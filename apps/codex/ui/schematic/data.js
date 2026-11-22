import {checkManifest,loadManifest} from '../../../web/vendor/rnl-viewer/manifest.js';
import {entryStatus} from '../../../../modules/schematic/native-model.js';

export const LIMITS=Object.freeze({files:300,fileBytes:2*1024*1024,totalBytes:20*1024*1024,chunkBytes:262144});
export const sameView=(a,b)=>a?.view_id===b?.view_id&&a?.workspace_id===b?.workspace_id&&a?.kind===b?.kind;
export function descriptor(value){
  if(value?.schema!=='ic.view.v1'||value.kind!=='schematic'||!/^v_[a-f0-9]{32}$/.test(value.view_id)||!/^w_[a-f0-9]{32}$/.test(value.workspace_id)||!Number.isSafeInteger(value.revision)||value.revision<1||!value.identity?.project_id||!/^[a-f0-9]{40}$/.test(value.identity.source_commit)||!/^[a-f0-9]{64}$/.test(value.identity.source_sha256))throw Error('Invalid pinned schematic view descriptor');
  return structuredClone(value);
}
export function nativeModel(payload,view){
  const g=payload?.geometry;
  if(!g||g.mode!=='native'||!g.available||g.integrity!=='valid'||!Array.isArray(g.cells)||!g.cells.length||g.cells.length>300)throw Error('Pinned native geometry is unavailable or invalid');
  if(payload.source_hash!==view.identity.source_sha256||payload.source_commit!==view.identity.source_commit)throw Error('Schematic source identity changed; open a new view');
  const ids=new Set();const entries=g.cells.map(cell=>{
    if(typeof cell.id!=='string'||!cell.id||ids.has(cell.id)||typeof cell.entrypoint!=='string')throw Error('Invalid native entry catalog');ids.add(cell.id);return {...cell,label:cell.label||cell.id};
  });
  return {payload,geometry:g,entries,defaultEntry:entries.find(e=>e.id===g.root_cell)||entries[0],
    sourcePath:payload.source_path,boundHash:g.source_binding?.geometry_source_sha256||null,
    sourceCommit:g.source_binding?.geometry_source_commit||null,bundleCommit:g.bundle_commit,mapping:g.mapping||payload.mapping||null};
}
export function policy(model,entry,view){
  const status=entryStatus(model,entry,view.identity.source_sha256);
  return {...status,selectionEnabled:!status.stale&&status.integrity==='valid',probeEnabled:false,
    probeReason:view.identity.run_id?'A separately verified run/terminal mapping is still required':'This schematic view has no bound simulation run'};
}
export async function dataCall(host,view,query){
  const result=await host.call('ic_view_data',{workspace_id:view.workspace_id,view_id:view.view_id,revision:view.revision,query});
  if(!sameView(view,result?.view)||result.view.revision!==view.revision||result.kind!==query.kind||!Object.hasOwn(result,'payload'))throw Error('Data response does not match the requested view/revision');
  if(JSON.stringify(result.view.identity)!==JSON.stringify(view.identity))throw Error('Pinned data identity changed');
  return result.payload;
}
export function cleanManifest(raw){
  // Gateway URLs are discovery metadata only. No URL survives into the renderer.
  const {base,...rest}=raw||{};
  const manifest={...rest,files:(raw?.files||[]).map(({url,...file})=>file)};
  const checked=checkManifest(manifest,{archive:true,limits:{...LIMITS,bytes:LIMITS.totalBytes,projectFiles:LIMITS.files,projectBytes:LIMITS.totalBytes}});
  if(checked.settings.autoInclude!==false||checked.files.some(f=>f.size>LIMITS.fileBytes))throw Error('Native closure must be finite and disable automatic include');
  return checked;
}
function fromBase64(value){
  if(typeof value!=='string'||value.length>Math.ceil(LIMITS.chunkBytes/3)*4+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('Invalid geometry chunk encoding');
  const text=atob(value);return Uint8Array.from(text,c=>c.charCodeAt(0));
}
export async function readClosure(host,view,entry,{current=()=>true,progress=()=>{}}={}){
  const manifest=cleanManifest(await dataCall(host,view,{kind:'geometry_manifest',entry:entry.id}));
  if(manifest.entry!==entry.entrypoint||manifest.level!==entry.level)throw Error('Manifest entry identity mismatch');
  const bytes={};let completed=0;
  // Bounded sequential transfers leave the host responsive to control requests.
  for(const file of manifest.files){
    const parts=[];let offset=0;
    do{
      if(!current())throw Error('Schematic read superseded');
      const chunk=await dataCall(host,view,{kind:'geometry_file',path:file.path,offset,limit:LIMITS.chunkBytes});
      if(chunk.path!==file.path||chunk.encoding!=='base64'||chunk.offset!==offset||chunk.total_bytes!==file.size||chunk.sha256!==file.sha256)throw Error('Geometry chunk identity mismatch');
      const part=fromBase64(chunk.data);if(part.length>LIMITS.chunkBytes||offset+part.length>file.size)throw Error('Geometry chunk exceeds bounds');
      const next=offset+part.length;
      if(chunk.next_offset!==(next===file.size?null:next)||next===offset&&file.size!==0)throw Error('Geometry chunk is incomplete or non-progressing');
      parts.push(part);offset=next;
    }while(offset<file.size);
    const full=new Uint8Array(file.size);let at=0;for(const part of parts){full.set(part,at);at+=part.length;}bytes[file.path]=full;
    progress(++completed,manifest.files.length);
  }
  const loaded=await loadManifest(manifest,{readFile:path=>bytes[path]??null,concurrency:1,limits:{projectFiles:LIMITS.files,projectBytes:LIMITS.totalBytes}});
  if(!current())throw Error('Schematic read superseded');
  return {manifest,request:{entry:loaded.entry,files:loaded.files,pool:loaded.pool,formats:loaded.formats,auto_include:false,svg:true,status:true}};
}
