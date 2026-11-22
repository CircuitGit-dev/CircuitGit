import test from 'node:test';import assert from 'node:assert/strict';
import {validateWaveformLocalState} from '../../../apps/codex/ui/waveforms/index.js';
import {validateSimulationLocalState} from '../../../apps/codex/ui/simulation/index.js';
const binding={workspace_id:'w_1',view_id:'v_1',identity:{project_id:'fixture',source_commit:'c',run_id:'run',configuration:'TRAN'}};
const signal={id:'s1',status:'available'};
test('invalid in-progress JSON remains exact raw text in simulation snapshot',()=>{
 const text='{"analysis": { "stop": "12n",\n',saved={schema:'ic.simulation.local.v1',binding,text,tab:'requests',pending_request_ids:['pending']};
 assert.equal(validateSimulationLocalState(saved,structuredClone(binding)),saved);assert.equal(saved.text,text);assert.deepEqual(saved.pending_request_ids,['pending']);
});
test('simulation snapshot cannot cross view, source, run or configuration boundaries',()=>{
 const saved={schema:'ic.simulation.local.v1',binding,text:'invalid {'};
 for(const key of ['project_id','source_commit','run_id','configuration'])assert.throws(()=>validateSimulationLocalState(saved,{...binding,identity:{...binding.identity,[key]:'other'}}));
 assert.throws(()=>validateSimulationLocalState(saved,{...binding,view_id:'v_other'}));assert.throws(()=>validateSimulationLocalState({...saved,text:'汉'.repeat(400000)},binding));
});
test('waveform selection is validated against saved-run catalog and preserves display state',()=>{
 const signals=[{id:'s1',visible:false,loaded:true}],saved={schema:'ic.waveforms.local.v1',binding,panel:{signals,window:[0,2e-8],cursors:{a:1e-8,b:1.1e-8}}};
 assert.equal(validateWaveformLocalState(saved,binding,[signal]),signals);assert.deepEqual(saved.panel.cursors,{a:1e-8,b:1.1e-8});assert.equal(signals[0].visible,false);
});
test('waveform restore rejects unknown, unexported, duplicated and foreign-run signals',()=>{
 const saved={schema:'ic.waveforms.local.v1',binding,panel:{signals:[{id:'s1'}]}};
 assert.throws(()=>validateWaveformLocalState(saved,{...binding,identity:{...binding.identity,run_id:'other'}},[signal]));
 assert.throws(()=>validateWaveformLocalState(saved,binding,[{id:'s1',status:'saved_needs_extraction'}]));
 assert.throws(()=>validateWaveformLocalState({...saved,panel:{signals:[{id:'unknown'}]}},binding,[signal]));
 assert.throws(()=>validateWaveformLocalState({...saved,panel:{signals:[{id:'s1'},{id:'s1'}]}},binding,[signal]));
});
