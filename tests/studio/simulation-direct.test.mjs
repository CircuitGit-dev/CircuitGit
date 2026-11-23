import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createController} from '../../modules/simulation/model.js';

const COMMIT='a'.repeat(40), HASH='b'.repeat(64);
function storage(){const values=new Map();return {get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values};}
const submitReceipt=(changes={})=>({run_id:'fixture-run',project_id:'demo',source_commit:COMMIT,configuration:'tran',state:'submitted',...changes});
function fixture({control,lookup,store=storage(),base='http://127.0.0.1:8766/api'}={}){
  const calls=[],listeners=new Set();
  let project='demo',runs=[],context={project:{id:project,sourceCommit:COMMIT},file:{dirty:false},loadState:'ready',loading:false};
  const record=(name,fn)=>async(...args)=>{calls.push({name,args:structuredClone(args)});return fn(...args);};
  const host={version:1,context:{getContext:()=>context,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}},
    getProject:()=>({activeProjectId:project,source_commit:COMMIT,projects:[{id:project,configurations:[{id:'tran'}]}]}),
    getRuns:()=>runs,slots:{simulation:{setBadge(){}}},notify(){},
    refresh:record('refresh',async()=>{}),selectRun:record('selectRun',async()=>{}),gateway:{base,
      request:record('request',async(path,options)=>{
        if(path==='/simulation/control')return control?control(options.body):submitReceipt();
        if(path.startsWith('/submissions/'))return lookup?lookup(decodeURIComponent(path.slice('/submissions/'.length))):{schema:'ic.submission.lookup.v1',submission_key:decodeURIComponent(path.slice('/submissions/'.length)),read_at:new Date().toISOString(),found:true,run_id:'fixture-run',run:submitReceipt({original_project_id:'demo'})};
        assert.ok(path.startsWith('/configuration?'));
        const query=new URLSearchParams(path.split('?')[1]);
        return {schema:'ic.sim.configuration-description.v1',project_id:query.get('project_id'),configuration:'tran',source_commit:COMMIT,
          configuration_path:'projects/demo/config.json',configuration_sha256:HASH,configuration_text:'{}',effective:{compiled_inputs_sha256:HASH}};
      }),
      plan:record('plan',async()=>{throw Error('Direct operation must use runtime endpoint');}),
      preflight:record('preflight',async()=>{throw Error('No separate direct preflight');}),
      submit:record('submit',async()=>{throw Error('Direct operation must use runtime endpoint');}),
    }};
  return {host,calls,store,listeners,of:name=>calls.filter(call=>call.name===name),controls:()=>calls.filter(call=>call.name==='request'&&call.args[0]==='/simulation/control'),
    setRuns(value){runs=value;listeners.forEach(fn=>fn());},
    switchProject(id){project=id;context={...context,project:{id,sourceCommit:COMMIT}};listeners.forEach(fn=>fn());}};
}
async function ready(f,t){const c=createController(f.host,()=>{},{storage:f.store});t.after(()=>c.destroy());await c.ready();return c;}
const originalRun=(changes={})=>({run_id:'fixture-run',project_id:'demo',source_commit:COMMIT,configuration:'tran',state:'simulator_failed',...changes});

test('direct submit uses one finite runtime action with current committed identity and a stable key',async t=>{
  const f=fixture(),c=await ready(f,t);await c.runDirect();
  const [{args:[path,options]}]=f.controls();
  assert.equal(path,'/simulation/control');assert.equal(options.method,'POST');
  assert.deepEqual(options.body.arguments,{project_id:'demo',configuration:'tran',source_commit:COMMIT});
  assert.equal(options.body.operation,'submit');assert.match(options.body.idempotency_key,/^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(options.body).sort(),['arguments','idempotency_key','operation']);
  assert.equal(f.of('plan').length,0);assert.equal(f.of('preflight').length,0);assert.equal(f.of('submit').length,0);
  assert.equal(c.state.lastReceipt.run_id,'fixture-run');assert.deepEqual(f.of('selectRun')[0].args,['fixture-run']);
  await assert.rejects(c.runDirect());assert.equal(f.controls().length,1);
});

test('direct submission refuses unsaved drafts before contacting gateway',async t=>{
  const f=fixture(),c=await ready(f,t);c.edit(['analysis','stop'],'2n');
  await assert.rejects(c.runDirect(),/草稿/);assert.equal(f.controls().length,0);
});

test('unknown direct dispatch retains same key and blocks rekeying after reload',async t=>{
  const f=fixture({control:async()=>{throw Error('Synthetic uncertain transport');}}),c=await ready(f,t);
  await assert.rejects(c.runDirect(),/uncertain/);const attempt=structuredClone(c.state.submitAttempt);
  await c.reload();await assert.rejects(c.runDirect());assert.deepEqual(c.state.submitAttempt,attempt);assert.equal(f.controls().length,1);
});

