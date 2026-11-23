#!/usr/bin/env python3
"""Build offline web/plugin packages from explicit application and module roots."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import tempfile

ROOT=Path(__file__).resolve().parents[2]
MARKER='.ic-build.json'

def sha(data):return hashlib.sha256(data).hexdigest()

def files(folder):
    for path in sorted(folder.rglob('*')):
        if any(part.startswith('.') or part in ('__pycache__','node_modules','scratch') for part in path.relative_to(folder).parts):continue
        if path.is_symlink():raise ValueError('Source symlink is not supported: '+str(path))
        if path.is_file() and path.suffix not in ('.pyc','.log') and not path.name.endswith('.local.json'):yield path

def assets():
    spec=json.loads((ROOT/'workspace.json').read_text())
    result={}
    for group in [spec['application'],*spec['shared']]:
        folder=ROOT/group['source']
        for path in files(folder):
            dest=posixpath.join(group['mount'],path.relative_to(folder).as_posix())
            if dest in result.values():raise ValueError('Duplicate public asset: '+dest)
            result[path.resolve()]=dest
    return result

RELATIVE=re.compile(r"(['\"])(\.{1,2}/[^'\"\n]+)\1")
def web_payload():
    mapping=assets();payload={};rows=[]
    for source,dest in mapping.items():
        raw=source.read_bytes();data=raw
        if source.suffix in ('.js','.mjs','.css','.html'):
            def replace(match):
                value=match[2];base=re.split(r'[?#]',value,maxsplit=1)[0]
                target=(source.parent/base).resolve()
                if target not in mapping:return match[0]
                relative=posixpath.relpath(mapping[target],posixpath.dirname(dest) or '.')
                if not relative.startswith('.'):relative='./'+relative
                return match[1]+relative+value[len(base):]+match[1]
            data=RELATIVE.sub(replace,raw.decode()).encode()
        payload[dest]=data
        rows.append({'source':str(source.relative_to(ROOT)),'path':dest,'source_sha256':sha(raw),'sha256':sha(data)})
    # Keep the original asset URLs through compatibility modules; runtime code is built once.
    payload['asset-manifest.json']=(json.dumps({'schema':'ic.web.assets.v1','files':rows},indent=2)+'\n').encode()
    return payload

def codex_payload():
    payload={}
    for folder,mount in [(ROOT/'apps/codex',''),(ROOT/'modules/gateway_client/ic_gateway','lib/ic_gateway')]:
        for path in files(folder):payload[posixpath.join(mount,path.relative_to(folder).as_posix())]=path.read_bytes()
    # A plugin bundle must be self contained and contains no circuit, runtime or site data.
    from mcp_ui import ui_payload
    payload.update(ui_payload(ROOT))
    # Installed executable code, distinct from engineering data and site settings.
    for name in ('server.py','runner.py','spiceowl_pool.py','workspace.py','configuration.py','publisher.py','geometry.py','waveforms.py','supervision.py','ic_sim.py'):
        payload['gateway/'+name]=(ROOT/'tools/workbench'/name).read_bytes()
    payload['gateway-web/index.html']=b'<!doctype html><meta charset="utf-8"><title>IC Workbench</title><p>IC Workbench gateway is running. Open the schematic, waveform or simulation window in Codex.</p>'
    return payload

def mcp_payload():
    # Optional SDK transport with the same packaged service/UI/runner beneath it.
    # Dependency installation is explicit and separate from this offline build.
    payload={'backend/'+name:data for name,data in codex_payload().items()}
    folder=ROOT/'apps/mcp'
    if not (folder/'server.py').is_file():raise ValueError('Portable MCP entry is unavailable')
    for path in files(folder):payload[path.relative_to(folder).as_posix()]=path.read_bytes()
    return payload

def build(kind,output=None):
    destinations={'web':'web','codex':'dist/ic-workbench','mcp':'dist/ic-workbench-mcp'}
    output=Path(output).resolve() if output else ROOT/destinations[kind]
    if output==ROOT or output in ROOT.parents or output.is_symlink():raise ValueError('Unsafe build output')
    if output.exists() and not (output/MARKER).is_file():
        raise ValueError('Refusing to replace an unmanaged output directory: '+str(output))
    payload={'web':web_payload,'codex':codex_payload,'mcp':mcp_payload}[kind]()
    output.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix='.'+output.name+'-build-',dir=output.parent))
    backup=None
    try:
        for name,data in payload.items():
            path=stage/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        (stage/MARKER).write_text(json.dumps({'schema':'ic.build.v1','kind':kind,'files':len(payload)})+'\n')
        if output.exists():
            backup=Path(tempfile.mkdtemp(prefix='.'+output.name+'-old-',dir=output.parent));backup.rmdir();output.rename(backup)
        try:stage.rename(output)
        except Exception:
            if backup:backup.rename(output);backup=None
            raise
    finally:
        if stage.exists():shutil.rmtree(stage)
        if backup and backup.exists():shutil.rmtree(backup)
    return {'kind':kind,'output':str(output),'files':len(payload)}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind',choices=['web','codex','mcp','all'])
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    if args.kind=='all' and args.output:parser.error('--output requires one package')
    for kind in (['web','codex'] if args.kind=='all' else [args.kind]):print(json.dumps(build(kind,args.output)))
if __name__=='__main__':main()
