#!/usr/bin/env python3
"""Read a saved, allowlisted Cadence library through SSH; never edits source.

The remote worker supports the site's Python 2.7. Snapshot hashes prove saved
bytes, not an atomic database transaction or equality with unsaved GUI edits.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import subprocess
import tarfile

WORKER = r'''
from __future__ import print_function
import os, sys, json, hashlib, io, tarfile, time, stat
root = os.path.realpath(sys.argv[1])
lib = os.path.basename(root)
options = json.loads(sys.argv[2])
allowed = tuple(options.get('views') or ('schematic', 'symbol', 'symbol_readable', 'veriloga', 'maestro', 'config'))
cells = set(options.get('cells') or [])
excluded = ('results', '.codex_runs', 'logs', 'netlist', 'psf', 'ahdlSimDB', '.cadence')
inventory = []
selected = []
skipped = []
def add(path):
    rel = os.path.relpath(path, root)
    name = os.path.basename(path)
    if '.cdslck' in name or name.endswith(('~', '.bak', '%')) or name.startswith('thumbnail_'):
        skipped.append({'path':rel,'reason':'lock/cache/backup'})
        return
    if os.path.islink(path):
        skipped.append({'path':rel,'reason':'symlink','target':os.readlink(path)})
        return
    if not os.path.isfile(path):
        return
    if os.path.getsize(path) > 32*1024*1024:
        raise RuntimeError('Unexpected large source file: '+rel)
    selected.append(path)
for name in ('cdsinfo.tag', 'data.dm'):
    add(os.path.join(root,name))
for cell in sorted(os.listdir(root)):
    if cells and cell not in cells:
        continue
    cp = os.path.join(root,cell)
    if cell.startswith('.') or not os.path.isdir(cp) or os.path.islink(cp):
        continue
    views = sorted(v for v in os.listdir(cp) if os.path.isdir(os.path.join(cp,v)))
    inventory.append({'cell':cell,'views':views})
    add(os.path.join(cp,'data.dm'))
    for view in views:
        if view not in allowed:
            skipped.append({'path':cell+'/'+view,'reason':'view outside source allowlist'})
            continue
        for base, dirs, files in os.walk(os.path.join(cp,view), followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in excluded and not d.startswith('.') and not os.path.islink(os.path.join(base,d)))
            for f in sorted(files):
                add(os.path.join(base,f))
manifest = {'schema':'ic-on-github.oa-snapshot.v1','library':lib,'source_root':root,
            'captured_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
            'basis':'saved files only; GUI dirty state not inspected',
            'inventory':inventory,'excluded':skipped,'files':[]}
out = tarfile.open(fileobj=sys.stdout,mode='w|gz')
for path in sorted(selected):
    s1 = os.stat(path)
    with open(path,'rb') as f:
        data = f.read()
    s2 = os.stat(path)
    if (s1.st_size,s1.st_mtime) != (s2.st_size,s2.st_mtime):
        raise RuntimeError('Source changed while reading: '+path)
    rel = os.path.relpath(path,root)
    digest = hashlib.sha256(data).hexdigest()
    manifest['files'].append({'path':lib+'/'+rel,'bytes':len(data),'sha256':digest,
                              'source_mtime':s2.st_mtime})
    info = tarfile.TarInfo(lib+'/'+rel)
    info.size = len(data)
    info.mode = 0o644
    info.mtime = int(s2.st_mtime)
    out.addfile(info,io.BytesIO(data))
# Second read detects changes spanning the snapshot traversal.
for rec in manifest['files']:
    p = os.path.join(root,rec['path'][len(lib)+1:])
    with open(p,'rb') as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    if digest != rec['sha256']:
        raise RuntimeError('Source changed during snapshot: '+p)
manifest['second_read_hash_check'] = 'all selected files matched'
raw = json.dumps(manifest,sort_keys=True,indent=2).encode('utf-8')
info = tarfile.TarInfo('snapshot-manifest.json')
info.size = len(raw)
info.mode = 0o644
out.addfile(info,io.BytesIO(raw))
out.close()
'''


def verify(archive):
    with tarfile.open(archive, 'r:gz') as tf:
        members = tf.getmembers()
        seen = set()
        for m in members:
            p = PurePosixPath(m.name)
            if p.is_absolute() or '..' in p.parts or not m.isfile() or m.name in seen:
                raise ValueError(f'Unsafe or duplicate archive member: {m.name}')
            seen.add(m.name)
        manifest = json.load(tf.extractfile('snapshot-manifest.json'))
        expected = {'snapshot-manifest.json'}
        for row in manifest['files']:
            expected.add(row['path'])
            body = tf.extractfile(row['path']).read()
            if len(body) != row['bytes'] or hashlib.sha256(body).hexdigest() != row['sha256']:
                raise ValueError(f'Content mismatch: {row["path"]}')
        if expected != seen:
            raise ValueError('Archive and manifest differ')
    return manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest='action', required=True)
    capture = sub.add_parser('capture')
    capture.add_argument('--host', required=True, help='Existing SSH alias')
    capture.add_argument('--remote-root', required=True)
    capture.add_argument('--remote-python', default='/usr/bin/python')
    capture.add_argument('--cells', nargs='+', help='Explicit cell allowlist')
    capture.add_argument('--views', nargs='+', help='Explicit view allowlist')
    capture.add_argument('--out', type=Path, required=True)
    check = sub.add_parser('verify')
    check.add_argument('archive', type=Path)
    extract = sub.add_parser('extract')
    extract.add_argument('archive', type=Path)
    extract.add_argument('--out', type=Path, required=True)
    a = ap.parse_args()
    if a.action == 'capture':
        if a.host.startswith('-') or not a.remote_root.startswith('/'):
            ap.error('Expected an SSH alias and absolute library path')
        a.out.parent.mkdir(parents=True, exist_ok=True)
        temp = a.out.with_suffix(a.out.suffix + '.partial')
        if a.out.exists() or temp.exists():
            raise FileExistsError('Use a new snapshot filename')
        options = json.dumps({'cells':a.cells, 'views':a.views},separators=(',',':'))
        command = ' '.join(shlex.quote(x) for x in [a.remote_python, '-', a.remote_root, options])
        with temp.open('xb') as stream:
            proc = subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',a.host,command],
                                  input=WORKER.encode(),stdout=stream,stderr=subprocess.PIPE,timeout=180)
        if proc.returncode:
            raise RuntimeError(proc.stderr.decode(errors='replace'))
        manifest = verify(temp)
        os.rename(temp,a.out)
        a.out.with_suffix('.manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        archive = a.out
    else:
        archive = a.archive
        manifest = verify(archive)
        if a.action == 'extract':
            if a.out.exists():
                raise FileExistsError('Extraction requires a new directory')
            a.out.mkdir(parents=True)
            with tarfile.open(archive,'r:gz') as tf:
                for m in tf.getmembers():
                    path = a.out / m.name
                    path.parent.mkdir(parents=True,exist_ok=True)
                    path.write_bytes(tf.extractfile(m).read())
    print(json.dumps({'archive':str(archive),'library':manifest['library'],
        'cells':len(manifest['inventory']),'files':len(manifest['files']),
        'source_bytes':sum(x['bytes'] for x in manifest['files']),
        'verified':True,'basis':manifest['basis']},indent=2))

if __name__ == '__main__':
    main()
