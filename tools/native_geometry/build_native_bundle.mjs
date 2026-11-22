// Reproducible viewer derivative of a saved native export. Never changes raw inputs.
// Usage: node build_native_bundle.mjs config.json (all paths relative to config).
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const configFile=resolve(process.argv[2]),cfg=JSON.parse(readFileSync(configFile)),base=dirname(configFile);
const path=x=>resolve(base,x),hash=x=>createHash('sha256').update(x).digest('hex');
const {indexSpectre}=await import(pathToFileURL(path(cfg.source_index_module)));
const input=path(cfg.export_root),out=path(cfg.output),repo=path(cfg.repository);
if(existsSync(out))throw Error('Output must be new; retain previous bundle identities');
const report=JSON.parse(readFileSync(join(input,'export-report.json')));
const definitions=report.definitions.map(d=>({...d}));
const source=readFileSync(join(repo,cfg.source.path),'utf8'),sourceHash=hash(source);
if(sourceHash!==cfg.source.sha256)throw Error('Canonical source differs from configured export binding');
const canonical=indexSpectre(source,cfg.source.path),files={},adaptations=[],rawHashes=[];
for(const name of [...new Set([...definitions.map(d=>d.file),report.entry,'eda-symbol.rnl','eda-style.rnl'])]){
  const bytes=readFileSync(join(input,name));files[name]=bytes.toString();rawHashes.push({path:name,sha256:hash(bytes),bytes:bytes.length});
}
for(const extra of cfg.additional_verified_fragments??[]){
  const bytes=readFileSync(path(extra.input));if(hash(bytes)!==extra.sha256)throw Error('Additional fragment hash mismatch');
  if(files[extra.file])throw Error('Duplicate additional fragment');
  files[extra.file]=bytes.toString().replaceAll('path="../','path="');
  definitions.push({library:extra.library,cell:extra.cell,subcircuit:extra.subcircuit,file:extra.file});
  adaptations.push({file:extra.file,reason:'Canonical-equivalent exported wrapper, flattened package paths',raw_sha256:hash(bytes)});
  files[report.entry]=files[report.entry].replace('\n','\ninclude '+JSON.stringify(extra.file)+'\n');
}
const normalize=x=>x.replace(/\\([<>])/g,'$1').replace(/<(\d+)>/g,'_$1').replace(/\s+/g,' ').trim();
const recovered=cfg.ignored_figures?JSON.parse(readFileSync(path(cfg.ignored_figures))).figures:[];
for(const figure of recovered){
 const d=definitions.find(d=>d.library===figure.library&&d.cell===figure.cell);
 if(!d)continue;
 const block='// @RNL(author="native-ignored-figure-recovery") {\n'+figure.records.split('\n').map(x=>'//   '+x).join('\n')+'\n// }\n';
 const end=new RegExp('^ends\\s+'+d.subcircuit+'\\s*$','m');
 if(!end.test(files[d.file]))throw Error('Figure recovery scope missing');
 files[d.file]=files[d.file].replace(end,block+'ends '+d.subcircuit);
 adaptations.push({file:d.file,reason:'Restore explicitly ignored native instrument as a non-electrical figure',figure});
}
const capCoverage=[];
for(const [file,text] of Object.entries(files))if(file.endsWith('.scs')){
  const idx=indexSpectre(text,file),explicit=new Set([...text.matchAll(/(#"[^"]+"|%[\w]+)\s+@SET-SYMBOL\s+[$%][\w]+/g)].map(m=>m[1]));
  const members=new Map();
  for(const match of text.matchAll(/(%\w+)\s*=\s*\{([^}]+)\}\s*@BUNDLE/g)){
    for(const part of match[2].matchAll(/#"([^"]+)"/g))members.set(part[1],match[1]);
  }
  for(const obj of idx.objects.filter(o=>o.kind==='instance'&&o.master==='capacitor')){
    const ref=members.get(obj.name)??'#'+JSON.stringify(obj.name);
    if(!explicit.has(ref))throw Error(`Capacitor without explicit native symbol: ${file}/${obj.name}/${ref}`);
    capCoverage.push({file,name:obj.name,ref,bundled:members.has(obj.name)});
  }
}
// Removing these two redundant defaults is permitted only after the complete
// capacitor coverage assertion above. No diagnostic is removed or filtered.
function removeCapRule(file,text){
  let count=0;const result=text.replace(/^.*@SELECT-INSTANCE\(model="capacitor"\).*@SET-SYMBOL.*$/gm,line=>{
    count++;adaptations.push({file,reason:'Redundant default targets hidden scalar bundle members',original:line});
    return '/* Native capacitor and bundle symbols are all explicitly assigned; see adaptation.json. */';
  });
  if(count!==1)throw Error(`Expected exactly one capacitor default in ${file}; got ${count}`);
  return result;
}
files['eda-symbol.rnl']=removeCapRule('eda-symbol.rnl',files['eda-symbol.rnl']);
for(const name of ['rnl-std-spectre','rnl-std-basic','rnl-std-semiconductors']){
  const nameFile=name+'.rnl',bytes=readFileSync(join(path(cfg.standard_packages),nameFile));
  files[nameFile]=name==='rnl-std-spectre'?removeCapRule(nameFile,bytes.toString()):bytes.toString();
  rawHashes.push({path:nameFile,origin:'pinned viewer standard package',sha256:hash(bytes),bytes:bytes.length});
}
for(const [file,text] of Object.entries(files))if(file.endsWith('.scs')){
  let next=text.split('\n').map((line,i)=>{
    if(/^\s*ahdl_include\s+/.test(line)){
      adaptations.push({file,line:i+1,reason:'External behavioral implementation is loaded only by the simulator',original:line});
      return '// External behavioral implementation omitted from viewer; preserved in source provenance.';
    }return line;
  }).join('\n');
  next=next.replace('//   @VERSION("0.3");','//   @VERSION("0.3");\n//   @USE-PACKAGE(name="rnl-std-spectre", version="0.3", path="rnl-std-spectre.rnl");');
  if(next===text)throw Error('Native header missing: '+file);
  files[file]=next;
}
// Electrical tuples are checked against canonical before any source jump is enabled.
const objects=[],electrical=[];
for(const [file,text] of Object.entries(files))if(file.endsWith('.scs')){
 const idx=indexSpectre(text,file);
 for(const obj of idx.objects){
   const target=canonical.objects.find(o=>o.kind===obj.kind&&o.scope===obj.scope&&normalize(o.name)===normalize(obj.name));
   let safe=!!target;
   if(safe&&obj.kind==='instance')safe=normalize(obj.master)===normalize(target.master)&&normalize(obj.parameters)===normalize(target.parameters)&&JSON.stringify(obj.nodes.map(normalize))===JSON.stringify(target.nodes.map(normalize));
   if(obj.kind==='instance'){electrical.push({file,scope:obj.scope,name:obj.name,canonical_equal:safe});if(!safe)throw Error('Noncanonical instance: '+file+'/'+obj.scope+'/'+obj.name);}
   objects.push({kind:obj.kind,name:obj.name,scope:obj.scope,viewer_source_path:file,source_kind:safe?'canonical':'export',readonly:!safe,source_path:safe?cfg.source.path:file,source_sha256:safe?sourceHash:hash(text),line_start:safe?target.line_start:obj.line_start,line_end:safe?target.line_end:obj.line_end,export_line_start:obj.line_start,export_line_end:obj.line_end});
 }
}
if(electrical.length!==canonical.objects.filter(o=>o.kind==='instance').length)throw Error('Missing canonical instances');
const providers=new Map();for(const [file,text] of Object.entries(files))for(const m of text.matchAll(/@PACKAGE\(name="([^"]+)",\s*version="([^"]+)"\)/g))providers.set(m[1]+'/'+m[2],file);
const targetFiles=new Map(definitions.map(d=>[d.subcircuit,d.file]));
// Each selectable subcircuit uses one flat, include-only wrapper. Recursive
// includes in every fragment would instantiate duplicate definitions in core.
const assemblies=new Set();
for(const d of definitions){
  const closure=new Set(),active=new Set();
  function walk(file){if(active.has(file))throw Error('Recursive native hierarchy');if(closure.has(file))return;active.add(file);
    for(const o of indexSpectre(files[file],file).objects.filter(o=>o.kind==='instance')){const child=targetFiles.get(o.master);if(child&&child!==file)walk(child);}
    active.delete(file);closure.add(file);
  }walk(d.file);
  const file='view-'+d.subcircuit+'.scs';assemblies.add(file);
  files[file]='// Explicit native hierarchy assembly; no automatic inclusion.\nsimulator lang=spectre\n'+[...closure].map(f=>'include '+JSON.stringify(f)).join('\n')+'\n';
}
const rows=Object.entries(files).map(([file,text])=>{
 const deps=new Set();
 for(const m of text.matchAll(/@USE-PACKAGE\(name="([^"]+)",\s*version="([^"]+)"(?:,\s*path="([^"]+)")?\)/g)){
   const provider=providers.get(m[1]+'/'+m[2]);if(!provider)throw Error('Missing package '+m[1]);deps.add(provider);
 }
 for(const m of text.matchAll(/^include\s+"([^"]+)"/gm)){if(!files[m[1]])throw Error('Unserved include '+m[1]);deps.add(m[1]);}
 if(file.endsWith('.scs'))for(const o of indexSpectre(text,file).objects.filter(o=>o.kind==='instance')){const f=targetFiles.get(o.master);if(f&&f!==file){deps.add(f);deps.add('view-'+o.master+'.scs');}}
 return {path:file,kind:assemblies.has(file)?'native-assembly':file.endsWith('.scs')?'native-netlist':'rnl',sha256:hash(text),bytes:Buffer.byteLength(text),dependencies:[...deps].sort()};
});
const root={id:report.top,cell_view:report.source,entrypoint:report.entry,level:report.root_kind==='top'?'@top':report.top};
const cells=[root,...definitions.map(d=>({id:d.subcircuit,cell_view:{library:d.library,cell:d.cell,view:'schematic'},entrypoint:'view-'+d.subcircuit+'.scs',level:d.subcircuit}))];
const losses=[{severity:'partial',blocking:true,reason:'Dynamic cdsParam/cdsTerm symbol labels omitted by the native exporter',count:report.notes.filter(x=>x.includes('unevaluated')).length},{severity:recovered.length?'partial':'error',blocking:true,reason:recovered.length?'Ignored instruments recovered as native non-electrical figures; native pin positions use visual dots; dynamic parameter labels remain omitted':'Ignored instruments are absent pending native figure recovery',count:recovered.length||report.notes.filter(x=>x.includes('nlAction=ignore')).length},{severity:'partial',blocking:true,reason:'Symbol physical-pin multiplicity and exact font/style fidelity not fully verified',count:null}];
const metadata={
 'mapping.json':{schema:'ic.native.source-map.v1',bound_source_hash:sourceHash,objects},
 'adaptation.json':{schema:'ic.native.display-adaptation.v1',raw_files:rawHashes,changes:adaptations,capacitor_coverage:capCoverage,raw_inputs_unchanged:true,diagnostics_filtered:false,placement_orientation_and_wire_records_unchanged:true},
 'validation.json':{schema:'ic.native-geometry.validation.v1',project_id:cfg.project_id,verifier:'native export and canonical tuple comparison; independent route audit attached separately',source_sha256:sourceHash,electrical:{instances:electrical.length,all_canonical_equal:true,details:electrical},cells:Object.fromEntries(cells.map(c=>[c.id,{checks:{placement:null,orientation:null,wire_routes:null,pins:null,symbols:null,labels:false}}])),native_notes:report.notes,limitations:losses},
 'provenance.json':{schema:'ic.native.provenance.v1',upstream:cfg.upstream,export_report:report,additional_verified_fragments:cfg.additional_verified_fragments??[],source:cfg.source,config_sha256:hash(readFileSync(configFile))}
};
for(const [file,obj]of Object.entries(metadata)){const text=JSON.stringify(obj,null,2)+'\n';files[file]=text;rows.push({path:file,kind:file==='mapping.json'?'source-map':file==='validation.json'?'validation-report':'provenance',sha256:hash(text),bytes:Buffer.byteLength(text),dependencies:[]});}
const manifest={schema:'ic.native-geometry.v1',id:cfg.id,project_id:cfg.project_id,source:cfg.source,native_export:{origin:'Cadence si + EDIF through pinned rnl-virtuoso with recorded local fixes',version:report.version,snapshot_sha256:cfg.snapshot_sha256,config_sha256:hash(readFileSync(configFile)),report_sha256:hash(readFileSync(join(input,'export-report.json')))},coordinate_system:{units:'RNL units',transform:{edif_divisor:10,x:'right',y:'up',native_symbol_pin_compensation:true}},root_cell:root.id,entrypoint:root.entrypoint,cells,coverage:{status:'partial',counts:{instances:{expected:electrical.length,exported:electrical.length},subcircuits:{expected:definitions.length,exported:definitions.length},wires:{expected:null,exported:null},symbols:{expected:null,exported:null},ports:{expected:null,exported:null},labels:{expected:null,exported:null}}},losses,fidelity:{status:'partial',report:'validation.json',report_sha256:hash(files['validation.json'])},mapping:'mapping.json',files:rows};
mkdirSync(out,{recursive:true});for(const [file,text] of Object.entries(files)){mkdirSync(dirname(join(out,file)),{recursive:true});writeFileSync(join(out,file),text);}
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({output:out,instances:electrical.length,mapping:objects.length,files:rows.length,cells:cells.length,explicit_capacitors:capCoverage.length,bundled_capacitor_members:capCoverage.filter(x=>x.bundled).length}));
