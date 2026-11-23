import test from 'node:test';
import assert from 'node:assert/strict';
import {createNodeClient,endpoint} from '../../apps/web/remote/client.js';
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
