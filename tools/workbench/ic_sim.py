#!/usr/bin/env python3
"""Auditable standalone Spectre launcher prototype. Default run is offline dry-run.

Requires a reviewed, committed input bundle. Uses SSH, never a Virtuoso CIW.
No automatic submission retry, cleanup, cancellation, or license modification.
"""
import argparse, base64, hashlib, io, json, os, re, shlex, subprocess, tarfile, time, uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

HERE=Path(__file__).resolve().parent
SAFE=re.compile(r'^[A-Za-z0-9_./+-]+$')
TOKEN=re.compile(r'@EXTERNAL_([A-Z0-9_]+)@')
def fail(msg):raise ValueError(msg)
def sha(data):return hashlib.sha256(data).hexdigest()
def write(path,obj):path.write_text(json.dumps(obj,indent=2)+'\n')
def q(s):return shlex.quote(str(s))
def relpath(s):
    p=PurePosixPath(s)
    if not SAFE.fullmatch(s) or p.is_absolute() or '..' in p.parts or str(p)=='.':fail('Unsafe relative path: '+s)
    return str(p)
def site_load(path):
    s=json.loads(path.read_text());allowed={'schema','ssh_target','remote_runs_root','cadence_cshrc','spectre_bin','ocean_bin','external_files','expected_host','expected_user'}
    if set(s)-allowed:fail('Unexpected site keys; credentials must remain in SSH/site environment')
    for key in ['ssh_target','remote_runs_root','cadence_cshrc','spectre_bin']:
        if not isinstance(s.get(key),str) or not SAFE.fullmatch(s[key]) or s[key].startswith('-'):fail('Invalid site '+key)
    if not s['remote_runs_root'].startswith('/') or PurePosixPath(s['remote_runs_root']).name!='ic_on_github_runs':fail('Use a dedicated absolute directory ending ic_on_github_runs')
    for key in ['cadence_cshrc','spectre_bin']:
        if not s[key].startswith('/'):fail('Absolute path required: '+key)
    for key,val in s.get('external_files',{}).items():
        if not re.fullmatch(r'[A-Z0-9_]+',key) or not SAFE.fullmatch(val) or not val.startswith('/'):fail('Invalid external path alias')
    return s
def ssh(site,script,timeout=30,data=None):
    # The site's login shell is csh; literal multiline quoted commands break there.
    # Keep the SSH command one line; decode trusted generated shell inside /bin/sh.
    encoded=base64.b64encode(script.encode()).decode()
    wrapper='eval "$(printf %s '+encoded+' | /usr/bin/base64 -d)"'
    return subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',site['ssh_target'],'/bin/sh -c '+q(wrapper)],input=data,capture_output=True,timeout=timeout)
def git(root,*args):
    p=subprocess.run(['git','-C',str(root),*args],capture_output=True,text=True)
    return p.stdout.strip() if p.returncode==0 else None
def prepare(bundle,site):
    b=json.loads(bundle.read_text());root=(bundle.parent/b['source_root']).resolve()
    if b.get('schema')!='ic.sim.bundle.v1':fail('Wrong bundle schema')
    entry=relpath(b['entrypoint']);payload={};provenance=[]
    for row in b['files']:
        dst=relpath(row['destination']);src=(root/row['source']).resolve()
        if not src.is_relative_to(root) or not src.is_file() or src.is_symlink():fail('Input outside source root or missing: '+str(src))
        if dst in payload:fail('Duplicate destination: '+dst)
        raw=src.read_bytes()
        if sha(raw)!=row['sha256']:fail('Input hash mismatch: '+str(src))
        text=raw.decode('utf-8')
        # Every external model stays referenced by an explicit server alias.
        text=TOKEN.sub(lambda m: site['external_files'][m[1]],text)
        if '@EXTERNAL_' in text:fail('Unresolved external alias')
        payload[dst]=text.encode();provenance.append({'source':str(src),'destination':dst,'source_sha256':sha(raw),'staged_sha256':sha(payload[dst])})
    if entry not in payload:fail('Entry point missing from payload')
    staged_headers={}
    if b.get('veriloga_header_staging') is not None:
        from onboarding_veriloga import prepare_header_staging
        staged_headers=prepare_header_staging(b,site,payload,provenance)
    external=set(site.get('external_files',{}).values())
    # Fail closed on missing include closure; only Cadence builtin VA headers exempted.
    for name,raw in payload.items():
        text=raw.decode()
        for dep in re.findall(r'^\s*(?:include|ahdl_include|`include)\s+"([^"]+)"',text,re.M):
            if staged_headers:
                import posixpath
                if posixpath.normpath(posixpath.join(posixpath.dirname(name),dep)) in staged_headers:continue
            if dep in ['constants.vams','disciplines.vams']:continue
            if dep.startswith('/'):
                if dep not in external:fail('Unmapped absolute include in '+name+': '+dep)
            elif str(PurePosixPath(name).parent/relpath(dep)) not in payload:fail('Unstaged include in '+name+': '+dep)
    commit=git(root,'rev-parse','--verify','HEAD');dirty=git(root,'status','--porcelain','--untracked-files=normal')
    proof={'source_commit':commit,'source_clean':dirty=='' if dirty is not None else False,'source_root':str(root),'bundle_sha256':sha(bundle.read_bytes()),'runner_sha256':sha(Path(__file__).read_bytes()),'site_config_sha256':sha(json.dumps(site,sort_keys=True).encode()),'files':provenance}
    return b,payload,proof
