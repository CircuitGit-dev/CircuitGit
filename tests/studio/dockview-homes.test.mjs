import test from 'node:test';
import assert from 'node:assert/strict';
import {remainingLayout,homeRelations,boundedFloat} from '../../apps/web/studio/dockview/homes.js';
import {projectRuns} from '../../apps/web/studio/dockview/waveforms.js';
const layout=()=>({grid:{width:1000,height:800,orientation:'HORIZONTAL',root:{type:'branch',data:[{type:'leaf',size:600,data:{id:'one',views:['schematic'],activeView:'schematic'}}]}},panels:{schematic:{id:'schematic'},waveforms:{id:'waveforms'}},activeGroup:'one',floatingGroups:[{data:{id:'two',views:['waveforms'],activeView:'waveforms'},position:{left:40,top:50,width:600,height:400}}]});
test('return fingerprint permits focus and float resizing but rejects unrelated layout edits',()=>{
 const before=layout(),after=structuredClone(before);after.activeGroup='two';after.floatingGroups[0].position.width=700;
 assert.equal(remainingLayout(before,['waveforms']),remainingLayout(after,['waveforms']));
 after.grid.root.data[0].size=500;assert.notEqual(remainingLayout(before,['waveforms']),remainingLayout(after,['waveforms']));
 assert.equal(before.floatingGroups.length,1);
});
test('dock home prefers its sibling tab index, otherwise the original adjacent edge',()=>{
 const origin={ids:['a','waveforms','b'],box:{x:0,y:400,width:700,height:200},location:'grid'};
 const other={ids:['schematic'],box:{x:0,y:0,width:700,height:396},location:'grid'};
 const relations=homeRelations(origin,[origin,other],['waveforms']);
 assert.deepEqual(relations[0],{id:'a',position:'center',index:1});assert.equal(relations[2].position,'bottom');
});
test('floating dimensions stay within the new viewport',()=>{
 assert.deepEqual(boundedFloat({left:900,top:800,width:700,height:400},{width:800,height:600}),{left:100,top:200,width:700,height:400});
 assert.deepEqual(boundedFloat(null,{width:800,height:600}),{width:640,height:420});
});
test('run picker never offers another project or assumes global active run',()=>{
 const a={run_id:'one',associated_project_id:'p'},b={run_id:'two',project_id:'q'},c={run_id:'three',project_id:'p'};
 assert.deepEqual(projectRuns([a,b,c],'p'),[a,c]);assert.deepEqual(projectRuns([a,b,c],'none'),[]);
});
