// Real stdio MCP + packaged resources + existing saved data, in an isolated host harness.
// This test never invokes a model, submits a solver, or sends a production POST.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer, request as httpRequest} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=resolve(process.env.EVIDENCE_DIR||root+'/test-results/workbench-acceptance');
const upstream=new URL(process.env.IC_GATEWAY_URL||'http://127.0.0.1:8766');
assert.equal(upstream.hostname,'127.0.0.1');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
await mkdir(output,{recursive:true});
const temp=await mkdtemp(tmpdir()+'/ic-mcp-acceptance-');
const report={kind:'actual stdio/tools/resources with real saved data in a separate-origin MCP Apps test host',
  status:'running',nativeCodexMount:false,checks:[],errors:[],productionPosts:0,modelTurns:0,toolCalls:{},gatewayReads:{}};
let childOrigin,parentOrigin,browser,mcp,stderr='',serial=0;
const pending=new Map(),resources={},opened={};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>server.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve();
const gateway=createServer((req,res)=>{
  const u=new URL(req.url,upstream);
  if(req.method!=='GET'||!u.pathname.startsWith('/api/')||u.pathname.startsWith('/api/ai/')){
    report.productionPosts++;res.writeHead(405);res.end('Acceptance only permits saved-data GET');return;
  }
  report.gatewayReads[u.pathname]=(report.gatewayReads[u.pathname]||0)+1;
  const remote=httpRequest(u,{method:'GET',headers:{Host:upstream.host}},response=>{
    const type=response.headers['content-type']||'application/json',chunks=[];
    response.on('data',bytes=>chunks.push(bytes));response.on('end',()=>{
      let bytes=Buffer.concat(chunks);
      if(type.includes('json'))bytes=Buffer.from(bytes.toString().split(upstream.origin).join('http://127.0.0.1:'+gateway.address().port));
      res.writeHead(response.statusCode,{'content-type':type});res.end(bytes);
    });
  });remote.on('error',e=>{res.writeHead(502);res.end(e.message);});remote.end();
});
function rpc(method,params={}){
  const id=++serial;
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},45000);
    pending.set(id,{resolve,reject,timeout});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}
const allowed=new Set(['ic_schematic_open','ic_waveforms_open','ic_simulation_open','ic_workspace_get',
  'ic_view_get','ic_view_data','ic_view_select','ic_view_state','ic_workbench_open','ic_workbench_layout','ic_view_snapshot']);
