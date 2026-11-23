// Reads an unchanged backend-generated serializer fixture supplied explicitly.
// The fixture's real local Git/Runner reservation has synthetic SSH and deferred
// dispatch. This test does not execute the backend, SSH, a model or a simulator.
// ONBOARDING_SESSION_FIXTURE=/.../onboarding-session.example.json node --test tests/studio/environment.contract.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createEnvironmentController} from '../../modules/simulation/environment/model.js';
import {validatePreDispatchRejection} from '../../modules/simulation/environment/submission.js';

const fixturePath=process.env.ONBOARDING_SESSION_FIXTURE;
if(!fixturePath)throw Error('Set ONBOARDING_SESSION_FIXTURE to the unchanged backend-generated example.');
const raw=await readFile(fixturePath,'utf8'),fixture=JSON.parse(raw),snapshots=fixture.snapshots;
assert.equal(fixture.synthetic,true);assert.equal(fixture.evidence.simulation_executed,false);
const clone=value=>structuredClone(value);
const source='simulator lang=spectre\nA (OUT IN LO LO) device_alpha w=2u l=200n nf=1 multi=1\nB (OUT IN HI HI) device_beta w=3u l=200n nf=1 multi=1\n';
assert.equal(createHash('sha256').update(source).digest('hex'),snapshots.netlist.source_sha256,'Source bytes match the original fixture producer.');
test('actual smart serializer prefills the selection and confirms one exact prepare/run chain',async()=>{
  const smart=JSON.parse(await readFile(new URL('../../docs/contracts/onboarding-smart.example.json',import.meta.url),'utf8'));
  assert.equal(smart.synthetic,true);assert.equal(smart.evidence.solver_invocations,0);
  const rows=smart.snapshots,calls=[],pending=[];
  assert.equal(createHash('sha256').update(source).digest('hex'),rows.netlist.source_sha256);
  const adapter={getState:()=>({connected:true,connectionId:'smart|'+rows.netlist.connection_id,selectedIntakeId:rows.netlist.intake_id}),subscribe:()=>()=>{},
    pendingStore:{async load(){return clone(pending);},async put(row){pending.push(clone(row));},async remove(row){const i=pending.findIndex(item=>item.phase===row.phase);if(i>=0)pending.splice(i,1);}}};
  for(const [method,snapshot]of Object.entries({inspectNetlist:'netlist',probeHost:'probe',discoverPdk:'discover',prepareExperiment:'prepare',runPrepared:'run',inspectExperiment:'inspect'})){
    adapter[method]=async args=>{calls.push({method,args:clone(args)});return clone(rows[snapshot]);};
  }
  const controller=createEnvironmentController({adapter});await controller.ready;
  await controller.importSource({file_name:rows.netlist.source.file_name,text:source});
  controller.setTargets(rows.probe.probes.map(row=>row.ssh_target));await controller.probeHost();await controller.matchPdk();
  assert.equal(controller.recommendation.candidate_id,rows.discover.recommended_selection.candidate_id);
  await controller.confirmAndRun();await controller.inspect();
  assert.equal(calls.filter(row=>row.method==='prepareExperiment').length,1);assert.equal(calls.filter(row=>row.method==='runPrepared').length,1);
  assert.equal(calls.find(row=>row.method==='prepareExperiment').args.recommendation_id,rows.discover.recommended_selection.recommendation_id);
  assert.deepEqual(controller.state.run.result,rows.inspect.job);assert.equal(pending.length,0);controller.destroy();
});
function make(){
  const calls=[],records=[],pendingStore={async load(){return clone(records);},async put(value){records.push(clone(value));},async remove(value){const index=records.findIndex(item=>item.phase===value.phase);if(index>=0)records.splice(index,1);}};
  const adapter={pendingStore,getState:()=>({connected:true,connectionId:'fixture|'+snapshots.netlist.connection_id,selectedIntakeId:snapshots.netlist.intake_id}),subscribe:()=>()=>{}};
  for(const [method,snapshot]of Object.entries({inspectNetlist:'netlist',probeHost:'probe',discoverPdk:'discover',prepareExperiment:'prepare',runPrepared:'run',inspectExperiment:'inspect',getSession:'getSession'}))adapter[method]=async args=>{calls.push({method,args:clone(args)});return clone(snapshots[snapshot]);};
  return {adapter,calls,records};
}
test('unchanged actual serializer snapshots pass the complete UI state workflow',async()=>{
  const {adapter,calls,records}=make(),controller=createEnvironmentController({adapter});await controller.ready;await controller.importSource({file_name:snapshots.netlist.source.file_name,text:source});
  controller.setTargets(snapshots.probe.probes.map(probe=>probe.ssh_target));await controller.probeHost();await controller.matchPdk();
  const selection=snapshots.prepare.selection;controller.selectCandidate(selection.candidate_id);assert.deepEqual(controller.state.modelContracts,{});controller.selectSections(selection.sections);
  assert.equal(controller.state.modelContracts.device_alpha.polarity,'n');assert.equal(controller.state.modelContracts.device_beta.polarity,'p');
  for(const [key,value]of Object.entries(selection.intent))controller.setIntent(key,String(value));controller.confirmIntent(true);await controller.prepare();await controller.runPrepared();await controller.inspect();
  assert.deepEqual(controller.state.run.result,snapshots.inspect.job);assert.equal(controller.state.run.result.inspection_state,'working');assert.equal(controller.state.run.result.waveforms.available,false);assert.equal(records.length,0);
  assert.deepEqual(calls.map(call=>call.method),['inspectNetlist','probeHost','discoverPdk','prepareExperiment','runPrepared','inspectExperiment']);assert.equal(calls[4].args.plan_id,snapshots.prepare.prepared.plan_id);assert.deepEqual(calls[5].args,{intake_id:snapshots.netlist.intake_id,job_id:snapshots.run.job.job_id});
  controller.destroy();
});
test('unchanged prepared session restores verified model evidence when explicit map is empty',async()=>{
  const {adapter,calls}=make();adapter.getSession=async args=>{calls.push({method:'getSession',args});return clone(snapshots.prepare);};const controller=createEnvironmentController({adapter});await controller.ready;assert.deepEqual(calls,[]);await controller.restoreSelected();assert.equal(controller.intentReady,true);assert.equal(controller.state.intentConfirmed,false);assert.equal(controller.state.modelContracts.device_beta.polarity,'p');controller.confirmIntent(true);assert.equal(controller.state.preparation.result.prepared.plan_id,snapshots.prepare.prepared.plan_id);assert.deepEqual(calls.map(call=>call.method),['getSession']);controller.destroy();
});

