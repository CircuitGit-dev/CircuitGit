"""Fixed-repository, isolated runtime Git workspace and signed bundle compiler."""
import difflib, hashlib, hmac, json, os, re, selectors, shutil, subprocess, time, uuid
from pathlib import Path, PurePosixPath
from runner import atomic,locked,filehash
import ic_sim as core
import configuration as configuration_schema

class Conflict(ValueError):pass

class VersionControlError(ValueError):
    """Bounded public error; never exposes Git stderr or local configuration."""
    def __init__(self,code,message,status=503):
        super().__init__(message);self.code=code;self.status=status

VERSION_TIMEOUT=15
VERSION_OUTPUT_LIMIT=1024*1024
VERSION_DIFF_LIMIT=256*1024
VERSION_PATH_LIMIT=128
VERSION_HISTORY_SCAN_LIMIT=200

def version_git(root,*args,deadline=None,limit=VERSION_OUTPUT_LIMIT,check=True):
    """Read-only callers only. Bound time/memory and prevent implicit fetch/filter execution."""
    deadline=deadline if deadline is not None else time.monotonic()+VERSION_TIMEOUT
    env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_OPTIONAL_LOCKS='0',GIT_NO_LAZY_FETCH='1',GIT_TERMINAL_PROMPT='0',
               GIT_NO_REPLACE_OBJECTS='1',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull,
               GIT_ATTR_NOSYSTEM='1',GIT_ALLOW_PROTOCOL='',GIT_PROTOCOL_FROM_USER='0',LC_ALL='C')
    command=['git','--no-pager','--literal-pathspecs','-c','core.hooksPath=/dev/null',
             '-c','core.fsmonitor=false','-c','core.untrackedCache=false',
             '-c','core.attributesFile=/dev/null','-c','core.quotePath=true',
             '-c','protocol.allow=never','-c','submodule.recurse=false',
             '-c','log.showSignature=false','-c','diff.renames=false','-C',str(root),*args]
    if time.monotonic()>=deadline:raise VersionControlError('version_timeout','Local version query timed out')
    try:p=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,start_new_session=True)
    except OSError:raise VersionControlError('version_unavailable','Local version information is unavailable') from None
    stdout=bytearray();sizes={'stdout':0,'stderr':0}
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(p.stdout,selectors.EVENT_READ,'stdout');selector.register(p.stderr,selectors.EVENT_READ,'stderr')
            while selector.get_map():
                remaining=deadline-time.monotonic()
                if remaining<=0:raise VersionControlError('version_timeout','Local version query timed out')
                for key,_ in selector.select(remaining):
                    chunk=os.read(key.fileobj.fileno(),65536)
                    if not chunk:selector.unregister(key.fileobj);continue
                    sizes[key.data]+=len(chunk)
                    if sizes[key.data]>(limit if key.data=='stdout' else 8192):
                        raise VersionControlError('version_output_limit','Local version query exceeds output limits',413)
                    if key.data=='stdout':stdout.extend(chunk)
            try:p.wait(timeout=max(.001,deadline-time.monotonic()))
            except subprocess.TimeoutExpired:raise VersionControlError('version_timeout','Local version query timed out') from None
        if check and p.returncode:raise VersionControlError('version_unavailable','Local version information is unavailable')
        return subprocess.CompletedProcess(command,p.returncode,bytes(stdout),b'')
    finally:
        try:
            if p.poll() is None:
                p.kill();p.wait()
        finally:
            p.stdout.close();p.stderr.close()

def version_public_path(path):
    """An explicit project file allowlist is required in addition to these exclusions."""
    project_path(path)
    if len(path.encode())>512:
        raise ValueError('invalid version-control project file')
    private=re.compile(r'(?i)(?:^|[._-])(?:pdks?|credentials?|secrets?|licenses?|private|tokens?|auth|id_rsa|id_ed25519)(?:$|[._-])')
    return not any(private.search(part) or '.local.' in part.lower() for part in PurePosixPath(path).parts) and not path.lower().endswith(('.pem','.key','.p12','.pfx'))
def safe_relative(path):
    if not isinstance(path,str) or not path or '\\' in path or ':' in path or len(path)>1024 or any(ord(c)<32 or ord(c)==127 for c in path) or any(not x or x.startswith('.') for x in path.split('/')):raise ValueError('path is outside allowed project files')
    return path
def project_path(path):
    """Validate an exact file identifier, never normalize or infer a cell's file list."""
    safe_relative(path)
    parts=path.split('/')
    if not (parts[0]=='projects' and len(parts)>=3 or parts[0]=='lib' and len(parts)>=4):
        raise ValueError('registered project files must be under projects/ or lib/<library>/<cell>/')
    return path

def project_metadata(project):
    result={}
    for field in ('library_id','cell_id'):
        if field not in project:continue
        value=project[field]
        if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}',value):
            raise ValueError('invalid project '+field)
        result[field]=value
    source=project_path(project['source_path'])
    if source.startswith('lib/'):
        parts=source.split('/')
        if any(result.get(field,parts[index])!=parts[index] for field,index in (('library_id',1),('cell_id',2))):
            raise ValueError('library/cell metadata does not match explicit source_path')
    return result

def git(root,*args,input=None,check=True):
    p=subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',str(root),*args],input=input,capture_output=True)
    if check and p.returncode:raise ValueError(p.stderr.decode(errors='replace')[-1500:])
    return p
