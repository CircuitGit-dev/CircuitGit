// Render the standalone public-source inverter using the actual pinned RNL core.
// No gateway, simulator, remote filesystem, layout solver or model is used.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCore} from '../../apps/web/vendor/rnl-viewer/core/core.js';
import {validateLibrary,viewAliases} from '../../apps/web/library/model.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const library=validateLibrary(JSON.parse(readFileSync(resolve(root,'lib/basics/library.json'))),'basics');
const cell=library.cells.find(cell=>cell.id==='cmos-inverter');
assert(cell);assert.equal(cell.project_id,null);assert.equal(cell.requires_external_models,true);
const view=cell.views.find(view=>view.id==='schematic'),files={};
for(const path of view.files)files['/'+path]=readFileSync(resolve(root,path),'utf8');
for(const [logical,canonical] of Object.entries(viewAliases(view)))files['/'+logical]=files['/'+canonical];
const core=await loadCore(readFileSync(resolve(root,'apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm')));
const doc=core.build({entry:'/'+view.entry,files,auto_include:false});
assert.equal(doc.failed,null);assert.deepEqual(doc.missing,[]);
assert.deepEqual(doc.diagnostics.filter(d=>['error','fatal'].includes(d.severity)),[]);
const level=doc.levels.find(level=>level.title===view.level);
assert(level&&!level.empty&&level.svg.includes('<svg'));assert.equal(level.unplaced.length,0);
const instances=doc.objects.filter(o=>o.kind==='instance');
assert.deepEqual(instances.map(o=>o.name).sort(),['M10','M9']);
for(const name of ['CLK','CLKN','VDD','VSS'])assert(doc.objects.some(o=>o.kind==='net'&&o.name===name),'missing net '+name);
for(const name of ['M9','M10'])assert(level.hits.some(hit=>hit.objects.some(i=>doc.objects[i].kind==='instance'&&doc.objects[i].name===name)),'missing instance hit '+name);
const output=process.argv[2];
if(output){mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'cmos-inverter.svg'),level.svg);}
console.log(JSON.stringify({status:'passed',library:'basics',cell:cell.id,level:level.title,instances:2,ports:4,unplaced:0,auto_layout:false,simulation_performed:false,diagnostic_counts:doc.diagnostics.reduce((r,d)=>(r[d.severity]=(r[d.severity]||0)+1,r),{})}));
