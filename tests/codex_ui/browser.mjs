import {chromium} from '/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),out=resolve(root,'../evidence/browser');await mkdir(out,{recursive:true});
const built=spawnSync('python3',['-B','tests/codex_ui/build_fixtures.py',out+'/resources'],{cwd:root,encoding:'utf8'});assert.equal(built.status,0,built.stderr);
const child=createServer(async(req,res)=>{try{const kind=new URL(req.url,'http://localhost').pathname.slice(1).split('.')[0];if(!['schematic','waveforms','simulation'].includes(kind)){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'text/html','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src data: blob:; worker-src blob: data:; frame-src 'none'"});res.end(await readFile(out+'/resources/'+kind+'.html'));}catch(error){res.writeHead(500);res.end(error.message);}});
const parent=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><meta charset="utf-8"><title>MCP Apps protocol HARNESS (not native Codex)</title><style>body{font:14px system-ui}iframe{width:32%;height:460px;border:1px solid #abc}</style><h3>Separate MCP resources · synthetic view descriptors · actual pinned RNL WASM</h3>');});
await new Promise(resolve=>child.listen(0,'127.0.0.1',resolve));await new Promise(resolve=>parent.listen(0,'127.0.0.1',resolve));
const childOrigin='http://127.0.0.1:'+child.address().port,parentOrigin='http://127.0.0.1:'+parent.address().port;
const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1500,height:900}}),errors=[],network=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(![parentOrigin,childOrigin].some(origin=>r.url().startsWith(origin))&&!r.url().startsWith('blob:')&&!r.url().startsWith('data:'))network.push(r.url());});
try{
  await page.goto(parentOrigin);
  await page.evaluate(({childOrigin,protocol})=>{
    window.transcript=[];window.framesByKind={};window.views={};window.handshakes={};window.waiters={};
    const reply=(frame,id,result)=>frame.contentWindow.postMessage({jsonrpc:'2.0',id,result},childOrigin);
    const notify=(frame,method,params)=>frame.contentWindow.postMessage({jsonrpc:'2.0',method,params},childOrigin);
    window.addEventListener('message',event=>{
      const kind=Object.keys(framesByKind).find(k=>framesByKind[k].contentWindow===event.source);if(!kind||event.origin!==childOrigin)return;
      const frame=framesByKind[kind],message=event.data;transcript.push({kind,message,at:performance.now()});
      if(message.method==='ui/initialize'){
        handshakes[kind]={start:performance.now(),stateBeforeReady:frame.dataset.ready||null};
        reply(frame,message.id,{protocolVersion:protocol,hostInfo:{name:'isolated-protocol-harness',version:'1'},hostCapabilities:{serverTools:{},serverResources:{},updateModelContext:{structuredContent:{}}},hostContext:{theme:'light',displayMode:'inline',availableDisplayModes:['inline','fullscreen'],containerDimensions:{height:460,width:470}}});
      }else if(message.method==='ui/notifications/initialized'){
        handshakes[kind].duration=performance.now()-handshakes[kind].start;
        views[kind]={schema:'ic.view.v1',kind,workspace_id:'workspace-fixture',view_id:'view-'+kind,revision:1,workspace_revision:1,requests:[],identity:{project_id:'fixture',source_commit:'a'.repeat(40),source_sha256:'b'.repeat(64),path:null,run_id:kind==='waveforms'?'fixture-run':null,configuration:kind==='simulation'?'fixture-conf':null}};
        notify(frame,'ui/notifications/tool-input',{arguments:{project_id:'fixture'}});notify(frame,'ui/notifications/tool-result',{structuredContent:{ok:true,data:views[kind]}});
      }else if(message.method==='tools/call')reply(frame,message.id,{structuredContent:{ok:true,data:{summary:'bounded'}},_meta:{icWorkbench:{data:{view:views[kind],payload:{owner:kind}}}}});
      else if(message.method==='ui/update-model-context')reply(frame,message.id,{});
      else if(message.method==='ui/request-display-mode')reply(frame,message.id,{mode:message.params.mode});
      else if(message.method==='resources/read')reply(frame,message.id,{contents:[{uri:message.params.uri,mimeType:'text/plain',text:'bounded resource fixture'}]});
      else if(message.id&&waiters[message.id]){waiters[message.id](message);delete waiters[message.id];}
    });
    for(const kind of ['schematic','waveforms','simulation']){const frame=document.createElement('iframe');frame.title=kind;frame.sandbox='allow-scripts allow-same-origin';framesByKind[kind]=frame;frame.src=childOrigin+'/'+kind+'.html';document.body.append(frame);}
  },{childOrigin,protocol:'2026-01-26'});
  const frames={};for(const kind of ['schematic','waveforms','simulation'])frames[kind]=page.frames().find(f=>f.url()===childOrigin+'/'+kind+'.html')||await page.waitForEvent('framenavigated',{predicate:f=>f.url()===childOrigin+'/'+kind+'.html'});
  for(const kind of Object.keys(frames))await frames[kind].waitForFunction(()=>document.body.dataset.appState==='mounted',null,{timeout:20000});
  assert.equal(await frames.schematic.locator('#ic-root').getAttribute('data-wasm'),'1');
  const timings=await page.evaluate(()=>handshakes);for(const value of Object.values(timings))assert.ok(value.duration<1000,JSON.stringify(timings));
  for(const [kind,frame] of Object.entries(frames)){
    const data=await frame.evaluate(()=>fixtureHost.call('ic_view_data',{workspace_id:fixtureHost.initial.workspace_id,view_id:fixtureHost.initial.view_id,revision:1,query:{kind:'project'}}));assert.equal(data.payload.owner,kind);
    await frame.evaluate(()=>fixtureHost.updateModelContext({selected:'fixture'}));
  }
  await frames.waveforms.evaluate(()=>fixtureHost.requestDisplayMode('fullscreen'));assert.equal(await frames.waveforms.evaluate(()=>fixtureHost.hostContext.displayMode),'fullscreen');
  // An unrelated sibling may know the other view id; its WindowProxy still must be rejected.
  await frames.simulation.evaluate(({origin})=>parent.frames[1].postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{ok:true,data:{schema:'ic.view.v1',kind:'waveforms',workspace_id:'workspace-fixture',view_id:'view-waveforms',revision:99,identity:{}}}}},origin),{origin:childOrigin});
  await page.waitForTimeout(40);assert.equal(await frames.waveforms.evaluate(()=>fixtureHost.view.revision),1);
  await page.screenshot({path:out+'/three-resources.png',fullPage:true});
  const teardown=await page.evaluate(({childOrigin})=>new Promise(resolve=>{waiters.teardown=resolve;framesByKind.schematic.contentWindow.postMessage({jsonrpc:'2.0',id:'teardown',method:'ui/resource-teardown',params:{}},childOrigin);}),{childOrigin});
  assert.deepEqual(teardown.result,{});assert.equal(await frames.schematic.evaluate(()=>document.body.dataset.disposed),'true');assert.equal(await frames.waveforms.evaluate(()=>document.body.dataset.appState),'mounted');
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);const transcript=await page.evaluate(()=>transcript);
  await writeFile(out+'/report.json',JSON.stringify({status:'passed',scope:'cross-origin MCP Apps protocol harness; three synthetic components; actual RNL WASM and packages; no native Codex mounting claim',timings,checks:['early initialization before data/module load','three independent packaged resource mounts','real WASM build: one resistor','tool-result input order and private metadata data','tools/call view binding','model context','fullscreen capability','sibling message rejected','teardown isolated and acknowledged'],errors,network,transcript},null,2)+'\n');
  console.log('MCP_UI_BROWSER_PASS: 3 resources, actual WASM, 9 protocol checks');
}finally{await browser.close();await new Promise(resolve=>child.close(resolve));await new Promise(resolve=>parent.close(resolve));}
