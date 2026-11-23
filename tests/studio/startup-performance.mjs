// Reproducible static RC startup measurements: three fresh contexts and three cached reloads.
// LATENCY_MS adds the same response delay to every resource; this is a synthetic network scenario.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=resolve(process.argv[2]||'site'),entry=process.argv[3]||'/studio/index.html?layout=dockview&demo=1';
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+new URL(req.url,'http://test').pathname);if(!path.startsWith(root+'/'))throw Error('path');const bytes=await readFile(path);setTimeout(()=>{res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'public,max-age=3600'});res.end(bytes);},Number(process.env.LATENCY_MS||0));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,channel:'chrome'}),rows=[];
try{for(let i=0;i<3;i++){const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();let errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.observedStartup={};const check=()=>{const o=window.observedStartup;if(window.ICStudioDock&&!o.layout)o.layout=performance.now();if(window.viewer?.doc&&document.querySelector('#canvas>svg')&&!o.schematic)o.schematic=performance.now();const app=document.getElementById('app');if(!window.ICStudioDock&&document.getElementById('sidebar')&&app&&getComputedStyle(app).visibility==='visible'&&!document.body.classList.contains('starting'))o.viewerFlash=true;if(document.body?.dataset.studioState==='ready'){o.ready=performance.now();return;}requestAnimationFrame(check);};requestAnimationFrame(check);});
for(const warm of [false,true]){await page.goto(origin+entry);await page.waitForFunction(()=>observedStartup.ready,null,{timeout:60000});rows.push({warm,...await page.evaluate(()=>({...observedStartup,requests:performance.getEntriesByType('resource').length,marks:performance.getEntriesByType('mark').map(x=>[x.name,x.startTime])})),errors});}await context.close();}console.log(JSON.stringify({root,latencyMs:Number(process.env.LATENCY_MS||0),rows},null,2));}finally{await browser.close();await new Promise(r=>server.close(r));}
