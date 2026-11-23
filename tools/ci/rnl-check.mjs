// Build bounded RNL documents with the trusted bundled WASM, never a simulator.
import {readFileSync,writeFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCore} from '../../apps/web/vendor/rnl-viewer/core/core.js';
const [rootArg,input,output]=process.argv.slice(2),root=realpathSync(rootArg);
const source=JSON.parse(readFileSync(input,'utf8')),results=[];
const core=await loadCore(readFileSync(new URL('../../apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm',import.meta.url)));
const safe=name=>{
  if(typeof name!=='string'||!name.match(/^(lib|projects)\//)||name.split('/').some(x=>!x||x==='.'||x==='..')||/[\\:%?#\x00-\x1f]/.test(name))throw Error('Unsafe RNL inventory path');
  const path=resolve(root,name);if(!realpathSync(path).startsWith(root+sep)||lstatSync(path).isSymbolicLink())throw Error('RNL path outside checkout');
  const raw=readFileSync(path);if(raw.length>10*1024*1024)throw Error('Oversized RNL source');return raw.toString('utf8');
};
if(!Array.isArray(source.rnl_views)||source.rnl_views.length>5000)throw Error('Invalid RNL check inventory');
for(const view of source.rnl_views){
  const row={library_id:view.library_id,cell_id:view.cell_id,view_id:view.view_id,entry:view.entry,status:'passed'};
  try{
    if(!Array.isArray(view.files)||view.files.length>2000||!view.files.includes(view.entry))throw Error('Invalid RNL closure');
    const files=Object.fromEntries(view.files.map(name=>['/'+name,safe(name)]));
    if(Object.values(files).reduce((n,s)=>n+Buffer.byteLength(s),0)>30*1024*1024)throw Error('Oversized RNL closure');
    const doc=core.build({entry:'/'+view.entry,files,svg:true,primitives:false});
    row.errors=(doc.diagnostics||[]).filter(d=>d.severity==='error').slice(0,50);
    row.levels=(doc.levels||[]).length;
    if(row.errors.length||!row.levels)row.status='failed';
    else {
      if(view.level!==undefined&&(typeof view.level!=='string'||!view.level.length||view.level.length>256))throw Error('Invalid declared RNL display level');
      const selected=view.level===undefined||view.level==='@top'?0:doc.levels.findIndex(level=>level.title===view.level);
      if(selected<0)throw Error('Declared RNL display level does not exist: '+view.level);
      const level=doc.levels[selected];row.selected_level=level.title;row.geometry_hits=Array.isArray(level.hits)?level.hits.length:0;
      // Native timing/text drawings can have visible SVG without electrical
      // probe hit targets. Use the renderer's drawing result, not hit count.
      if(level.empty!==false||typeof level.svg!=='string'||!level.svg.includes('<svg'))throw Error('Selected RNL display level has no drawable geometry: '+level.title);
    }
  }catch(error){row.status='failed';row.error=error.message;}
  results.push(row);
}
const report={schema:'circuitgit.rnl-ci.v1',check_kind:'rnl-document-build',source_commit:source.source_commit,
  status:source.status!=='passed'||results.some(r=>r.status==='failed')?'failed':results.length?'passed':'not_applicable',simulation_started:false,views:results};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,views:results.length,simulation_started:false}));
if(report.status==='failed')process.exitCode=1;
