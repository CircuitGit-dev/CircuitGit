import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,relative,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {applySelectionProperties,selectionBase,selectionBaseSha256,selectionPatchId} from '../tools/viewer/patches/selected-instance-properties.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const vendor=join(root,'apps/web/vendor/rnl-viewer');
const manifest=JSON.parse(readFileSync(join(vendor,'provenance.json')));
const lock=JSON.parse(readFileSync(join(root,'tools/viewer/upstream-lock.json')));
assert.equal(manifest.commit,lock.upstream_commit);
assert.equal(manifest.core_version,lock.runtime_version);
function walk(dir){return readdirSync(dir).flatMap(name=>{const p=join(dir,name);return statSync(p).isDirectory()?walk(p):[relative(vendor,p)]})}
assert.deepEqual(walk(vendor).filter(p=>p!=='provenance.json').sort(),manifest.files.map(f=>f.path).sort());
for(const row of manifest.files){
  const bytes=readFileSync(join(vendor,row.path));
  assert.equal(bytes.length,row.bytes,row.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256,row.path);
}
assert.equal(readFileSync(join(vendor,'ic-selection-bridge.js'),'utf8'),readFileSync(join(root,'tools/viewer/patches/ic-selection-bridge.js'),'utf8'));
const selection=readFileSync(join(vendor,'selection.js'),'utf8'),base=selectionBase(selection);
assert.equal(createHash('sha256').update(base).digest('hex'),selectionBaseSha256);
assert.equal(applySelectionProperties(base),selection,'Selection adaptation must be reproducible from its pinned base');
assert.equal(applySelectionProperties(selection),selection,'Selection adaptation must be idempotent');
assert.throws(()=>applySelectionProperties(base+'\n// unreviewed drift\n'),/reviewed pinned base/);
assert.ok(manifest.circuitgit_adaptations.some(item=>item.patch_id===selectionPatchId&&item.path==='selection.js'&&item.sha256===createHash('sha256').update(selection).digest('hex')));
// Replay the updater against an isolated two-file import and refuse unrelated drift.
const fixture=mkdtempSync(join(tmpdir(),'rnl-selection-patch-'));
try{
  const sources={'selection.js':base,'THIRD_PARTY_NOTICES.md':'Synthetic patch test notices.\n'};
  for(const [path,content]of Object.entries(sources))writeFileSync(join(fixture,path),content);
  writeFileSync(join(fixture,'provenance.json'),JSON.stringify({commit:manifest.commit,files:Object.entries(sources).map(([path,content])=>({path,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')}))}));
  const args=[join(root,'tools/viewer/apply-selection-properties.mjs'),fixture];
  execFileSync(process.execPath,args,{stdio:'pipe'});
  assert.equal(readFileSync(join(fixture,'selection.js'),'utf8'),selection);
  const first=readFileSync(join(fixture,'provenance.json'),'utf8');
  execFileSync(process.execPath,args,{stdio:'pipe'});
  assert.equal(readFileSync(join(fixture,'provenance.json'),'utf8'),first,'Repeat patch leaves provenance byte-identical');
  writeFileSync(join(fixture,'THIRD_PARTY_NOTICES.md'),'Unreviewed change\n');
  assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe'}),/Unrelated vendor drift/);
  assert.equal(readFileSync(join(fixture,'provenance.json'),'utf8'),first,'Rejected drift cannot refresh provenance');
}finally{rmSync(fixture,{recursive:true,force:true});}
const html=readFileSync(join(vendor,'index.html'),'utf8');
assert(!/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html),'inline executable startup script');
console.log(JSON.stringify({status:'passed',vendor_files:manifest.files.length,upstream_commit:manifest.commit,core_version:manifest.core_version}));
