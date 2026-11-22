// Build exactly the materialized bytes and per-cell closure; report every diagnostic.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]),runtime=resolve(process.argv[3]),out=resolve(process.argv[4]);
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'))),files={},table=new Map(manifest.files.map(f=>[f.path,f]));
const sha=x=>createHash('sha256').update(x).digest('hex');
for(const f of manifest.files){const bytes=readFileSync(join(root,f.path));if(sha(bytes)!==f.sha256||bytes.length!==f.bytes)throw Error('Hash mismatch: '+f.path);if(['native-netlist','native-assembly','rnl'].includes(f.kind))files['/native/'+f.path]=bytes.toString();}
const closure=entry=>{const done=new Set(),visiting=new Set();function walk(p){if(visiting.has(p))throw Error('Cycle');if(done.has(p))return;visiting.add(p);for(const d of table.get(p).dependencies)walk(d);visiting.delete(p);done.add(p);}walk(entry);return [...done];};
const {startCore}=await import(pathToFileURL(runtime));const core=startCore();const rows=[];mkdirSync(out,{recursive:true});
try{for(const cell of manifest.cells){const paths=closure(cell.entrypoint),members=Object.fromEntries(paths.map(p=>['/native/'+p,files['/native/'+p]]));
 const doc=await core.build({entry:'/native/'+cell.entrypoint,files:members,auto_include:false});
 const row={id:cell.id,entry:cell.entrypoint,files:paths.length,instances:doc.objects.filter(o=>o.kind==='instance').length,levels:doc.levels.length,unplaced:doc.levels.reduce((n,l)=>n+(l.unplaced?.length??0),0),diagnostics:doc.diagnostics};rows.push(row);
 if(cell.id===manifest.root_cell)writeFileSync(join(out,'core-document.json'),JSON.stringify(doc));
 console.log(JSON.stringify({id:row.id,instances:row.instances,levels:row.levels,errors:row.diagnostics.filter(x=>x.severity==='error').length,unplaced:row.unplaced}));
}}finally{core.terminate();}
const result={schema:'ic.native.core-validation.v1',manifest_sha256:sha(readFileSync(join(root,'manifest.json'))),runtime,diagnostics_filtered:false,cells:rows,passed:rows.every(r=>!r.unplaced&&!r.diagnostics.some(d=>d.severity==='error'||d.severity==='warning'))};
writeFileSync(join(out,'core-summary.json'),JSON.stringify(result,null,2)+'\n');if(!result.passed)process.exitCode=1;
