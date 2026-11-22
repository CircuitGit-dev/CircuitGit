import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyLayout,validateLayout,parseLayout,groups,visibleIds,activeIds,findGroup,addPanel,movePanel,closePanel,activatePanel,maximizePanel,resizeSplit,resetLayout} from '../../../apps/codex/ui/workbench/layout.js';
const panel=(id,kind='waveforms')=>({id,kind,title:kind+' '+id});
const initial=()=>addPanel(addPanel(addPanel(emptyLayout(),panel('s','schematic')),panel('w')),panel('c','simulation'));

test('registry persists closed views; all closed serializes and reopens same id',()=>{
  let layout=initial();for(const id of ['s','w','c'])layout=closePanel(layout,id);
  assert.equal(layout.tree,null);assert.equal(layout.panels.length,3);assert.deepEqual(parseLayout(JSON.stringify(layout)),layout);
  layout=addPanel(layout,panel('w'));assert.deepEqual(visibleIds(layout),['w']);assert.equal(layout.panels.length,3);
});
test('merge and reorder tabs retain unique panel ids and activate dropped tab',()=>{
  let layout=resetLayout(initial());const target=findGroup(layout,'s').id;layout=movePanel(layout,'w',target,'center','s');
  assert.deepEqual(findGroup(layout,'w').tabs,['w','s']);assert.equal(findGroup(layout,'w').active,'w');
  layout=movePanel(layout,'w',target,'center');assert.deepEqual(findGroup(layout,'w').tabs,['s','w']);assert.equal(new Set(visibleIds(layout)).size,3);
});
test('four edges map to split axis and order without losing source siblings',()=>{
  for(const edge of ['left','right','top','bottom']){
    const source=initial(),target=findGroup(source,'w').id;const layout=movePanel(source,'w',target,edge);
    assert.equal(layout.tree.axis,['left','right'].includes(edge)?'horizontal':'vertical');
    assert.equal(layout.tree[['left','top'].includes(edge)?'first':'second'].tabs[0],'w');
    assert.deepEqual(new Set(visibleIds(layout)),new Set(['s','w','c']));assert.equal(source.tree.type,'group');
  }
});
test('moving singleton group collapses redundant split and self drop is no-op',()=>{
  let layout=resetLayout(initial());const source=findGroup(layout,'s').id;assert.deepEqual(movePanel(layout,'s',source,'left'),layout);
  layout=movePanel(layout,'w',findGroup(layout,'c').id,'center');assert.equal(groups(layout.tree).length,2);
  layout=movePanel(layout,'c',findGroup(layout,'s').id,'center');layout=movePanel(layout,'w',findGroup(layout,'s').id,'center');assert.equal(layout.tree.type,'group');
});
test('closing active tab selects neighbor; inactive close retains active',()=>{
  let layout=activatePanel(initial(),'w');layout=closePanel(layout,'s');assert.equal(layout.tree.active,'w');layout=closePanel(layout,'w');assert.equal(layout.tree.active,'c');
});
test('maximize retains underlying tree and tab switch changes maximized view',()=>{
  const original=resetLayout(initial());let layout=maximizePanel(original,'w');assert.deepEqual(layout.tree,original.tree);assert.deepEqual(activeIds(layout),['w']);
  layout=activatePanel(layout,'c');assert.equal(layout.maximized,'c');layout=maximizePanel(layout,'c');assert.equal(layout.maximized,null);assert.equal(activeIds(layout).length,3);
  layout=closePanel(maximizePanel(layout,'w'),'w');assert.equal(layout.maximized,null);
});
test('ratio clamp, immutable edits and reset restore balanced grouped kinds',()=>{
  const original=resetLayout(initial()),small=resizeSplit(original,original.tree.id,-5),large=resizeSplit(original,original.tree.id,5);
  assert.equal(small.tree.ratio,.15);assert.equal(large.tree.ratio,.85);assert.equal(original.tree.ratio,.6);assert.throws(()=>resizeSplit(original,original.tree.id,NaN),/有限/);
  const restored=resetLayout(closePanel(initial(),'w'));assert.deepEqual(new Set(visibleIds(restored)),new Set(['s','w','c']));assert.equal(restored.tree.ratio,.6);
});
test('default puts schematic and simulation side by side above full-width waveform at 40 percent',()=>{
  const layout=resetLayout(addPanel(initial(),panel('w2')));
  assert.equal(layout.tree.axis,'vertical');assert.equal(layout.tree.ratio,.6);
  assert.equal(layout.tree.first.axis,'horizontal');assert.equal(layout.tree.first.ratio,.62);
  assert.deepEqual(layout.tree.first.first.tabs,['s']);assert.deepEqual(layout.tree.first.second.tabs,['c']);
  assert.deepEqual(layout.tree.second.tabs,['w','w2']);assert.equal(layout.tree.second.active,'w');validateLayout(layout);
});
test('partial defaults keep waveform below either other kind and single-kind views fill the space',()=>{
  for(const kind of ['schematic','simulation']){
    const layout=resetLayout(addPanel(addPanel(emptyLayout(),panel('top',kind)),panel('wave')));
    assert.equal(layout.tree.axis,'vertical');assert.equal(layout.tree.ratio,.6);assert.deepEqual(layout.tree.first.tabs,['top']);assert.deepEqual(layout.tree.second.tabs,['wave']);
  }
  const topOnly=resetLayout(closePanel(addPanel(addPanel(emptyLayout(),panel('s','schematic')),panel('c','simulation')),'s'));
  assert.equal(topOnly.tree.axis,'horizontal');assert.deepEqual(topOnly.tree.first.tabs,['s']);assert.deepEqual(topOnly.tree.second.tabs,['c']);
  assert.equal(resetLayout(addPanel(emptyLayout(),panel('w'))).tree.type,'group');assert.equal(resetLayout(emptyLayout()).tree,null);
});
test('reject invalid schema, duplicate/foreign views, unbounded or malformed nodes',()=>{
  const source=initial();const bad=[{...source,version:2},{...source,token:'secret'},{...source,panels:[...source.panels,panel('s')]},{...source,panels:[...source.panels,panel('s2','schematic')]},{...source,maximized:'missing'},{...source,tree:{...source.tree,tabs:['s','s']}},{...source,tree:{...source.tree,tabs:['foreign']}},{...source,tree:{...source.tree,active:'foreign'}}];
  for(const layout of bad)assert.throws(()=>validateLayout(layout));assert.throws(()=>parseLayout('x'.repeat(131073)),/128 KiB/);
});
test('reject duplicate node ids, too deep trees and excess panel registry',()=>{
  let layout=emptyLayout();for(let i=0;i<16;i++)layout=addPanel(layout,panel('p'+i));assert.throws(()=>addPanel(layout,panel('p16')));
  let node={type:'group',id:'leaf-0',tabs:['p0'],active:'p0'};
  for(let i=1;i<9;i++)node={type:'split',id:'split-'+i,axis:'horizontal',ratio:.5,first:node,second:{type:'group',id:'leaf-'+i,tabs:['p'+i],active:'p'+i}};
  assert.throws(()=>validateLayout({...layout,tree:node}),/8 层/);
  const split=resetLayout(initial());split.tree.second.id=split.tree.id;assert.throws(()=>validateLayout(split),/重复/);
});
test('deep edge move fails atomically and original layout remains usable',()=>{
  let layout=emptyLayout();for(let i=0;i<8;i++)layout=addPanel(layout,panel('p'+i),{edge:i?'right':'center'});
  const original=JSON.stringify(layout);assert.throws(()=>addPanel(layout,panel('p8'),{edge:'right'}),/8 层/);assert.equal(JSON.stringify(layout),original);validateLayout(layout);
});
test('panel title and node bounds match the backend limits',()=>{
  const layout=addPanel(emptyLayout(),{...panel('w'),title:'x'.repeat(256)});layout.tree.id='n'.repeat(180);validateLayout(layout);
  assert.throws(()=>validateLayout({...layout,panels:[{...panel('w'),title:'x'.repeat(257)}]}));
  assert.throws(()=>validateLayout({...layout,tree:{...layout.tree,id:'n'.repeat(181)}}));
  const longRun='r'.repeat(180);validateLayout(addPanel(emptyLayout(),{...panel('v'),title:'波形 · '+longRun}));
});