def simulator_config(bundle):
    sim=dict(bundle.get('simulator',{}));profile=sim.get('profile','spectre-default')
    defaults=['-64','+aps','+mt=2','+lqtimeout','900','-maxw','5','-maxn','5'] if profile=='nov6-aps2' else ['-64']
    sim.setdefault('profile',profile);sim.setdefault('args',defaults);sim.setdefault('output_format','psfxl')
    if sim['output_format'] not in ['psfxl','psfascii','psfbin']:fail('Unsupported output_format')
    if not isinstance(sim['args'],list) or any(not isinstance(x,str) or '\n' in x or '\x00' in x for x in sim['args']):fail('simulator.args must be single-line argv strings')
    if any(x.split('=')[0] in ['+log','-raw','-format','-ahdllibdir','-param'] for x in sim['args']):fail('Output paths and -param are reserved; parameterize the source deck')
    return sim
def external_pins(bundle):
    pins={d['alias']:d['sha256'] for d in bundle.get('external_dependencies',[])}
    for key,value in bundle.get('external_sha256',{}).items():
        if key in pins and pins[key]!=value:fail('Conflicting external pin: '+key)
        pins[key]=value
    return pins
def check_external(bundle,site,probe):
    pins=external_pins(bundle)
    for key,value in pins.items():
        if key not in site['external_files'] or not re.fullmatch(r'[a-f0-9]{64}',value) or probe['dependency_sha256'].get(key)!=value:fail('External dependency hash mismatch or missing pin: '+key)
    return pins
def required_aliases(proof,site):
    text='\n'.join(Path(x['source']).read_text() for x in proof['files'])
    used=set(TOKEN.findall(text))
    for path in re.findall(r'^\s*(?:include|ahdl_include|`include)\s+"([^"]+)"',text,re.M):
        used.update(key for key,value in site['external_files'].items() if value==path)
    return used
