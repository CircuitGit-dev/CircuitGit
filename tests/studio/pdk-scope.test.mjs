import test from 'node:test';
import assert from 'node:assert/strict';
import {setupPdkScopeFixture,scopeIds} from './pdk-scope.fixture.mjs';
import {checkTestbenchHeaderSelection,checkPdkScopeSelection} from '../../modules/simulation/environment/agent-testbench.js';
const clone=value=>structuredClone(value);
const begin=async options=>{const result=await setupPdkScopeFixture(options),c=result.controller;c.selectScopeLibrary({probe_id:scopeIds.probe,library_id:scopeIds.library});await c.readPdkScopes({kind:'entries'});c.selectScopeEntry(scopeIds.entries[1]);await c.readPdkScopes({kind:'sections'});return result;};

test('saved catalogs require explicit entry/section choice and use exact returned page offsets without scan hints',async()=>{
  const {controller:c,fixture:f}=await setupPdkScopeFixture();assert.equal(c.state.scopeChoice.entryId,'');assert.deepEqual(c.state.scopeChoice.sectionIds,[]);
  c.setHint('search_paths','/unrelated/synthetic/search');c.selectScopeLibrary({probe_id:scopeIds.probe,library_id:scopeIds.library});await c.readPdkScopes({kind:'entries'});assert.equal(c.state.scopeChoice.entryId,'');await c.readPdkScopes({kind:'entries',more:true});assert.equal(c.state.scopeEntries.result.catalog.items.length,3);assert.equal(c.state.scopeEntries.result.catalog.next_offset,null);await assert.rejects(c.readPdkScopes({kind:'entries',more:true}),/下一页/);
  c.selectScopeEntry(scopeIds.entries[1]);await c.readPdkScopes({kind:'sections'});assert.deepEqual(c.state.scopeChoice.sectionIds,[]);await c.readPdkScopes({kind:'sections',more:true});c.selectScopeSections([scopeIds.sections[3],scopeIds.sections[0]]);
  const calls=f.calls.filter(row=>row.method==='getPdkScopes');assert.deepEqual(calls.map(row=>row.args.offset),[0,2,0,2]);assert(calls.every(row=>Object.keys(row.args).every(key=>['intake_id','probe_id','library_id','entry_id','offset','limit'].includes(key))));
  const before=clone(f.saved.agent_tb);await c.savePdkScope();const write=f.calls.find(row=>row.method==='selectPdkScope').args;assert.deepEqual(write.section_ids,[scopeIds.sections[3],scopeIds.sections[0]]);assert.equal(Object.hasOwn(write,'tmi_option_id'),false);assert.deepEqual(f.saved.agent_tb.testbench,before.testbench);assert.equal(f.saved.agent_tb.draft_id,before.draft_id);assert.deepEqual(f.saved.agent_tb.selection,before.selection);assert.equal(f.saved.agent_tb.status,'binding_stale');assert.equal(c.state.session.pdk_scope_selection.ready_to_run,false);await assert.rejects(c.prepareAgentTestbench(),/保存/);c.destroy();
});

test('catalog pages reject foreign bindings, malformed rows, duplicates and invented pagination',async()=>{
  for(const mutate of [v=>v.intake_id='foreign',v=>v.probe_id='foreign',v=>v.catalog.library_id='f'.repeat(64),v=>v.catalog.entry_id=scopeIds.entries[0],v=>v.catalog.items[0].entry_sha256='bad',v=>v.catalog.items[1].entry_id=v.catalog.items[0].entry_id,v=>v.catalog.next_offset=17,v=>v.catalog.ready_to_run=true]){
    const {controller:c,fixture:f}=await setupPdkScopeFixture(),original=f.adapter.getPdkScopes;f.adapter.getPdkScopes=async args=>{const value=await original(args);mutate(value);return value;};c.selectScopeLibrary({probe_id:scopeIds.probe,library_id:scopeIds.library});await assert.rejects(c.readPdkScopes({kind:'entries'}));assert.equal(c.state.scopeEntries.result,null);c.destroy();
  }
  const {controller:c,fixture:f}=await begin();const original=f.adapter.getPdkScopes;f.adapter.getPdkScopes=async args=>{const value=await original(args);value.catalog.items[0].section_id=scopeIds.sections[0];return value;};await assert.rejects(c.readPdkScopes({kind:'sections',more:true}),/重复/);assert.equal(c.state.scopeSections.result.catalog.items.length,2);c.destroy();
});

