// Refresh only this reviewed adaptation. Unrelated vendor drift is an error.
import {readFileSync,writeFileSync,renameSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {applySelectionProperties,appendSelectionNotice,selectionBaseSha256,selectionPatchId} from './patches/selected-instance-properties.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv.length>3)throw Error('Usage: node tools/viewer/apply-selection-properties.mjs [VENDOR_DIRECTORY]');
const vendor=resolve(process.argv[2]||join(root,'apps/web/vendor/rnl-viewer'));
const manifestPath=join(vendor,'provenance.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
const lock=JSON.parse(readFileSync(join(root,'tools/viewer/upstream-lock.json'),'utf8'));
if(manifest.commit!==lock.upstream_commit)throw Error('Vendor provenance does not match the pinned upstream.');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function files(directory){return readdirSync(directory).flatMap(name=>{const path=join(directory,name),stat=lstatSync(path);if(stat.isSymbolicLink())throw Error('Vendor symlink is unsupported.');return stat.isDirectory()?files(path):[relative(vendor,path)];});}
if(JSON.stringify(files(vendor).filter(path=>path!=='provenance.json').sort())!==JSON.stringify(manifest.files.map(row=>row.path).sort()))throw Error('Vendor inventory has unrelated added or missing files.');
const currentSelection=readFileSync(join(vendor,'selection.js'),'utf8'),selection=applySelectionProperties(currentSelection);
const currentNotice=readFileSync(join(vendor,'THIRD_PARTY_NOTICES.md'),'utf8'),notice=appendSelectionNotice(currentNotice);
for(const row of manifest.files){
  const bytes=readFileSync(join(vendor,row.path));
  if(row.path==='selection.js'){
    if(![selectionBaseSha256,hash(selection)].includes(row.sha256)||![selectionBaseSha256,hash(selection)].includes(hash(bytes)))throw Error('Unreviewed selection.js provenance.');
  }else if(row.bytes!==bytes.length||row.sha256!==hash(bytes))throw Error('Unrelated vendor drift: '+row.path);
}
const adaptations=[
  {path:'selection.js',content:selection,previous:selectionBaseSha256,reason:'Display literal selected-instance model and dimensions using the exact Document source span.'},
  {path:'THIRD_PARTY_NOTICES.md',content:notice,previous:hash(currentNotice),reason:'Document the selected-instance source inspection adaptation.'},
];
manifest.circuitgit_adaptations ||= [];
for(const patch of adaptations){
  const row=manifest.files.find(row=>row.path===patch.path);row.bytes=Buffer.byteLength(patch.content);row.sha256=hash(patch.content);
  const previous=manifest.circuitgit_adaptations.find(item=>item.patch_id===selectionPatchId&&item.path===patch.path);
  manifest.circuitgit_adaptations=manifest.circuitgit_adaptations.filter(item=>!(item.patch_id===selectionPatchId&&item.path===patch.path));
  manifest.circuitgit_adaptations.push({path:patch.path,previous_packaged_sha256:previous?.previous_packaged_sha256||patch.previous,sha256:row.sha256,reason:patch.reason,patch_id:selectionPatchId,patch:'tools/viewer/patches/selected-instance-properties.mjs'});
}
const note='2026-11-23: Add read-only selected-instance model and dimensions through the reproducible selected-instance-properties-v1 patch.';
manifest.local_patch_notes ||= [];if(!manifest.local_patch_notes.includes(note))manifest.local_patch_notes.push(note);
function atomicWrite(path,content){if(readFileSync(path,'utf8')===content)return;const temporary=path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,content,{flag:'wx'});renameSync(temporary,path);}
for(const patch of adaptations)atomicWrite(join(vendor,patch.path),patch.content);
atomicWrite(manifestPath,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({status:'applied',patch:selectionPatchId,files:adaptations.map(patch=>patch.path),upstream_commit:manifest.commit}));
