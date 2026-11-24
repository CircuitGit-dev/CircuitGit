import test from 'node:test';
import assert from 'node:assert/strict';
import {readOverview,selectionFor,countsFor,localEvidenceHref} from '../../apps/web/workflow/model.js';

const fixture=()=>({schema:'ic.workflow.overview.v1',cases:['bootstrap','inverter'].map(id=>({id,title:id,stages:Array.from({length:10},(_,index)=>({id:'step-'+(index+1),title:'Step '+(index+1),status:index<7?'verified':index===7?'review':'planned'}))}))});
test('case and exact stage deep links remain separate identities',()=>{
  const data=readOverview(fixture()),selected=selectionFor(data,'https://example.test/workflow/?case=inverter&stage=step-8');assert.equal(selected.item.id,'inverter');assert.equal(selected.index,7);
  assert.deepEqual(countsFor(selected.item),{verified:7,review:1,planned:2,illustrative:0});
  const missing=selectionFor(data,'https://example.test/workflow/?case=missing&stage=step-99');assert.equal(missing.item.id,'bootstrap');assert.equal(missing.index,0);
});
test('all ten explicit evidence states are required; duplicate or incomplete identities fail closed',()=>{
  for(const mutate of [data=>data.schema='future',data=>data.cases[0].stages.pop(),data=>data.cases[0].stages[1].id='step-1',data=>data.cases[0].stages[0].status='success',data=>data.cases[1].id='bootstrap']){const value=fixture();mutate(value);assert.throws(()=>readOverview(value));}
});
test('evidence links are limited to publication assets, not endpoints or external content',()=>{
  assert.equal(localEvidenceHref('data/sources/dut.scs'),'data/sources/dut.scs');
  for(const path of ['javascript:alert(1)','https://private.test/model','data/../config/local.json','data/%2e%2e/local','/api/ai/turn','../studio/index.html','data/a b.json','data\\secret','data/\nsecret'])assert.equal(localEvidenceHref(path),null,path);
});
