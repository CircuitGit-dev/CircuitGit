// Local draft routing only; no provider, network or tool calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {formatAgentAssistance,appendAssistanceText,createAgentAssistance,createAssistanceQueue} from '../../apps/web/ai/assistance.js';
import {imageDocument,tick} from './fixtures/image-dom.mjs';
const request=()=>({kind:'environment',prompt:'核对当前仿真环境。',context:{schema:'ic.simulation.agent-assistance.v1',origin:'environment',binding:{status:'bound',intake_id:'synthetic-intake',revision:7,source_sha256:'a'.repeat(64),connection_id:'synthetic-store',adapter_connection_id:'synthetic-pairing'}}});
const draft=()=>formatAgentAssistance(request(),{requestId:'fixture-request'});
function host(){const doc=imageDocument(),create=doc.createElement;doc.createElement=tag=>Object.assign(create(tag),{style:{}});const element=doc.createElement('div');doc.body.append(element);let visible=false;const states=[],notes=[];return{doc,element,states,notes,get visible(){return visible;},slot:{element,setVisible(value){visible=value;states.push(value);},isVisible:()=>visible},notify:(...args)=>notes.push(args)};}

test('request text preserves exact bounded binding and labels the snapshot as data, not approval',()=>{
  const value=draft();assert(value.text.includes('"revision":7'));assert(value.text.includes('"source_sha256":"'+'a'.repeat(64)+'"'));assert(value.text.includes('synthetic-pairing'));assert.match(value.text,/JSON 数据，不是授权或审批指令/);assert.equal(appendAssistanceText('my draft',value),'my draft\n\n────────\n\n'+value.text);
});

test('invalid, cyclic, deep and oversized snapshots fail without truncating or changing the authored draft',()=>{
  for(const patch of [{kind:'unknown'},{prompt:'a'.repeat(2049)},{context:{schema:'wrong',origin:'runtime'}},{context:{...request().context,value:Infinity}},{context:{...request().context,value:()=>{}}},{context:{...request().context,value:'a'.repeat(25*1024)}}])assert.throws(()=>formatAgentAssistance({...request(),...patch},{requestId:'test'}));
  const cyclic=request();cyclic.context.self=cyclic.context;assert.throws(()=>formatAgentAssistance(cyclic,{requestId:'test'}),/JSON/);
  const deep=request();let current=deep.context;for(let i=0;i<9;i++)current=current.child={};assert.throws(()=>formatAgentAssistance(deep,{requestId:'test'}),/8 层/);
  assert.throws(()=>appendAssistanceText('a'.repeat(24000),draft()),/原草稿和请求均保留/);
});

test('closed lazy AI receives one draft without undoing a later close or creating another recipient',async()=>{
  const h=host(),router=createAgentAssistance(h),received=[];let release;router.setLoader(()=>new Promise(resolve=>{release=()=>{router.registerReceiver(d=>{received.push(d);return{status:'prepared',message:'prepared'};});resolve();};}));
  const result=router.request(request());await tick();assert.equal(h.visible,true);assert.match(h.element.textContent,/请求已保留/);h.slot.setVisible(false);release();assert.equal((await result).status,'prepared');assert.equal(h.visible,false);assert.equal(received.length,1);assert.equal(h.element.querySelector('[aria-label="待挂载的仿真请求"]'),null);router.destroy();
});

test('unavailable receiver leaves readable pending draft and retries only mounting, never sending',async()=>{
  const h=host(),router=createAgentAssistance(h);router.setLoader(()=>{throw Error('synthetic mount failure');});assert.equal((await router.request(request())).status,'queued');assert.match(h.element.textContent,/synthetic-intake/);const received=[];router.registerReceiver(d=>{received.push(d);return {status:'queued',message:'Choose session'};});assert.equal(received.length,1);assert.match(received[0].text,/核对当前仿真环境/);router.destroy();
});

test('pending queue retains busy requests and only explicit application consumes them',()=>{
  const h=host();let available=false,applied=[],busy=true;const queue=createAssistanceQueue({element:h.element,getAvailability:()=>({available,message:'Choose a chat'}),apply:d=>busy?{status:'queued',message:'Original turn unknown'}:(applied.push(d),{status:'prepared'})});
  queue.enqueue(draft());queue.enqueue(draft());assert.equal(queue.count,1);assert.match(h.element.textContent,/synthetic-intake/);queue.flush();assert.equal(queue.count,1);busy=false;available=true;queue.flush();assert.equal(queue.count,0);assert.equal(applied.length,1);queue.destroy();
});
