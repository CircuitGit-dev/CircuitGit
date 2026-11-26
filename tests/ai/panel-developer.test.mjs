import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAI} from '../../apps/web/ai/ai-panel.js';
import {imageDocument,tick,until} from './fixtures/image-dom.mjs';

function fixture(t,{development={available:true,workspace:'/fixture/application',reason:null},history={}}={}){
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const document=imageDocument(),previous=globalThis.Option;globalThis.Option=document.Option;t.after(()=>{globalThis.Option=previous;});
  const root=document.createElement('section');document.body.append(root);
  const context={revision:1,mode:'live',project:{id:'fixture'},file:{dirty:false,currentTextSha256:'hash',persistedSha256:'hash'}},calls=[];
  const state={development,developmentError:false,history:{session_id:'developer-fixture',state:'idle',cursor:0,messages:[],turns:[],pending:[],...history},events:[]};
  let contextListener=()=>{};
  async function read(path){calls.push({method:'GET',path});const url=new URL(path,'https://fixture.invalid');assert.equal(url.searchParams.get('session_id'),'developer-fixture');
    if(url.pathname==='/models')return {default_model:'fixture',models:[{id:'fixture',model:'fixture',displayName:'Fixture',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
    if(url.pathname==='/development'){if(state.developmentError)throw Error('404');return structuredClone(state.development);}
    if(url.pathname==='/history')return structuredClone(state.history);
    if(url.pathname==='/events')return {events:structuredClone(state.events),state:state.history.state,cursor:state.history.cursor,pending:structuredClone(state.history.pending)};
    assert.fail('Unexpected fixture GET '+path);
  }
  async function post(path,body){calls.push({method:'POST',path,body:structuredClone(body)});assert.equal(body.session_id,'developer-fixture');
    if(path==='/approval')return {delivered:true};assert.equal(path,'/turn');
    const receipt={key:body.idempotency_key,state:'running',thread_id:'thread-fixture',turn_id:'turn-fixture',selected_model_id:body.model||'',permission_mode:body.permission_mode||'manual',reasoning_effort:body.reasoning_effort??null,...(body.permission_mode==='developer'?{development_access:state.development.access||'manual',development_workspace:state.development.workspace}:{})};
    Object.assign(state.history,{state:'running',active_request_key:receipt.key,active_turn_id:receipt.turn_id});state.history.turns.push(receipt);return receipt;
  }
  const options={presentation:'clean',sessionId:'developer-fixture',contextAdapter:{getContext:()=>context,subscribe:callback=>{contextListener=callback;return()=>{};}},getRequest:read,postRequest:post};
  let panel=mountAI(root,options);panel.setVisible(true);t.after(()=>panel.destroy());
  const c=()=>({input:root.querySelector('textarea'),model:root.querySelector('.ic-ai-model'),permission:root.querySelector('.ic-ai-permission'),effort:root.querySelector('.ic-ai-effort'),settings:root.querySelector('.ic-ai-settings-button'),developer:root.querySelector('.ic-ai-permission').children.find(o=>o.value==='developer'),send:root.querySelectorAll('button').find(b=>b.type==='submit'),form:root.querySelector('form')});
  const choose=(node,value)=>{node.value=value;node.fire('change');};
  const ready=()=>until(()=>!c().model.disabled);
  const open=async()=>{await ready();c().settings.click();await tick();await tick();};
  const submit=()=>c().form.onsubmit({preventDefault(){}});
  const poll=async()=>{t.mock.timers.tick(1200);await tick();await tick();};
  function emit(method,params){state.events.push({sequence:++state.history.cursor,request_key:state.history.active_request_key,method,params});}
  async function start(){await open();choose(c().permission,'developer');c().input.value='开发这个工作台';await submit();}
  function remount(){panel.destroy();panel=mountAI(root,options);panel.setVisible(true);return panel;}
  return {document,root,c,calls,state,context,choose,open,ready,start,submit,poll,emit,remount,updateContext(){contextListener(context);}};
}

test('unconfigured or missing development endpoint disables only developer mode',async t=>{
  const f=fixture(t,{development:{available:false,workspace:null,reason:'not configured'}});await f.open();assert.equal(f.c().developer.disabled,true);assert.match(f.root.textContent,/尚未配置/);
  f.choose(f.c().permission,'developer');assert.equal(f.c().permission.value,'manual');assert.equal(f.c().send.disabled,false);
  f.c().settings.click();f.state.developmentError=true;await f.open();assert.equal(f.c().developer.disabled,true);assert.match(f.root.textContent,/其他模式仍可使用/);
  f.c().input.value='普通提问';await f.submit();assert.equal(f.calls.find(c=>c.path==='/turn').body.permission_mode,undefined);
});

test('configured developer mode displays fixed workspace and sends only the mode, with normal locking',async t=>{
  const f=fixture(t);await f.open();assert.equal(f.c().developer.disabled,false);f.choose(f.c().permission,'developer');f.choose(f.c().effort,'low');
  assert.match(f.c().settings.title,/低 · 开发者/);assert.match(f.root.textContent,/\/fixture\/application/);assert.match(f.root.textContent,/写入和扩展执行权限需人工批准/);
  f.c().input.value='开发';await f.submit();const sent=f.calls.find(c=>c.path==='/turn').body;assert.equal(sent.permission_mode,'developer');assert.equal(sent.reasoning_effort,'low');assert.equal(Object.hasOwn(sent,'development_workspace'),false);assert.equal(Object.hasOwn(sent,'workspace'),false);
  assert(f.calls.filter(c=>c.path.startsWith('/development')).length>=2);assert.equal(f.c().permission.disabled,true);f.choose(f.c().permission,'manual');assert.equal(f.c().permission.value,'developer');
});

test('workspace changes before submission preserve the draft and require a new user send',async t=>{
  const f=fixture(t);await f.open();f.choose(f.c().permission,'developer');f.c().input.value='keep';f.state.development.workspace='/fixture/changed';await f.submit();
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(f.c().input.value,'keep');assert.match(f.root.textContent,/工作目录已变化/);assert.match(f.root.textContent,/\/fixture\/changed/);
  await f.submit();assert.equal(f.calls.filter(c=>c.path==='/turn').length,1);
});

test('restored developer setting is preserved and cannot silently downgrade when unavailable',async t=>{
  const f=fixture(t,{development:{available:false,workspace:null,reason:'not configured'},history:{state:'complete',active_request_key:null,turns:[{key:'old',state:'complete',permission_mode:'developer',reasoning_effort:'low',input_resumed_at_ms:1}]}});await f.ready();await tick();
  assert.equal(f.c().permission.value,'developer');assert.equal(f.c().send.disabled,true);assert.match(f.c().settings.title,/开发者/);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('native approvals require exact server capability and method, never a field inside params',async t=>{
  const f=fixture(t);await f.start();
  const requests=[
    {approval_id:'denied',kind:'codex',method:'item/commandExecution/requestApproval',can_approve:false,params:{can_approve:true,command:'not permitted'}},
    {approval_id:'unknown',kind:'codex',method:'item/other/requestApproval',can_approve:true,params:{}},
    {approval_id:'command',kind:'codex',method:'item/commandExecution/requestApproval',can_approve:true,development_workspace:'/fixture/application',params:{command:'python3 -B tests/check.py',cwd:'/fixture/application',reason:'Run isolated tests'}},
  ];
  for(const a of requests)f.emit('approval/required',{...a,status:'pending'});await f.poll();
  const cards=f.document.body.querySelectorAll('.ic-ai-approval'),yes=card=>card.querySelector('[data-decision=approve]');
  assert.equal(yes(cards[0]).disabled,true);assert.equal(yes(cards[1]).disabled,true);assert.equal(yes(cards[2]).disabled,false);
  assert.match(cards[2].textContent,/python3 -B tests\/check.py/);assert.match(cards[2].textContent,/执行目录：\/fixture\/application/);assert.match(cards[2].textContent,/Run isolated tests/);
  assert.equal(f.calls.filter(c=>c.path==='/approval').length,0);await yes(cards[0]).click();await yes(cards[1]).click();assert.equal(f.calls.filter(c=>c.path==='/approval').length,0);
  await yes(cards[2]).click();assert.deepEqual(f.calls.find(c=>c.path==='/approval').body,{session_id:'developer-fixture',approval_id:'command',decision:'approve'});
  assert.equal(f.document.body.querySelectorAll('[data-approval-id="command"]').length,0,'resolved approval card must disappear immediately');
  assert.equal(f.root.querySelector('.ic-ai-stop').hidden,false,'stop button stays visible while turn is active');
});

test('file approval shows only the exactly matched native file item and marks missing diffs honestly',async t=>{
  const f=fixture(t);await f.start();f.emit('item/started',{item:{id:'file-1',type:'fileChange',changes:[{path:'apps/web/example.js',diff:'- old\n+ fixed'}]}});
  for(const [id,itemId] of [['matched','file-1'],['missing','different-file']])f.emit('approval/required',{approval_id:id,status:'pending',kind:'codex',method:'item/fileChange/requestApproval',can_approve:true,params:{itemId,reason:'Fix viewer'},development_workspace:'/fixture/application'});
  await f.poll();const cards=f.document.body.querySelectorAll('.ic-ai-approval');assert.match(cards[0].textContent,/apps\/web\/example.js/);assert.match(cards[0].textContent,/fixed/);assert.doesNotMatch(cards[1].textContent,/apps\/web\/example.js/);assert.match(cards[1].textContent,/未提供文件差异/);
  f.context.revision=2;f.updateContext();assert.equal(cards[0].querySelector('[data-decision=approve]').disabled,true);assert.equal(f.calls.filter(c=>c.path==='/approval').length,0);
});

test('native command output remains in expandable steps, outside the chat transcript',async t=>{
  const f=fixture(t);await f.start();f.emit('item/started',{item:{id:'cmd',type:'commandExecution',command:'python test.py',cwd:'/fixture/application'}});f.emit('item/commandExecution/outputDelta',{itemId:'cmd',delta:'tests passed'});await f.poll();
  const step=f.root.querySelector('.ic-ai-steps').querySelectorAll('details').find(node=>node.querySelector('summary').textContent==='命令输出');step.open=true;step.fire('toggle');assert.match(step.textContent,/tests passed/);assert.match(step.textContent,/python test.py/);assert.equal(f.root.querySelectorAll('.ic-ai-message').length,1);
});

test('full access is declared by the server and never added to browser turn arguments',async t=>{
  const f=fixture(t,{development:{available:true,workspace:'/fixture/application',reason:null,access:'full'}});await f.open();f.choose(f.c().permission,'developer');
  assert.equal(f.c().settings.textContent,'⚙');assert.equal(f.c().settings.getAttribute('aria-label'),'AI设置');assert.equal(f.c().developer.textContent,'开发者模式 · 完全访问');assert.match(f.c().settings.title,/开发者 · 完全访问/);assert.match(f.root.textContent,/可读写本机文件、执行命令及联网，无需逐项审批/);
  f.c().input.value='实现改动';await f.submit();const sent=f.calls.find(c=>c.path==='/turn').body;
  assert.equal(sent.permission_mode,'developer');assert.equal(Object.hasOwn(sent,'access'),false);assert.equal(Object.hasOwn(sent,'development_access'),false);assert.equal(Object.hasOwn(sent,'development_workspace'),false);
  assert.match(f.root.querySelector('.ic-ai-progress').textContent,/本回合权限：开发者 · 完全访问/);assert.equal(f.calls.filter(c=>c.path==='/approval').length,0);
});

test('access drift in either direction retains the draft until a new explicit send',async t=>{
  const f=fixture(t);await f.open();f.choose(f.c().permission,'developer');f.c().input.value='保留权限变化时的草稿';f.state.development.access='full';await f.submit();
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(f.c().input.value,'保留权限变化时的草稿');assert.match(f.root.textContent,/开发访问权限已变化/);assert.match(f.c().settings.title,/完全访问/);
  f.state.development.access='manual';await f.submit();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.match(f.c().settings.title,/开发者 · 人工批准/);await f.submit();assert.equal(f.calls.filter(c=>c.path==='/turn').length,1);
});

test('legacy running receipts remain manual when the current server configuration becomes full',async t=>{
  const f=fixture(t,{development:{available:true,workspace:'/fixture/application',access:'full'},history:{state:'running',active_request_key:'old',turns:[{key:'old',state:'running',permission_mode:'developer',turn_id:'old-turn'}]}});await tick();await tick();
  assert.equal(f.c().permission.value,'developer');assert.equal(f.c().permission.disabled,true);assert.match(f.root.querySelector('.ic-ai-progress').textContent,/本回合权限：开发者 · 人工批准/);assert.doesNotMatch(f.root.querySelector('.ic-ai-progress').textContent,/完全访问/);
  assert.match(f.root.querySelector('.ic-ai-settings-note').textContent,/本回合按人工批准配置；新消息将使用完全访问/);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('historical full receipts keep their own access evidence after configuration switches back to manual',async t=>{
  const f=fixture(t,{history:{state:'complete',active_request_key:null,turns:[{key:'old',state:'complete',permission_mode:'developer',development_access:'full',input_resumed_at_ms:1}]}});await f.ready();await tick();
  assert.match(f.root.querySelector('.ic-ai-progress').textContent,/本回合权限：开发者 · 完全访问/);assert.match(f.c().settings.title,/开发者 · 人工批准/);assert.match(f.root.querySelector('.ic-ai-settings-note').textContent,/需人工批准/);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
