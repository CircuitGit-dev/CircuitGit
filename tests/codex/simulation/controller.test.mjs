import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSimulationController} from '../../../apps/codex/ui/simulation/controller.js';
import {createViewClient} from '../../../apps/codex/ui/simulation/view-client.js';
import {parseConfiguration,updateConfiguration,editableConfiguration,approvalInstructions,requestLabel,publicationVerified} from '../../../apps/codex/ui/simulation/domain.js';
import {createFixture,COMMIT,NEXT,HASH,clone} from './fixture.mjs';
const controller=host=>createSimulationController(host,createViewClient(host));
const setup=async options=>{const f=createFixture(options),c=controller(f.host);await c.ready();assert.equal(c.state.error,null);return {f,c};};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const row=(id='fixture-run',extra={})=>({run_id:id,source_commit:COMMIT,project_id:'fixture-project',configuration:'TRAN',state:'simulator_complete_pending_measurements',...extra});

test('initial reads use bounded view data envelope and client report only',async()=>{
  const {f,c}=await setup();assert.deepEqual(f.calls.map(x=>x.name),['ic_view_data','ic_view_data','ic_view_data','ic_view_state']);
  assert.deepEqual(f.calls.slice(0,3).map(x=>x.args.query.kind),['configuration','draft','runs']);
  assert.equal(c.state.view.revision,2);assert.equal(c.state.view.ui.mounted,null);assert.equal(c.state.text,f.draft);
  assert.equal(f.contexts.at(-1).workspace_id,f.snapshot().workspace_id);c.dispose();assert.equal(f.listeners,0);
});
test('JSON editor preserves unknown fields, duplicate keys and malformed nested types stay explicit',()=>{
  assert.equal(parseConfiguration(updateConfiguration('{"future":{"x":7},"analysis":{}}',['analysis','stop'],'20n')).future.x,7);
  assert.throws(()=>parseConfiguration('{"x":1,"x":2}'),/重复/);
  assert.throws(()=>editableConfiguration({save:'bad'}),/save/);assert.throws(()=>editableConfiguration({save:{mode:'append',signals:[null]}}),/save/);
});
test('draft persists with CAS before preview; apply remains pending until fixture human resolves',async()=>{
  const {f,c}=await setup();c.edit(['analysis','stop'],'20n');const draft=c.state.text;await c.preview();
  assert.equal(f.draft,draft);assert.equal(c.state.view.revision,4);assert.equal(c.state.review.text,draft);
  const receipt=await c.requestApply();assert.equal(receipt.state,'pending_approval');assert.equal(f.descriptor.source_commit,COMMIT);
  assert.equal(c.state.view.revision,5);assert.throws(()=>c.edit(['analysis','stop'],'30n'),/待审批/);
  await assert.rejects(c.requestApply());assert.equal(f.calls.filter(x=>x.name==='ic_view_request').length,1);
  const manual=approvalInstructions(receipt);assert.ok(manual.approve.includes(receipt.request_id)&&manual.approve.includes(receipt.fingerprint));
  f.human(receipt.request_id,'accepted',{source_commit:NEXT,push_status:'not_requested'});await c.requestStatus(receipt.request_id);
  assert.equal(c.state.view.identity.source_commit,COMMIT);assert.equal(c.state.text,draft);
  assert.equal(c.readAcceptedCommit(receipt.request_id).arguments.source_commit,NEXT);
  assert.equal(c.state.newView.arguments.workspace_id,c.state.view.workspace_id);await assert.rejects(c.plan());c.dispose();
});
test('pending request and server draft survive teardown/reopen without a new idempotency key',async()=>{
  const {f,c}=await setup();c.edit(['analysis','stop'],'18n');await c.preview();const request=await c.requestApply();c.dispose();
  const reopened=controller(f.reopenHost());await reopened.ready();assert.equal(reopened.state.error,null);
  assert.equal(reopened.state.text,f.draft);assert.equal(reopened.state.requests[0].receipt.request_id,request.request_id);
  assert.equal(reopened.state.requests[0].arguments.idempotency_key,request.arguments.idempotency_key);await assert.rejects(reopened.requestApply());
  assert.equal(f.calls.filter(x=>x.name==='ic_view_request').length,1);reopened.dispose();
});
test('plan accepts unchanged committed text; local edit invalidates plan and preview',async()=>{
  const {f,c}=await setup();await c.plan();assert.equal(c.state.view.plan_ready,true);c.edit(['analysis','stop'],'30n');assert.equal(c.state.plan,null);
  await assert.rejects(c.requestSubmit());await c.preview();c.edit(['analysis','stop'],'40n');assert.equal(c.state.review,null);await assert.rejects(c.requestApply());
  await c.discard(c.drafts()[0].key,true);assert.equal(c.dirty(),false);assert.equal(f.draft,f.descriptor.configuration_text);await c.reload();assert.equal(c.dirty(),false);
  await c.plan();const receipt=await c.requestSubmit();assert.equal(receipt.state,'pending_approval');assert.equal(receipt.arguments.source_commit,COMMIT);
  assert.match(requestLabel({...receipt,state:'accepted'}),/不代表/);c.dispose();
});
test('timeout preserves unknown attempt and blocks replay across reload',async()=>{
  const {f,c}=await setup();await c.plan();f.faults.set('ic_view_request',()=>{throw Error('transport outcome unknown');});
  await assert.rejects(c.requestSubmit(),/unknown/);const key=c.state.requests[0].arguments.idempotency_key;
  await c.reload();assert.equal(c.state.suspended,true);await assert.rejects(c.plan());await assert.rejects(c.requestSubmit());
  assert.equal(c.state.requests[0].arguments.idempotency_key,key);assert.equal(f.calls.filter(x=>x.name==='ic_view_request').length,1);c.dispose();
});
test('lost response after persistence recovers by owned receipt read, never replay',async()=>{
  const {f,c}=await setup();await c.plan();f.faults.set('ic_view_request',async(_,next)=>{await next();throw Error('lost response');});
  await assert.rejects(c.requestSubmit());await c.reload();assert.equal(c.state.requests.length,1);assert.equal(c.state.requests[0].receipt.state,'pending_approval');
  assert.equal(c.state.requests[0].unresolved,false);assert.equal(f.calls.filter(x=>x.name==='ic_view_request').length,1);c.dispose();
});
test('CAS conflicts and permission failures stop dependencies and preserve local text',async()=>{
  const {f,c}=await setup();c.edit(['analysis','stop'],'22n');const text=c.state.text;f.updateView();await assert.rejects(c.preview(),/stale/);
  assert.equal(c.state.text,text);assert.equal(c.state.suspended,true);assert.equal(f.calls.filter(x=>x.name==='ic_view_plan').length,0);
  await c.reload();f.faults.set('ic_view_draft',()=>{throw Error('permission denied');});await assert.rejects(c.storeDraft(),/permission/);assert.equal(c.state.suspended,true);c.dispose();
});
test('view data cannot be confused with payload; identity key order is immaterial',async()=>{
  const {f,c}=await setup(),v=createViewClient(f.host),same=clone(c.state.view);same.identity=Object.fromEntries(Object.entries(same.identity).reverse());assert.doesNotThrow(()=>v.same(c.state.view,same));
  f.faults.set('ic_view_data:configuration',async(_,next)=>(await next()).payload);await assert.rejects(c.reload());assert.equal(c.state.suspended,true);c.dispose();
});
test('wrong receipt fingerprint or arguments suspends without adopting foreign request',async()=>{
  const {f,c}=await setup();await c.plan();const receipt=await c.requestSubmit();
  f.faults.set('ic_view_data:request',async(_,next)=>{const r=await next();r.payload.arguments.source_commit=NEXT;return r;});
  await assert.rejects(c.requestStatus(receipt.request_id),/参数/);assert.equal(c.state.requests[0].receipt.arguments.source_commit,COMMIT);assert.equal(c.state.suspended,true);c.dispose();
});
test('same-view hide/reload retains local unsaved text; windows, foreign and stale notifications isolate',async()=>{
  const {f,c}=await setup(),other=await setup({viewDigit:'2'});c.edit(['analysis','stop'],'25n');const text=c.state.text;
  f.notify(f.updateView({visible:false}));await c.ready();assert.equal(c.state.text,text);assert.equal(other.c.state.text,other.f.draft);
  assert.equal(await c.acceptResult(other.f.snapshot()),false);assert.equal(await c.acceptResult(f.host.initial),false);
  const bad=f.updateView();bad.identity.source_commit=NEXT;await assert.rejects(c.acceptResult(bad),/工程身份/);assert.equal(c.state.text,text);assert.equal(c.state.suspended,true);
  c.dispose();other.c.dispose();
});
test('late read after newer notification or disposal never overwrites current state',async()=>{
  const {f,c}=await setup(),wait=deferred();let first=true;
  f.faults.set('ic_view_data:configuration',async(_,next)=>{const reply=await next();if(first){first=false;await wait.promise;}return reply;});
  const loading=c.reload();await new Promise(r=>setTimeout(r,0));f.notify(f.updateView({visible:false}));await c.ready();const revision=c.state.view.revision;
  wait.resolve();await loading;assert.equal(c.state.view.revision,revision);assert.equal(c.state.view.visible,false);
  c.dispose();f.notify(f.updateView());assert.equal(c.state.view.revision,revision);
});
test('source drift still exposes already-owned approval receipt',async()=>{
  const {f,c}=await setup();c.edit(['analysis','stop'],'20n');await c.preview();const receipt=await c.requestApply();f.human(receipt.request_id,'accepted',{source_commit:NEXT});
  f.faults.set('ic_view_data:configuration',()=>{throw Error('source changed');});await assert.rejects(c.reload());
  assert.equal(c.state.requests[0].receipt.state,'accepted');assert.equal(c.readAcceptedCommit(receipt.request_id).arguments.source_commit,NEXT);c.dispose();
});
test('local run selection never binds; explicit historical reopen arguments retain source and workspace',async()=>{
  const {f,c}=await setup({jobs:[row()]});await c.chooseRun('fixture-run');assert.equal(c.state.view.identity.run_id,null);assert.equal(c.runPolicy().collect,false);
  await assert.rejects(c.requestCollect());const args=c.showRunWindow('fixture-run').arguments;assert.equal(args.run_id,'fixture-run');assert.equal(args.workspace_id,c.state.view.workspace_id);
  assert.equal(f.calls.filter(x=>x.name==='ic_view_bind_run').length,0);c.dispose();
});
test('bind accepted owned submit with exact CAS request id, then read bound results and request collect',async()=>{
  const {f,c}=await setup();await c.plan();const receipt=await c.requestSubmit();await assert.rejects(c.bindAcceptedRun(receipt.request_id));
  f.human(receipt.request_id,'accepted',{run_id:'fixture-run',source_commit:COMMIT});f.updateRows([row()]);await c.requestStatus(receipt.request_id);
  await c.bindAcceptedRun(receipt.request_id);assert.equal(c.state.view.identity.run_id,'fixture-run');assert.equal(c.state.selectedRun,'fixture-run');
  const bind=f.calls.find(x=>x.name==='ic_view_bind_run');assert.deepEqual(Object.keys(bind.args).sort(),['expected_revision','request_id','view_id','workspace_id']);
  await c.results();const collect=await c.requestCollect();assert.equal(collect.arguments.run_id,'fixture-run');assert.equal(collect.state,'pending_approval');c.dispose();
});
test('unexpected run changes require own accepted receipt; a legitimate external bind can be reloaded',async()=>{
  const {f,c}=await setup();const bad=f.updateView({identity:{...f.snapshot().identity,run_id:'foreign'}});await assert.rejects(c.acceptResult(bad),/提交回执/);c.dispose();
  const next=await setup();await next.c.plan();const r=await next.c.requestSubmit();next.f.human(r.request_id,'accepted',{run_id:'fixture-run'});next.f.updateRows([row()]);
  next.f.notify(next.f.updateView({identity:{...next.f.snapshot().identity,run_id:'fixture-run'}}));await next.c.ready();assert.equal(next.c.state.error,null);assert.equal(next.c.state.view.identity.run_id,'fixture-run');next.c.dispose();
});
test('historical view skips unavailable configuration/draft and can request archive from complete collection',async()=>{
  const collection={contains_full_raw:true,sha256:HASH,bytes:123};const {f,c}=await setup({historical:true,run:'fixture-run',jobs:[row('fixture-run',{state:'collected',collection})]});
  assert.equal(c.state.configurationUnavailable,true);assert.equal(c.state.descriptor,null);assert.equal(f.calls.some(x=>['draft','configuration'].includes(x.args.query?.kind)),false);
  await assert.rejects(c.plan());await c.results();assert.equal(c.runPolicy().archive,true);const archive=await c.requestArchive();assert.equal(archive.state,'pending_approval');c.dispose();
});
test('saved real archive projection is read-only with verified hashes and no collect/archive replay',async()=>{
  const jobs=JSON.parse(await readFile(new URL('../../studio/fixtures/jobs.json',import.meta.url),'utf8')).data.jobs;
  const run=jobs[0],id=run.run_id||run.job_id;
  const {f,c}=await setup({jobs,run:id,historical:true,source:run.source_commit,project:run.associated_project_id||run.project_id,configuration:run.configuration});
  await c.results();assert.equal(publicationVerified(run,run.publication,run.collection),true);assert.equal(c.runPolicy().archive,false);await assert.rejects(c.requestArchive());await assert.rejects(c.requestCollect());
  assert.equal(f.calls.filter(x=>x.name==='ic_view_request').length,0);assert.equal(c.state.results.get(id).collection.sha256,run.collection.sha256);c.dispose();
});