test('malformed direct submission receipt stops followup and preserves original action',async t=>{
  const f=fixture({control:async()=>({state:'unknown'})}),c=await ready(f,t);
  await assert.rejects(c.runDirect(),/回执/);assert.ok(c.state.submitAttempt.idempotency_key);
  assert.equal(f.of('selectRun').length,0);await assert.rejects(c.runDirect());assert.equal(f.controls().length,1);
});

test('late direct submission cannot select an old run in the newly active project',async t=>{
  let resolve;const f=fixture({control:()=>new Promise(done=>{resolve=done;})}),c=await ready(f,t);
  const pending=c.runDirect();f.switchProject('other');await c.ready();resolve(submitReceipt());await pending;
  assert.equal(c.state.projectId,'other');assert.equal(c.state.lastReceipt,null);assert.equal(f.of('selectRun').length,0);
});

test('lost reply survives controller destruction and remount with only original-key GET reconciliation',async t=>{
  const f=fixture({control:async body=>{if(body.operation==='submit')throw Error('reply lost after remote dispatch');return {run_id:'fixture-run',state:'collecting'};}}),first=await ready(f,t);
  await assert.rejects(first.runDirect());const key=first.state.directPending.idempotency_key;first.destroy();
  assert.equal(f.listeners.size,0);assert.equal(f.store.length,1);
  const next=await ready(f,t);assert.equal(next.state.directPending.idempotency_key,key);assert.equal(next.directSubmissionBlocked(),true);
  await assert.rejects(next.runDirect());assert.equal(f.controls().length,1);
  const found=await next.lookupDirect();assert.equal(found.run_id,'fixture-run');assert.equal(f.controls().length,1);
  assert.deepEqual(f.of('request').filter(call=>call.args[0].startsWith('/submissions/')).map(call=>call.args),[['/submissions/'+key,{method:'GET'}]]);
  assert.equal(next.state.directPending,null);assert.equal(next.state.lastReceipt.run_id,'fixture-run');assert.equal(next.state.suspended,false);
  assert.equal(f.store.length,0);assert.deepEqual(f.of('selectRun').at(-1).args,['fixture-run']);
  f.setRuns([originalRun()]);await next.collectDirect('fixture-run');
  assert.equal(f.controls().filter(call=>call.args[1].body.operation==='submit').length,1);
});

test('a missing original mapping retains the original key and never permits another POST',async t=>{
  const f=fixture({control:async()=>{throw Error('unknown');},lookup:key=>({schema:'ic.submission.lookup.v1',submission_key:key,read_at:new Date().toISOString(),found:false,run_id:null,run:null})});
  const first=await ready(f,t);await assert.rejects(first.runDirect());first.destroy();const next=await ready(f,t);
  await next.lookupDirect();assert.equal(next.state.directLookup.found,false);assert.equal(f.store.length,1);
  await assert.rejects(next.runDirect());assert.equal(f.controls().length,1);assert.equal(f.of('selectRun').length,0);
});

test('lookup rejects mismatched original project source configuration key and run',async t=>{
  for(const changed of [{run:{project_id:'other'}},{run:{original_project_id:'other'}},{run:{source_commit:'c'.repeat(40)}},{run:{configuration:'other'}},{run_id:'other-run'},{submission_key:'different-key'},{run:{job_id:'other-run'}}]){
    const f=fixture({control:async()=>{throw Error('unknown');},lookup:key=>({schema:'ic.submission.lookup.v1',submission_key:key,read_at:new Date().toISOString(),found:true,run_id:'fixture-run',...changed,run:submitReceipt({original_project_id:'demo',...changed.run})})});
    const c=await ready(f,t);await assert.rejects(c.runDirect());await assert.rejects(c.lookupDirect(),/身份/);
    assert.equal(f.store.length,1);assert.equal(f.controls().length,1);assert.equal(f.of('selectRun').length,0);
  }
});

test('submit receipt identity mismatch remains pending instead of selecting or garbage collecting',async t=>{
  for(const changed of [{project_id:'other'},{source_commit:'c'.repeat(40)},{configuration:'other'},{job_id:'other-run'}]){
    const f=fixture({control:async()=>submitReceipt(changed)}),c=await ready(f,t);
    await assert.rejects(c.runDirect(),/身份/);assert.equal(f.store.length,1);assert.equal(f.of('selectRun').length,0);
  }
});

