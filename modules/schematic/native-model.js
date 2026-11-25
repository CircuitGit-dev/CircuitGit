// Read-only metadata normalization. This module never changes RNL geometry or electrical text.
const HASH=/^[a-f0-9]{64}$/i;
export function localURL(value,base){const url=new URL(value,base);if(url.origin!==new URL(base).origin||!['http:','https:'].includes(url.protocol))throw Error('Native assets must use the private gateway origin');return url.href;}
export function normalizeNative(payload,base){
  const g=payload?.geometry||{};if(g.integrity==='invalid'||g.state==='invalid')throw Error('Native geometry integrity is invalid');if(!['native','live-rnl'].includes(g.mode)&&payload?.kind!=='native-rnl')throw Error('No native geometry descriptor');
  const binding=g.source_binding||{};const bound=binding.geometry_source_sha256||payload.bound_source_hash;
  const cells=g.cells||payload.entries||[];const root=g.root_cell||payload.default_entry;
  const entries=cells.map((cell,i)=>{const id=cell.id||cell.cell_id||cell.name||cell.cell||String(i);return {...cell,id,label:cell.label||cell.name||cell.cell_view?.cell||cell.cell||id,level:cell.level||cell.cell_view?.cell||cell.cell||id,manifest:localURL(cell.viewer_manifest_url||cell.manifest_url||g.viewer_manifest_url,base)};});
  if(!entries.length&&g.viewer_manifest_url)entries.push({id:root||g.cell_view?.cell||'root',label:g.cell_view?.cell||'Root',level:g.cell_view?.cell||g.level,manifest:localURL(g.viewer_manifest_url,base)});
  if(!entries.length)throw Error('No exported native cell entrypoints are available');
  for(const file of g.files||[])if(file.url)localURL(file.url,base);
  return {payload,geometry:g,mode:g.mode==='live-rnl'?'live-rnl':'native',entries,boundHash:HASH.test(bound||'')?bound:null,sourcePath:payload.source_path,bundleCommit:g.bundle_commit||null,bundleSha256:HASH.test(g.bundle_sha256||'')?g.bundle_sha256:null,layoutSync:g.layout_sync||null,sourceCommit:binding.geometry_source_commit||payload.source_commit||null,defaultEntry:entries.find(e=>e.id===root)||entries[0],mapping:g.mapping||payload.mapping||null,mappingURL:g.mapping_url?localURL(g.mapping_url,base):null};
}
export function nativeStatus(model,currentHash,{dirty=false}={}){
  const {payload,geometry:g,boundHash}=model;const sourceMatch=!!boundHash&&boundHash===currentHash&&!dirty;
  const stale=!!payload.stale||g.state==='stale'||!sourceMatch;
  const integrity=g.integrity==='valid';const losses=Array.isArray(g.losses)?g.losses:null;
  if(model.mode==='live-rnl'||g.mode==='live-rnl'){
    return {mode:'live-rnl',state:stale?'stale':integrity?'ready':'invalid',stale,sourceMatch,nativeReady:false,liveReady:integrity&&!stale,integrity:g.integrity||'unknown',fidelity:g.fidelity||'live-incremental-rnl',losses:losses||[],coverage:g.coverage||null,layoutSync:model.layoutSync||g.layout_sync||null,boundSourceHash:boundHash,currentSourceHash:currentHash,bundleCommit:null,bundleSha256:model.bundleSha256||g.bundle_sha256||null,sourceCommit:model.sourceCommit};
  }
  const verified=g.fidelity==='verified'||g.fidelity==='exact';
  const blocking=losses?.some(l=>l.blocking===true||l.severity==='error')||false;
  const ready=integrity&&verified&&losses!==null&&!blocking&&!stale&&payload.native_ready!==false;
  return {mode:'native',state:stale?'stale':ready?'ready':g.state==='invalid'?'invalid':'partial',stale,sourceMatch,nativeReady:ready,integrity:g.integrity||'unknown',fidelity:g.fidelity||'unverified',losses,coverage:g.coverage||null,boundSourceHash:boundHash,currentSourceHash:currentHash,bundleCommit:model.bundleCommit,bundleSha256:model.bundleSha256||null,sourceCommit:model.sourceCommit};
}
export function sourceSelection(mapping,event,currentHash,{allowCanonical=false}={}){
  const objects=Array.isArray(mapping)?mapping:mapping?.objects||[];
  const candidates=objects.filter(o=>o.kind===event.kind&&(o.name===event.name||(typeof event.id==='string'&&o.id===event.id))&&o.scope===event.scope&&(!o.viewer_source_path||o.viewer_source_path===event.source_path));
  if(candidates.length!==1)return null;
  const selected=candidates[0];const target=selected.target||selected;const canonical=target.source_kind!=='export'&&target.readonly!==true;
  if(canonical&&(!allowCanonical||target.source_sha256!==currentHash))return null;
  if(!Number.isInteger(target.line_start)||target.line_start<1||typeof target.source_path!=='string')return null;
  return {...selected,...target,canonical,readonly:!canonical};
}

