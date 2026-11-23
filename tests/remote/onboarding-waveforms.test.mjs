import test from 'node:test';
import assert from 'node:assert/strict';
import {onboardingWaveformScope,scopedOnboardingWaveformAPI} from '../../apps/web/remote/onboarding-waveforms.js';

const commit='a'.repeat(40),plan='b'.repeat(64),digest='c'.repeat(64);
const intake={schema:'ic.onboarding.session.v1',intake_id:'intake_one',source_sha256:digest,source_commit:commit,
  prepared:{schema:'ic.experiment.plan.v1',state:'prepared',plan_id:plan,source_commit:commit,project_id:'new-project',recipe_id:'inverter'}};
const job={schema:'ic.experiment.job.v1',plan_id:plan,source_commit:commit,project_id:'new-project',configuration:'inverter',run_id:'run-one',job_id:'run-one'};
const identity={run_id:job.run_id,source_commit:commit,archive_sha256:digest,raw_signature:digest,effective_config_sha256:digest,csv_sha256:digest};
const signal={id:'signal-one',label:'OUT',analysis:'tran',status:'available'};
const provider={catalog:async()=>({...identity,signals:[signal]}),mapping:async()=>({...identity,status:'verified_binding',objects:[{}]}),
  waveform:async()=>({...identity,signal,points:[[0,0],[1e-9,.9]]})};
const scope=()=>onboardingWaveformScope(structuredClone(intake),structuredClone(job));

test('requires exact intake, prepared plan, project, configuration and original run',()=>{
  assert.equal(scope().run_id,'run-one');
  for(const field of ['plan_id','source_commit','project_id','configuration','job_id'])assert.throws(()=>onboardingWaveformScope(intake,{...job,[field]:'foreign'}));
  assert.throws(()=>onboardingWaveformScope({...intake,source_commit:null},job));
});
test('catalog/window keep the same native archive while diagram probes remain disabled',async()=>{
  const api=scopedOnboardingWaveformAPI(scope(),provider);
  assert.equal((await api.catalog('run-one')).signals[0].id,signal.id);
  assert.deepEqual((await api.mapping('run-one')).objects,[]);
  assert.equal((await api.mapping('run-one')).status,'unmapped');
  assert.deepEqual((await api.waveform('run-one',signal.id)).points,[[0,0],[1e-9,.9]]);
  await assert.rejects(api.catalog('another-run'));
});
test('rejects mixed archives, a different signal, and malformed display vectors',async()=>{
  let response={...identity,signal,points:[[0,0]]};
  const api=scopedOnboardingWaveformAPI(scope(),{...provider,waveform:async()=>response});
  await api.catalog('run-one');
  response={...response,archive_sha256:'e'.repeat(64)};await assert.rejects(api.waveform('run-one',signal.id),/归档身份/);
  response={...identity,signal:{...signal,id:'foreign'},points:[[0,0]]};await assert.rejects(api.waveform('run-one',signal.id),/信号/);
  response={...identity,signal,points:[[0,NaN]]};await assert.rejects(api.waveform('run-one',signal.id),/样本/);
});
test('drops an in-flight response after connection replacement without retry',async()=>{
  let resolve,current=true,calls=0;
  const api=scopedOnboardingWaveformAPI(scope(),{...provider,catalog:()=>{calls++;return new Promise(r=>resolve=r);}},{isCurrent:()=>current});
  const result=api.catalog('run-one');current=false;resolve({...identity,signals:[signal]});
  await assert.rejects(result,/连接已变化/);assert.equal(calls,1);
});
test('flat source wrapping can retain a different compiler hash with the same frozen run identity',async()=>{
  const api=scopedOnboardingWaveformAPI(scope(),{...provider,catalog:async()=>({...identity,source_hashes:{'generated-wrapper.scs':'f'.repeat(64)},signals:[signal]})});
  assert.equal((await api.catalog('run-one')).run_id,'run-one');
});