test('ordered sections stay unique, bounded to 64 and cannot cross entries',async()=>{
  const {controller:c}=await begin({pageSize:64});await c.readPdkScopes({kind:'sections',more:true});assert.throws(()=>c.selectScopeSections(scopeIds.sections),/64/);assert.throws(()=>c.selectScopeSections([scopeIds.sections[0],scopeIds.sections[0]]),/不同/);const chosen=scopeIds.sections.slice(0,64).reverse();c.selectScopeSections(chosen);assert.deepEqual(c.state.scopeChoice.sectionIds,chosen);c.selectScopeEntry(scopeIds.entries[0]);assert.deepEqual(c.state.scopeChoice.sectionIds,[]);assert.equal(c.state.scopeSections.result,null);assert.throws(()=>c.selectScopeSections([scopeIds.sections[0]]),/当前入口/);c.destroy();
});

test('TMI is selected only from the saved scope then re-saved with fresh CAS and selection identity',async()=>{
  const {controller:c,fixture:f}=await begin({tmiRequired:true});c.selectScopeSections([scopeIds.sections[1],scopeIds.sections[0]]);assert.throws(()=>c.selectScopeTmi(scopeIds.tmi[0]),/已保存/);await c.savePdkScope();const first=clone(f.saved.pdk_scope_selection),revision=f.saved.revision;assert.equal(first.status,'blocked');assert.throws(()=>c.adoptPdkScope(),/完整作用域/);assert.throws(()=>c.selectScopeTmi('a'.repeat(64)),/TMI/);c.selectScopeTmi(scopeIds.tmi[1]);assert.equal(f.saved.revision,revision);await c.savePdkScope();const calls=f.calls.filter(row=>row.method==='selectPdkScope');assert.equal(calls[1].args.revision,revision);assert.equal(calls[1].args.tmi_option_id,scopeIds.tmi[1]);assert.notEqual(f.saved.pdk_scope_selection.selection_id,first.selection_id);assert.equal(f.saved.pdk_scope_selection.status,'requires_audit');c.destroy();
});

test('adopting a saved scope edits selection only, preserves authored helpers and requires a new draft save',async()=>{
  const {controller:c,fixture:f}=await begin();c.selectScopeSections([scopeIds.sections[1]]);await c.savePdkScope();const code=c.agentEditor.code+'// local edit\r\n',metadata=JSON.parse(c.agentEditor.manifest);metadata.helper_files={'helper.va':'\uFEFFmodule helper;\r\nendmodule\r\n'};c.editAgentTestbench('code',code);c.editAgentTestbench('manifest',JSON.stringify(metadata,null,2)+'\n');const manifest=c.agentEditor.manifest;c.adoptPdkScope();assert.equal(c.agentEditor.code,code);assert.equal(c.agentEditor.manifest,manifest);assert.deepEqual(JSON.parse(c.agentEditor.selection),{scope_selection_id:f.saved.pdk_scope_selection.selection_id,host_ids:['synthetic-host']});assert.equal(c.agentEditor.error,null);await assert.rejects(c.prepareAgentTestbench(),/保存/);await c.saveAgentTestbench();assert.equal(f.saved.agent_tb.status,'draft');assert.equal(f.saved.agent_tb.testbench.text,code);assert.equal(f.saved.agent_tb.testbench.helper_files['helper.va'],metadata.helper_files['helper.va']);c.destroy();
});

test('saved-scope source, library, ID and same-probe header evidence cannot be mixed',async()=>{
  const {controller:c,fixture:f}=await begin();c.selectScopeSections([scopeIds.sections[0]]);await c.savePdkScope();c.adoptPdkScope();const selected=JSON.parse(c.agentEditor.selection),saved=clone(f.saved);assert.equal(checkPdkScopeSelection(saved).selection_id,selected.scope_selection_id);
  assert.throws(()=>checkTestbenchHeaderSelection({...selected,candidate_id:'synthetic-candidate'},saved),/绑定/);assert.throws(()=>checkTestbenchHeaderSelection({...selected,scope_selection_id:'a'.repeat(64)},saved),/绑定/);
  const header={id:'headers_'+'9'.repeat(64),probe_id:scopeIds.probe,status:'observed',coverage:{complete:true},missing:[]};saved.veriloga_headers=[header];assert.doesNotThrow(()=>checkTestbenchHeaderSelection({...selected,veriloga_header_id:header.id},saved));saved.veriloga_headers[0].probe_id='probe_'+'2'.repeat(32);assert.throws(()=>checkTestbenchHeaderSelection({...selected,veriloga_header_id:header.id},saved),/主机/);saved.pdk_scope_selection.source_sha256='b'.repeat(64);assert.throws(()=>checkPdkScopeSelection(saved),/源码/);c.destroy();
});