def validate_text(path,text):
    if not isinstance(text,str) or len(text.encode())>2*1024*1024 or '\x00' in text:raise ValueError('text file exceeds limits')
    if path.endswith('.json'):json.loads(text)
    if re.search(r'(?im)^\s*(?:shell|system|exec)\b|\$system\s*\(',text):raise ValueError('shell execution directives are not allowed')
    if re.search(r'(?i)\b(?:write|writefinal|savefile|sensfile)\s*=\s*"/',text):raise ValueError('absolute output paths are not allowed')
def assignments(text,values,kind):
    if not values:return text
    pattern=r'(?m)^parameters[^\n]*(?:\\\n[^\n]*)*' if kind=='parameters' else r'(?m)^tran\s+tran[^\n]*(?:\\\n[^\n]*)*'
    blocks=list(re.finditer(pattern,text))
    if len(blocks)!=1:raise ValueError('require exactly one '+kind+' declaration block for overrides')
    block=blocks[0].group(0)
    for key,value in values.items():
        if not re.fullmatch(r'[A-Za-z_]\w*',key) or not isinstance(value,(str,int,float)) or not re.fullmatch(r'[A-Za-z0-9_.+*/()eE-]{1,120}',str(value)):raise ValueError('invalid parameter expression')
        if kind!='parameters' and key not in ['stop','maxstep','errpreset','method','maxiters']:raise ValueError('unsupported analysis override')
        pattern_key=r'(?<!\w)'+re.escape(key)+r'=[^\s\\]+'
        if len(re.findall(pattern_key,block))!=1:raise ValueError('missing/duplicate declared parameter '+key)
        block=re.sub(pattern_key,lambda _:key+'='+str(value),block)
    return text[:blocks[0].start()]+block+text[blocks[0].end():]
