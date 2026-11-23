import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRuntimeSnapshot,resourceFreshness,createRuntimeController} from '../../modules/simulation/runtime.js';
import {runtimeSnapshot,runtimeFixture} from './runtime.fixture.mjs';

function controllerFixture(t,fixture=runtimeFixture(),{visible=true}={}){
  let tick=null,cleared=false,shown=visible;
  const controller=createRuntimeController(fixture.host,{isVisible:()=>shown,setIntervalFn(fn,ms){assert.equal(ms,5000);tick=fn;return 7;},clearIntervalFn(id){assert.equal(id,7);cleared=true;}});
  t.after(()=>controller.destroy());
  return {fixture,controller,tick:async()=>{tick();await controller.ready();},visible(value){shown=value;},get cleared(){return cleared;}};
}
const gets=f=>f.calls.filter(call=>call.options?.method==='GET');
const posts=f=>f.calls.filter(call=>call.options?.method==='POST');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('runtime preserves original resource times unknown metrics and independent acceptance',()=>{
  const source=runtimeSnapshot(),value=normalizeRuntimeSnapshot(source,'p');
  assert.equal(value.pool.hosts[1].cpu_busy_percent,null);assert.equal(value.pool.hosts[1].memory_available_bytes,null);
  assert.equal(value.pool.hosts[1].observed_at,'2026-01-01T00:00:00Z');assert.deepEqual(value.runs[0].acceptance,{execution:'failed',data_validity:'unknown',specification:'unknown'});
  source.pool.hosts[0].label='changed';assert.notEqual(value.pool.hosts[0].label,'changed');assert.ok(Object.isFrozen(value.runs[0]));
});

test('malformed cross-project duplicate oversized and executable diagnostics fail closed',()=>{
  const mutations=[v=>{v.project_id='other';},v=>{v.capabilities.scan='yes';},v=>{v.pool.hosts.push(structuredClone(v.pool.hosts[0]));},
    v=>{v.pool.hosts[0].cpu_busy_percent=NaN;},v=>{v.pool.hosts[0].memory_available_bytes=128*2**30;},v=>{v.pool.hosts[0].observed_at='today';},
    v=>{v.runs.push(structuredClone(v.runs[0]));},v=>{v.runs[0].source_commit='HEAD';},v=>{v.runs[0].monitor.failures=-1;},
    v=>{v.runs[0].diagnostics.advisory_only=false;},v=>{v.runs[0].diagnostics.agent_proposal={execute:'yes'};},
    v=>{v.runs[0].diagnostics.diagnostics[0].suggested_actions=['x'.repeat(501)];},v=>{v.runs[0].acceptance.specification='healthy';},
    v=>{v.runs[0].acceptance.specification='pass';}];
  for(const mutate of mutations){const value=runtimeSnapshot();mutate(value);assert.throws(()=>normalizeRuntimeSnapshot(value,'p'));}
});

test('resource freshness treats old future and missing observations distinctly from a current sample',()=>{
  const host=runtimeSnapshot().pool.hosts[0],now=Date.parse(host.observed_at);
  assert.equal(resourceFreshness(host,now+119999).state,'recent');assert.equal(resourceFreshness(host,now+120001).state,'stale');
  assert.equal(resourceFreshness(host,now-1).state,'unknown');assert.equal(resourceFreshness({...host,observed_at:null},now).state,'unknown');
  assert.equal(resourceFreshness({...host,reachable:null},now).state,'unknown');
});

test('visible runtime polls cached GET every five seconds and never starts a scan',async t=>{
  const f=controllerFixture(t);await f.controller.ready();assert.equal(gets(f.fixture).length,1);
  await f.tick();assert.equal(gets(f.fixture).length,2);assert.equal(posts(f.fixture).length,0);
  assert.equal(gets(f.fixture)[0].path,'/simulation/runtime?project_id=p');
});

test('hidden or inactive runtime pauses cache reads and reactivation resumes',async t=>{
  const f=controllerFixture(t);await f.controller.ready();f.visible(false);await f.tick();assert.equal(gets(f.fixture).length,1);
  f.visible(true);f.controller.setActive(false);await f.tick();assert.equal(gets(f.fixture).length,1);
  f.controller.setActive(true);await f.controller.ready();assert.equal(gets(f.fixture).length,2);
});

test('mounting invisibly does not make an initial request',async t=>{
  const f=controllerFixture(t,undefined,{visible:false});await f.controller.ready();assert.equal(f.fixture.calls.length,0);
  f.visible(true);f.controller.visibilityChanged();await f.controller.ready();assert.equal(gets(f.fixture).length,1);
});

