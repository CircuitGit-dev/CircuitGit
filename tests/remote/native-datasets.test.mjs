import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createOnboardingBridge,createOnboardingPendingStore,createOnboardingSelectionStore} from '../../apps/web/remote/onboarding-bridge.js';
import {isOnboardingRequest} from '../../apps/web/remote/client.js';
import {nativeAnalysisSession} from '../studio/native-datasets.fixture.mjs';
const fixture=JSON.parse(await readFile(new URL('../../docs/contracts/onboarding-acdc.example.json',import.meta.url)));
const snapshot=nativeAnalysisSession({schema:'ic.onboarding.session.v1',connection_id:'native-fixture-store',source:{}},fixture);
function memory(){const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};}
async function setup(){
  const calls=[],storage=memory(),info={schema:'circuitgit.remote-node.v1',node_id:'native-fixture',connection_id:snapshot.connection_id,single_owner:true,auth:'bearer',capabilities:{chat:false,simulation_onboarding:true,simulation_onboarding_api_version:'1'}};
  let mutate=value=>value;
  const transport={base:'http://127.0.0.1:18885',request:async(path,options={})=>{calls.push({path,options});const url=new URL(path,'http://fixture');if(url.pathname.endsWith('/session'))return structuredClone(snapshot);if(url.pathname.endsWith('/analysis'))return mutate(structuredClone(fixture.results[options.body.operation==='ac_metrics'?'ac':'dc_op']));
    const operation=url.pathname.split('/').at(-1),did=url.searchParams.get('dataset_id'),kind=Object.keys(fixture.catalogs).find(kind=>fixture.catalogs[kind].dataset_id===did),catalog=kind?fixture.catalogs[kind]:fixture.overview;
    const response={schema:'ic.onboarding.waveforms.v1',operation,...Object.fromEntries(['intake_id','job_id','run_id','source_commit','archive_sha256','original_source_sha256','compiled_source_sha256','compiled_source_path','transformation'].map(key=>[key,fixture.descriptor[key]])),read_only:true,probe:{enabled:false,current_geometry_context_verified:false},...(did?{dataset_id:did}:{})};
    if(operation==='catalog')response.catalog=catalog;else if(operation==='mapping')response.mapping={...catalog,schema:'ic.waveform-map.v1',status:'unmapped',objects:[]};else response.series=[fixture.windows[kind]];return mutate(structuredClone(response));}};
  const bridge=createOnboardingBridge({win:{location:{origin:'http://127.0.0.1:18884'}},pendingStore:createOnboardingPendingStore({storage}),selectionStore:createOnboardingSelectionStore({storage})});await bridge.bindClient(transport,info);await bridge.adoptIntake(snapshot);
  return {bridge,calls,provider:bridge.waveformApi({intake_id:snapshot.intake_id,job:snapshot.job}),mutate:fn=>mutate=fn};
}
test('finite transport permits exact dataset selectors only',()=>{
  const base='/simulation/onboarding/waveforms/catalog?intake_id='+fixture.intake_id+'&job_id='+fixture.run_id;
  assert.equal(isOnboardingRequest(base+'&dataset_id='+fixture.catalogs.ac.dataset_id,'GET'),true);for(const bad of ['latest','../data','ds_wrong',fixture.catalogs.ac.dataset_id+'&dataset_id='+fixture.catalogs.dc.dataset_id])assert.equal(isOnboardingRequest(base+'&dataset_id='+bad,'GET'),false);
});
test('bridge preserves native catalog, complex coordinates, zero Hz and exact AC/DC analysis',async()=>{
  const {bridge,provider,calls}=await setup();assert.equal((await provider.catalog(fixture.run_id)).signals.length,0);
  for(const kind of ['ac','dc']){const source=fixture.catalogs[kind],catalog=await provider.catalog(fixture.run_id,{dataset_id:source.dataset_id});assert.equal(catalog.data_sha256,source.data_sha256);await provider.mapping(fixture.run_id,{dataset_id:source.dataset_id});assert.deepEqual(await provider.waveform(fixture.run_id,source.signals[0].id,{dataset_id:source.dataset_id}),fixture.windows[kind]);}
  for(const kind of ['ac','dc_op'])assert.deepEqual(await bridge.analyzeExperiment(fixture.requests[kind]),fixture.results[kind]);
  assert.equal(calls.some(row=>row.options.body?.analysis==='tran'),false);bridge.disconnect();
});
test('bridge rejects cross-dataset selection before dispatch and altered response identity after dispatch',async()=>{
  const f=await setup(),ac=fixture.catalogs.ac;await f.provider.catalog(fixture.run_id,{dataset_id:ac.dataset_id});let count=f.calls.length;
  await assert.rejects(f.provider.waveform(fixture.run_id,ac.signals[0].id,{dataset_id:fixture.catalogs.dc.dataset_id}));assert.equal(f.calls.length,count);
  await assert.rejects(f.bridge.analyzeExperiment({...fixture.requests.ac,inputs:{response:fixture.catalogs.dc.signals[0].id}}));assert.equal(f.calls.length,count);
  f.mutate(value=>{if(value.series)value.series[0].data_sha256='f'.repeat(64);return value;});await assert.rejects(f.provider.waveform(fixture.run_id,ac.signals[0].id,{dataset_id:ac.dataset_id}));f.bridge.disconnect();
});
