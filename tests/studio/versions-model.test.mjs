import test from 'node:test';
import assert from 'node:assert/strict';
import {createVersionModel} from '../../apps/web/studio/versions/model.js';

const sha='a'.repeat(40),other='b'.repeat(40),tick=()=>new Promise(resolve=>setImmediate(resolve));
const context=(id='demo',commit=sha,dirty=false)=>({project:{id,sourceCommit:commit},file:{path:'projects/demo/source.scs',dirty}});
const summary=(id='demo',commit=sha)=>({project_id:id,source_commit:commit,commits:[{sha:commit}],upstream:{available:true,ahead:0,behind:0,remote_checked:false,freshness:'local_cache'}});
function fixture(){const pending=[];const model=createVersionModel({gateway:{request(path,options){return new Promise((resolve,reject)=>pending.push({path,options,resolve,reject}));}}});return {model,pending};}

test('version queries bind project identity and source; selection/draft changes do not refetch',async()=>{
  const {model,pending}=fixture();model.context(context());assert.equal(pending.length,1);
  assert.equal(pending[0].path,'/version-control?project_id=demo&limit=20&scope=design');pending[0].resolve(summary());await tick();
  model.context({...context(),selection:{kind:'net',name:'out'}});model.context(context('demo',sha,true));
  assert.equal(pending.length,1);assert.equal(model.getState().draft.path,'projects/demo/source.scs');
  assert.equal(model.getState().summary.upstream.remote_checked,false);
});
test('slow old project query cannot overwrite new project history',async()=>{
  const {model,pending}=fixture();model.context(context());model.context(context('second',other));
  pending[1].resolve(summary('second',other));await tick();pending[0].resolve(summary());await tick();
  assert.equal(model.getState().summary.project_id,'second');assert.equal(model.getState().loading,false);
});
test('commit responses are invalidated by back, refresh, project switch and disposal',async()=>{
  const {model,pending}=fixture();model.context(context());pending[0].resolve(summary());await tick();
  await model.select('unregistered');assert.equal(pending.length,1);
  const selected=model.select(sha);assert(pending[1].path.includes('commit='+sha+'&scope=design'));model.back();
  pending[1].resolve({project_id:'demo',source_commit:sha,commit:{sha},diff:'obsolete'});await selected;assert.equal(model.getState().detail,null);
  const refresh=model.refresh();model.destroy();pending[2].resolve(summary());await refresh;assert.equal(model.getState().summary.source_commit,sha);
});
test('moving runtime HEAD and mismatched commit detail fail closed',async()=>{
  const {model,pending}=fixture();model.context(context());pending[0].resolve(summary('demo',other));await tick();
  assert.equal(model.getState().summary,null);assert.match(model.getState().error,/版本已变化/);
  const read=model.refresh();pending[1].resolve(summary());await read;
  const selected=model.select(sha);pending[2].resolve({project_id:'demo',source_commit:other,commit:{sha}});await selected;
  assert.equal(model.getState().detail,null);assert.match(model.getState().detailError,/已过期/);
});
test('read failures remain explicit and do not replay a request',async()=>{
  const {model,pending}=fixture();model.context(context());pending[0].reject(Error('gateway unavailable'));await tick();
  assert.equal(model.getState().error,'gateway unavailable');assert.equal(pending.length,1);assert.equal(model.getState().loading,false);
});
test('cosmetic toggle changes only the history query',async()=>{
 const {model,pending}=fixture();model.context(context());pending[0].resolve(summary());await tick();
 const toggled=model.includeCosmetic(true);assert(pending[1].path.endsWith('include_cosmetic=1'));pending[1].resolve(summary());await toggled;
 assert.equal(model.getState().includeCosmetic,true);assert.equal(pending.some(p=>p.options?.method==='POST'),false);
});
test('restore preview is explicit, scoped and never issues a commit',async()=>{
 const {model,pending}=fixture();model.context(context());pending[0].resolve({...summary(),scope:{paths:['projects/demo/source.scs']}});await tick();
 const result=model.restorePreview(sha);assert.equal(pending[1].path,'/version-control/restore-preview');assert.deepEqual(pending[1].options.body,{project_id:'demo',commit:sha,base_commit:sha});
 pending[1].resolve({schema:'ic.version-control.restore-preview.v1',project_id:'demo',target_commit:sha,base_commit:sha,changes:[{path:'projects/demo/source.scs',content:'OLD'}],preview:{base_commit:sha,review_id:'c'.repeat(64)},automatic_commit:false});
 assert.equal((await result).automatic_commit,false);assert.equal(pending.length,2);
 model.context(context('demo',sha,true));await assert.rejects(model.restorePreview(sha),/草稿/);assert.equal(pending.length,2);
});
