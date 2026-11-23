import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createNodeClient} from '../../apps/web/remote/client.js';
import {Gateway} from '../../apps/web/api.js';
import {createOnboardingBridge,createOnboardingPendingStore,createOnboardingSelectionStore,snapshotOnboardingSource} from '../../apps/web/remote/onboarding-bridge.js';
import {analysisSession} from '../studio/analysis.fixture.mjs';

const intake='intake-public-fixture',plan='plan-fixture';
const session=revision=>({schema:'ic.onboarding.session.v1',connection_id:'store-A',intake_id:intake,revision,source_commit:null});
function memory(){const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};}
function fixture({storage=memory(),storeId='store-A',gateway=false,respond,open}={}){
  const calls=[],pairs=[],info={schema:'circuitgit.remote-node.v1',node_id:'node-fixture',connection_id:storeId,single_owner:true,auth:'bearer',capabilities:{chat:false,simulation_onboarding:true,simulation_onboarding_api_version:'1',override_fields:['spectre_path']}};
  let closed=0;
  const transport={base:'http://127.0.0.1:18885',close(){closed++;},health:async()=>{calls.push({path:'/health'});return info;},request:async(path,options={})=>{calls.push({path,...options});if(path==='/node/info')return info;if(respond)return respond(path,options);if(path.endsWith('/netlist'))return session(0);if(path.endsWith('/probe'))return session(options.body.revision+1);if(path.endsWith('/prepare'))return {...session(options.body.revision+1),prepared:{plan_id:plan,submission_key:'experiment-'+plan}};if(path.includes('/session?'))return session(2);if(path.includes('/submission?'))return {intake_id:intake,plan_id:plan,submission_key:'experiment-'+plan,found:false,replay_permitted:false};return {hosts:[]};}};
  const bridge=createOnboardingBridge({win:{location:{origin:'http://127.0.0.1:18884'},open},gateway:gateway?transport:null,pair:options=>{pairs.push(options);return {result:Promise.resolve({url:options.base,accessCode:'x'.repeat(43)}),cancel(){}};},clientFactory:()=>transport,pendingStore:createOnboardingPendingStore({storage}),selectionStore:createOnboardingSelectionStore({storage})});
  return {bridge,storage,calls,pairs,info,transport,get closed(){return closed;}};
}
async function imported(f){await f.bridge.connect({port:18885});await f.bridge.inspectNetlist({file_name:'inverter.scs',text:'subckt INV A Y VDD VSS\nends INV\n'});}

test('RNL virtual-root alias resolves the current file and its editor buffer exactly',()=>{
  const doc={path:'/circuit/inv.scs',files:[{path:'unrelated.scs',text:'wrong'},{path:'circuit/inv.scs',text:'saved'}]};
  assert.deepEqual(snapshotOnboardingSource(doc),{file_name:'inv.scs',text:'saved'});
  assert.deepEqual(snapshotOnboardingSource(doc,{hasBuffer:path=>path==='circuit/inv.scs',fileText:()=> 'edited'}),{file_name:'inv.scs',text:'edited'});
  assert.equal(snapshotOnboardingSource({...doc,path:'/elsewhere/inv.scs'}),null);
  assert.equal(snapshotOnboardingSource({...doc,files:[...doc.files,{path:'circuit/inv.scs',text:'ambiguous'}]}),null);
});

