"""Verified full-result publication to one pinned private GitHub repository."""
import json, os, re, subprocess, tarfile
from pathlib import Path
from urllib.parse import quote,urlparse
from runner import atomic,filehash,locked,stamp
from workspace import git,Conflict

class Publisher:
    def __init__(self,cfg,workspace,runner):self.cfg=cfg;self.ws=workspace;self.runner=runner;self.gh=cfg.get('gh_bin','gh');self.repo=cfg.get('github_repo')
    def api(self,endpoint,method='GET',data=None,upload=None):
        if self.cfg.get('local_only') or not self.repo:raise PermissionError('Local intake has no publication destination')
        argv=[self.gh,'api',endpoint,'--method',method,'-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28']
        raw=None
        if upload:argv+=['-H','Content-Type: application/octet-stream','--input',str(upload)]
        elif data is not None:argv+=['--input','-'];raw=json.dumps(data).encode()
        p=subprocess.run(argv,input=raw,capture_output=True,timeout=1800 if upload else 60)
        if p.returncode:raise ValueError('GitHub API failed: '+p.stderr.decode(errors='replace')[-1000:])
        return json.loads(p.stdout)
    def stage_index(self,checkout,resultdir,include_receipt=False):
        names=['manifest.json','summary.json','files.json','waveforms.png']+(['publication.json'] if include_receipt else [])
        paths=[]
        for name in names:
            path=resultdir/name
            if path.exists():
                if path.stat().st_size>5*1024*1024:raise ValueError('small Git index file exceeds 5MiB: '+name)
                paths.append(str(path.relative_to(checkout)))
        # Repository ignores result trees by default. Only this explicit small-file
        # allowlist is intentionally staged; raw archives remain Release assets.
        git(checkout,'add','-f','--',*paths)
    def scan(self,archive):
        # Fail rather than silently omit raw files if credential material is encountered.
        patterns=[rb'-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----',rb'gh[pousr]_[A-Za-z0-9]{30,}',rb'Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}']
        with tarfile.open(archive,'r:gz') as tf:
            for m in tf:
                if not m.isfile():continue
                if m.name.startswith('/') or '..' in Path(m.name).parts:raise ValueError('unsafe archive member')
                f=tf.extractfile(m);previous=b''
                for chunk in iter(lambda:f.read(1024*1024),b''):
                    data=previous+chunk
                    if any(re.search(p,data) for p in patterns):raise ValueError('credential scan blocked publication: '+m.name)
                    previous=data[-256:]
    def prepare(self,rid):
        if self.cfg.get('local_only') or not self.repo:raise PermissionError('Local intake has no publication destination')
        r=self.runner.read(rid);c=r.get('collection')
        if not c or not c.get('contains_full_raw'):raise ValueError('full raw collection required before publication')
        archive=Path(c['archive'])
        if filehash(archive)!=c['sha256']:raise ValueError('local archive changed')
        self.scan(archive);root=self.runner.path(rid)/'publication';root.mkdir(exist_ok=True)
        limit=1024**3;assets=[]
        if archive.stat().st_size<=limit:assets=[archive]
        else:
            with archive.open('rb') as f:
                i=1
                while True:
                    first=f.read(1024*1024)
                    if not first:break
                    part=root/f'full-results.tar.gz.part-{i:04d}';remaining=limit
                    with part.open('wb') as o:
                        o.write(first);remaining-=len(first)
                        while remaining:
                            b=f.read(min(1024*1024,remaining))
                            if not b:break
                            o.write(b);remaining-=len(b)
                    assets.append(part);i+=1
        if len(assets)+1>1000:raise ValueError('release would exceed 1000 assets; no data truncated')
        for name in ['waveforms.png']:
            path=self.runner.path(rid)/name
            if path.exists():assets.append(path)
        manifest={'schema':'ic.results.publication.v1','run_id':rid,'source_commit':r['source_commit'],'source_provenance':r['plan']['provenance'],'configuration':r['plan'].get('configuration'),'external_sha256':r['plan']['external_sha256'],'full_archive_sha256':c['sha256'],'full_archive_bytes':c['bytes'],'included':c['included'],'excluded':c['excluded'],'release_tag':'sim-'+rid,'assets':[{'name':p.name,'sha256':filehash(p),'bytes':p.stat().st_size,'local_path':str(p)} for p in assets]}
        atomic(root/'publication-plan.json',manifest);return manifest
    def list_assets(self,release_id):
        result=[]
        for page in range(1,12):
            part=self.api(f'repos/{self.repo}/releases/{release_id}/assets?per_page=100&page={page}');result+=part
            if len(part)<100:return result
        raise ValueError('asset pagination exceeds bounded release size')
    def verify_asset(self,asset,expected,root):
        if asset.get('state')!='uploaded' or asset.get('size')!=expected['bytes']:raise ValueError('asset state/size mismatch')
        digest=asset.get('digest')
        if digest:
            if digest!='sha256:'+expected['sha256']:raise ValueError('asset digest mismatch')
        else:
            path=root/('verify-'+str(asset['id']));argv=[self.gh,'api',f'repos/{self.repo}/releases/assets/{asset["id"]}','-H','Accept: application/octet-stream']
            with path.open('wb') as f:p=subprocess.run(argv,stdout=f,stderr=subprocess.PIPE,timeout=1800)
            if p.returncode or filehash(path)!=expected['sha256']:raise ValueError('asset download verification failed')
        return {'id':asset['id'],'name':asset['name'],'size':asset['size'],'sha256':expected['sha256'],'digest':digest,'url':asset['browser_download_url'],'verified':True}
    def final_release(self,release_id,tag,expected_assets,root):
        release=self.api(f'repos/{self.repo}/releases/{release_id}')
        if release['id']!=release_id or release['tag_name']!=tag or release.get('draft') is not False:raise ValueError('published release identity/state mismatch')
        assets={a['name']:a for a in self.list_assets(release_id)}
        verified=[self.verify_asset(assets[a['name']],a,root) for a in expected_assets]
        return release,verified
    def refresh_complete(self,r):
        receipt=r['publication'];root=self.runner.path(r['run_id'])/'publication'
        if self.api('repos/'+self.repo).get('private') is not True:raise ValueError('refusing non-private repository')
        expected=[{'name':a['name'],'bytes':a['size'],'sha256':a['sha256']} for a in receipt['assets']]
        release,verified=self.final_release(receipt['release_id'],receipt['release_tag'],expected,root)
        if release['html_url']==receipt['release_url'] and verified==receipt['assets']:return receipt
        updated={**receipt,'release_url':release['html_url'],'assets':verified,'release_target_commitish':release.get('target_commitish')}
        checkout=root/'checkout';resultdir=checkout/'results/runs'/r['run_id'];atomic(resultdir/'publication.json',updated);self.stage_index(checkout,resultdir,True)
        if git(checkout,'diff','--cached','--name-only').stdout:git(checkout,'-c','user.name=IC Workbench','-c','user.email=ic-workbench@localhost','commit','-m','Record canonical published Release URLs '+r['run_id'])
        git(checkout,'push','origin','HEAD:refs/heads/'+receipt['branch']);commit=git(checkout,'rev-parse','HEAD').stdout.decode().strip()
        if git(checkout,'ls-remote','origin','refs/heads/'+receipt['branch']).stdout.decode().split()[0]!=commit:raise Conflict('canonical URL receipt push not confirmed')
        updated['archive_commit']=commit;r['publication']=updated;self.runner.save(r);return updated
    def publish(self,rid):
        with locked(self.runner.path(rid)/'publish.lock'):
            r=self.runner.read(rid)
            if (r.get('publication') or {}).get('status')=='complete':
                if filehash(r['collection']['archive'])!=r['publication']['full_archive_sha256']:raise ValueError('published archive changed; refusing stale receipt')
                return self.refresh_complete(r)
            plan=self.prepare(rid);meta=self.api('repos/'+self.repo)
            if meta.get('private') is not True:raise ValueError('refusing public repository')
            root=self.runner.path(rid)/'publication';checkout=root/'checkout';branch='codex/results/'+rid
            if not checkout.exists():
                p=subprocess.run(['git','clone','--no-hardlinks',str(self.ws.root),str(checkout)],capture_output=True)
                if p.returncode:raise ValueError('publication clone failed')
                git(checkout,'remote','set-url','origin','https://github.com/'+self.repo+'.git')
                git(checkout,'checkout','-b',branch,r['source_commit'])
            resultdir=checkout/'results/runs'/rid;resultdir.mkdir(parents=True,exist_ok=True)
            clean_plan={**plan,'assets':[{k:v for k,v in a.items() if k!='local_path'} for a in plan['assets']]}
            atomic(resultdir/'manifest.json',clean_plan);atomic(resultdir/'summary.json',r['collection']['summary'])
            figure=self.runner.path(rid)/'waveforms.png'
            if figure.exists():
                import shutil
                shutil.copyfile(figure,resultdir/'waveforms.png')
            inventory=json.loads((self.runner.path(rid)/'archive-files.json').read_text());atomic(resultdir/'files.json',inventory)
            self.stage_index(checkout,resultdir)
            if git(checkout,'diff','--cached','--name-only').stdout:
                git(checkout,'-c','user.name=IC Workbench','-c','user.email=ic-workbench@localhost','commit','-m','Archive full simulation results '+rid)
            archive_commit=git(checkout,'rev-parse','HEAD').stdout.decode().strip();git(checkout,'push','origin','HEAD:refs/heads/'+branch)
            if git(checkout,'ls-remote','origin','refs/heads/'+branch).stdout.decode().split()[0]!=archive_commit:raise Conflict('archive branch push not confirmed')
            r['publication']={'status':'index_pushed','archive_commit':archive_commit,'branch':branch,'source_commit':r['source_commit'],'release_tag':plan['release_tag'],'full_archive_sha256':plan['full_archive_sha256']};self.runner.save(r)
            # Lookup is read-only; create exactly once if server explicitly returns 404.
            endpoint=f'repos/{self.repo}/releases/tags/{quote(plan["release_tag"],safe="")}'
            get=subprocess.run([self.gh,'api',endpoint],capture_output=True)
            if get.returncode==0:release=json.loads(get.stdout)
            elif '404' in get.stderr.decode():release=self.api('repos/'+self.repo+'/releases','POST',{'tag_name':plan['release_tag'],'target_commitish':archive_commit,'name':'Simulation '+rid,'body':'Full raw simulation archive; source commit '+r['source_commit']+'. Scientific acceptance is recorded separately.','draft':True,'prerelease':True,'make_latest':'false'})
            else:raise ValueError('release lookup failed; outcome unknown')
            upload=release['upload_url'].split('{')[0];parsed=urlparse(upload)
            if parsed.scheme!='https' or parsed.netloc!='uploads.github.com' or not parsed.path.startswith('/repos/'+self.repo+'/releases/'):raise ValueError('unexpected GitHub upload URL')
            existing={x['name']:x for x in self.list_assets(release['id'])};verified=[]
            for asset in plan['assets']:
                remote=existing.get(asset['name'])
                if remote is None:remote=self.api(upload+'?name='+quote(asset['name']),method='POST',upload=Path(asset['local_path']))
                verified.append(self.verify_asset(remote,asset,root))
            if release.get('draft'):self.api(f'repos/{self.repo}/releases/{release["id"]}','PATCH',{'draft':False,'prerelease':True,'make_latest':'false'})
            # Draft URLs may be untagged placeholders. Only record the final GET.
            release,verified=self.final_release(release['id'],plan['release_tag'],plan['assets'],root)
            receipt={**r['publication'],'status':'assets_verified','release_id':release['id'],'release_url':release['html_url'],'release_target_commitish':release.get('target_commitish'),'assets':verified,'verified_at':stamp()}
            atomic(resultdir/'publication.json',receipt);self.stage_index(checkout,resultdir,include_receipt=True)
            if git(checkout,'diff','--cached','--name-only').stdout:git(checkout,'-c','user.name=IC Workbench','-c','user.email=ic-workbench@localhost','commit','-m','Record verified GitHub Release assets '+rid)
            git(checkout,'push','origin','HEAD:refs/heads/'+branch);final=git(checkout,'rev-parse','HEAD').stdout.decode().strip()
            if git(checkout,'ls-remote','origin','refs/heads/'+branch).stdout.decode().split()[0]!=final:raise Conflict('publication receipt push not confirmed')
            receipt.update(status='complete',archive_commit=final);r['publication']=receipt;self.runner.save(r);return receipt
