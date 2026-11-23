import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {checkAnalysisResult} from '../../modules/simulation/environment/analysis.js';
import {createEnvironmentController,onboardingWaveformsAvailable} from '../../modules/simulation/environment/model.js';
import {environmentFixture,source} from './environment.fixture.mjs';
import {nativeAnalysisSession} from './native-datasets.fixture.mjs';
const fixture=JSON.parse(await readFile(new URL('../../docs/contracts/onboarding-acdc.example.json',import.meta.url)));
async function setup(){
  const f=environmentFixture();await f.adapter.inspectNetlist(source);f.saved=nativeAnalysisSession(f.saved,fixture);f.setConnection({selectedIntakeId:f.saved.intake_id});
  f.adapter.waveformApi=()=>({catalog:async(_run,options)=>structuredClone(options?.dataset_id?Object.values(fixture.catalogs).find(row=>row.dataset_id===options.dataset_id):fixture.overview)});
  f.adapter.analyzeExperiment=async args=>{f.calls.push({method:'analyzeExperiment',args});return structuredClone(fixture.results[args.operation==='ac_metrics'?'ac':'dc_op']);};
  const controller=createEnvironmentController({adapter:f.adapter});await controller.ready;await controller.restoreSelected();return {f,controller};
}
test('AC/DC-only original archives are available without pretending to have a CSV hash',async()=>{
  const {f,controller}=await setup();assert.equal(onboardingWaveformsAvailable({intake:f.saved,job:f.saved.job}),true);const overview=await controller.readAnalysisCatalog();assert.equal(overview.signals.length,0);assert.equal(overview.datasets.length,3);
  for(const kind of ['ac','dc_op']){const request=fixture.requests[kind];const catalog=await controller.readAnalysisCatalog({dataset_id:request.dataset_id});assert.equal(catalog.dataset_id,request.dataset_id);const result=await controller.analyze(request);assert.deepEqual(result,fixture.results[kind]);assert.equal('csv_sha256' in result.input,false);}
  assert.equal(f.calls.some(row=>row.method==='runPrepared'),false);controller.destroy();
});
test('native analysis rejects wrong datasets, missing zero-axis proof and relabelled response units',async()=>{
  const {f,controller}=await setup();const mutations=[row=>row.input.dataset_id=fixture.catalogs.dc.dataset_id,row=>row.input.data_sha256='f'.repeat(64),row=>row.input.native_member_sha256='e'.repeat(64),row=>row.request.dataset_id=fixture.catalogs.dc.dataset_id,row=>row.input.selection.response.id=fixture.catalogs.dc.signals[0].id,row=>row.input.selection.frequency_hz.unit='s',row=>row.result.parameters.response_unit='1',row=>row.result.stability_verdict='stable'];
  for(const mutate of mutations){const value=structuredClone(fixture.results.ac);mutate(value);assert.throws(()=>checkAnalysisResult(value,f.saved));}controller.destroy();
});
test('DC selection stays exact and unrecognized device IDs cannot inherit a saturation verdict',async()=>{
  const {f,controller}=await setup();assert.deepEqual(checkAnalysisResult(fixture.results.dc_op,f.saved),fixture.results.dc_op);
  const value=structuredClone(fixture.results.dc_op);value.request.inputs.devices[0]='d_'+'f'.repeat(32);assert.throws(()=>checkAnalysisResult(value,f.saved));controller.destroy();
});
