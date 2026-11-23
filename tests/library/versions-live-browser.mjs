// Actual Chrome -> paired finite bridge -> direct production workflow.
// Saves, a restore and one external edit occur only in a disposable synthetic Git repo.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const output=process.env.EVIDENCE_DIR;let browser,helper,fixture,helperExit;
const errors=[],responses=[],allowed=new Map([['/library/versions.js','apps/web/library/versions.js'],['/library/versions.css','apps/web/library/versions.css'],['/library/model.js','apps/web/library/model.js'],['/remote/library-bridge.js','apps/web/remote/library-bridge.js'],['/remote/client.js','apps/web/remote/client.js'],['/modules/simulation/http.js','modules/simulation/http.js']]);
const server=createServer((req,res)=>{const path=new URL(req.url,'http://fixture').pathname;if(path==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end('<!doctype html><meta charset="utf-8"><main style="width:500px;height:860px"></main>');}const file=allowed.get(path);if(!file){res.writeHead(404);return res.end('Not found');}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(readFileSync(resolve(root,file)));});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;
const python=String.raw`
import importlib.util,json,secrets,sys,threading
from pathlib import Path
root=Path(sys.argv[1]);sys.path[:0]=[str(root/'tools/workbench'),str(root/'apps/codex')]
from remote_node import Node,Server,Handler
from browser_library import LocalLibrary
spec=importlib.util.spec_from_file_location('disposable_browser_fixture',root/'tests/library/test_workflow.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
f=module.LibraryWorkflowTest();f.setUp();server=Server(('127.0.0.1',0),Handler)
base='http://127.0.0.1:'+str(server.server_port);origin=sys.argv[2]
node=Node(None,secrets.token_urlsafe(32),[origin],'disposable-browser-test',base)
node.library=LocalLibrary(f.workflow,node.pairing,base);server.node=node
rid,csrf=node.pairing.create(origin,secrets.token_urlsafe(24));grant=node.pairing.decide(rid,csrf,True)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
try:
 print(json.dumps({'base':base,'token':grant['accessCode'],'path':f.path,'before':f.before,'sha256':f.sha(f.before),'initial':f.initial}),flush=True)
 for command in sys.stdin:
  if command.strip()=='external_edit':
   f.write(f.path,f.before.replace('1k','3k'));print(json.dumps({'event':'external_edit'}),flush=True)
  elif command.strip()=='stop': break
 print(json.dumps({'external_edit_visible':(f.root/f.path).read_text()==f.before.replace('1k','3k'),'head_unchanged':f.head()==f.initial,'checkpoints':len(f.workflow.checkpoints('demo','gain')['checkpoints'])}),flush=True)
finally:
 server.shutdown();server.server_close();thread.join();f.doCleanups()
`;
try{
 helper=spawn(process.env.PYTHON||'python3',['-B','-u','-c',python,root,origin],{stdio:['pipe','pipe','pipe']});let stderr='';helper.stderr.on('data',chunk=>{stderr+=chunk.toString();});helperExit=new Promise(ok=>helper.once('exit',(code,signal)=>ok({code,signal})));
 const lines=createInterface({input:helper.stdout});const first=new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('Synthetic helper startup timeout')),15000);lines.on('line',line=>{try{const data=JSON.parse(line);responses.push(data);if(!fixture){fixture=data;clearTimeout(timer);ok(data);}}catch{}});helper.once('exit',code=>{if(!fixture){clearTimeout(timer);no(Error('Synthetic helper failed '+code+': '+stderr));}});});
 await first;
 browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});const context=await browser.newContext({viewport:{width:1100,height:940}});const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/');await page.evaluate(async fixture=>{
  const [{createNodeClient},{createLibraryBridge},{mountLibraryVersions}]=await Promise.all([import('/remote/client.js'),import('/remote/library-bridge.js'),import('/library/versions.js')]);
  const client=createNodeClient({url:fixture.base,accessCode:fixture.token});const bridge=createLibraryBridge();bridge.bind(client,{supported:true});
  window.open=()=>{throw Error('Unexpected secondary popup');};window.fixtureBridge=bridge;window.fixtureScope={library_id:'demo',cell_id:'gain',library:'Disposable fixture',cell:'Gain',view_id:'netlist',view:'Synthetic source',directory:'lib/demo/gain',entry:fixture.path,files:[fixture.path],source_sha256:fixture.sha256,has_schematic:false};
  window.fixturePanel=mountLibraryVersions({element:document.querySelector('main'),getSelection:()=>window.fixtureScope,subscribeSelection:()=>()=>{},bridge,loadPublished:async()=>({commits:[]})});
 },fixture);
 const source=page.getByRole('textbox',{name:'电路源码',exact:true});await source.waitFor();assert.equal(await source.getAttribute('readonly'),null);await source.fill(fixture.before.replace('1k','2k'));await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>document.body.textContent.includes('已保存。'));const after=await page.evaluate(path=>window.fixtureBridge.request('read_file',{library_id:'demo',cell_id:'gain',path}),fixture.path);assert.equal(after.text,fixture.before.replace('1k','2k'));assert.notEqual(after.sha256,fixture.sha256);assert.equal(after.base_commit,fixture.initial);assert.equal(context.pages().length,1);assert.equal(await page.getByRole('dialog').count(),0);
 await page.waitForFunction(()=>!document.body.textContent.includes('正在读取电路版本')&&!document.body.textContent.includes('未保存草稿'));
 if(output){mkdirSync(output,{recursive:true});await page.screenshot({path:resolve(output,'real-direct-saved-source.png')});}
 await page.getByRole('button',{name:'恢复保存前',exact:true}).first().click();await page.waitForFunction(()=>document.querySelector('.cg-cv-source')?.value.includes('r=1k'));const restored=await page.evaluate(path=>window.fixtureBridge.request('read_file',{library_id:'demo',cell_id:'gain',path}),fixture.path);assert.equal(restored.sha256,fixture.sha256);
 helper.stdin.write('external_edit\n');await page.waitForFunction(()=>document.querySelector('.cg-cv-source')?.value.includes('r=3k'),null,{timeout:15000});assert.match(await page.getByLabel('工作区差异',{exact:true}).innerText(),/r=3k/);
 assert.deepEqual(errors,[]);assert.equal(context.pages().length,1);if(output)await page.screenshot({path:resolve(output,'real-agent-edit-visible.png')});
 await page.evaluate(()=>{window.fixturePanel.destroy();window.fixtureBridge.unbind();});await browser.close();browser=null;
 helper.stdin.end('stop\n');const ended=await helperExit;assert.equal(ended.code,0);const final=responses.at(-1);assert.deepEqual(final,{external_edit_visible:true,head_unchanged:true,checkpoints:2});
 const report={status:'passed',disposableGit:true,userHelperAccess:false,modelCalls:0,simulations:0,pushes:0,pullRequests:0,checks:['production paired bridge and direct loopback execute','one-click save without modal/popup','saved source text/hash refresh','one-click save-before restore','two durable checkpoints','external Agent file edit becomes visible through current polling','Git HEAD unchanged'],errors};if(output)writeFileSync(resolve(output,'versions-live-browser.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{
 await browser?.close();if(helper&&helper.exitCode===null){helper.stdin.end('stop\n');const timeout=setTimeout(()=>helper.kill('SIGTERM'),5000);await helperExit;clearTimeout(timeout);}await new Promise(ok=>server.close(ok));
}
