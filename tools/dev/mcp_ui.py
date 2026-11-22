"""Offline, dependency-free MCP App documents: scoped ESM import maps and asset blobs.

All paths are explicit registered application/module/vendor roots. Builds never include
project data, local configuration, runtime state or gateway credentials.
"""
import base64
import hashlib
import json
import mimetypes
from pathlib import Path
import posixpath
import re

KINDS=('schematic','waveforms','simulation','workbench')
IMPORT=re.compile(r'''(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"\n]+)\1''')
URL=re.compile(r'''new\s+URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)''')
CSS_URL=re.compile(r'''url\(\s*(['"]?)([^)'"\s]+)\1\s*\)''')
CSS_IMPORT=re.compile(r'''@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?\s*;''')
COMMENTS=re.compile(r'/\*[\s\S]*?\*/|^\s*//[^\n]*',re.MULTILINE)

def encoded(data):return base64.b64encode(data).decode('ascii')
def digest(data):return hashlib.sha256(data).hexdigest()
def mime(path):return {'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm'}.get(Path(path).suffix,mimetypes.guess_type(path)[0] or 'application/octet-stream')

def safe_files(folder):
    if not folder.exists():return
    for path in sorted(folder.rglob('*')):
        rel=path.relative_to(folder)
        if any(p.startswith('.') or p in ('node_modules','__pycache__','scratch') for p in rel.parts):continue
        if path.is_symlink():raise ValueError('Symlink in MCP UI asset root: '+str(path))
        if path.is_file() and not path.name.endswith(('.local.json','.pyc','.log')):yield path

