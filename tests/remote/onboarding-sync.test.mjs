import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOnboardingSync} from '../../apps/web/remote/onboarding-sync.js';

const hash=text=>createHash('sha256').update(text).digest('hex');
function fixture(){
  const source={file_name:'inv.scs',text:'subckt inv A Y VDD VSS\nends inv\n'},calls=[],listeners=new Set();
  let session={schema:'ic.onboarding.session.v1',connection_id:'a'.repeat(32),intake_id:'intake_'+'b'.repeat(32),revision:1,
    source_sha256:hash(source.text),source_commit:null,source:{file_name:source.file_name}};
  let state={connected:true,connectionId:'paired-local|helper|store',storeIdentity:session.connection_id,selectedIntakeId:session.intake_id};
  const bridge={getState:()=>state,getSessionState:()=>structuredClone(session),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async getSession(input){calls.push({op:'read',...input});return structuredClone(session);},
    async adoptIntake(input){calls.push({op:'adopt',...input});session={...session,...input};state.selectedIntakeId=input.intake_id;}};
  const waves=[],timers=new Set();
  const sync=createOnboardingSync({bridge,getSource:()=>source,hashText:hash,openWaveforms:async payload=>waves.push(payload),
    setTimer:fn=>{timers.add(fn);return fn;},clearTimer:fn=>timers.delete(fn)});
  return {sync,source,bridge,calls,waves,timers,get session(){return session;},set session(next){session=next;},get state(){return state;}};
}

test('AI receives the exact imported source before any Git snapshot exists',async()=>{
  const f=fixture();const context=await f.sync.contextFor();
  assert.equal(context.onboarding.intake_id,f.session.intake_id);assert.equal(context.file.persistedSha256,hash(f.source.text));
  assert.equal(context.file.baseCommit,null);assert.equal(context.geometry,null);f.sync.destroy();
});
test('source changes and a different helper cannot become AI context',async()=>{
  const f=fixture();assert.equal(await f.sync.contextFor({connectionId:'other'}),null);
  f.source.text+='changed';assert.equal(await f.sync.contextFor(),null);
  await assert.rejects(f.sync.contextFor({required:true}),/网表/);f.sync.destroy();
});
test('refresh queries only selected intake and never lists latest jobs',async()=>{
  const f=fixture();await f.sync.refresh();assert.deepEqual(f.calls,[{op:'read',intake_id:f.session.intake_id}]);f.sync.destroy();
});
test('AI read/result for a different intake cannot change current view',async()=>{
  const f=fixture();const unrelated={...f.session,intake_id:'intake_'+'c'.repeat(32)};
  assert.equal((await f.sync.handleToolResult({tool:'ic_onboarding_inspect',result:unrelated})).status,'ignored');
  assert.equal(f.calls.length,0);f.sync.destroy();
});
test('only explicit netlist tool result with matching source can adopt a new intake',async()=>{
  const f=fixture(),created={...f.session,intake_id:'intake_'+'c'.repeat(32)};
  await f.sync.handleToolResult({tool:'ic_onboarding_netlist',result:{structuredContent:{ok:true,data:created}}});
  assert.equal(f.calls[0].op,'adopt');assert.equal(f.state.selectedIntakeId,created.intake_id);
  const before=f.calls.length;await f.sync.handleToolResult({tool:'ic_onboarding_netlist',result:{...created,source_sha256:'e'.repeat(64)}});
  assert.equal(f.calls.length,before);f.sync.destroy();
});
test('verified waveforms open once for exact plan and run, with no simulation POST',async()=>{
  const f=fixture();f.session={...f.session,prepared:{plan_id:'plan'},job:{job_id:'job',plan_id:'plan',waveforms:{available:true,source_binding_verified:true,archive_sha256:'d'.repeat(64)}}};
  await f.sync.refresh();await f.sync.refresh();assert.equal(f.waves.length,1);
  f.source.text+='changed';await f.sync.refresh();assert.equal(f.waves.length,1);f.sync.destroy();
});
test('deferred controller prevents waveform replacement and disposal stops polling',async()=>{
  const f=fixture();f.session={...f.session,prepared:{plan_id:'plan'},job:{job_id:'job',plan_id:'plan',waveforms:{available:true,source_binding_verified:true,archive_sha256:'d'.repeat(64)}}};
  const unregister=f.sync.register({async refreshCurrent(input){assert.equal(input.intakeId,f.session.intake_id);return {status:'deferred'};}});
  await f.sync.refresh();assert.equal(f.waves.length,0);assert.equal(f.timers.size,1);unregister();assert.equal(f.timers.size,0);f.sync.destroy();
});
