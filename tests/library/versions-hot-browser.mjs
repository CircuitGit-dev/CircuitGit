// Source-only browser acceptance: ephemeral loopback server, no build or live gateway.
// Synthetic files exist only in this process. LIBRARY_REAL_CELL=pipetisar-real/Switch adds a real-data check.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,statSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,relative,extname,posix} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),app=resolve(root,'apps/web'),prefix='/CircuitGit/';
const built=process.env.LIBRARY_WEB_ROOT?resolve(process.env.LIBRARY_WEB_ROOT):null;
const output=resolve(process.env.EVIDENCE_DIR||root+'/test-results/library');mkdirSync(output,{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const assets=JSON.parse(readFileSync(root+'/workspace.json','utf8')),mounts=[{source:'apps/web',mount:''},...assets.shared];
const publicPath=source=>{for(const item of mounts){const folder=resolve(root,item.source);if(source.startsWith(folder+'/'))return posix.join(item.mount,relative(folder,source));}return null;};
function sourceBytes(file,destination){
  const bytes=readFileSync(file);if(!['.html','.js','.mjs','.css'].includes(extname(file)))return bytes;
  let text=bytes.toString('utf8');if(file===resolve(built||app,'demo/main.js'))text=text.replace('  return host;\n}', '  window.__hotFixtureHost=host; return host;\n}');if(built)return text;return text.replace(/(['"])(\.{1,2}\/[^'"\n]+)\1/g,(original,quote,value)=>{const path=value.split(/[?#]/)[0],target=resolve(dirname(file),path),mapped=publicPath(target);if(!mapped||!existsSync(target)||!statSync(target).isFile())return original;let link=posix.relative(posix.dirname(destination),mapped);if(!link.startsWith('.'))link='./'+link;return quote+link+value.slice(path.length)+quote;});
}
const cellRoot='lib/synthetic/closure',entry=cellRoot+'/schematic/view.scs',companion='lib/_shared/synthetic/circuit.scs',logicalCompanion=cellRoot+'/schematic/support/circuit.scs',readme=cellRoot+'/README.md';
const native={id:'schematic',label:'Synthetic native closure',kind:'rnl',entry,files:[entry,companion],aliases:{[logicalCompanion]:companion},level:'@top'};
const cell={id:'closure',name:'Synthetic closure fixture',description:'UI test data only; not a published ADC.',kind:'circuit',directory:cellRoot,readme,project_id:null,requires_external_models:false,views:[native,{id:'docs',label:'Synthetic README',kind:'markdown',entry:readme,files:[readme]}]};
const library={schema:'circuitgit.library.v1',id:'synthetic',name:'Synthetic test library',description:'Test only',cells:[cell,{...cell,id:'missing',name:'Missing closure fixture',views:[{...native,files:[entry,companion,cellRoot+'/schematic/missing.scs']}]}]};
// Keep the hand-authored top-level geometry in its own entry document. The
// included file defines a real named dependency, never another annotated @top.
const syntheticEntry=readFileSync(app+'/demo/rc.scs','utf8').replaceAll('R0','R_SYN')
  .replace('simulator lang=spectre','simulator lang=spectre\ninclude "support/circuit.scs"')
  .replace('R_SYN (in out) resistor r=1k','R_SYN (in out) synthetic_resistor r=1k');
const syntheticDependency='// Synthetic named dependency; no simulation was run.\nsimulator lang=spectre\nsubckt synthetic_resistor p n\nparameters r=1k\nR_DEP (p n) resistor r=r\nends synthetic_resistor\n';
const synthetic=new Map([['lib/catalog.json',JSON.stringify({schema:'circuitgit.libraries.v1',libraries:[{id:'synthetic',name:library.name,description:'Tests only',manifest:'lib/synthetic/library.json'}]})],['lib/synthetic/library.json',JSON.stringify(library)],[entry,syntheticEntry],[companion,syntheticDependency],[readme,'# Synthetic test only\n<script>window.fixtureExecuted=true</script>']]);
let mode='synthetic';const requested=[],failures=[],realAllowed=new Set();let realCatalog=null;
if(process.env.LIBRARY_REAL_CELL){realCatalog=JSON.parse(readFileSync(root+'/lib/catalog.json','utf8'));realAllowed.add('lib/catalog.json');for(const lib of realCatalog.libraries){realAllowed.add(lib.manifest);const manifest=JSON.parse(readFileSync(resolve(root,lib.manifest),'utf8'));for(const c of manifest.cells){realAllowed.add(c.readme);for(const view of c.views)for(const path of view.files)realAllowed.add(path);}}}
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const server=createServer((req,res)=>{
  try{
    const path=new URL(req.url,'http://test').pathname;if(!path.startsWith(prefix))throw Error('prefix');const destination=decodeURIComponent(path.slice(prefix.length));
    if(destination.startsWith('library-files/')){
      const file=destination.slice('library-files/'.length);requested.push(file);res.setHeader('Content-Type',file.endsWith('.json')?'application/json':'text/plain');
      if(mode==='synthetic'&&synthetic.has(file)){res.end(synthetic.get(file));return;}
      if(mode==='real'&&realAllowed.has(file)){res.end(readFileSync(resolve(root,file)));return;}
      res.writeHead(404);res.end('Fixture not found');return;
    }
    if(destination==='demo/release.json'){res.setHeader('Content-Type','application/json');res.end('{"commits":[]}');return;}
    let file=resolve(built||app,destination);if(!built)for(const item of assets.shared)if(destination.startsWith(item.mount+'/'))file=resolve(root,item.source,destination.slice(item.mount.length+1));
    if(built?!file.startsWith(built+'/'):publicPath(file)!==destination)throw Error('source path');res.setHeader('Content-Type',types[extname(file)]||'application/octet-stream');res.end(sourceBytes(file,destination));
  }catch(error){failures.push({url:req.url,message:error.message});res.writeHead(404);res.end('Not found');}
});
await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
const base='http://127.0.0.1:'+server.address().port,pages=[],errors=[],apiRequests=[];let browser;
try{
 browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});const page=await browser.newPage({viewport:{width:1400,height:960}});page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.goto(base+prefix+'vendor/rnl-viewer/index.html?studio=1&layout=dockview&demo=1');await page.waitForFunction(()=>document.body.dataset.studioState==='ready',null,{timeout:60000});assert.equal(requested.length,0);
 await page.locator('#studio-library-button').click();const manager=page.getByRole('dialog',{name:'Library Manager',exact:true});await manager.locator('[data-library-field="library"]').selectOption('synthetic');await manager.locator('[data-library-field="cell"]').selectOption('closure');await manager.locator('[data-library-field="view"]').selectOption('schematic');await manager.getByRole('button',{name:'打开原理图',exact:true}).click();await page.waitForFunction(()=>window.CircuitGitDemo.getContext().loadState==='ready'&&!window.CircuitGitDemo.reference,null,{timeout:60000});assert.equal(await page.locator('.wf-trace').count(),0);
 await page.evaluate(async({entry,companion,source,dependency,prefix})=>{
  window.open=()=>{throw Error('Unexpected popup');};window.fixtureFiles={[entry]:source,[companion]:dependency};window.fixtureRevision=1;window.fixtureCalls=[];
  const state=await import(prefix+'vendor/rnl-viewer/state.js'),drawing=await import(prefix+'vendor/rnl-viewer/drawing.js');drawing.showLevel(state.current,{x:100,y:200,k:1.75});window.beforeView={...drawing.view};window.beforeDoc=state.doc;
  window.__hotFixtureHost.libraryBridge.bind({request:async(route,{body})=>{
   window.fixtureCalls.push({route,body});if(route!=='/library/read')throw Error('Unexpected write');const {operation,args}=body;if(args.library_id!=='synthetic'||args.cell_id!=='closure')throw Error('wrong cell');if(operation==='current')return {base_commit:'b'.repeat(40),fingerprint:String(window.fixtureRevision),changes:[],diff:''};if(operation==='read_file'){if(!(args.path in window.fixtureFiles))throw Error('outside closure');return {path:args.path,text:window.fixtureFiles[args.path],sha256:String(window.fixtureRevision).padStart(64,'0')};}throw Error('Unexpected operation '+operation);
  }});
 },{entry,companion,source:syntheticEntry,dependency:syntheticDependency,prefix});
 await page.waitForFunction(()=>window.fixtureCalls.some(call=>call.body.operation==='read_file'));await page.waitForTimeout(250);
 await page.evaluate(entry=>{window.fixtureFiles[entry]=window.fixtureFiles[entry].replace('r=1k','r=2k');window.fixtureRevision++;},entry);
 await page.waitForFunction(()=>document.querySelector('#studio-native-note').textContent.includes('已同步本机原理图'),null,{timeout:30000});
 const updated=await page.evaluate(async(prefix)=>{const state=await import(prefix+'vendor/rnl-viewer/state.js'),drawing=await import(prefix+'vendor/rnl-viewer/drawing.js'),opening=await import(prefix+'vendor/rnl-viewer/open.js');return {changed:state.doc!==window.beforeDoc,view:{...drawing.view},expected:window.beforeView,text:(await opening.currentSource().open()).text,run:window.CircuitGitDemo.getContext().run};},prefix);assert.equal(updated.changed,true);assert.deepEqual(updated.view,updated.expected);assert.match(updated.text,/r=2k/);assert.equal(updated.run,null);
 await page.evaluate(companion=>{window.beforeCanonicalEdit=window.viewer.doc;window.fixtureFiles[companion]=window.fixtureFiles[companion].replace('parameters r=1k','parameters r=7k').replaceAll('R_DEP','R_CANONICAL');window.fixtureRevision++;},companion);
 await page.waitForFunction(()=>window.viewer.doc!==window.beforeCanonicalEdit,null,{timeout:30000});
 const aliasState=await page.evaluate(async({prefix,companion,logicalCompanion})=>{const source=(await import(prefix+'vendor/rnl-viewer/open.js')).currentSource();return {physical:await source.read('/'+companion),virtual:await source.read('/'+logicalCompanion),requests:window.fixtureCalls.filter(call=>call.body.operation==='read_file').map(call=>call.body.args.path)};},{prefix,companion,logicalCompanion});assert.equal(aliasState.physical,aliasState.virtual);assert.match(aliasState.virtual,/parameters r=7k/);assert.ok(!aliasState.requests.includes(logicalCompanion));assert.ok(!requested.includes(logicalCompanion));
 assert.equal(await page.evaluate(()=>window.viewer.doc.objects.some(object=>object.name==='R_CANONICAL')),true,'parent document must reparse its changed child circuit');assert.equal(await page.evaluate(()=>window.viewer.doc.objects.some(object=>object.name==='R_DEP')),false);
 await page.evaluate(entry=>{window.lastGoodDoc=window.viewer.doc;window.lastGoodSVG=document.querySelector('#canvas > svg')?.outerHTML;window.fixtureFiles[entry]='simulator lang=spectre\ninclude "missing.scs"\n';window.fixtureRevision++;},entry);
 await page.waitForFunction(()=>document.querySelector('#studio-native-note').textContent.includes('保留最后可读版本'),null,{timeout:30000});assert.equal(await page.evaluate(()=>window.viewer.doc===window.lastGoodDoc),true);assert.equal(await page.evaluate(()=>!!window.lastGoodSVG&&document.querySelector('#canvas > svg')?.outerHTML===window.lastGoodSVG),true);
 await page.evaluate(({entry,source})=>{window.fixtureFiles[entry]=source.replace('r=1k','r=3k');window.fixtureRevision++;},{entry,source:syntheticEntry});await page.waitForFunction(()=>document.querySelector('#studio-native-note').textContent.includes('已同步本机原理图'),null,{timeout:30000});const recovered=await page.evaluate(async prefix=>(await (await import(prefix+'vendor/rnl-viewer/open.js')).currentSource().open()).text,prefix);assert.match(recovered,/r=3k/);assert.equal(await page.locator('.wf-trace').count(),0);
 await page.evaluate(()=>window.__hotFixtureHost.libraryBridge.unbind());assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
 await page.screenshot({path:output+'/hot-refresh.png',fullPage:true});const report={status:'passed',sourceOnly:!built,builtAssets:!!built,realOperations:false,checks:['lazy initial library browsing','shared visible-cell current polling','Agent source change loads complete allowlisted closure','RNL document replaced after validation','level and viewport preserved','shared canonical dependency edit refreshes every virtual alias','changed child circuit appears in the loaded parent document','virtual aliases are never fetched from disk or network','parse failure retains exact last good doc and SVG','subsequent fix auto-recovers','old waveforms remain unbound','no popup and no write request'],errors};writeFileSync(output+'/hot-refresh.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
