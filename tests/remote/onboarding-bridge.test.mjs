import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createOnboardingBridge,createOnboardingPendingStore,createOnboardingSelectionStore,snapshotOnboardingSource} from '../../apps/web/remote/onboarding-bridge.js';

const intake='intake-public-fixture',plan='plan-fixture';
const session=revision=>({schema:'ic.onboarding.session.v1',connection_id:'store-A',intake_id:intake,revision,source_commit:null});
function memory(){const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};}
function fixture({storage=memory(),storeId='store-A',gateway=false,respond}={}){
  const calls=[],pairs=[],info={schema:'circuitgit.remote-node.v1',node_id:'node-fixture',connection_id:storeId,single_owner:true,auth:'bearer',capabilities:{chat:false,simulation_onboarding:true,simulation_onboarding_api_version:'1',override_fields:['spectre_path']}};
  let closed=0;
  const transport={base:'http://127.0.0.1:18885',close(){closed++;},health:async()=>{calls.push({path:'/health'});return info;},request:async(path,options={})=>{calls.push({path,...options});if(path==='/node/info')return info;if(respond)return respond(path,options);if(path.endsWith('/netlist'))return session(0);if(path.endsWith('/probe'))return session(options.body.revision+1);if(path.endsWith('/prepare'))return {...session(options.body.revision+1),prepared:{plan_id:plan,submission_key:'experiment-'+plan}};if(path.includes('/session?'))return session(2);if(path.includes('/submission?'))return {intake_id:intake,plan_id:plan,submission_key:'experiment-'+plan,found:false,replay_permitted:false};return {hosts:[]};}};
  const bridge=createOnboardingBridge({win:{location:{origin:'http://127.0.0.1:18884'}},gateway:gateway?transport:null,pair:options=>{pairs.push(options);return {result:Promise.resolve({url:options.base,accessCode:'x'.repeat(43)}),cancel(){}};},clientFactory:()=>transport,pendingStore:createOnboardingPendingStore({storage}),selectionStore:createOnboardingSelectionStore({storage})});
  return {bridge,storage,calls,pairs,info,get closed(){return closed;}};
}
async function imported(f){await f.bridge.connect({port:18885});await f.bridge.inspectNetlist({file_name:'inverter.scs',text:'subckt INV A Y VDD VSS\nends INV\n'});}

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
  assert.deepEqual(f.calls.at(-1),{path:'/simulation/onboarding/probe',method:'POST',body:args});
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
