import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewAdapter,panelContext} from '../../../apps/codex/ui/waveforms/adapter.js';
export const fixtureView=()=>({schema:'ic.view.v1',view_id:'v_'+'1'.repeat(32),workspace_id:'w_'+'2'.repeat(32),kind:'waveforms',revision:1,
 identity:{project_id:'p',source_commit:'c'.repeat(40),source_sha256:null,path:null,configuration:'tran',run_id:'run-1'},selection:null,
 readiness:{state:'requested',basis:'server-request',message:null},ui:{mounted:null},workspace_revision:1});
const signal={id:'saved-1',psf_name:'VINP',label:'VINP',analysis:'tran',unit:'V',status:'available'};
function fixture(){let view=fixtureView(),listener,block,queryCount=0;const calls=[];
 const host={initial:view,onResult:fn=>(listener=fn,()=>{listener=null;}),async call(name,args){calls.push({name,args});
  if(name==='ic_view_get')return structuredClone(view);
  assert.equal(args.view_id,view.view_id);assert.equal(args.workspace_id,view.workspace_id);
  if((args.revision??args.expected_revision)!==view.revision)throw Object.assign(Error('stale'),{code:'conflict'});
  if(name==='ic_view_data'){
   queryCount++;if(block)await block;
   const q=args.query,payload=q.kind==='runs'?{jobs:[{run_id:'run-1',source_commit:view.identity.source_commit,associated_project_id:'p'}]}:
    q.kind==='signals'?{run_id:'run-1',source_commit:view.identity.source_commit,signals:[signal]}:
    q.kind==='mapping'?{status:'unmapped',run_id:'run-1',source_commit:view.identity.source_commit}:
    {run_id:'run-1',source_commit:view.identity.source_commit,signal,points:[[0,0]],measurement:{uses_display_samples:false}};
   return {view:structuredClone(view),kind:q.kind,payload};
  }
  view={...view,revision:view.revision+1,workspace_revision:view.workspace_revision+1};
  if(name==='ic_view_select')view.selection=args.selection.kind==='none'?null:{...args.selection,verification:'saved-signal-catalog',source_commit:view.identity.source_commit,run_id:'run-1'};
  if(name==='ic_view_state')view.readiness={state:'loaded',basis:'client-report',message:args.message};
  return structuredClone(view);
 }};
 return {host,calls,external(value){view=value;listener?.(structuredClone(value));},get view(){return structuredClone(view);},setBlock(p){block=p;},get queryCount(){return queryCount;}};
}
test('host-only finite tools pin every read and CAS selection; context never asserts fresh geometry',async()=>{
 const f=fixture(),a=createViewAdapter(f.host);await a.api.jobs();await a.api.catalog('run-1');await a.api.mapping('run-1');await a.api.waveform('run-1','saved-1',{limit:200,cursor_a:0});await a.select(['saved-1']);await a.reportLoaded();
 assert.equal(a.view.revision,3);assert.equal(a.view.ui.mounted,null);assert.equal(panelContext(a.view).geometry,null);assert.equal(a.readings.size,1);assert(f.calls.every(x=>['ic_view_data','ic_view_select','ic_view_state'].includes(x.name)));a.dispose();
});
test('same identity results are monotonic; other views and rebound sources cannot replace local authority',()=>{
 const f=fixture(),errors=[],a=createViewAdapter(f.host,{onError:e=>errors.push(e)}),newer={...f.view,revision:3};f.external(newer);assert.equal(a.view.revision,3);f.external({...newer,revision:2});assert.equal(a.view.revision,3);
 f.external({...newer,view_id:'v_'+'3'.repeat(32),revision:9});assert.equal(a.view.revision,3);
 f.external({...newer,identity:{...newer.identity,run_id:'other'},revision:4});assert.equal(a.view.identity.run_id,'run-1');assert.equal(errors.length,1);a.dispose();
});
test('disposed or cancelled queued reads never issue another host call',async()=>{
 const f=fixture(),a=createViewAdapter(f.host),cancel=new AbortController();cancel.abort();await assert.rejects(a.api.catalog('run-1',{signal:cancel.signal}),{name:'AbortError'});assert.equal(f.calls.length,0);a.dispose();await assert.rejects(a.api.jobs(),{name:'AbortError'});assert.equal(f.calls.length,0);
});
test('stale in-flight response is rejected and no mutation retries',async()=>{
 const f=fixture(),a=createViewAdapter(f.host);let release;f.setBlock(new Promise(r=>release=r));const pending=a.api.catalog('run-1');await new Promise(r=>setTimeout(r,0));f.external({...f.view,revision:2});release();await assert.rejects(pending,/修订/);assert.equal(f.calls.length,1);
 f.host.call=async()=>{throw Object.assign(Error('conflict'),{code:'conflict'});};await assert.rejects(a.select([]),/conflict/);a.dispose();
});
test('unavailable map is explicit while historical catalog remains readable; CAS conflict is never hidden',async()=>{
 const f=fixture(),original=f.host.call;f.host.call=(name,args)=>args.query?.kind==='mapping'?Promise.reject(Object.assign(Error('map missing'),{code:'not_found'})):original(name,args);
 const a=createViewAdapter(f.host);await a.api.catalog('run-1');assert.equal((await a.api.mapping('run-1')).status,'unmapped');await a.api.waveform('run-1','saved-1');
 f.host.call=()=>Promise.reject(Object.assign(Error('conflict'),{code:'conflict'}));await assert.rejects(a.api.mapping('run-1'),/conflict/);a.dispose();
});
test('wrong run and unavailable signal cannot issue a waveform call',async()=>{
 const f=fixture(),a=createViewAdapter(f.host);await a.api.catalog('run-1');const count=f.calls.length;await assert.rejects(a.api.waveform('another','saved-1'));await assert.rejects(a.api.waveform('run-1','unknown'));assert.equal(f.calls.length,count);a.dispose();
});

test('another view may advance workspace revision without changing this view revision',()=>{
 const f=fixture(),a=createViewAdapter(f.host);f.external({...f.view,workspace_revision:5});assert.equal(a.view.revision,1);assert.equal(a.view.workspace_revision,5);assert.throws(()=>a.accept({...f.view,workspace_revision:4}),/工作区修订/);a.dispose();
});

test('persisted descriptor key order preserves identity and state while real changes still fail',async()=>{
 const f=fixture(),a=createViewAdapter(f.host);await a.reportLoaded();
 const reordered=JSON.parse(JSON.stringify(a.view,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v));
 assert.doesNotThrow(()=>a.accept(reordered));
 assert.throws(()=>a.accept({...reordered,readiness:{...reordered.readiness,state:'error'}}),/同一修订/);
 assert.throws(()=>a.accept({...reordered,identity:{...reordered.identity,run_id:'other'}}),/其他视图/);
 await a.api.catalog('run-1');await a.api.waveform('run-1','saved-1');assert.equal(a.readings.size,1);a.dispose();
});