def scripts(site,entry,simulator=None,*,veriloga_staging=False):
    sim=simulator or simulator_config({})
    args=[site['spectre_bin'],*sim['args'],PurePosixPath(entry).name,'+escchars','+log','../psf/spectre.out','-format',sim['output_format'],'-raw','../psf','-ahdllibdir','../ahdl','+logstatus']
    env='#!/bin/csh -f\nsource '+site['cadence_cshrc']+'\nif ( $status != 0 ) exit 70\nexec '+' '.join(q(x) for x in args)+'\n'
    job='''#!/bin/sh
set -u
cd "$(dirname "$0")" || exit 70
umask 077
terminal_written=0
on_exit() {
  rc=$?
  if [ "$terminal_written" != 1 ]; then
    printf '%s\n' "$rc" > exit_code
    printf 'job_setup_failed\n' > state.tmp
    mv state.tmp state
  fi
}
trap on_exit 0
printf 'running\n' > state.tmp
mv state.tmp state || exit 70
if ! sha256sum -c payload.sha256 > checksums.log 2>&1; then
  printf '71\n' > exit_code
  printf 'input_hash_failure\n' > state
  terminal_written=1
  exit 71
fi
if [ -f external.sha256 ] && ! sha256sum -c external.sha256 > external-checksums.log 2>&1; then
  printf '72\n' > exit_code
  printf 'input_hash_failure\n' > state
  terminal_written=1
  exit 72
fi
mkdir -p psf ahdl || exit 70
cd netlist || exit 70
/bin/csh -f ../cadence.csh > ../console.log 2>&1
rc=$?
cd .. || exit 70
printf '%s\n' "$rc" > exit_code.tmp
mv exit_code.tmp exit_code
if [ "$rc" = 0 ] && grep -Eq 'spectre completes with 0 errors,' psf/spectre.out; then
  printf 'simulator_complete_pending_measurements\n' > state.tmp
else
  printf 'simulator_failed\n' > state.tmp
fi
mv state.tmp state
terminal_written=1
exit "$rc"
'''
    if veriloga_staging:
        job=job.replace('mkdir -p psf ahdl || exit 70','/bin/sh ./veriloga-stage.sh || exit 73\nmkdir -p psf ahdl || exit 70',1)
    return {'cadence.csh':env.encode(),'job.sh':job.encode()}
def archive(payload):
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w:gz') as tf:
        for name,data in sorted(payload.items()):
            info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o600;info.mtime=0;tf.addfile(info,io.BytesIO(data))
    return stream.getvalue()
def stage_command(site,remote):
    return f'umask 077\nmkdir -p {q(site["remote_runs_root"])} || exit 70\nmkdir {q(remote)} || exit 75\ncd {q(remote)} || exit 70\nif ! tar xzf -; then printf "staging_failed\\n" > state; exit 71; fi\nprintf "staged\\n" > state\n'
def launch_command(remote):
    return f'cd {q(remote)} || exit 70\nmkdir launch_once 2>/dev/null || exit 75\nnohup /bin/sh job.sh >/dev/null 2>&1 </dev/null &\necho $! > supervisor.pid\n'
def doctor(site):
    checks={'cadence_setup':site['cadence_cshrc'],'spectre':site['spectre_bin'],**site.get('external_files',{})}
    script='hostname\nid -un\n'
    for cmd in ['tar','nohup','sha256sum']:
        script+=f'if command -v {q(cmd)} >/dev/null 2>&1; then printf "%s\\n" {q("TOOL_"+cmd+"=ok")}; else printf "%s\\n" {q("TOOL_"+cmd+"=MISSING")}; fi\n'
    for path in ['/bin/sh','/bin/csh','/usr/bin/base64','/usr/bin/timeout']:
        script+=f'if test -x {q(path)}; then printf "%s\\n" {q("TOOL_"+path+"=ok")}; else printf "%s\\n" {q("TOOL_"+path+"=MISSING")}; fi\n'
    for key,path in checks.items():script+=f'if test -r {q(path)}; then printf "%s\\n" {q(key+"=readable")}; printf "%s " {q("SHA256_"+key)}; sha256sum {q(path)}; else printf "%s\\n" {q(key+"=MISSING")}; fi\n'
    script+=f'/usr/bin/timeout 15 {q(site["spectre_bin"])} -V\n'
    p=ssh(site,script);text=p.stdout.decode(errors='replace')
    hashes=dict(re.findall(r'^SHA256_(\S+) ([a-f0-9]{64}) ',text,re.M))
    tools_ok=all('TOOL_'+key+'=ok' in text.splitlines() for key in ['tar','nohup','sha256sum','/bin/sh','/bin/csh','/usr/bin/base64','/usr/bin/timeout'])
    return {'exit_code':p.returncode,'checks':text.splitlines(),'dependency_sha256':hashes,'stderr':p.stderr.decode(errors='replace'),'license_checkout':'not_attempted','simulation':'not_started','identity_ok':all(x in text.splitlines()[:2] for x in [site.get('expected_host',''),site.get('expected_user','')]),'all_tools_available':tools_ok,'all_references_readable':bool(checks) and all(key+'=readable' in text.splitlines() for key in checks)}
def state(site,receipt):
    remote=receipt['remote_directory'];p=ssh(site,f'cd {q(remote)} && {{ cat state 2>/dev/null; test ! -f exit_code || cat exit_code; }}')
    return {'ssh_exit':p.returncode,'reported_state':p.stdout.decode().strip() or 'unknown','note':'A stale running state is not proof the process is alive; never resubmit on ambiguity'}
