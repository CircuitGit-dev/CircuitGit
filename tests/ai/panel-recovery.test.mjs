// Real panel + explicit protocol fixture. No network, model, or engineering actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAI} from '../../apps/web/ai/ai-panel.js';
import {imageDocument,PNG,tick,until} from './fixtures/image-dom.mjs';

function fixture(t,{history={}}={}){
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const document=imageDocument(),previous=globalThis.Option;globalThis.Option=document.Option;
  t.after(()=>{globalThis.Option=previous;});
  const root=document.createElement('section');document.body.append(root);
  const calls=[],sessionId='recovery-fixture',turnId='turn-fixture';
  const context={version:1,revision:1,mode:'live',project:{id:'fixture'},file:{dirty:false,persistedSha256:'hash',currentTextSha256:'hash'}};
  const catalog={default_model:'argon',models:[{id:'argon',model:'argon',displayName:'Argon fixture',inputModalities:['text','image']},{id:'sol',model:'sol',displayName:'Sol fixture',inputModalities:['text','image']}]};
  const unavailable={can_resume:false,reason:'no_terminal_failure',expected_turn_id:null};
  const state={history:{session_id:sessionId,state:'idle',messages:[],turns:[],pending:[],cursor:0,recovery:unavailable,...history},events:[],holdNextPoll:false,releasePoll:null,resumeFailure:false,catalogFailure:false};
  const batch=()=>({events:structuredClone(state.events),cursor:state.history.cursor,state:state.history.state,pending:structuredClone(state.history.pending),recovery:structuredClone(state.history.recovery)});
  async function read(path){
    calls.push({method:'GET',path});const url=new URL(path,'https://fixture.invalid');assert.equal(url.searchParams.get('session_id'),sessionId);
    if(url.pathname==='/history')return structuredClone(state.history);
    if(url.pathname==='/models'){if(state.catalogFailure)throw Error('Fixture catalog unavailable');return structuredClone(catalog);}
    if(url.pathname==='/events'){
      const result=batch();
      if(state.holdNextPoll){state.holdNextPoll=false;return new Promise(resolve=>{state.releasePoll=()=>resolve(result);});}
      return result;
    }
    assert.fail('Unexpected GET '+path);
  }
  async function post(path,body){
    calls.push({method:'POST',path,body:structuredClone(body)});assert.equal(body.session_id,sessionId);
    if(path==='/turn'){
      assert.equal(state.history.state==='idle'||state.history.state==='complete',true);
      const receipt={key:body.idempotency_key,state:'running',thread_id:'thread-fixture',turn_id:turnId,selected_model_id:body.model};
      state.history={...state.history,state:'running',active_request_key:receipt.key,active_turn_id:turnId,thread_id:'thread-fixture',turns:[...state.history.turns,receipt],messages:[...state.history.messages,{role:'user',request_key:receipt.key,text:body.message}]};
      return receipt;
    }
    if(path==='/resume'){
      assert.equal(body.expected_turn_id,turnId);assert.deepEqual(Object.keys(body).sort(),['expected_turn_id','session_id']);
      if(state.resumeFailure){state.history.recovery={...unavailable,reason:'approval_unresolved'};throw Error('Fixture resume denied');}
      assert.equal(state.history.recovery.can_resume,true);
      state.history.state='complete';state.history.recovery=unavailable;
      state.history.active_request_key=null;state.history.active_turn_id=null;
      state.history.turns.at(-1).input_resumed_at_ms=Date.now();
      return {session_id:sessionId,state:'complete',resumed:true,automatic_retry:false,history_retained:true};
    }
    assert.fail('Unexpected POST '+path);
  }
  const options={presentation:'clean',sessionId,contextAdapter:{getContext:()=>context,subscribe:()=>()=>{}},getRequest:read,postRequest:post};
  let panel=mountAI(root,options);
  t.after(()=>panel.destroy());panel.setVisible(true);
  function remount(){panel.destroy();panel=mountAI(root,options);panel.setVisible(true);return panel;}
  const model=root.querySelector('select'),input=root.querySelector('textarea'),form=root.querySelector('form');
  const send=root.querySelectorAll('button').find(b=>b.type==='submit'),resume=root.querySelector('.ic-ai-resume');
  async function start(){await until(()=>!model.disabled);model.value='argon';model.fire('change');input.value='只回复连接正常';await form.onsubmit({preventDefault(){}});await tick();}
  function emit(method,params){state.events.push({sequence:++state.history.cursor,request_key:state.history.active_request_key,thread_id:'thread-fixture',turn_id:turnId,method,params});}
  async function poll(){t.mock.timers.tick(1200);await tick();await tick();}
  async function fail(error={message:'We are experiencing high demand',codexErrorInfo:'internalServerError'}){
    emit('turn/completed',{threadId:'thread-fixture',turn:{id:turnId,status:'failed',durationMs:32141,error}});
    state.history.state='suspended';Object.assign(state.history.turns.at(-1),{state:'suspended',terminal_status:'failed',terminal_error:error,duration_ms:32141});
    state.history.recovery={can_resume:true,reason:'terminal_failure',expected_turn_id:turnId};await poll();
  }
  return {document,root,panel,calls,state,catalog,model,input,form,send,resume,start,emit,poll,fail,turnId,remount};
}