async function call(name,args){
  assert(allowed.has(name),'Live test attempted unexpected tool '+name);
  report.toolCalls[name]=(report.toolCalls[name]||0)+1;
  return rpc('tools/call',{name,arguments:args});
}
const data=result=>{
  assert.equal(result.isError,false,JSON.stringify(result.structuredContent));
  return result._meta?.icWorkbench?.data??result.structuredContent.data;
};
const resourceServer=createServer((req,res)=>{
  const kind=req.url.slice(1).split('.')[0];
  if(!resources[kind]){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'text/html','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: data:; style-src 'unsafe-inline' blob: data:; img-src data: blob:; font-src data: blob:; connect-src data: blob:; worker-src blob: data:; frame-src 'none'"});
  res.end(resources[kind]);
});
const parentServer=createServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/html'});
  res.end('<!doctype html><title>IC Workbench MCP integration harness</title><style>body{font:14px system-ui;margin:12px;background:#f1f5f9}#windows{display:grid;grid-template-columns:1fr 1fr;gap:12px}iframe{width:100%;height:610px;background:white;border:1px solid #bbc4d0}iframe:first-child{grid-column:span 2;height:900px}h1{font-size:18px}</style><h1>MCP integration test host · saved circuit and waveforms</h1><div id="windows"></div>');
});
try{
  await listen(gateway);
  const config=resolve(temp,'client.json');
  await writeFile(config,JSON.stringify({gateway_url:'http://127.0.0.1:'+gateway.address().port,state_dir:temp+'/state',timeout_seconds:30}));
  mcp=spawn(process.env.IC_PYTHON||'python3',['-B',root+'/dist/ic-workbench/ic_workbench.py','--config',config,'mcp'],{cwd:temp,stdio:['pipe','pipe','pipe']});
  mcp.stderr.on('data',b=>{stderr=(stderr+b).slice(-5000);});
  createInterface({input:mcp.stdout}).on('line',line=>{
    let value;try{value=JSON.parse(line);}catch{report.errors.push('Non-JSON stdout');return;}
    const entry=pending.get(value.id);if(!entry)return;pending.delete(value.id);clearTimeout(entry.timeout);
    value.error?entry.reject(Error(JSON.stringify(value.error))):entry.resolve(value.result);
  });
  mcp.on('exit',code=>{for(const entry of pending.values()){clearTimeout(entry.timeout);entry.reject(Error('MCP exited '+code+' '+stderr));}pending.clear();});
  const init=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}},clientInfo:{name:'ic-acceptance',version:'1'}});
  assert(init.capabilities.resources);
  mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=(await rpc('tools/list')).tools;
  assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
  assert(!tools.some(t=>/approve|confirm/.test(t.name)));
  for(const kind of ['workbench']){
    const tool=tools.find(t=>t.name==='ic_'+kind+'_open');
    assert.equal(tool?._meta?.ui?.resourceUri,'ui://ic-workbench/'+kind+'.html');
    const resource=await rpc('resources/read',{uri:tool._meta.ui.resourceUri});
    assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');
    resources[kind]=resource.contents[0].text;
  }
  report.checks.push('stdio server exposes the combined workbench resource and no model approval tool');
  opened.workbench=await call('ic_workbench_open',{project_id:'real-sar-20261106',configuration:'PIPE_LOW',run_id:process.env.IC_TEST_RUN||'20261109T054442Z-1d9279ef0b-014b97a6'});
  const workspace_id=data(opened.workbench).workspace_id;
  report.workspace_id=workspace_id;
  await listen(resourceServer);await listen(parentServer);
  childOrigin='http://127.0.0.1:'+resourceServer.address().port;parentOrigin='http://127.0.0.1:'+parentServer.address().port;
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('request',r=>{if(![parentOrigin,childOrigin,'blob:','data:'].some(x=>r.url().startsWith(x)))report.errors.push('Unexpected browser network '+r.url());});
  await page.exposeFunction('mcpCall',async({name,arguments:args})=>call(name,args));
  await page.exposeFunction('mcpResource',async args=>rpc('resources/read',args));
  await page.goto(parentOrigin);
  await page.evaluate(({childOrigin,opened})=>{
    window.framesByKind={};window.contexts={};window.handshakes={};window.waiters={};window.uiErrors=[];
    const send=(frame,value)=>frame.contentWindow.postMessage({jsonrpc:'2.0',...value},childOrigin);
    addEventListener('message',async event=>{
      const kind=Object.keys(framesByKind).find(k=>framesByKind[k].contentWindow===event.source);
      if(!kind||event.origin!==childOrigin||event.data?.jsonrpc!=='2.0')return;
      const frame=framesByKind[kind],m=event.data;
      try{
        if(m.method==='ui/initialize'){
          handshakes[kind]={start:performance.now()};
          send(frame,{id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'isolated-test-host',version:'1'},
            hostCapabilities:{serverTools:{},serverResources:{},updateModelContext:{structuredContent:{}}},
            hostContext:{theme:'light',displayMode:'inline',availableDisplayModes:['inline','fullscreen'],containerDimensions:{height:900,width:1470}}}});
        }else if(m.method==='ui/notifications/initialized'){
          handshakes[kind].duration=performance.now()-handshakes[kind].start;
          send(frame,{method:'ui/notifications/tool-input',params:{arguments:{project_id:'real-sar-20261106'}}});
          send(frame,{method:'ui/notifications/tool-result',params:opened[kind]});
        }else if(m.method==='tools/call')send(frame,{id:m.id,result:await window.mcpCall(m.params)});
        else if(m.method==='resources/read')send(frame,{id:m.id,result:await window.mcpResource(m.params)});
        else if(m.method==='ui/update-model-context'){contexts[kind]=m.params;send(frame,{id:m.id,result:{}});}
        else if(m.method==='ui/request-display-mode')send(frame,{id:m.id,result:{mode:m.params.mode}});
        else if(m.id&&waiters[m.id]){waiters[m.id](m);delete waiters[m.id];}
      }catch(error){uiErrors.push(kind+': '+error.message);if(m.id)send(frame,{id:m.id,error:{code:-32000,message:error.message}});}
    });
    for(const kind of ['workbench']){
      const frame=document.createElement('iframe');frame.title=kind;frame.sandbox='allow-scripts allow-same-origin';
      framesByKind[kind]=frame;frame.src=childOrigin+'/'+kind+'.html';document.getElementById('windows').append(frame);
    }
  },{childOrigin,opened});
  const frames={};
  for(const kind of ['workbench']){
    const frame=page.frames().find(f=>f.url()===childOrigin+'/'+kind+'.html')||await page.waitForEvent('framenavigated',{predicate:f=>f.url()===childOrigin+'/'+kind+'.html'});
    frames[kind]=frame;
    await frame.waitForFunction(()=>document.body.dataset.appState==='mounted',null,{timeout:60000});
  }
  const frame=frames.workbench;
  await frame.locator('.ic-schematic svg').first().waitFor({timeout:60000});
  assert(await frame.locator('.ic-schematic option').count()>=97);
  await frame.getByRole('button',{name:'绘制已导出波形',exact:true}).click();
  await frame.waitForFunction(()=>document.querySelectorAll('.wf-trace').length===6&&document.querySelectorAll('.wf-cursors tr').length===7,null,{timeout:45000});
  await page.screenshot({path:output+'/workbench-debug.png',fullPage:true});
  await writeFile(output+'/simulation-text.txt',await frame.locator('.ic-mcp-simulation').innerText());
  await frame.locator('.ic-mcp-simulation textarea[data-field="json"]').waitFor({timeout:15000});
  assert((await frame.locator('.ic-mcp-simulation input').count())>1);
  report.checks.push('one MCP resource renders real schematic, six saved traces and simulation configuration');
  await page.screenshot({path:output+'/workbench-initial.png',fullPage:true});
  const panelId=async selector=>frame.locator(selector).evaluate(el=>el.closest('.wb-panel').dataset.panelId);
  const schematicId=await panelId('.ic-schematic'),waveId=await panelId('.ic-mcp-waveforms'),simId=await panelId('.ic-mcp-simulation');
  const tab=id=>frame.locator('[data-tab-id="'+id+'"]');
  const saved=()=>frame.waitForFunction(()=>document.querySelector('.wb-save-state').textContent==='布局已保存');
  const closePanel=async id=>{await tab(id).click();const group=tab(id).locator('xpath=ancestor::section[contains(@class,"wb-group")]');await group.getByRole('button',{name:/^关闭 /}).click();await tab(id).waitFor({state:'detached',timeout:15000});};
  const reopen=async id=>{await frame.locator('.wb-view-menu summary').click();await frame.locator('.wb-view-menu button').filter({hasText:id===waveId?'波形':id===simId?'仿真':'原理图'}).click();await tab(id).waitFor();};
  await saved();
  await frame.evaluate(()=>{window.actualSchematicSVG=document.querySelector('.ic-schematic svg');window.actualWaveCanvas=document.querySelector('canvas.wf-plot');if(!window.actualWaveCanvas)throw Error('Missing waveform canvas');});
  // Merge with physical pointer drag; native component DOM must survive.
  const waveBox=await tab(waveId).boundingBox(),schematicBox=await tab(schematicId).boundingBox();
  await page.mouse.move(waveBox.x+waveBox.width/2,waveBox.y+waveBox.height/2);await page.mouse.down();
  await page.mouse.move(schematicBox.x+schematicBox.width/2,schematicBox.y+schematicBox.height/2,{steps:15});await page.mouse.up();
  await frame.waitForFunction(()=>document.querySelectorAll('.wb-group').length===2);await saved();
  assert.equal(await frame.evaluate(()=>actualSchematicSVG===document.querySelector('.ic-schematic svg')),true);
  assert.equal(await frame.evaluate(()=>actualWaveCanvas===document.querySelector('canvas.wf-plot')),true);
  report.checks.push('pointer drag merges tabs without remounting real schematic SVG or waveform canvas');
  // Restore default splits and resize using keyboard; same mounted instances survive.
  await frame.getByRole('button',{name:'恢复默认工作台布局',exact:true}).click();await saved();
  const separator=frame.getByRole('separator').first();await separator.focus();const old=await separator.getAttribute('aria-valuenow');await separator.press('ArrowRight');
  await saved();assert.notEqual(await frame.getByRole('separator').first().getAttribute('aria-valuenow'),old);
  assert.equal(await frame.evaluate(()=>actualSchematicSVG===document.querySelector('.ic-schematic svg')),true);
  await tab(waveId).dblclick();await frame.getByRole('button',{name:'还原面板',exact:true}).waitFor();
  await page.screenshot({path:output+'/waveform-maximized.png',fullPage:true});
  await frame.getByRole('button',{name:'还原面板',exact:true}).click();await saved();
  report.checks.push('resize and maximize/restore preserve mounted components');
  // Persist unfinished JSON exactly; closing must never invoke electrical writes.
  const editor=frame.locator('.ic-mcp-simulation textarea[data-field="json"]');await editor.fill('{"unfinished":');
  await closePanel(simId);await saved();assert.equal(await frame.locator('.ic-mcp-simulation').count(),0);
  await reopen(simId);await editor.waitFor();await frame.waitForFunction(()=>document.querySelector('.ic-mcp-simulation textarea[data-field="json"]').value==='{"unfinished":');
  report.checks.push('closing and reopening the same simulation view preserves invalid in-progress JSON');
  await closePanel(waveId);await saved();assert.equal(await frame.locator('.ic-mcp-waveforms').count(),0);
  await reopen(waveId);await frame.waitForFunction(()=>document.querySelectorAll('.wf-trace').length===6&&document.querySelectorAll('.wf-cursors tr').length===7,null,{timeout:45000});
  report.checks.push('closing waveform panel disposes it and reopening restores six exact saved-run traces');
  await closePanel(waveId);await closePanel(simId);await closePanel(schematicId);await saved();
  await frame.getByRole('heading',{name:'工作台已清空'}).waitFor();
  const parent=data(await call('ic_view_get',{workspace_id,view_id:data(opened.workbench).view_id}));
  const state=data(await call('ic_view_data',{workspace_id,view_id:parent.view_id,revision:parent.revision,query:{kind:'layout'}}));
  assert.equal(JSON.parse(state.payload.text).tree,null);assert.equal(JSON.parse(state.payload.text).panels.length,3);
  report.checks.push('all panels close while their identities remain persisted for reopening');
  await frame.goto(childOrigin+'/workbench.html');await frame.waitForFunction(()=>document.body.dataset.appState==='mounted',null,{timeout:60000});
  await frame.getByRole('heading',{name:'工作台已清空'}).waitFor();await saved();assert.equal(await frame.locator('.wb-empty-actions button').count(),3);assert.equal(await frame.locator('.ic-schematic').count(),0);
  report.checks.push('resource reload preserves the all-closed layout and does not open new views');
  await frame.locator('.wb-empty-actions button').filter({hasText:'原理图'}).click();await frame.locator('.ic-schematic svg').first().waitFor({timeout:60000});
  assert.equal(await panelId('.ic-schematic'),schematicId);await saved();
  await page.setViewportSize({width:760,height:1000});await page.screenshot({path:output+'/workbench-narrow.png',fullPage:true});

  report.errors.push(...await page.evaluate(()=>uiErrors));
  assert.deepEqual(report.errors,[]);
  assert.equal(report.productionPosts,0);
  report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;throw error;}
finally{
  await writeFile(output+'/report.json',JSON.stringify(report,null,2)+'\n');
  await browser?.close();mcp?.stdin.end();
  if(mcp&&mcp.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{mcp.kill();resolve();},3000);mcp.once('exit',()=>{clearTimeout(timer);resolve();});});
  await close(resourceServer);await close(parentServer);await close(gateway);await rm(temp,{recursive:true,force:true});
  console.log(JSON.stringify({status:report.status,checks:report.checks,errors:report.errors,failure:report.failure,productionPosts:report.productionPosts}));
}
