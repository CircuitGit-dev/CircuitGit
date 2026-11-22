// Actual packaged MCP host + schematic/waveform resources; fixture server state; real historical data.
import assert from 'node:assert/strict';import {createServer} from 'node:http';import {readFile,mkdir,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {resolve,dirname} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadCore} from '../../../apps/web/vendor/rnl-viewer/core/core.js';import {files as packageFiles,packageDirs} from '../../../apps/web/vendor/rnl-viewer/core/packages.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),out=resolve(process.env.EVIDENCE_DIR||root+'/test-results/codex-waveforms/cross'),bundle=resolve(process.env.IC_UI_BUNDLE||root+'/test-results/codex-waveforms/cross-package');await mkdir(out,{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const gateway='http://127.0.0.1:8766',run='20261109T054442Z-1d9279ef0b-014b97a6',workspace='w_'+'5'.repeat(32),sha=b=>createHash('sha256').update(b).digest('hex');
const report={status:'running',scope:'packaged MCP protocol bridge and two independent resources; actual RNL physical clicks and saved data; in-memory server workspace/CAS fixture; not a native Codex mounting claim',checks:[],calls:[],reads:[],clicks:[],errors:[]};
async function get(path){assert(/^\/api\/(jobs|schematic|geometry\/viewer-manifest)(\?|$)/.test(path)||new RegExp('^/api/jobs/'+run+'/(signals|waveform-map|waveform)(\\?|$)').test(path));const r=await fetch(gateway+path),b=await r.json();report.reads.push({path,status:r.status});if(path.startsWith('/api/geometry/viewer-manifest')&&r.ok)return b;if(!r.ok||!b.ok)throw Error(b.error?.message||r.status);return b.data;}
const mapping=await get('/api/jobs/'+run+'/waveform-map'),catalog=await get('/api/jobs/'+run+'/signals'),jobs=await get('/api/jobs');
const sourceHash=mapping.display_source?.sha256||mapping.source.sha256,sourcePath=mapping.source.canonical_path||mapping.source.path;
const native=await get('/api/schematic?'+new URLSearchParams({project_id:'real-sar-20261106',path:sourcePath,source_hash:sourceHash}));
const views={};let workspaceRevision=1,selection=null;const privateManifests=new Map();
function view(kind){return {schema:'ic.view.v1',view_id:'v_'+(kind==='schematic'?'6':'7').repeat(32),workspace_id:workspace,kind,revision:1,
 identity:{project_id:'real-sar-20261106',source_commit:kind==='schematic'?native.source_commit:catalog.source_commit,source_sha256:kind==='schematic'?sourceHash:null,path:kind==='schematic'?sourcePath:null,run_id:kind==='schematic'?null:run,configuration:kind==='schematic'?null:'PIPE_LOW'},selection:null,draft_dirty:false,visible:true,display_mode:'inline',readiness:{state:'requested',basis:'server-request',message:null},ui:{resource_uri:'ui://ic-workbench/'+kind+'.html',available:true,mounted:null},review_id:null,plan_ready:false,requests:[],workspace_revision:1};}
