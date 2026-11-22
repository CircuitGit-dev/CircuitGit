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
const output=resolve(process.env.EVIDENCE_DIR||root+'/test-results/structure-browser');await mkdir(output,{recursive:true});
const report={kind:'built source with real saved data; AI UI fixtures only',checks:[],errors:[],productionPosts:0,modelTurns:0,waveformReads:[]};
const mime={'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png'};
let origin,browser;
function json(res,data){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,data}));}
const server=createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://local');
  if(req.method!=='GET'){res.writeHead(405);res.end('Read-only validation');return;}
  if(u.pathname.startsWith('/api/ai/')){
   if(u.pathname.endsWith('/sessions'))return json(res,{sessions:[{session_id:'default',name:'验证会话（未调用模型）',state:'idle',pending_approval_count:0,suspended_approval_count:0}],max_sessions:8});
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
  assert(path.startsWith(root+'/web'+sep));const bytes=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'});res.end(bytes);
 }catch(e){res.writeHead(404);res.end(e.message);}
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,channel:'chrome',ignoreDefaultArgs:['--disable-popup-blocking']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 context.on('page',p=>p.on('pageerror',e=>report.errors.push(e.message)));page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(origin+'/');
 await page.waitForFunction(()=>window.ICWorkbenchContext?.getContext().geometry?.sourceMatch&&!document.body.classList.contains('studio-native-loading'));
 assert((await page.locator('#studio-entry option').count())>20);
 await page.locator('[data-field=configuration]').waitFor();await page.locator('.ic-ai-form textarea').waitFor();
 report.checks.push('legacy root redirect loads native RNL, configuration panel and AI adapter from built assets');
 const clickMenu=async(label,id)=>{await page.bringToFront();await page.locator('#menubar .menu-title').filter({hasText:label}).click();await page.locator('[data-id="'+id+'"]').click();};
 await clickMenu(/Help/,'help.workbench');const help=page.getByRole('dialog',{name:'IC on GitHub · 功能与用法'});assert.equal(await help.locator('h3').count(),6);await page.keyboard.press('Escape');
 report.checks.push('Help guide retained after relocation');
 const rid=process.env.IC_TEST_RUN||'20261109T054442Z-1d9279ef0b-014b97a6';await page.locator('#studio-run').selectOption(rid);
 const waitPopup=page.waitForEvent('popup');await clickMenu(/^Plot$/,'plot.voltage');const popup=await waitPopup;
 await popup.locator('.wf-list button').first().waitFor();await page.bringToFront();
 const target=await page.evaluate(async()=>{
  const s=await import('/vendor/rnl-viewer/state.js'),level=s.doc.levels[s.current];
  const index=s.doc.objects.findIndex(o=>o.kind==='net'&&o.name==='VINP'&&o.level===level.host);
  const hits=level.hits.filter(h=>h.objects.includes(index)),h=hits.find(h=>h.kind==='label')||hits[0];
  const svg=document.querySelector('#canvas>svg'),p=svg.createSVGPoint();p.x=(Math.min(...h.points.map(p=>p[0]))+Math.max(...h.points.map(p=>p[0])))/2;p.y=(Math.min(...h.points.map(p=>p[1]))+Math.max(...h.points.map(p=>p[1])))/2;
  const point=p.matrixTransform(svg.getScreenCTM());return {index,x:point.x,y:point.y};
 });
 await page.mouse.click(target.x,target.y,{delay:40});const picker=page.locator('#pick-list:not([hidden]) .pick-row[data-object="'+target.index+'"]');if(await picker.count())await picker.click();
 await popup.waitForFunction(()=>document.querySelector('.wf-cursors')?.textContent.includes('VINP')&&document.querySelector('.wf-status')?.textContent==='已加载真实运行数据。');
 await page.keyboard.press('Escape');assert.equal(await page.locator('body').getAttribute('data-studio-plot'),'none');
 report.checks.push('real node probe loads VINP; Esc remains exit-only');
 await popup.bringToFront();await popup.getByRole('button',{name:'绘制已导出波形',exact:true}).click();
 await popup.waitForFunction(()=>document.querySelectorAll('.wf-trace').length===6&&document.querySelectorAll('.wf-cursors tr').length===7&&document.querySelector('.wf-status')?.textContent==='已加载真实运行数据。');
 report.checks.push('all six historical voltage/current curves and cursor measurements work through shared panel');
 await popup.screenshot({path:output+'/waveforms.png',fullPage:true});await page.screenshot({path:output+'/studio.png'});
 assert.equal(report.errors.length,0);assert(report.waveformReads.every(x=>x===200));report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;throw e;}
finally{await writeFile(output+'/report.json',JSON.stringify(report,null,2));await browser?.close();await new Promise(r=>server.close(r));console.log(JSON.stringify(report));}