test('accepted collect awaits full saved collection before archive becomes eligible',async()=>{
  const {f,c}=await setup({run:'fixture-run',jobs:[row()]});const collect=await c.requestCollect();f.human(collect.request_id,'accepted',{run_id:'fixture-run'});await c.requestStatus(collect.request_id);
  assert.equal(c.runPolicy().archive,false);f.updateRows([row('fixture-run',{state:'collected',collection:{contains_full_raw:true,bytes:100,sha256:HASH}})]);await c.refreshJobs();await c.results();
  assert.equal(c.runPolicy().archive,true);const archive=await c.requestArchive();assert.equal(archive.operation,'sim_archive');assert.equal(archive.state,'pending_approval');c.dispose();
});

test('same-revision receipt notification refreshes live approval state without replay',async()=>{
  const {f,c}=await setup();await c.plan();const receipt=await c.requestSubmit();const revision=c.state.view.revision;
  f.human(receipt.request_id,'denied');f.notify(f.snapshot());await c.ready();assert.equal(c.state.requests[0].receipt.state,'denied');assert.equal(c.state.view.revision,revision);
  assert.equal(f.calls.filter(x=>x.name==='ic_view_request').length,1);c.dispose();
});

test('review button path sends only frozen hashes; fake host cancellation never retries',async()=>{
  const {f,c}=await setup();await c.plan();const receipt=await c.requestSubmit();
  assert.equal(f.calls.filter(x=>x.name==='ic_request_review').length,0);
  await c.requestReview(receipt.request_id);
  assert.deepEqual(f.calls.find(x=>x.name==='ic_request_review').args,{request_id:receipt.request_id,fingerprint:receipt.fingerprint});
  assert.equal(c.inspectRequest(receipt.request_id).receipt.state,'pending_approval');assert.match(c.state.notice,/取消/);
  f.notify(f.snapshot());await c.ready();await c.requestStatus(receipt.request_id);
  assert.equal(f.calls.filter(x=>x.name==='ic_request_review').length,1);
  assert.equal(f.calls.filter(x=>x.name==='ic_view_request').length,1);c.dispose();
});

