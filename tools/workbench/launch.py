#!/usr/bin/env python3
"""Launch the local private workbench with a separate runtime Git checkout."""
import argparse,json,os,shutil,subprocess,sys
from pathlib import Path

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port',type=int,default=8766)
    p.add_argument('--config',type=Path,help='Existing trusted local gateway config')
    p.add_argument('--runtime-root',type=Path,help='New or existing isolated runtime directory')
    p.add_argument('--local-sim',choices=['ngspice','xyce'],help='Configure a local open-source SPICE site instead of remote Spectre')
    p.add_argument('--site-mode',choices=['auto','local','spectre'],default='auto',help='Initial site selection when site.local.json is absent (auto prefers installed local ngspice/Xyce)')
    p.add_argument('--simulator-bin',type=Path,help='Explicit path to local ngspice or Xyce executable')
    p.add_argument('--open-pdk',choices=['builtin','sky130','gf180mcu','ihp-sg13g2'],default='builtin',help='Open-source PDK profile for --local-sim')
    p.add_argument('--pdk-root',type=Path,help='Absolute root directory of the installed open PDK (required for non-builtin PDK)')
    p.add_argument('--pdk-corner',help='Open-source PDK corner (e.g., tt, ff, ss, typical, mos_tt)')
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
            if not site.exists():
                engine=a.local_sim
                sim_bin=str(a.simulator_bin.resolve()) if a.simulator_bin else None
                local_mod=Path(__file__).resolve().with_name('local_sim.py')
                if engine or (a.site_mode in ('auto','local') and local_mod.is_file()):
                    sys.path.insert(0,str(Path(__file__).resolve().parent))
                    from local_sim import detect_local_simulator,validate_local_site
                    if not engine:
                        for candidate in ('ngspice','xyce'):
                            found=sim_bin or detect_local_simulator(candidate)
                            if found:engine,sim_bin=candidate,found;break
                    elif not sim_bin:
                        sim_bin=detect_local_simulator(engine)
                    if engine and sim_bin:
                        open_pdk={'pdk':a.open_pdk}
                        if a.pdk_root:open_pdk['root']=str(a.pdk_root.resolve())
                        if a.pdk_corner:open_pdk['corner']=a.pdk_corner
                        local_site=validate_local_site({
                            'schema':'ic.sim.local-site.v1','transport':'local','engine':engine,
                            'simulator_bin':sim_bin,'runs_root':str(runtime/'ic_on_github_runs'),
                            'open_pdk':open_pdk,'external_files':{},
                        })
                        fd_s=os.open(site,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                        with os.fdopen(fd_s,'w') as sf:json.dump(local_site,sf,indent=2);sf.write('\n')
                    elif a.local_sim or a.site_mode=='local':
                        p.error(f'Local {a.local_sim or "ngspice/xyce"} executable not found on PATH; pass --simulator-bin /abs/path')
                    else:
                        shutil.copyfile(repo/'config/site.example.json',site)
                else:
                    shutil.copyfile(repo/'config/site.example.json',site)
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
    subprocess.run([sys.executable,'-X','utf8','-B',str(repo/'tools/dev/build.py'),'web'],check=True)
    command=[sys.executable,'-X','utf8','-B',str(Path(__file__).with_name('server.py')),
             '--config',str(config),'--web-root',str(repo/'web'),'--port',str(a.port)]
    raise SystemExit(subprocess.call(command))
if __name__=='__main__':
    if any(flag in sys.argv[1:] for flag in ('--help','-h','--write-config-only')):main()
    else:
        from bootstrap_python import run_entrypoint
        raise SystemExit(run_entrypoint(__file__,main))
