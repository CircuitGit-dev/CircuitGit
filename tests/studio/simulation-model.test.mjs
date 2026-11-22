import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createController,parseConfiguration,updateConfiguration} from '../../apps/web/studio/simulation/model.js';

const A='a'.repeat(40),B='b'.repeat(40),HASH='1'.repeat(64);
function fixture({request,submit,preview}={}) {
  let registry={activeProjectId:'p',source_commit:A,projects:[{id:'p',configurations:[{id:'c'},{id:'c2'}]}]};
  let context={project:{id:'p',sourceCommit:A},file:{dirty:false},loadState:'ready',loading:false};
  const listeners=new Set(),calls=[];
  let text='{"parameters":{},"analysis":{},"future":{"keep":7}}';
  const descriptor=(query)=>({schema:'ic.sim.configuration-description.v1',project_id:query.get('project_id'),configuration:query.get('configuration'),source_commit:query.get('source_commit'),configuration_path:'projects/p/config.json',configuration_sha256:HASH,configuration_text:text,effective:{compiled_inputs_sha256:HASH}});
  const record=(name,fn)=>async (...args)=>{calls.push({name,args});return fn(...args);};
  const host={version:1,context:{getContext:()=>context,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}},getProject:()=>registry,getRuns:()=>[{run_id:'old',state:'archived',publication:{status:'published'}}],slots:{simulation:{setBadge(){}}},notify(){},refresh:record('refresh',async options=>{if(options.project&&host.saved){registry={...registry,source_commit:B};context={...context,project:{id:registry.activeProjectId,sourceCommit:B}};for(const fn of listeners)fn(context);}}),selectRun:record('selectRun',async()=>{}),gateway:{
    request:record('request',request||(async path=>descriptor(new URLSearchParams(path.split('?')[1])))),
    preview:record('preview',preview||(async body=>({base_commit:body.base_commit,review_id:'review',diff:'diff',configuration_previews:[{project_id:'p',configuration:'c',effective:{compiled_inputs_sha256:HASH}}]}))),
    save:record('save',async body=>{text=body.changes[0].content;host.saved=true;return {source_commit:B,push_status:body.push?'confirmed':'not_requested'};}),
    plan:record('plan',async body=>({...body,settings:{effective:{compiled_inputs_sha256:HASH}},blockers:[]})),
    preflight:record('preflight',async body=>({plan:{provenance:{source_commit:body.source_commit},configuration:{effective:{compiled_inputs_sha256:HASH}}}})),
    submit:record('submit',submit||(async()=>({run_id:'new',state:'queued'}))),
    job:record('job',async()=>({})),
  }};
  return {host,calls,setContext(next){context={...context,...next};for(const fn of listeners)fn(context);},advanceCommit(commit){registry={...registry,source_commit:commit};context={...context,project:{id:registry.activeProjectId,sourceCommit:commit}};for(const fn of listeners)fn(context);},switchProject(id){registry={...registry,activeProjectId:id,projects:registry.projects.some(p=>p.id===id)?registry.projects:[...registry.projects,{id,configurations:[{id:'c'}]}]};context={...context,project:{id,sourceCommit:registry.source_commit}};for(const fn of listeners)fn(context);},descriptor};
}
test('form JSON round trip preserves unknown fields and rejects duplicates',()=>{
  const edited=updateConfiguration('{"future":{"x":1},"parameters":{}}',['parameters','N'],'32');
  assert.equal(parseConfiguration(edited).future.x,1);
  assert.throws(()=>parseConfiguration('{"parameters":{"N":1,"N":2}}'),/重复/);
  assert.throws(()=>parseConfiguration('{"x":{},"x":{}}'),/重复/);
});
test('mount performs only read-only configuration request; archive listing never polls status',async()=>{
  const f=fixture(),c=createController(f.host);await c.ready();
  assert.deepEqual(f.calls.map(x=>x.name),['request']);
  await c.refreshRuns();await assert.rejects(c.observeRun('old'),/已归档/);
  assert.equal(f.calls.filter(x=>x.name==='job').length,0);c.destroy();
});
test('preview/save/plan use exact text and source version; preflight/submit are separate explicit actions',async()=>{
  const f=fixture(),c=createController(f.host);await c.ready();c.edit(['parameters','N'],'32');
  await assert.rejects(c.commit(),/预览/);await assert.rejects(c.plan(),/保存/);
  await c.preview();const text=c.state.draftText;await c.commit();await c.ready();
  assert.equal(f.calls.find(x=>x.name==='save').args[0].changes[0].content,text);assert.equal(c.state.sourceCommit,B);assert.equal(c.draftDirty(),false);
  await c.plan();await assert.rejects(c.submit(true),/预检/);await c.preflight();await assert.rejects(c.submit(false),/明确确认/);await c.submit(true);
  assert.equal(f.calls.filter(x=>x.name==='submit').length,1);assert.equal(f.calls.find(x=>x.name==='submit').args[0].source_commit,B);
  assert.ok(f.calls.find(x=>x.name==='submit').args[0].idempotency_key);assert.equal(f.calls.at(-1).name,'selectRun');
  await assert.rejects(c.submit(true));assert.equal(f.calls.filter(x=>x.name==='submit').length,1);c.destroy();
});
test('editing after preview invalidates save and plan',async()=>{
  const f=fixture(),c=createController(f.host);await c.ready();c.edit(['parameters','N'],'32');await c.preview();c.edit(['parameters','N'],'64');await assert.rejects(c.commit(),/预览/);assert.equal(c.state.plan,null);c.destroy();
});
test('dirty source invalidates dependent actions synchronously',async()=>{
  const f=fixture(),c=createController(f.host);await c.ready();await c.plan();f.setContext({file:{dirty:true}});
  assert.equal(c.state.plan,null);assert.equal(c.state.descriptor,null);await assert.rejects(c.plan());c.destroy();
});
test('late configuration response cannot overwrite another project',async()=>{
  const pending=[];const f=fixture({request:path=>new Promise(resolve=>pending.push({path,resolve}))});const c=createController(f.host);
  f.switchProject('q');assert.equal(pending.length,2);
  pending[1].resolve(f.descriptor(new URLSearchParams(pending[1].path.split('?')[1])));await c.ready();
  pending[0].resolve(f.descriptor(new URLSearchParams(pending[0].path.split('?')[1])));await Promise.resolve();
  assert.equal(c.state.descriptor.project_id,'q');c.destroy();
});
test('protocol/approval failure suspends dependent writes',async()=>{
  const f=fixture({preview:async()=>{throw Object.assign(Error('manual approval declined'),{status:403});}}),c=createController(f.host);await c.ready();c.edit(['parameters','N'],'32');await assert.rejects(c.preview(),/declined/);assert.equal(c.state.suspended,true);await assert.rejects(c.commit());assert.equal(f.calls.filter(x=>x.name==='save').length,0);c.destroy();
});
test('unknown submission outcome cannot be retried by reload',async()=>{
  const f=fixture({submit:async()=>{throw Error('unknown network outcome');}}),c=createController(f.host);await c.ready();await c.plan();await c.preflight();await assert.rejects(c.submit(true),/unknown/);await c.reload();assert.equal(c.state.suspended,true);await assert.rejects(c.plan());assert.equal(f.calls.filter(x=>x.name==='submit').length,1);c.destroy();
});
test('configuration switches and reload preserve exact keyed drafts and invalidate preview/plan',async()=>{
  const f=fixture(),c=createController(f.host);await c.ready();c.edit(['parameters','N'],'32');await c.preview();const draft=c.state.draftText;
  await c.chooseConfiguration('c2');assert.equal(c.state.preview,null);assert.notEqual(c.state.draftText,draft);assert.equal(c.getDrafts().length,1);
  await c.chooseConfiguration('c');assert.equal(c.state.draftText,draft);assert.equal(c.draftDirty(),true);assert.equal(c.state.preview,null);
  await c.reload();assert.equal(c.state.draftText,draft);assert.equal(c.state.plan,null);c.destroy();
});
test('canonical dirty editing and project changes retain drafts without leaking to another identity',async()=>{
  const f=fixture(),c=createController(f.host);await c.ready();c.edit(['analysis','stop'],'40n');const draft=c.state.draftText;
  f.setContext({file:{dirty:true}});assert.equal(c.state.descriptor,null);assert.equal(c.getDrafts()[0].text,draft);
  f.setContext({file:{dirty:false}});await c.ready();assert.equal(c.state.draftText,draft);
  f.switchProject('q');await c.ready();assert.notEqual(c.state.draftText,draft);assert.equal(c.getDrafts()[0].projectId,'p');
  f.switchProject('p');await c.ready();assert.equal(c.state.draftText,draft);assert.equal(c.state.preview,null);c.destroy();
});
test('new commit cannot inherit old draft as saved configuration; discard is explicit',async()=>{
  const f=fixture(),c=createController(f.host);await c.ready();c.edit(['parameters','N'],'64');const draft=c.state.draftText;
  f.advanceCommit(B);await c.ready();assert.notEqual(c.state.draftText,draft);assert.equal(c.draftDirty(),false);
  const cached=c.getDrafts()[0];assert.equal(cached.sourceCommit,A);assert.equal(cached.active,false);assert.equal(cached.text,draft);
  assert.throws(()=>c.discardDraft(cached.key,false),/明确/);c.discardDraft(cached.key,true);assert.equal(c.getDrafts().length,0);c.destroy();
});
test('badge counts only explicit nonterminal states',async()=>{
  const f=fixture(),badges=[];f.host.slots.simulation.setBadge=x=>badges.push(x);
  f.host.getRuns=()=>['simulator_complete_pending_measurements','preflight_failed','simulator_failed','archived','collected'].map(state=>({state}));
  const c=createController(f.host);await c.ready();assert.equal(badges.at(-1),null);
  f.host.getRuns=()=>[{state:'running_observed'}];await c.synchronize();assert.equal(badges.at(-1),'运行中');
  f.host.getRuns=()=>[{state:'reconcile_required'}];await c.synchronize();assert.equal(badges.at(-1),'需核对');c.destroy();
});
