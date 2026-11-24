import test from 'node:test';
import assert from 'node:assert/strict';
import {createOnboardingBridge,createOnboardingPendingStore,createOnboardingSelectionStore} from '../../apps/web/remote/onboarding-bridge.js';
import {isOnboardingRequest,pdkScopeQuery,checkPdkScopeSelection} from '../../apps/web/remote/client.js';

const identity={intake_id:'intake_'+'a'.repeat(32),probe_id:'probe_'+'b'.repeat(32),library_id:'c'.repeat(64)};
const entry='d'.repeat(64),sections=['e'.repeat(64),'f'.repeat(64)],source='1'.repeat(64),selectionId='2'.repeat(64);
const save={...identity,revision:3,entry_id:entry,section_ids:sections};
const baseSession=()=>({schema:'ic.onboarding.session.v1',connection_id:'scope-store',intake_id:identity.intake_id,revision:3,source_sha256:source});
const selected=()=>({...baseSession(),revision:4,pdk_scope_selection:{selection_id:selectionId,probe_id:identity.probe_id,
  library_id:identity.library_id,entry_id:entry,section_ids:sections,sections:['MOS','CAP'],source_sha256:source,requirements_sha256:'3'.repeat(64),
  required_model_names:['synthetic'],covered_model_names:['synthetic'],missing_model_names:[],model_declarations:[{name:'synthetic',declaration_count:1,port_counts:[4]}],
  scope:{node_count:2,file_count:1,namespace_model_count:1},tmi_options:[],selected_tmi_option_id:null,missing:[],library_complete_within_policy:false,
  scientific_compatibility:'not_evaluated',model_contracts_reused:false,status:'requires_audit',ready_to_run:false,fresh_audit_required:true}});
const catalog=()=>({schema:'ic.onboarding.pdk-scopes.v1',connection_id:'scope-store',intake_id:identity.intake_id,
  probe_id:identity.probe_id,revision:3,catalog:{schema:'spiceowl.pdk-scope-catalog.v1',library_id:identity.library_id,entry_id:null,
    kind:'entries',items:[{entry_id:entry,label:'synthetic.scs',entry_sha256:'4'.repeat(64),section_count:2}],total:1,next_offset:null,
    status:'available',missing:[],library_complete_within_policy:false,ready_to_run:false}});
async function fixture(respond){
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},calls=[];
  const gateway={health:async()=>({connection_id:'scope-store',capabilities:{simulation_onboarding:true,simulation_onboarding_api_version:'1'}}),
    request:async(path,options)=>{calls.push({path,options});return path.endsWith('/netlist')?baseSession():respond(path,options);}};
  const bridge=createOnboardingBridge({gateway,win:{location:{origin:'http://127.0.0.1:1'}},
    pendingStore:createOnboardingPendingStore({storage}),selectionStore:createOnboardingSelectionStore({storage})});
  await bridge.connect();await bridge.inspectNetlist({file_name:'synthetic.scs',text:'synthetic'});
  return {bridge,calls};
}

test('catalog query accepts only exact cached identity and bounded optional pagination',()=>{
  const path='/simulation/onboarding/pdk-scopes?'+pdkScopeQuery({...identity,entry_id:entry,offset:64,limit:128});
  assert(isOnboardingRequest(path,'GET'));assert(!isOnboardingRequest(path,'POST'));
  for(const suffix of ['&path=/private','&refresh=true','&entry_id='+entry,'&offset=1'])assert(!isOnboardingRequest(path+suffix,'GET'));
  for(const extra of [{limit:0},{limit:129},{offset:true},{offset:16385},{entry_id:null},{entry_id:'/private'}, {offset:'1'}])
    assert.throws(()=>pdkScopeQuery({...identity,...extra}));
  for(const bad of ['NaN','1e2','-1','01','Infinity'])assert(!isOnboardingRequest('/simulation/onboarding/pdk-scopes?'+pdkScopeQuery(identity)+'&offset='+bad,'GET'));
});

test('catalog keeps current store/intake/probe/library revision and ordered selection uses one local CAS',async()=>{
  const f=await fixture(path=>path.includes('pdk-scopes?')?catalog():selected());
  assert.deepEqual(await f.bridge.getPdkScopes(identity),catalog());
  assert.equal(f.calls.at(-1).options.method,'GET');assert.equal(f.calls.at(-1).options.timeout,20000);
  const result=await f.bridge.selectPdkScope(save);
  assert.deepEqual(result.pdk_scope_selection.section_ids,sections);
  assert.deepEqual(f.calls.at(-1).options.body,save);assert.equal(f.calls.at(-1).options.timeout,20000);
  assert.equal(f.calls.filter(row=>row.options.method==='POST').length,2); // Import and scope save only.
});

test('foreign catalog and malformed pagination never become browser choices',async()=>{
  for(const mutate of [v=>v.connection_id='other',v=>v.probe_id='probe_'+'0'.repeat(32),v=>v.revision=4,
    v=>v.catalog.library_id='0'.repeat(64),v=>v.catalog.ready_to_run=true,v=>v.catalog.next_offset=0,
    v=>v.catalog.items.push(v.catalog.items[0]),v=>delete v.catalog.status,
    v=>delete v.catalog.items[0].entry_sha256,v=>v.catalog.total=2,v=>v.catalog.items=[]]){
    const result=catalog();mutate(result);const f=await fixture(()=>result);
    await assert.rejects(f.bridge.getPdkScopes(identity),e=>e.data.code==='pdk_scope_mismatch');
  }
});

