#!/usr/bin/env python3
"""Restore a saved native OA snapshot into a new directory, never overwrite.

External Cadence/technology libraries are supplied through an existing site
cds.lib. Binary design content is copied verbatim and checked before/after.
"""
import argparse,hashlib,json,shutil
from pathlib import Path

def verify(root,manifest):
    for row in manifest['files']:
        path=root/row['path']
        if not path.is_relative_to(root) or path.is_symlink() or '..' in Path(row['path']).parts:raise ValueError('Unsafe path')
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('Hash mismatch: '+str(path))

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--snapshot',type=Path,required=True);ap.add_argument('--out',type=Path,required=True)
    ap.add_argument('--site-cds-lib',type=Path,required=True)
    a=ap.parse_args();root=a.snapshot.resolve();m=json.loads((root/'snapshot-manifest.json').read_text())
    if a.out.exists():raise FileExistsError('Restore requires a new destination')
    if not a.site_cds_lib.is_file():raise FileNotFoundError(a.site_cds_lib)
    verify(root,m);a.out.mkdir(parents=True)
    for row in m['files']:
        dst=a.out/row['path'];dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/row['path'],dst)
    shutil.copyfile(root/'snapshot-manifest.json',a.out/'snapshot-manifest.json')
    verify(a.out,m)
    # Place local DEFINE after external site definitions, retaining library name.
    if any(' ' in str(p) or '\n' in str(p) for p in [a.site_cds_lib,a.out]):raise ValueError('Cadence paths must not contain spaces/newlines')
    (a.out/'cds.lib').write_text('INCLUDE '+str(a.site_cds_lib.resolve())+'\nDEFINE '+m['library']+' '+str((a.out/m['library']).resolve())+'\n')
    print(json.dumps({'restored_files':len(m['files']),'library':m['library'],'directory':str(a.out),'hashes_verified':True}))
if __name__=='__main__':main()
