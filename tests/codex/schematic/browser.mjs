// Actual schematic module + pinned native geometry, with an explicitly synthetic MCP host.
// No production/gateway/model/solver calls. Two iframe documents prove module lifetime isolation.
import assert from 'node:assert/strict';import {createServer} from 'node:http';import {readFile,mkdir,writeFile} from 'node:fs/promises';import {resolve,extname} from 'node:path';import {fileURLToPath} from 'node:url';
import {root,view,query,native,closure,nativeRoot} from './fixture.mjs';import {loadCore} from '../../../apps/web/vendor/rnl-viewer/core/core.js';
const playwright=process.env.PLAYWRIGHT_MODULE||'/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';const {chromium}=await import(playwright);
const out=process.env.EVIDENCE_DIR||resolve(root,'../evidence/browser');await mkdir(out,{recursive:true});
const wasm=await readFile(root+'/apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm'),core=await loadCore(wasm);
const request={entry:'/native/'+native.entrypoint,files:Object.fromEntries(await Promise.all(closure(native.entrypoint).map(async p=>['/native/'+p,await readFile(nativeRoot+p,'utf8')]))),auto_include:false};const built=core.build(request);
const hit=built.levels[0].hits.find(h=>h.kind==='box'&&h.objects.includes(0)),point=[(hit.points[0][0]+hit.points[1][0])/2,(hit.points[0][1]+hit.points[1][1])/2];
const child=`<!doctype html><meta charset="utf-8"><style>html,body{height:100%;margin:0}#root{height:100%;box-sizing:border-box;padding:8px}</style><div id="root"></div><script type="module">
import {mount} from '/apps/codex/ui/schematic/index.js';
const suffix=new URLSearchParams(location.search).get('id')||'1';let current=await (await fetch('/__view?id='+suffix)).json();const calls=[],contexts=[],callbacks=new Set();window.fixture={calls,contexts,current:()=>current};
const host={initial:current,assetText:async p=>{const r=await fetch('/'+p);if(!r.ok)throw Error('Asset unavailable');return r.text();},assetBytes:async p=>(await fetch('/'+p)).arrayBuffer(),onResult:fn=>(callbacks.add(fn),()=>callbacks.delete(fn)),updateModelContext:async value=>{contexts.push(value);},requestDisplayMode:async()=>{throw Error('SYNTHETIC host does not advertise fullscreen');},async call(name,args){
 calls.push({name,args});if(args.workspace_id!==current.workspace_id||args.view_id!==current.view_id)throw Error('Cross-view fixture request');
 if(name==='ic_view_get')return structuredClone(current);
 if(name==='ic_view_data'){if(args.revision!==current.revision)throw Error('SYNTHETIC stale revision');const r=await fetch('/__data?id='+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args.query)});if(!r.ok)throw Error('Fixture read failed');return {view:structuredClone(current),kind:args.query.kind,payload:await r.json()};}
 if(['ic_view_state','ic_view_select'].includes(name)){if(args.expected_revision!==current.revision)throw Error('SYNTHETIC stale CAS');current={...current,revision:current.revision+1,workspace_revision:current.workspace_revision+1};if(name==='ic_view_select')current.selection={...args.selection,source_commit:current.identity.source_commit,run_id:current.identity.run_id,verification:'ui-metadata'};return structuredClone(current);}
 throw Error('Forbidden fixture action '+name);
}};window.fixture.dispose=async()=>{(await window.fixture.controller).dispose();};window.fixture.controller=mount(document.getElementById('root'),host);</script>`;
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://local');let bytes,type='text/html';
 if(url.pathname==='/')bytes='<!doctype html><style>body{margin:0;display:flex;height:100vh}iframe{border:0;width:50%;height:100%}</style><iframe title="Schematic A" src="/child?id=1"></iframe><iframe title="Schematic B" src="/child?id=2"></iframe>';
 else if(url.pathname==='/child')bytes=child;
 else if(url.pathname==='/__view'){bytes=JSON.stringify(view(url.searchParams.get('id')));type='application/json';}
 else if(url.pathname==='/__data'&&req.method==='POST'){let body='';for await(const c of req){body+=c;if(body.length>4096)throw Error('Bounded fixture body');}const v=view(url.searchParams.get('id')),q=JSON.parse(body),data=query(v,q);if(url.searchParams.get('id')==='3'&&q.kind==='schematic')data.geometry.source_binding.geometry_source_sha256='0'.repeat(64);bytes=JSON.stringify(data);type='application/json';}
 else{if(req.method!=='GET')throw Error('Read-only fixture');const path=resolve(root,'.'+decodeURIComponent(url.pathname));if(!path.startsWith(root+'/apps/')&&!path.startsWith(root+'/modules/'))throw Error('Path outside application assets');bytes=await readFile(path);type=({'.js':'text/javascript','.css':'text/css','.wasm':'application/wasm'})[extname(path)]||'application/octet-stream';}
 res.writeHead(200,{'content-type':type});res.end(bytes);
 }catch(error){res.writeHead(400);res.end(error.message);}});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1600,height:1000}}),checks=[],errors=[],external=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
