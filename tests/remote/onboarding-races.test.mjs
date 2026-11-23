import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOnboardingBridge,createOnboardingSelectionStore} from '../../apps/web/remote/onboarding-bridge.js';
import {createOnboardingSync} from '../../apps/web/remote/onboarding-sync.js';

// Every request is an in-memory fixture. No browser, model, SSH or simulator runs.
const STORE='a'.repeat(32),OTHER_STORE='e'.repeat(32);
const OLD='intake_'+'b'.repeat(32),NEXT='intake_'+'c'.repeat(32),NEWER='intake_'+'d'.repeat(32);
const SOURCE={file_name:'inv.scs',text:'subckt inv A Y VDD VSS\nends inv\n'};
const HASH=createHash('sha256').update(SOURCE.text).digest('hex');
const session=(intake_id=OLD,revision=1)=>({schema:'ic.onboarding.session.v1',connection_id:STORE,
  intake_id,revision,source_sha256:HASH,source_commit:null,source:{file_name:SOURCE.file_name}});
const info=(connection_id=STORE)=>({schema:'circuitgit.remote-node.v1',single_owner:true,auth:'bearer',connection_id,
  capabilities:{chat:true,simulation_onboarding:true,simulation_onboarding_api_version:'1'}});
const scope=(base='http://127.0.0.1:18885',store=STORE)=>'paired-local|'+base+'|'+store;
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function memory(){const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};}
function client(base='http://127.0.0.1:18885',store=STORE){
  const calls=[];let closed=0;
  return {base,calls,get closed(){return closed;},close(){closed++;},async request(path,options={}){
    calls.push({path,options});
    if(path==='/node/info')return info(store);
    const url=new URL(path,base);
    assert.equal(url.pathname,'/simulation/onboarding/session');
    assert.equal(options.method,'GET');
    return {...session(url.searchParams.get('intake_id')),connection_id:store};
  }};
}
const pendingStore={async load(){return[];}};

function syncFixture({hashText=()=>HASH,read}={}){
  let current=session(),state={connected:true,connectionId:scope(),storeIdentity:STORE,selectedIntakeId:OLD};
  const calls=[];
  const bridge={getState:()=>({...state}),getSessionState:()=>structuredClone(current),subscribe:()=>()=>{},
    async getSession(args){calls.push(args);return read?read(args):structuredClone(current);}};
  const sync=createOnboardingSync({bridge,getSource:()=>({...SOURCE}),hashText});
  return {sync,state,calls,set session(value){current=value;}};
}

test('context hashing rejects an intake or store switch even when source bytes are identical',async()=>{
  for(const change of [state=>state.selectedIntakeId=NEXT,state=>state.storeIdentity=OTHER_STORE]){
    const started=deferred(),finish=deferred();
    const f=syncFixture({hashText:async()=>{started.resolve();await finish.promise;return HASH;}});
    try{
      const context=f.sync.contextFor();await started.promise;change(f.state);finish.resolve();
      assert.equal(await context,null);
    }finally{f.sync.destroy();}
  }
});

test('send-time refresh reads the selected intake instead of reusing an older cached revision',async()=>{
  const f=syncFixture({read:async args=>session(args.intake_id,2)});
  try{
    assert.equal((await f.sync.contextFor()).onboarding.revision,1);
    assert.equal(f.calls.length,0);
    const actual=await f.sync.contextFor({refresh:true,required:true,connectionId:STORE});
    assert.equal(actual.onboarding.revision,2);
    assert.deepEqual(f.calls,[{intake_id:OLD}]);
    assert.equal(actual.project.sourceCommit,null);
  }finally{f.sync.destroy();}
});

test('a send-time readback arriving after intake selection changed cannot become AI context',async()=>{
  const started=deferred(),finish=deferred();
  const f=syncFixture({read:async()=>{started.resolve();await finish.promise;return session();}});
  try{
    const context=f.sync.contextFor({refresh:true,required:true});
    const rejected=assert.rejects(context,/当前电路/);
    await started.promise;f.state.selectedIntakeId=NEXT;finish.resolve();await rejected;
    assert.deepEqual(f.calls,[{intake_id:OLD}]);
  }finally{f.sync.destroy();}
});

test('pending borrowed connection is exclusive and its cancellation cannot overwrite a newer client',async()=>{
  const started=deferred(),finish=deferred(),a=client(),b=client('http://127.0.0.1:18886',OTHER_STORE);
  const bridge=createOnboardingBridge({pendingStore:{async load({connectionId}){
    if(connectionId===scope()){started.resolve();await finish.promise;}return[];
  }},selectionStore:createOnboardingSelectionStore({storage:memory()})});
  try{
    const binding=bridge.bindClient(a,info());await started.promise;
    await assert.rejects(bridge.bindClient(b,info(OTHER_STORE)),error=>error.data.code==='connection_busy');
    assert.equal(bridge.unbindClient(a),true);
    await bridge.bindClient(b,info(OTHER_STORE));
    const rejected=assert.rejects(binding,error=>error.data.code==='connection_changed');
    finish.resolve();await rejected;
    assert.equal(bridge.getState().endpoint,b.base);
    assert.equal(bridge.getState().storeIdentity,OTHER_STORE);
    assert.equal(bridge.unbindClient(a),false);
    assert.equal(a.closed,0);assert.equal(b.closed,0);
  }finally{bridge.disconnect();}
});

