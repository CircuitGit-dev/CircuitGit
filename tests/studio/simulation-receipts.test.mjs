import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createController} from '../../apps/web/studio/simulation/model.js';
import {createReceiptActions,receiptPolicy,safeReceiptLink} from '../../apps/web/studio/simulation/receipts.js';
const C='a'.repeat(40),N='b'.repeat(40),H='c'.repeat(64);
const collection={contains_full_raw:true,sha256:H,bytes:123};
const publication={status:'published',source_commit:C,full_archive_sha256:H,archive_commit:N,release_id:1,verified_at:'2026-11-10T00:00:00Z',release_url:'https://github.com/example/private/releases/tag/sim-r',assets:[{verified:true,sha256:H}]};
function fixture(){
  let runs=[{run_id:'r',source_commit:C,state:'simulator_complete_pending_measurements',collection:null,publication:null}];
  let results={job_id:'r',state:'not_collected',collection:null,publication:null};
  let registry={activeProjectId:'p',source_commit:C,capabilities:{git:true,runner:true,publish:true},projects:[{id:'p',configurations:[{id:'c'}]}]};
  let context={project:{id:'p',sourceCommit:C},loadState:'ready',file:{dirty:false},run:{runId:'r'}};
  const callbacks=new Set(),calls=[];let config='{"parameters":{}}',pushResult='not_requested';
  const host={version:1,context:{getContext:()=>context,subscribe(fn){callbacks.add(fn);return()=>callbacks.delete(fn);}},getProject:()=>registry,getRuns:()=>runs,slots:{simulation:{setBadge(){}}},notify(){},selectRun:async()=>{},refresh:async()=>{calls.push('local-list');callbacks.forEach(fn=>fn());},gateway:{
    request:async()=>({schema:'ic.sim.configuration-description.v1',project_id:'p',configuration:'c',source_commit:registry.source_commit,configuration_path:'projects/p/c.json',configuration_sha256:H,configuration_text:config,effective:{compiled_inputs_sha256:H}}),
    preview:async()=>({base_commit:C,review_id:'test',configuration_previews:[{project_id:'p',configuration:'c',effective:{compiled_inputs_sha256:H}}]}),
    save:async body=>{calls.push({save:body});config=body.changes[0].content;registry={...registry,source_commit:N};context={...context,project:{id:'p',sourceCommit:N}};return {source_commit:N,push_status:pushResult};},
    results:async id=>{calls.push('local-results:'+id);return structuredClone(results);},
    collect:async id=>{calls.push('collect:'+id);runs=[{...runs[0],state:'collecting'}];return {...runs[0]};},
    archive:async id=>{calls.push('archive:'+id);runs=[{...runs[0],state:'archiving'}];return {...runs[0]};},
    job:async()=>{throw Error('single-run status must never be called');}
  }};
  return {host,calls,setRuns(x){runs=x;},setResults(x){results=x;},pushResult(x){pushResult=x;},get run(){return runs[0];},get results(){return results;},context(x){context={...context,...x};callbacks.forEach(fn=>fn());}};
}
test('config push defaults false and faithfully records not_requested',async()=>{
  const f=fixture(),c=createController(f.host);await c.ready();c.edit(['parameters','N'],32);await c.preview();await c.commit();
  assert.equal(f.calls.find(x=>x.save).save.push,false);assert.equal(c.state.saveReceipt.pushStatus,'not_requested');assert.equal(c.state.saveReceipt.sourceCommit,N);c.destroy();
});
test('explicit push choice reaches existing save endpoint and shows confirmed',async()=>{
  const f=fixture();f.pushResult('confirmed');const c=createController(f.host);await c.ready();c.edit(['parameters','N'],32);await c.preview();c.setPushAfterSave(true);await c.commit();
  assert.equal(f.calls.find(x=>x.save).save.push,true);assert.equal(c.state.saveReceipt.pushStatus,'confirmed');assert.equal(c.state.pushAfterSave,false);c.destroy();
});
test('unexpected push status preserved and blocks dependencies/retry through reload',async()=>{
  const f=fixture();f.pushResult('failed');const c=createController(f.host);await c.ready();c.edit(['parameters','N'],32);await c.preview();c.setPushAfterSave(true);await assert.rejects(c.commit(),/push_status/);
  assert.equal(c.state.saveReceipt.pushStatus,'failed');await c.reload();assert.equal(c.state.suspended,true);await assert.rejects(c.commit());assert.equal(f.calls.filter(x=>x.save).length,1);c.destroy();
});
test('save network/approval failure has unknown commit outcome and no replay',async()=>{
  const f=fixture();let saves=0;f.host.gateway.save=async()=>{saves++;throw Error('denied or lost response');};const c=createController(f.host);await c.ready();c.edit(['parameters','N'],32);await c.preview();await assert.rejects(c.commit());await c.reload();await assert.rejects(c.plan());assert.equal(saves,1);assert.equal(c.state.saveAttempt.status,'unknown');c.destroy();
});
test('collect accepted stays pending until local result/list completion, then archive becomes eligible',async()=>{
  const f=fixture(),a=createReceiptActions(f.host);await a.collect('r');assert.equal(a.get('r').attempt.status,'accepted');assert.equal(a.policy('r').archive,false);assert.equal(a.policy('r').collect,false);
  await assert.rejects(a.collect('r'));f.setRuns([{...f.run,state:'collected',collection}]);f.setResults({...f.results,state:'collected',collection});await a.inspect('r');assert.equal(a.get('r').attempt.status,'completed');assert.equal(a.policy('r').archive,true);assert.equal(f.calls.filter(x=>x==='collect:r').length,1);a.destroy();
});
test('archive accepted does not imply published; only verified stored publication completes',async()=>{
  const f=fixture();f.setRuns([{...f.run,state:'collected',collection}]);f.setResults({...f.results,state:'collected',collection});const a=createReceiptActions(f.host);await a.archive('r');assert.equal(a.get('r').attempt.status,'accepted');assert.equal(a.policy('r').verified,undefined);
  f.setRuns([{...f.run,state:'archived',publication}]);f.setResults({...f.results,publication});await a.inspect('r');assert.equal(a.get('r').attempt.status,'completed');assert.equal(a.policy('r').verified,true);assert.equal(a.policy('r').archive,false);await assert.rejects(a.archive('r'));a.destroy();
});
test('archived runs allow local receipt only, no collect/archive and no single-run status',async()=>{
  const f=fixture();f.setRuns([{...f.run,state:'archived',collection,publication}]);f.setResults({...f.results,state:'collected',collection,publication});const a=createReceiptActions(f.host);await a.inspect('r');await assert.rejects(a.collect('r'));await assert.rejects(a.archive('r'));assert.deepEqual(f.calls,['local-list','local-results:r']);a.destroy();
});
test('partial publication/full-raw missing/active/unknown/error states block archive or collect',()=>{
  const f=fixture();
  for(const state of ['running_observed','queued','preflight','submitted','reconcile_required','unknown'])assert.equal(receiptPolicy({...f.run,state}).collect,false);
  assert.equal(receiptPolicy({...f.run,state:'collected',collection:{...collection,contains_full_raw:false}}).archive,false);
  assert.equal(receiptPolicy({...f.run,state:'collected',collection,publication:{status:'index_pushed'}}).archive,false);
  assert.equal(receiptPolicy({...f.run,operation_error:'failure'}).collect,false);
});
test('unknown POST outcome and subsequent local stale evidence never retry',async()=>{
  const f=fixture();let count=0;f.host.gateway.collect=async()=>{count++;throw Error('timeout unknown');};const a=createReceiptActions(f.host);await assert.rejects(a.collect('r'));await a.inspect('r');assert.equal(a.get('r').attempt.status,'unknown');await assert.rejects(a.collect('r'));assert.equal(count,1);a.destroy();
});
test('concurrent/double POST is rejected and no automatic polling timer',async()=>{
  const f=fixture();let resolve;f.host.gateway.collect=()=>new Promise(r=>resolve=r);const a=createReceiptActions(f.host);const first=a.collect('r');await assert.rejects(a.collect('r'));resolve(f.run);await first;assert.equal(a.get('r').attempt.status,'accepted');const calls=f.calls.length;await new Promise(r=>setTimeout(r,15));assert.equal(f.calls.length,calls);a.destroy();
});
test('wrong run/source/hash or falsely verified response fails closed',async()=>{
  for(const result of [{job_id:'other',state:'collected'},{job_id:'r',state:'collected',collection,publication:{...publication,source_commit:N}},{job_id:'r',state:'collected',collection,publication:{...publication,full_archive_sha256:'d'.repeat(64)}},{job_id:'r',state:'collected',collection,publication:{...publication,assets:[]}}]){
    const f=fixture();f.setResults(result);const a=createReceiptActions(f.host);await assert.rejects(a.inspect('r'));assert.equal(a.policy('r').collect,false);a.destroy();
  }
});
test('late async result stays attached to original run rather than newly selected context',async()=>{
  const f=fixture();let resolve;f.host.gateway.results=()=>new Promise(r=>resolve=r);const a=createReceiptActions(f.host);const pending=a.inspect('r');await Promise.resolve();f.context({run:{runId:'new'}});resolve(f.results);await pending;assert.equal(a.selectedId(),'new');assert.equal(a.get('r').result.job_id,'r');assert.equal(a.get('new'),null);a.destroy();
});
test('links allow only configured GitHub repository or exact same-origin run artifacts',()=>{
  const o={repo:'example/private',run:'r',origin:'http://127.0.0.1:8768'};
  assert.ok(safeReceiptLink('https://github.com/example/private/releases/tag/sim-r',o));
  for(const url of ['javascript:alert(1)','https://github.com/other/repo/releases/tag/x','https://evil.test/example/private/releases/tag/x','https://github.com@example.com/example/private/releases/tag/x'])assert.equal(safeReceiptLink(url,o),null);
  assert.ok(safeReceiptLink('/api/jobs/r/artifacts/full-results.tar.gz',{...o,kind:'artifact'}));assert.equal(safeReceiptLink('/api/jobs/other/artifacts/a',{...o,kind:'artifact'}),null);
});
test('saved real archived receipt validates read-only with source/archive/asset identity',async()=>{
  const jobs=JSON.parse(await readFile(new URL('./fixtures/jobs.json',import.meta.url))).data.jobs;
  const id='20261109T071529Z-ba49b4ff1c-955216aa';
  const saved=JSON.parse(await readFile(new URL('./fixtures/'+id+'/results.json',import.meta.url))).data;
  const row=jobs.find(r=>r.run_id===id),policy=receiptPolicy(row,saved);assert.equal(policy.verified,true);assert.equal(policy.archive,false);assert.equal(policy.collect,false);
});
test('capability and local archive identity mismatches cannot enable actions',async()=>{
  const f=fixture();f.host.getProject=()=>({capabilities:{runner:false,publish:false}});const a=createReceiptActions(f.host);assert.equal(a.policy('r').collect,false);await assert.rejects(a.collect('r'));assert.equal(f.calls.length,0);a.destroy();
  const b=fixture();b.setRuns([{...b.run,state:'collected',collection}]);b.setResults({...b.results,state:'collected',collection:{...collection,sha256:'d'.repeat(64)}});const c=createReceiptActions(b.host);await assert.rejects(c.inspect('r'),/SHA/);assert.equal(c.policy('r').archive,false);c.destroy();
});
