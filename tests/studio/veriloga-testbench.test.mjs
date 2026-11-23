import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {checkTestbenchDocument,checkTestbenchHelpers,decodeTestbenchHelper,editTestbenchHelper,preserveHelperLineEndings,checkTestbenchHeaderSelection,createAgentDraftEditor} from '../../modules/simulation/environment/agent-testbench.js';
import {agentSource,agentTestbenchFixture,testbench} from './agent-testbench.fixture.mjs';

const helper='\ufeff// original UTF-8 λ\r\nmodule source(p,n);\r\ninout p,n;\relectrical p,n;\nendmodule\r\n';
const manifest=()=>{const value={...testbench};delete value.text;return JSON.stringify(value);};
const headerId='headers_'+'a'.repeat(64);
async function session(){const fixture=agentTestbenchFixture();await fixture.adapter.inspectNetlist(agentSource);await fixture.adapter.probeHost({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision,ssh_targets:['synthetic-host']});await fixture.adapter.discoverPdk({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision,probe_ids:['synthetic-probe-0']});await fixture.authorDraft();return {...fixture.saved,veriloga_headers:[{id:headerId,probe_id:'synthetic-probe-0',status:'observed',coverage:{complete:true},missing:[],headers:[{name:'disciplines.vams',alias:'VA_HEADER_SYNTHETIC',sha256:'b'.repeat(64)}]}]};}

