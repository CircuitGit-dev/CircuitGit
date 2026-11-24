// Real RNL and Dockview over static files. Delayed components are controlled by this test;
// no model, simulation, circuit write or live gateway call is issued.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),site=resolve(root,'site'),output=resolve(root,'test-results/startup');await mkdir(output,{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://test');assert(url.pathname.startsWith('/CircuitGit/'));const path=resolve(site,url.pathname.slice('/CircuitGit/'.length)||'index.html');assert(path.startsWith(site+'/'));const bytes=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,prefix=origin+'/CircuitGit/';
const browser=await chromium.launch({headless:true,channel:'chrome'}),report={checks:[],errors:[],requests:[],api:[]};
let releaseRenderer,releaseOptional;
const rendererGate=new Promise(r=>releaseRenderer=r),optionalGate=new Promise(r=>releaseOptional=r);
try{
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'}),page=await context.newPage();
  page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{const path=new URL(r.url()).pathname;report.requests.push(path);if(path.includes('/api/'))report.api.push(path);});
  await page.addInitScript(()=>{window.startupFrames=[];const observe=()=>{if(document.querySelector('#sidebar')&&getComputedStyle(document.getElementById('app')).visibility==='visible'&&!window.ICStudioDock&&!document.body.classList.contains('starting'))startupFrames.push('viewer-before-host');if(document.body?.dataset.workbenchState!=='ready')requestAnimationFrame(observe);};requestAnimationFrame(observe);});
  await page.route('**/studio/schematic.js',async route=>{await rendererGate;await route.continue();});
  await page.route(/\/(remote\/panel|studio\/dockview\/waveforms)\.js$/,async route=>{await optionalGate;await route.continue();});
  await page.goto(prefix+'studio/index.html?demo=1&layout=dockview',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.ICStudioDock&&document.body.dataset.workbenchState==='layout-ready');
  assert.equal(await page.locator('#sidebar').isVisible(),false);assert.equal(await page.locator('#startup').count(),0);
  assert.equal(await page.evaluate(()=>ICStudioDock.api.totalPanels),4);
  await page.getByRole('button',{name:'浮动当前面板',exact:true}).last().click();await page.getByRole('button',{name:'放回主布局',exact:true}).click();
  await page.screenshot({path:output+'/layout-before-renderer.png'});
  report.checks.push('restored final Dockview layout is interactive while schematic import is blocked');
  releaseRenderer();await page.waitForFunction(()=>document.body.dataset.workbenchState==='ready',null,{timeout:30000});
  assert.equal(await page.locator('#canvas>svg').isVisible(),true);assert.equal(await page.locator('.wf-plot').count(),0);assert.equal(await page.locator('.cg-node-welcome').count(),0);
  assert(!report.requests.some(p=>/\/vendor\/rnl-viewer\/(main|startup|preload)\.js$/.test(p)));
  assert.deepEqual(await page.evaluate(()=>startupFrames),[]);
  report.checks.push('schematic completes without waiting for AI/waveforms; standalone RNL startup is never executed');
  releaseOptional();await page.locator('.cg-node-welcome').waitFor({state:'attached'});await page.locator('.wf-trace[data-trace="vout:1"]').waitFor();
  await page.locator('.studio-panel-simulation [data-agent-assistance="environment"]').click();
  await page.locator('.studio-panel-ai .ic-ai-assistance-pending:not([hidden])').waitFor();
  assert.match(await page.locator('.studio-panel-ai .ic-ai-assistance-pending').innerText(),/尚未连接/);
  assert.match(await page.locator('.studio-panel-ai .ic-ai-assistance-pending pre').textContent(),/ic\.simulation\.agent-assistance\.v1/);
  assert.equal(await page.locator('.cg-remote').count(),1);
  report.checks.push('built simulation assistance opens the existing offline AI panel with a retained draft and no connection request');
  await page.evaluate(()=>{for(const id of ['ai','simulation','waveforms'])ICStudioDock.api.getPanel(id).api.close();});
  await page.waitForTimeout(250);report.requests=[];
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.body.dataset.workbenchState==='ready');
  assert.equal(await page.evaluate(()=>ICStudioDock.api.totalPanels),1);
  assert(!report.requests.some(p=>/\/(remote\/panel|library\/versions|studio\/ai\/index|studio\/dockview\/waveforms|modules\/waveforms\/panel)\.js$/.test(p)),JSON.stringify(report.requests));
  report.checks.push('saved closed panels stay closed and do not import AI, versions or waveform components');
  await page.evaluate(()=>window.viewer.command('plot.voltage'));await page.locator('.wf-plot').waitFor();await page.keyboard.press('Escape');
  await page.evaluate(()=>ICStudioDock.open('ai'));await page.locator('.cg-node-welcome').waitFor({state:'attached'});
  await page.evaluate(()=>window.viewer.command('git.history'));await page.waitForFunction(()=>!!document.querySelector('.cg-cell-versions'));
  report.checks.push('probe and history commands reopen lazy panels; AI becomes available on demand');
  await page.evaluate(()=>ICStudioDock.reset());await page.waitForTimeout(250);
  // A restored inactive tab may have a detached Dockview container. Its owned DOM
  // must stay connected while startup and asynchronous callbacks resolve controls.
  await page.evaluate(()=>{const api=ICStudioDock.api;api.getPanel('simulation').api.moveTo({group:api.getPanel('ai').group,position:'center'});api.getPanel('ai').api.setActive();});
  await page.waitForTimeout(250);await page.reload();await page.waitForFunction(()=>document.body.dataset.workbenchState==='ready');
  assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('simulation').api.isVisible),false);
  assert.equal(await page.evaluate(()=>document.getElementById('demo-update')?.isConnected),true);
  await page.evaluate(()=>ICStudioDock.open('simulation'));await page.locator('[data-field="page-reference"]').click();await page.locator('#demo-r').fill('2400');await page.locator('#demo-update').click();
  await page.waitForFunction(()=>document.getElementById('demo-basis').textContent.includes('τ = 2.4 ns'));
  report.checks.push('inactive simulation tab restores without missing onclick controls; editing still rebuilds the circuit');
  await page.evaluate(()=>{ICStudioDock.reset();const api=ICStudioDock.api;api.getPanel('schematic').api.moveTo({group:api.getPanel('waveforms').group,position:'center'});api.getPanel('waveforms').api.setActive();});
  await page.waitForTimeout(250);await page.reload();await page.waitForFunction(()=>document.body.dataset.workbenchState==='ready');
  assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('schematic').api.isVisible),false);
  assert.equal(await page.evaluate(()=>window.viewer.doc.path),'/circuitgit-demo.scs');
  await page.evaluate(()=>ICStudioDock.open('schematic'));await page.locator('#canvas>svg').waitFor();
  assert.equal(await page.evaluate(()=>document.querySelectorAll('#app').length),1);
  report.checks.push('inactive schematic retains its DOM identity and opens normally after startup');
  // Slow imports can finish while their tab becomes inactive. They must mount once,
  // remain reachable and reappear inside the correct panel rather than below the grid.
  await page.evaluate(()=>ICStudioDock.reset());await page.waitForTimeout(250);
  let releaseDelayedAI;const delayedAI=new Promise(resolve=>releaseDelayedAI=resolve);
  await page.route('**/remote/panel.js',async route=>{await delayedAI;await route.continue();});
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.body.dataset.workbenchState==='ready');
  await page.evaluate(()=>{const api=ICStudioDock.api;api.getPanel('ai').api.moveTo({group:api.getPanel('simulation').group,position:'center'});api.getPanel('simulation').api.setActive();});
  releaseDelayedAI();await page.locator('.cg-node-welcome').waitFor({state:'attached'});
  await page.evaluate(()=>ICStudioDock.open('ai'));await page.locator('.studio-panel-ai .cg-remote').waitFor();
  assert.equal(await page.locator('.cg-remote').count(),1);
  report.checks.push('AI import completing behind another tab stays inside its own panel and reopens once');
  await page.unroute('**/remote/panel.js');await page.evaluate(()=>ICStudioDock.reset());await page.waitForTimeout(250);
  // A saved old URL goes straight to the host, retaining demo/query/hash intent.
  report.requests=[];
  await page.goto(prefix+'vendor/rnl-viewer/index.html?studio=1&layout=dockview&demo=1#kept');await page.waitForFunction(()=>document.body.dataset.workbenchState==='ready');
  assert(new URL(page.url()).pathname.endsWith('/studio/index.html'));assert.equal(new URL(page.url()).hash,'#kept');
  assert(!report.requests.some(p=>/\/vendor\/rnl-viewer\/(main|startup|preload)\.js$/.test(p)));
  report.checks.push('old viewer Studio bookmarks retain query/hash without preloading the standalone renderer startup');
  await page.screenshot({path:output+'/workbench-ready.png'});
  const popupReady=page.waitForEvent('popup');
  await page.evaluate(()=>window.viewer.command('new-window'));
  const popup=await popupReady;await popup.waitForFunction(()=>window.viewer?.doc?.path==='/circuitgit-demo.scs',null,{timeout:30000});
  assert(new URL(popup.url()).pathname.endsWith('/vendor/rnl-viewer/index.html'));assert.equal(await popup.evaluate(()=>!!window.ICStudioDock),false);await popup.close();
  report.checks.push('detached RNL window retains the exact document handoff without starting another workbench');
  // Renderer failure remains a panel-local error, never an inaccessible blank workbench.
  await page.route('**/studio/schematic.js',route=>route.abort());
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.body.dataset.workbenchState==='error');
  await page.getByRole('button',{name:'重新加载',exact:true}).waitFor();assert.equal(await page.evaluate(()=>ICStudioDock.api.totalPanels),4);
  await page.getByRole('button',{name:'浮动当前面板',exact:true}).last().click();await page.getByRole('button',{name:'放回主布局',exact:true}).click();
  report.checks.push('failed renderer import leaves window management and an explicit retry available');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.api,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;throw error;}
finally{releaseRenderer();releaseOptional();await writeFile(output+'/report.json',JSON.stringify(report,null,2));await browser.close();await new Promise(r=>server.close(r));console.log(JSON.stringify(report));}
