// Source-only browser acceptance: ephemeral loopback server, no build or live gateway.
// Synthetic files exist only in this process. LIBRARY_REAL_CELL=pipetisar-real/Switch adds a real-data check.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,statSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,relative,extname,posix} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),app=resolve(root,'apps/web'),prefix='/CircuitGit/';
const built=process.env.LIBRARY_WEB_ROOT?resolve(process.env.LIBRARY_WEB_ROOT):null,libraryRoot=built?resolve(built,'library-files'):root;
const output=resolve(process.env.EVIDENCE_DIR||root+'/test-results/library');mkdirSync(output,{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const assets=JSON.parse(readFileSync(root+'/workspace.json','utf8')),mounts=[{source:'apps/web',mount:''},...assets.shared];
const publicPath=source=>{for(const item of mounts){const folder=resolve(root,item.source);if(source.startsWith(folder+'/'))return posix.join(item.mount,relative(folder,source));}return null;};
function sourceBytes(file,destination){
  const bytes=readFileSync(file);if(!['.html','.js','.mjs','.css'].includes(extname(file)))return bytes;
  if(built)return bytes;
  return bytes.toString('utf8').replace(/(['"])(\.{1,2}\/[^'"\n]+)\1/g,(original,quote,value)=>{const path=value.split(/[?#]/)[0],target=resolve(dirname(file),path),mapped=publicPath(target);if(!mapped||!existsSync(target)||!statSync(target).isFile())return original;let link=posix.relative(posix.dirname(destination),mapped);if(!link.startsWith('.'))link='./'+link;return quote+link+value.slice(path.length)+quote;});
}
const cellRoot='lib/synthetic/closure',entry=cellRoot+'/schematic/view.scs',companion=cellRoot+'/schematic/support/circuit.scs',readme=cellRoot+'/README.md';
const native={id:'schematic',label:'Synthetic native closure',kind:'rnl',entry,files:[entry,companion],level:'@top'};
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
if(process.env.LIBRARY_REAL_CELL){realCatalog=JSON.parse(readFileSync(libraryRoot+'/lib/catalog.json','utf8'));realAllowed.add('lib/catalog.json');for(const lib of realCatalog.libraries){realAllowed.add(lib.manifest);const manifest=JSON.parse(readFileSync(resolve(libraryRoot,lib.manifest),'utf8'));for(const c of manifest.cells){realAllowed.add(c.readme);for(const view of c.views)for(const path of view.files)realAllowed.add(path);}}}
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const server=createServer((req,res)=>{
  try{
    const path=new URL(req.url,'http://test').pathname;if(!path.startsWith(prefix))throw Error('prefix');const destination=decodeURIComponent(path.slice(prefix.length));
    if(destination.startsWith('library-files/')){
      const file=destination.slice('library-files/'.length);requested.push(file);res.setHeader('Content-Type',file.endsWith('.json')?'application/json':'text/plain');
      if(mode==='synthetic'&&synthetic.has(file)){res.end(synthetic.get(file));return;}
      if(mode==='real'&&realAllowed.has(file)){res.end(readFileSync(resolve(libraryRoot,file)));return;}
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
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  const page=await browser.newPage({viewport:{width:1500,height:980}});pages.push(page);page.setDefaultTimeout(12000);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{const url=new URL(r.url());if(url.pathname.includes('/api/')||(!['data:','blob:'].includes(url.protocol)&&url.origin!==base))apiRequests.push(url.href);});
  await page.goto(base+prefix+'vendor/rnl-viewer/index.html?studio=1&layout=dockview&demo=1');
  await page.waitForFunction(()=>document.body.dataset.studioState==='ready',null,{timeout:45000});
  await page.waitForSelector('.wf-trace[data-trace="vout:1"]');assert.equal(requested.length,0,'catalog must remain lazy until Library opens');
  await page.locator('#demo-r').fill('2000');await page.locator('#demo-update').click();await page.waitForFunction(()=>document.querySelector('#demo-basis').textContent.includes('τ = 2 ns'));
  await page.locator('#studio-library-button').click();const manager=page.getByRole('dialog',{name:'Library Manager',exact:true});
  const field=key=>manager.locator(`[data-library-field="${key}"]`);
  await field('library').selectOption('synthetic');await field('cell').selectOption('closure');await field('view').selectOption('docs');
  await manager.getByRole('button',{name:'查看文件',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.cg-library-preview').hidden);
  assert.match(await manager.locator('.cg-library-preview').innerText(),/<script>/);assert.equal(await page.evaluate(()=>window.fixtureExecuted),undefined);
  assert.equal(await page.evaluate(()=>window.CircuitGitDemo.reference),true);assert.equal(requested.includes(companion),false);
  await manager.getByRole('searchbox').fill('native closure');assert.equal(await field('cell').locator('option').count(),2);await manager.getByRole('searchbox').fill('');await field('cell').selectOption('closure');await field('view').selectOption('schematic');
  await page.screenshot({path:output+'/manager.png',fullPage:true});
  await manager.getByRole('button',{name:'打开原理图',exact:true}).click();await page.waitForFunction(()=>window.CircuitGitDemo.getContext().loadState==='ready'&&!window.CircuitGitDemo.reference,null,{timeout:45000});
  const state=await page.evaluate(()=>({context:window.CircuitGitDemo.getContext(),selection:window.CircuitGitDemo.getLibrarySelection(),path:window.viewer.doc.path,objects:window.viewer.doc.objects.map(o=>o.name),errors:window.viewer.doc.diagnostics.filter(d=>d.severity==='error')}));
  assert.equal(state.path,'/'+entry);assert.ok(state.objects.includes('R_SYN'));assert.ok(state.objects.includes('R_DEP'),'named subcircuit dependency must be parsed from the nested companion');assert.equal(state.context.run,null);assert.equal(state.context.selection,null);assert.match(state.context.project.id,/^public-library:/);assert.deepEqual(state.selection.files,[entry,companion]);assert.deepEqual(state.errors,[]);
  assert.ok(requested.includes(entry)&&requested.includes(companion));assert.equal(await page.locator('.wf-trace').count(),0);assert.equal(await page.locator('#demo-r').count(),0);assert.match(await page.locator('#studio-run').innerText(),/未关联/);assert.match(await page.locator('#studio-waveforms-content').innerText(),/尚未关联/);
  await page.evaluate(()=>window.viewer.command('plot.current'));assert.equal(await page.locator('.wf-trace').count(),0);
  await page.screenshot({path:output+'/synthetic-open.png',fullPage:true});
  await page.evaluate(()=>{const api=window.ICStudioDock.api;api.addFloatingGroup(api.getPanel('schematic'),{x:25,y:25,width:720,height:540});});
  await page.getByRole('button',{name:'放回主布局',exact:true}).click();assert.equal(await page.evaluate(()=>window.viewer.doc.path),'/'+entry);
  await page.locator('#studio-library-button').click();await manager.getByRole('button',{name:'回到 RC 参考',exact:true}).click();
  await page.waitForSelector('.wf-trace[data-trace="vout:1"]');assert.equal(await page.locator('#demo-r').inputValue(),'2000');assert.match(await page.locator('#demo-basis').innerText(),/τ = 2 ns/);assert.equal(await page.evaluate(()=>window.viewer.doc.path),'/circuitgit-demo.scs');
  await page.locator('#studio-library-button').click();await field('cell').selectOption('missing');await manager.getByRole('button',{name:'打开原理图',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cg-library-status').textContent.includes('打开失败'));
  assert.equal(await page.evaluate(()=>window.CircuitGitDemo.reference),true);assert.equal(await page.locator('.wf-trace').count(),2);
  await page.setViewportSize({width:620,height:880});await page.screenshot({path:output+'/manager-narrow.png',fullPage:true});
  const size=await manager.evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));assert.ok(size.scroll<=size.width+1);
  await manager.getByRole('button',{name:'关闭',exact:true}).click();await page.setViewportSize({width:1500,height:980});
  let real=null;
  if(process.env.LIBRARY_REAL_CELL){
    mode='real';const [libId,cellId]=process.env.LIBRARY_REAL_CELL.split('/'),manifest=JSON.parse(readFileSync(libraryRoot+'/'+realCatalog.libraries.find(l=>l.id===libId).manifest,'utf8')),cell=manifest.cells.find(c=>c.id===cellId),view=cell.views.find(v=>v.kind==='rnl');
    assert.ok(view.level,'real native view must explicitly declare its exported level');
    await page.locator('#studio-library-button').click();await manager.getByRole('button',{name:'刷新目录',exact:true}).click();await page.waitForFunction(id=>[...document.querySelector('[data-library-field="library"]').options].some(o=>o.value===id),libId);
    await field('library').selectOption(libId);await field('cell').selectOption(cellId);await field('view').selectOption(view.id);await manager.getByRole('button',{name:'打开原理图',exact:true}).click();
    await page.waitForFunction(()=>window.CircuitGitDemo.getContext().loadState==='ready'&&!window.CircuitGitDemo.reference,null,{timeout:60000});
    real=await page.evaluate(()=>({path:window.viewer.doc.path,level:window.viewer.doc.levels[window.viewer.level].title,levelIndex:window.viewer.level,drawable:window.viewer.doc.levels[window.viewer.level].empty===false&&window.viewer.doc.levels[window.viewer.level].svg.includes('<svg'),objects:window.viewer.doc.levels[window.viewer.level].hits.length,selection:window.CircuitGitDemo.getLibrarySelection(),diagnostics:window.viewer.doc.diagnostics.filter(d=>d.severity==='error')}));
    assert.equal(real.path,'/'+view.entry);if(view.level==='@top')assert.equal(real.levelIndex,0);else assert.equal(real.level,view.level);assert.equal(real.drawable,true);assert.equal(real.selection.files.length,view.files.length);assert.ok(view.files.every(path=>requested.includes(path)));assert.deepEqual(real.diagnostics,[]);assert.equal(await page.locator('.wf-trace').count(),0);
    // The preceding synthetic float/return check deliberately bypasses saved
    // drag homes. Give the real drawing an explicit inspection viewport.
    await page.evaluate(async prefix=>{const panel=window.ICStudioDock.api.getPanel('schematic');panel.api.setActive();panel.api.maximize();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));(await import(prefix+'vendor/rnl-viewer/drawing.js')).fit();},prefix);
    const drawingSize=await page.locator('#canvas').boundingBox();assert.ok(drawingSize.width>600&&drawingSize.height>300);assert.equal(await page.locator('#canvas > svg').isVisible(),true);
    await page.screenshot({path:output+'/real-native.png',fullPage:true});
    await page.evaluate(()=>window.ICStudioDock.api.getPanel('schematic').api.exitMaximized());
    await page.locator('#studio-library-button').click();await manager.getByRole('button',{name:'回到 RC 参考',exact:true}).click();await page.waitForSelector('.wf-trace[data-trace="vout:1"]');
  }
  assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);assert.deepEqual(apiRequests,[]);
  const report={status:'passed',sourceOnly:!built,builtAssets:!!built,syntheticFixturePublished:false,checks:['lazy indexed browsing','search and safe text preview','complete nested RNL closure','RC waveform and simulation isolation','Dockview float and return','RC parameter/source/reference restoration','missing closure fails before switch','narrow dialog'],real,errors,apiRequests};writeFileSync(output+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){for(const page of pages){await page.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{});console.error(JSON.stringify({error:error.message,pageErrors:errors,failures,body:(await page.locator('body').innerText().catch(()=>'' )).slice(0,12000),diagnostics:await page.evaluate(()=>window.viewer?.doc?.diagnostics?.filter(item=>['error','fatal'].includes(item.severity)).slice(0,20)).catch(()=>null)}));}throw error;}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
