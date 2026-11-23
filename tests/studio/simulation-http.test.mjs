// In-memory response streams only. These fixtures do not contact a gateway.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readSimulationJson,isSimulationApiPath,SIMULATION_RESPONSE_LIMIT} from '../../modules/simulation/http.js';
import {normalizeRuntimeSnapshot} from '../../modules/simulation/runtime.js';
import {runtimeSnapshot} from './runtime.fixture.mjs';
import {Gateway} from '../../apps/web/api.js';
import {createNodeClient} from '../../apps/web/remote/client.js';
const utf8=new TextEncoder();
function streamResponse(bytes,{status=200,chunk=65536,onCancel=()=>{}}={}){
  let offset=0;
  return new Response(new ReadableStream({pull(controller){if(offset===bytes.length)return controller.close();const end=Math.min(bytes.length,offset+chunk);controller.enqueue(bytes.subarray(offset,end));offset=end;},cancel:onCancel}),{status,headers:{'Content-Type':'application/json'}});
}
function envelopeBytes(size){
  const body=' \n'+JSON.stringify({ok:true,data:{label:'中文😀'}})+'\n';
  return utf8.encode(body+' '.repeat(size-utf8.encode(body).byteLength));
}

test('complete envelope limit includes UTF-8 characters and JSON whitespace at exactly 2 MiB',async()=>{
  const bytes=envelopeBytes(SIMULATION_RESPONSE_LIMIT);
  assert.equal(bytes.byteLength,SIMULATION_RESPONSE_LIMIT);
  const value=await readSimulationJson(streamResponse(bytes,{chunk:4093}));
  assert.deepEqual(value,{ok:true,data:{label:'中文😀'}});
  const split=await readSimulationJson(streamResponse(utf8.encode('{"字":"😀"}'),{chunk:1}));
  assert.deepEqual(split,{'字':'😀'});
});

test('one byte over cancels the stream and never parses or returns a partial report',async()=>{
  let cancelled=false,parses=0;
  const response=streamResponse(envelopeBytes(SIMULATION_RESPONSE_LIMIT+1),{onCancel(){cancelled=true;}}),parse=JSON.parse;
  JSON.parse=(...args)=>{parses++;return parse(...args);};
  try{await assert.rejects(readSimulationJson(response),error=>error.code==='response_size_limit'&&error.data.limit_bytes===SIMULATION_RESPONSE_LIMIT);}
  finally{JSON.parse=parse;}
  assert.equal(cancelled,true);assert.equal(parses,0);
});

test('route matching requires the exact normalized simulation API path',()=>{
  for(const path of ['/api/simulation/runtime?project_id=p','/api/simulation/control','/api/simulation/results/run-1'])assert.equal(isSimulationApiPath(path),true);
  for(const path of ['/api/simulation','/api/simulationx/runtime','/api/ai/simulation/runtime','/api/simulation/../ai/models','/api/ai/models?next=/api/simulation/runtime','/prefix/api/simulation/runtime'])assert.equal(isSimulationApiPath(path),false);
});

test('local simulation transport limits the original envelope and preserves server 503 errors',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async()=>{calls++;return streamResponse(envelopeBytes(SIMULATION_RESPONSE_LIMIT+1));};
  const gateway=new Gateway();await assert.rejects(gateway.request('/simulation/runtime?project_id=p'),error=>error.data.code==='response_size_limit');assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({ok:false,error:{code:'response_size_limit',message:'Synthetic server response bound'}}),{status:503});};
  await assert.rejects(gateway.request('/simulation/control',{method:'POST',body:{operation:'inspect'}}),error=>error.status===503&&error.data.code==='response_size_limit');assert.equal(calls,2);
});

test('ordinary local APIs and similar path prefixes keep their original JSON behavior',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>{calls++;return {ok:true,data:{text:'x'.repeat(SIMULATION_RESPONSE_LIMIT+1)}};}});
  const gateway=new Gateway();
  for(const path of ['/ai/models','/simulationx/runtime','/simulation/../ai/models'])assert.equal((await gateway.request(path)).text.length,SIMULATION_RESPONSE_LIMIT+1);
  assert.equal(calls,3);
});

test('paired simulation transport keeps response-size diagnostics and never retries writes',async()=>{
  let calls=0;
  const client=createNodeClient({url:'https://synthetic.invalid/owner',accessCode:'x'.repeat(43),fetchImpl:async()=>{calls++;return streamResponse(envelopeBytes(SIMULATION_RESPONSE_LIMIT+1));}});
  await assert.rejects(client.request('/simulation/execute',{method:'POST',body:{idempotency_key:'synthetic-fixed-key'}}),error=>error.data.code==='response_size_limit');assert.equal(calls,1);client.close();
  const rejected=createNodeClient({url:'https://synthetic.invalid',accessCode:'x'.repeat(43),fetchImpl:async()=>new Response(JSON.stringify({ok:false,error:{code:'response_size_limit',message:'Synthetic server limit'}}),{status:503})});
  await assert.rejects(rejected.request('/simulation/execute',{method:'POST',body:{}}),error=>error.status===503&&error.data.code==='response_size_limit');rejected.close();
});

test('decoded runtime data has a separate UTF-8 secondary bound',()=>{
  const snapshot=runtimeSnapshot(),context=snapshot.runs[0].diagnostics.observed_context;context.synthetic_padding='';
  const remaining=SIMULATION_RESPONSE_LIMIT-utf8.encode(JSON.stringify(snapshot)).byteLength;
  context.synthetic_padding='中'.repeat(Math.floor(remaining/3))+'x'.repeat(remaining%3);
  assert.equal(utf8.encode(JSON.stringify(snapshot)).byteLength,SIMULATION_RESPONSE_LIMIT);
  assert.equal(normalizeRuntimeSnapshot(snapshot,'p').runs[0].run_id,'run-1');
  context.synthetic_padding+='x';assert.throws(()=>normalizeRuntimeSnapshot(snapshot,'p'));
});
