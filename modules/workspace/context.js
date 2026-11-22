// One read-only consumer API. Source bytes and application state stay in this closure.
const hashPattern=/^[a-f0-9]{64}$/i;
const str=v=>typeof v==='string'?v:null;
const hash=v=>hashPattern.test(v||'')?v:null;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const copy=v=>v==null?null:structuredClone(v);
const positive=v=>Number.isInteger(v)&&v>0?v:null;
export async function digest(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export function createContextStore({readExport,hashText=digest}={}){
  let snapshot=freeze({version:1,revision:0,mode:'connecting',loadState:'idle',loading:false,project:null,file:null,selection:null,geometry:null,run:null});
  let sourceText=null,fileKey=null,generation=0,currentHash=null,pending=Promise.resolve(),lastInput=null;
  const listeners=new Set();
  function publish(input){
    const p=input.project||{},f=input.file||{},g=input.geometry||{},s=input.selection,j=input.run;
    const sourceMatch=!g.snapshotOnly&&g.canonicalMappingEnabled!==false&&!!currentHash&&!f.dirty&&currentHash===g.geometrySourceSha256&&g.sourceMatch===true;
    const geometry=input.geometry?{mode:str(g.mode),state:g.snapshotOnly?'snapshot-only':sourceMatch?str(g.state):'stale',snapshotOnly:g.snapshotOnly===true,canonicalMappingEnabled:g.canonicalMappingEnabled!==false&&!g.snapshotOnly,sourceKind:str(g.sourceKind),exportNamespace:str(g.exportNamespace),bundleCommit:str(g.bundleCommit),manifestSha256:hash(g.manifestSha256),geometrySourceCommit:str(g.geometrySourceCommit),geometrySourceSha256:hash(g.geometrySourceSha256),currentSourceSha256:currentHash,sourceMatch,nativeReady:sourceMatch&&g.nativeReady===true,fidelity:str(g.fidelity),coverage:copy(g.coverage),losses:copy(g.losses),historicalSnapshotVisible:g.historicalSnapshotVisible===true,nativeEntryId:str(g.nativeEntryId),displayedLevel:str(g.displayedLevel)}:null;
    let selection=null;
    if(s){
      const verified=s.targetKind==='canonical'&&s.mappingVerified===true&&sourceMatch&&s.sourcePath===f.path&&s.sourceSha256===currentHash;
      const target=s.targetKind==='canonical'&&!verified?'unmapped':s.targetKind;
      const occurrenceResolved=!g.snapshotOnly&&s.occurrenceResolved===true&&Array.isArray(s.occurrencePath)&&s.occurrencePath.every(x=>typeof x==='string');
      selection={kind:str(s.kind),name:str(s.name),scope:str(s.scope),targetKind:['canonical','export','unmapped'].includes(target)?target:'unmapped',sourcePath:target==='unmapped'?null:str(s.sourcePath),sourceSha256:target==='unmapped'?null:hash(s.sourceSha256),lineStart:target==='unmapped'?null:positive(s.lineStart),lineEnd:target==='unmapped'?null:positive(s.lineEnd),viewerSourcePath:str(s.viewerSourcePath),nativeEntryId:str(s.nativeEntryId),mappingVerified:verified,readonly:!verified,
        occurrencePath:occurrenceResolved?[...s.occurrencePath]:null,occurrenceResolved,occurrenceNamespace:occurrenceResolved?'native-export':null,occurrenceReason:occurrenceResolved?null:str(s.occurrenceReason)||'No verified TB-root navigation chain',occurrenceEvidence:copy(s.occurrenceEvidence),terminalName:str(s.terminalName),terminalReason:str(s.terminalName)?null:str(s.terminalReason)||'Selection does not identify one terminal',terminalOptions:copy(s.terminalOptions)||[],netName:s.kind==='net'?str(s.name):str(s.netName),busBit:Number.isInteger(s.busBit)?s.busBit:null,busBitReason:Number.isInteger(s.busBit)?null:'No explicit scalar bus-bit identity in viewer metadata',reason:target==='unmapped'?str(s.reason)||'Source identity changed or mapping unavailable':null};
    }
    const body={version:1,mode:str(input.mode),loadState:str(input.loadState),loading:input.loadState==='loading',project:input.project?{id:str(p.id),repository:str(p.repository),branch:str(p.branch),sourceCommit:str(p.sourceCommit)}:null,file:input.file?{path:str(f.path),baseCommit:str(f.baseCommit),persistedSha256:hash(f.persistedSha256),currentTextSha256:currentHash,hashPending:currentHash===null,dirty:f.dirty===true,editable:f.editable===true}:null,selection,geometry,run:j?{runId:str(j.runId),sourceCommit:str(j.sourceCommit),state:str(j.state),configurationId:str(j.configurationId),projectId:str(j.projectId),sourceSha256:hash(j.sourceSha256),historical:j.historical===true}:null};
    const previous={...snapshot};delete previous.revision;
    if(JSON.stringify(previous)===JSON.stringify(body))return;
    snapshot=freeze({...body,revision:snapshot.revision+1});
    for(const listener of [...listeners]){try{listener(snapshot);}catch(error){console.error('Context subscriber failed',error);}}
  }
  function update(input,text){
    // Loading/failure never exposes a previous project's data, even on stray updates.
    if(['loading','error'].includes(input.loadState)){input={...input,file:null,selection:null,geometry:null,run:null};text=null;}
    lastInput=input;
    const key=input.file?JSON.stringify([input.project?.id,input.file.path,input.file.baseCommit]):null;
    if(key!==fileKey||text!==sourceText){
      fileKey=key;sourceText=typeof text==='string'?text:null;currentHash=null;const serial=++generation;
      publish(input);
      pending=sourceText===null?Promise.resolve():hashText(sourceText).then(value=>{if(serial!==generation)return;currentHash=hash(value);publish(lastInput);}).catch(()=>{if(serial===generation){currentHash=null;publish(lastInput);}});
    }else publish(input);
  }
  async function readSelection({contextRevision,maxLines=80,maxBytes=12288}={}){
    if(contextRevision!==snapshot.revision)throw Error('Context revision changed; request a fresh context');
    const original=snapshot,s=original.selection;
    if(!s||s.targetKind==='unmapped'||!s.sourceSha256||!s.lineStart||!s.lineEnd)throw Error('No verified source range is selected');
    if(!Number.isInteger(maxLines)||maxLines<1||maxLines>200||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>32768)throw Error('Selection limits: 1–200 lines, 1–32768 bytes');
    let text;
    if(s.targetKind==='canonical'){
      if(!s.mappingVerified||!currentHash||s.sourceSha256!==currentHash)throw Error('Canonical mapping is stale');
      text=sourceText;
    }else{
      if(!readExport)throw Error('Export source reader is unavailable');
      text=await readExport({sourcePath:s.sourcePath,sourceSha256:s.sourceSha256,contextRevision});
    }
    if(typeof text!=='string'||await hashText(text)!==s.sourceSha256)throw Error('Selected source hash mismatch');
    if(snapshot.revision!==contextRevision)throw Error('Context changed during source read');
    const lines=text.split('\n');if(s.lineEnd<s.lineStart||s.lineEnd>lines.length)throw Error('Selected source range is invalid');
    const end=Math.min(s.lineEnd,s.lineStart+maxLines-1),result=[];let bytes=0;
    for(const line of lines.slice(s.lineStart-1,end)){const size=new TextEncoder().encode((result.length?'\n':'')+line).length;if(bytes+size>maxBytes)break;result.push(line);bytes+=size;}
    if(!result.length)throw Error('First selected line exceeds byte limit');
    return freeze({contextRevision,sourcePath:s.sourcePath,sourceSha256:s.sourceSha256,targetKind:s.targetKind,lineStart:s.lineStart,lineEnd:s.lineStart+result.length-1,text:result.join('\n'),bytes,truncated:result.length<s.lineEnd-s.lineStart+1});
  }
  const api=Object.freeze({getContext:()=>snapshot,subscribe(listener){if(typeof listener!=='function')throw TypeError('Subscriber must be a function');listeners.add(listener);return ()=>listeners.delete(listener);},readSelection});
  return {api,update,settled:()=>pending};
}