test('upstream retries keep the turn active, controls locked, and final duration accurate',async t=>{
  const f=fixture(t);await f.start();
  f.emit('error',{threadId:'thread-fixture',turnId:f.turnId,willRetry:true,error:{message:'Reconnecting... 1/5',additionalDetails:'high demand'}});await f.poll();
  assert.equal(f.panel.getState().phase,'running');assert.equal(f.send.disabled,true);assert.equal(f.model.disabled,true);
  assert.match(f.root.querySelector('.ic-ai-progress').textContent,/模型连接重试中/);assert.doesNotMatch(f.root.querySelector('.ic-ai-progress').textContent,/失败/);
  assert.equal(f.root.querySelector('.ic-ai-failure-button').hidden,true);assert.equal(f.resume.hidden,true);
  f.input.value='不能插入重试中的请求';await f.form.onsubmit({preventDefault(){}});assert.equal(f.calls.filter(c=>c.path==='/turn').length,1);
  await f.fail();assert.equal(f.panel.getState().phase,'suspended');assert.equal(f.send.disabled,true);assert.equal(f.model.disabled,true);
  assert.match(f.root.querySelector('.ic-ai-progress').textContent,/失败 · 32\.1 秒/);
  assert.match(f.root.querySelector('.ic-ai-failure-button').textContent,/模型服务暂时不可用/);assert.equal(f.resume.hidden,false);assert.equal(f.resume.disabled,false);
});

test('non-retrying error waits for terminal receipt; 503 missing channel is not a local event failure',async t=>{
  const f=fixture(t);await f.start();const error={message:'unexpected status 503: No available channel for model retired-model',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503}}};
  f.emit('error',{willRetry:false,error});await f.poll();assert.equal(f.panel.getState().phase,'running');assert.equal(f.send.disabled,true);assert.equal(f.resume.hidden,true);
  assert.match(f.root.querySelector('.ic-ai-progress').textContent,/等待最终回执/);
  await f.fail(error);assert.equal(f.panel.getState().connected,true);assert.match(f.root.querySelector('.ic-ai-failure-button').textContent,/模型通道不可用/);
  assert.doesNotMatch(f.root.querySelector('.ic-ai-failure-button').textContent,/本地事件/);
});

