// Built web + existing read-only gateway data. AI responses are explicit UI fixtures.
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const upstream=new URL(process.env.IC_GATEWAY_URL||'http://127.0.0.1:8766');
assert.equal(upstream.hostname,'127.0.0.1');
const output=resolve(process.env.EVIDENCE_DIR||root+'/test-results/waveform-performance');await mkdir(output,{recursive:true});
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
   assert(/^\/api\/(health|project|jobs|tree|file|schematic|configuration)$/.test(u.pathname)||
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
  const path=resolve(root+'/web','.'+(u.pathname==='/'?'/index.html':decodeURIComponent(u.pathname)));
  assert(path.startsWith(root+'/web'+sep));const bytes=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
 }catch(e){res.writeHead(404);res.end(e.message);}
});


try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1600,height:1050}});page.on('pageerror',e=>report.errors.push(e.message));
 const requests=[];page.on('request',r=>{if(r.url().includes('/waveform?'))requests.push(r.url());});
 await page.addInitScript(()=>{
  window.wfPerf={frames:0,resizes:0,allocations:0,paints:0,pointers:0,lines:0,gaps:[],longTasks:[],curveFrames:[]};let last=0;
  const frame=t=>{if(last)wfPerf.gaps.push(t-last);last=t;wfPerf.frames++;requestAnimationFrame(frame);};requestAnimationFrame(frame);
  window.addEventListener('resize',()=>wfPerf.resizes++);
  document.addEventListener('pointermove',e=>{if(e.target.matches('.wf-plot'))wfPerf.pointers++;},true);
  for(const key of ['width','height']){const d=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);Object.defineProperty(HTMLCanvasElement.prototype,key,{...d,set(v){if(this.matches('.wf-plot'))wfPerf.allocations++;d.set.call(this,v);}});}
  for(const key of ['fillRect','lineTo','stroke']){const fn=CanvasRenderingContext2D.prototype[key];CanvasRenderingContext2D.prototype[key]=function(...args){if(this.canvas.matches('.wf-plot')){if(key==='fillRect'){wfPerf.paints++;if(args[0]===0&&args[1]===0)wfPerf.curveFrames.push(0);}else if(key==='lineTo')wfPerf.lines++;else if(['#58d5ee','#ffbd68','#ca99ff','#6ed8a7','#ff819e','#b6cf62'].includes(this.strokeStyle)&&wfPerf.curveFrames.length)wfPerf.curveFrames[wfPerf.curveFrames.length-1]++;}return fn.apply(this,args);};}
  new PerformanceObserver(list=>{for(const entry of list.getEntries())wfPerf.longTasks.push(entry.duration);}).observe({type:'longtask'});
  window.resetPerf=()=>{for(const key of Object.keys(wfPerf))wfPerf[key]=Array.isArray(wfPerf[key])?[]:0;};
 });
 await page.goto(origin+'/studio/dockview/index.html');await page.waitForFunction(()=>window.ICRNLStudio&&document.querySelector('#canvas>svg'),null,{timeout:60000});
 await page.locator('.wf-plot').focus();await page.keyboard.press('o');await page.waitForFunction(()=>document.querySelector('.wf-run-picker option'));
 await page.locator('.wf-run-picker').selectOption('20261109T054442Z-1d9279ef0b-014b97a6');await page.getByRole('dialog',{name:'打开已有运行',exact:true}).getByRole('button',{name:'打开',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.wf-cursors tr').length===7,null,{timeout:45000});
 report.display=await page.locator('.wf-data-note').textContent();
 const measure=async(name,fn)=>{await page.evaluate(()=>resetPerf());const start=requests.length,t=Date.now();await fn();const m=await page.evaluate(()=>wfPerf);report[name]={...m,elapsed:Date.now()-t,requests:requests.length-start};};
 await measure('idle',()=>page.waitForTimeout(500));
 const box=await page.locator('.wf-plot').boundingBox();
 await measure('pan',async()=>{await page.mouse.move(box.x+400,box.y+90);await page.mouse.down();await page.mouse.move(box.x+500,box.y+90,{steps:80});await page.mouse.up();await page.waitForFunction(()=>document.querySelector('.wf-status').textContent==='已加载真实运行数据。');});
 await measure('wheelBurst',async()=>{await page.locator('.wf-plot').evaluate(el=>{for(let i=0;i<20;i++)el.dispatchEvent(new WheelEvent('wheel',{deltaY:i%2?100:-100,clientX:400,clientY:200,bubbles:true,cancelable:true}));});await page.waitForFunction(()=>document.querySelector('.wf-status').textContent==='已加载真实运行数据。');});
 await measure('resizeBurst',async()=>{await page.evaluate(()=>{const p=ICStudioDock.api.getPanel('waveforms');for(let i=0;i<40;i++)p.api.setSize({height:230+i});});await page.waitForTimeout(500);});
 assert.equal(report.pan.allocations,0);assert(report.pan.paints>=20);assert(report.pan.curveFrames.every(n=>n===6),'pan must retain all six curves in every frame');
 assert.equal(report.wheelBurst.allocations,0);assert(report.wheelBurst.requests<=12,'wheel burst must merge into at most two batches');assert(report.wheelBurst.curveFrames.every(n=>n===6));
 assert(report.resizeBurst.resizes<=2,'panel sizing must not flood the schematic with global resize events');
 assert.deepEqual(report.errors,[]);assert.equal(report.productionPosts,0);
 report.checks.push('pan keeps all six real curves with zero canvas reallocations','wheel burst merges reads and keeps all six curves','layout resizing coalesces schematic notifications');
 report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;throw e;}
finally{await writeFile(output+'/performance.json',JSON.stringify(report,null,2));await browser?.close();await new Promise(r=>server.close(r));const compact={...report};for(const k of ['idle','pan','wheelBurst','resizeBurst'])if(compact[k]){const m=compact[k],g=m.gaps;compact[k]={...m,gaps:undefined,maxFrameGap:Math.max(...g),p95FrameGap:g.sort((a,b)=>a-b)[Math.floor(g.length*.95)]};}console.log(JSON.stringify(compact));}