async function reviewFixture({mutate=()=>{},open}={}){
  const review_id='a'.repeat(64),review_digest='b'.repeat(64),plan_id='c'.repeat(64);
  const path='/agent-tb/review?'+new URLSearchParams({intake_id:intake,review_id});
  const snapshot={...session(3),prepared:{plan_id},agent_tb_review:{state:'pending',requires_human:true,revision:3,review_id,review_digest,plan_id,review_path:path,review_url:'http://127.0.0.1:19666'+path}};
  mutate(snapshot);const f=fixture({respond:()=>structuredClone(snapshot),open});await imported(f);
  return {...f,snapshot,args:{intake_id:intake,revision:3,review_id,review_digest,plan_id}};
}
test('a human review click opens only the frozen gateway form and never posts run or approval',async()=>{
  const opened=[],popup={opener:'synthetic-opener',location:{replace:url=>opened.push(url)}};
  const f=await reviewFixture({open:(...args)=>{assert.deepEqual(args,['about:blank','_blank']);return popup;}}),before=f.calls.length;
  assert.throws(()=>f.bridge.openAgentTestbenchReview(f.args),error=>error.data.code==='human_gesture_required');
  assert.equal(f.bridge.openAgentTestbenchReview(f.args,{event:{isTrusted:true}}).opened,true);
  assert.equal(popup.opener,null);assert.deepEqual(opened,[f.snapshot.agent_tb_review.review_url]);assert.equal(f.calls.length,before);
  assert.equal('approveAgentTestbench' in f.bridge,false);assert.equal('runReviewedAgentTestbench' in f.bridge,false);
});
test('foreign, missing, stale and altered review URLs cannot open a window',async()=>{
  for(const mutate of [
    value=>value.agent_tb_review.review_url='https://example.org'+value.agent_tb_review.review_path,
    value=>value.agent_tb_review.review_url='http://localhost:19666'+value.agent_tb_review.review_path,
    value=>value.agent_tb_review.review_url+='&other=1',value=>delete value.agent_tb_review.review_url,
    value=>value.agent_tb_review.review_path+='/changed',value=>value.agent_tb_review.state='approved',
    value=>value.agent_tb_review.revision=2,
  ]){let opened=0;const f=await reviewFixture({mutate,open:()=>opened++});assert.throws(()=>f.bridge.openAgentTestbenchReview(f.args,{event:{isTrusted:true}}));assert.equal(opened,0);}
});
const analysisExample=JSON.parse(await readFile(new URL('./fixtures/onboarding-analysis.example.json',import.meta.url),'utf8')).analysis;
async function analysisBridgeFixture({mutate=()=>{}}={}){
  const snapshot=analysisSession({...session(7),source:{}},analysisExample);
  const f=fixture({respond:(path)=>{if(path.endsWith('/analysis')){const value=structuredClone(analysisExample);mutate(value);return value;}return snapshot;}});await imported(f);return {...f,snapshot};
}
test('analysis transport uses only exact saved signal IDs and receives the actual full-resolution receipt',async()=>{
  const f=await analysisBridgeFixture(),args={intake_id:f.snapshot.intake_id,job_id:analysisExample.job_id,...analysisExample.request};
  assert.deepEqual(await f.bridge.analyzeExperiment(args),analysisExample);assert.equal(f.calls.at(-1).path,'/simulation/onboarding/analysis');assert.equal(f.calls.at(-1).timeout,120000);
  for(const inputs of [{samples:'/tmp/private.csv'},{samples:'s_'+'f'.repeat(32)},{samples:'@time'},{decisions:['s_'+'f'.repeat(32)]}]){const before=f.calls.length;await assert.rejects(f.bridge.analyzeExperiment({...args,inputs}),e=>e.data.code==='analysis_scope_mismatch');assert.equal(f.calls.length,before);}
});
test('analysis transport rejects changed original data and fabricated metrics even with matching outer IDs',async()=>{
  for(const mutate of [value=>value.input.csv_sha256='0'.repeat(64),value=>value.input.display_downsampling_used=true,value=>value.result.metrics.sndr_db.value=NaN,value=>value.input.selection.samples.id='s_'+'f'.repeat(32),value=>value.changes_original_job_verdict=true]){
    const f=await analysisBridgeFixture({mutate});await assert.rejects(f.bridge.analyzeExperiment({intake_id:f.snapshot.intake_id,job_id:analysisExample.job_id,...analysisExample.request}),e=>e.data.code==='analysis_scope_mismatch');
  }
});

test('shared AI helper pairing is reused without closing its transport',async()=>{
  const f=fixture();await f.bridge.bindClient(f.transport,f.info);
  assert.equal(f.bridge.getState().storeIdentity,'store-A');assert.equal(f.pairs.length,0);
  await f.bridge.listSshAliases();f.bridge.disconnect();assert.equal(f.closed,0);
});
test('explicit AI intake adoption performs a matching readback before selecting',async()=>{
  const result={...session(2),source_sha256:'a'.repeat(64)};
  const f=fixture({respond:async()=>result});await f.bridge.bindClient(f.transport,f.info);
  await f.bridge.adoptIntake(result);assert.equal(f.bridge.getState().selectedIntakeId,intake);
  assert.equal(f.bridge.getSessionState().source_sha256,result.source_sha256);
  assert.match(f.calls[0].path,/session\?intake_id=intake-public-fixture$/);
});
test('AI adoption refuses a changed source during readback or another connection',async()=>{
  const result={...session(2),source_sha256:'a'.repeat(64)};
  const f=fixture({respond:async()=>result});await f.bridge.bindClient(f.transport,f.info);
  await assert.rejects(f.bridge.adoptIntake(result,{isCurrent:()=>false}),/画布/);
  assert.equal(f.bridge.getState().selectedIntakeId,null);
  await assert.rejects(f.bridge.adoptIntake({...result,connection_id:'another'}),/不匹配/);
  assert.equal(f.calls.length,1);
});