def render_document(root,kind):
    root=Path(root).resolve()
    allowed=[root/'apps/codex/ui',root/'modules',root/'apps/web/vendor/rnl-viewer']
    # Shared Python gateway code is not a browser asset root.
    assets={}
    for folder in allowed:
        for path in safe_files(folder):
            if path.suffix in ('.py','.toml') or 'gateway_client' in path.parts or 'resources' in path.relative_to(folder).parts:continue
            assets[path.relative_to(root).as_posix()]=path.read_bytes()
    entry='apps/codex/ui/'+kind+'/index.js'
    modules={};local_assets={};worker_cache={}
    def resolve(source,reference):
        if not reference.startswith('.'):raise ValueError('Only relative packaged imports supported: '+source+' -> '+reference)
        name=posixpath.normpath(posixpath.join(posixpath.dirname(source),reference))
        if name not in assets:raise ValueError('Unregistered/missing MCP UI asset: '+source+' -> '+reference)
        return name
    def data_uri(name):
        data=assets[name]
        if name.endswith('.css'):data=css(name).encode()
        return 'data:'+mime(name)+';base64,'+encoded(data)
    def css(name,trail=()):
        if name in trail:raise ValueError('Cyclic stylesheet import: '+name)
        text=assets[name].decode()
        text=CSS_IMPORT.sub(lambda m:css(resolve(name,m[2] if m[2].startswith('.') else './'+m[2]),trail+(name,)),text)
        def url(match):
            value=match[2]
            if value.startswith(('data:','#')):return match[0]
            target=resolve(name,value if value.startswith('.') else './'+value)
            return 'url("'+data_uri(target)+'")'
        return CSS_URL.sub(url,text)
    def asset(name):
        if name not in local_assets:
            data=css(name).encode() if name.endswith('.css') else assets[name]
            local_assets[name]={'mime':mime(name),'data':encoded(data),'sha256':digest(data)}
        return name
    def transform(name,worker=False,trail=()):
        # Comments are erased so JSDoc import() types are never treated as runtime dependencies.
        text=COMMENTS.sub('',assets[name].decode())
        def imports(match):
            reference=match[2]
            if reference.startswith('node:'):return match[0] # unreachable browser-only Node fallback
            target=resolve(name,reference)
            replacement=worker_url(target,trail) if worker else '@icwb/'+target
            if not worker:module(target)
            return match[0][:match.start(2)-match.start()]+replacement+match[0][match.end(2)-match.start():]
        text=IMPORT.sub(imports,text)
        def urls(match):
            target=resolve(name,match[2])
            if worker:return 'new URL('+json.dumps(data_uri(target))+')'
            if target.endswith(('.js','.mjs')):
                # Module workers cannot inherit the document import map. Give them a closed data graph.
                local_assets[target]={'mime':'text/javascript','data':encoded(worker_source(target).encode()),'sha256':digest(worker_source(target).encode())}
            else:asset(target)
            return 'new URL(globalThis.__ICWB_ASSETS__.url('+json.dumps(target)+'))'
        return URL.sub(urls,text)
    def worker_source(name,trail=()):
        if name in trail:raise ValueError('Cyclic worker ESM graph requires explicit adapter: '+name)
        return transform(name,True,trail+(name,))
    def worker_url(name,trail):
        if name not in worker_cache:worker_cache[name]='data:text/javascript;base64,'+encoded(worker_source(name,trail).encode())
        return worker_cache[name]
    def module(name):
        if name in modules:return
        if not name.endswith(('.js','.mjs')):raise ValueError('Non-JS module import: '+name)
        modules[name]=None
        modules[name]=encoded(transform(name).encode())
    if entry in assets:module(entry)
    if kind=='workbench' and 'apps/codex/ui/workbench/components.js' in assets:module('apps/codex/ui/workbench/components.js')
    # Each component gets its local styles/images; schematic also gets the pinned renderer assets.
    for name in sorted(assets):
        if name.startswith('apps/codex/ui/'+kind+'/') and not name.endswith(('.js','.mjs')):asset(name)
        if kind=='workbench' and name.startswith('apps/codex/ui/') and not name.endswith(('.js','.mjs')):asset(name)
        if name.startswith('modules/') and not name.endswith(('.js','.mjs')):asset(name)
        if kind in ('schematic','workbench') and name.startswith('apps/web/vendor/rnl-viewer/') and not name.endswith(('.js','.mjs')):asset(name)
    payload={'schema':'ic.ui.bundle.v1','kind':kind,'entry':entry if entry in assets else None,'modules':modules,'assets':local_assets}
    payload_bytes=json.dumps(payload,separators=(',',':')).encode()
    host=(root/'apps/codex/ui/host.js').read_text()
    host=re.sub(r'(?m)^export\s+','',host)
    shell=(root/'apps/codex/ui/shell.css').read_text()
    runtime=(root/'apps/codex/ui/bootstrap.js').read_text()
    # The first script completes initialize before parsing/importing any large renderer payload.
    prefix='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IC '+kind+'</title><style>'+shell+'</style></head><body><main class="ic-app-shell"><header class="ic-app-header"><strong>IC '+kind+'</strong><button id="ic-display" hidden>全屏</button></header><div id="ic-status" class="ic-app-status" role="status">连接宿主…</div><div id="ic-root" class="ic-app-root"></div></main><script>'+host+'\n'+runtime.replace('__IC_KIND__',json.dumps(kind))+'</script>'
    # inert base64 contains no executable tags, HTML or private runtime state
    html=prefix+'<script id="ic-bundle" type="application/octet-stream">'+encoded(payload_bytes)+'</script></body></html>'
    return html.encode(),{'kind':kind,'resource_uri':'ui://ic-workbench/'+kind+'.html','path':'ui/'+kind+'.html','entry_present':entry in assets,'module_count':len(modules),'asset_count':len(local_assets),'payload_sha256':digest(payload_bytes),'sha256':digest(html.encode()),'bytes':len(html.encode()),'requires':{'script-src':['blob:','data:'],'worker-src':['blob:','data:'],'connect-src':['blob:','data:'],'wasm':kind in ('schematic','workbench')}}

def ui_payload(root):
    root=Path(root)
    if not (root/'apps/codex/ui/host.js').exists():return {}
    output={};rows=[]
    for kind in KINDS:
        html,row=render_document(root,kind);output[row['path']]=html;rows.append(row)
    output['ui/manifest.json']=(json.dumps({'schema':'ic.ui.resources.v1','files':rows},indent=2)+'\n').encode()
    return output
