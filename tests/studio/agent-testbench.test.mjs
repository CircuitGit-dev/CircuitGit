import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEnvironmentController} from '../../modules/simulation/environment/model.js';
import {agentReviewIdentity,createAgentDraftEditor} from '../../modules/simulation/environment/agent-testbench.js';
import {agentSource,agentTestbenchFixture,testbench} from './agent-testbench.fixture.mjs';

async function setup(){const fixture=agentTestbenchFixture(),controller=createEnvironmentController({adapter:fixture.adapter});await controller.ready;await controller.importSource(agentSource);await fixture.authorDraft();fixture.setConnection({selectedIntakeId:fixture.saved.intake_id});await controller.refreshCurrent({connectionId:fixture.adapter.getState().connectionId,intakeId:fixture.saved.intake_id,sourceSha256:fixture.saved.source_sha256,revision:fixture.saved.revision});return {fixture,controller};}

test('agent mode and supplied support text survive import without choosing an inverter recipe',async()=>{
  const fixture=agentTestbenchFixture(),controller=createEnvironmentController({adapter:fixture.adapter});await controller.ready;
  const source={...agentSource,support_files:{'blocks/load.scs':'// original synthetic support text\n'}};await controller.importSource(source);
  assert.deepEqual(fixture.calls.find(call=>call.method==='inspectNetlist').args,source);assert.equal(controller.state.source.mode,'agent-tb');assert.equal(controller.state.session.agent_tb,undefined);assert.equal(fixture.calls.some(call=>call.method==='prepareExperiment'),false);
});
test('complete draft edits preserve manifest fields and revoke old review until a new saved plan is prepared',async()=>{
  const {fixture,controller}=await setup();await controller.prepareAgentTestbench();const review=agentReviewIdentity(controller.state.session);
  assert.equal(review.state,'pending');assert.equal(fixture.records.length,0);assert.equal(fixture.calls.some(call=>call.method==='runPrepared'),false);
  controller.editAgentTestbench('code',testbench.text+'// reviewed local change\n');assert.equal(controller.agentEditor.dirty,true);
  assert.throws(()=>controller.openAgentTestbenchReview({isTrusted:true}),/保存草稿/);await assert.rejects(controller.prepareAgentTestbench(),/保存/);
  await controller.saveAgentTestbench();assert.equal(controller.agentEditor.dirty,false);assert.equal(controller.state.session.agent_tb_review,null);assert.equal(controller.state.preparation.status,'idle');
  const saved=fixture.calls.filter(call=>call.method==='saveAgentTestbench').at(-1).args;assert.deepEqual(saved.testbench.interface,testbench.interface);assert.deepEqual(saved.testbench.postprocess,testbench.postprocess);
  await controller.prepareAgentTestbench();assert.notEqual(controller.state.session.agent_tb_review.draft_id,review.draft_id);
});
test('review action only opens the exact human form and never invokes runPrepared or approves itself',async()=>{
  const {fixture,controller}=await setup();await controller.prepareAgentTestbench();const review=controller.state.session.agent_tb_review;
  assert.throws(()=>controller.openAgentTestbenchReview(),/gesture/);controller.openAgentTestbenchReview({isTrusted:true});
  assert.deepEqual(fixture.calls.filter(call=>call.method==='openAgentTestbenchReview').map(call=>call.args),[{intake_id:fixture.saved.intake_id,revision:fixture.saved.revision,review_id:review.review_id,review_digest:review.review_digest,plan_id:review.plan_id}]);
  assert.equal(fixture.calls.some(call=>call.method==='runPrepared'),false);assert.equal(controller.state.session.agent_tb_review.state,'pending');
});
test('a remote draft update preserves local text but blocks saving or reviewing the wrong revision',async()=>{
  const {fixture,controller}=await setup();controller.editAgentTestbench('code',testbench.text+'// local edit\n');
  await fixture.adapter.saveAgentTestbench({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision,testbench:{...testbench,text:testbench.text+'// remote edit\n'},selection:fixture.selection});
  await controller.refreshCurrent({...controller.currentBinding,revision:fixture.saved.revision});assert.equal(controller.agentEditor.conflict,true);assert(controller.agentEditor.code.endsWith('// local edit\n'));
  await assert.rejects(controller.saveAgentTestbench(),/另一操作更新/);controller.resetAgentTestbench();assert(controller.agentEditor.code.endsWith('// remote edit\n'));
});
test('late draft-save replies after changing connection never replace the current source',async()=>{
  const {fixture,controller}=await setup();controller.editAgentTestbench('code',testbench.text+'// local edit\n');let finish;fixture.adapter.saveAgentTestbench=()=>new Promise(resolve=>finish=resolve);
  const request=controller.saveAgentTestbench();fixture.setConnection({connectionId:'another-connection'});finish({...fixture.saved,revision:fixture.saved.revision+1});await assert.rejects(request,/连接已变化/);
  assert.equal(controller.agentEditor.dirty,true);assert.equal(controller.state.session.revision,2);
});
test('editor rejects duplicate metadata, hidden text copies and cross-source review binding',async()=>{
  const {fixture}=await setup(),editor=createAgentDraftEditor();editor.observe(fixture.saved);
  editor.edit('manifest','{"schema":"ic.agent_testbench.v1","schema":"replaced"}');assert.match(editor.state.error,/重复/);
  editor.reset(fixture.saved);const meta=JSON.parse(editor.state.manifest);editor.edit('manifest',JSON.stringify({...meta,text:'another testbench'}));assert.match(editor.state.error,/代码页/);
  const controller=createEnvironmentController({adapter:fixture.adapter});await controller.ready;await controller.restoreSelected();await controller.prepareAgentTestbench();
  assert.throws(()=>agentReviewIdentity({...controller.state.session,agent_tb_review:{...controller.state.session.agent_tb_review,intake_id:'foreign'}}),/不一致/);
});
test('blocked preparation retains reasons and releases pending without inventing a human review',async()=>{
  const {fixture,controller}=await setup();fixture.adapter.prepareAgentTestbench=async()=>{
    fixture.saved={...fixture.saved,revision:fixture.saved.revision+1,state:'blocked',source_commit:null,agent_tb_review:null,
      prepared:{schema:'ic.experiment.plan.v1',state:'blocked',plan_id:null,recipe_id:'agent-testbench',missing:[{field:'selection',code:'pdk_selection_missing',message:'Choose observed models'}]}};return fixture.saved;
  };
  await controller.prepareAgentTestbench();assert.equal(controller.state.preparation.status,'complete');assert.equal(controller.state.session.prepared.state,'blocked');assert.equal(controller.state.pending.length,0);assert.equal(controller.locked,false);
  assert.throws(()=>controller.openAgentTestbenchReview({isTrusted:true}),/生成/);assert.equal(fixture.calls.some(call=>call.method==='runPrepared'),false);controller.destroy();
});
test('interrupted backend work suspends writes but permits explicit original-session readback',async()=>{
  const {fixture,controller}=await setup();fixture.saved={...fixture.saved,revision:fixture.saved.revision+1,state:'recovery_required',
    recovery:{status:'interrupted',operation:'agent-tb/prepare',operation_id:'f'.repeat(32),started_at:'2026-11-23T00:00:00Z',requires_human:true,automatic_retry:false,original_records_preserved:true}};
  await controller.refreshCurrent({...controller.currentBinding,revision:fixture.saved.revision});assert.equal(controller.locked,true);assert.equal(controller.recoveryRequired.operation,'agent-tb/prepare');
  const before=fixture.calls.length;await assert.rejects(controller.prepareAgentTestbench(),/人工恢复/);assert.equal(fixture.calls.length,before);
  await controller.refreshCurrent(controller.currentBinding);assert.equal(fixture.calls.at(-1).method,'getSession');assert.equal(controller.state.busy,null);controller.destroy();
});