test('explicit local pairing works with chat disabled and never reads AI state',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);const connected=f.bridge.connect({port:18885});
  assert.equal(f.pairs.length,1,'pairing starts synchronously in the click');assert.equal(f.pairs[0].base,'http://127.0.0.1:18885');await connected;
  assert.deepEqual(f.calls.map(call=>call.path),['/node/info']);assert.equal(f.bridge.getState().connected,true);
  assert.deepEqual(f.bridge.getState().capabilities.override_fields,['spectre_path']);f.bridge.disconnect();assert.equal(f.closed,1);
});
test('same-origin provider uses its gateway and no paired or AI routes',async()=>{
  const f=fixture({gateway:true});await f.bridge.connect();await f.bridge.listSshAliases();
  assert.equal(f.pairs.length,0);assert.deepEqual(f.calls.map(call=>call.path),['/health','/simulation/onboarding/ssh-hosts']);
  assert.match(f.bridge.getState().connectionId,/^same-origin\|http:\/\/127.0.0.1:18884\|store-A$/);f.bridge.disconnect();assert.equal(f.closed,0);
});
test('advanced connection accepts only an explicitly selected loopback port',async()=>{
  for(const args of [{url:'https://arbitrary.invalid'},{port:0},{port:'18885'},{port:65536}]){const f=fixture();await assert.rejects(f.bridge.connect(args),e=>e.data.code==='invalid_connection');assert.equal(f.pairs.length,0);}
  const f=fixture();await f.bridge.connect();assert.equal(f.pairs[0].base,'http://127.0.0.1:8767');
});
test('netlist is selected by this connection and normal session selection survives reload',async()=>{
  const f=fixture();await imported(f);assert.equal(f.bridge.getState().selectedIntakeId,intake);
  const before=f.calls.length;await assert.rejects(f.bridge.getSession({intake_id:'unrelated-title'}),e=>e.data.code==='intake_scope_mismatch');assert.equal(f.calls.length,before);
  const next=fixture({storage:f.storage});await next.bridge.connect();assert.equal(next.bridge.getState().selectedIntakeId,intake);
  await next.bridge.getSession({intake_id:intake});assert.equal(next.calls.at(-1).path,'/simulation/onboarding/session?intake_id='+intake);
  assert.equal(next.calls.some(call=>call.method==='POST'),false);
});
test('a fresh helper store on the same port does not inherit the old intake',async()=>{
  const first=fixture();await imported(first);const second=fixture({storage:first.storage,storeId:'store-B'});await second.bridge.connect();
  assert.equal(second.bridge.getState().selectedIntakeId,null);await assert.rejects(second.bridge.getSession({intake_id:intake}),e=>e.data.code==='intake_scope_mismatch');
});
test('a stale async pending-store read cannot pollute the newly selected helper',async()=>{
  let release,started;const waiting=new Promise(resolve=>started=resolve),calls=[];
  const bridge=createOnboardingBridge({win:{location:{origin:'https://example.invalid'}},pair:({base})=>({result:Promise.resolve({url:base,accessCode:'x'.repeat(43)}),cancel(){}}),
    clientFactory:({url})=>({base:url,close(){},request:async path=>{calls.push({url,path});return {schema:'circuitgit.remote-node.v1',node_id:url,connection_id:url,single_owner:true,auth:'bearer',capabilities:{simulation_onboarding:true,simulation_onboarding_api_version:'1'}};}}),
    pendingStore:{load:async({connectionId})=>connectionId.includes(':18885')?new Promise(resolve=>{release=resolve;started();}):[],put:async()=>{},remove:async()=>{}},
    selectionStore:{load:async()=>null,remember:async()=>{}},
  });
  const first=bridge.connect({port:18885});await waiting;bridge.disconnect();await bridge.connect({port:18886});
  const scope=bridge.getState().connectionId;release([{connectionId:'old',intake_id:'old-intake',phase:'prepare',revision:0}]);
  await assert.rejects(first,e=>e.data.code==='connection_changed');assert.equal(bridge.getState().connectionId,scope);
  const before=calls.length;await assert.rejects(bridge.getSession({intake_id:'old-intake'}),e=>e.data.code==='intake_scope_mismatch');assert.equal(calls.length,before);
});
test('probe requires explicit hosts and preserves exact CAS arguments',async()=>{
  const f=fixture();await imported(f);const before=f.calls.length;
  await assert.rejects(f.bridge.probeHost({intake_id:intake,revision:0,ssh_targets:[]}),e=>e.data.code==='invalid_input');assert.equal(f.calls.length,before);
  const args={intake_id:intake,revision:0,ssh_targets:['user-selected-alias'],overrides:{spectre_path:'explicit-tool'}};await f.bridge.probeHost(args);
  assert.deepEqual(f.calls.at(-1),{path:'/simulation/onboarding/probe',method:'POST',timeout:45000,body:args});
});
test('run persists the original plan key before dispatch and lost replies are never replayed',async()=>{
  let dispatched=0,storage=memory();
  const f=fixture({storage,respond:async(path,options)=>{if(path.endsWith('/netlist'))return session(0);if(path.endsWith('/run')){dispatched++;const rows=await f.bridge.pendingStore.load({connectionId:f.bridge.getState().connectionId});assert.equal(rows[0].submission_key,'experiment-'+plan);assert.equal(rows[0].intake_id,intake);throw Error('lost reply');}if(path.includes('/submission?'))return {intake_id:intake,plan_id:plan,submission_key:'experiment-'+plan,found:false,replay_permitted:false};return session(0);}});
  await imported(f);const args={intake_id:intake,revision:0,plan_id:plan};await assert.rejects(f.bridge.runPrepared(args),e=>e.data.code==='transport_unknown');
  await assert.rejects(f.bridge.runPrepared(args),e=>e.data.code==='replay_forbidden');assert.equal(dispatched,1);
  const next=fixture({storage});await next.bridge.connect();await assert.rejects(next.bridge.runPrepared(args),e=>e.data.code==='replay_forbidden');
  assert.equal((await next.bridge.readSubmission({intake_id:intake,plan_id:plan})).found,false);
  await assert.rejects(next.bridge.runPrepared(args),e=>e.data.code==='replay_forbidden');assert.equal(next.calls.some(row=>row.method==='POST'),false);
});
test('prepare recovery reads the original session; its pending identity survives disconnect',async()=>{
  const f=fixture({respond:async path=>{if(path.endsWith('/netlist'))return session(0);throw Error('lost prepare reply');}});await imported(f);const scope=f.bridge.getState().connectionId;
  await assert.rejects(f.bridge.prepareExperiment({intake_id:intake,revision:0}),e=>e.data.code==='transport_unknown');f.bridge.disconnect();
  const rows=await f.bridge.pendingStore.load({connectionId:scope});assert.equal(rows.length,1);assert.equal(rows[0].phase,'prepare');assert.equal(rows[0].plan_id,null);
  const next=fixture({storage:f.storage});await next.bridge.connect();await next.bridge.getSession({intake_id:intake});
  await assert.rejects(next.bridge.prepareExperiment({intake_id:intake,revision:0}),e=>e.data.code==='replay_forbidden');
});
test('unavailable durable storage prevents prepare/run from reaching the transport',async()=>{
  const storage=memory(),original=storage.setItem;storage.setItem=(key,value)=>{if(key.endsWith('pending.v1'))throw Error('denied');original(key,value);};
  const f=fixture({storage});await imported(f);const before=f.calls.length;
  await assert.rejects(f.bridge.runPrepared({intake_id:intake,revision:0,plan_id:plan}),e=>e.data.code==='pending_store_unavailable');assert.equal(f.calls.length,before);
});
test('clear or replacement connections discard delayed reads and writes',async()=>{
  for(const write of [false,true]){
    let release;const f=fixture({respond:async path=>path.endsWith('/netlist')?session(0):new Promise(resolve=>release=resolve)});await imported(f);
    const result=write?f.bridge.probeHost({intake_id:intake,revision:0,ssh_targets:['chosen']}):f.bridge.getSession({intake_id:intake});
    f.bridge.disconnect();release(session(1));await assert.rejects(result,e=>e.data.code===(write?'transport_unknown':'connection_changed'));
    assert.equal(f.bridge.getState().connected,false);
  }
});
test('pending store rejects extra source or credential fields and isolates connection scopes',async()=>{
  const store=createOnboardingPendingStore({storage:memory()}),record={schema:'ic.onboarding.pending.v1',connectionId:'scope-A',intake_id:intake,revision:0,phase:'run',plan_id:plan,submission_key:'experiment-'+plan,createdAt:new Date().toISOString()};
  await assert.rejects(store.put({...record,text:'private source'}),e=>e.data.code==='invalid_pending_identity');await store.put(record);assert.equal((await store.load({connectionId:'scope-B'})).length,0);
  await store.remove(record);assert.deepEqual(await store.load({connectionId:'scope-A'}),[]);
});
test('current source snapshots only the entry editor buffer, not dependencies or runtime metadata',()=>{
  const doc={path:'/public/inverter.scs',files:[{path:'/public/inverter.scs',text:'saved source'},{path:'/another.scs',text:'not included'}]};
  assert.deepEqual(snapshotOnboardingSource(doc,{hasBuffer:()=>true,fileText:()=> 'edited source'}),{file_name:'inverter.scs',text:'edited source'});
  assert.deepEqual(snapshotOnboardingSource(doc),{file_name:'inverter.scs',text:'saved source'});assert.equal(snapshotOnboardingSource(null),null);
});