test('explicit recovery preserves draft images, text, model, and failed history without starting a turn',async t=>{
  const f=fixture(t);await f.start();await f.fail();const prior=structuredClone(f.state.history.turns);
  f.input.value='准备换模型后的新问题';const file=f.root.querySelector('input');file.files=[new File([PNG],'draft.png',{type:'image/png'})];file.fire('change');await until(()=>f.root.querySelector('.ic-ai-image-preview'));
  await f.resume.click();await tick();assert.equal(f.panel.getState().phase,'complete');assert.equal(f.model.value,'argon');assert.equal(f.model.disabled,false);
  assert.equal(f.input.value,'准备换模型后的新问题');assert.equal(f.root.querySelectorAll('.ic-ai-image-preview').length,1);
  assert(Number.isFinite(f.state.history.turns.at(-1).input_resumed_at_ms));
  assert.deepEqual(f.state.history.turns.map(({input_resumed_at_ms,...turn})=>turn),prior);
  assert.equal(f.resume.hidden,true);assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(c=>c.path),['/turn','/resume']);
  assert.equal(f.calls.filter(c=>c.path.startsWith('/history')).length,2);assert(f.calls.filter(c=>c.path.startsWith('/models')).length>=2);
  assert.match(f.document.body.textContent,/原请求未重发/);
});

test('pending approvals, absent recovery capability, and rejected resume keep inputs stopped',async t=>{
  const f=fixture(t);await f.start();await f.fail();
  f.state.history.recovery={can_resume:false,reason:'approval_unresolved',expected_turn_id:f.turnId};await f.poll();assert.equal(f.resume.hidden,true);assert.equal(f.send.disabled,true);
  f.state.history.recovery={can_resume:false,reason:'unknown_outcome',expected_turn_id:null};await f.poll();assert.equal(f.resume.hidden,true);
  f.state.history.recovery={can_resume:true,reason:'terminal_failure',expected_turn_id:null};await f.poll();assert.equal(f.resume.hidden,true);assert.equal(f.resume.disabled,true);
  f.state.history.recovery={can_resume:true,reason:'terminal_failure',expected_turn_id:''};await f.poll();assert.equal(f.resume.hidden,true);assert.equal(f.resume.disabled,true);
  f.state.history.recovery={can_resume:true,reason:'terminal_failure',expected_turn_id:f.turnId};await f.poll();f.state.resumeFailure=true;await f.resume.click();await tick();
  assert.equal(f.panel.getState().phase,'suspended');assert.equal(f.send.disabled,true);assert.equal(f.model.disabled,true);assert.equal(f.resume.hidden,true);
  assert.equal(f.calls.filter(c=>c.path==='/turn').length,1);assert.equal(f.calls.filter(c=>c.path==='/resume').length,1);
});

test('a pending pre-recovery event response cannot overwrite resumed state',async t=>{
  const f=fixture(t);await f.start();await f.fail();f.state.holdNextPoll=true;await f.poll();assert.equal(typeof f.state.releasePoll,'function');
  await f.resume.click();assert.equal(f.panel.getState().phase,'complete');f.state.releasePoll();await tick();
  assert.equal(f.panel.getState().phase,'complete');assert.equal(f.send.disabled,false);assert.equal(f.model.disabled,false);
  assert.equal(f.calls.filter(c=>c.path==='/turn').length,1);
});

test('recovery catalog failure never silently changes the selected model',async t=>{
  const f=fixture(t);await f.start();await f.fail();f.state.catalogFailure=true;await f.resume.click();
  assert.equal(f.panel.getState().phase,'complete');assert.equal(f.model.value,'argon');assert.equal(f.model.disabled,true);
  assert.equal(f.calls.filter(c=>c.path==='/turn').length,1);
});

test('missing catalogue model after recovery preserves the choice and requires an explicit new selection',async t=>{
  const f=fixture(t);await f.start();await f.fail();f.catalog.models=f.catalog.models.filter(model=>model.id!=='argon');
  f.input.value='保留的新问题';await f.resume.click();
  assert.equal(f.model.value,'argon');assert.equal(f.input.value,'保留的新问题');
  await f.form.onsubmit({preventDefault(){}});assert.equal(f.calls.filter(c=>c.path==='/turn').length,1);
  f.model.value='sol';f.model.fire('change');await f.form.onsubmit({preventDefault(){}});
  const turns=f.calls.filter(c=>c.path==='/turn');assert.equal(turns.length,2);
  assert.equal(turns[1].body.model,'sol');assert.equal(turns[1].body.message,'保留的新问题');
  assert.notEqual(turns[0].body.idempotency_key,turns[1].body.idempotency_key);
});

