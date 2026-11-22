"""Build explicit synthetic entrypoints against the real pinned RNL/WASM assets."""
from pathlib import Path
import json,shutil,sys,tempfile
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/dev'))
from mcp_ui import render_document

def fixture_root(folder):
    folder=Path(folder)
    for relative in ['apps/codex/ui','apps/web/vendor/rnl-viewer','modules']:
        shutil.copytree(ROOT/relative,folder/relative,dirs_exist_ok=True)
    for kind in ['schematic','waveforms','simulation']:
        target=folder/'apps/codex/ui'/kind;target.mkdir(parents=True,exist_ok=True)
        imports="import {loadCore} from '../../../web/vendor/rnl-viewer/core/core.js';\nimport {files,packageDirs} from '../../../web/vendor/rnl-viewer/core/packages.js';\n" if kind=='schematic' else ''
        probe="const core=await loadCore(host.assetBytes('apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm'));const doc=core.build({entry:'/fixture.sp',files:{...files,'/fixture.sp':'* synthetic fixture\\nR1 in 0 1k\\n.end\\n'},pool:packageDirs});root.dataset.wasm=String(doc.objects.filter(o=>o.kind==='instance').length);" if kind=='schematic' else ''
        (target/'index.js').write_text(imports+"export async function mount(root,host){\n"+probe+"\nconst style=document.createElement('style');style.textContent=host.assetText('apps/codex/ui/"+kind+"/style.css');root.append(style);\nwindow.fixtureHost=host;root.dataset.view=host.initial.view_id;root.dataset.kind=host.initial.kind;root.append(document.createTextNode('Synthetic component mounted '+host.initial.kind));window.fixtureNotices=[];const unsubscribe=host.onResult(v=>fixtureNotices.push(v));return {dispose(){unsubscribe();document.body.dataset.disposed='true';root.replaceChildren();}};}\n")
        (target/'style.css').write_text('.ic-app-root{padding:12px;background:var(--ic-bg)}\n')
    return folder

if __name__=='__main__':
    output=Path(sys.argv[1]);output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ic-mcp-bundle-fixture-') as tmp:
        folder=fixture_root(tmp);manifest=[]
        for kind in ['schematic','waveforms','simulation']:
            html,row=render_document(folder,kind);(output/(kind+'.html')).write_bytes(html);manifest.append(row)
        (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({'status':'built','output':str(output),'resources':3}))