views.schematic=view('schematic');views.waveforms=view('waveforms');
const copy=x=>structuredClone(x),desc=v=>({...copy(v),workspace_revision:workspaceRevision});
async function manifest(entry){if(privateManifests.has(entry))return privateManifests.get(entry);const m=await get('/api/geometry/viewer-manifest?'+new URLSearchParams({project_id:'real-sar-20261106',bundle_commit:native.geometry.bundle_commit,manifest_sha256:native.geometry.manifest_sha256,entry}));privateManifests.set(entry,m);return m;}
const top=await manifest(native.geometry.root_cell),allFiles=new Map();for(const f of top.files){const bytes=await readFile(root+'/projects/real-sar-20261106/native/'+f.path);assert.equal(sha(bytes),f.sha256);allFiles.set(f.path,{...f,bytes});}
const core=await loadCore(await readFile(root+'/apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm'));
const built=core.build({entry:'/native/'+top.entry,files:{...packageFiles,...Object.fromEntries([...allFiles].map(([p,f])=>['/native/'+p,f.bytes.toString()]))},package_dirs:packageDirs,auto_include:false});assert(!built.failed);assert(built.objects.length>0);
async function tool(kind,name,args){
 const v=views[kind];report.calls.push({kind,name,args});assert.equal(args.workspace_id,workspace);
 if(name==='ic_workspace_get')return {schema:'ic.workspace.v1',workspace_id:workspace,revision:workspaceRevision,views:Object.values(views).map(desc),selection:copy(selection)};
 assert.equal(args.view_id,v.view_id);if(name==='ic_view_get')return desc(v);
 if((args.revision??args.expected_revision)!==v.revision)throw Object.assign(Error('CAS revision conflict'),{code:'conflict'});
 if(name==='ic_view_data'){
  const q=args.query;let payload;
  if(q.kind==='schematic')payload=native;
  else if(q.kind==='geometry_manifest')payload=await manifest(q.entry);
  else if(q.kind==='geometry_file'){
   let f=allFiles.get(q.path);if(!f){const row=[...privateManifests.values()].flatMap(m=>m.files).find(f=>f.path===q.path);assert(row);const bytes=await readFile(root+'/projects/real-sar-20261106/native/'+q.path);assert.equal(sha(bytes),row.sha256);f={...row,bytes};allFiles.set(q.path,f);}
   const offset=q.offset||0,end=Math.min(offset+(q.limit||262144),f.bytes.length);payload={path:q.path,encoding:'base64',data:f.bytes.subarray(offset,end).toString('base64'),offset,total_bytes:f.bytes.length,next_offset:end===f.bytes.length?null:end,sha256:f.sha256};
  }else if(q.kind==='runs')payload={jobs:jobs.jobs.filter(j=>j.associated_project_id===v.identity.project_id)};
  else if(q.kind==='signals')payload=catalog;else if(q.kind==='mapping')payload=mapping;
  else if(q.kind==='waveform'){const p={...q};delete p.kind;payload=await get('/api/jobs/'+run+'/waveform?'+new URLSearchParams(p));}
  else throw Error('query blocked');return {view:desc(v),kind:q.kind,payload};
 }
 if(name==='ic_view_select'){
  if(args.selection.kind==='signals')assert(args.selection.signal_ids.every(id=>catalog.signals.some(s=>s.id===id)));
  v.selection=args.selection.kind==='none'?null:{...args.selection,verification:kind==='schematic'?'ui-metadata':'saved-signal-catalog',source_commit:v.identity.source_commit,run_id:v.identity.run_id};
  v.revision++;workspaceRevision++;selection={view_id:v.view_id,view_revision:v.revision,selection:copy(v.selection)};return desc(v);
 }
 if(name==='ic_view_state'){v.revision++;workspaceRevision++;v.readiness={state:args.client_state,basis:'client-report',message:args.message};return desc(v);}
 throw Error('tool blocked');
}
const server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://local');
 if(req.method==='POST'){let b='';for await(const c of req)b+=c;const a=JSON.parse(b);let result;
  if(u.pathname==='/fixture-view')result=desc(views[a.kind]);
  else if(u.pathname==='/fixture-tool'){try{const value=await tool(a.kind,a.name,a.args);result=value?.payload!==undefined?{structuredContent:{ok:true,data:{view:value.view,kind:value.kind}},_meta:{icWorkbench:{data:value}},content:[]}:{structuredContent:{ok:true,data:value},content:[]};}catch(e){result={isError:true,structuredContent:{ok:false,error:{code:e.code||'invalid_input',message:e.message}},content:[]};}}
  else throw Error('fixture route blocked');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
 }
 assert.equal(req.method,'GET');let content,type='text/html';if(u.pathname==='/')content='<!doctype html><style>body{margin:0;display:flex;height:100vh;background:#101824}iframe{border:0;width:50%;height:100%}</style><iframe data-kind="schematic" src="/schematic.html" title="Schematic MCP resource"></iframe><iframe data-kind="waveforms" src="/waveforms.html" title="Waveforms MCP resource"></iframe><script type="module" src="/cross-host.js"></script>';
 else if(u.pathname==='/cross-host.js'){content=await readFile(root+'/tests/codex/waveforms/cross-host.js');type='text/javascript';}
 else if(['/schematic.html','/waveforms.html'].includes(u.pathname))content=await readFile(bundle+u.pathname);else throw Error('asset blocked');res.writeHead(200,{'content-type':type});res.end(content);
 }catch(e){res.writeHead(400);res.end(e.message);}});