test('fresh library/probe changes clear stale catalog UI while TB text and selection stay available',async()=>{
  const {controller:c,fixture:f}=await begin();c.selectScopeSections([scopeIds.sections[1]]);const code=c.agentEditor.code,selection=c.agentEditor.selection;
  f.saved={...f.saved,revision:f.saved.revision+1,discovery:{...f.saved.discovery,lut:[{probe_id:scopeIds.probe,library_id:'f'.repeat(64)}]}};await c.refreshCurrent({...c.currentBinding,revision:f.saved.revision});assert.equal(c.state.scopeChoice.libraryId,'');assert.equal(c.state.scopeEntries.result,null);assert.equal(c.agentEditor.code,code);assert.equal(c.agentEditor.selection,selection);c.destroy();
});

test('read replies crossing selected intake or connection never populate scope state',async()=>{
  for(const changed of [{selectedIntakeId:'another-intake'},{connectionId:'another-connection'}]){const {controller:c,fixture:f}=await setupPdkScopeFixture();c.selectScopeLibrary({probe_id:scopeIds.probe,library_id:scopeIds.library});let release;const original=f.adapter.getPdkScopes;f.adapter.getPdkScopes=async args=>{const result=await original(args);await new Promise(resolve=>{release=resolve;});return result;};const work=c.readPdkScopes({kind:'entries'});await new Promise(resolve=>setImmediate(resolve));f.setConnection(changed);release();await assert.rejects(work,/变化|切换/);assert.equal(c.state.scopeEntries.result,null);c.destroy();}
});

test('uncertain scope save blocks replay and edits until an original-session readback',async()=>{
  const {controller:c,fixture:f}=await begin();c.selectScopeSections([scopeIds.sections[1]]);const original=f.adapter.selectPdkScope;f.adapter.selectPdkScope=async args=>{await original(args);throw Object.assign(Error('lost response'),{data:{code:'transport_unknown'}});};await assert.rejects(c.savePdkScope(),/lost/);assert.equal(c.state.scopeSave.status,'unknown');assert.throws(()=>c.selectScopeSections([]),/保存结果未知/);assert.throws(()=>c.setTargets(['new-host']),/保存结果未知/);await assert.rejects(c.savePdkScope(),/保存结果未知/);assert.equal(f.calls.filter(row=>row.method==='selectPdkScope').length,1);await c.refreshCurrent({...c.currentBinding,revision:f.saved.revision});assert.equal(c.state.scopeSave.status,'idle');assert.equal(c.state.session.pdk_scope_selection.selection_id,f.saved.pdk_scope_selection.selection_id);c.destroy();
});

test('a library read reset clears stale local choices and current intake is checked before any scope write',async()=>{
  const {controller:c,fixture:f}=await begin();c.selectScopeSections([scopeIds.sections[0]]);await c.readPdkScopes({kind:'entries'});assert.equal(c.state.scopeChoice.entryId,'');assert.deepEqual(c.state.scopeChoice.sectionIds,[]);assert.equal(c.state.scopeSections.result,null);c.selectScopeEntry(scopeIds.entries[0]);await c.readPdkScopes({kind:'sections'});c.selectScopeSections([scopeIds.sections[0]]);f.setConnection({selectedIntakeId:'foreign'});await assert.rejects(c.savePdkScope(),/未提交旧作用域/);assert.equal(f.calls.filter(row=>row.method==='selectPdkScope').length,0);c.destroy();
});

test('a late scope write is held as unknown across connection changes and cannot be replayed',async()=>{
  const {controller:c,fixture:f}=await begin();c.selectScopeSections([scopeIds.sections[0]]);const original=f.adapter.selectPdkScope;let release;f.adapter.selectPdkScope=async args=>{const value=await original(args);await new Promise(resolve=>{release=resolve;});return value;};const work=c.savePdkScope();await new Promise(resolve=>setImmediate(resolve));f.setConnection({connectionId:'other-connection'});release();await assert.rejects(work,/连接已变化/);assert.equal(c.state.scopeSave.status,'unknown');assert.equal(c.locked,true);f.setConnection({connectionId:'synthetic-connection'});await c.ready;await assert.rejects(c.savePdkScope(),/保存结果未知/);await c.refreshCurrent({...c.currentBinding,revision:f.saved.revision});assert.equal(c.state.scopeSave.status,'idle');assert.equal(f.calls.filter(row=>row.method==='selectPdkScope').length,1);c.destroy();
});

test('clearing a dropdown clears its request choice instead of silently retaining the previous selection',async()=>{
  const {controller:c}=await begin();c.selectScopeSections([scopeIds.sections[0]]);await c.savePdkScope();c.selectScopeTmi(scopeIds.tmi[0]);c.selectScopeTmi(null);assert.equal(c.state.scopeChoice.tmiOptionId,null);c.selectScopeLibrary();assert.equal(c.state.scopeChoice.libraryId,'');assert.deepEqual(c.state.scopeChoice.sectionIds,[]);assert.equal(c.state.scopeEntries.result,null);await assert.rejects(c.savePdkScope(),/明确选择/);c.destroy();
});