test('onboarding handshake requires the frozen store identity; node ID alone cannot restore a session',async()=>{
  const f=fixture();delete f.info.connection_id;
  await assert.rejects(f.bridge.connect({port:18885}),e=>e.data.code==='missing_connection_identity');
  assert.equal(f.bridge.getState().connected,false);assert.equal(f.closed,1);
});
test('all returned sessions remain bound to the original store, including run and inspect',async()=>{
  const f=fixture({respond:async(path,options)=>{
    if(path.endsWith('/netlist'))return session(0);
    return {...session(path.endsWith('/run')?1:0),connection_id:'other-store',job:{schema:'ic.experiment.job.v1',job_id:'j',run_id:'j',plan_id:plan}};
  }});await imported(f);
  await assert.rejects(f.bridge.getSession({intake_id:intake}),e=>e.data.code==='invalid_session_identity');
  for(const [name,args]of [['runPrepared',{intake_id:intake,revision:0,plan_id:plan}],['inspectExperiment',{intake_id:intake,job_id:'j'}]])
    await assert.rejects(f.bridge[name](args),e=>e.data.code==='transport_unknown');
});

const waveformFixture=JSON.parse(await readFile(new URL('./fixtures/onboarding-waveforms.example.json',import.meta.url),'utf8'));
async function waveFixture({mutate,mutateSession,wrapped=false}={}){
  const source=structuredClone(waveformFixture),descriptor=source.descriptor,run=descriptor.run_id,planId='b'.repeat(64);
  if(wrapped){
    descriptor.original_source_sha256='d'.repeat(64);descriptor.transformation='added_explicit_subcircuit_wrapper';
    for(const request of source.requests){request.response.data.original_source_sha256=descriptor.original_source_sha256;request.response.data.transformation=descriptor.transformation;}
  }
  const snapshot={schema:'ic.onboarding.session.v1',connection_id:'store-A',intake_id:descriptor.intake_id,revision:3,source_sha256:descriptor.original_source_sha256,source_commit:descriptor.source_commit,
    prepared:{schema:'ic.experiment.plan.v1',state:'prepared',plan_id:planId,source_commit:descriptor.source_commit,project_id:descriptor.intake_id,recipe_id:'fixture'},
    source_mapping:{source_commit:descriptor.source_commit,source_id:descriptor.compiled_source_path,original_source_sha256:descriptor.original_source_sha256,compiled_source_sha256:descriptor.compiled_source_sha256,transformation:descriptor.transformation}};
  mutateSession?.(snapshot);
  const job={schema:'ic.experiment.job.v1',job_id:run,run_id:run,plan_id:planId,source_commit:descriptor.source_commit,project_id:descriptor.intake_id,configuration:'fixture',waveforms:descriptor};
  const f=fixture({respond:async(path)=>{
    if(path.endsWith('/netlist'))return snapshot;
    const op=path.split('?')[0].split('/').pop(),result=structuredClone(source.requests.find(row=>row.path.endsWith('/'+op)).response.data);
    return mutate?mutate(result,op):result;
  }});
  await f.bridge.connect({port:18885});await f.bridge.inspectNetlist({file_name:'synthetic.scs',text:source.source_text});
  return {...f,run,job,source,snapshot,provider:f.bridge.waveformApi({intake_id:descriptor.intake_id,job})};
}
test('saved native-reader fixture is scoped and unwrapped only after source and archive validation',async()=>{
  const f=await waveFixture(),id=f.source.descriptor.available_signal_ids[0];
  await f.provider.catalog(f.run);await f.provider.mapping(f.run);
  const actual=await f.provider.waveform(f.run,id,{start:0,end:2e-9,limit:1600,cursor_a:1e-9});
  assert.deepEqual(actual,f.source.requests[2].response.data.series[0]);
  const url=new URL(f.calls.at(-1).path,'http://fixture');
  assert.deepEqual(Object.fromEntries(url.searchParams),{intake_id:f.snapshot.intake_id,job_id:f.run,signal_ids:id,start:'0',stop:'2e-9',max_points:'1600'});
  assert.equal(actual.measurement.uses_display_samples,false);assert.deepEqual(actual.measurement.cursors,{});
  assert.equal(f.calls.some(call=>call.path.includes('/ai/')),false);
});
test('explicit wrapper keeps original input and compiled source identities distinct',async()=>{
  const f=await waveFixture({wrapped:true});const data=await f.provider.catalog(f.run);
  assert.notEqual(f.snapshot.source_sha256,f.source.descriptor.compiled_source_sha256);
  assert.equal(data.source_hashes[f.source.descriptor.compiled_source_path],f.source.descriptor.compiled_source_sha256);
});
test('foreign outer scope, changed source wrapper, and changed inner content are rejected',async()=>{
  for(const change of [
    data=>{data.intake_id='foreign-intake';},data=>{data.compiled_source_sha256='0'.repeat(64);},
    data=>{data.original_source_sha256='0'.repeat(64);},data=>{data.transformation='none-but-mislabelled';},
    data=>{data.probe.enabled=true;},data=>{data.catalog.csv_sha256='0'.repeat(64);},
    data=>{data.catalog.source_hashes={};},data=>{data.catalog.raw_signature='0'.repeat(64);},
    data=>{data.catalog.signals.push({...data.catalog.signals[0],id:'s_'+'e'.repeat(32)});},
  ]){
    const f=await waveFixture({mutate:(data,op)=>{if(op==='catalog')change(data);return data;}});
    await assert.rejects(f.provider.catalog(f.run),e=>e.data.code==='waveform_identity_mismatch');
  }
});
test('signal selection, window bounds, and disconnected waveform reads fail before dispatch',async()=>{
  const f=await waveFixture(),id=f.source.descriptor.available_signal_ids[0];let before=f.calls.length;
  await assert.rejects(f.provider.waveform(f.run,id),e=>e.data.code==='waveform_identity_mismatch');assert.equal(f.calls.length,before);
  await f.provider.catalog(f.run);before=f.calls.length;
  for(const params of [{start:2,end:1},{limit:3},{start:Infinity},{analysis:'dc'}])await assert.rejects(f.provider.waveform(f.run,id,params),e=>e.data.code==='invalid_input');
  assert.equal(f.calls.length,before);f.bridge.disconnect();
  await assert.rejects(f.provider.waveform(f.run,id),e=>e.data.code==='connection_changed');assert.equal(f.calls.length,before);
});
test('available descriptor is mandatory and cannot change the selected run',async()=>{
  const f=await waveFixture();
  for(const change of [value=>value.waveforms.available=false,value=>value.waveforms.source_binding_verified=false,value=>value.waveforms.job_id='other',value=>value.waveforms.original_source_sha256='0'.repeat(64)]){
    const job=structuredClone(f.job);change(job);
    assert.throws(()=>f.bridge.waveformApi({intake_id:f.snapshot.intake_id,job}),e=>e.data.code==='waveform_identity_mismatch');
  }
});

