import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,relative,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
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
const html=readFileSync(join(vendor,'index.html'),'utf8');
assert(!/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html),'inline executable startup script');
console.log(JSON.stringify({status:'passed',vendor_files:manifest.files.length,upstream_commit:manifest.commit,core_version:manifest.core_version}));