test('only the explicit scan sends one project-bound POST and later reads the cache',async t=>{
  const f=controllerFixture(t);await f.controller.ready();await f.controller.scan();
  assert.deepEqual(posts(f.fixture),[{path:'/simulation/resources/scan',options:{method:'POST',body:{project_id:'p'}}}]);
  assert.equal(f.controller.state.snapshot.pool.scan_in_progress,true);assert.equal(f.controller.canScan(),false);
  await f.tick();assert.equal(posts(f.fixture).length,1);assert.equal(gets(f.fixture).length,3);
});

test('unconfigured pools missing scan capability and in-progress scans cannot send POST',async t=>{
  for(const mutate of [v=>{v.pool.configured=false;},v=>{v.capabilities.scan=false;},v=>{v.pool.scan_in_progress=true;}]){
    const fixture=runtimeFixture();mutate(fixture.snapshot);const f=controllerFixture(t,fixture);await f.controller.ready();
    await assert.rejects(f.controller.scan());assert.equal(posts(fixture).length,0);
  }
});

test('scan failure stays visible and cache polling never automatically retries it',async t=>{
  const f=controllerFixture(t);f.fixture.scanError=Error('Synthetic transport uncertainty');await f.controller.ready();
  await assert.rejects(f.controller.scan(),/uncertainty/);assert.equal(f.controller.state.scanState,'unknown');
  await f.tick();await f.tick();assert.equal(posts(f.fixture).length,1);assert.match(f.controller.state.scanError,/uncertainty/);
});

test('accepted scan becomes available again only after cached completion evidence',async t=>{
  const f=controllerFixture(t);await f.controller.ready();await f.controller.scan();
  assert.equal(f.controller.canScan(),false);assert.equal(f.controller.state.scanState,'requested');
  f.fixture.snapshot.pool.scan_in_progress=false;await f.tick();
  assert.equal(f.controller.state.scanState,'idle');assert.equal(f.controller.canScan(),true);assert.equal(posts(f.fixture).length,1);
});

test('parallel refresh callers share one request',async t=>{
  const fixture=runtimeFixture(),wait=deferred();fixture.host.gateway.request=()=>wait.promise;
  const f=controllerFixture(t,fixture),a=f.controller.ready(),b=f.controller.refresh();assert.equal(a,b);
  wait.resolve(runtimeSnapshot());await a;assert.equal(f.controller.state.status,'ready');
});

test('old project replies cannot populate the next project',async t=>{
  const fixture=runtimeFixture(),waits=[];fixture.host.gateway.request=()=>{const wait=deferred();waits.push(wait);return wait.promise;};
  const f=controllerFixture(t,fixture);await Promise.resolve();fixture.switchProject('q');await Promise.resolve();
  waits[1].resolve(runtimeSnapshot('q'));await f.controller.ready();waits[0].resolve(runtimeSnapshot('p'));await Promise.resolve();
  assert.equal(f.controller.state.snapshot.project_id,'q');
});

test('same-project read failure retains old timestamps with an explicit error state',async t=>{
  const f=controllerFixture(t);await f.controller.ready();const observed=f.controller.state.snapshot.pool.hosts[0].observed_at;
  f.fixture.error=Error('Synthetic failed cache read');await f.controller.refresh();assert.equal(f.controller.state.status,'error');
  assert.equal(f.controller.state.snapshot.pool.hosts[0].observed_at,observed);assert.equal(f.controller.canScan(),false);
});

test('404 is unavailable and no recurring unsupported-endpoint requests are made',async t=>{
  const fixture=runtimeFixture();fixture.error=Object.assign(Error('not provided'),{status:404});const f=controllerFixture(t,fixture);
  await f.controller.ready();assert.equal(f.controller.state.status,'unavailable');await f.tick();assert.equal(gets(fixture).length,1);
  fixture.error=null;await f.controller.refresh({force:true});assert.equal(f.controller.state.status,'ready');
});

test('dispose clears timer subscription and ignores late replies',async t=>{
  const fixture=runtimeFixture(),wait=deferred();fixture.host.gateway.request=()=>wait.promise;const f=controllerFixture(t,fixture);
  await Promise.resolve();f.controller.destroy();assert.equal(f.cleared,true);assert.equal(fixture.listeners.size,0);
  wait.resolve(runtimeSnapshot());await f.controller.ready();assert.equal(f.controller.state.snapshot,null);
});
