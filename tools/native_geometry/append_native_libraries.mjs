// Add read-only saved-library views to a verified circuit bundle, without claiming
// those independent historical cells are the canonical simulation source.
import {readFileSync,writeFileSync,cpSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const cfgPath=resolve(process.argv[2]),cfg=JSON.parse(readFileSync(cfgPath)),base=dirname(cfgPath),p=x=>resolve(base,x),sha=x=>createHash('sha256').update(x).digest('hex');
const {indexSpectre}=await import(pathToFileURL(p(cfg.source_index_module)));
const out=p(cfg.output);if(existsSync(out))throw Error('Output already exists');cpSync(p(cfg.base_bundle),out,{recursive:true});
const manifest=JSON.parse(readFileSync(join(out,'manifest.json'))),added=[];
for(const lib of cfg.libraries){
 const root=p(lib.input),report=JSON.parse(readFileSync(join(root,'library-report.json'))),prefix=lib.prefix,local={},raw=[],changes=[];
 if(!report.complete||report.failed_cells.length)throw Error('Incomplete library export');
 for(const name of [...report.entries.map(e=>e.file),...(report.symbol_only_files??[]).map(e=>e.file),'eda-symbol.rnl','eda-style.rnl']){
  const data=readFileSync(join(root,name));local[name]=data.toString();raw.push({path:name,sha256:sha(data),bytes:data.length});
 }
 const capCoverage=[];
 for(const [file,text] of Object.entries(local))if(file.endsWith('.scs')){
  const explicit=new Set([...text.matchAll(/(#"[^"]+"|%[\w]+)\s+@SET-SYMBOL\s+[$%][\w]+/g)].map(m=>m[1])),bundled=new Map();
  for(const m of text.matchAll(/(%\w+)\s*=\s*\{([^}]+)\}\s*@BUNDLE/g))for(const n of m[2].matchAll(/#"([^"]+)"/g))bundled.set(n[1],m[1]);
  for(const o of indexSpectre(text,file).objects.filter(o=>o.kind==='instance'&&o.master==='capacitor')){const ref=bundled.get(o.name)??'#'+JSON.stringify(o.name);if(!explicit.has(ref))throw Error('Unassigned capacitor '+prefix+'/'+file+'/'+o.name);capCoverage.push({file,name:o.name,ref});}
 }
 function fix(file,text){let n=0;const next=text.replace(/^.*@SELECT-INSTANCE\(model="capacitor"\).*@SET-SYMBOL.*$/gm,line=>{n++;changes.push({file,original:line,reason:'Redundant capacitor default after complete explicit symbol coverage assertion'});return '/* Native scalar/bundle capacitor assignments are explicit; see library-provenance.json. */';});if(n!==1)throw Error('Unexpected capacitor rule count');return next;}
 local['eda-symbol.rnl']=fix('eda-symbol.rnl',local['eda-symbol.rnl']);
 for(const n of ['rnl-std-spectre','rnl-std-basic','rnl-std-semiconductors']){let text=readFileSync(join(p(cfg.standard_packages),n+'.rnl'),'utf8');local[n+'.rnl']=n==='rnl-std-spectre'?fix(n+'.rnl',text):text;}
 for(const [file,text] of Object.entries(local))if(file.endsWith('.scs')){
  local[file]=text.split('\n').map((line,i)=>{if(/^\s*ahdl_include\s/.test(line)){changes.push({file,line:i+1,original:line,reason:'Behavioral implementation excluded from viewer only'});return '// External behavioral implementation omitted from read-only viewer.';}return line;}).join('\n').replace('//   @VERSION("0.3");','//   @VERSION("0.3");\n//   @USE-PACKAGE(name="rnl-std-spectre", version="0.3", path="rnl-std-spectre.rnl");');
 }
 const targets=new Map();for(const [file,text] of Object.entries(local))if(file.endsWith('.scs'))for(const s of indexSpectre(text,file).scopes){if(targets.has(s.name))throw Error('Duplicate library scope '+s.name);targets.set(s.name,file);}
 const cells=[],assemblies=new Set();
 for(const e of report.entries){
  const idx=indexSpectre(local[e.file],e.file),scope=idx.scopes.find(s=>s.name===e.cell),isTop=idx.objects.some(o=>o.scope==='(top)');
  let entry=e.file,level=scope?.name??'@top';
  if(!isTop&&scope){
   const closure=new Set(),active=new Set();function walk(file){if(active.has(file))throw Error('Recursive library');if(closure.has(file))return;active.add(file);for(const o of indexSpectre(local[file],file).objects.filter(o=>o.kind==='instance')){const f=targets.get(o.master);if(f&&f!==file)walk(f);}active.delete(file);closure.add(file);}walk(e.file);
   entry='view-'+e.cell+'.scs';assemblies.add(entry);local[entry]='// Explicit saved-library assembly.\nsimulator lang=spectre\n'+[...closure].map(f=>'include '+JSON.stringify(f)).join('\n')+'\n';
  }
  cells.push({id:prefix+'.'+e.cell,cell_view:{library:e.library,cell:e.cell,view:'schematic'},entrypoint:prefix+'/'+entry,level,source_kind:'saved-library-export',canonical_source_mapping:false});
 }
 for(const e of report.symbol_only_files??[]){
  const entry='symbol-'+e.cell+'.scs';local[entry]='@RNL(type="header") { @VERSION("0.3"); @USE-PACKAGE(name='+JSON.stringify(e.package)+', version="0.1", path='+JSON.stringify(e.file)+'); @USE-PACKAGE(name="eda-style", version="0.1", path="eda-style.rnl") }\n@RNL { %symbol = $FIGURE @ATTACH (0, 0) => @SET-SYMBOL $'+JSON.stringify(e.library+'/'+e.cell)+'; %symbol @TEXT('+JSON.stringify(e.cell)+', key="name") }\n';
  local[entry]='// Saved native symbol, rendered as a non-electrical figure.\nsimulator lang=spectre\n'+local[entry].split('\n').map(line=>'// '+line).join('\n');
  cells.push({id:prefix+'.'+e.cell,cell_view:{library:e.library,cell:e.cell,view:'symbol'},entrypoint:prefix+'/'+entry,level:'@top',source_kind:'saved-library-export',canonical_source_mapping:false});
 }
 const levelEntries=new Map(cells.map(c=>[c.level,c.entrypoint.slice(prefix.length+1)]));
 const providers=new Map();for(const [file,text]of Object.entries(local))for(const m of text.matchAll(/@PACKAGE\(name="([^"]+)",\s*version="([^"]+)"\)/g))providers.set(m[1]+'/'+m[2],file);
 for(const [file,text]of Object.entries(local)){
  const deps=new Set();for(const m of text.matchAll(/@USE-PACKAGE\(name="([^"]+)",\s*version="([^"]+)"(?:,\s*path="([^"]+)")?\)/g)){const provider=providers.get(m[1]+'/'+m[2]);if(!provider)throw Error('Missing library package');deps.add(provider);}
  for(const m of text.matchAll(/^include\s+"([^"]+)"/gm)){if(!local[m[1]])throw Error('Unlisted include');deps.add(m[1]);}
  if(file.endsWith('.scs'))for(const o of indexSpectre(text,file).objects.filter(o=>o.kind==='instance')){const f=targets.get(o.master);if(f&&f!==file){deps.add(f);const entry=levelEntries.get(o.master);if(entry&&entry!==file)deps.add(entry);}}
  const name=prefix+'/'+file;mkdirSync(dirname(join(out,name)),{recursive:true});writeFileSync(join(out,name),text);manifest.files.push({path:name,kind:assemblies.has(file)?'native-assembly':file.endsWith('.scs')?'native-netlist':'rnl',sha256:sha(text),bytes:Buffer.byteLength(text),dependencies:[...deps].map(d=>prefix+'/'+d).sort()});
 }
 const metadata={schema:'ic.native.library-provenance.v1',library:report.library,report,raw_files:raw,changes,capacitor_coverage:capCoverage,source_kind:'saved-library-export',canonical_source_mapping:false,notice:'Saved OA archive library view; circuit source binding applies only to the main real-SAR bundle. No simulation configuration or accepted performance is implied.'};
 const name=prefix+'/library-provenance.json',text=JSON.stringify(metadata,null,2)+'\n';writeFileSync(join(out,name),text);manifest.files.push({path:name,kind:'provenance',sha256:sha(text),bytes:Buffer.byteLength(text),dependencies:[]});
 for(const c of cells){c.coverage={status:'partial',saved_library_cells:{expected:report.successful_cells,exported:cells.length}};c.losses=[{severity:'partial',blocking:true,reason:'Saved-library snapshot: dynamic labels, exact styles and ignored instrumentation remain partial; no canonical simulation-source identity for this independent cell.'}];c.fidelity={status:'partial',report:name};}
 manifest.cells.push(...cells);added.push({prefix,cells:cells.length,schematics:report.entries.length,symbol_only:(report.symbol_only_files??[]).length,failed:report.failed_cells.length});
}
for(const f of manifest.files)f.export_namespace=f.path.includes('/')?f.path.split('/')[0]:'canonical';
for(const c of manifest.cells)c.export_namespace=c.entrypoint.includes('/')?c.entrypoint.split('/')[0]:'canonical';
manifest.library_catalog=added;writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({output:out,files:manifest.files.length,cells:manifest.cells.length,libraries:added,manifest_sha256:sha(readFileSync(join(out,'manifest.json')))}));