test('disconnecting the former AI owner leaves a later independently connected simulation client open',async()=>{
  const a=client(),b=client('http://127.0.0.1:18886',OTHER_STORE);
  const bridge=createOnboardingBridge({pendingStore,selectionStore:createOnboardingSelectionStore({storage:memory()}),
    pair:({base})=>({result:Promise.resolve({url:base,accessCode:'synthetic'}),cancel(){}}),clientFactory:()=>b});
  await bridge.bindClient(a,info());await bridge.connect({port:18886});
  assert.equal(bridge.unbindClient(a),false);
  assert.equal(bridge.getState().connected,true);assert.equal(bridge.getState().endpoint,b.base);
  assert.equal(a.closed,0);assert.equal(b.closed,0);
  bridge.disconnect();assert.equal(b.closed,1);assert.equal(a.closed,0);
});

async function adoptionFixture({previous=OLD}={}){
  const store=createOnboardingSelectionStore({storage:memory()}),started=deferred(),finish=deferred();
  if(previous)await store.remember({connectionId:scope(),intake_id:previous});
  const selectionStore={...store,async remember(row){await store.remember(row);
    if(row.intake_id===NEXT){started.resolve();await finish.promise;}}};
  const transport=client();const bridge=createOnboardingBridge({pendingStore,selectionStore});
  await bridge.bindClient(transport,info());
  return {bridge,store,transport,started,finish};
}

test('source switching during durable adoption restores the exact previous selection, including an empty one',async()=>{
  for(const previous of [OLD,null]){
    const f=await adoptionFixture({previous});let sourceCurrent=true;
    try{
      const adoption=f.bridge.adoptIntake(session(NEXT),{isCurrent:()=>sourceCurrent});
      const rejected=assert.rejects(adoption,error=>error.data.code==='source_changed');
      await f.started.promise;sourceCurrent=false;f.finish.resolve();await rejected;
      assert.equal(f.bridge.getState().selectedIntakeId,previous);
      assert.equal(await f.store.load({connectionId:scope()}),previous);
      f.bridge.disconnect();await f.bridge.bindClient(f.transport,info());
      assert.equal(f.bridge.getState().selectedIntakeId,previous,'reload preserves the rolled-back selection');
    }finally{f.bridge.disconnect();}
  }
});

test('source rollback never overwrites another tab newer durable selection',async()=>{
  const f=await adoptionFixture();let sourceCurrent=true;
  try{
    const adoption=f.bridge.adoptIntake(session(NEXT),{isCurrent:()=>sourceCurrent});
    const rejected=assert.rejects(adoption,error=>error.data.code==='source_changed');
    await f.started.promise;
    await f.store.remember({connectionId:scope(),intake_id:NEWER});
    sourceCurrent=false;f.finish.resolve();await rejected;
    assert.equal(await f.store.load({connectionId:scope()}),NEWER);
    assert.equal(f.bridge.getState().selectedIntakeId,OLD);
  }finally{f.bridge.disconnect();}
});

test('disconnect during adoption removes stale persistence without reviving a borrowed connection',async()=>{
  const f=await adoptionFixture();
  try{
    const adoption=f.bridge.adoptIntake(session(NEXT));
    const rejected=assert.rejects(adoption,error=>error.data.code==='source_changed');
    await f.started.promise;assert.equal(f.bridge.unbindClient(f.transport),true);
    f.finish.resolve();await rejected;
    assert.equal(f.bridge.getState().connected,false);
    assert.equal(f.bridge.getState().selectedIntakeId,null);
    assert.equal(await f.store.load({connectionId:scope()}),OLD);
    assert.equal(f.transport.closed,0);
  }finally{f.bridge.disconnect();}
});

test('queued newer adoption wins after the superseded pending selection is restored',async()=>{
  const f=await adoptionFixture();
  try{
    const old=f.bridge.adoptIntake(session(NEXT));
    const rejected=assert.rejects(old,error=>error.data.code==='source_changed');
    await f.started.promise;
    const newer=f.bridge.adoptIntake(session(NEWER));
    f.finish.resolve();await rejected;await newer;
    assert.equal(f.bridge.getState().selectedIntakeId,NEWER);
    assert.equal(await f.store.load({connectionId:scope()}),NEWER);
    assert.equal(f.transport.calls.filter(row=>row.options.method!=='GET').length,0);
  }finally{f.bridge.disconnect();}
});

test('an old AI tool result cannot replace an intake explicitly selected while its source hash was pending',async()=>{
  const selectionStore=createOnboardingSelectionStore({storage:memory()});
  await selectionStore.remember({connectionId:scope(),intake_id:OLD});
  const transport=client(),bridge=createOnboardingBridge({pendingStore,selectionStore});
  await bridge.bindClient(transport,info());
  const started=deferred(),finish=deferred();let first=true;
  const sync=createOnboardingSync({bridge,getSource:()=>({...SOURCE}),hashText:async()=>{
    if(first){first=false;started.resolve();await finish.promise;}return HASH;
  }});
  try{
    const oldResult=sync.handleToolResult({tool:'ic_onboarding_netlist',result:session(NEXT)});
    await started.promise;
    await bridge.adoptIntake(session(NEWER));
    finish.resolve();await oldResult;
    assert.equal(bridge.getState().selectedIntakeId,NEWER);
    assert.equal(await selectionStore.load({connectionId:scope()}),NEWER);
  }finally{sync.destroy();bridge.disconnect();}
});