test('local unresolved approvals also block recovery even when server metadata permits it',async t=>{
  const f=fixture(t);await f.start();await f.fail();
  f.state.history.pending=[{approval_id:'pending-fixture',request_key:f.state.history.active_request_key,status:'resolving',kind:'codex',method:'item/commandExecution/requestApproval',params:{}}];
  await f.poll();assert.equal(f.resume.hidden,false);assert.equal(f.resume.disabled,true);assert.equal(f.send.disabled,true);
  await f.resume.click();assert.equal(f.calls.filter(c=>c.path==='/resume').length,0);
});

test('restored terminal failure shows the persisted model error and authoritative recovery option',async t=>{
  const f=fixture(t,{history:{state:'suspended',active_request_key:'old-key',active_turn_id:'turn-fixture',thread_id:'thread-fixture',
    turns:[{key:'old-key',turn_id:'turn-fixture',thread_id:'thread-fixture',selected_model_id:'argon',state:'suspended',terminal_status:'failed',terminal_error:{message:'No available channel for model argon'},duration_ms:32141}],
    messages:[{role:'user',request_key:'old-key',text:'历史请求'}],
    recovery:{can_resume:true,reason:'terminal_failure',expected_turn_id:'turn-fixture'}}});
  await tick();await tick();
  assert.equal(f.panel.getState().phase,'suspended');assert.equal(f.send.disabled,true);
  assert.match(f.root.querySelector('.ic-ai-progress').textContent,/失败 · 32\.1 秒/);
  assert.match(f.root.querySelector('.ic-ai-failure-button').textContent,/模型通道不可用/);
  assert.equal(f.resume.hidden,false);assert.equal(f.resume.disabled,false);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('remount after explicit recovery retains only the latest receipt model and all failed history without resending',async t=>{
  const f=fixture(t);await f.start();await f.fail();await f.resume.click();
  assert.equal(f.state.history.active_request_key,null);assert.equal(f.state.history.active_turn_id,null);
  f.state.history.turns.unshift({key:'earlier-key',state:'suspended',terminal_status:'failed',selected_model_id:'sol',input_resumed_at_ms:1});
  const preserved=structuredClone(f.state.history.turns),postCount=f.calls.filter(c=>c.method==='POST').length;
  const reloaded=f.remount();await tick();await tick();
  assert.equal(reloaded.getState().phase,'complete');assert.equal(f.root.querySelector('select').value,'argon');
  assert.match(f.root.textContent,/只回复连接正常/);assert.equal(f.root.querySelectorAll('.ic-ai-progress').length,2);
  assert.match(f.root.querySelectorAll('.ic-ai-progress').at(-1).textContent,/失败 · 32\.1 秒/);
  assert.deepEqual(f.state.history.turns,preserved);assert.equal(f.calls.filter(c=>c.method==='POST').length,postCount);
  delete f.state.history.turns.at(-1).selected_model_id;
  f.remount();await tick();await tick();
  assert.equal(f.root.querySelector('select').value,'');assert.equal(f.calls.filter(c=>c.method==='POST').length,postCount);
});

test('assistance append is idempotent by request identity and never changes images or model settings',async t=>{
  const f=fixture(t);await until(()=>!f.model.disabled);f.input.value='Existing text';f.model.value='sol';
  const draft={request_id:'synthetic-assistance',kind:'testbench',text:'Explicit synthetic intake and revision'};
  assert.equal(f.panel.appendDraft(draft).status,'prepared');const once=f.input.value;assert(once.startsWith('Existing text\n\n────────'));
  assert.equal(f.panel.appendDraft(draft).status,'prepared');assert.equal(f.input.value,once);assert.equal(f.model.value,'sol');
  assert.throws(()=>f.panel.appendDraft({...draft,text:'Different contents'}),/请求身份/);assert.equal(f.input.value,once);assert.equal(f.calls.filter(row=>row.method==='POST').length,0);
});