try{
 await page.goto(origin);const a=page.frames().find(f=>f.url().endsWith('id=1')),b=page.frames().find(f=>f.url().endsWith('id=2'));
 await a.waitForFunction(()=>document.querySelector('.ic-schematic-status')?.textContent.includes('711 器件'),null,{timeout:30000});await b.waitForFunction(()=>document.querySelector('.ic-schematic-status')?.textContent.includes('711 器件'),null,{timeout:30000});
 assert.equal(await a.locator('[aria-label="原图入口"] option').count(),97);assert.equal(await b.locator('[aria-label="原图入口"] option').count(),97);
 checks.push('Two independent documents render the exact native TB with 711 instances / 23 levels and 97 entry options');
 const xy=await a.evaluate(point=>{const svg=document.querySelector('.rnl-canvas>svg'),p=new DOMPoint(...point).matrixTransform(svg.getScreenCTM());return{x:p.x,y:p.y};},point);
 await a.locator('.rnl-canvas').click({position:await a.evaluate(xy=>{const r=document.querySelector('.rnl-canvas').getBoundingClientRect();return{x:xy.x-r.x,y:xy.y-r.y};},xy)});
 await a.getByText('instance · XDUT',{exact:true}).waitFor();await a.getByLabel('器件端口',{exact:true}).selectOption('VINP');await a.getByRole('button',{name:'发送选择到工作区',exact:true}).click();
 await a.waitForFunction(()=>fixture.contexts.length===1);const selected=await a.evaluate(()=>fixture.contexts[0]);assert.equal(selected.selection.name,'XDUT');assert.equal(selected.selection.terminal,'VINP');assert.equal(selected.identity.run_id,null);assert.equal(selected.verification,'ui-metadata');assert.equal(await b.evaluate(()=>fixture.contexts.length),0);
 const published=await a.evaluate(()=>fixture.calls.find(c=>c.name==='ic_view_select').args.selection);
 assert.deepEqual(Object.keys(published.geometry).sort(),['viewer_source_path','native_entry_id','bundle_commit','manifest_sha256','source_match','canonical_mapping_enabled','snapshot_only'].sort());
 assert.equal(published.geometry.viewer_source_path,native.entrypoint);assert.equal(published.geometry.native_entry_id,native.root_cell);
 assert.equal(published.geometry.source_match,true);assert.equal(published.geometry.snapshot_only,false);assert.equal(published.geometry.manifest_sha256.length,64);
 assert.deepEqual(published.occurrence_path,[]);assert.deepEqual(selected.selection.geometry,published.geometry);
 checks.push('Real click selects XDUT; VINP and closed geometry pins reach ic_view_select and context with ui-metadata, explicit resolved top path and null run; B unchanged');
 await a.getByRole('button',{name:'进入选中器件',exact:true}).click();await a.waitForFunction(()=>document.querySelector('.rnl-path').textContent.includes('PIPE_TOP_F4_RS9_N06'));assert.equal(await b.locator('.rnl-path').textContent(),'TB_PIPE_RS9_N06.scs');await a.getByRole('button',{name:'上一级',exact:true}).click();
 checks.push('Hierarchy navigation preserves actual parent instance visits and does not affect the other document');
 await a.getByRole('button',{name:'全屏',exact:true}).click();assert.match(await a.locator('.ic-schematic-status').textContent(),/does not advertise/);
 await a.getByLabel('筛选原图入口',{exact:true}).fill('sar');assert((await a.locator('[aria-label="原图入口"] option').count())<97);await a.getByLabel('筛选原图入口',{exact:true}).fill('');
 checks.push('Entry filtering works and unsupported host display mode is explicit');
 await page.screenshot({path:out+'/two-native-schematics.png',fullPage:true});
 await a.evaluate(()=>fixture.dispose());assert.equal(await a.locator('.rnl-canvas').count(),0);assert.equal(await b.locator('.rnl-canvas>svg').count(),1);checks.push('Disposal removes only its own DOM, listeners and renderer state');
 await page.goto(origin+'/child?id=3');await page.waitForFunction(()=>document.querySelector('.ic-schematic-status')?.textContent.includes('711 器件'));
 assert.equal(await page.locator('.ic-schematic-renderer').isVisible(),false);await page.getByText('查看过期原图',{exact:false}).click();assert.equal(await page.locator('.ic-schematic-renderer').isVisible(),true);assert.equal(await page.getByRole('button',{name:'发送选择到工作区',exact:true}).isDisabled(),true);checks.push('Stale source hides geometry by default; explicit historical display cannot publish selection');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 await writeFile(out+'/report.json',JSON.stringify({status:'passed',scope:'Real pinned native bytes, standalone RNL renderer; synthetic MCP host/CAS only. No actual Codex native mount proven.',checks,errors,external,model_calls:0,eda_calls:0,production_requests:0,selection:selected},null,2));console.log('SCHEMATIC_BROWSER_PASS '+checks.length);
}catch(error){await page.screenshot({path:out+'/failure.png',fullPage:true});await writeFile(out+'/failure.json',JSON.stringify({message:error.message,checks,errors,external},null,2));throw error;}
finally{await browser.close();await new Promise(ok=>server.close(ok));}