test('descriptor source compilation must match the exact preparation mapping',async()=>{
  for(const field of ['source_id','original_source_sha256','compiled_source_sha256','transformation','source_commit'])
    await assert.rejects(waveFixture({wrapped:true,mutateSession:session=>{session.source_mapping[field]='conflicting-identity';}}),e=>e.data.code==='waveform_identity_mismatch');
  const f=await waveFixture();
  for(const field of ['project_id','configuration'])assert.throws(()=>f.bridge.waveformApi({intake_id:f.snapshot.intake_id,job:{...f.job,[field]:'other-project-or-recipe'}}),e=>e.data.code==='waveform_identity_mismatch');
});

test('both bridge transports receive the same finite operation budgets',async()=>{
  for(const gateway of [false,true]){
    const f=fixture({gateway,respond:async(path,options)=>{
      if(path.endsWith('/netlist'))return session(0);
      if(path.endsWith('/run'))return {...session(options.body.revision+1),job:{schema:'ic.experiment.job.v1',job_id:'j',run_id:'j',plan_id:plan}};
      if(path.endsWith('/inspect'))return {...session(5),job:{schema:'ic.experiment.job.v1',job_id:'j',run_id:'j',plan_id:plan}};
      return session(options.body.revision+1);
    }});
    await f.bridge.connect(gateway?{}:{port:18885});await f.bridge.inspectNetlist({file_name:'fixture.scs',text:'// fixture'});
    await f.bridge.probeHost({intake_id:intake,revision:0,ssh_targets:['one'],overrides:{setup_source_ids:{one:'observed-source'}}});assert.equal(f.calls.at(-1).timeout,80000);
    await f.bridge.discoverPdk({intake_id:intake,revision:1,probe_ids:['one','two','three']});assert.equal(f.calls.at(-1).timeout,130000);
    await f.bridge.prepareExperiment({intake_id:intake,revision:2});assert.equal(f.calls.at(-1).timeout,150000);
    await f.bridge.runPrepared({intake_id:intake,revision:3,plan_id:plan});assert.equal(f.calls.at(-1).timeout,320000);
    await f.bridge.inspectExperiment({intake_id:intake,job_id:'j'});assert.equal(f.calls.at(-1).timeout,45000);
  }
});
test('a real paired-client run timeout preserves the original key across reconnect and cannot replay',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const storage=memory(),calls=[];let dispatched;
  const started=new Promise(resolve=>dispatched=resolve);
  function make(){return createOnboardingBridge({win:{location:{origin:'https://fixture.invalid'}},
    pair:({base})=>({result:Promise.resolve({url:base,accessCode:'x'.repeat(43)}),cancel(){}}),
    pendingStore:createOnboardingPendingStore({storage}),selectionStore:createOnboardingSelectionStore({storage}),
    clientFactory:options=>createNodeClient({...options,fetchImpl:async(url,{signal})=>{
      const path=new URL(url).pathname;calls.push(path);
      if(path.endsWith('/run')){dispatched();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Timed out','AbortError')),{once:true}));}
      const data=path==='/node/info'?{schema:'circuitgit.remote-node.v1',connection_id:'store-A',single_owner:true,auth:'bearer',capabilities:{simulation_onboarding:true,simulation_onboarding_api_version:'1'}}:
        path.endsWith('/submission')?{intake_id:intake,plan_id:plan,submission_key:'experiment-'+plan,found:false,replay_permitted:false}:session(0);
      return new Response(JSON.stringify({ok:true,data}));
    }})});}
  const bridge=make();await bridge.connect({port:18885});await bridge.inspectNetlist({file_name:'fixture.scs',text:'// fixture'});
  const args={intake_id:intake,revision:0,plan_id:plan},request=bridge.runPrepared(args);await started;
  t.mock.timers.tick(320000);await assert.rejects(request,e=>e.data.code==='transport_unknown');
  const pending=await bridge.pendingStore.load({connectionId:bridge.getState().connectionId});assert.equal(pending[0].submission_key,'experiment-'+plan);
  bridge.disconnect();const reloaded=make();await reloaded.connect({port:18885});
  await assert.rejects(reloaded.runPrepared(args),e=>e.data.code==='replay_forbidden');
  assert.equal((await reloaded.readSubmission({intake_id:intake,plan_id:plan})).found,false);
  await assert.rejects(reloaded.runPrepared(args),e=>e.data.code==='replay_forbidden');assert.equal(calls.filter(path=>path.endsWith('/run')).length,1);
});