test('helper import preserves BOM, UTF-8 and mixed line endings in the authored manifest',()=>{
  const bytes=new TextEncoder().encode(helper),decoded=decodeTestbenchHelper(bytes);assert.equal(decoded,helper);
  const value=JSON.parse(editTestbenchHelper(manifest(),'behavior/source.va',decoded));
  assert.equal(value.helper_files['behavior/source.va'],helper);assert.deepEqual(value.interface,testbench.interface);assert.deepEqual(value.postprocess,testbench.postprocess);
  assert.equal(createHash('sha256').update(value.helper_files['behavior/source.va']).digest('hex'),createHash('sha256').update(bytes).digest('hex'));
  assert.equal(checkTestbenchDocument({...value,text:testbench.text}).helper_files['behavior/source.va'],helper);
});
test('helper validation rejects unsafe and colliding names, standard-header shadowing and non-UTF8 text',()=>{
  for(const name of ['../x.va','/x.va','x//y.va','x\\y.va','./x.va','dut.scs','TB.SCS','PDK.scs','agent-testbench.json','constants.vams','model/Disciplines.vams'])assert.throws(()=>checkTestbenchHelpers({[name]:'module x; endmodule'}),name);
  for(const files of [{'a.va':'x','A.VA':'y'},{'dir':'x','dir/x.va':'y'},{'dir/x.va':'x','dir':'y'}])assert.throws(()=>checkTestbenchHelpers(files),/冲突/);
  assert.throws(()=>checkTestbenchHelpers({'leaf.va':'x'},['LEAF.VA']),/冲突/);
  assert.throws(()=>checkTestbenchHelpers({'lib/leaf.va':'x'},['lib']),/冲突/);
  for(const text of ['', '\u0000','\ud800','x'.repeat(512*1024+1)])assert.throws(()=>checkTestbenchHelpers({'x.va':text}));
  assert.throws(()=>checkTestbenchHelpers(null));assert.throws(()=>checkTestbenchDocument({...testbench,helper_files:null}));
  assert.throws(()=>decodeTestbenchHelper(Uint8Array.of(0xc3,0x28)),/UTF-8/);
});
test('helper edits keep unknown metadata and reject ambiguous JSON instead of replacing it',()=>{
  const input=JSON.stringify({...JSON.parse(manifest()),notes:{original:'unchanged'}}),added=editTestbenchHelper(input,'a.va',helper);
  assert.deepEqual(JSON.parse(added).notes,{original:'unchanged'});
  assert.deepEqual(JSON.parse(editTestbenchHelper(added,'a.va',null,{remove:true})).helper_files,{});
  assert.throws(()=>editTestbenchHelper('{"helper_files":{"a.va":"x","a.va":"y"}}','b.va','z'),/重复/);
  assert.throws(()=>editTestbenchHelper('{"helper_files":null}','b.va','z'));
});
test('textarea edits preserve untouched mixed newlines and never normalize a no-op',()=>{
  const view=helper.replace(/\r\n?/g,'\n');assert.equal(preserveHelperLineEndings(helper,view),helper);
  assert.equal(preserveHelperLineEndings(helper,view.replace('source','driver')),helper.replace('source','driver'));
  assert.equal(preserveHelperLineEndings('a\r\nb\rc\n','a\nb!\nc\n'),'a\r\nb!\rc\n');
  assert.equal(preserveHelperLineEndings('a\r\nb\r\n','a\nx\nb\n'),'a\r\nx\r\nb\r\n');
  assert.equal(preserveHelperLineEndings('a\r\nb\r\n','a\n'),'a\r\n');
});
test('a helper edit makes the draft dirty and a remote draft cannot erase its exact text',async()=>{
  const value=await session(),editor=createAgentDraftEditor();editor.observe(value);
  editor.edit('manifest',editTestbenchHelper(editor.state.manifest,'behavior/source.va',helper));assert.equal(editor.state.dirty,true);
  assert.equal(editor.read(value).testbench.helper_files['behavior/source.va'],helper);
  editor.observe({...value,revision:value.revision+1,agent_tb:{...value.agent_tb,draft_id:'c'.repeat(64)}});
  assert.equal(editor.state.conflict,true);assert.equal(JSON.parse(editor.state.manifest).helper_files['behavior/source.va'],helper);assert.throws(()=>editor.read(value),/另一操作/);
});
test('saved DUT support is distinct from authored helpers in editor validation',async()=>{
  const value=await session();value.agent_tb.support_sha256={'behavior/source.va':'c'.repeat(64)};const editor=createAgentDraftEditor();editor.observe(value);
  editor.edit('manifest',editTestbenchHelper(editor.state.manifest,'behavior/source.va',helper));
  assert.match(editor.state.error,/DUT 支持文件/);assert.throws(()=>editor.read(value),/冲突/);
});
test('header selection requires complete observation from the selected current PDK probe',async()=>{
  const value=await session(),selection={...value.agent_tb.selection,veriloga_header_id:headerId};checkTestbenchHeaderSelection(selection,value);
  for(const changed of [{...value,veriloga_headers:[]},{...value,probes:[]},{...value,veriloga_headers:[{...value.veriloga_headers[0],probe_id:'another-probe'}]},{...value,veriloga_headers:[{...value.veriloga_headers[0],status:'blocked'}]},{...value,veriloga_headers:[{...value.veriloga_headers[0],coverage:{complete:false}}]},{...value,veriloga_headers:[{...value.veriloga_headers[0],missing:[{code:'missing'}]}]}])assert.throws(()=>checkTestbenchHeaderSelection(selection,changed));
  assert.throws(()=>checkTestbenchHeaderSelection({...selection,candidate_id:'unknown'},value));
});
test('mismatched header JSON blocks save without marking an unchanged remote draft locally edited',async()=>{
  const value=await session(),editor=createAgentDraftEditor();editor.observe(value);
  editor.edit('selection',JSON.stringify({...value.agent_tb.selection,veriloga_header_id:headerId}));assert.equal(editor.state.error,null);assert.equal(editor.read(value).selection.veriloga_header_id,headerId);
  const accepted={...value,agent_tb:{...value.agent_tb,selection:{...value.agent_tb.selection,veriloga_header_id:headerId}}};editor.accept(accepted);assert.equal(editor.state.dirty,false);
  editor.observe({...accepted,revision:accepted.revision+1,veriloga_headers:[]});assert.equal(editor.state.dirty,false);assert.match(editor.state.error,/当前主机/);assert.throws(()=>editor.read({...accepted,veriloga_headers:[]}),/当前主机/);
});
