import test from 'node:test';
import assert from 'node:assert/strict';
import {writable,publishedCell,receiptState,commitDraft,createPublishedHistoryLoader} from '../../apps/web/library/versions.js';
const scope={library_id:'test',cell_id:'gain',directory:'lib/test/gain',cell:'Gain'};
test('editing requires exact library/cell capability and explicit local acknowledgement on mismatch',()=>{
 const description={...scope,source_match:true,capabilities:{save:true}};
 assert.equal(writable(description,scope,'save'),true);assert.equal(writable(description,scope,'commit'),false);
 assert.equal(writable({...description,cell_id:'other'},scope,'save',true),false);
 assert.equal(writable({...description,source_match:false},scope,'save'),false);
 assert.equal(writable({...description,source_match:false},scope,'save',true),true);
 assert.equal(writable(null,scope,'save',true),false);
});
test('public history selects exact directory and identity, never application history',()=>{
 const correct={...scope,commits:[{sha:'a'}]},data={cells:[{...scope,directory:'apps/web',commits:[{sha:'b'}]},correct]};
 assert.equal(publishedCell(data,scope),correct);assert.equal(publishedCell({commits:[{sha:'app'}]},scope),null);
});
test('popup closure and approval are not proof of completion',()=>{
 assert.equal(receiptState({human_review_state:'completed'}),'unknown');assert.equal(receiptState({status:'pending'}),'pending');assert.equal(receiptState({state:'complete'}),'complete');assert.equal(receiptState({receipt:{status:'unknown'}}),'unknown');assert.equal(receiptState({status:'unknown',human_review_state:'expired'}),'expired');
});
test('commit draft is an editable description of current cell files',()=>{
 assert.deepEqual(commitDraft(scope,[{path:'lib/test/gain/netlist.scs'}]),{title:'更新 Gain · 1 个文件',body:'• lib/test/gain/netlist.scs'});
});
test('published metadata uses credential-free scoped read and fails clearly',async()=>{
 let request;const loader=createPublishedHistoryLoader({url:'http://fixture/history.json',fetcher:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({cells:[{...scope,commits:[]}]})};}});
 assert.equal((await loader(scope)).cell_id,'gain');assert.equal(request.options.credentials,'omit');assert.equal(request.options.redirect,'error');
 await assert.rejects(createPublishedHistoryLoader({fetcher:async()=>({ok:false})})(scope),/尚未包含/);
});
