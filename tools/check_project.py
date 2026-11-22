#!/usr/bin/env python3
"""PDK-free integrity checks for native snapshots and runnable text bundles."""
import hashlib,importlib.util,json,re,sys,tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):return json.loads(p.read_text())
def main():
    total=0
    for folder in ['design/native','design/original-sar-reference']:
        root=ROOT/folder;m=load(root/'snapshot-manifest.json')
        for row in m['files']:
            p=root/row['path']
            assert p.is_file() and not p.is_symlink() and sha(p)==row['sha256'],str(p)
            assert '.cdslck' not in p.name and not p.name.endswith('%'),str(p)
            total+=1
    for item in load(ROOT/'design/archives/manifest.json'):
        p=ROOT/item['path'];assert sha(p)==item['sha256'],str(p)
    for design in ['real-sar-20261106','mdac-array-20261106']:
        p=ROOT/'design/variants'/design;d=load(p/'design.json');r=load(p/'oa-restore-comparison.json')
        assert sha(p/'circuit.scs')==d['portable_circuit_sha256']
        assert r['all_equal'] and r['includes_top_instances'] and all(x['equal'] for x in r['rows'])
        assert sha(ROOT/'design/native/snapshot-manifest.json')==d['oa_snapshot_manifest_sha256']
        for row in d['oa_files']:assert sha(ROOT/'design/native'/row['path'])==row['sha256']
    spec=importlib.util.spec_from_file_location('ic_sim',ROOT/'tools/sim/ic_sim.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    for row in load(ROOT/'validation/simulation-tool-manifest.json')['files']:
        assert sha(ROOT/'tools/sim'/row['path'])==row['sha256'],'Simulation tool differs from frozen delivery'
    site=m.site_load(ROOT/'config/site.example.json')
    bundles=list((ROOT/'sim/bundles').rglob('bundle.json'));assert len(bundles)>=2
    for p in bundles:
        b,payload,proof=m.prepare(p,site)
        assert b['reviewed_for_distribution'] is True
        assert b['design_id']=='real-sar-20261106' and b['top_cell']=='PIPE_TOP_F4_RS9_N06' and b['history']=='Interactive.0'
        assert m.required_aliases(proof,site)==set(m.external_pins(b))
        for pin in m.external_pins(b).values():assert re.fullmatch('[a-f0-9]{64}',pin)
        assert b['simulator']['profile']=='nov6-aps2'
        assert sha(p.parent/'netlist/project.scs')==load(ROOT/'design/variants'/b['design_id']/'design.json')['portable_circuit_sha256']
    # Scope scan: custom source may reference vendor names, but not define their implementations.
    for p in ROOT.rglob('*'):
        if not p.is_file() or any(x in p.parts for x in ['.git','.local','runs','test-scratch','test-results','node_modules','__pycache__']):continue
        if p.suffix in ['.scs','.spi','.sp']:
            assert not re.search(r'^\s*(?:subckt|\.subckt)\s+\S*BWP\S*',p.read_text(),re.M|re.I),'Vendor body in '+str(p)
        if p.suffix in ['.json','.md','.py','.va','.scs','.yml']:
            text=p.read_text(errors='replace')
            assert not re.search(r'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----',text),'Private key in '+str(p)
            assert not re.search(r'\bgh[pousr]_[A-Za-z0-9]{30,}\b',text),'Token in '+str(p)
    print(json.dumps({'native_files_verified':total,'bundles_verified':len(bundles),'vendor_definitions_in_git':0,'status':'passed'}))
if __name__=='__main__':main()
