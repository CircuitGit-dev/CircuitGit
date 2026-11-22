import test from 'node:test';
import assert from 'node:assert/strict';
import {selectionContext,assertWaveformResponse} from '../../../apps/codex/ui/waveforms/summary.js';
const signal={id:'s',psf_name:'VDD0:p',unit:'A',quantity:'current',polarity:'into_terminal',sample_count:158252,csv_sha256:'a'.repeat(64),data_basis:'PSFXL_native_samples'};
const data={run_id:'r',source_commit:'c',signal,csv_sha256:signal.csv_sha256,points:[[0,-.05],[1e-8,-.065]],measurement:{basis:'PSFXL_native_samples',cursors:{a:{x:1e-8,y:-.065,method:'linear_interpolation_of_native_psfxl_samples'}},delta:{dt:1e-9,dy:0,x_unit:'s',y_unit:'A'},uses_display_samples:false}};
test('compact model context preserves current sign/provenance and excludes all sample arrays',()=>{
 const value=selectionContext({view_id:'v',workspace_id:'w',revision:2,project_id:'p',run_id:'r',run_source_commit:'c'},
  {signals:[{id:'s',visible:true,loaded:true}],window:[0,2.4e-8],cursors:{a:1e-8,b:1.1e-8}}, {signals:[{...signal,private:'must not leak'}]},new Map([['s',{...data,private:'must not leak'}]]));
 assert.equal(value.signals[0].measurement.a.y,-.065);assert.equal(value.signals[0].polarity,'into_terminal');assert.equal(value.signals[0].sample_count,158252);assert(!JSON.stringify(value).includes('points'));assert(!JSON.stringify(value).includes('private'));assert(JSON.stringify(value).length<2000);
});
test('unloaded or hidden views never retain previous cursor measurement as current',()=>{
 const value=selectionContext({view_id:'v',workspace_id:'w',revision:2}, {signals:[{id:'s',loaded:false,visible:false}]}, {signals:[signal]},new Map([['s',data]]));
 assert.equal(value.signals[0].measurement,null);assert.equal(value.signals[0].visible,false);
});
test('wrong run/source/signal/unit/hash and display-based cursors fail closed',()=>{
 const options={runId:'r',signal,catalog:{source_commit:'c'}};assert.equal(assertWaveformResponse(data,options),data);
 for(const patch of [{run_id:'other'},{source_commit:'other'},{signal:{...signal,id:'other'}},{signal:{...signal,unit:'V'}},{csv_sha256:'b'.repeat(64)},{measurement:{uses_display_samples:true}},{points:[[NaN,2]]}])assert.throws(()=>assertWaveformResponse({...data,...patch},options));
});
