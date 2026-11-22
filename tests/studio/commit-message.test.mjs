import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommitMessage} from '../../modules/workspace/commit-message.js';
const identity={project_id:'demo',base_commit:'a'.repeat(40),review_id:'b'.repeat(64)};
const tick=()=>new Promise(r=>setImmediate(r));
function setup(t){const pending=[];const draft=createCommitMessage({gateway:{request(path,options){return new Promise((resolve,reject)=>pending.push({path,options,resolve,reject}));}}});t.after(()=>draft.destroy());return {draft,pending};}
const complete=(extra={})=>({...identity,summary_id:'summary-fixture',state:'complete',title:'调整输入电阻',body:'将输入电阻从1k改为2k。',model:'fixture',...extra});
test('one frozen review starts one draft and never commits',async t=>{
 const {draft,pending}=setup(t),work=draft.prepare(identity);assert.equal(pending.length,1);assert.equal(pending[0].path,'/changes/summary');assert.deepEqual(pending[0].options.body,identity);
 pending[0].resolve(complete());await work;assert.equal(draft.message(),'调整输入电阻\n\n将输入电阻从1k改为2k。');await draft.prepare(identity);assert.equal(pending.length,1);
});
test('agent completion does not overwrite manually edited title or body',async t=>{
 const {draft,pending}=setup(t),work=draft.prepare(identity);draft.setTitle('我的标题');draft.setBody('我的说明');pending[0].resolve(complete());await work;
 assert.equal(draft.message(),'我的标题\n\n我的说明');
});
test('a stale response cannot fill a new or invalidated review',async t=>{
 const {draft,pending}=setup(t),work=draft.prepare(identity);draft.invalidate();pending[0].resolve(complete());await work;
 assert.equal(draft.getState().status,'idle');assert.equal(draft.getState().title,'');
});
test('failure stays explicit and a manual message can still be reviewed',async t=>{
 const {draft,pending}=setup(t),work=draft.prepare(identity);pending[0].resolve(complete({state:'failed',error:{message:'Provider unavailable'}}));await work;
 assert.equal(draft.getState().status,'failed');assert.throws(()=>draft.message());draft.setTitle('人工确认的电路更新');assert.equal(draft.message(),'人工确认的电路更新');assert.equal(pending.length,1);
});
test('identity mismatch and oversize output are rejected instead of silently accepted',async t=>{
 for(const response of [complete({review_id:'c'.repeat(64)}),complete({title:'x'.repeat(81)}),complete({body:'x'.repeat(300)})]){
  const {draft,pending}=setup(t),work=draft.prepare(identity);pending[0].resolve(response);await work;assert.equal(draft.getState().status,'failed');assert.equal(draft.getState().title,'');
 }
});
test('configuration switch can reset manually edited text without reusing its old summary',async t=>{
 const {draft,pending}=setup(t);draft.setTitle('旧配置标题');const work=draft.prepare(identity);draft.reset();pending[0].resolve(complete());await work;assert.equal(draft.getState().title,'');assert.equal(draft.getState().identity,null);
});
test('running summaries poll their original receipt without another POST',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {draft,pending}=setup(t),work=draft.prepare(identity);pending[0].resolve(complete({state:'running'}));await work;
 t.mock.timers.tick(1200);assert.equal(pending[1].path,'/changes/summary?summary_id=summary-fixture');assert.equal(pending[1].options,undefined);
 draft.setTitle('轮询期间手写标题');pending[1].resolve(complete());await tick();assert.equal(draft.getState().status,'complete');assert.equal(draft.getState().title,'轮询期间手写标题');assert.equal(pending.length,2);
});