function rejectionData(){
  const planId='c'.repeat(64),commit='d'.repeat(40);
  const prepared={schema:'ic.experiment.plan.v1',state:'prepared',plan_id:planId,project_id:intake,recipe_id:'fixture-tran',source_commit:commit,submission_key:'experiment-'+planId};
  const original={...session(3),source_sha256:'e'.repeat(64),source_commit:commit,prepared,execution_scope:{candidate_host_ids:['host-one']}};
  const submission={intake_id:intake,plan_id:planId,found:false,run_id:null,submission_key:prepared.submission_key,dispatch_outcome:'pre_dispatch_rejected',replay_permitted:false,job:null,
    rejection:{schema:'ic.experiment.pre-dispatch-rejection.v1',plan_id:planId,project_id:intake,source_commit:commit,submission_key:prepared.submission_key,phase:'before_runner_reserve',code:'resource_or_dependency_preflight_rejected',launch_attempted:false,recorded_at:'2026-11-23T08:30:00Z'}};
  return {original,submission,response:{...original,revision:4,state:'pre_dispatch_rejected',job:null,submission},args:{intake_id:intake,revision:3,plan_id:planId}};
}
async function rejectionFixture({mutate,lost=false,storage}={}){
  const data=rejectionData();let run=false;
  const f=fixture({storage,respond:async path=>{
    if(path.endsWith('/netlist'))return session(1);
    if(path.includes('/session?'))return run?structuredClone(data.response):structuredClone(data.original);
    if(path.endsWith('/run')){run=true;if(lost)throw Error('lost reply');const result=structuredClone(data.response);mutate?.(result);return result;}
    if(path.includes('/submission?'))return structuredClone(data.submission);
    throw Error('Unexpected test route');
  }});
  await imported(f);await f.bridge.getSession({intake_id:intake});return {...f,...data};
}
test('typed pre-dispatch rejection must match the cached original plan and does not clear the pending identity',async()=>{
  const f=await rejectionFixture();const result=await f.bridge.runPrepared(f.args);
  assert.equal(result.state,'pre_dispatch_rejected');assert.equal(result.job,null);
  const pending=await f.bridge.pendingStore.load({connectionId:f.bridge.getState().connectionId});assert.equal(pending.length,1);assert.equal(pending[0].submission_key,f.submission.submission_key);
  assert.deepEqual(await f.bridge.readSubmission({intake_id:intake,plan_id:f.args.plan_id}),f.submission);
  await assert.rejects(f.bridge.runPrepared({...f.args,revision:4}),e=>e.data.code==='replay_forbidden');
  await f.bridge.pendingStore.remove(pending[0]);
  assert.deepEqual(await f.bridge.readSubmission({intake_id:intake,plan_id:f.args.plan_id}),f.submission,'verified original plan remains valid after UI receipt cleanup');
  const next=fixture({storage:f.storage,respond:async path=>path.includes('/session?')?f.response:f.submission});await next.bridge.connect({port:18885});await next.bridge.getSession({intake_id:intake});
  await assert.rejects(next.bridge.runPrepared({...f.args,revision:4}),e=>e.data.code==='replay_forbidden');assert.equal(next.calls.some(row=>row.method==='POST'),false);
});
test('forged or cross-source pre-dispatch claims stay unknown and retain the original request',async()=>{
  for(const mutate of [
    value=>{value.submission.rejection.launch_attempted=true;},value=>{value.submission.rejection.phase='after_runner_reserve';},
    value=>{value.submission.rejection.source_commit='f'.repeat(40);},value=>{value.submission.rejection.submission_key='other';},
    value=>{value.submission.job={job_id:'foreign'};},value=>{value.job={job_id:'foreign'};},
    value=>{value.prepared={...value.prepared,plan_id:'a'.repeat(64)};},value=>{value.source_sha256='a'.repeat(64);},
  ]){
    const f=await rejectionFixture({mutate});await assert.rejects(f.bridge.runPrepared(f.args),e=>e.data.code==='transport_unknown');
    assert.equal((await f.bridge.pendingStore.load({connectionId:f.bridge.getState().connectionId})).length,1);
    await assert.rejects(f.bridge.runPrepared(f.args),e=>e.data.code==='replay_forbidden');assert.equal(f.calls.filter(row=>row.path.endsWith('/run')).length,1);
  }
});
test('a lookup cannot promote a self-consistent rejection until the original prepared session is read',async()=>{
  const first=await rejectionFixture({lost:true});await assert.rejects(first.bridge.runPrepared(first.args),e=>e.data.code==='transport_unknown');
  const next=fixture({storage:first.storage,respond:async path=>path.includes('/session?')?first.original:first.submission});await next.bridge.connect({port:18885});
  const lookup={intake_id:intake,plan_id:first.args.plan_id};
  await assert.rejects(next.bridge.readSubmission(lookup),e=>e.data.code==='transport_unknown');
  assert.equal((await next.bridge.pendingStore.load({connectionId:next.bridge.getState().connectionId})).length,1);
  await next.bridge.getSession({intake_id:intake});assert.deepEqual(await next.bridge.readSubmission(lookup),first.submission);
  await assert.rejects(next.bridge.runPrepared(first.args),e=>e.data.code==='replay_forbidden');assert.equal(next.calls.some(row=>row.method==='POST'),false);
});

