import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectedInstanceProperties} from '../../modules/schematic/instance-properties.js';

function fixture(statement='M0 (d g s b) actual_nfet w=1u l=60n nf=2 m=4'){
  return {dialect:'spectre',objects:[{kind:'instance',name:'M0',level:0,lines:[0,2,statement.split('\n').length+1]}],files:[{path:'cell.scs',format:'spectre',text:'// first line\n'+statement+'\n// next line'}]};
}
test('selected transistor uses its exact original model and dimensions',()=>{
  const value=selectedInstanceProperties(fixture(),0);
  assert.equal(value.model,'actual_nfet');assert.deepEqual(value.dimensions,[{name:'w',value:'1u'},{name:'l',value:'60n'},{name:'nf',value:'2'},{name:'m',value:'4'}]);
  assert.deepEqual(value.source,{path:'cell.scs',start:2,end:2});
});
test('dimensions preserve quoted grouped and continued expressions without evaluating them',()=>{
  const value=selectedInstanceProperties(fixture('M0 (d g s b) pdk_nfet w=(baseW + 2u) \\\n  l="min_length + delta" nf=ceil(NF/2) m=2 other=9'),0);
  assert.equal(value.available,true);assert.deepEqual(value.dimensions.map(item=>item.value),['(baseW + 2u)','"min_length + delta"','ceil(NF/2)','2']);
});
test('same-named devices in other scopes cannot replace the exact selected span',()=>{
  const doc=fixture();doc.files[0].text+='\nM0 (d g s b) other_nfet w=9u l=1u';
  assert.equal(selectedInstanceProperties(doc,0).model,'actual_nfet');
});
test('ambiguous missing and unsupported source identity fails closed',()=>{
  for(const change of [d=>{d.objects[0].name='M1';},d=>{d.objects[0].lines=null;},d=>{d.objects[0].lines=[0,2,30];},d=>{d.files[0].format='spice';},d=>{d.objects[0].lines=[0,1,3];}]){
    const doc=fixture();change(doc);assert.equal(selectedInstanceProperties(doc,0).available,false);
  }
  const doc=fixture();doc.objects[0].kind='net';assert.equal(selectedInstanceProperties(doc,0),null);
});
test('repeated dimension assignment is not silently resolved and absent values stay absent',()=>{
  const value=selectedInstanceProperties(fixture('M0 (d g s b) nmos w=1u w=2u l=90n'),0);
  assert.deepEqual(value.dimensions,[{name:'l',value:'90n'}]);
});