let browser,page;const save=(n,v)=>writeFile(out+'/'+n+'.json',JSON.stringify(v,null,2));
async function clickNative(frame,kind,name){const l=built.levels[0],index=built.objects.findIndex(o=>o.kind===kind&&o.name===name&&o.level===l.host);assert(index>=0);const hits=l.hits.filter(h=>h.objects.includes(index));const h=hits.find(h=>h.kind==='label'&&(kind==='net'||h.id?.endsWith('::name')))||hits.find(h=>h.kind==='box');assert(h);
 const p=[(Math.min(...h.points.map(p=>p[0]))+Math.max(...h.points.map(p=>p[0])))/2,(Math.min(...h.points.map(p=>p[1]))+Math.max(...h.points.map(p=>p[1])))/2];
 const xy=await frame.evaluate(p=>{const svg=document.querySelector('.rnl-canvas>svg'),q=new DOMPoint(...p).matrixTransform(svg.getScreenCTM()),r=document.querySelector('.rnl-canvas').getBoundingClientRect();return {x:q.x-r.x,y:q.y-r.y};},p);report.clicks.push({kind,name,index,hit:h.kind,points:h.points,xy});await frame.locator('.rnl-canvas').click({position:xy});const picker=frame.locator('.rnl-picker button').filter({hasText:kind+' · '+name});if(await picker.count())await picker.click();await frame.getByText(kind+' · '+name,{exact:true}).waitFor();await frame.getByRole('button',{name:'发送选择到工作区',exact:true}).click();await page.waitForFunction(name=>modelUpdates.filter(x=>x.kind==='schematic').at(-1)?.value.selection?.name===name,name);assert.equal(views.schematic.selection.name,name);assert.equal(views.schematic.selection.run_id,null);
}
try{await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true,channel:'chrome'});page=await browser.newPage({viewport:{width:1800,height:1100}});page.on('pageerror',e=>report.errors.push(e.message));await page.goto(origin);const s=page.frames().find(f=>f.url().endsWith('/schematic.html')),w=page.frames().find(f=>f.url().endsWith('/waveforms.html'));
 await s.waitForFunction(()=>document.querySelector('.ic-schematic-status')?.textContent.includes('711 器件'),null,{timeout:30000});await w.waitForFunction(()=>document.querySelectorAll('.wf-list button').length>0);assert(!report.calls.some(c=>c.kind==='waveforms'&&c.name==='ic_view_select'));report.checks.push('packaged host initialize/tool-result mounts two independent MCP resources on explicit same workspace');
 for(const name of ['VINP','ROP']){await clickNative(s,'net',name);await w.locator('.mcp-link-read').click();await w.waitForFunction(name=>document.querySelector('.wf-status').textContent.includes('已加载')&&document.querySelector('.wf-cursors').textContent.includes(name),name);}
 assert.equal(await w.locator('.wf-trace').count(),2);report.checks.push('actual physical VINP and ROP publication → workspace_get → exact proof/native mapping → receiving view CAS → real curves');
 await clickNative(s,'instance','VDD0');await w.locator('.mcp-link-read').click();await w.locator('.mcp-link-choices button').waitFor();assert.equal(await w.locator('.wf-trace').count(),2);assert.match(await w.locator('.mcp-link-choices').innerText(),/VDD0 · p · into_terminal/);await w.locator('.mcp-link-choices button').click();await w.waitForFunction(()=>document.querySelector('.wf-status').textContent.includes('已加载')&&document.querySelectorAll('.wf-trace').length===3);report.checks.push('VDD0 device actual selection with null run requires explicit saved-map p; current is not inferred from node');
 await w.locator('.wf-a').fill('1e-8');await w.locator('.wf-b').fill('1.1e-8');await w.locator('[data-action=measure]').click();await w.waitForFunction(()=>[...document.querySelectorAll('.wf-cursors tr')].some(r=>r.textContent.includes('VDD0:p')&&r.textContent.includes('1 ns')));await page.waitForFunction(()=>modelUpdates.some(x=>x.kind==='waveforms'&&x.value.signals?.find(s=>s.name==='VDD0:p')?.measurement?.delta.dt>0));
 const current=(await page.evaluate(()=>modelUpdates.filter(x=>x.kind==='waveforms').at(-1))).value.signals.find(x=>x.name==='VDD0:p');assert.equal(current.sample_count,158252);assert.equal(current.measurement.uses_display_samples,false);report.checks.push('linked current retains158252 native samples and1ns full-data cursors in bounded model context');
 const count=report.reads.filter(x=>x.path.includes('/waveform?')).length;await clickNative(s,'net','VDD');await w.locator('.mcp-link-read').click();await w.waitForFunction(()=>document.querySelector('.mcp-link-status').textContent.includes('无精确映射'));assert.equal(report.reads.filter(x=>x.path.includes('/waveform?')).length,count);report.checks.push('unknown physical VDD net blocked without another waveform read');
 await w.locator('.mcp-link-follow').check();await clickNative(s,'net','VINP');await w.waitForFunction(()=>document.querySelector('.mcp-link-status').textContent.includes('已核验并添加 VINP'));await w.locator('.mcp-link-follow').uncheck();report.checks.push('optional2s follow observes real selection and stops explicitly');
 await page.screenshot({path:out+'/linked-schematic-waveforms.png',fullPage:true});report.finalViews=Object.values(views).map(desc);report.protocol=await page.evaluate(()=>protocolEvents);report.modelContexts=await page.evaluate(()=>modelUpdates);assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;if(page){await page.screenshot({path:out+'/failure.png',fullPage:true});report.protocol=await page.evaluate(()=>protocolEvents).catch(()=>[]);report.lastViews=Object.values(views).map(desc);}throw error;}finally{await save('report',report);await browser?.close();await new Promise(r=>server.close(r));console.log(JSON.stringify({status:report.status,checks:report.checks.length,errors:report.errors,failure:report.failure}));}
