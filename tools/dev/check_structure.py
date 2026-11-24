#!/usr/bin/env python3
"""Check architectural boundaries and all static JS imports without installing packages."""
import json,re,sys,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(Path(__file__).resolve().parent))
from build import assets,web_payload
sys.path.insert(0,str(ROOT/'tools/workbench'))
from upstream_sources import inspect_upstreams

IMPORT=re.compile(r'''(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"\n]+)\1''')
def imports(text):
    # Vendor JSDoc references upstream TypeScript sources not shipped at runtime.
    return IMPORT.finditer(re.sub(r'/\*[\s\S]*?\*/','',text))

def check():
    # Git index gitlinks remain available in a nonrecursive/shallow checkout.
    # Inspection is offline and never initializes or rewrites upstream sources.
    upstreams=inspect_upstreams(ROOT)
    mapping=assets();count=0
    for path in mapping:
        if path.is_relative_to(ROOT/'submodules'):
            raise ValueError('Upstream source cannot be packaged as an application asset: '+str(path))
        if path.suffix not in ('.js','.mjs'):continue
        for match in imports(path.read_text()):
            value=match[2]
            if not value.startswith('.'):continue
            target=(path.parent/value.split('?')[0].split('#')[0]).resolve()
            if not target.is_file():raise ValueError('Broken source import: '+str(path.relative_to(ROOT))+' -> '+value)
            if target not in mapping:raise ValueError('Import escapes public asset roots: '+str(target))
            if path.is_relative_to(ROOT/'modules') and not target.is_relative_to(ROOT/'modules'):
                raise ValueError('Shared module depends on an app: '+str(path))
            count+=1
    # Generated URLs must resolve under the static root, including compatibility entrypoints.
    from urllib.parse import urljoin,urlsplit
    output=web_payload()
    for name,data in output.items():
        if not name.endswith(('.js','.mjs')):continue
        for match in imports(data.decode()):
            value=match[2]
            if not value.startswith('.'):continue
            resolved=urlsplit(urljoin('http://build/'+name,value)).path.lstrip('/')
            if resolved not in output:raise ValueError('Broken built import: '+name+' -> '+value)
    from subprocess import check_call
    check_call([sys.executable,'-B',str(ROOT/'tools/dev/export_contracts.py'),'--check'])
    registry=json.loads((ROOT/'contracts/modules.v1.json').read_text())
    for module in registry['modules']:
        if not (ROOT/module['entry']).is_file():raise ValueError('Missing module entry: '+module['id'])
    return {'status':'passed','source_imports':count,'public_assets':len(mapping),'module_entries':len(registry['modules']),'upstreams':upstreams}
if __name__=='__main__':print(json.dumps(check()))
