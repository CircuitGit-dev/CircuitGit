import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createController} from '../../modules/simulation/model.js';

const COMMIT='a'.repeat(40), HASH='b'.repeat(64), PLAN='c'.repeat(64);
function fixture({pool=true,preflight,submit}={}) {
  const calls=[],listeners=new Set();
  let project='demo',context={project:{id:project,sourceCommit:COMMIT},file:{dirty:false},loadState:'ready',loading:false};
  const record=(name,fn)=>async (...args)=>{calls.push({name,args:structuredClone(args)});return fn(...args);};
  const response=()=>({execution_plan_id:PLAN,execution_target:{mode:'resource_pool',host_id:'node-a',plan_id:PLAN},plan:{provenance:{source_commit:COMMIT},configuration:{effective:{compiled_inputs_sha256:HASH}}}});
  const host={version:1,context:{getContext:()=>context,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}},
    getProject:()=>({activeProjectId:project,source_commit:COMMIT,projects:[{id:project,configurations:[{id:'tran'}]}]}),getRuns:()=>[],
    slots:{simulation:{setBadge(){}}},notify(){},refresh:record('refresh',async()=>{}),selectRun:record('selectRun',async()=>{}),gateway:{
      request:record('request',async path=>{const query=new URLSearchParams(path.split('?')[1]);return {schema:'ic.sim.configuration-description.v1',project_id:query.get('project_id'),configuration:'tran',source_commit:COMMIT,configuration_path:'projects/demo/config.json',configuration_sha256:HASH,configuration_text:'{}',effective:{compiled_inputs_sha256:HASH}};}),
      plan:record('plan',async body=>({...body,settings:{effective:{compiled_inputs_sha256:HASH}},blockers:[],...(pool?{resource_selection_required:true,execution_mode:'resource_pool'}:{})})),
      preflight:record('preflight',preflight||(async()=>pool?response():{plan:response().plan})),
      submit:record('submit',submit||(async()=>({run_id:'fixture-run'}))),
    }};
  return {host,calls,response,of:name=>calls.filter(call=>call.name===name),switchProject(id){project=id;context={...context,project:{id,sourceCommit:COMMIT}};listeners.forEach(fn=>fn());}};
}
async function ready(f,t){const controller=createController(f.host);t.after(()=>controller.destroy());await controller.ready();await controller.plan();return controller;}

test('resource selection is explicit and submit carries the exact reviewed preflight token',async t=>{
  const f=fixture(),c=await ready(f,t);assert.equal(f.of('preflight').length,0);
  await c.preflight();await c.submit(true);
  const body=f.of('submit')[0].args[0];assert.equal(body.execution_plan_id,PLAN);assert.equal(body.source_commit,COMMIT);assert.ok(body.idempotency_key);
  assert.equal(f.of('preflight').length,1);await assert.rejects(c.submit(true));assert.equal(f.of('submit').length,1);assert.equal(f.of('preflight').length,1);
});

test('missing malformed or inconsistent resource plan cannot reach submit',async t=>{
  for(const malformed of ['missing','malformed','mismatch','newline']){
    const f=fixture();f.host.gateway.preflight=async()=>{const result=f.response();if(malformed==='missing')delete result.execution_plan_id;else if(malformed==='malformed')result.execution_plan_id='short';else if(malformed==='newline')result.execution_plan_id=result.execution_target.plan_id=PLAN+'\n';else result.execution_target.plan_id='d'.repeat(64);return result;};
    const c=await ready(f,t);await c.preflight();await assert.rejects(c.submit(true),/执行计划/);assert.equal(f.of('submit').length,0);
  }
});

test('unknown submit preserves original token and key and never selects again on reload',async t=>{
  const f=fixture({submit:async()=>{throw Error('Synthetic unknown response');}}),c=await ready(f,t);
  await c.preflight();await assert.rejects(c.submit(true),/unknown/);const original=structuredClone(c.state.submitAttempt);
  assert.equal(original.execution_plan_id,PLAN);assert.ok(original.idempotency_key);
  await c.reload();await assert.rejects(c.plan());assert.deepEqual(c.state.submitAttempt,original);assert.equal(f.of('submit').length,1);assert.equal(f.of('preflight').length,1);
});

test('declined confirmation makes no request and leaves the reviewed plan available',async t=>{
  const f=fixture(),c=await ready(f,t);await c.preflight();await assert.rejects(c.submit(false),/明确确认/);
  assert.equal(c.state.preflight.execution_plan_id,PLAN);assert.equal(f.of('submit').length,0);assert.equal(f.of('preflight').length,1);
});

test('editing configuration invalidates frozen preflight and prevents submission',async t=>{
  const f=fixture(),c=await ready(f,t);await c.preflight();c.edit(['analysis','stop'],'2n');
  assert.equal(c.state.preflight,null);await assert.rejects(c.submit(true));assert.equal(f.of('submit').length,0);assert.equal(f.of('preflight').length,1);
});

test('late preflight cannot move its selected host into another project',async t=>{
  let resolve;const f=fixture({preflight:()=>new Promise(done=>{resolve=done;})}),c=await ready(f,t);
  const pending=c.preflight();f.switchProject('other');await c.ready();resolve(f.response());await pending;
  assert.equal(c.state.projectId,'other');assert.equal(c.state.preflight,null);await assert.rejects(c.submit(true));assert.equal(f.of('submit').length,0);
});

test('preflight error makes no fallback selection or submission',async t=>{
  const f=fixture({preflight:async()=>{throw Error('Synthetic no eligible host');}}),c=await ready(f,t);
  await assert.rejects(c.preflight(),/no eligible host/);assert.equal(c.state.suspended,true);await assert.rejects(c.submit(true));
  assert.equal(f.of('preflight').length,1);assert.equal(f.of('submit').length,0);
});

test('legacy fixed site works without any resource token fields',async t=>{
  const f=fixture({pool:false}),c=await ready(f,t);await c.preflight();await c.submit(true);
  assert.deepEqual(Object.keys(f.of('submit')[0].args[0]).sort(),['configuration','idempotency_key','project_id','source_commit']);
  assert.equal(f.of('preflight').length,1);
});
