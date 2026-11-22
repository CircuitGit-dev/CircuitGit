import test from 'node:test';import assert from 'node:assert/strict';import {normalizeNative,nativeStatus,sourceSelection} from '../../apps/web/native-viewer/model.js';
const hash='a'.repeat(64),payload={source_path:'projects/x/circuit.scs',native_ready:true,geometry:{mode:'native',state:'ready',integrity:'valid',fidelity:'verified',losses:[],coverage:{instances:3},source_binding:{geometry_source_sha256:hash},viewer_manifest_url:'/api/geometry/manifest',cell_view:{cell:'top'}}};
const model=normalizeNative(payload,'http://127.0.0.1:8767/');
test('matching hash is insufficient without fidelity and losses audit',()=>{assert.equal(nativeStatus(model,hash).nativeReady,true);const partial=normalizeNative({...payload,geometry:{...payload.geometry,fidelity:'unverified'}},'http://127.0.0.1:8767/');assert.equal(nativeStatus(partial,hash).nativeReady,false);});
test('draft edits make snapshot stale while retaining manifest and native identity',()=>{const status=nativeStatus(model,hash,{dirty:true});assert.equal(status.stale,true);assert.equal(status.nativeReady,false);assert.equal(model.entries[0].manifest,'http://127.0.0.1:8767/api/geometry/manifest');});
test('native assets must never use public viewer origins',()=>assert.throws(()=>normalizeNative({...payload,geometry:{...payload.geometry,viewer_manifest_url:'https://evil.test/foo'}},'http://127.0.0.1:8767/'),/private gateway/));
test('canonical mapping requires exact source hash and freshness',()=>{const object={kind:'instance',name:'M1',scope:'cmp',source_path:'projects/x/circuit.scs',source_sha256:hash,line_start:22,line_end:28};assert.equal(sourceSelection({objects:[object]},{kind:'instance',name:'M1',scope:'cmp'},hash,{allowCanonical:false}),null);assert.equal(sourceSelection({objects:[object]},{kind:'instance',name:'M1',scope:'cmp'},hash,{allowCanonical:true}).line_start,22);assert.equal(sourceSelection({objects:[object,object]},{kind:'instance',name:'M1',scope:'cmp'},hash,{allowCanonical:true}),null);});

test('missing IDs do not make other instances in the same scope match',()=>{const objects=['M1','M2'].map((name,i)=>({kind:'instance',name,scope:'cmp',source_path:'projects/x/circuit.scs',source_sha256:hash,line_start:20+i}));assert.equal(sourceSelection({objects},{kind:'instance',name:'M1',scope:'cmp'},hash,{allowCanonical:true}).line_start,20);});

test('independent exported library cannot inherit canonical mapping or source identity',async()=>{
  const {selectedEntryStatus}=await import('../../apps/web/native-viewer/model.js');
  const status=selectedEntryStatus({payload:{},geometry:{integrity:'valid',fidelity:'partial'},boundHash:'a'.repeat(64)}, {source_kind:'saved-library-export',canonical_source_mapping:false,coverage:{status:'partial'},losses:[],fidelity:{status:'partial'}},'a'.repeat(64));
  assert.equal(status.canonicalMappingEnabled,false);assert.equal(status.sourceMatch,false);assert.equal(status.sourceCommit,null);assert.equal(status.nativeReady,false);
});
test('same basename in a different export namespace is not a canonical source match',()=>{
  const h='a'.repeat(64),mapping={objects:[{kind:'instance',name:'XIO',scope:'PIPE_SAR9_Real_N06',viewer_source_path:'PIPE_SAR9_Real_N06.scs',source_path:'projects/x/circuit.scs',source_sha256:h,line_start:992}]};
  assert.equal(sourceSelection(mapping,{kind:'instance',name:'XIO',scope:'PIPE_SAR9_Real_N06',source_path:'research/PIPE_SAR9_Real_N06.scs'},h,{allowCanonical:true}),null);
});
