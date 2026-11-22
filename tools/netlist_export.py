#!/usr/bin/env python3
"""Cadence-native batch netlist export, locally or over an existing SSH alias.

Reuse an si.env produced by Cadence; override only documented identity/view
fields. This release accepts Spectre: `si -batch -command nl`.
No OA parser, source Check & Save, bridge restart, or simulator execution.
"""
import argparse, hashlib, io, json, re, shlex, subprocess, tarfile, time
from pathlib import Path, PurePosixPath

def digest(raw):return hashlib.sha256(raw).hexdigest()
def quote(s):return shlex.quote(str(s))
def write_json(p,obj):p.write_text(json.dumps(obj,indent=2)+'\n')

def load_config(path):
    c=json.loads(path.read_text())
    if c.get('schema')!='ic.netlist.export.v1':raise ValueError('Wrong config schema')
    if c['transport'] not in ('local','ssh'):raise ValueError('transport must be local or ssh')
    if c['simulator']!='spectre':raise ValueError('This release validates Spectre only; other translators need output validation adapters')
    for k in ('library','cell','view','simulator'):
        if not re.fullmatch(r'[A-Za-z0-9_.+-]+',c[k]):raise ValueError('Invalid '+k)
    for k in ('cds_lib','output_directory'):
        if not c[k].startswith('/') or '\n' in c[k]:raise ValueError('Absolute path required: '+k)
    if c['transport']=='ssh' and (c['ssh_target'].startswith('-') or not re.fullmatch(r'[A-Za-z0-9_.@-]+',c['ssh_target'])):
        raise ValueError('Invalid SSH alias')
    for key in ('view_list','stop_list'):
        if not c[key] or not all(re.fullmatch(r'[A-Za-z0-9_.+-]+',s) for s in c[key]):raise ValueError('Invalid '+key)
    template=(path.parent/c['si_env_template']).resolve()
    if not template.is_file():raise FileNotFoundError(template)
    return c,template

def si_env(c,template):
    text=template.read_text()
    replacements={
      'simLibName':json.dumps(c['library']),'simCellName':json.dumps(c['cell']),
      'simViewName':json.dumps(c['view']),'simSimulator':json.dumps(c['simulator']),
      'simViewList':"'("+' '.join(json.dumps(v) for v in c['view_list'])+')',
      'simStopList':"'("+' '.join(json.dumps(v) for v in c['stop_list'])+')',
      'simNotIncremental':'t','simReNetlistAll':'t','simNetlistHier':'t'}
    for key,value in replacements.items():
        text=re.sub(r'^'+key+r'\s*=.*\n?','',text,flags=re.M)
        text+=f'\n{key} = {value}\n'
    return text.encode()

def shell(c,script,timeout=30):
    command=['/bin/sh','-s'] if c['transport']=='local' else [
      'ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',c['ssh_target'],'/bin/sh -s']
    r=subprocess.run(command,input=script.encode(),capture_output=True,timeout=timeout)
    return r

def transfer(c,data,directory):
    command=['tar','xzf','-','-C',directory] if c['transport']=='local' else [
      'ssh','-o','BatchMode=yes',c['ssh_target'],'tar xzf - -C '+quote(directory)]
    r=subprocess.run(command,input=data,capture_output=True,timeout=45)
    if r.returncode:raise RuntimeError(r.stderr.decode(errors='replace'))

def payload_archive(files):
    buf=io.BytesIO()
    with tarfile.open(fileobj=buf,mode='w:gz') as tf:
        for name,raw in files.items():
            ti=tarfile.TarInfo(name);ti.size=len(raw);ti.mode=0o600;tf.addfile(ti,io.BytesIO(raw))
    return buf.getvalue()

def collect(c,directory,local):
    command=['tar','czf','-','-C',directory,'.'] if c['transport']=='local' else [
      'ssh','-o','BatchMode=yes',c['ssh_target'],'tar czf - -C '+quote(directory)+' .']
    r=subprocess.run(command,capture_output=True,timeout=60)
    if r.returncode:raise RuntimeError(r.stderr.decode(errors='replace'))
    with tarfile.open(fileobj=io.BytesIO(r.stdout),mode='r:gz') as tf:
        for m in tf.getmembers():
            p=PurePosixPath(m.name)
            if p.is_absolute() or '..' in p.parts or not(m.isfile() or m.isdir()):raise ValueError('Unsafe output member')
            if m.isfile():
                dest=local/p;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(tf.extractfile(m).read())