// An independent export never inherits main-source synchronization or line mappings.
export function entryPolicy(model,entry){
  const root=model.geometry.cells?.find(c=>c.id===model.geometry.root_cell)||model.defaultEntry;
  const directory=p=>typeof p==='string'?p.slice(0,p.lastIndexOf('/')+1):null;
  const separatePath=entry?.entrypoint&&root?.entrypoint&&directory(entry.entrypoint)!==directory(root.entrypoint);
  const separateNamespace=entry?.export_namespace&&entry.export_namespace!==(root?.export_namespace||'canonical');
  const snapshotOnly=entry?.canonical_source_mapping===false||entry?.snapshot_only===true||entry?.source_kind==='saved-library-export'||!!separatePath||!!separateNamespace;
  return {snapshotOnly,canonicalMappingEnabled:!snapshotOnly,sourceKind:entry?.source_kind||(snapshotOnly?'independent-export':'canonical-export'),exportNamespace:entry?.export_namespace||null};
}
export function entryStatus(model,entry,currentHash,{dirty=false}={}){
  const policy=entryPolicy(model,entry),status=nativeStatus(model,currentHash,{dirty});
  const fidelity=typeof entry?.fidelity==='object'?entry.fidelity.status:entry?.fidelity;
  if(policy.snapshotOnly)return {...status,...policy,state:'snapshot-only',stale:false,sourceMatch:false,nativeReady:false,boundSourceHash:null,sourceCommit:null,fidelity:fidelity||'unverified',coverage:entry?.coverage||null,losses:entry?.losses||[{reason:'Independent entry metadata unavailable; canonical mapping disabled'}]};
  return {...status,...policy,...(fidelity?{fidelity}:{}),...(entry?.coverage?{coverage:entry.coverage}:{}),...(entry?.losses?{losses:entry.losses}:{})};
}
// Core file paths may be relative to the entry directory. Resolve only against this
// pinned entry and closure; the Document virtual path proves which open emitted it.
export function viewerSourcePath(path,manifest,documentPath){
  if(typeof path!=='string'||!manifest||documentPath!==`/${manifest.id}/${manifest.entry}`)return null;
  if(path.includes('\\')||path.startsWith('/')||/^[a-z]+:/i.test(path))return null;
  const dir=manifest.entry.slice(0,manifest.entry.lastIndexOf('/')+1);
  const normalize=value=>{const out=[];for(const part of value.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!out.length)return null;out.pop();}else out.push(part);}return out.join('/');};
  const candidates=[...new Set([normalize(dir+path),normalize(path)])].filter(p=>p&&manifest.files.some(f=>f.path===p));
  return candidates.length===1?candidates[0]:null;
}

// Preserve the integrated public entry-status API while adding explicit snapshot state.
export const selectedEntryStatus=entryStatus;
