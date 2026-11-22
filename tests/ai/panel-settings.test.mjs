import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAI} from '../../apps/web/ai/ai-panel.js';
import {imageDocument,PNG,tick,until} from './fixtures/image-dom.mjs';

function fixture(t,{models,history:initialHistory}={}){
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const document=imageDocument(),previous=globalThis.Option;globalThis.Option=document.Option;t.after(()=>{globalThis.Option=previous;});
  const root=document.createElement('section');document.body.append(root);
  const context={version:1,revision:1,mode:'live',project:{id:'fixture'},file:{dirty:false,currentTextSha256:'hash',persistedSha256:'hash'}};
  const catalog={default_model:'capable',models:models||[
    {id:'capable',model:'capable',displayName:'Capable fixture',inputModalities:['text','image'],defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Fast'},{reasoningEffort:'medium'},{reasoningEffort:'high'},{reasoningEffort:'future-effort'}]},
    {id:'limited',model:'limited',displayName:'Limited fixture',inputModalities:['text','image'],defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]},
  ]};
  const sessionId='settings-fixture',turnId='turn-fixture',unavailable={can_resume:false,reason:'not_terminal',expected_turn_id:null};
  const state={history:{session_id:sessionId,state:'idle',messages:[],turns:[],pending:[],cursor:0,recovery:unavailable,...initialHistory},events:[],mode:'normal'},calls=[];
  async function read(path){calls.push({method:'GET',path});const url=new URL(path,'https://fixture.invalid');assert.equal(url.searchParams.get('session_id'),sessionId);
    if(url.pathname==='/models')return structuredClone(catalog);
    if(url.pathname==='/development')return {available:false,workspace:null,reason:'Fixture not configured'};
    if(url.pathname==='/history')return structuredClone(state.history);
    if(url.pathname==='/events')return {events:structuredClone(state.events),cursor:state.history.cursor,state:state.history.state,recovery:state.history.recovery,pending:structuredClone(state.history.pending)};
    assert.fail('Unexpected fixture GET '+path);
  }
  async function post(path,body){calls.push({method:'POST',path,body:structuredClone(body)});assert.equal(body.session_id,sessionId);
    if(path==='/resume'){assert.equal(state.history.recovery.can_resume,true);state.history.turns.at(-1).input_resumed_at_ms=Date.now();Object.assign(state.history,{state:'complete',active_request_key:null,active_turn_id:null,recovery:unavailable});return {session_id:sessionId,state:'complete',resumed:true,automatic_retry:false,history_retained:true};}
    assert.equal(path,'/turn');if(state.mode==='unknown')throw Error('Synthetic lost response');
    const receipt={key:body.idempotency_key,state:'running',thread_id:'thread-fixture',turn_id:turnId,selected_model_id:body.model||'',reasoning_effort:body.reasoning_effort??null,permission_mode:body.permission_mode||'manual'};
    state.history.turns.push(receipt);state.history.messages.push({role:'user',request_key:receipt.key,text:body.message});Object.assign(state.history,{state:'running',active_request_key:receipt.key,active_turn_id:turnId});return receipt;
  }
  const options={presentation:'clean',sessionId,contextAdapter:{getContext:()=>context,subscribe:()=>()=>{}},getRequest:read,postRequest:post};
  let panel=mountAI(root,options);panel.setVisible(true);t.after(()=>panel.destroy());
  const controls=()=>({model:root.querySelector('.ic-ai-model'),effort:root.querySelector('.ic-ai-effort'),permission:root.querySelector('.ic-ai-permission'),settings:root.querySelector('.ic-ai-settings-button'),box:root.querySelector('.ic-ai-settings'),note:root.querySelector('.ic-ai-settings-note'),input:root.querySelector('textarea'),form:root.querySelector('form'),send:root.querySelectorAll('button').find(b=>b.type==='submit')});
  const choose=(select,value)=>{select.value=value;select.fire('change');};
  const submit=()=>controls().form.onsubmit({preventDefault(){}});
  const ready=()=>until(()=>!controls().model.disabled);
  const poll=async()=>{t.mock.timers.tick(1200);await tick();await tick();};
  const remount=()=>{panel.destroy();panel=mountAI(root,options);panel.setVisible(true);return panel;};
  async function fail(){const receipt=state.history.turns.at(-1),error={message:'No available channel for model capable'};Object.assign(receipt,{state:'suspended',terminal_status:'failed',terminal_error:error,duration_ms:1000});state.events.push({sequence:++state.history.cursor,request_key:receipt.key,method:'turn/completed',params:{turn:{id:turnId,status:'failed',durationMs:1000,error}}});state.history.state='suspended';state.history.recovery={can_resume:true,reason:'terminal_failure',expected_turn_id:turnId};await poll();}
  return {document,root,panel,state,calls,catalog,controls,choose,submit,ready,poll,remount,fail};
}

test('legacy catalogs retain inherited reasoning and the unchanged default request fields',async t=>{
  const f=fixture(t,{models:[{id:'capable',displayName:'Legacy'}]});await f.ready();const c=f.controls();
  assert.equal(c.box.hidden,true);assert.deepEqual(c.effort.children.map(o=>o.value),['']);assert.equal(c.permission.value,'manual');
  assert.match(c.settings.title,/沿用会话 · 人工批准/);c.input.value='legacy';await f.submit();
  assert.deepEqual(Object.keys(f.calls.find(c=>c.path==='/turn').body).sort(),['context','idempotency_key','message','session_id']);
});