// Optional companion generated by the actual backend control flow with a mocked
// preflight mismatch. Its response snapshots are never modified or spliced into
// the successful fixture above; neither fixture proves live simulator behavior.
test('unchanged backend pre-dispatch rejection validates and survives normal selected-intake restore',{skip:!process.env.ONBOARDING_REJECTION_FIXTURE},async()=>{
  const path=process.env.ONBOARDING_REJECTION_FIXTURE,raw=await readFile(path,'utf8'),value=JSON.parse(raw);
  assert.equal(value.schema,'ic.onboarding.rejection-examples.v1');assert.equal(value.synthetic,true);assert.equal(value.evidence.simulation_executed,false);assert.equal(value.evidence.runner_reservation_attempted,false);
  const rejected=value.snapshots.runRejected,saved=value.snapshots.getSessionRejected,lookup=value.snapshots.readSubmissionRejected;
  assert.equal(createHash('sha256').update(source).digest('hex'),rejected.source_sha256);assert.deepEqual(validatePreDispatchRejection(lookup,{intake:rejected,plan:rejected.prepared}),rejected.submission);assert.deepEqual(saved.submission,lookup);
  const calls=[],notified=[],adapter={getState:()=>({connected:true,connectionId:'fixture|'+saved.connection_id,selectedIntakeId:saved.intake_id}),subscribe:()=>()=>{},pendingStore:{load:async()=>[]},getSession:async args=>{calls.push(args);return clone(saved);}};
  const controller=createEnvironmentController({adapter,onRun:value=>notified.push(value)});await controller.ready;await controller.restoreSelected();assert.deepEqual(calls,[{intake_id:saved.intake_id}]);assert.equal(controller.state.run.status,'rejected');assert.equal(controller.state.run.result,null);assert.deepEqual(controller.state.run.rejection,lookup);assert.deepEqual(controller.state.pending,[]);assert.equal(controller.state.intentConfirmed,false);assert.equal(controller.intentReady,true);assert.deepEqual(notified,[]);assert.ok(controller.state.rejectedSubmissionKeys.includes(lookup.submission_key));assert.equal(await readFile(path,'utf8'),raw);controller.destroy();
});
