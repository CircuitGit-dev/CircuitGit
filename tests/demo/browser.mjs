import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {chromium}=process.env.PLAYWRIGHT_MODULE?await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE)):await import('playwright');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),site=resolve(root,'site');
const output=resolve(root,'test-results/demo');mkdirSync(output,{recursive:true});
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
let server,url=process.env.DEMO_URL;
if(!url){server=createServer((req,res)=>{try{const path=new URL(req.url,'http://local').pathname;if(!path.startsWith('/CircuitGit/'))throw Error('prefix');const file=resolve(site,path.slice('/CircuitGit/'.length)||'index.html');if(!file.startsWith(site+'/'))throw Error('path');res.setHeader('Content-Type',types[extname(file)]||'text/plain');res.end(readFileSync(file));}catch{res.writeHead(404);res.end('Not found');}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));url='http://127.0.0.1:'+server.address().port+'/CircuitGit/';}
const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1550,height:1000},deviceScaleFactor:1});
const errors=[],failed=[],apiRequests=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failed.push([r.status(),r.url()]);});page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))apiRequests.push(r.url());});
try{
  await page.goto(url);
  try{await page.waitForFunction(()=>document.body.dataset.studioState==='ready',{timeout:35000});}catch(e){console.log(JSON.stringify({errors,failed,text:(await page.locator('body').innerText()).slice(-5000),diagnostics:await page.evaluate(()=>window.viewer?.doc?.diagnostics)}));throw e;}
  const document=await page.evaluate(()=>({errors:window.viewer.doc.diagnostics.filter(d=>d.severity==='error'),objects:window.viewer.doc.objects.map(o=>({name:o.name,kind:o.kind})),svg:!!document.querySelector('#canvas svg')}));
  assert.equal(document.errors.length,0);assert(document.svg);assert(document.objects.some(o=>o.name==='R0'));
  await page.waitForSelector('.wf-trace[data-trace="vin:1"]');await page.waitForSelector('.wf-trace[data-trace="vout:1"]');
  await page.waitForFunction(()=>document.querySelector('.wf-status')?.textContent.includes('浏览器计算'));
  await page.evaluate(()=>window.viewer.command('plot.voltage'));
  async function clickObject(kind,name){const hit=await page.evaluate(({kind,name})=>{
    const d=window.viewer.doc,l=d.levels[window.viewer.level],i=d.objects.findIndex(o=>o.kind===kind&&o.name===name&&o.level===l.host);
    const h=l.hits.find(h=>h.objects?.includes(i)&&h.points?.length>=2);if(!h)throw Error('No hit for '+name);
    const svg=document.querySelector('#canvas > svg'),p=svg.createSVGPoint();p.x=(h.points[0][0]+h.points[1][0])/2;p.y=(h.points[0][1]+h.points[1][1])/2;const q=p.matrixTransform(svg.getScreenCTM());return {x:q.x,y:q.y};},{kind,name});await page.mouse.click(hit.x,hit.y);}
  await clickObject('net','out');
  await page.waitForFunction(()=>window.CircuitGitDemo.getContext().selection?.name==='out');
  await page.evaluate(()=>window.viewer.command('plot.current'));await clickObject('instance','R0');
  await page.waitForSelector('.wf-trace[data-trace="ir:1"]');
  await page.keyboard.press('Escape');
  const chart=page.locator('.wf-plot');const box=await chart.boundingBox();assert(box.width>300&&box.height>120);
  await chart.hover();await page.mouse.wheel(0,-180);await chart.press('f');
  await page.locator('#demo-r').fill('2000');await page.locator('#demo-update').click();
  await page.waitForFunction(()=>document.querySelector('#demo-basis')?.textContent.includes('τ = 2 ns'));
  await page.locator('[data-signal-id="vin"]').evaluate(el=>el.click());await page.locator('[data-signal-id="vout"]').evaluate(el=>el.click());
  await page.waitForFunction(()=>document.querySelector('.wf-status')?.textContent.includes('浏览器计算'));
  const downloads=[];page.on('download',d=>downloads.push(d));await page.locator('#demo-export').click();
  await page.waitForTimeout(300);assert.equal(downloads.length,2);
  for(const d of downloads){const text=readFileSync(await d.path(),'utf8');if(d.suggestedFilename()==='TRAN.json')assert(Math.abs(JSON.parse(text).analysis.stop-12e-9)<1e-20);else assert(text.includes('r=2000'));}
  const groups=await page.evaluate(()=>window.ICStudioDock.api.groups.length);
  await page.locator('[aria-label="浮动当前面板"]').last().click();await page.waitForSelector('[aria-label="放回主布局"]');await page.locator('[aria-label="放回主布局"]').click();
  assert.equal(await page.evaluate(()=>window.ICStudioDock.api.groups.length),groups);
  // Restore default reference values for the public documentation screenshot.
  await page.locator('#demo-r').fill('1000');await page.locator('#demo-update').click();await page.waitForFunction(()=>document.querySelector('#demo-basis')?.textContent.includes('τ = 1 ns'));
  await page.locator('[data-signal-id="vin"]').evaluate(el=>el.click());await page.locator('[data-signal-id="vout"]').evaluate(el=>el.click());
  await page.waitForFunction(()=>document.querySelector('.wf-status')?.textContent.includes('浏览器计算'));
  await page.screenshot({path:process.env.DEMO_SCREENSHOT||output+'/workbench.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);assert.deepEqual(apiRequests,[]);
  const result={status:'passed',url,schematic:true,voltageProbe:true,currentProbe:true,referenceWaveforms:true,configurationExport:true,floatAndReturn:true,errors,failed,apiRequests};
  writeFileSync(output+'/acceptance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();server?.close();}
