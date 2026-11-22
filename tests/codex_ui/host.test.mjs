import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createMCPHost,unwrapToolResult,MCP_UI_PROTOCOL} from '../../apps/codex/ui/host.js';

const view=(kind='waveforms',extra={})=>({schema:'ic.view.v1',kind,view_id:'view-A',workspace_id:'workspace-A',revision:1,identity:{project_id:'p',source_commit:'a'.repeat(40),run_id:'run-A'},workspace_revision:1,requests:[],selection:null,draft_dirty:false,review_id:null,plan_ready:false,visible:true,display_mode:'inline',readiness:{state:'requested',basis:'server-request',message:null},ui:{resource_uri:'ui://ic-workbench/'+kind+'.html',available:true,mounted:null},...extra});
const result=data=>({structuredContent:{ok:true,data},content:[]});
function fixture({opaque=false,kind='waveforms',capabilities={serverTools:{},serverResources:{},updateModelContext:{structuredContent:{}}},timeout=100}={}){
  const sent=[],listeners=new Map(),statuses=[];const parent={postMessage(message,origin){sent.push({message,origin});}};
  const win={parent,crypto:webcrypto,location:{ancestorOrigins:opaque?['null']:['https://host.example']},document:{referrer:opaque?'':'https://host.example/chat',documentElement:{dataset:{},style:{setProperty(){}}}},setTimeout,clearTimeout,addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name){listeners.delete(name);}};
  const receive=(message,{source=parent,origin=opaque?'null':'https://host.example'}={})=>listeners.get('message')?.({data:{jsonrpc:'2.0',...message},source,origin});
  const host=createMCPHost({kind,window:win,requestTimeout:timeout,initializeTimeout:timeout,onStatus:(m,o)=>statuses.push({m,o})});
  async function init(){const request=sent[0].message;await receive({id:request.id,result:{protocolVersion:MCP_UI_PROTOCOL,hostCapabilities:capabilities,hostContext:{displayMode:'inline',availableDisplayModes:['inline','fullscreen']}}});await host.ready;}
  async function bind(){await init();await receive({method:'ui/notifications/tool-input',params:{arguments:{project_id:'p',run_id:'run-A'}}});await receive({method:'ui/notifications/tool-result',params:result(view(kind,kind==='simulation'?{identity:{project_id:'p',source_commit:'a'.repeat(40),run_id:null,configuration:'tran',path:'config.json'}}:{}))});await host.initialReady;}
  async function reply(value){await new Promise(r=>setImmediate(r));await receive({id:sent.at(-1).message.id,result:value});}
  return {win,parent,sent,statuses,receive,host,init,bind,reply};
}
test('workbench scopes child requests and keeps parent view revision independent',async()=>{
  const f=fixture({kind:'workbench'});await f.bind();
  const child=view('simulation',{view_id:'v_'+'a'.repeat(32),identity:{project_id:'p',source_commit:'a'.repeat(40),configuration:'tran',run_id:null}});
  const opening=f.host.openPanel('simulation',{configuration:'tran'});await f.reply(result(child));assert.equal((await opening).view_id,child.view_id);
  const scope=f.host.componentHost(child);
  const saving=scope.saveLocalState({text:'{unfinished',tab:'configuration'});
  const updated={...child,revision:2,workspace_revision:3};await f.reply(result(updated));await saving;
  assert.equal(scope.view.revision,2);assert.equal(f.host.view.revision,1);assert.equal(f.host.view.kind,'workbench');
  const loading=scope.loadLocalState();await f.reply({...result({view:updated}),_meta:{icWorkbench:{data:{view:updated,payload:{text:'{"text":"{unfinished"}'}}}}});assert.equal((await loading).text,'{unfinished');
  const before=f.sent.length;
  await assert.rejects(scope.call('ic_view_get',{workspace_id:'workspace-A',view_id:'other'}),/Cross-view/);
  await assert.rejects(scope.call('ic_simulation_open',{}),/through the workbench/);
  assert.equal(f.sent.length,before);
  scope.dispose();await assert.rejects(scope.call('ic_view_get',{}),/disposed/);await f.host.dispose();
});
test('workbench never admits a child from a different project or accepts stale child state',async()=>{
  const f=fixture({kind:'workbench'});await f.bind();
  const opening=f.host.openPanel('waveforms',{run_id:'saved'});
  await f.reply(result(view('waveforms',{view_id:'v_'+'a'.repeat(32),identity:{project_id:'foreign'}})));
  await assert.rejects(opening,/does not belong/);
  await assert.rejects(f.host.openPanel('waveforms',{project_id:'foreign',run_id:'saved'}),/Invalid workbench/);
  const child=view('waveforms',{view_id:'v_'+'a'.repeat(32)});
  const scope=f.host.componentHost(child),reading=scope.call('ic_view_get',{view_id:child.view_id,workspace_id:child.workspace_id});
  await f.reply(result({...child,revision:0}));await assert.rejects(reading,/descriptor/);
  assert.equal(scope.view.revision,1);await f.host.dispose();
});
test('embedded model context carries exact panel and workbench identities',async()=>{
  const f=fixture({kind:'workbench'});await f.bind();const child=view('waveforms',{view_id:'v_'+'b'.repeat(32)}),scope=f.host.componentHost(child);
  const sending=scope.updateModelContext({signals:['s']});await f.reply({});await sending;
  assert.deepEqual(f.sent.at(-1).message.params.structuredContent,{signals:['s'],workspace_id:'workspace-A',view_id:child.view_id,view_revision:1,workbench_id:'view-A'});
  await f.host.dispose();
});
test('initialize is first; initialized immediately; no data/tool calls before descriptor',async()=>{
  const f=fixture();assert.equal(f.sent[0].message.method,'ui/initialize');assert.equal(f.sent[0].origin,'https://host.example');assert.equal(f.sent[0].message.params.protocolVersion,'2026-01-26');
  await f.init();assert.equal(f.sent[1].message.method,'ui/notifications/initialized');assert.equal(f.host.initial,null);assert.equal(f.sent.length,2);await f.host.dispose();
});
test('only direct parent and correlated ID accepted, known origin pinned',async()=>{
  const f=fixture();await f.receive({id:f.sent[0].message.id,result:{}},{source:{}});await f.receive({id:f.sent[0].message.id,result:{}},{origin:'https://attacker.example'});await f.receive({id:'guessed',result:{}});assert.equal(f.sent.length,1);await f.bind();assert.equal(f.host.initial.view_id,'view-A');await f.host.dispose();
});
test('opaque parent uses standard direct-parent wildcard and pins null origin',async()=>{
  const f=fixture({opaque:true});assert.equal(f.sent[0].origin,'*');await f.bind();assert.equal(f.sent[1].origin,'*');await f.receive({method:'ui/notifications/tool-result',params:result(view('waveforms',{revision:2}))},{origin:'https://other.example'});assert.equal(f.host.view.revision,1);await f.host.dispose();
});
test('missing origin is learned from correlated parent reply',async()=>{
  const f=fixture({opaque:true});await f.receive({id:f.sent[0].message.id,result:{protocolVersion:MCP_UI_PROTOCOL,hostCapabilities:{},hostContext:{}}},{origin:'https://actual.example'});await f.host.ready;assert.equal(f.sent[1].origin,'https://actual.example');await f.host.dispose();
});
test('tool-input precedes result, descriptor isolation/revision/source pinned',async()=>{
  const f=fixture();await f.init();await f.receive({method:'ui/notifications/tool-result',params:result(view())});assert.equal(f.host.initial,null);
  await f.receive({method:'ui/notifications/tool-input',params:{arguments:{}}});await f.receive({method:'ui/notifications/tool-result',params:result(view())});let notifications=0;f.host.onResult(()=>notifications++);
  for(const data of [view('schematic'),view('waveforms',{view_id:'view-B'}),view('waveforms',{revision:0}),view('waveforms',{revision:2,identity:{source_commit:'b'}})])await f.receive({method:'ui/notifications/tool-result',params:result(data)});
  assert.equal(f.host.view.revision,1);assert.equal(notifications,0);await f.receive({method:'ui/notifications/tool-result',params:result(view('waveforms',{revision:2}))});assert.equal(notifications,1);assert.equal(f.host.initial.revision,1);await f.host.dispose();
});
test('workspace revision can advance while the same view CAS revision is unchanged',async()=>{
  const f=fixture();await f.bind();const next=view('waveforms',{workspace_revision:4});await f.receive({method:'ui/notifications/tool-result',params:result(next)});assert.equal(f.host.view.workspace_revision,4);assert.equal(f.host.view.revision,1);await f.host.dispose();
});
test('another view advancing workspace revision does not block this view data/get',async()=>{
  const f=fixture();await f.bind();const next={...f.host.view,workspace_revision:8};
  const data=f.host.call('ic_view_data',{workspace_id:'workspace-A',view_id:'view-A',revision:1,query:{kind:'signals'}});
  await f.reply({...result({summary:'signals'}),_meta:{icWorkbench:{data:{view:next,payload:{signals:['s']}}}}});
  assert.deepEqual((await data).payload,{signals:['s']});assert.equal(f.host.view.revision,1);assert.equal(f.host.view.workspace_revision,8);
  const get=f.host.call('ic_view_get',{workspace_id:'workspace-A',view_id:'view-A'});await f.reply(result({...next,workspace_revision:9}));assert.equal((await get).workspace_revision,9);
  const stale=f.host.call('ic_view_get',{workspace_id:'workspace-A',view_id:'view-A'});await f.reply(result(next));await assert.rejects(stale,/Stale workspace/);assert.equal(f.host.view.workspace_revision,9);await f.host.dispose();
});
test('human CLI receipt advances without view revision and cannot roll back or change identity',async()=>{
  const f=fixture({kind:'simulation'});await f.bind();const receipt={request_id:'human-request',operation:'sim_submit',fingerprint:'fixed',state:'pending_approval'};
  const prepared={...f.host.view,revision:2,workspace_revision:2,requests:[receipt]};await f.receive({method:'ui/notifications/tool-result',params:result(prepared)});
  for(const state of ['dispatching','accepted']){
    const call=f.host.call('ic_view_data',{workspace_id:'workspace-A',view_id:'view-A',revision:2,query:{kind:'request',request_id:receipt.request_id}});
    const updated={...prepared,requests:[{...receipt,state}]};await f.reply({...result({view:updated}),_meta:{icWorkbench:{data:{view:updated,payload:{...receipt,state}}}}});
    assert.equal((await call).payload.state,state);assert.equal(f.host.view.requests[0].state,state);assert.equal(f.host.view.revision,2);
  }
  for(const requests of [[receipt],[{...receipt,state:'dispatching'}],[{...receipt,state:'denied'}],[{...receipt,state:'accepted',fingerprint:'other'}],[]]){
    const call=f.host.call('ic_view_get',{workspace_id:'workspace-A',view_id:'view-A'});await f.reply(result({...prepared,requests}));await assert.rejects(call,/receipt/);assert.equal(f.host.view.requests[0].state,'accepted');
  }
  await f.host.dispose();
});
test('same revision protects CAS fields but accepts live availability and key reordering',async()=>{
  const f=fixture();await f.bind();const before=f.host.view;
  for(const update of [{selection:{kind:'net',name:'x'}},{draft_dirty:true},{review_id:'other'},{plan_ready:true},{visible:false},{display_mode:'fullscreen'},{readiness:{state:'loaded'}},{ui:{...before.ui,resource_uri:'ui://ic-workbench/other.html'}},{requests:[{request_id:'new',operation:'apply',fingerprint:'f',state:'pending_approval'}]}]){
    const call=f.host.call('ic_view_get',{view_id:'view-A',workspace_id:'workspace-A'});await f.reply(result({...before,...update}));await assert.rejects(call,/CAS-controlled/);assert.deepEqual(f.host.view,before);
  }
  const call=f.host.call('ic_view_get',{view_id:'view-A',workspace_id:'workspace-A'});const next={...before,identity:Object.fromEntries(Object.entries(before.identity).reverse()),ui:{...before.ui,available:false}};await f.reply(result(next));assert.equal((await call).ui.available,false);await f.host.dispose();
});
test('live receipt transitions allow missed polling states and keep terminal results immutable',async()=>{
  for(const state of ['accepted','denied','rejected','uncertain']){
    const f=fixture();await f.bind();const receipt={request_id:'r',operation:'apply',fingerprint:'f',state:'pending_approval'},prepared={...f.host.view,revision:2,workspace_revision:2,requests:[receipt]};await f.receive({method:'ui/notifications/tool-result',params:result(prepared)});
    await f.receive({method:'ui/notifications/tool-result',params:result({...prepared,requests:[{...receipt,state}]})});assert.equal(f.host.view.requests[0].state,state);
    await f.receive({method:'ui/notifications/tool-result',params:result({...prepared,revision:3,workspace_revision:3,requests:[receipt]})});assert.equal(f.host.view.requests[0].state,state);assert.equal(f.host.view.revision,2);
    const stale=f.host.call('ic_view_get',{workspace_id:'workspace-A',view_id:'view-A'});await f.reply(result({...prepared,revision:1,workspace_revision:3,requests:[{...receipt,state}]}));await assert.rejects(stale,/Stale view revision/);assert.equal(f.host.view.revision,2);await f.host.dispose();
  }
});
test('in-flight bind_run tolerates a same-CAS live workspace refresh',async()=>{
  const f=fixture({kind:'simulation'});await f.bind();const before=f.host.view;
  const call=f.host.call('ic_view_bind_run',{workspace_id:'workspace-A',view_id:'view-A',expected_revision:1,request_id:'own-accepted-request'});await new Promise(resolve=>setImmediate(resolve));
  await f.receive({method:'ui/notifications/tool-result',params:result({...before,workspace_revision:2})});
  await f.reply(result({...before,revision:2,workspace_revision:3,identity:{...before.identity,run_id:'own-run'}}));assert.equal((await call).identity.run_id,'own-run');await f.host.dispose();
});
test('tools/call unwraps UI metadata, errors propagate, no retries; cross-view args refused',async()=>{
  const f=fixture();await f.bind();let notified=0;f.host.onResult(()=>notified++);
  const pending=f.host.call('ic_view_data',{view_id:'view-A',workspace_id:'workspace-A',revision:1,query:{kind:'signals'}});const data={view:view(),payload:{signals:['saved-real-id']}};await f.reply({...result({summary:'bounded'}),_meta:{icWorkbench:{data}}});assert.deepEqual(await pending,data);assert.equal(notified,0);assert.equal(f.sent.at(-1).message.method,'tools/call');
  await assert.rejects(f.host.call('ic_view_get',{view_id:'other'}),/Cross-view/);const count=f.sent.length;
  const failed=f.host.call('ic_view_get',{view_id:'view-A'});await f.reply({isError:true,structuredContent:{ok:false,error:{code:'conflict',message:'stale'}}});await assert.rejects(failed,/stale/);assert.equal(f.sent.length,count+1);await f.host.dispose();
});
test('bounded model context and display/resource capability checks',async()=>{
  const f=fixture();await f.bind();const update=f.host.updateModelContext({signal_ids:['s']});await f.reply({});await update;assert.deepEqual(f.sent.at(-1).message.params.structuredContent,{signal_ids:['s'],view_id:'view-A',workspace_id:'workspace-A',view_revision:1});
  await assert.rejects(f.host.updateModelContext({text:'x'.repeat(33000)}),/32 KiB/);assert.equal((await f.host.requestDisplayMode('sidepanel')).supported,false);
  const mode=f.host.requestDisplayMode('fullscreen');await f.reply({mode:'inline'});assert.equal((await mode).mode,'inline');
  const read=f.host.readResource('ui://ic-workbench/schematic.html');await f.reply({contents:[{uri:'ui://ic-workbench/schematic.html',text:'html'}]});assert.equal((await read).contents.length,1);await assert.rejects(f.host.readResource('http://gateway/token'),/outside/);await f.host.dispose();
  const limited=fixture({capabilities:{}});await limited.bind();await assert.rejects(limited.host.call('ic_view_get',{}),/does not support/);await assert.rejects(limited.host.updateModelContext({}),/cannot accept/);await limited.host.dispose();
});
test('timeout and teardown reject outstanding operations exactly once',async()=>{
  const f=fixture({timeout:25});await f.bind();const count=f.sent.length;await assert.rejects(f.host.call('ic_view_get',{}),/timed out/);assert.equal(f.sent.length,count+1);
  let disposed=0;f.host.setDisposer(()=>disposed++);const pending=f.host.call('ic_view_get',{});pending.catch(()=>{});await new Promise(r=>setImmediate(r));await f.receive({id:'host-teardown',method:'ui/resource-teardown',params:{}});await assert.rejects(pending,/disposed/);assert.equal(disposed,1);assert.deepEqual(f.sent.at(-1).message,{jsonrpc:'2.0',id:'host-teardown',result:{}});await f.host.dispose();assert.equal(disposed,1);
});
test('UI private data is not accepted over an error envelope',()=>{assert.throws(()=>unwrapToolResult({structuredContent:{ok:false,error:{message:'denied'}},_meta:{icWorkbench:{data:'fake-success'}}}),/denied/);});
test('only successful explicit simulation bind_run may bind null run with newer revision',async()=>{
  const f=fixture({kind:'simulation'});await f.bind();const initial=f.host.initial,args={workspace_id:initial.workspace_id,view_id:initial.view_id,expected_revision:1,request_id:'accepted-submit-receipt'},bound={...initial,revision:2,identity:{...initial.identity,run_id:'receipt-run'}};
  await f.receive({method:'ui/notifications/tool-result',params:result(bound)});assert.equal(f.host.view.identity.run_id,null);
  const other=f.host.call('ic_view_get',{view_id:initial.view_id,workspace_id:initial.workspace_id});await f.reply(result(bound));await assert.rejects(other,/identity changed/);
  const wrongSource=f.host.call('ic_view_bind_run',args);await f.reply(result({...bound,identity:{...bound.identity,source_commit:'b'.repeat(40)}}));await assert.rejects(wrongSource,/identity changed/);
  const old=f.host.call('ic_view_bind_run',args);await f.reply(result({...bound,revision:1}));await assert.rejects(old,/identity changed/);
  const allowed=f.host.call('ic_view_bind_run',args);await f.reply(result(bound));assert.equal((await allowed).identity.run_id,'receipt-run');assert.equal(f.host.initial.identity.run_id,null);assert.equal(f.host.view.revision,2);
  const replace=f.host.call('ic_view_bind_run',{...args,expected_revision:2});await f.reply(result({...bound,revision:3,identity:{...bound.identity,run_id:'other-run'}}));await assert.rejects(replace,/identity changed/);await f.host.dispose();
});
test('bind_run does not authorize identity drift for waveform views or stale call CAS',async()=>{
  const f=fixture();await f.bind();const request=f.host.call('ic_view_bind_run',{workspace_id:'workspace-A',view_id:'view-A',expected_revision:1,request_id:'x'});await f.reply(result(view('waveforms',{revision:2,identity:{...f.host.initial.identity,run_id:'other-run'}})));await assert.rejects(request,/identity changed/);await f.host.dispose();
  const s=fixture({kind:'simulation'});await s.bind();const stale=s.host.call('ic_view_bind_run',{workspace_id:'workspace-A',view_id:'view-A',expected_revision:0,request_id:'x'});await s.reply(result({...s.host.initial,revision:2,identity:{...s.host.initial.identity,run_id:'r'}}));await assert.rejects(stale,/identity changed/);await s.host.dispose();
});
