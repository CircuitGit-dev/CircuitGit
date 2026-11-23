import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {checkAnalysisResult} from '../../modules/simulation/environment/analysis.js';
import {parseEnvironmentJson} from '../../modules/simulation/environment/json.js';
import {createEnvironmentController} from '../../modules/simulation/environment/model.js';
import {environmentFixture,source} from './environment.fixture.mjs';
import {analysisSession,analysisCatalog} from './analysis.fixture.mjs';

const fixture=JSON.parse(await readFile(new URL('../remote/fixtures/onboarding-analysis.example.json',import.meta.url),'utf8')),result=fixture.analysis;
async function setup(){
  const f=environmentFixture();await f.adapter.inspectNetlist(source);f.saved=analysisSession(f.saved,result);f.setConnection({selectedIntakeId:f.saved.intake_id});
  f.adapter.waveformApi=()=>({catalog:async()=>analysisCatalog(result)});f.adapter.analyzeExperiment=async args=>{f.calls.push({method:'analyzeExperiment',args:structuredClone(args)});return structuredClone(result);};
  const controller=createEnvironmentController({adapter:f.adapter});await controller.ready;await controller.restoreSelected();return {f,controller};
}
test('the actual serializer fixture retains metrics and complete source provenance without recomputing measurements',async()=>{
  const {f,controller}=await setup();assert.deepEqual(checkAnalysisResult(result,f.saved),result);
  await controller.readAnalysisCatalog();const actual=await controller.analyze(result.request);assert.deepEqual(actual,result);assert.deepEqual(controller.state.analysis.result,result);
  assert.equal(f.calls.filter(row=>row.method==='analyzeExperiment').length,1);assert.equal(f.calls.some(row=>row.method==='runPrepared'),false);controller.destroy();
});
test('foreign source, archive, raw data, downsampling and invalid metrics cannot be shown as valid analysis',async()=>{
  const {f,controller}=await setup();const mutations=[
    row=>row.original_source_sha256='0'.repeat(64),row=>row.job_id='foreign',row=>row.input.csv_sha256='0'.repeat(64),
    row=>row.input.raw_signature='0'.repeat(64),row=>row.input.effective_config_sha256='0'.repeat(64),row=>row.input.source_hashes={},
    row=>row.input.full_resolution=false,row=>row.input.display_downsampling_used=true,row=>row.result.metrics.sndr_db.value=Infinity,
    row=>row.result.metrics.sndr_db.status='undefined',row=>row.changes_original_job_verdict=true,row=>row.solver_invocations=1,
    row=>row.input.selection.samples.id='s_'+'f'.repeat(32),row=>row.result.specification_result='pass'];
  for(const mutate of mutations){const changed=structuredClone(result);mutate(changed);assert.throws(()=>checkAnalysisResult(changed,f.saved));}
  for(const missing of [undefined,null,{}, {job:null}])assert.throws(()=>checkAnalysisResult(result,missing),/分析结果/);
  controller.destroy();
});
test('undefined results remain undefined and sparse or empty spectra remain data gaps',async()=>{
  const {f,controller}=await setup(),value=structuredClone(result);value.result.metrics.sndr_db={value:null,unit:'dB',status:'undefined'};
  value.evaluation={specification_result:'not_evaluated',criteria:[]};
  value.result.spectrum={frequency_hz:[0,1,2,3],power_db:[null,-70,-20,null],power_unit:'V^2',frequency_unit:'Hz'};
  assert.deepEqual(checkAnalysisResult(value,f.saved).result.spectrum.power_db,[null,-70,-20,null]);
  value.result.spectrum.power_db=[null,null,null,null];assert.equal(checkAnalysisResult(value,f.saved).result.metrics.sndr_db.value,null);controller.destroy();
});
test('new sources and changed archived data clear analysis and catalog rather than reusing old results',async()=>{
  const {f,controller}=await setup();await controller.readAnalysisCatalog();controller.receiveAnalysis(result);
  f.saved={...f.saved,job:{...f.saved.job,waveforms:{...f.saved.job.waveforms,csv_sha256:'0'.repeat(64)}}};
  await controller.refreshCurrent(controller.currentBinding);assert.equal(controller.state.analysis.result,null);assert.equal(controller.state.analysisCatalog.result,null);
  await controller.importSource(source);assert.equal(controller.state.analysis.result,null);assert.equal(controller.state.analysisCatalog.result,null);controller.destroy();
});
test('a delayed analysis response after a connection switch cannot populate the current result',async()=>{
  const {f,controller}=await setup();let finish;f.adapter.analyzeExperiment=()=>new Promise(resolve=>finish=resolve);
  const promise=controller.analyze(result.request);f.setConnection({connectionId:'different-helper'});finish(result);await assert.rejects(promise,/连接已变化/);assert.equal(controller.state.analysis.result,null);controller.destroy();
});
test('duplicate escaped metadata keys and duplicates nested in an array fail closed',()=>{
  assert.throws(()=>parseEnvironmentJson('{"x":1,"\\u0078":2}'),/重复/);
  assert.throws(()=>parseEnvironmentJson('[{"x":1,"x":2}]',{objectOnly:false}),/重复/);
  assert.deepEqual(parseEnvironmentJson('{"x":{"y":1},"y":2,"z":[{"x":3}]}'),{x:{y:1},y:2,z:[{x:3}]});
});
