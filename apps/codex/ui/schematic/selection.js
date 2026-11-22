import {selectionMetadata} from '../../../web/vendor/rnl-viewer/ic-context-metadata.js';
import {viewerSourcePath,sourceSelection} from '../../../../modules/schematic/native-model.js';

export function rootVisit(doc,index){return [{level:index,title:doc.levels[index].title,via:null}];}
export function terminals(doc,level,object){
  if(object.kind!=='instance')return [];
  const children=doc.levels[level].children.filter(c=>c.instance===object.name);
  if(children.length!==1||children[0].symbol===null)return [];
  const pins=doc.symbols[children[0].symbol]?.pins||[];
  return [...new Set(pins.flatMap(p=>p.terminals||[]))].filter(name=>typeof name==='string'&&name.length<=256).slice(0,256);
}
export function objectSelection(doc,current,path,index,rootEntry,manifest){
  const object=doc.objects[index];if(!object||!['net','instance','usage'].includes(object.kind)||object.level!==doc.levels[current]?.host)return null;
  const context=selectionMetadata(doc,path,current,index,rootEntry);
  const sourcePath=viewerSourcePath(context?.viewerSourcePath,manifest,doc.path);if(!sourcePath)return null;
  const scope=doc.levels[current].kind==='file'?'(top)':object.level_title;
  return {object_index:index,kind:object.kind,name:object.name,scope,source_path:sourcePath,
    export_lines:object.lines?.slice(1)||null,level:doc.levels[current].title,
    context,terminals:terminals(doc,current,object),opens:object.opens};
}
export function selectionForHost(raw,{model,entry,status,view},terminal=null){
  if(!status.selectionEnabled||!raw||!['net','instance'].includes(raw.kind))throw Error('Selection is unavailable for stale or unsupported geometry');
  if(terminal!==null&&(raw.kind!=='instance'||!raw.terminals.includes(terminal)))throw Error('Terminal is not in the selected symbol');
  const mapped=status.canonicalMappingEnabled?sourceSelection(model.mapping,raw,view.identity.source_sha256,{allowCanonical:status.sourceMatch&&!status.stale}):null;
  const canonical=!!mapped?.canonical;
  const selection={kind:terminal===null?raw.kind:'terminal',name:raw.name,scope:raw.scope,source_path:canonical?mapped.source_path:raw.source_path};
  const lines=canonical?[mapped.line_start,mapped.line_end??mapped.line_start]:raw.export_lines;
  if(lines&&Number.isInteger(lines[0])&&Number.isInteger(lines[1]))Object.assign(selection,{line_start:lines[0],line_end:lines[1]});
  const occurrence=raw.context?.occurrencePath;
  if(!status.snapshotOnly&&raw.context?.occurrenceResolved===true&&Array.isArray(occurrence)&&occurrence.length<=64&&occurrence.every(p=>typeof p==='string'&&p.length>0&&p.length<=512))selection.occurrence_path=[...occurrence];
  // Preserve exported selector identity separately from a mapped canonical source span.
  // These UI declarations help the waveform view compare its own saved proof; they are not proof themselves.
  const geometry={viewer_source_path:raw.source_path,native_entry_id:entry.id,bundle_commit:model.bundleCommit,
    manifest_sha256:model.geometry?.manifest_sha256,source_match:status.sourceMatch,
    canonical_mapping_enabled:status.canonicalMappingEnabled,snapshot_only:status.snapshotOnly};
  if(typeof geometry.viewer_source_path!=='string'||!geometry.viewer_source_path||typeof geometry.native_entry_id!=='string'||!geometry.native_entry_id||
    !/^[a-f0-9]{40}$/.test(geometry.bundle_commit||'')||!/^[a-f0-9]{64}$/.test(geometry.manifest_sha256||'')||
    ['source_match','canonical_mapping_enabled','snapshot_only'].some(key=>typeof geometry[key]!=='boolean'))throw Error('Selection lacks pinned native geometry metadata');
  selection.geometry=geometry;
  if(terminal!==null)selection.terminal=terminal;
  return {selection,context:{view_id:view.view_id,workspace_id:view.workspace_id,view_revision:view.revision,
    identity:view.identity,entry_id:entry.id,object_index:raw.object_index,export_source_path:raw.source_path,
    canonical_mapping:canonical,snapshot_only:status.snapshotOnly,geometry_source_commit:status.sourceCommit,
    bundle_commit:status.bundleCommit,selection,probe_enabled:false,probe_reason:status.probeReason,
    terminal_evidence:terminal===null?null:'Explicit choice from rendered Document symbol pins',verification:'ui-metadata'}};
}
