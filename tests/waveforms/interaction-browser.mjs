// Delayed, deterministic data exercises the shared renderer without a gateway or solver.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const output=resolve(root,'test-results/waveform-interaction');await mkdir(output,{recursive:true});
const report={scope:'shared panel with delayed synthetic data; no engineering reads or writes',checks:[],errors:[]};
let browser;
const server=createServer(async(req,res)=>{try{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><style>.wf-plot{display:block;width:900px;height:320px}.wf-list{max-height:50px;overflow:auto}</style><main></main>');return;}
  assert(req.url.startsWith('/modules/waveforms/')||req.url==='/modules/simulation/environment/spectrum.js');
  const path=resolve(root,'.'+req.url);assert(path.startsWith(root+sep));
  res.setHeader('Content-Type','text/javascript');res.end(await readFile(path));
}catch(error){res.writeHead(404);res.end(error.message);}});
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage({viewport:{width:1200,height:1000}});page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async()=>{
    const {mountWaveformPanel}=await import('/modules/waveforms/panel.js');
    const {displayEnvelope}=await import('/modules/waveforms/rendering.js');
    const points=Array.from({length:100001},(_,i)=>[i/1000,Math.sin(i/80)]);points[47777][1]=10;points[47778][1]=-9;
    const signal={id:'vin',label:'VIN',psf_name:'/VIN',unit:'V',quantity:'voltage',analysis:'tran',status:'available',domain:[0,100]};
    window.fixture={delay:120,active:0,maxActive:0,requests:[],responses:[],paints:[],fail:false,held:false};
    const f=fixture,proto=CanvasRenderingContext2D.prototype,fill=proto.fillRect,stroke=proto.stroke;
    proto.fillRect=function(...args){if(this.canvas.matches('.wf-plot')&&args[0]===0&&args[1]===0){f.paints.push({curves:0,at:performance.now(),held:f.held});}return fill.apply(this,args);};
    proto.stroke=function(...args){if(this.canvas.matches('.wf-plot')&&this.strokeStyle==='#58d5ee'&&f.paints.length)f.paints.at(-1).curves++;return stroke.apply(this,args);};
    const api={
      jobs:async()=>({jobs:[]}),mapping:async run=>({status:'unmapped',run_id:run}),
      catalog:async run=>({run_id:run,source_commit:'test',csv_sha256:'test',signals:[signal]}),
      waveform:async(run,id,params)=>{
        const call={run,...params,at:performance.now()};f.requests.push(call);f.active++;f.maxActive=Math.max(f.maxActive,f.active);
        const fail=f.fail;await new Promise(r=>setTimeout(r,f.delay));f.active--;
        // Intentionally ignore abort to test stale-response rejection in the panel itself.
        if(fail)throw Error('delayed fixture failure');
        f.responses.push({...call,at:performance.now(),held:f.held});
        return {run_id:run,points:displayEnvelope(points,params.start,params.end,params.limit/2),display:{returned_points:params.limit,input_points:points.length},
          measurement:{basis:'PSFXL_native_samples',cursors:{a:{x:params.cursor_a,y:params.cursor_a},b:{x:params.cursor_b,y:params.cursor_b}},delta:{dt:params.cursor_b-params.cursor_a,dy:params.cursor_b-params.cursor_a}}};
      }
    };
    window.panel=mountWaveformPanel(document.querySelector('main'),{api,followSelection:false,contextAdapter:{getContext:()=>({}),subscribe:()=>()=>{}}});
    await panel.setRun('a');document.querySelector('[data-action=add-all]').click();
  });
  const loaded=()=>page.waitForFunction(()=>panel.snapshot().signals.length===1&&panel.snapshot().signals.every(s=>s.loaded));
  const settled=()=>page.waitForFunction(()=>fixture.active===0);
  const range=async(a,b)=>{await page.locator('.wf-start').fill(String(a));await page.locator('.wf-end').fill(String(b));await page.locator('[data-action=window]').click();await loaded();};
  await loaded();await range(35,65);await page.waitForTimeout(50);
  await page.evaluate(()=>{fixture.requests=[];fixture.responses=[];fixture.paints=[];fixture.maxActive=0;fixture.held=true;});
  const box=await page.locator('.wf-plot').boundingBox();const x=box.x+450,y=box.y+140;
  await page.mouse.move(x,y);await page.mouse.down();
  for(let i=0;i<24;i++){await page.mouse.move(x+i*4,y);await page.waitForTimeout(40);}
  const during=await page.evaluate(()=>({requests:fixture.requests,responses:fixture.responses,paints:fixture.paints,snapshot:panel.snapshot(),maxActive:fixture.maxActive}));
  assert(during.responses.filter(r=>r.held).length>=3,'data must refresh repeatedly before pointer release');
  assert(during.requests.length<=8,'continuous motion must be rate limited');
  assert.equal(during.maxActive,1,'do not stack window reads');
  assert(during.paints.length>=15,'render movement before data reads finish');
  assert(during.paints.every(p=>p.curves>0),'keep curves in every painted frame');
  assert(during.snapshot.signals.every(s=>!s.loaded),'preview is not a settled measurement');
  await page.evaluate(()=>fixture.held=false);await page.mouse.up();await loaded();await settled();
  const after=await page.evaluate(()=>({last:fixture.requests.at(-1),snapshot:panel.snapshot(),rows:document.querySelectorAll('.wf-cursors tr').length}));
  assert.deepEqual([after.last.start,after.last.end],after.snapshot.window);assert.equal(after.rows,2);
  report.liveDrag={paintedFrames:during.paints.length,dataUpdatesWhileHeld:during.responses.length,windowReads:during.requests.length,maxConcurrent:during.maxActive};
  report.checks.push('continuous throttled reads while held; all frames retain curves; final window measurement after release');

  await page.evaluate(()=>{fixture.delay=450;fixture.requests=[];fixture.paints=[];});
  await page.locator('.wf-plot').evaluate(el=>{for(let i=0;i<60;i++)el.dispatchEvent(new WheelEvent('wheel',{deltaY:i%2?100:-100,bubbles:true,cancelable:true}));});
  await page.waitForFunction(()=>fixture.active===1);await page.waitForTimeout(50);
  assert.equal(await page.locator('.wf-cursors tr').count(),1,'stale measurement is withheld while reading');
  assert(await page.evaluate(()=>fixture.paints.length>0&&fixture.paints.every(p=>p.curves>0)));
  await loaded();await settled();assert((await page.evaluate(()=>fixture.requests.length))<=2);
  report.checks.push('slow wheel reads keep painted curves; a 60-event burst is coalesced without stale cursor results');

  // Exact queries still go through the adapter so its revision/measurement context stays authoritative.
  const measure=async(a,b)=>{await page.locator('.wf-a').fill(String(a));await page.locator('.wf-b').fill(String(b));await page.locator('[data-action=measure]').click();await loaded();await settled();};
  await page.evaluate(()=>fixture.delay=20);await measure(40,45);await measure(41,46);
  const n=await page.evaluate(()=>fixture.requests.length);await measure(40,45);
  assert.equal(await page.evaluate(()=>fixture.requests.length),n+1);assert.equal(await page.evaluate(()=>fixture.requests.at(-1).cursor_a),40);
  report.checks.push('returning to a cursor/window revalidates through the adapter rather than bypassing its context');

  await range(110,130);await page.evaluate(()=>{fixture.delay=300;fixture.paints=[];document.querySelector('.wf-start').value=35;document.querySelector('.wf-end').value=65;document.querySelector('[data-action=window]').click();});
  await page.waitForTimeout(50);assert(await page.evaluate(()=>fixture.paints.length>0&&fixture.paints.every(p=>p.curves>0)));await loaded();
  report.checks.push('returning from an empty time window immediately reuses the full-range overview');

  await page.evaluate(()=>{fixture.fail=true;fixture.paints=[];});await page.locator('[data-action=fit]').click();
  await page.waitForFunction(()=>document.querySelector('.wf-status').textContent.includes('读取失败'));await page.waitForTimeout(50);
  assert(await page.evaluate(()=>fixture.paints.every(p=>p.curves>0)));assert.equal(await page.locator('.wf-cursors tr').count(),1);
  await page.evaluate(()=>fixture.fail=false);await page.locator('[data-action=fit]').click();await loaded();
  report.checks.push('a read error preserves the previous curve and does not publish old measurements');

  await page.evaluate(()=>fixture.delay=300);await page.locator('[data-action=fit]').click();await page.waitForFunction(()=>fixture.active===1);
  await page.evaluate(async()=>{await panel.setRun('b');document.querySelector('[data-action=add-all]').click();});
  await loaded();await settled();assert.equal(await page.evaluate(()=>panel.snapshot().runId),'b');assert.equal(await page.evaluate(()=>fixture.requests.at(-1).run),'b');
  report.checks.push('switching runs during a read rejects late old-run responses and finishes the new run');

  await page.locator('[data-action=fit]').click();await page.waitForFunction(()=>fixture.active===1);
  await page.locator('.wf-plot').evaluate(el=>el.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true,cancelable:true})));
  const beforeCancel=await page.evaluate(()=>fixture.requests.length);await page.locator('[data-action=cancel]').click();await settled();await page.waitForTimeout(220);
  assert.equal(await page.evaluate(()=>fixture.requests.length),beforeCancel);assert(await page.evaluate(()=>panel.snapshot().signals.every(s=>!s.loaded)));
  report.checks.push('explicit cancel drops the queued refresh even when an adapter returns after abort');
  await page.locator('[data-action=fit]').click();await loaded();
  await page.locator('[data-action=fit]').click();await page.waitForFunction(()=>fixture.active===1);await page.evaluate(()=>panel.destroy());
  await settled();await page.waitForTimeout(220);assert.equal(await page.locator('main').innerHTML(),'');assert.deepEqual(report.errors,[]);
  report.checks.push('destroy ignores late reads and removes the panel without scheduling more work');report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;throw error;}
finally{await writeFile(output+'/report.json',JSON.stringify(report,null,2));await browser?.close();await new Promise(r=>server.close(r));console.log(JSON.stringify(report));}
