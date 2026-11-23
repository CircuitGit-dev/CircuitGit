import test from 'node:test';
import assert from 'node:assert/strict';
import {createNodeClient,endpoint,ONBOARDING_OPERATIONS,isOnboardingRequest,onboardingRequestTimeout} from '../../apps/web/remote/client.js';
const code='x'.repeat(43);
test('remote HTTPS/prefix or explicit loopback only, never embedded credentials',()=>{
  assert.equal(endpoint('https://node.example/owner/'),'https://node.example/owner');
  assert.equal(endpoint('http://127.0.0.1:8767'),'http://127.0.0.1:8767');
  for(const url of ['http://node.example','https://u:p@node.example','https://node.example/?token=a','https://node.example/#key'])assert.throws(()=>endpoint(url));
});
test('request attaches the code only as a bearer header and disables redirects/cookies',async()=>{
  const calls=[],client=createNodeClient({url:'https://node.example/prefix',accessCode:code,fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ok:true,data:{hello:1}})};}});
  assert.equal(calls.length,0);await client.request('/node/info');await client.request('/ai/context?project_id=rc');
  assert.equal(calls[1].url,'https://node.example/prefix/api/ai/context?project_id=rc');
  for(const c of calls){assert(!c.url.includes(code));assert.equal(c.options.headers.Authorization,'Bearer '+code);assert.equal(c.options.credentials,'omit');assert.equal(c.options.redirect,'error');}
  client.close();await assert.rejects(client.request('/node/info'),/断开/);
});
test('a disconnected in-flight reply cannot reactivate chat',async()=>{
  let release;const client=createNodeClient({url:'https://node.example',accessCode:code,fetchImpl:()=>new Promise(r=>release=r)});
  const request=client.request('/node/info');client.close();release({ok:true,json:async()=>({ok:true,data:{schema:'stale'}})});
  await assert.rejects(request,/断开/);
});
test('uncertain writes are never retried automatically',async()=>{
  let count=0;const client=createNodeClient({url:'https://node.example',accessCode:code,fetchImpl:async()=>{count++;throw Error('dropped');}});
  await assert.rejects(client.request('/ai/turn',{method:'POST',body:{idempotency_key:'fixed'}}),/不要重复发送/);
  assert.equal(count,1);
});
test('node rejection preserves structured protocol diagnostics',async()=>{
  const client=createNodeClient({url:'https://node.example',accessCode:code,fetchImpl:async()=>({ok:false,status:409,json:async()=>({ok:false,error:{code:'conflict',message:'changed'}})})});
  await assert.rejects(client.request('/ai/turn',{method:'POST',body:{}}),e=>e.status===409&&e.data.code==='conflict');
});
test('paired simulation uses only its explicit route and preserves unknown outcome',async()=>{
  const calls=[];const client=createNodeClient({url:'http://127.0.0.1:8767',accessCode:code,fetchImpl:async(url,options)=>{calls.push({url,options});throw Error('connection dropped');}});
  await assert.rejects(client.request('/simulation/execute',{method:'POST',body:{operation:'submit',arguments:{project_id:'fixture'},idempotency_key:'same-key'}}),e=>e.data.code==='transport_unknown');
  assert.equal(calls.length,1);assert.equal(calls[0].url,'http://127.0.0.1:8767/api/simulation/execute');
  await assert.rejects(client.request('/simulation/admin',{method:'POST',body:{}}),/运行节点/);assert.equal(calls.length,1);
});
test('revoked node authorization notifies the host once without replaying',async()=>{
  let calls=0,rejected=0;
  const client=createNodeClient({url:'https://node.example',accessCode:code,onUnauthorized:()=>{rejected++;client.close();},fetchImpl:async()=>{calls++;return {ok:false,status:403,json:async()=>({ok:false,error:{code:'forbidden',message:'revoked'}})};}});
  await assert.rejects(client.request('/ai/events?after=0'),e=>e.status===403);
  await assert.rejects(client.request('/node/info'),/断开/);
  assert.equal(rejected,1);assert.equal(calls,1);
});
test('onboarding permits only the documented nine routes, exact verbs and bounded query identity',async()=>{
  const calls=[],client=createNodeClient({url:'http://127.0.0.1:18885',accessCode:code,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({ok:true,data:{observed:true}}));}});
  for(const row of Object.values(ONBOARDING_OPERATIONS)){
    const path='/simulation/onboarding'+row.path+(row.query?'?'+new URLSearchParams(Object.fromEntries(row.query.map(key=>[key,'opaque-original-id']))):'');
    assert.equal(isOnboardingRequest(path,row.method),true);await client.request(path,{method:row.method,...(row.method==='POST'?{body:{}}:{})});
    assert.equal(isOnboardingRequest(path,row.method==='GET'?'POST':'GET'),false);
  }
  assert.equal(calls.length,9);
  for(const path of ['/simulation/onboarding/admin','/simulation/onboarding/session','/simulation/onboarding/session?intake_id=a&intake_id=b','/simulation/onboarding/session?intake_id=a&path=secret','/simulation/onboarding/../onboarding/ssh-hosts','/simulation/onboarding/ssh-hosts#fragment'])await assert.rejects(client.request(path),/运行节点/);
  assert.equal(calls.length,9);
});
test('all onboarding envelopes enforce the simulation 2 MiB bound and retain structured rejection',async()=>{
  const large=createNodeClient({url:'http://127.0.0.1:18885',accessCode:code,fetchImpl:async()=>new Response(' '.repeat(2*1024*1024+1))});
  await assert.rejects(large.request('/simulation/onboarding/ssh-hosts'),e=>e.code==='response_size_limit');
  const rejected=createNodeClient({url:'http://127.0.0.1:18885',accessCode:code,fetchImpl:async()=>new Response(JSON.stringify({ok:false,error:{code:'stale_state',message:'revision changed'}}),{status:409})});
  await assert.rejects(rejected.request('/simulation/onboarding/probe',{method:'POST',body:{}}),e=>e.status===409&&e.data.code==='stale_state');
});
test('onboarding waveforms accept only bound finite GET reads and supported window fields',()=>{
  const base='/simulation/onboarding/waveforms/',identity='?intake_id=i&job_id=j';
  for(const kind of ['catalog','mapping']){assert(isOnboardingRequest(base+kind+identity,'GET'));assert.equal(isOnboardingRequest(base+kind+identity,'POST'),false);}
  const window=base+'window'+identity+'&signal_ids=signal-A,signal-B&start=0&stop=1e-9&max_points=1600';assert(isOnboardingRequest(window,'GET'));
  for(const path of [base+'raw'+identity,base+'window'+identity,window+'&cursor_a=0',window+'&analysis=tran',window+'&job_id=other',window.replace('1600','10001'),window.replace('signal-A,signal-B',','),window.replace('start=0','start=NaN')])assert.equal(isOnboardingRequest(path,'GET'),false,path);
});

