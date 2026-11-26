"""Publish bounded, cell-scoped circuit/netlist Git metadata; never docs-only noise or old source text."""
import json
import os
from pathlib import Path
import subprocess

CIRCUIT_SOURCE_SUFFIXES = (
    '.scs', '.rnl', '.sp', '.spice', '.cir', '.cdl', '.ckt', '.net', '.inc', '.va', '.vams',
)


def is_circuit_source(path):
    return path.lower().endswith(CIRCUIT_SOURCE_SUFFIXES)


def generate(root):
    root = Path(root).resolve()
    def git(*args):
        return subprocess.check_output(['git','-c','core.hooksPath='+os.devnull,'-c','core.fsmonitor=false',
                                        '-C',str(root),*args], timeout=20)
    head = git('rev-parse','HEAD').decode().strip()
    shallow = git('rev-parse','--is-shallow-repository').decode().strip() == 'true'
    catalog = json.loads((root/'lib/catalog.json').read_text()) if (root/'lib/catalog.json').exists() else {'libraries':[]}
    rows=[]
    for library in catalog['libraries']:
        manifest=json.loads((root/library['manifest']).read_text())
        for cell in manifest['cells']:
            prefix=cell['directory']+'/'
            raw_paths={p for v in cell['views'] for p in v['files']}
            project=cell.get('project_id');legacy='projects/'+project+'/' if project else None
            # Only record commits that actually modified schematic/netlist/RNL/Verilog-A sources.
            paths=sorted(
                p for p in raw_paths
                if is_circuit_source(p) and (p.startswith(prefix) or (legacy and p.startswith(legacy)))
            )
            commits=[]
            if paths:
                raw=git('log','-31','--format=%H%x00%s%x00%aI%x1e',head,'--',*paths)
                for record in raw.decode().split('\x1e'):
                    record=record.strip('\n')
                    if not record:continue
                    sha,subject,date=record.split('\0',2)
                    # Filenames are only circuit sources that changed within this exact scope;
                    # no README/metadata noise, global app history, author emails or historical blobs.
                    changed=[
                        p for p in git('diff-tree','--root','--no-commit-id','--name-only','-r',sha,'--',*paths).decode().splitlines()
                        if is_circuit_source(p)
                    ]
                    if not changed:continue
                    commits.append({'sha':sha,'subject':subject,'date':date,'files':changed})
            rows.append({'library_id':library['id'],'cell_id':cell['id'],'directory':cell['directory'],
                         'source_commit':head,'commits':commits[:30],
                         'has_more':len(commits)>30,'history_complete':not shallow and len(commits)<=30})
    return {'schema':'circuitgit.library-history.v1','source_commit':head,'read_only':True,
            'shallow':shallow,'cells':rows}


def publish(root, output):
    report=generate(root)
    path=Path(output)/'library-files/lib/history.json'
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return report