def collect(site,receipt,dest,raw=False):
    remote=receipt['remote_directory'];names=['run.json','state','exit_code','payload.sha256','external.sha256','checksums.log','external-checksums.log','console.log','psf/spectre.out']+(['psf'] if raw else [])
    # Downloads an archive without extracting it; no remote input path can overwrite local source files.
    code='cd '+q(remote)+' || exit 70\nset --\n'
    for name in names:code+=f'test ! -e {q(name)} || set -- "$@" {q(name)}\n'
    code+='tar czf - "$@"\n';p=ssh(site,code,timeout=600)
    if p.returncode:fail('Collection failed; retain receipt and recover without launching')
    file=dest/('raw-results.tar.gz' if raw else 'results.tar.gz');file.write_bytes(p.stdout)
    return {'archive':str(file),'sha256':sha(p.stdout),'includes_raw_psf':raw}
def run(args,site):
    b,payload,proof=prepare(args.bundle,site)
    if PurePosixPath(b['entrypoint']).parent!=PurePosixPath('netlist'):fail('Prototype entrypoint must be netlist/input.scs')
    runid=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+(proof['source_commit'] or 'uncommitted')[:12]+'-'+uuid.uuid4().hex[:8]
    remote=site['remote_runs_root']+'/'+runid
    identity={key:b.get(key) for key in ['design_id','library','top_cell','testbench','history','test']};sim=simulator_config(b);pins=external_pins(b)
    plan={'schema':'ic.sim.run.v1','run_id':runid,'test_id':b['test_id'],**identity,'design_origin':b.get('design_origin','oa-export'),'historical_reference':b.get('historical_reference'),'configuration':b.get('configuration',{}),'simulator':sim,'external_dependencies':b.get('external_dependencies',[]),'external_sha256':pins,'remote_directory':remote,'ssh_target':site['ssh_target'],'solver_flags':sim['args'],'format':sim['output_format'],'entrypoint':b['entrypoint'],'provenance':proof,'reviewed_for_distribution':b.get('reviewed_for_distribution',False),'simulation_started':False}
    if not args.execute:
        plan.update(mode='offline_dry_run',blockers=[msg for condition,msg in [(not proof['source_commit'],'source_has_no_commit'),(not proof['source_clean'],'source_not_clean'),(not b.get('reviewed_for_distribution'),'payload_review_pending')] if condition]);print(json.dumps(plan,indent=2));return
    if not proof['source_commit'] or not proof['source_clean'] or not b.get('reviewed_for_distribution'):fail('Execute requires a clean committed source and reviewed payload')
    if not b.get('design_id'):fail('Execute requires design_id')
    if b.get('design_origin','oa-export')!='text-netlist' and any(not v for v in identity.values()):fail('OA export requires design_id/library/top_cell/testbench/history/test identity')
    source=Path(proof['source_root'])
    for path in [args.bundle.resolve()]+[Path(x['source']) for x in proof['files']]:
        if not path.is_relative_to(source) or git(source,'ls-files','--error-unmatch','--',str(path.relative_to(source))) is None:fail('Bundle and all payload sources must be tracked in source commit')
    check=doctor(site)
    if check['exit_code'] or not check['identity_ok'] or not check['all_references_readable'] or not check['all_tools_available']:fail('Remote dependency/identity preflight failed')
    pins=check_external(b,site,check)
    used=required_aliases(proof,site)
    if not used.issubset(pins):fail('Every used external alias must have an exact manifest hash pin')
    plan['runtime_preflight']=check
    local=args.results/runid;local.mkdir(parents=True,exist_ok=False)
    plan['status']='prepared_not_submitted';write(local/'run.json',plan)
    payload.update(scripts(site,b['entrypoint'],sim,veriloga_staging=b.get('veriloga_header_staging') is not None));payload['run.json']=json.dumps(plan,indent=2).encode()
    runtime_pins=[(value,site['external_files'][key]) for key,value in pins.items()]+[(check['dependency_sha256']['cadence_setup'],site['cadence_cshrc']),(check['dependency_sha256']['spectre'],site['spectre_bin'])]
    payload['external.sha256']=''.join(h+'  '+p+'\n' for h,p in runtime_pins).encode()
    payload['payload.sha256']=''.join(sha(v)+'  '+k+'\n' for k,v in sorted(payload.items())).encode()
    # Atomic run directory; existing ID cannot be overwritten. No transport retries.
    p=ssh(site,stage_command(site,remote),data=archive(payload),timeout=60)
    if p.returncode:fail('Staging failed or outcome unknown. Keep '+str(local/'run.json'))
    plan['status']='launch_request_outcome_unknown';write(local/'run.json',plan)
    launch=launch_command(remote)
    try:
        p=ssh(site,launch)
        if p.returncode:fail('Launch outcome unknown; use status/fetch with receipt')
        plan['status']='submitted';plan['simulation_started']='requested_not_yet_observed';write(local/'run.json',plan)
        deadline=time.monotonic()+args.wait_seconds
        while time.monotonic()<deadline:
            observed=state(site,plan);write(local/'last_status.json',observed)
            if 'simulator_complete_pending_measurements' in observed['reported_state'] or 'failed' in observed['reported_state'] or 'input_hash_failure' in observed['reported_state']:
                plan['terminal_observation']=observed;plan['collection']=collect(site,plan,local,args.raw);write(local/'run.json',plan);print(json.dumps(plan,indent=2))
                if 'simulator_complete_pending_measurements' not in observed['reported_state']:raise SystemExit(1)
                return
            if observed['ssh_exit']:break
            time.sleep(5)
    except (subprocess.TimeoutExpired,OSError,ValueError) as error:
        plan['error']=str(error)
    plan['status']='reconcile_required';write(local/'run.json',plan);print(json.dumps(plan,indent=2));raise SystemExit(75)
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--site',required=True,type=Path);subs=ap.add_subparsers(dest='command',required=True)
    pre=subs.add_parser('preflight',aliases=['doctor']);pre.add_argument('--bundle',type=Path)
    for name in ['plan','run']:
        r=subs.add_parser(name);r.add_argument('--bundle',required=True,type=Path);r.add_argument('--execute',action='store_true');r.add_argument('--wait-seconds',type=int,default=3600);r.add_argument('--results',type=Path,default=HERE/'runs');r.add_argument('--raw',action='store_true')
    for name in ['status','collect']:
        s=subs.add_parser(name,aliases=['fetch'] if name=='collect' else []);s.add_argument('--receipt',required=True,type=Path)
        if name=='collect':s.add_argument('--raw',action='store_true')
    a=ap.parse_args();site=site_load(a.site)
    if a.command in ['doctor','preflight']:
        prepared=prepare(a.bundle,site) if a.bundle else None;bundle=prepared[0] if prepared else None
        result=doctor(site)
        if bundle is not None:
            try:
                result['verified_external_sha256']=check_external(bundle,site,result)
                if not required_aliases(prepared[2],site).issubset(result['verified_external_sha256']):fail('Every used external alias must have a manifest hash pin')
            except ValueError as error:result['bundle_error']=str(error);result['exit_code']=2
        print(json.dumps(result,indent=2))
        raise SystemExit(0 if result['exit_code']==0 and result['identity_ok'] and result['all_references_readable'] and result['all_tools_available'] else 2)
    if a.command in ['run','plan']:
        if a.command=='plan' and a.execute:fail('plan never executes; use run --execute')
        run(a,site);return
    receipt=json.loads(a.receipt.read_text());remote=receipt['remote_directory']
    if receipt['ssh_target']!=site['ssh_target'] or not remote.startswith(site['remote_runs_root']+'/') or not SAFE.fullmatch(remote) or '..' in PurePosixPath(remote).parts:fail('Receipt/site mismatch')
    result=state(site,receipt) if a.command=='status' else collect(site,receipt,a.receipt.parent,a.raw)
    print(json.dumps(result,indent=2))
    if a.command=='status':
        if result['ssh_exit']:raise SystemExit(2)
        if result['reported_state']=='unknown':raise SystemExit(75)
if __name__=='__main__':
    try:main()
    except (ValueError,KeyError,OSError,subprocess.TimeoutExpired) as exc:
        import sys
        print('ERROR: '+str(exc),file=sys.stderr);raise SystemExit(2)
