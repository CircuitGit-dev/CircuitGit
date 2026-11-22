import test from 'node:test';import assert from 'node:assert/strict';
import {workspaceSelection,resolveLinkedSelection} from '../../../apps/codex/ui/waveforms/link.js';
const hash='a'.repeat(64),commit='b'.repeat(40),manifest='c'.repeat(64);
const map={status:'verified_binding',run_id:'r',source_commit:commit,source:{path:'c.scs',sha256:hash},geometry:{bundle_commit:commit,manifest_sha256:manifest,entry_id:'TB'},objects:[
 {selector:{kind:'net',name:'VINP',scope:'(top)',viewer_source_path:'TB.scs',native_entry_id:'TB',occurrence_path:[]},signal_id:'v',psf_name:'VINP',analysis:'tran',unit:'V'},
 {selector:{kind:'terminal',name:'VDD0',scope:'(top)',viewer_source_path:'TB.scs',native_entry_id:'TB',occurrence_path:[],terminal_name:'p'},signal_id:'i',psf_name:'VDD0:p',analysis:'tran',unit:'A',polarity:'into_terminal',scale:1}]};
const catalog={run_id:'r',signals:[{id:'v',psf_name:'VINP',analysis:'tran',unit:'V',status:'available'},{id:'i',psf_name:'VDD0:p',analysis:'tran',unit:'A',status:'available'}]};
const waveView={kind:'waveforms',view_id:'wview',workspace_id:'ws',identity:{project_id:'p',run_id:'r',source_commit:commit}};
const selection={kind:'net',name:'VINP',source_path:'c.scs',scope:'(top)',occurrence_path:[],source_commit:commit,run_id:null,verification:'ui-metadata',geometry:{viewer_source_path:'TB.scs',native_entry_id:'TB',bundle_commit:commit,manifest_sha256:manifest,source_match:true,canonical_mapping_enabled:true,snapshot_only:false}};
const source={schema:'ic.view.v1',kind:'schematic',view_id:'sview',workspace_id:'ws',revision:2,identity:{project_id:'p',source_commit:commit,source_sha256:hash,path:'c.scs',run_id:null},selection,draft_dirty:false};
const args=(s=selection)=>({source:{...source,selection:s},selection:s,waveView,mapping:map,catalog});
test('schematic run:null links only through exact fixed-run source and native selectors',()=>{const r=resolveLinkedSelection(args());assert.equal(r.status,'resolved');assert.equal(r.signal.id,'v');assert.equal(r.source.view_id,'sview');});
test('device selection requires explicit mapped p; VDD net never becomes current',()=>{
 const device={...selection,kind:'instance',name:'VDD0'};assert.equal(resolveLinkedSelection(args(device)).status,'terminal_required');assert.equal(resolveLinkedSelection(args(device),'p').signal.id,'i');assert.notEqual(resolveLinkedSelection(args({...device,kind:'net',name:'VDD'})).status,'resolved');assert.notEqual(resolveLinkedSelection(args(device),'n').status,'resolved');
});
test('library, unknown path/entry/occurrence, missing fields and source drift all block',()=>{
 const cases=[{source_path:'research/TB.scs'},{occurrence_path:undefined},{occurrence_path:['different']},{geometry:undefined},{geometry:{...selection.geometry,snapshot_only:true}},{geometry:{...selection.geometry,canonical_mapping_enabled:false}},{geometry:{...selection.geometry,source_match:false}},{geometry:{...selection.geometry,native_entry_id:'different'}},{geometry:{...selection.geometry,viewer_source_path:'other.scs'}},{geometry:{...selection.geometry,bundle_commit:'d'.repeat(40)}}];
 for(const patch of cases)assert.notEqual(resolveLinkedSelection(args({...selection,...patch})).status,'resolved',JSON.stringify(patch));
 assert.notEqual(resolveLinkedSelection({...args(),source:{...source,identity:{...source.identity,source_sha256:'e'.repeat(64)}}}).status,'resolved');
});
test('duplicated exact mappings do not pick first',()=>{assert.equal(resolveLinkedSelection({...args(),mapping:{...map,objects:[map.objects[0],map.objects[0]]}}).status,'ambiguous');});
test('workspace latest selection is tied to actual source view revision and same project',()=>{
 const ws={schema:'ic.workspace.v1',workspace_id:'ws',revision:4,views:[source,waveView],selection:{view_id:'sview',view_revision:2,selection}};
 assert.equal(workspaceSelection(ws,waveView).status,'selected');assert.equal(workspaceSelection({...ws,selection:{...ws.selection,view_revision:1}},waveView).status,'blocked');assert.equal(workspaceSelection({...ws,workspace_id:'other'},waveView).status,'blocked');assert.equal(workspaceSelection({...ws,selection:{view_id:waveView.view_id,selection}},waveView).status,'self');
});