test('synthetic host approval/denial adopts the persisted receipt without a second prepare',async()=>{
  for(const [review_status,state] of [['approved','accepted'],['denied','denied']]){
    const {f,c}=await setup();await c.plan();const receipt=await c.requestSubmit();
    f.faults.set('ic_request_review',()=>{
      f.human(receipt.request_id,state,state==='accepted'?{run_id:'SYNTHETIC-host-run'}:undefined);
      return {request:clone(f.receipts.get(receipt.request_id)),review_status,automatic_retry:false};
    });
    await c.requestReview(receipt.request_id);assert.equal(c.inspectRequest(receipt.request_id).receipt.state,state);
    assert.equal(c.state.view.identity.run_id,null);await assert.rejects(c.requestReview(receipt.request_id));
    assert.equal(f.calls.filter(x=>x.name==='ic_view_request').length,1);
    assert.equal(f.calls.filter(x=>x.name==='ic_request_review').length,1);c.dispose();
  }
});

test('unsupported timeout unchecked and rejected host reviews preserve the same request',async()=>{
  for(const status of ['unsupported','timeout','not_approved','host_rejected','invalid_response']){
    const {f,c}=await setup();await c.plan();const receipt=await c.requestSubmit();
    f.faults.set('ic_request_review',()=>({request:clone(receipt),review_status:status,automatic_retry:false}));
    await c.requestReview(receipt.request_id);
    assert.equal(c.inspectRequest(receipt.request_id).receipt.state,'pending_approval');
    assert.equal(c.inspectRequest(receipt.request_id).arguments.idempotency_key,receipt.arguments.idempotency_key);
    assert.equal(c.state.suspended,['host_rejected','invalid_response'].includes(status));
    assert.equal(f.calls.filter(x=>x.name==='ic_request_review').length,1);c.dispose();
  }
});

