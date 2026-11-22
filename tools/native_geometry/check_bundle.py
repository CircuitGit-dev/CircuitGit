#!/usr/bin/env python3
"""Read-only verification of the shipped committed native catalog and canonical circuit."""
import json, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/workbench'))
sys.path.insert(0,str(ROOT/'tools'))
from geometry import Geometry
from workspace import Workspace
from compare_netlists import canonical

def main():
    ws=Workspace.__new__(Workspace);ws.root=ROOT
    registry=json.loads((ROOT/'config/workbench.projects.json').read_text())
    ws.projects={p['id']:p for p in registry}
    geometry=Geometry(ws);head=ws.head();result=[]
    for project in registry:
        if not project.get('geometry_manifest'):continue
        snap=geometry.snapshot(project['id'],head)
        for cell in snap['cells']:geometry.validate_cell(snap,cell)
        for path in snap['table']:geometry.member(snap,path)
        geometry.mapping(snap,snap['manifest']['mapping'],False)
        root=ROOT/Path(project['geometry_manifest']).parent
        rendered='\n'.join(f.read_text() for f in sorted(root.glob('*.scs')) if not f.name.startswith('view-'))
        assert canonical(rendered)==canonical((ROOT/project['source_path']).read_text()),'Canonical electrical content changed'
        result.append({'project':project['id'],'cells':len(snap['cells']),'files':len(snap['table']),'manifest_sha256':snap['sha256'],'electrical_equal':True})
    print(json.dumps({'status':'passed','catalogs':result}))

if __name__=='__main__':main()