def run(args):
    c,template=load_config(args.config)
    env=si_env(c,template)
    command='nl' if c['simulator']=='spectre' else 'netlist'
    plan={'schema':'ic.netlist.export-receipt.v1','config':c,'command':['si','-batch','-cdslib',c['cds_lib'],'-command',command],
          'config_sha256':digest(args.config.read_bytes()),'si_env_template_sha256':digest(template.read_bytes()),
          'effective_si_env_sha256':digest(env),'source_save_requested':False,'simulation_started':False,
          'status':'plan_only','started_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    if args.command=='plan':print(json.dumps(plan,indent=2));return
    if args.receipt_dir.exists():raise FileExistsError('Use a new receipt directory')
    args.receipt_dir.mkdir(parents=True)
    write_json(args.receipt_dir/'manifest.json',plan)
    out=c['output_directory']
    # Refuse existing output directories. No rm, refresh, overwrite or automatic retry.
    pre=shell(c,'set -eu\ntest -r '+quote(c['cds_lib'])+'\nsha256sum '+quote(c['cds_lib'])+'\nmkdir '+quote(out)+'\n')
    (args.receipt_dir/'prepare-stderr.log').write_bytes(pre.stderr)
    if pre.returncode:raise RuntimeError('Output exists or cds.lib unavailable; see prepare-stderr.log')
    plan['cds_lib_sha256']=pre.stdout.decode().split()[0]
    wrapper='#!/bin/csh -f\n'
    for path in c['env_csh']:
        wrapper+='source '+quote(path)+'\nif ( $status != 0 ) exit 70\n'
    wrapper+='cd '+quote(out)+'\nif ( $status != 0 ) exit 70\n'
    wrapper+='which si > tool-path.txt\nwhich virtuoso >> tool-path.txt\nvirtuoso -W >& tool-version.txt\n'
    wrapper+='si -batch -cdslib '+quote(c['cds_lib'])+' -command '+command+' >& netlist.log\n'
    wrapper+='set rc=$status\necho $rc > exit.txt\nexit $rc\n'
    transfer(c,payload_archive({'si.env':env,'run.csh':wrapper.encode(),'extra.lib':b'\n'}),out)
    script='set -u\ncd '+quote(out)+'\n/usr/bin/timeout '+str(int(c.get('timeout_seconds',180)))+' /bin/csh -f run.csh > launcher.log 2>&1\nrc=$?\nprintf "%s\\n" "$rc" > launcher-exit.txt\nexit "$rc"\n'
    plan['status']='export_requested';write_json(args.receipt_dir/'manifest.json',plan)
    try:
        r=shell(c,script,timeout=int(c.get('timeout_seconds',180))+30)
        collect(c,out,args.receipt_dir/'artifacts')
        artifact=args.receipt_dir/'artifacts'
        log=(artifact/'netlist.log').read_text(errors='replace') if (artifact/'netlist.log').exists() else ''
        net=artifact/'netlist'
        errors=re.findall(r'^.*(?:ERROR|\*Error\*).*$',log,re.M)
        ok=r.returncode==0 and net.is_file() and net.stat().st_size>0 and not errors
        version=(artifact/'tool-version.txt').read_text(errors='replace') if (artifact/'tool-version.txt').exists() else ''
        if not version.strip() and (artifact/'launcher.log').exists():
            v=re.search(r'sub-version\s+(\S+)',(artifact/'launcher.log').read_text(errors='replace'))
            version=v[1] if v else None
        plan.update(status='succeeded' if ok else 'failed',exit_code=r.returncode,errors=errors,
            tool_version=version,
            artifacts=[{'path':str(p.relative_to(args.receipt_dir)),'bytes':p.stat().st_size,'sha256':digest(p.read_bytes())}
                       for p in sorted(artifact.rglob('*')) if p.is_file()])
    except Exception as exc:
        plan.update(status='unknown_or_collection_failed',error=str(exc))
        write_json(args.receipt_dir/'manifest.json',plan)
        raise
    write_json(args.receipt_dir/'manifest.json',plan)
    print(json.dumps({'status':plan['status'],'manifest':str(args.receipt_dir/'manifest.json'),'exit_code':plan['exit_code']}))
    if plan['status']!='succeeded':raise SystemExit(1)

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('command',choices=['plan','export'])
    ap.add_argument('--config',type=Path,required=True);ap.add_argument('--receipt-dir',type=Path)
    a=ap.parse_args()
    if a.command=='export' and a.receipt_dir is None:ap.error('--receipt-dir is required for export')
    run(a)
if __name__=='__main__':main()