test('wrong review response hash or tool error suspends and preserves original receipt',async()=>{
  for(const fault of [receipt=>({request:{...clone(receipt),fingerprint:'e'.repeat(64)},review_status:'approved',automatic_retry:false}),
                      ()=>{throw Error('SYNTHETIC host transport timeout');}]){
    const {f,c}=await setup();await c.plan();const receipt=await c.requestSubmit();
    f.faults.set('ic_request_review',()=>fault(receipt));await assert.rejects(c.requestReview(receipt.request_id));
    assert.equal(c.state.suspended,true);assert.equal(c.inspectRequest(receipt.request_id).receipt.fingerprint,receipt.fingerprint);
    assert.equal(c.inspectRequest(receipt.request_id).receipt.state,'pending_approval');
    assert.equal(f.calls.filter(x=>x.name==='ic_request_review').length,1);c.dispose();
  }
});

test('duplicate clicks and late review reply cannot overwrite a newer notification',async()=>{
  const {f,c}=await setup();await c.plan();const receipt=await c.requestSubmit(),wait=deferred(),started=deferred();
  f.faults.set('ic_request_review',async()=>{started.resolve();await wait.promise;return {request:clone(receipt),review_status:'cancelled',automatic_retry:false};});
  const reviewing=c.requestReview(receipt.request_id);await started.promise;
  await assert.rejects(c.requestReview(receipt.request_id),/操作进行中/);
  f.human(receipt.request_id,'denied');f.notify(f.updateView({visible:false}));await c.ready();
  const revision=c.state.view.revision;wait.resolve();await reviewing;
  assert.equal(c.state.view.revision,revision);assert.equal(c.state.view.visible,false);
  assert.equal(c.inspectRequest(receipt.request_id).receipt.state,'denied');
  assert.equal(f.calls.filter(x=>x.name==='ic_request_review').length,1);c.dispose();
});

test('a disposed component does not adopt a late synthetic host response',async()=>{
  const {f,c}=await setup();await c.plan();const receipt=await c.requestSubmit(),wait=deferred(),started=deferred();
  f.faults.set('ic_request_review',async()=>{started.resolve();await wait.promise;return {request:clone(receipt),review_status:'cancelled',automatic_retry:false};});
  const reviewing=c.requestReview(receipt.request_id);await started.promise;c.dispose();const count=f.calls.length;
  wait.resolve();await reviewing;assert.equal(f.calls.length,count);assert.equal(f.listeners,0);
});