test('catalog-driven efforts and explicit permissions are sent exactly and locked for active turns',async t=>{
  const f=fixture(t);await f.ready();const c=f.controls();await c.settings.click();assert.equal(c.box.hidden,false);
  assert.deepEqual(c.effort.children.map(o=>o.value),['','model_default','low','medium','high','future-effort']);
  assert.equal(c.effort.children.find(o=>o.value==='future-effort').textContent,'future-effort');assert.equal(c.effort.children.find(o=>o.value==='high').title,'high');
  f.choose(c.effort,'high');f.choose(c.permission,'read_only');assert.match(c.settings.title,/高 · 只读/);assert.match(c.note.textContent,/查看电路和已有结果/);
  c.input.value='inspect';await f.submit();const sent=f.calls.find(c=>c.path==='/turn').body;assert.equal(sent.reasoning_effort,'high');assert.equal(sent.permission_mode,'read_only');
  assert.equal(c.effort.disabled,true);assert.equal(c.permission.disabled,true);assert.equal(c.model.disabled,true);
  f.choose(c.effort,'low');f.choose(c.permission,'manual');assert.equal(c.effort.value,'high');assert.equal(c.permission.value,'read_only');
});

test('model default remains an explicit choice instead of being rewritten to an effort value',async t=>{
  const f=fixture(t);await f.ready();const c=f.controls();f.choose(c.effort,'model_default');c.input.value='default';await f.submit();
  assert.equal(f.calls.find(c=>c.path==='/turn').body.reasoning_effort,'model_default');
});

test('unsupported model switch keeps effort and draft until the user explicitly reselects',async t=>{
  const f=fixture(t);await f.ready();const c=f.controls();f.choose(c.effort,'high');c.input.value='keep draft';
  const file=f.root.querySelector('input');file.files=[new File([PNG],'draft.png',{type:'image/png'})];file.fire('change');await until(()=>f.root.querySelector('.ic-ai-image-preview'));
  f.choose(c.model,'limited');assert.equal(c.effort.value,'high');assert.equal(c.box.hidden,false);assert.equal(c.send.disabled,true);assert.match(c.note.textContent,/不支持当前思考强度/);
  await f.submit();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(c.input.value,'keep draft');assert.equal(f.root.querySelectorAll('.ic-ai-image-preview').length,1);
  f.choose(c.effort,'low');assert.equal(c.send.disabled,false);assert.equal(c.effort.value,'low');
});

test('sending rechecks supported reasoning without clearing the draft or downgrading a stale choice',async t=>{
  const f=fixture(t);await f.ready();const c=f.controls();f.choose(c.effort,'high');c.input.value='preserve';
  f.catalog.models[0].supportedReasoningEfforts=[{reasoningEffort:'low'}];await f.submit();
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(c.effort.value,'high');assert.equal(c.input.value,'preserve');assert.match(f.root.textContent,/不支持当前思考强度/);
});

test('failure, explicit recovery, hide, and reload retain settings without resending or upgrading permissions',async t=>{
  const f=fixture(t);await f.ready();let c=f.controls();f.choose(c.effort,'high');f.choose(c.permission,'read_only');c.input.value='inspect';await f.submit();await f.fail();
  assert.equal(c.effort.disabled,true);assert.equal(c.permission.disabled,true);await f.root.querySelector('.ic-ai-resume').click();
  f.panel.setVisible(false);f.panel.setVisible(true);assert.equal(c.effort.value,'high');assert.equal(c.permission.value,'read_only');
  f.remount();await f.ready();c=f.controls();assert.equal(c.effort.value,'high');assert.equal(c.permission.value,'read_only');assert.match(c.settings.title,/高 · 只读/);
  assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(c=>c.path),['/turn','/resume']);
  f.choose(c.permission,'manual');f.choose(c.effort,'');c.input.value='new approved work';await f.submit();const last=f.calls.filter(c=>c.path==='/turn').at(-1).body;
  assert.equal(last.permission_mode,'manual');assert.equal(Object.hasOwn(last,'reasoning_effort'),false);
});

test('unknown submission keeps settings locked',async t=>{
  const f=fixture(t);await f.ready();const c=f.controls();f.choose(c.effort,'low');f.choose(c.permission,'read_only');f.state.mode='unknown';c.input.value='unknown';await f.submit();
  assert.equal(c.effort.disabled,true);assert.equal(c.permission.disabled,true);f.choose(c.permission,'manual');assert.equal(c.permission.value,'read_only');
  assert.equal(f.calls.filter(c=>c.path==='/turn').length,1);
});

test('resolved-history pending approval locks all settings even when the session state is complete',async t=>{
  const f=fixture(t);await f.ready();const c=f.controls();f.state.history.state='complete';f.state.history.pending=[{approval_id:'approval',status:'resolving'}];await f.poll();
  assert.equal(c.effort.disabled,true);assert.equal(c.permission.disabled,true);assert.equal(c.model.disabled,true);assert.equal(c.send.disabled,true);
});
