"""Inspect and initialize only the two pinned official upstream submodules.

Python 3.8+, standard library only. Inspection never initializes a checkout or
searches an enclosing repository. Existing nonmatching or dirty work is refused.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


UPSTREAMS = {
    'rnl': {'relative_path':'submodules/rnl','repository':'https://github.com/rich-netlist/rnl.git'},
    'spiceowl': {'relative_path':'submodules/spiceowl','repository':'https://github.com/spiceowl-dev/spiceowl.git'},
}
HASH = re.compile(r'[a-f0-9]{40}\Z')


class UpstreamError(RuntimeError):
    """The source identity is unavailable or unsafe; no reset is permitted."""


def _regular(path):
    if path.is_symlink() or not path.is_file():
        raise UpstreamError('Expected a regular pinned metadata file: '+str(path))
    return path


def _json(path):
    try:return json.loads(_regular(path).read_text(encoding='utf-8'))
    except (OSError,ValueError,TypeError) as error:
        raise UpstreamError('Invalid upstream metadata: '+str(path)) from error


def _pins(root,names):
    result={}
    for name in names:
        if name not in UPSTREAMS:raise UpstreamError('Unknown upstream source')
        spec=UPSTREAMS[name]
        if name=='spiceowl':
            value=_json(root/'contracts/spiceowl-integration.lock.json')
            pin=value.get('spiceowl') or {}
            if value.get('schema')!='circuitgit.spiceowl-integration.v1':raise UpstreamError('Invalid SpiceOwl lock schema')
            repository,commit=pin.get('repository'),pin.get('commit')
        else:
            pin=_json(root/'tools/viewer/upstream-lock.json')
            repository,commit=pin.get('upstream_repository'),pin.get('upstream_commit')
            if repository==spec['repository'][:-4]:repository=spec['repository']
            provenance=_json(root/'apps/web/vendor/rnl-viewer/provenance.json')
            if provenance.get('commit')!=commit or provenance.get('upstream') not in (spec['repository'],spec['repository'][:-4]):
                raise UpstreamError('RNL lock and vendored provenance differ')
        if repository!=spec['repository'] or not isinstance(commit,str) or not HASH.fullmatch(commit):
            raise UpstreamError('Upstream lock must identify its official repository and exact commit')
        result[name]={'name':name,**spec,'path':str(root/spec['relative_path']),'commit':commit,
            'gitlink_commit':None,'head_commit':None,'tree':None,'status':'unchecked','gitlink_verified':False}
    return result


def _environment():
    env={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull,GIT_TERMINAL_PROMPT='0',GIT_OPTIONAL_LOCKS='0')
    return env


def _git(root,args,run,*,timeout=30,allow_missing=False):
    command=['git','-c','core.hooksPath='+os.devnull,'-c','core.fsmonitor=false',
        '-c','core.attributesFile='+os.devnull,'-c','protocol.allow=never',
        '-c','protocol.https.allow=always','-c','credential.helper=',
        '-C',str(root),*args]
    try:reply=run(command,capture_output=True,text=True,timeout=timeout,check=False,env=_environment())
    except (OSError,subprocess.TimeoutExpired) as error:
        raise UpstreamError('Pinned upstream Git operation could not finish; no checkout was reset') from error
    if reply.returncode:
        if allow_missing and reply.returncode==1:return None
        raise UpstreamError('Pinned upstream Git operation failed; preserve the existing checkout and inspect its state')
    return reply.stdout


def _safe_path(root,relative):
    target=root/relative
    for part in (target,*target.parents):
        if part.is_symlink():raise UpstreamError('Upstream paths cannot redirect through symlinks')
        if part==root:break
    return target


def inspect_upstreams(root,*,run=None,require_initialized=False,names=('rnl','spiceowl')):
    root=Path(root).resolve();run=run or subprocess.run
    if not isinstance(names,(tuple,list)) or not names or len(set(names))!=len(names):raise UpstreamError('Select explicit distinct upstream names')
    sources=_pins(root,names)
    # Archives and standalone distributions cannot prove a Git index binding.
    # Do not let git -C accidentally discover a repository above this root.
    if not (root/'.git').exists():
        if require_initialized:raise UpstreamError('This source archive has no Git submodule checkout')
        return {'schema':'circuitgit.upstream-sources.v1','status':'unchecked','sources':sources}
    if (root/'.git').is_symlink():raise UpstreamError('The repository Git marker cannot be a symlink')
    top=_git(root,['rev-parse','--show-toplevel'],run).strip()
    if Path(top).resolve()!=root:raise UpstreamError('Upstream checks must run at their own repository root')
    modules=_safe_path(root,'.gitmodules');_regular(modules)
    configured={}
    for item in _git(root,['config','--null','--file',str(modules),'--list'],run).split('\0'):
        if not item:continue
        key,separator,value=item.partition('\n')
        if not separator or key in configured:raise UpstreamError('Duplicate or malformed submodule settings')
        configured[key]=value
    expected={key:value for name,spec in UPSTREAMS.items() for key,value in (
        ('submodule.'+name+'.path',spec['relative_path']),('submodule.'+name+'.url',spec['repository']))}
    if configured!=expected:raise UpstreamError('Only the two explicit official upstream submodules are supported')
    for name,row in sources.items():
        path=_safe_path(root,row['relative_path'])
        entries=_git(root,['ls-files','--stage','-z','--',row['relative_path']],run).split('\0')
        entries=[entry for entry in entries if entry]
        if len(entries)!=1:raise UpstreamError('Missing or conflicted upstream Git index entry: '+name)
        metadata,separator,index_path=entries[0].partition('\t')
        if not separator or metadata!='160000 '+row['commit']+' 0' or index_path!=row['relative_path']:
            raise UpstreamError('Upstream Git link differs from its dependency lock: '+name)
        row.update(gitlink_commit=row['commit'],gitlink_verified=True)
        configured_url=_git(root,['config','--local','--get','submodule.'+name+'.url'],run,allow_missing=True)
        if configured_url is not None and configured_url.strip()!=row['repository']:
            raise UpstreamError('Existing submodule URL differs from its official origin: '+name)
        if not path.exists() or path.is_dir() and not any(path.iterdir()):
            row['status']='missing';continue
        if not path.is_dir() or not (path/'.git').exists() or (path/'.git').is_symlink():
            raise UpstreamError('Preserve the existing non-submodule content: '+name)
        if Path(_git(path,['rev-parse','--show-toplevel'],run).strip()).resolve()!=path.resolve():
            raise UpstreamError('The upstream path resolves to another repository: '+name)
        origin=_git(path,['config','--local','--get','remote.origin.url'],run,allow_missing=True)
        if origin is None or origin.strip()!=row['repository']:raise UpstreamError('Upstream origin differs from its official URL: '+name)
        head=_git(path,['rev-parse','--verify','HEAD'],run).strip()
        if head!=row['commit']:raise UpstreamError('Existing upstream HEAD differs from its Git link; no automatic checkout: '+name)
        if _git(path,['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none'],run):
            raise UpstreamError('Upstream checkout has local changes; preserve them before setup: '+name)
        tree=_git(path,['rev-parse','HEAD^{tree}'],run).strip()
        if not HASH.fullmatch(tree):raise UpstreamError('Upstream tree identity is invalid: '+name)
        row.update(status='ready',head_commit=head,tree=tree)
    status='ready' if all(row['status']=='ready' for row in sources.values()) else 'missing'
    if require_initialized and status!='ready':raise UpstreamError('Initialize the pinned upstream submodules before continuing')
    return {'schema':'circuitgit.upstream-sources.v1','status':status,'sources':sources}


def ensure_upstreams(root,*,run=None,progress=None):
    root=Path(root).resolve();run=run or subprocess.run
    progress=progress or (lambda message:None)
    observed=inspect_upstreams(root,run=run)
    if observed['status']=='unchecked':return observed
    paths=[row['relative_path'] for row in observed['sources'].values()]
    progress('核验并同步官方上游子模块…')
    _git(root,['submodule','sync','--',*paths],run,timeout=120)
    missing=[row['relative_path'] for row in observed['sources'].values() if row['status']=='missing']
    if missing:
        progress('初始化缺失的固定版本子模块…')
        _git(root,['submodule','update','--init','--checkout','--',*missing],run,timeout=600)
    return inspect_upstreams(root,run=run,require_initialized=True)


def spiceowl_source(root,pin,*,run=None):
    observed=inspect_upstreams(root,run=run,names=('spiceowl',))
    row=observed['sources']['spiceowl']
    if {key:row[key] for key in ('repository','commit')}!=pin:raise UpstreamError('Bootstrap and upstream SpiceOwl pins differ')
    return row if row['status']=='ready' else None


def archive_source(root,source,destination,*,run=None):
    """Export committed bytes only; pip never writes inside the submodule."""
    root=Path(root).resolve();run=run or subprocess.run;destination=Path(destination)
    pin={key:source[key] for key in ('repository','commit')}
    current=spiceowl_source(root,pin,run=run)
    if current!=source:raise UpstreamError('Upstream source changed before archive creation')
    if destination.exists() or destination.is_symlink() or not destination.parent.is_dir():
        raise UpstreamError('Source archives require a new private destination')
    _git(Path(source['path']),['archive','--format=tar','--output='+str(destination),source['commit']],run,timeout=120)
    if source!=spiceowl_source(root,pin,run=run):raise UpstreamError('Upstream source changed during archive creation')
    _regular(destination);destination.chmod(0o600)
    return {'schema':'circuitgit.upstream-archive.v1','source':source,
        'url':destination.resolve().as_uri(),'sha256':hashlib.sha256(destination.read_bytes()).hexdigest()}
