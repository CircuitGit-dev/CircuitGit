import test from 'node:test';
import assert from 'node:assert/strict';
import {writable,publishedCell,receiptState,receiptReleased,commitDraft,createPublishedHistoryLoader,textDiff,createPendingStore,testbenchExecutionLabel} from '../../apps/web/library/versions.js';
import {createLibraryBridge,cellFingerprint} from '../../apps/web/remote/library-bridge.js';
const scope={library_id:'test',cell_id:'gain',directory:'lib/test/gain',cell:'Gain'};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('paired scoped capability permits editing independent of public snapshot age',()=>{
 const description={...scope,source_match:false,capabilities:{save:true}};
 assert.equal(writable(description,scope,'save'),true);assert.equal(writable(description,scope,'commit'),false);assert.equal(writable({...description,cell_id:'other'},scope,'save'),false);assert.equal(writable(null,scope,'save'),false);
});
test('public history selects exact directory and identity, never application history',()=>{
 const correct={...scope,commits:[{sha:'a'}]},data={cells:[{...scope,directory:'apps/web',commits:[{sha:'b'}]},correct]};assert.equal(publishedCell(data,scope),correct);assert.equal(publishedCell({commits:[{sha:'app'}]},scope),null);
});
test('only complete receipts represent success; rollback and partial are distinct',()=>{
 assert.equal(receiptState({}),'unknown');assert.equal(receiptState({state:'complete'}),'complete');assert.equal(receiptState({state:'rolled_back'}),'rolled_back');assert.equal(receiptState({state:'partial'}),'partial');
 for(const state of ['prepared','not_found','failed']){assert.equal(receiptReleased({state}),false);assert.equal(receiptReleased({state,dispatched:true}),false);assert.equal(receiptReleased({state,dispatched:false}),true);}
 for(const state of ['partial','unknown','pending'])assert.equal(receiptReleased({state,dispatched:false}),false);
 assert.equal(receiptReleased({state:'rolled_back'}),true);assert.equal(receiptReleased({receipt:{state:'prepared',dispatched:false}}),true);
});
test('linear editor diff is bounded and preserves literal source text',()=>{
 assert.equal(textDiff('same','same'),'尚无修改。');assert.match(textDiff('R=1k\n','R=2k\n'),/-R=1k\n\+R=2k/);assert.match(textDiff('','<script>test()</script>'),/\+<script>/);assert.match(textDiff('','x'.repeat(600000)),/文件较大/);assert.match(textDiff('','x\n'.repeat(300)),/截断/);
});
test('pending request metadata survives remount without persisting code or credentials',()=>{
 const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};const first=createPendingStore(storage);const record=first.remember({...scope,repository:'owner/repo',operation:'save',idempotency_key:'original-key-123',paths:['lib/test/gain/a.scs'],content:'private source',token:'secret'});
 const restored=createPendingStore(storage);assert.equal(restored.find(scope,'owner/repo').idempotency_key,'original-key-123');assert.equal(restored.find(scope,'other/repo'),null);assert.doesNotMatch([...values.values()][0],/private source|secret|"content"|"token"/);restored.forget(record);assert.equal(restored.find(scope),null);
});
test('commit draft describes current cell files',()=>{assert.deepEqual(commitDraft(scope,[{path:'lib/test/gain/a.scs'}]),{title:'更新 Gain · 1 个文件',body:'• lib/test/gain/a.scs'});});
test('Testbench CI distinguishes unrun, named-analysis success, invalid and uncertain results',()=>{
 assert.equal(testbenchExecutionLabel('not_run'),'尚未运行 CI');assert.match(testbenchExecutionLabel('passed'),/命名分析/);
 assert.match(testbenchExecutionLabel('invalid'),/无效/);assert.match(testbenchExecutionLabel('unknown'),/未自动重跑/);
 assert.doesNotMatch(testbenchExecutionLabel('unrecognized'),/满足验收|尚未运行/);
});
test('published metadata uses credential-free reads',async()=>{
 let options;const loader=createPublishedHistoryLoader({fetcher:async(_url,value)=>(options=value,{ok:true,json:async()=>({cells:[{...scope,commits:[]}]})})});assert.equal((await loader(scope)).cell_id,'gain');assert.equal(options.credentials,'omit');await assert.rejects(createPublishedHistoryLoader({fetcher:async()=>({ok:false})})(scope),/尚未包含/);
});
test('bridge executes finite direct operations once per stable key and emits one mutation',async()=>{
 const calls=[],events=[],bridge=createLibraryBridge();bridge.bind({request:async(path,options)=>(calls.push({path,...options}),{state:'complete'})});bridge.subscribeMutation(event=>events.push(event));const body={operation:'save',args:{...scope,path:'lib/test/gain/a.scs',content:'R=2k',base_sha256:'a'.repeat(64)},idempotency_key:'stable-save-key'};
 assert.equal((await bridge.request('execute',body)).state,'complete');assert.equal(calls[0].path,'/library/execute');assert.deepEqual(calls[0].body,body);assert.equal(events.length,1);await assert.rejects(bridge.request('execute',body),/已经发送/);await bridge.request('receipt',{idempotency_key:body.idempotency_key});assert.equal(events.length,1);await assert.rejects(bridge.request('confirm',{review_id:'test'}),/不支持/);await assert.rejects(bridge.request('execute',{...body,operation:'shell'}),/参数无效/);bridge.unbind();
});
test('lost direct execution is reconciled only by the original receipt key after reconnect',async()=>{
 let executions=0;const bridge=createLibraryBridge();bridge.bind({request:async()=>{executions++;throw Error('lost response');}});const body={operation:'save',args:scope,idempotency_key:'lost-save-key'};await assert.rejects(bridge.request('execute',body));bridge.unbind();const reads=[];bridge.bind({request:async(_path,{body})=>(reads.push(body),{state:'complete'})});await bridge.request('receipt',{idempotency_key:body.idempotency_key});assert.equal(executions,1);assert.deepEqual(reads,[{operation:'receipt',args:{idempotency_key:'lost-save-key'}}]);await assert.rejects(bridge.request('execute',body),/已经发送/);bridge.unbind();
});
test('shared watcher skips hidden cells and never overlaps reads',async()=>{
 let visible=false,active=0,max=0,reads=0;const bridge=createLibraryBridge({pollInterval:10});bridge.bind({request:async()=>{reads++;active++;max=Math.max(max,active);await wait(25);active--;return {fingerprint:String(reads)};}});const stop1=bridge.watchCell(scope,{isVisible:()=>visible}),stop2=bridge.watchCell(scope,{isVisible:()=>visible});await wait(25);assert.equal(reads,0);visible=true;await wait(95);assert.equal(max,1);assert.ok(reads>=2&&reads<=4);visible=false;await wait(35);const before=reads;await wait(35);assert.equal(reads,before);stop1();stop2();bridge.unbind();
});
test('fingerprint includes server revision and current file hashes',()=>{assert.equal(cellFingerprint({fingerprint:'observed'}),'observed');assert.notEqual(cellFingerprint({changes:[{path:'a',sha256:'1'}]}),cellFingerprint({changes:[{path:'a',sha256:'2'}]}));});