test('same-origin Gateway timeout also retains the original submission instead of replaying',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const storage=memory(),calls=[];let dispatched;
  const started=new Promise(resolve=>dispatched=resolve),info={connection_id:'store-A',mutation_token:'fixture-token',capabilities:{simulation_onboarding:true,simulation_onboarding_api_version:'1'}};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push(url);
    if(url.endsWith('/run')){assert.equal(options.headers['X-Workbench-Token'],'fixture-token');dispatched();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Timed out','AbortError')),{once:true}));}
    return new Response(JSON.stringify({ok:true,data:url.endsWith('/health')?info:session(1)}));
  });
  const make=()=>createOnboardingBridge({gateway:new Gateway(),win:{location:{origin:'http://127.0.0.1:18884'}},pendingStore:createOnboardingPendingStore({storage}),selectionStore:createOnboardingSelectionStore({storage})});
  const bridge=make();await bridge.connect();await bridge.inspectNetlist({file_name:'fixture.scs',text:'// fixture'});
  const args={intake_id:intake,revision:1,plan_id:plan},request=bridge.runPrepared(args);await started;t.mock.timers.tick(320000);
  await assert.rejects(request,e=>e.data.code==='transport_unknown');bridge.disconnect();
  const restored=make();await restored.connect();assert.equal((await restored.pendingStore.load({connectionId:restored.getState().connectionId}))[0].submission_key,'experiment-'+plan);
  await assert.rejects(restored.runPrepared(args),e=>e.data.code==='replay_forbidden');assert.equal(calls.filter(path=>path.endsWith('/run')).length,1);
});
