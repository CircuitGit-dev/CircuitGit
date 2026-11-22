import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {loadCore} from '../../../apps/web/vendor/rnl-viewer/core/core.js';
import {descriptor,nativeModel,policy,dataCall,cleanManifest,readClosure} from '../../../apps/codex/ui/schematic/data.js';
import {objectSelection,rootVisit,selectionForHost,terminals} from '../../../apps/codex/ui/schematic/selection.js';
import {root,native,nativeRoot,hash,view,geometry,manifest,host,closure} from './fixture.mjs';

test('all 97 entries and every pinned native member retain exact byte identity',()=>{
  assert.equal(native.cells.length,97);for(const f of native.files){const raw=readFileSync(nativeRoot+f.path);assert.equal(hash(raw),f.sha256);assert.equal(raw.length,f.bytes);}
  for(const entry of native.cells)assert(closure(entry.entrypoint).length<=300);
});
test('finite chunk reader recreates original 711-instance RNL Document without URLs or layout',async()=>{
  const v=view(),h=host(v),entry=native.cells[0],bundle=await readClosure(h,v,entry),core=await loadCore(readFileSync(root+'/apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm'));
  assert.equal(bundle.request.auto_include,false);assert(!JSON.stringify(bundle.manifest).includes('127.0.0.1'));
  const doc=core.build(bundle.request);assert.equal(doc.objects.filter(o=>o.kind==='instance').length,711);assert.equal(doc.levels.length,23);assert.equal(doc.failed,null);assert.equal(doc.levels.reduce((n,l)=>n+l.unplaced.length,0),0);
  assert.equal(doc.levels[0].svg.includes('data-id="wire-0"'),true);
  const object=objectSelection(doc,0,rootVisit(doc,0),0,entry.entrypoint,bundle.manifest);assert.equal(object.name,'XDUT');assert(object.terminals.includes('VINP'));
  const model=nativeModel(geometry(v),v),status=policy(model,entry,v),selection=selectionForHost(object,{model,entry,status,view:v},'VINP');
  assert.equal(selection.selection.terminal,'VINP');assert.deepEqual(selection.selection.occurrence_path,[]);assert.equal(selection.context.identity.run_id,null);assert.equal(selection.context.probe_enabled,false);
  assert.deepEqual(selection.selection.geometry,{viewer_source_path:entry.entrypoint,native_entry_id:entry.id,
    bundle_commit:v.identity.source_commit,manifest_sha256:hash(readFileSync(nativeRoot+'manifest.json')),
    source_match:true,canonical_mapping_enabled:true,snapshot_only:false});
  assert.equal(selection.context.verification,'ui-metadata');
  const netIndex=doc.objects.findIndex(o=>o.kind==='net'&&o.name==='VINP'&&o.level===0);
  const net=objectSelection(doc,0,rootVisit(doc,0),netIndex,entry.entrypoint,bundle.manifest);
  assert.equal(selectionForHost(net,{model,entry,status,view:v}).selection.kind,'net');
  assert.throws(()=>selectionForHost(object,{model,entry,status,view:v},'invented'),/Terminal/);
  const primitive=doc.objects.find(o=>o.name==='VDD0'&&o.level===0);assert.deepEqual(terminals(doc,0,primitive),[]);
});
test('cross-view, identity drift and malformed descriptors fail closed',async()=>{
  const v=view(),h=host(v);assert.throws(()=>descriptor({...v,revision:-1}));
  await assert.rejects(()=>dataCall({...h,call:async()=>({view:view('2'),kind:'schematic',payload:{}})},v,{kind:'schematic'}),/match/);
  assert.throws(()=>nativeModel({...geometry(v),source_hash:'0'.repeat(64)},v),/identity/);
});
test('hash mismatch, chunk identity and non-progressing transfer are rejected',async()=>{
  for(const mode of ['hash','identity','progress']){
    const v=view(),h=host(v),call=h.call.bind(h);h.call=async(name,args)=>{const r=await call(name,args);if(args.query.kind==='geometry_file'){
      if(mode==='hash'){const bytes=Buffer.from(r.payload.data,'base64');bytes[0]^=1;r.payload.data=bytes.toString('base64');}
      if(mode==='identity')r.payload.path='other';if(mode==='progress')r.payload.next_offset=0;
    }return r;};await assert.rejects(()=>readClosure(h,v,native.cells[0]));
  }
});
test('automatic includes, oversized files and traversal paths are not accepted',()=>{
  const m=manifest(native.cells[0].id);assert.throws(()=>cleanManifest({...m,settings:{autoInclude:true}}));
  assert.throws(()=>cleanManifest({...m,files:[{...m.files[0],size:2*1024*1024+1}]}));
  assert.throws(()=>cleanManifest({...m,files:[{...m.files[0],path:'../escape'}]}));
});
test('stale canonical source blocks selection, independent entry never claims a run mapping',()=>{
  const v=view(),g=geometry(v);g.geometry.source_binding.geometry_source_sha256='0'.repeat(64);const model=nativeModel(g,v),status=policy(model,model.defaultEntry,v);
  assert.equal(status.stale,true);assert.equal(status.selectionEnabled,false);
  assert.throws(()=>selectionForHost({kind:'net'},{model,entry:model.defaultEntry,status,view:v}),/stale/);
  const standalone=model.entries.find(e=>e.canonical_source_mapping===false);assert(standalone);const independent=policy(model,standalone,v);assert.equal(independent.snapshotOnly,true);assert.equal(independent.sourceMatch,false);assert.equal(independent.probeEnabled,false);
});
test('superseded closure stops without fetching another file',async()=>{
  const h=host();await assert.rejects(()=>readClosure(h,h.initial,native.cells[0],{current:()=>false}),/superseded/);assert.equal(h.calls.length,1);
});
test('unresolved occurrences remain absent and canonical spans cannot replace exported selector identity',()=>{
  const v=view(),model=nativeModel(geometry(v),v),entry=model.defaultEntry,status=policy(model,entry,v);
  const raw={kind:'net',name:'VINP',scope:'(top)',source_path:entry.entrypoint,context:{occurrenceResolved:true,occurrencePath:[]},terminals:[]};
  model.mapping=[{kind:'net',name:'VINP',scope:'(top)',viewer_source_path:entry.entrypoint,target:{source_path:v.identity.path,source_sha256:v.identity.source_sha256,line_start:1,line_end:1}}];
  const make=context=>selectionForHost({...raw,context},{model,entry,status,view:v}).selection;
  const resolved=make(raw.context);assert.deepEqual(resolved.occurrence_path,[]);assert.equal(resolved.source_path,v.identity.path);assert.equal(resolved.geometry.viewer_source_path,entry.entrypoint);
  for(const context of [undefined,{}, {occurrenceResolved:false,occurrencePath:[]},{occurrenceResolved:true},{occurrenceResolved:true,occurrencePath:null},{occurrenceResolved:true,occurrencePath:'XDUT'}])assert.equal(Object.hasOwn(make(context),'occurrence_path'),false);
  const snapshot=model.entries.find(e=>e.canonical_source_mapping===false),snapshotStatus=policy(model,snapshot,v);
  const independent=selectionForHost(raw,{model,entry:snapshot,status:snapshotStatus,view:v});
  assert.equal(Object.hasOwn(independent.selection,'occurrence_path'),false);assert.equal(independent.selection.geometry.snapshot_only,true);
  assert.equal(independent.selection.geometry.source_match,false);assert.equal(independent.selection.geometry.canonical_mapping_enabled,false);
  assert.equal(independent.context.verification,'ui-metadata');assert.equal(independent.context.identity.run_id,null);
  assert.throws(()=>selectionForHost(raw,{model:{...model,geometry:{}},entry,status,view:v}),/pinned native geometry/);
});
