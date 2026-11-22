"""Run official headless native geometry export using an explicit site/config."""
import argparse,json,shlex,subprocess,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--config',type=Path,required=True);p.add_argument('--receipt-dir',type=Path,required=True);a=p.parse_args()
c=json.loads(a.config.read_text());out=a.receipt_dir;out.mkdir(parents=True,exist_ok=False)
argv=[c['exporter'],'export','--no-config','--project',c['project'],'--lib',c['library'],'--out',c['output'],'--auto-check-save=false','--format','spectre','--symbols','--scale',str(c.get('scale',10)),'--timeout',c.get('timeout','30m'),'--schematic-views',c.get('schematic_views','schematic'),'--symbol-views',c.get('symbol_views','symbol')]
if c.get('cell'):argv+=['--cell',c['cell'],'--hierarchy=true','--file-mode','separate']
argv+=['--external='+str(c.get('external',bool(c.get('cell')))).lower()]
for f in c['env_csh']:argv+=['--env-csh',f]
if c.get('cdsinit',False):argv+=['--cdsinit']
command='exec '+shlex.join(argv)+'\n'
record={'schema':'ic.native-geometry.export.v1','config':c,'command':argv,'state':'launch_requested','started_unix':time.time(),'auto_check_save':False,'simulation_requested':False}
def save(): (out/'receipt.json').write_text(json.dumps(record,indent=2)+'\n')
save()
with (out/'stdout.json').open('wb') as stdout,(out/'stderr.log').open('wb') as stderr:
    proc=subprocess.Popen(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',c['ssh_target'],'/bin/sh -s'],stdin=subprocess.PIPE,stdout=stdout,stderr=stderr)
    record['local_transport_pid']=proc.pid;save();proc.communicate(command.encode());record['exit_code']=proc.returncode
record['finished_unix']=time.time()
try:record['result']=json.loads((out/'stdout.json').read_text());record['state']=record['result'].get('state','unknown')
except ValueError:record['state']='transport_or_unparsed_failure'
save();print(json.dumps(record));raise SystemExit(proc.returncode)
