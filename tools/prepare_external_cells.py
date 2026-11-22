#!/usr/bin/env python3
"""Create hash-pinned external cell adapters beside existing server evidence.

Reads the original netlist on the licensed host. Only hashes cross SSH stdout;
vendor subcircuit implementations remain on that host and outside the Git repo.
"""
import argparse,json,subprocess
from pathlib import Path

WORKER=r'''
from __future__ import print_function
import os,json,re,hashlib
cfg=json.loads(CONFIG)
root=cfg['output_directory']
if not os.path.isdir(root):os.makedirs(root,0o700)
rows=[]
for entry in cfg['cells']:
 raw=open(entry['source_netlist'],'rb').read()
 if hashlib.sha256(raw).hexdigest()!=entry['source_netlist_sha256']:raise RuntimeError('Original netlist hash differs')
 pattern=r'^subckt\s+'+re.escape(entry['cell'])+r'[^\n]*\n.*?^ends[^\n]*\n'
 matches=re.findall(pattern,raw.decode('utf-8'),re.M|re.S)
 if len(matches)!=1:raise RuntimeError('Ambiguous cell block')
 data=('simulator lang=spectre\n'+matches[0]).encode('utf-8')
 if hashlib.sha256(data).hexdigest()!=entry['sha256']:raise RuntimeError('Cell hash differs')
 dest=os.path.join(root,entry['external_filename'])
 if os.path.exists(dest):
  if open(dest,'rb').read()!=data:raise RuntimeError('Existing external adapter differs')
 else:
  fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  os.write(fd,data);os.close(fd)
 rows.append({'alias':entry['alias'],'path':dest,'sha256':hashlib.sha256(open(dest,'rb').read()).hexdigest()})
print(json.dumps({'external_files':rows,'implementation_transferred_to_client':False},indent=2))
'''

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--config',type=Path,required=True);ap.add_argument('--receipt',type=Path,required=True)
    a=ap.parse_args();c=json.loads(a.config.read_text())
    if c['ssh_target'].startswith('-') or not c['output_directory'].startswith('/'):raise ValueError('Invalid host/path')
    code=WORKER.replace('CONFIG',repr(json.dumps(c)))
    r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',c['ssh_target'],'/usr/bin/python -'],
        input=code.encode(),capture_output=True,timeout=60)
    if r.returncode:raise RuntimeError(r.stderr.decode(errors='replace'))
    data=json.loads(r.stdout);a.receipt.parent.mkdir(parents=True,exist_ok=True);a.receipt.write_text(json.dumps(data,indent=2)+'\n')
    print(json.dumps(data,indent=2))
if __name__=='__main__':main()
