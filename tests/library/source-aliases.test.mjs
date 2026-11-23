import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadCore} from '../../apps/web/vendor/rnl-viewer/core/core.js';
import {createLibraryClient} from '../../apps/web/library/model.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const entry='lib/synthetic/cell/schematic/view.scs',logical='lib/synthetic/cell/schematic/support/device.scs',canonical='lib/packages/synthetic/device.scs';
const text=readFileSync(join(root,'apps/web/demo/rc.scs'),'utf8').replace('simulator lang=spectre','simulator lang=spectre\ninclude "support/device.scs"').replace('R0 (in out) resistor r=1k','R0 (in out) shared_resistor r=1k');
const dependency='simulator lang=spectre\nsubckt shared_resistor p n\nparameters r=1k\nR_DEP (p n) resistor r=r\nends shared_resistor\n';
const view={kind:'rnl',entry,files:[entry,canonical],aliases:{[logical]:canonical},level:'@top'};

test('canonical alias closure renders exactly the same geometry and SVG as copied sources',async()=>{
  const core=await loadCore(readFileSync(join(root,'apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm')));
  const data=new Map([[entry,text],[canonical,dependency]]),requested=[];
  const client=createLibraryClient({baseURL:'https://example.test/',fetcher:async url=>{const path=url.pathname.slice(1);requested.push(path);return new Response(data.get(path)||'',{status:data.has(path)?200:404});}});
  const bundle=await client.loadView(view),before=core.build({entry:'/'+entry,files:{['/'+entry]:text,['/'+logical]:dependency},svg:true,auto_include:false});
  const after=core.build({entry:'/'+entry,files:bundle.source.snapshot,svg:true,auto_include:false});
  assert.deepEqual(requested,[entry,canonical]);assert.equal(after.failed,null);assert.deepEqual(after.diagnostics,before.diagnostics);
  assert.deepEqual(after.levels.map(level=>({title:level.title,svg:level.svg,hits:level.hits})),before.levels.map(level=>({title:level.title,svg:level.svg,hits:level.hits})));
  assert.equal(after.levels[0].empty,false);
});

test('CI reconstructs aliases without reading virtual files and rejects authority conflicts',()=>{
  const folder=mkdtempSync(join(tmpdir(),'circuitgit-alias-ci-'));
  try{
    for(const [path,content] of [[entry,text],[canonical,dependency]]){mkdirSync(dirname(join(folder,path)),{recursive:true});writeFileSync(join(folder,path),content);}
    assert.equal(existsSync(join(folder,logical)),false);
    const inventory={status:'passed',source_commit:'a'.repeat(40),rnl_views:[{...view,library_id:'synthetic',cell_id:'cell',view_id:'schematic'}]};
    const input=join(folder,'input.json'),output=join(folder,'output.json');writeFileSync(input,JSON.stringify(inventory));
    const command=()=>spawnSync(process.execPath,[join(root,'tools/ci/rnl-check.mjs'),folder,input,output],{encoding:'utf8',timeout:30000});
    let result=command();assert.equal(result.status,0,result.stderr);let report=JSON.parse(readFileSync(output,'utf8'));assert.equal(report.status,'passed');assert.ok(report.views[0].geometry_hits>0);
    inventory.rnl_views[0].aliases={[entry]:canonical};writeFileSync(input,JSON.stringify(inventory));result=command();assert.equal(result.status,1);report=JSON.parse(readFileSync(output,'utf8'));assert.equal(report.views[0].status,'failed');assert.match(report.views[0].error,/不能覆盖/);
    inventory.rnl_views[0].aliases={[logical]:'lib/packages/synthetic/absent.scs'};writeFileSync(input,JSON.stringify(inventory));result=command();assert.equal(result.status,1);assert.match(JSON.parse(readFileSync(output,'utf8')).views[0].error,/权威文件/);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
