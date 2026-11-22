// Built web + existing read-only gateway data. AI responses are explicit UI fixtures.
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const webRoot=resolve(process.env.IC_WEB_ROOT||root+'/web');
const upstream=new URL(process.env.IC_GATEWAY_URL||'http://127.0.0.1:8766');
assert.equal(upstream.hostname,'127.0.0.1');
const output=resolve(process.env.EVIDENCE_DIR||root+'/test-results/dockview-menu-focus');await mkdir(output,{recursive:true});
const report={kind:'built source with real saved data; AI UI fixtures only',checks:[],errors:[],productionPosts:0,modelTurns:0,waveformReads:[]};
const mime={'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png'};
let origin,browser;
function json(res,data){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,data}));}
const server=createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://local');
  if(req.method!=='GET'){report.productionPosts++;res.writeHead(405);res.end('Read-only validation');return;}
  if(u.pathname.startsWith('/api/ai/')){
   if(u.pathname.endsWith('/sessions'))return json(res,{sessions:[{session_id:'default',name:'界面预览 · 未连接模型',state:'idle',pending_approval_count:0,suspended_approval_count:0}],max_sessions:8});
   if(u.pathname.endsWith('/history'))return json(res,{session_id:'default',messages:[],turns:[],cursor:0,state:'idle',pending:[]});
   if(u.pathname.endsWith('/events'))return json(res,{events:[],cursor:0,state:'idle',pending:[]});
   if(u.pathname.endsWith('/models'))return json(res,{models:[],default_model:null,inference_verified:false});
   res.writeHead(404);res.end();return;
  }
  if(u.pathname.startsWith('/api/')){
   // Only known local read endpoints. Never proxy live status/collect/publish/model actions.
   assert(/^\/api\/(health|project|jobs|tree|file|schematic|configuration|supervision)$/.test(u.pathname)||
          /^\/api\/version-control(?:\/commit)?$/.test(u.pathname)||
          /^\/api\/geometry\/(file|viewer-manifest)$/.test(u.pathname)||
          /^\/api\/jobs\/[A-Za-z0-9_-]+\/(signals|waveform-map|waveform|results)$/.test(u.pathname));
   const remote=request(new URL(req.url,upstream),{method:'GET',headers:{Host:upstream.host}},r=>{
    const chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>{
     let bytes=Buffer.concat(chunks);const type=r.headers['content-type']||'application/octet-stream';
     if(type.includes('json'))bytes=Buffer.from(bytes.toString().split(upstream.origin).join(origin));
     res.writeHead(r.statusCode,{'Content-Type':type,'Cache-Control':'no-store'});res.end(bytes);
     if(u.pathname.endsWith('/waveform'))report.waveformReads.push(r.statusCode);
    });
   });remote.on('error',e=>{res.writeHead(502);res.end(e.message);});remote.end();return;
  }
  const path=resolve(webRoot,'.'+(u.pathname==='/'?'/index.html':decodeURIComponent(u.pathname)));
  assert(path.startsWith(webRoot+sep));const bytes=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
 }catch(e){res.writeHead(404);res.end(e.message);}
});

