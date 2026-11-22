import {createContextStore,digest} from './store.js';

// The host supplies closure-local state. Consumers receive only the store's frozen public API.
export function createWorkbenchContext(read){
  const store=createContextStore({async readExport({sourcePath,sourceSha256}){
    const {nativeFiles=[]}=read();const files=nativeFiles.filter(f=>f.path===sourcePath&&f.sha256===sourceSha256);
    if(files.length!==1)throw Error('Export is not uniquely present in the current native allowlist');
    const f=files[0],url=new URL(f.url,location.href);
    if(url.origin!==location.origin)throw Error('Export reader requires the gateway origin');
    const response=await fetch(url,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('Export source HTTP '+response.status);
    const buffer=await response.arrayBuffer();if(buffer.byteLength>2*1024*1024)throw Error('Export exceeds per-file limit');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);if(await digest(text)!==f.sha256)throw Error('Export source hash mismatch');return text;
  }});
  function update(){
    const r=read(),state=r.state,f=state.file,p=state.project,n=r.nativeState,g=r.nativePayload?.geometry;
    const raw=r.selection,files=r.nativeFiles||[],path=raw?.export_source_path||raw?.viewer_source_path||raw?.source_path;
    const exported=files.filter(f=>path&&(f.path===path));
    let selection=null;
    if(raw){
      const canonical=raw.canonical===true;const file=exported.length===1?exported[0]:null;
      const lineStart=canonical?raw.line_start:raw.export_lines?.[1]||raw.export_line_start||raw.line_start;
      const lineEnd=canonical?raw.line_end:raw.export_lines?.[2]||raw.export_line_end||raw.line_end||lineStart;
      selection={kind:raw.kind,name:raw.name,scope:raw.scope,targetKind:canonical?'canonical':file&&lineStart?'export':'unmapped',sourcePath:canonical?raw.source_path:file?.path,sourceSha256:canonical?raw.source_sha256:file?.sha256,lineStart,lineEnd,viewerSourcePath:path,nativeEntryId:raw.entry_id||n?.entry,mappingVerified:canonical,reason:raw.reason,...raw.context};
    }
    const fileMetadata=f?{path:f.path,baseCommit:f.base_commit||p?.source_commit||p?.commit,persistedSha256:f.sha256,dirty:state.dirty,editable:f.editable!==false&&['live','mock'].includes(state.mode)}:null;
    const job=state.job;
    store.update({mode:state.mode,loadState:state.projectLoadState,project:p?{id:state.active?.project_id||state.active?.id,repository:p.repo||p.repository||p.repo_name,branch:p.branch,sourceCommit:p.source_commit||p.commit}:null,file:fileMetadata,selection,geometry:g&&n?{mode:'native',state:n.state,snapshotOnly:n.snapshotOnly,canonicalMappingEnabled:n.canonicalMappingEnabled,sourceKind:n.sourceKind,exportNamespace:n.exportNamespace,bundleCommit:n.bundleCommit,manifestSha256:g.manifest_sha256,geometrySourceCommit:n.sourceCommit,geometrySourceSha256:n.boundSourceHash,sourceMatch:n.sourceMatch,nativeReady:n.nativeReady,fidelity:n.fidelity,coverage:n.coverage,losses:n.losses,historicalSnapshotVisible:r.historicalSnapshotVisible,nativeEntryId:n.entry,displayedLevel:n.displayedLevel}:null,run:job?{runId:job.job_id||job.run_id||job.id,sourceCommit:job.source_commit||job.provenance?.source_commit,state:job.state,configurationId:job.configuration_id||(typeof job.configuration==='string'?job.configuration:null),projectId:job.associated_project_id||job.project_id,sourceSha256:job.source_sha256,historical:job.historical||job.source_commit!==p?.source_commit}:null},f?r.text:null);
  }
  return {api:store.api,update};
}
