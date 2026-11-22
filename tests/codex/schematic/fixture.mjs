// Local immutable engineering snapshot; all MCP view state below is synthetic.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
export const nativeRoot=root+'/projects/real-sar-20261106/native/';
export const native=JSON.parse(readFileSync(nativeRoot+'manifest.json'));
export const table=new Map(native.files.map(f=>[f.path,f]));
export const hash=data=>createHash('sha256').update(data).digest('hex');
export function closure(entry){const result=new Set();function visit(path){if(result.has(path))return;const f=table.get(path);if(!f)throw Error('Missing fixture member '+path);result.add(path);for(const p of f.dependencies||[])visit(p);}visit(entry);return [...result];}
export function view(suffix='1'){
  return {schema:'ic.view.v1',kind:'schematic',view_id:'v_'+suffix.repeat(32),workspace_id:'w_'+suffix.repeat(32),revision:1,
    identity:{project_id:'real-sar-20261106',source_commit:'a'.repeat(40),source_sha256:native.source.sha256,path:native.source.path,run_id:null,configuration:null},
    visible:true,display_mode:'inline',readiness:{state:'requested'},ui:{mounted:null},selection:null,workspace_revision:1};
}
export function geometry(v){
  return {source_hash:v.identity.source_sha256,source_commit:v.identity.source_commit,source_path:v.identity.path,
    geometry:{mode:'native',available:true,integrity:'valid',fidelity:'partial',state:'partial',cells:native.cells,
      root_cell:native.root_cell,bundle_commit:v.identity.source_commit,manifest_sha256:hash(readFileSync(nativeRoot+'manifest.json')),source_binding:{geometry_source_sha256:v.identity.source_sha256,geometry_source_commit:v.identity.source_commit},losses:native.losses,coverage:native.coverage}};
}
export function manifest(entry){const cell=native.cells.find(e=>e.id===entry);if(!cell)throw Error('Unknown fixture entry');return {format:1,id:native.id,entry:cell.entrypoint,level:cell.level,pool:closure(cell.entrypoint).filter(p=>p!==cell.entrypoint),files:closure(cell.entrypoint).map(path=>({path,size:table.get(path).bytes,sha256:table.get(path).sha256,url:'http://127.0.0.1:1/never-fetch'})),settings:{autoInclude:false}};}
export function query(v,q){
  if(q.kind==='schematic')return geometry(v);
  if(q.kind==='geometry_manifest')return manifest(q.entry);
  if(q.kind==='geometry_file'){const row=table.get(q.path);if(!row)throw Error('Path not enumerated');const raw=readFileSync(nativeRoot+q.path),offset=q.offset||0,end=Math.min(raw.length,offset+(q.limit||262144));return {path:q.path,offset,total_bytes:raw.length,next_offset:end<raw.length?end:null,sha256:row.sha256,encoding:'base64',data:raw.subarray(offset,end).toString('base64')};}
  throw Error('No fixture operation '+q.kind);
}
export function host(v=view()){return {initial:v,calls:[],async call(name,args){this.calls.push({name,args});if(name!=='ic_view_data'||args.revision!==v.revision||args.view_id!==v.view_id||args.workspace_id!==v.workspace_id)throw Error('Unexpected fixture call');return {view:v,kind:args.query.kind,payload:query(v,args.query)};}};}