try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1550,height:1050}});
 page.on('pageerror',error=>report.errors.push(error.message));
 await page.goto(origin+'/vendor/rnl-viewer/index.html?studio=1&native=1&layout=dockview');
 await page.waitForFunction(()=>window.ICStudioDock&&document.querySelector('.wf-plot')&&document.querySelector('[data-field=configuration]'));
 await page.waitForFunction(()=>window.ICWorkbenchContext?.getContext().loadState==='ready'&&!document.body.classList.contains('studio-native-loading'),null,{timeout:45000});
 const run='20261109T054442Z-1d9279ef0b-014b97a6';
 await page.locator('#studio-run').selectOption(run);
 await page.locator('[data-field=page-jobs]').click();
 await page.locator('.ic-sim-job').getByRole('button',{name:'查看结果',exact:true}).click();
 const card=page.getByRole('region',{name:'SpiceOwl 保存的仿真监督记录',exact:true});
 await card.getByRole('button',{name:'查看保存波形',exact:true}).click();
 await page.locator('.wf-plot').focus();await page.keyboard.press('o');
 await page.waitForFunction(()=>document.querySelector('.wf-run-picker')?.options.length>0);
 await page.locator('.wf-run-picker').selectOption(run);
 await page.getByRole('dialog',{name:'打开已有运行',exact:true}).getByRole('button',{name:'打开',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.wf-trace').length===6&&document.querySelectorAll('.wf-cursors tr').length===7&&document.querySelector('.wf-status')?.textContent==='已加载真实运行数据。',null,{timeout:45000});
 await page.locator('.wf-plot').focus();await page.keyboard.press('l');
 await page.getByRole('dialog',{name:'添加信号',exact:true}).waitFor();
 await page.getByRole('dialog',{name:'添加信号',exact:true}).getByRole('button',{name:'关闭添加信号',exact:true}).click();
 await page.getByRole('dialog',{name:'添加信号',exact:true}).waitFor({state:'hidden'});
 await page.screenshot({path:output+'/waveforms-loaded.png'});
 await page.evaluate(()=>{
  window.focusEvents=[];
  const original=HTMLElement.prototype.focus;
  HTMLElement.prototype.focus=function(...args){focusEvents.push({type:'focus-call',target:this.className||this.id,stack:new Error().stack});return original.apply(this,args);};
  for(const type of ['focusin','focusout'])document.addEventListener(type,event=>focusEvents.push({type,target:event.target.className||event.target.id}),true);
  ICStudioDock.api.onDidActivePanelChange(panel=>focusEvents.push({type:'active-panel',id:panel?.id}));
  window.originalWave=document.querySelector('.wf-plot');window.originalSimulation=document.querySelector('.ic-sim-panel');
 });
 await page.locator('.wf-plot').focus();
 await page.evaluate(()=>ICStudioDock.api.getPanel('simulation').api.close());
 await page.waitForFunction(()=>!ICRNLStudio.slots.simulation.isVisible());
 await page.locator('#menubar .menu-title').filter({hasText:'Window'}).click();
 await page.locator('#menubar [data-id="window.simulation"]').click();
 await page.waitForTimeout(250);
 report.observation=await page.evaluate(()=>({active:ICStudioDock.api.activePanel?.id,simulationVisible:ICStudioDock.api.getPanel('simulation')?.api.isVisible,focused:document.activeElement.className,events:focusEvents}));
 assert.equal(report.observation.simulationVisible,true,'Window command must leave the opened simulation visible');
 assert.equal(report.observation.active,'simulation');
 assert.equal(await page.evaluate(()=>document.querySelector('.wf-plot')===originalWave&&document.querySelector('.ic-sim-panel')===originalSimulation),true);
 report.checks.push('Top Window menu opens the simulation from a focused waveform and preserves its active tab');
 // The same command must activate an existing hidden tab, not only a newly created panel.
 await page.evaluate(()=>ICStudioDock.open('waveforms'));await page.locator('.wf-plot').focus();
 await page.locator('#menubar .menu-title').filter({hasText:'Window'}).click();
 await page.locator('#menubar [data-id="window.simulation"]').hover();await page.keyboard.press('Enter');
 await page.waitForTimeout(750);
 assert.equal(await page.evaluate(()=>ICStudioDock.api.activePanel?.id),'simulation');
 assert.equal(await page.locator('.ic-sim-panel').isVisible(),true);
 report.checks.push('Keyboard command activates the existing simulation tab in the waveform group');
 // Esc cancels the menu without moving focus away from the active waveform.
 await page.evaluate(()=>ICStudioDock.open('waveforms'));await page.locator('.wf-plot').focus();
 await page.locator('#menubar .menu-title').filter({hasText:'Window'}).click();await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>document.activeElement===originalWave&&ICStudioDock.api.activePanel?.id==='waveforms'),true);
 report.checks.push('Cancelling Window retains waveform focus and selection');
 for(let attempt=0;attempt<3;attempt++){
  await page.evaluate(()=>{ICStudioDock.open('waveforms');ICStudioDock.api.getPanel('simulation').api.close();});
  await page.locator('.wf-plot').focus();
  await page.locator('#menubar .menu-title').filter({hasText:'Window'}).click();
  await page.locator('#menubar [data-id="window.simulation"]').click();
  await page.waitForTimeout(750);
  assert.equal(await page.evaluate(()=>ICStudioDock.api.activePanel?.id),'simulation');
  assert.equal(await page.locator('.ic-sim-panel').isVisible(),true);
 }
 assert.equal(await page.evaluate(()=>document.querySelector('.wf-plot')===originalWave&&document.querySelector('.ic-sim-panel')===originalSimulation),true);
 assert.equal(await page.locator('.wf-trace').count(),6);
 report.checks.push('Three close/reopen rounds preserve simulation DOM, waveform canvas and all six traces');
 report.finalFocus=await page.evaluate(()=>({active:ICStudioDock.api.activePanel?.id,visible:ICRNLStudio.slots.simulation.isVisible()}));

 assert.deepEqual(report.errors,[]);assert.equal(report.productionPosts,0);
 report.status='passed';
 await page.screenshot({path:output+'/window-menu.png',fullPage:true});
} catch(error) {report.status='failed';report.failure=error.stack;process.exitCode=1;}
finally {await writeFile(output+'/report.json',JSON.stringify(report,null,2));await browser?.close();await new Promise(r=>server.close(r));console.log(JSON.stringify(report,null,2));}