test('finite onboarding budgets follow explicit host batches instead of changing global defaults',()=>{
  const hosts=Array.from({length:8},(_,i)=>'host-'+i);
  assert.equal(onboardingRequestTimeout('probeHost',{ssh_targets:hosts.slice(0,1)}),45000);
  assert.equal(onboardingRequestTimeout('probeHost',{ssh_targets:hosts}),150000);
  assert.equal(onboardingRequestTimeout('probeHost',{ssh_targets:hosts,overrides:{setup_source_ids:{'host-0':'observed-source'}}}),290000);
  assert.equal(onboardingRequestTimeout('discoverPdk',{probe_ids:hosts.slice(0,1)}),70000);
  assert.equal(onboardingRequestTimeout('discoverPdk',{probe_ids:hosts}),250000);
  assert.equal(onboardingRequestTimeout('prepareExperiment'),150000);
  assert.equal(onboardingRequestTimeout('runPrepared',{}, {execution_scope:{candidate_host_ids:hosts.slice(0,1)}}),110000);
  assert.equal(onboardingRequestTimeout('runPrepared'),320000,'unknown cached scope uses the finite eight-host maximum');
  assert.equal(onboardingRequestTimeout('inspectExperiment'),45000,'collection itself runs in the backend background');
  for(const name of ['inspectNetlist','listSshAliases','getSession','readSubmission'])assert.equal(onboardingRequestTimeout(name),20000);
  assert.throws(()=>onboardingRequestTimeout('arbitraryOperation'),/Unknown/);
});
test('paired client accepts bounded per-onboarding timeouts only and retains the ordinary default',async t=>{
  const scheduled=[],calls=[];
  t.mock.method(globalThis,'setTimeout',(_callback,delay)=>{scheduled.push(delay);return 0;});
  const client=createNodeClient({url:'http://127.0.0.1:18885',accessCode:code,fetchImpl:async(url)=>{calls.push(url);return new Response(JSON.stringify({ok:true,data:{}}));}});
  await client.request('/simulation/onboarding/discover-pdk',{method:'POST',body:{probe_ids:['chosen']},timeout:70000});
  assert.equal(scheduled.at(-1),70000);
  await client.request('/simulation/onboarding/probe',{method:'POST',body:{ssh_targets:['chosen']}});assert.equal(scheduled.at(-1),45000);
  await client.request('/ai/context',{timeout:320000});assert.equal(scheduled.at(-1),45000,'non-onboarding override cannot enlarge the ordinary request');
  const before=calls.length;
  for(const timeout of [0,-1,Infinity,70000.5,250001])await assert.rejects(client.request('/simulation/onboarding/discover-pdk',{method:'POST',body:{},timeout}),/finite route budget/);
  assert.equal(calls.length,before);
});
test('an onboarding timer abort reports unknown outcome after one POST and never retries it',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let calls=0;
  const client=createNodeClient({url:'http://127.0.0.1:18885',accessCode:code,fetchImpl:(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Timed out','AbortError')),{once:true}));}});
  const request=client.request('/simulation/onboarding/discover-pdk',{method:'POST',body:{probe_ids:['chosen']}});
  t.mock.timers.tick(69999);assert.equal(calls,1);
  t.mock.timers.tick(1);await assert.rejects(request,e=>e.data.code==='transport_unknown');assert.equal(calls,1);
});
