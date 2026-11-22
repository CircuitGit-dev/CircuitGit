#!/usr/bin/env python3
"""Launch the local private workbench with a separate runtime Git checkout."""
import argparse,json,os,shutil,subprocess,sys
from pathlib import Path

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port',type=int,default=8766)
    p.add_argument('--config',type=Path,help='Existing trusted local gateway config')
    p.add_argument('--runtime-root',type=Path,help='New or existing isolated runtime directory')
    p.add_argument('--write-config-only',action='store_true')
    a=p.parse_args();repo=Path(__file__).resolve().parents[2]
    if a.config:
        config=a.config.resolve()
        if not config.is_file():p.error('--config must be an existing file')
    else:
        config=repo/'config/workbench.local.json'
        if not config.exists():
            runtime=(a.runtime_root or repo/'.local/workbench').resolve()
            if runtime==repo or repo.is_relative_to(runtime):p.error('runtime must be separate from repository root')
            site=repo/'config/site.local.json'
            if not site.exists():shutil.copyfile(repo/'config/site.example.json',site)
            catalog=json.loads((repo/'config/workbench.projects.json').read_text())
            defaults=json.loads((repo/'config/workbench.example.json').read_text())
            cfg={**defaults,'seed_repo':str(repo),
                 'runtime_root':str(runtime),'runs_root':str(runtime/'runs'),
                 'site_file':str(site),'gh_bin':shutil.which('gh') or 'gh','projects':catalog}
            fd=os.open(config,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w') as f:json.dump(cfg,f,indent=2);f.write('\n')
        elif a.runtime_root:p.error('Existing config preserved; edit it explicitly to change runtime-root')
    if a.write_config_only:
        print(json.dumps({'config':str(config),'server_started':False}));return
    subprocess.run([sys.executable,'-B',str(repo/'tools/dev/build.py'),'web'],check=True)
    command=[sys.executable,'-B',str(Path(__file__).with_name('server.py')),
             '--config',str(config),'--web-root',str(repo/'web'),'--port',str(a.port)]
    raise SystemExit(subprocess.call(command))
if __name__=='__main__':main()