class Workspace:
    def __init__(self,cfg,site,signing_key):
        self.cfg=cfg;self.site=site;self.key=signing_key;self.runtime=Path(cfg['runtime_root']).resolve();self.root=self.runtime/'workspace';self.frozen=self.runtime/'frozen';self.frozen.mkdir(parents=True,exist_ok=True)
        self.repo=cfg['github_repo'];self.branch=cfg.get('runtime_branch','codex/gateway-session');self.base_branch=cfg.get('base_branch','main')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',self.repo) or any(x in ['.','..'] for x in self.repo.split('/')):raise ValueError('invalid installed repository allowlist')
        for branch in [self.branch,self.base_branch]:
            if not re.fullmatch(r'[A-Za-z0-9_/-]+',branch) or '..' in branch:raise ValueError('invalid configured branch')
        if not self.branch.startswith('codex/'):raise ValueError('runtime branch must be an isolated codex/ branch')
        with locked(self.runtime/'workspace.lock'):
            if not self.root.exists():
                seed=Path(cfg['seed_repo']).resolve()
                p=subprocess.run(['git','clone','--no-hardlinks','--no-local',str(seed),str(self.root)],capture_output=True)
                if p.returncode:raise ValueError('runtime clone failed: '+p.stderr.decode())
                git(self.root,'remote','set-url','origin','https://github.com/'+self.repo+'.git');git(self.root,'checkout','-b',self.branch)
            if git(self.root,'remote','get-url','origin').stdout.decode().strip()!='https://github.com/'+self.repo+'.git':raise ValueError('runtime origin does not match pinned repository')
        self.projects={p['id']:p for p in cfg['projects']};self.allowed=set()
        if len(self.projects)!=len(cfg['projects']):raise ValueError('duplicate project id')
        for p in self.projects.values():
            project_metadata(p)
            for k in ['source_path']:self.allowed.add(project_path(p[k]))
            for c in p['configurations']:
                self.allowed.add(project_path(c['configuration_path']))
                safe_relative(c['bundle_template'])
                for replacement in c.get('source_replacements',[]):self.allowed.add(project_path(replacement['source']));core.relpath(replacement['destination'])
            for path in p.get('read_paths',[]):self.allowed.add(project_path(path))
    def head(self):return git(self.root,'rev-parse','HEAD').stdout.decode().strip()
    def clean(self):return not git(self.root,'status','--porcelain').stdout
    def require_base(self,base):
        if base!=self.head():raise Conflict('base_commit changed; refresh before editing')
    def file_path(self,path):
        safe_relative(path)
        if path not in self.allowed:raise ValueError('file is not allowlisted')
        f=self.root/path
        for part in [f,*f.parents]:
            if part==self.root:break
            if part.is_symlink():raise ValueError('symlink is not allowed')
        if not f.resolve().is_relative_to(self.root):raise ValueError('path escapes workspace')
        return f
    def file(self,path):
        f=self.file_path(path);raw=f.read_bytes()
        if len(raw)>2*1024*1024:raise ValueError('file too large')
        return {'path':path,'content':raw.decode(),'sha256':core.sha(raw),'base_commit':self.head(),'editable':not any(path in p.get('read_paths',[]) for p in self.projects.values())}
    def describe(self):
        projects=[{'id':p['id'],'name':p.get('name',p['id']),**project_metadata(p),'source_path':p['source_path'],'configurations':[{'id':c['id'],'name':c.get('name',c['id']),'path':c['configuration_path']} for c in p['configurations']]} for p in self.projects.values()]
        tracking=git(self.root,'rev-parse','--abbrev-ref','--symbolic-full-name','@{u}',check=False).stdout.decode().strip() or 'origin/'+self.base_branch
        return {'repo':self.repo,'branch':self.branch,'tracking_branch':tracking,'source_commit':self.head(),'clean':self.clean(),'dirty':not self.clean(),'projects':projects,'active_project':projects[0]['id'] if projects else None,'capabilities':{'git':True,'runner':True,'publish':True,'viewer':False}}
    def tree(self,project_id):
        if project_id not in self.projects:raise FileNotFoundError('unknown project')
        p=self.projects[project_id];paths={p['source_path'],*[c['configuration_path'] for c in p['configurations']],*p.get('read_paths',[]),*[r['source'] for c in p['configurations'] for r in c.get('source_replacements',[])]}
        return {'files':[{'path':x,'kind':'file','editable':not any(x in project.get('read_paths',[]) for project in self.projects.values())} for x in sorted(paths)],'base_commit':self.head()}
    def _version_paths(self,project_id,scope='all'):
        if scope not in ('all','design'):raise ValueError('invalid version-control scope')
        if not isinstance(project_id,str) or project_id not in self.projects:raise FileNotFoundError('unknown project')
        p=self.projects[project_id]
        paths={p['source_path'],*p.get('read_paths',[])}
        for c in p['configurations']:
            paths.add(c['configuration_path'])
            paths.update(r['source'] for r in c.get('source_replacements',[]))
        if scope=='design':
            # Match the editor's actual write boundary, including all canonical
            # hierarchy replacements, not only the entry netlist.
            paths.difference_update(path for project in self.projects.values() for path in project.get('read_paths',[]))
        if len(paths)>VERSION_PATH_LIMIT:raise VersionControlError('version_output_limit','Project version scope exceeds file limits',413)
        # The project configuration is an explicit file list, never a recursive directory scope.
        paths=sorted(path for path in paths if version_public_path(path))
        if not paths:raise PermissionError('project has no public version-control files')
        for path in paths:
            f=self.root/path
            if f.is_dir() and not f.is_symlink():raise ValueError('version-control scope must contain files only')
            if any(parent.is_symlink() for parent in f.parents if parent!=self.root and parent.is_relative_to(self.root)):
                raise PermissionError('version-control scope contains a symlink directory')
        return paths
    @staticmethod
    def _version_normalized(path,raw):
        """Conservative cosmetic comparison; never strip inline netlist content."""
        try:text=raw.decode('utf-8')
        except UnicodeDecodeError:return raw
        if '\x00' in text:return raw
        if path.endswith('.json'):
            def pairs(items):
                result={}
                for key,value in items:
                    if key in result:raise ValueError('duplicate JSON key')
                    result[key]=value
                return result
            try:return json.dumps(json.loads(text,object_pairs_hook=pairs,parse_constant=lambda x:(_ for _ in ()).throw(ValueError(x))),sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
            except (ValueError,TypeError):return raw
        suffix=PurePosixPath(path).suffix.lower()
        if suffix not in ('.scs','.sp','.spi','.cir'):return raw
        kept=[];quote=None;continued=False
        for line in text.splitlines(keepends=True):
            stripped=line.lstrip()
            comment=stripped.startswith('//') or suffix!='.scs' and stripped.startswith('*')
            if not quote and not continued and (not stripped.strip() or comment):continue
            kept.append(line.rstrip('\r\n'))
            escaped=False
            for char in line:
                if escaped:escaped=False;continue
                if char=='\\':escaped=True;continue
                if quote:
                    if char==quote:quote=None
                elif char in ('"',"'"):quote=char
            continued=line.rstrip('\r\n').rstrip().endswith('\\')
        # An unterminated quote is ambiguous: keep bytes instead of hiding it.
        return raw if quote else '\n'.join(kept).encode()
    def _version_cosmetic(self,commit,files,deadline):
        if not commit['parents'] or not files:return False
        for f in files:
            if f['status']!='M' or f['content_omitted'] is not None:return False
            blobs=[]
            for version in (commit['parents'][0],commit['sha']):
                ref=version+':'+f['path']
                size=version_git(self.root,'cat-file','-s',ref,deadline=deadline,limit=64).stdout.strip()
                if not size.isdigit() or int(size)>256*1024:return False
                blobs.append(version_git(self.root,'cat-file','blob',ref,deadline=deadline,limit=256*1024).stdout)
            if self._version_normalized(f['path'],blobs[0])!=self._version_normalized(f['path'],blobs[1]):return False
        return True
    def _version_design_summary(self,project_id,files,cosmetic=False):
        config_paths={c['configuration_path'] for c in self.projects[project_id]['configurations']}
        circuits=[f for f in files if f['path'] not in config_paths]
        configs=[f for f in files if f['path'] in config_paths]
        parts=[]
        if circuits:parts.append(('新增' if all(f['status']=='A' for f in circuits) else '更新')+'电路 '+str(len(circuits))+' 个文件')
        if configs:parts.append(('新增' if all(f['status']=='A' for f in configs) else '更新')+'仿真配置 '+str(len(configs))+' 份')
        return '注释 / 格式整理' if cosmetic else '，'.join(parts)
    def _version_identity(self,deadline):
        expected=self.runtime.resolve()/'workspace'
        if self.root.is_symlink() or self.root.resolve()!=expected:raise Conflict('runtime workspace identity changed')
        repository=version_git(self.root,'rev-parse','--show-toplevel','--is-shallow-repository',deadline=deadline,limit=8192).stdout.decode().splitlines()
        if len(repository)!=2 or repository[1]!='false':
            raise VersionControlError('version_unavailable','Complete local history is required for version queries')
        if Path(repository[0]).resolve()!=expected:raise Conflict('runtime workspace identity changed')
        grafts=self.root/'.git/info/grafts'
        if grafts.exists() and grafts.stat().st_size:
            raise VersionControlError('version_unavailable','Rewritten local ancestry is not supported for version queries')
        ref=version_git(self.root,'symbolic-ref','-q','HEAD',deadline=deadline,limit=2048,check=False)
        if ref.returncode or ref.stdout.decode().strip()!='refs/heads/'+self.branch:
            raise Conflict('runtime branch changed or detached; refresh the installed workspace')
        head=version_git(self.root,'rev-parse','--verify','HEAD^{commit}',deadline=deadline,limit=128).stdout.decode().strip()
        if not re.fullmatch('[a-f0-9]{40}',head):raise VersionControlError('version_unavailable','Unsupported runtime commit identity')
        return head,self.branch
    def _version_metadata(self,sha,deadline):
        data=version_git(self.root,'show','--no-patch','--no-show-signature','--no-notes',
                         '--format=%H%x00%P%x00%s%x00%an%x00%aI',sha,deadline=deadline,limit=16384).stdout.rstrip(b'\n').split(b'\x00')
        if len(data)!=5:raise VersionControlError('version_unavailable','Invalid local commit metadata')
        h,parents,subject,author,date=[v.decode('utf-8',errors='replace') for v in data]
        parents=parents.split()
        if h!=sha or len(parents)>32 or any(not re.fullmatch('[a-f0-9]{40}',p) for p in parents):
            raise VersionControlError('version_unavailable','Invalid local commit ancestry')
        if len(subject)>4096 or len(author)>512 or len(date)>64:
            raise VersionControlError('version_output_limit','Commit metadata exceeds output limits',413)
        # Subjects/authors are untrusted display text; author email and full body are never exposed.
        clean=lambda s:''.join(c if ord(c)>=32 and ord(c)!=127 else ' ' for c in s)
        return {'sha':h,'parents':parents,'subject':clean(subject),'author':clean(author),'date':clean(date)}
    def _version_body(self,sha,deadline):
        raw=version_git(self.root,'show','--no-patch','--no-show-signature','--no-notes','--format=%b',sha,
                        deadline=deadline,limit=16384).stdout.decode('utf-8',errors='replace').strip()
        # Keep bounded author-written context; no email/config/trailer expansion.
        return ''.join(c for c in raw if ord(c)>=32 or c in '\n\t')[:4000]
    def _version_diff(self,commit,paths,deadline,mode,limit=VERSION_OUTPUT_LIMIT):
        args=['diff-tree','--no-commit-id','-r','--no-renames','--no-ext-diff','--no-textconv',
              '--ignore-submodules=all','--no-color','--no-relative']
        if mode=='raw':args+=['--raw','-z','--no-abbrev']
        elif mode=='stats':args+=['--numstat','-z']
        else:args+=['--patch','--full-index','--src-prefix=a/','--dst-prefix=b/','--unified=3']
        args+=([commit['parents'][0],commit['sha']] if commit['parents'] else ['--root',commit['sha']])
        return version_git(self.root,*args,'--',*paths,deadline=deadline,limit=limit).stdout
    def _version_files(self,commit,paths,deadline):
        raw=self._version_diff(commit,paths,deadline,'raw')
        tokens=raw.split(b'\x00')
        if tokens[-1]!=b'' or (len(tokens)-1)%2:raise VersionControlError('version_unavailable','Invalid local change metadata')
        files=[]
        for i in range(0,len(tokens)-1,2):
            header=tokens[i].decode('ascii',errors='replace').split();path=tokens[i+1].decode('utf-8',errors='strict')
            if len(header)!=5 or path not in paths or header[4] not in ('A','D','M','T'):
                raise VersionControlError('version_unavailable','Invalid project change scope')
            regular=header[0][1:] in ('000000','100644','100755') and header[1] in ('000000','100644','100755')
            files.append({'path':path,'status':header[4],'additions':None,'deletions':None,
                          'binary':False,'content_omitted':None if regular else 'non_regular_file'})
        if len(files)>VERSION_PATH_LIMIT:raise VersionControlError('version_output_limit','Commit exceeds file limits',413)
        return files
    def _version_upstream(self,head,branch,deadline):
        fullref=version_git(self.root,'for-each-ref','--format=%(upstream)','refs/heads/'+branch,
                            deadline=deadline,limit=4096).stdout.decode().strip()
        if '\n' in fullref or (fullref and not fullref.startswith('refs/')):
            raise VersionControlError('version_unavailable','Invalid local tracking reference')
        ref=fullref.removeprefix('refs/remotes/').removeprefix('refs/heads/') if fullref else None
        result={'available':False,'ref':ref,'commit':None,'ahead':None,'behind':None,
                'freshness':'local_cache','remote_checked':False,'count_scope':'runtime_branch_all_commits',
                'reason':'unconfigured' if not fullref else 'missing_local_ref'}
        if fullref:
            resolved=version_git(self.root,'rev-parse','--verify','--end-of-options',fullref+'^{commit}',deadline=deadline,limit=128,check=False)
            if not resolved.returncode:
                sha=resolved.stdout.decode().strip()
                if not re.fullmatch('[a-f0-9]{40}',sha):raise VersionControlError('version_unavailable','Invalid cached upstream identity')
                counts=version_git(self.root,'rev-list','--left-right','--count',head+'...'+sha,deadline=deadline,limit=128).stdout.decode().split()
                if len(counts)!=2 or any(not x.isdecimal() for x in counts):raise VersionControlError('version_unavailable','Invalid cached upstream counts')
                result.update(available=True,commit=sha,ahead=int(counts[0]),behind=int(counts[1]),reason=None)
        return result
    def _version_finish(self,identity,deadline,data):
        if self._version_identity(deadline)!=identity:raise Conflict('runtime source changed during version query; refresh')
        if len(json.dumps(data,ensure_ascii=False).encode())>VERSION_OUTPUT_LIMIT:
            raise VersionControlError('version_output_limit','Version response exceeds output limits',413)
        return data
    def _version_status(self,paths,deadline):
        # Even `status` may run repository-defined clean/process filters while hashing
        # working files. Disable every locally defined driver without exposing values.
        keys=version_git(self.root,'config','--local','--includes','--name-only','--get-regexp',
                         r'^filter\..*\.(clean|smudge|process|required)$',deadline=deadline,limit=8192,check=False)
        if keys.returncode not in (0,1):raise VersionControlError('version_unavailable','Local filter metadata is unavailable')
        overrides=[]
        for key in set(keys.stdout.decode('utf-8',errors='strict').splitlines()):
            if not re.fullmatch(r'filter\.[^\x00-\x1f\x7f=]+\.(clean|smudge|process|required)',key):
                raise VersionControlError('version_unavailable','Unsupported local filter metadata')
            overrides+=['-c',key+('=false' if key.endswith('.required') else '=')]
        return version_git(self.root,*overrides,'status','--porcelain=v1','-z','--no-renames','--untracked-files=all',
                           '--ignore-submodules=all','--',*paths,deadline=deadline).stdout
    def version_control(self,project_id,limit=20,scope='all',include_cosmetic=False):
        if type(limit) is not int or not 1<=limit<=50:raise ValueError('version history limit must be 1..50')
        if type(include_cosmetic) is not bool:raise ValueError('include_cosmetic must be boolean')
        deadline=time.monotonic()+VERSION_TIMEOUT;paths=self._version_paths(project_id,scope)
        identity=self._version_identity(deadline);head,branch=identity
        raw=self._version_status(paths,deadline)
        changes=[]
        for row in raw.split(b'\x00'):
            if not row:continue
            if len(row)<4 or row[2:3]!=b' ':raise VersionControlError('version_unavailable','Invalid local status metadata')
            status=row[:2].decode('ascii');path=row[3:].decode('utf-8',errors='strict')
            if path not in paths or any(c not in ' MADRCUT?!' for c in status):
                raise VersionControlError('version_unavailable','Invalid project status scope')
            changes.append({'path':path,'status':status,'staged':status[0] not in ' ?',
                            'unstaged':status[1]!=' '})
        hashes=version_git(self.root,'log','--first-parent','--diff-merges=first-parent','--no-patch','--no-notes','--format=%H',
                           '--max-count='+str(VERSION_HISTORY_SCAN_LIMIT+1 if scope=='design' else limit+1),head,'--',*paths,deadline=deadline,limit=16384).stdout.decode().split()
        commits=[];hidden=0;scanned=0
        for sha in hashes:
            if scope=='design' and scanned==VERSION_HISTORY_SCAN_LIMIT:break
            if not re.fullmatch('[a-f0-9]{40}',sha):raise VersionControlError('version_unavailable','Invalid local history identity')
            commit=self._version_metadata(sha,deadline);files=self._version_files(commit,paths,deadline)
            scanned+=1
            if files:
                cosmetic=scope=='design' and self._version_cosmetic(commit,files,deadline)
                if cosmetic and not include_cosmetic:hidden+=1;continue
                extra={'design_summary':self._version_design_summary(project_id,files,cosmetic),'cosmetic_only':cosmetic} if scope=='design' else {}
                commits.append({**commit,**extra,'files':[f['path'] for f in files],'files_count':len(files)})
                if len(commits)>limit:break
        upstream=self._version_upstream(head,branch,deadline)
        return self._version_finish(identity,deadline,{'schema':'ic.version-control.v1','project_id':project_id,
            'source_commit':head,'branch':branch,'tracking_branch':upstream['ref'],
            'clean':not changes,'dirty':bool(changes),'changes':changes,'commits':commits[:limit],
            'has_more':len(commits)>limit or len(hashes)>scanned,'upstream':upstream,'limit':limit,
            'cosmetic_hidden':hidden,'history_scanned':scanned,'scanning_limited':scope=='design' and scanned==VERSION_HISTORY_SCAN_LIMIT and len(hashes)>scanned,
            'scope':{'kind':'project_design' if scope=='design' else 'project_allowlist','paths':paths,'history_mode':'first_parent','comparison':'first_parent','include_cosmetic':include_cosmetic}})
    def version_control_commit(self,project_id,sha,scope='all'):
        if not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{40}',sha):raise ValueError('commit must be a full lowercase SHA')
        deadline=time.monotonic()+VERSION_TIMEOUT;paths=self._version_paths(project_id,scope)
        identity=self._version_identity(deadline);head,_=identity
        exists=version_git(self.root,'cat-file','-t',sha,deadline=deadline,limit=64,check=False)
        if exists.returncode or exists.stdout.strip()!=b'commit':raise FileNotFoundError('unknown project commit')
        ancestor=version_git(self.root,'merge-base','--is-ancestor',sha,head,deadline=deadline,limit=128,check=False)
        if ancestor.returncode==1:raise FileNotFoundError('unknown project commit')
        if ancestor.returncode:raise VersionControlError('version_unavailable','Local commit ancestry is unavailable')
        commit=self._version_metadata(sha,deadline);files=self._version_files(commit,paths,deadline)
        if not files:raise FileNotFoundError('unknown project commit')
        # Attributes can force binary blobs to be treated as text. Check the actual
        # allowed blobs as well, without textconv or custom diff drivers.
        for f in files:
            if f['content_omitted'] is not None:continue
            versions=[]
            if f['status']!='A' and commit['parents']:versions.append(commit['parents'][0])
            if f['status']!='D':versions.append(sha)
            for version in versions:
                blob=version_git(self.root,'cat-file','blob',version+':'+f['path'],deadline=deadline).stdout
                try:blob.decode('utf-8')
                except UnicodeDecodeError:is_binary=True
                else:is_binary=b'\x00' in blob
                if is_binary:
                    f.update(binary=True,content_omitted='binary_file');break
        regular={f['path']:f for f in files if f['content_omitted'] is None}
        diff=''
        if regular:
            stats=self._version_diff(commit,list(regular),deadline,'stats')
            seen=set()
            for row in stats.split(b'\x00'):
                if not row:continue
                fields=row.split(b'\t',2)
                if len(fields)!=3:raise VersionControlError('version_unavailable','Invalid local diff statistics')
                add,delete,path=[v.decode('utf-8',errors='strict') for v in fields]
                if path not in regular or path in seen:raise VersionControlError('version_unavailable','Invalid diff statistics scope')
                seen.add(path)
                if add==delete=='-':regular[path].update(binary=True,content_omitted='binary_file')
                elif add.isdecimal() and delete.isdecimal():regular[path].update(additions=int(add),deletions=int(delete))
                else:raise VersionControlError('version_unavailable','Invalid local diff statistics')
            if seen!=set(regular):raise VersionControlError('version_unavailable','Incomplete local diff statistics')
            text_paths=[path for path,f in regular.items() if not f['binary']]
            if text_paths:diff=self._version_diff(commit,text_paths,deadline,'patch',VERSION_DIFF_LIMIT).decode('utf-8',errors='replace')
        if scope=='design':
            commit['design_summary']=self._version_design_summary(project_id,files,self._version_cosmetic(commit,files,deadline))
            commit['body']=self._version_body(sha,deadline)
        return self._version_finish(identity,deadline,{'schema':'ic.version-control.commit.v1','project_id':project_id,
            'source_commit':head,'commit':commit,'parent_commit':commit['parents'][0] if commit['parents'] else None,
            'files':files,'diff':diff,'truncated':False})
    def version_control_restore_preview(self,project_id,sha,base):
        """Stage a reviewed new-commit proposal. Never checkout/reset historical trees."""
        with locked(self.runtime/'workspace.lock'):
            self.require_base(base)
            if not self.clean():raise Conflict('runtime workspace has external/uncommitted changes')
            detail=self.version_control_commit(project_id,sha,scope='design')
            deadline=time.monotonic()+VERSION_TIMEOUT;paths=self._version_paths(project_id,'design')
            changes=[];missing=[]
            for path in paths:
                tree=version_git(self.root,'ls-tree','-z',sha,'--',path,deadline=deadline,limit=1024).stdout
                if not tree:missing.append(path);continue
                row=tree.rstrip(b'\x00').split(b'\t',1)
                if len(row)!=2 or row[0].split()[:2] not in ([b'100644',b'blob'],[b'100755',b'blob']):
                    raise ValueError('historical design contains a non-regular file')
                raw=version_git(self.root,'cat-file','blob',sha+':'+path,deadline=deadline,limit=2*1024*1024).stdout
                text=raw.decode('utf-8');validate_text(path,text);current=self.file(path)
                if text!=current['content']:changes.append({'path':path,'content':text,'sha256':current['sha256']})
            if missing:raise Conflict('历史版本尚未包含当前工程的全部电路与配置，不能完整回档：'+', '.join(missing))
            if not changes:raise ValueError('当前电路和配置已经与此版本一致。')
            preview=self.preview(base,changes)
            return {'schema':'ic.version-control.restore-preview.v1','project_id':project_id,'target_commit':sha,
                    'base_commit':base,'changes':changes,'preview':preview,'commit':detail['commit'],'automatic_commit':False}
    def commit_summary_input(self,project_id,base,review_id):
        """Read a frozen reviewed diff, revalidate its exact project/source identities."""
        if not isinstance(review_id,str) or not re.fullmatch('[a-f0-9]{64}',review_id):raise ValueError('invalid review id')
        with locked(self.runtime/'workspace.lock'):
            self.require_base(base);paths=set(self._version_paths(project_id,'design'))
            path=self.runtime/'reviews'/(review_id+'.json')
            if path.is_symlink() or not path.is_file():raise FileNotFoundError('unknown change review')
            if path.stat().st_size>2*1024*1024:raise ValueError('变更过大，无法自动生成完整摘要；请手动填写提交说明。')
            reviewed=json.loads(path.read_text())
            if reviewed.get('base_commit')!=base:raise Conflict('review base changed; preview again')
            changes=reviewed.get('changes')
            if not isinstance(changes,list) or not 1<=len(changes)<=20:raise ValueError('invalid reviewed changes')
            for change in changes:
                if set(change)!={'path','content','before_sha256'} or change['path'] not in paths:
                    raise PermissionError('summary review is outside selected circuit files')
                if self.file(change['path'])['sha256']!=change['before_sha256']:raise Conflict('review source hash changed')
            proposed=[{'path':c['path'],'content':c['content'],'sha256':c['before_sha256']} for c in changes]
            preview=self.preview(base,proposed,persist=False)
            if preview['review_id']!=review_id:raise Conflict('review content changed; preview again')
            if len(preview['diff'].encode())>64*1024:raise ValueError('差异超过64 KiB，未发送不完整摘要；请手动填写提交说明。')
            return {'schema':'ic.commit-summary-input.v1','project_id':project_id,'base_commit':base,'review_id':review_id,
                    'diff':preview['diff'],'files':[{'path':c['path'],'before_sha256':c['before_sha256'],
                                                  'after_sha256':core.sha(c['content'].encode())} for c in changes]}
    def preview(self,base,changes,persist=True):
        self.require_base(base)
        if not isinstance(changes,list) or not 1<=len(changes)<=20:raise ValueError('changes must contain 1..20 allowlisted files')
        seen=set();diff=[];normalized=[]
        for c in changes:
            path=c['path'];text=c['content'];f=self.file_path(path)
            if path in seen or any(path in p.get('read_paths',[]) for p in self.projects.values()):raise ValueError('duplicate/read-only change')
            seen.add(path);validate_text(path,text);before=f.read_text()
            if c.get('sha256') and c['sha256']!=core.sha(before.encode()):raise Conflict('file hash changed')
            diff.extend(difflib.unified_diff(before.splitlines(True),text.splitlines(True),fromfile='a/'+path,tofile='b/'+path));normalized.append({'path':path,'content':text,'before_sha256':core.sha(before.encode())})
        if not diff:raise ValueError('no changes')
        # Materialize all configurations in memory to validate JSON and override closure before commit.
        overrides={c['path']:c['content'].encode() for c in normalized}
        configuration_previews=[]
        for p in self.projects.values():
            for c in p['configurations']:
                bundle,files,_=self.compile_inputs(p,c,base,overrides);self.validate_compiled(bundle,files)
                configuration_previews.append({'project_id':p['id'],'configuration':c['id'],'effective':bundle['configuration']['effective']})
        review=core.sha(json.dumps([base,normalized],sort_keys=True).encode())
        if persist:atomic(self.runtime/'reviews'/f'{review}.json',{'base_commit':base,'changes':normalized})
        return {'base_commit':base,'review_id':review,'diff':''.join(diff),'validation':{'ok':True,'checks':['allowlist','text/JSON syntax','bundle closure/parameter declarations','bounded save identities']},'files':[{'path':c['path'],'sha256':core.sha(c['content'].encode())} for c in normalized],'configuration_previews':configuration_previews}
    def commit(self,base,changes,message,push=False):
        if not isinstance(message,str) or not 1<=len(message)<=300:raise ValueError('invalid commit message')
        with locked(self.runtime/'workspace.lock'):
            self.require_base(base)
            if not self.clean():raise Conflict('runtime workspace has external/uncommitted changes')
            preview=self.preview(base,changes);review=json.loads((self.runtime/'reviews'/f'{preview["review_id"]}.json').read_text())
            for c in review['changes']:
                path=self.file_path(c['path']);tmp=path.with_name(path.name+'.workbench-tmp');tmp.write_text(c['content']);tmp.replace(path)
            git(self.root,'add','--',*[c['path'] for c in review['changes']]);git(self.root,'-c','user.name=IC Workbench','-c','user.email=ic-workbench@localhost','commit','-m',message)
            head=self.head();result={'source_commit':head,'branch':self.branch,'review_id':preview['review_id'],'push_status':'not_requested'}
            if push:self.push();result['push_status']='confirmed'
            return result
    def private_repo(self):
        gh=self.cfg.get('gh_bin','gh');p=subprocess.run([gh,'api','repos/'+self.repo],capture_output=True)
        if p.returncode:raise ValueError('GitHub repository lookup failed')
        if json.loads(p.stdout).get('private') is not True:raise ValueError('refusing non-private repository')
    def push(self):
        self.private_repo();git(self.root,'push','--set-upstream','origin','HEAD:refs/heads/'+self.branch)
        remote=git(self.root,'ls-remote','origin','refs/heads/'+self.branch).stdout.decode().split()
        if not remote or remote[0]!=self.head():raise Conflict('push outcome not confirmed; do not repeat blindly')
    def sync(self):
        with locked(self.runtime/'workspace.lock'):
            if not self.clean():raise Conflict('cannot sync dirty workspace')
            exists=git(self.root,'ls-remote','--heads','origin','refs/heads/'+self.branch).stdout
            chosen=self.branch if exists else self.base_branch
            git(self.root,'fetch','origin',chosen);p=git(self.root,'merge','--ff-only','FETCH_HEAD',check=False)
            if p.returncode:raise Conflict('remote source diverged; preserve runtime branch and reconcile')
            git(self.root,'branch','--set-upstream-to=origin/'+chosen,self.branch)
            return self.describe()
    def blob(self,commit,path,overrides=None):
        safe_relative(path)
        if overrides and path in overrides:return overrides[path]
        if not re.fullmatch('[a-f0-9]{40}',commit):raise ValueError('invalid source commit')
        mode=git(self.root,'ls-tree',commit,'--',path).stdout.decode()
        if not mode.startswith('100644 ') and not mode.startswith('100755 '):raise ValueError('source is absent or not a regular tracked file: '+path)
        return git(self.root,'show',commit+':'+path).stdout
    def select(self,pid,configuration):
        if pid not in self.projects:raise FileNotFoundError('unknown project')
        p=self.projects[pid];c=next((x for x in p['configurations'] if x['id']==configuration),None)
        if not c:raise FileNotFoundError('unknown configuration')
        return p,c
    def compile_inputs(self,p,c,commit,overrides=None):
        template_path=c['bundle_template'];template=self.blob(commit,template_path);b=json.loads(template);out={};sources={template_path:core.sha(template)}
        root=PurePosixPath(template_path).parent/PurePosixPath(b['source_root'])
        import posixpath
        for f in b['files']:
            src=posixpath.normpath(str(root/f['source']));raw=self.blob(commit,src);sources[src]=core.sha(raw);out[core.relpath(f['destination'])]=raw
        replacements=c.get('source_replacements',[{'source':p['source_path'],'destination':'netlist/project.scs'}])
        for r in replacements:
            raw=self.blob(commit,r['source'],overrides);validate_text(r['source'],raw.decode());out[core.relpath(r['destination'])]=raw;sources[r['source']]=core.sha(raw)
        raw=self.blob(commit,c['configuration_path'],overrides);conf=configuration_schema.load_configuration(raw);sources[c['configuration_path']]=core.sha(raw)
        entry=b['entrypoint'];text=out[entry].decode();text=assignments(text,conf.get('parameters',{}),'parameters');text=assignments(text,conf.get('analysis',{}),'analysis');out[entry]=text.encode()
        flat=re.sub(r'\\\n\s*',' ',text)
        parameters=next((line for line in flat.splitlines() if line.startswith('parameters ')),None)
        effective_parameters=dict(re.findall(r'(\w+)=([^\s]+)',parameters)) if parameters else {}
        b.update(source_root='.',design_id=p['id'],configuration={'template_reference':b.get('configuration',{}),'workbench':conf,'effective_parameters':effective_parameters,'effective_tran':next((line for line in flat.splitlines() if line.startswith('tran tran')),None),'effective_entrypoint_sha256':core.sha(out[entry]),'device_values_authority':'canonical source and staged netlist; template_reference is historical metadata'},reviewed_for_distribution=True)
        if 'simulator' in conf:b['simulator']=conf['simulator']
        from runner import postprocess_config
        b['postprocess']=postprocess_config(conf.get('postprocess',b.get('postprocess')))
        out,save_info,_=configuration_schema.apply_save(out,entry,conf.get('save'))
        b['configuration']['effective']=configuration_schema.settings(out,entry,save_info,core.simulator_config(b),b['postprocess'])
        b['configuration']['effective_entrypoint_sha256']=core.sha(out[entry])
        core.simulator_config(b);b['files']=[{'source':k,'destination':k,'sha256':core.sha(v)} for k,v in sorted(out.items())]
        for name,data in out.items():validate_text(name,data.decode())
        return b,out,sources
    def configuration_description(self,pid,configuration,commit):
        with locked(self.runtime/'workspace.lock'):
            self.require_base(commit)
            if not self.clean():raise Conflict('configuration description requires clean committed inputs')
            p,c=self.select(pid,configuration);bundle,files,sources=self.compile_inputs(p,c,commit)
            return configuration_schema.descriptor(p,c,commit,self.blob(commit,c['configuration_path']),bundle,files,sources)
    def validate_compiled(self,bundle,files):
        import tempfile
        with tempfile.TemporaryDirectory(dir=self.frozen) as tmp:
            root=Path(tmp)
            for name,data in files.items():f=root/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(data)
            atomic(root/'bundle.json',bundle);_,_,proof=core.prepare(root/'bundle.json',self.site)
            if not core.required_aliases(proof,self.site).issubset(core.external_pins(bundle)):raise ValueError('compiled bundle has unpinned external aliases')
            for value in core.external_pins(bundle).values():
                if not re.fullmatch('[a-f0-9]{64}',value):raise ValueError('invalid external pin')
    def materialize(self,pid,configuration,commit):
        with locked(self.runtime/'workspace.lock'):
            self.require_base(commit);p,c=self.select(pid,configuration);b,files,sources=self.compile_inputs(p,c,commit)
            compiler_hash=core.sha(Path(__file__).read_bytes()+Path(configuration_schema.__file__).read_bytes());key=core.sha(json.dumps([commit,pid,configuration,sources,compiler_hash,project_metadata(p)],sort_keys=True).encode());dest=self.frozen/key
            if not dest.exists():
                temp=self.frozen/(key+'.'+uuid.uuid4().hex);temp.mkdir()
                for name,raw in files.items():f=temp/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(raw)
                atomic(temp/'bundle.json',b);data={'source_commit':commit,'project_id':pid,**project_metadata(p),'configuration':configuration,'source_sha256':sources,'compiler_sha256':compiler_hash,'bundle_sha256':filehash(temp/'bundle.json')}
                signature=hmac.new(self.key,json.dumps(data,sort_keys=True).encode(),hashlib.sha256).hexdigest();atomic(temp/'materialization.json',{'data':data,'signature':signature});temp.rename(dest)
            # Validate closure and pins from actual new hashes; never modify archived templates.
            core.prepare(dest/'bundle.json',self.site);return dest/'bundle.json'