test('pending storage is gateway/project/source/config scoped and persists across project switches',async t=>{
  const store=storage(),f=fixture({store,control:async()=>{throw Error('unknown');}}),c=await ready(f,t);
  await assert.rejects(c.runDirect());const key=c.state.directPending.idempotency_key;
  f.switchProject('other');await c.ready();assert.equal(c.state.directPending,null);
  f.switchProject('demo');await c.ready();assert.equal(c.state.directPending.idempotency_key,key);
  const other=await ready(fixture({store,base:'http://127.0.0.1:9999/api'}),t);assert.equal(other.state.directPending,null);
  assert.equal(store.length,1);
});

test('unavailable corrupt or full storage prevents POST and never evicts unresolved records',async t=>{
  const broken=storage();broken.setItem=()=>{throw Error('quota');};const f=fixture({store:broken}),c=await ready(f,t);
  await assert.rejects(c.runDirect(),/quota/);assert.equal(c.directSubmissionBlocked(),true);assert.equal(f.controls().length,0);
  const full=storage();for(let i=0;i<64;i++)full.setItem('circuitgit.simulation.pending.v1:'+i,'preserve');
  const g=fixture({store:full}),d=await ready(g,t);await assert.rejects(d.runDirect(),/64/);assert.equal(full.length,64);assert.equal(g.controls().length,0);
  const h=fixture({control:async()=>{throw Error('unknown');}}),e=await ready(h,t);await assert.rejects(e.runDirect());e.destroy();
  h.store.setItem(h.store.key(0),'{broken');const remount=await ready(h,t);assert.ok(remount.state.directStorageError);await assert.rejects(remount.runDirect());assert.equal(h.controls().length,1);
});

test('confirmed actions remove only their pending metadata; late reply after disposal has no host effects',async t=>{
  let resolve;const f=fixture({control:()=>new Promise(done=>{resolve=done;})}),c=await ready(f,t);
  f.store.setItem('unrelated-setting','keep');const work=c.runDirect();assert.equal(f.store.length,2);
  const row=JSON.parse([...f.store.values.entries()].find(([key])=>key.startsWith('circuitgit.'))[1]);
  assert.deepEqual(Object.keys(row).sort(),['arguments','created_at','gateway','idempotency_key','schema']);
  c.destroy();resolve(submitReceipt());await work;assert.equal(f.listeners.size,0);assert.equal(f.of('refresh').length,0);assert.equal(f.of('selectRun').length,0);
  assert.equal(f.store.length,1);assert.equal(f.store.getItem('unrelated-setting'),'keep');
});

test('direct collection binds original historical source configuration and run',async t=>{
  const f=fixture({control:async()=>({run_id:'fixture-run',state:'collecting'})}),c=await ready(f,t);
  const historic='c'.repeat(40);f.setRuns([originalRun({source_commit:historic,configuration:'old-tran'})]);
  await c.collectDirect('fixture-run');
  assert.deepEqual(f.controls()[0].args[1],{method:'POST',body:{operation:'collect',arguments:{project_id:'demo',source_commit:historic,configuration:'old-tran',run_id:'fixture-run'},idempotency_key:'collect-fixture-run'}});
  assert.equal(f.of('submit').length,0);assert.equal(f.of('preflight').length,0);
});

test('collection rejects a missing run or a run from another project',async t=>{
  const f=fixture(),c=await ready(f,t);f.setRuns([originalRun({project_id:'other'})]);
  await assert.rejects(c.collectDirect('missing'));await assert.rejects(c.collectDirect('fixture-run'));assert.equal(f.controls().length,0);
});

test('collection cannot dispatch after the simulation controller is disposed',async t=>{
  const f=fixture(),c=await ready(f,t);f.setRuns([originalRun()]);c.destroy();
  await assert.rejects(c.collectDirect('fixture-run'));assert.equal(f.controls().length,0);
});

test('late collection result cannot overwrite the newly selected project receipt',async t=>{
  let resolve;const f=fixture({control:()=>new Promise(done=>{resolve=done;})}),c=await ready(f,t);f.setRuns([originalRun()]);
  const pending=c.collectDirect('fixture-run');f.switchProject('other');await c.ready();
  resolve({run_id:'fixture-run',state:'collecting'});await pending;
  assert.equal(c.state.projectId,'other');assert.equal(c.state.lastReceipt,null);assert.equal(f.of('refresh').length,0);
});

test('collection cannot bypass an existing busy action and issue another request',async t=>{
  let resolve;const f=fixture({control:()=>new Promise(done=>{resolve=done;})}),c=await ready(f,t);f.setRuns([originalRun()]);
  const pending=c.collectDirect('fixture-run');
  // Assert immediately so a second pending promise cannot hang the fixture.
  const second=c.collectDirect('fixture-run');
  const dispatchCount=f.controls().length;
  resolve({run_id:'fixture-run',state:'collecting'});
  if(dispatchCount===1){await pending;await assert.rejects(second);}else{void second.catch(()=>{});}
  assert.equal(dispatchCount,1);
});