test('selection rejects inferred sections, duplicates, mixed legacy identities and implicit TMI null',()=>{
  assert.deepEqual(checkPdkScopeSelection(save),save);
  for(const extra of [{section_ids:['TT']},{section_ids:[]},{section_ids:[sections[0],sections[0]]},
    {section_ids:Array.from({length:65},(_,i)=>i.toString(16).padStart(64,'0'))},{candidate_id:entry},{tmi_option_id:null},{revision:true}])
    assert.throws(()=>checkPdkScopeSelection({...save,...extra}));
});

test('a reordered or mismatched save receipt stays unknown and is never replayed automatically',async()=>{
  for(const mutate of [v=>v.pdk_scope_selection.section_ids=[...sections].reverse(),v=>v.source_sha256='0'.repeat(64),
    v=>v.revision=5,v=>v.pdk_scope_selection.ready_to_run=true,v=>v.pdk_scope_selection.probe_id='other',
    v=>v.pdk_scope_selection.selected_tmi_option_id='5'.repeat(64)]){
    const result=selected();mutate(result);const f=await fixture(()=>result);
    await assert.rejects(f.bridge.selectPdkScope(save),e=>e.data.code==='transport_unknown');
    await assert.rejects(f.bridge.selectPdkScope(save),e=>e.data.code==='scope_reconciliation_required');
    assert.equal(f.calls.filter(row=>row.path.endsWith('/select-pdk-scope')).length,1);
  }
});

test('only original-session readback after an unknown scope save unlocks an explicit retry',async()=>{
  let fail=true;
  const f=await fixture(path=>{if(path.endsWith('/select-pdk-scope')){if(fail)throw Error('lost');return selected();}return baseSession();});
  await assert.rejects(f.bridge.selectPdkScope(save),e=>e.data.code==='transport_unknown');
  await assert.rejects(f.bridge.selectPdkScope(save),e=>e.data.code==='scope_reconciliation_required');
  assert.equal(f.calls.filter(row=>row.path.endsWith('/select-pdk-scope')).length,1);
  await f.bridge.getSession({intake_id:identity.intake_id});fail=false;
  assert.equal((await f.bridge.selectPdkScope(save)).revision,4);
});

test('a session read overlapping a still-pending write cannot reconcile its later lost response',async()=>{
  let rejectWrite,readReply;
  const f=await fixture(path=>path.endsWith('/select-pdk-scope')?new Promise((_r,reject)=>rejectWrite=reject):new Promise(resolve=>readReply=resolve));
  const write=f.bridge.selectPdkScope(save),read=f.bridge.getSession({intake_id:identity.intake_id});
  rejectWrite(Error('lost'));await assert.rejects(write,e=>e.data.code==='transport_unknown');
  readReply(baseSession());await read;
  await assert.rejects(f.bridge.selectPdkScope(save),e=>e.data.code==='scope_reconciliation_required');
});

test('a late older session read cannot replace a successful scope-save revision',async()=>{
  let release;const f=await fixture(path=>path.includes('/session?')?new Promise(resolve=>release=resolve):
    path.includes('/pdk-scopes?')?{...catalog(),revision:4}:selected());
  const old=f.bridge.getSession({intake_id:identity.intake_id});
  await f.bridge.selectPdkScope(save);release(baseSession());
  await assert.rejects(old,e=>e.data.code==='stale_session_response');
  assert.equal((await f.bridge.getPdkScopes(identity)).revision,4);
});

test('an AI adoption read cannot restore an older revision after a successful scope save',async()=>{
  let release;const f=await fixture(path=>path.includes('/session?')?new Promise(resolve=>release=resolve):
    path.includes('/pdk-scopes?')?{...catalog(),revision:4}:selected());
  const old=f.bridge.adoptIntake({connection_id:'scope-store',intake_id:identity.intake_id,source_sha256:source});
  await f.bridge.selectPdkScope(save);release(baseSession());
  await assert.rejects(old,e=>e.data.code==='stale_session_response');
  assert.equal((await f.bridge.getPdkScopes(identity)).revision,4);
});

test('a same-revision in-progress snapshot cannot replace the completed operation',async()=>{
  for(const adopt of [false,true]){
    const operation={operation_id:'6'.repeat(32),status:'completed'};
    let release;const f=await fixture(path=>path.includes('/session?')?new Promise(resolve=>release=resolve):
      path.includes('/pdk-scopes?')?{...catalog(),revision:4}:{...selected(),operation});
    const old=adopt?f.bridge.adoptIntake({connection_id:'scope-store',intake_id:identity.intake_id,source_sha256:source}):
      f.bridge.getSession({intake_id:identity.intake_id});
    await f.bridge.selectPdkScope(save);
    release({...baseSession(),revision:4,state:'select-pdk-scope',operation:{...operation,status:'active'}});
    await assert.rejects(old,e=>e.data.code==='stale_session_response');
    assert.equal((await f.bridge.getPdkScopes(identity)).revision,4);
  }
});

test('a delayed catalog cannot overwrite a newer intake revision read while it was pending',async()=>{
  let release;const f=await fixture(path=>path.includes('pdk-scopes?')?new Promise(resolve=>release=resolve):selected());
  const old=f.bridge.getPdkScopes(identity);
  await f.bridge.getSession({intake_id:identity.intake_id});release(catalog());
  await assert.rejects(old,e=>e.data.code==='pdk_scope_mismatch');
});
