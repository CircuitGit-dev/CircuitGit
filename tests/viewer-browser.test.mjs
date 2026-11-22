import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,extname,dirname} from 'node:path';
const {chromium}=process.env.PLAYWRIGHT_MODULE?await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE)):await import('playwright');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(repo,'web'),evidence=resolve(process.env.EVIDENCE_DIR||repo+'/test-results');mkdirSync(evidence,{recursive:true});
const source=readFileSync(resolve(repo,'projects/real-sar-20261106/circuit.scs'),'utf8');
const rc=readFileSync(resolve(repo,'projects/rc-smoke/circuit.scs'),'utf8');
const html=`<!doctype html><html><body style="margin:0"><style>pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><div id="viewer" style="height:640px"></div><pre id="state"></pre><pre id="selection"></pre><script type="module">
import {mount} from '/viewer-adapter/index.js';
const text=await fetch('/source.scs').then(r=>r.text());window.source=text;window.events=[];window.selections=[];
window.adapter=mount(document.querySelector('#viewer'),{sourceText:text,sourcePath:'projects/real-sar-20261106/circuit.scs',sourceCommit:null,onStatus:s=>{window.events.push(s);document.querySelector('#state').textContent=JSON.stringify(s)},onSelect:s=>{window.selections.push(s);document.querySelector('#selection').textContent=JSON.stringify(s)}});
</script></body></html>`;
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.wasm':'application/wasm','.svg':'image/svg+xml'};
const server=createServer((req,res)=>{try{const name=new URL(req.url,'http://x').pathname;if(name==='/test.html'){res.setHeader('Content-Type','text/html');res.end(html);return}if(name==='/source.scs'){res.end(source);return}const p=resolve(root,'.'+name);if(!p.startsWith(root+'/'))throw Error('path');res.setHeader('Content-Type',types[extname(p)]||'text/plain');res.end(readFileSync(p));}catch{res.writeHead(404);res.end('missing')}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const url='http://127.0.0.1:'+server.address().port+'/test.html';const browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:1180,height:780}});const errors=[];page.on('pageerror',e=>errors.push(e.message));const remote=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1'))remote.push(r.url())});
try{
 await page.goto(url);await page.waitForFunction(()=>window.events?.some(e=>e.state==='ready'),{timeout:30000});
 const frame=page.frames().find(f=>f.url().includes('rnl-viewer'));
 await frame.waitForFunction(async()=>{const s=await import('./state.js');return s.doc?.levels[s.current]?.title==='PIPE_TOP_F4_RS9_N06'});
 const data=await frame.evaluate(async()=>{const s=await import('./state.js');return {objects:s.doc.objects,level:s.doc.levels[s.current],svg:document.querySelector('#canvas svg')?.outerHTML.slice(0,800)}});
 writeFileSync(evidence+'/hierarchy-browser-document.json',JSON.stringify(data,null,2));
 async function hit(name,twice=false){
  const xy=await frame.evaluate(async name=>{const s=await import('./state.js');const index=s.doc.objects.findIndex(o=>o.name===name&&o.kind==='instance'&&o.level===s.doc.levels[s.current].host);const h=s.doc.levels[s.current].hits.find(h=>h.kind==='label'&&h.id?.endsWith('::name')&&h.objects.includes(index))??s.doc.levels[s.current].hits.find(h=>h.kind==='box'&&h.objects.includes(index));if(!h)throw Error('missing '+name);const svg=document.querySelector('#canvas > svg');const p=svg.createSVGPoint();p.x=(h.points[0][0]+h.points[1][0])/2;p.y=(h.points[0][1]+h.points[1][1])/2;const q=p.matrixTransform(svg.getScreenCTM());return {x:q.x,y:q.y}},name);const box=await page.locator('iframe').boundingBox();if(twice)await page.mouse.dblclick(box.x+xy.x,box.y+xy.y);else await page.mouse.click(box.x+xy.x,box.y+xy.y);
 }
 await hit('XSARA');await page.waitForFunction(()=>window.selections.some(s=>s.name==='XSARA'&&s.scope==='PIPE_TOP_F4_RS9_N06'));
 await frame.locator('#canvas').press('Enter');await frame.waitForFunction(async()=>{const s=await import('./state.js');return s.doc.levels[s.current].title==='PIPE_SAR9_Real_N06'});
 await hit('XCORE');await page.waitForFunction(()=>window.selections.some(s=>s.name==='XCORE'));await frame.locator('#canvas').press('Enter');await frame.waitForFunction(async()=>{const s=await import('./state.js');return s.doc.levels[s.current].title==='RS9_L3_9bit_SAR_2'});
 await hit('I16');await page.waitForFunction(()=>window.selections.some(s=>s.name==='I16'&&s.scope==='RS9_L3_9bit_SAR_2'));
 await page.screenshot({path:evidence+'/hierarchy-viewer.png',fullPage:true});
 await page.evaluate(()=>window.adapter.select({kind:'instance',name:'M1',scope:'RS9_L3_9bit_SAR_2'}));
 await page.waitForFunction(()=>window.selections.some(s=>s.name==='M1'&&s.scope==='RS9_L3_9bit_SAR_2'));
 assert.equal(await page.evaluate(()=>window.selections.find(s=>s.name==='M1'&&s.scope==='RS9_L3_9bit_SAR_2').line_start),937);
 await page.evaluate(()=>window.adapter.setScope('(top)'));
 await frame.waitForFunction(async()=>{const s=await import('./state.js');return s.doc.levels[s.current].kind==='file'});
 await page.evaluate(()=>window.adapter.update({sourceText:window.source,sourceHash:undefined,scope:'(top)'}));
 await page.waitForFunction(()=>window.events.at(-1)?.state==='ready');
 await frame.waitForFunction(async()=>{const s=await import('./state.js');return s.doc.levels[s.current].kind==='file'});
 await page.evaluate(rc=>window.adapter.update({sourceText:rc,sourcePath:'projects/rc-smoke/circuit.scs',sourceHash:undefined,scope:undefined}),rc);
 await page.waitForFunction(()=>window.events.at(-1)?.state==='ready');
 await frame.waitForFunction(async()=>{const s=await import('./state.js');return s.doc.levels[s.current].kind==='file'&&s.doc.objects.some(o=>o.name==='R0')});
 assert(!await page.evaluate(()=>window.events.some(e=>e.state==='error')),JSON.stringify(await page.evaluate(()=>window.events)));
 await page.evaluate(()=>window.adapter.update({sourceText:window.source,sourcePath:'projects/real-sar-20261106/circuit.scs',sourceHash:undefined,scope:undefined}));
 await page.waitForFunction(()=>window.events.at(-1)?.state==='ready');
 const before=await page.evaluate(()=>window.events.at(-1));
 await page.evaluate(()=>window.adapter.update({sourceText:window.source.replace('Rseries=50','Rseries=51'),sourceHash:undefined}));
 await page.waitForFunction(h=>window.events.at(-1)?.state==='ready'&&window.events.at(-1)?.source_sha256!==h,before.source_sha256);
 await page.evaluate(()=>window.adapter.update({sourceText:'subckt broken a b\nR0 (a b) resistor r=1k\n',sourceHash:undefined}));
 await page.waitForFunction(()=>window.events.at(-1)?.state==='unsupported'&&window.events.at(-1)?.stale);
 if(errors.length||remote.length)throw Error(JSON.stringify({errors,remote}));
 writeFileSync(evidence+'/hierarchy-browser-test.json',JSON.stringify({status:'passed',source_path:'projects/real-sar-20261106/circuit.scs',top_scope_navigation:true,rc_project_switch:true,mapping:'physical top XSARA label click + Enter; XCORE click + Enter drilldown; physical SAR I16 click and reverse M1 selection',selection:await page.evaluate(()=>window.selections),events:await page.evaluate(()=>window.events),external_requests:remote,page_errors:errors},null,2));
 console.log('BROWSER_PASS');
}finally{await browser.close();server.close();}
