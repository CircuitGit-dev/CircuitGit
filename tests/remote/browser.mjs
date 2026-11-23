/** Opt-in browser acceptance against an explicitly configured private node. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {chromium}=process.env.PLAYWRIGHT_MODULE?await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE)):await import('playwright');
const pairingMode=process.env.NODE_PAIR==='1',nodeUrl=pairingMode?'http://127.0.0.1:8767':process.env.NODE_URL;
if(!pairingMode&&(!process.env.NODE_KEY_FILE||!nodeUrl))throw Error('Provide NODE_KEY_FILE and NODE_URL, or NODE_PAIR=1');
let code=pairingMode?'':readFileSync(process.env.NODE_KEY_FILE,'utf8').trim();
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),site=resolve(root,'site'),out=resolve(root,'test-results/remote');mkdirSync(out,{recursive:true});
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
let server,url=process.env.FRONTEND_URL;
if(!url){server=createServer((req,res)=>{try{const path=new URL(req.url,'http://local').pathname;if(!path.startsWith('/CircuitGit/'))throw Error('prefix');const file=resolve(site,path.slice('/CircuitGit/'.length)||'index.html');if(!file.startsWith(site+'/'))throw Error('path');res.setHeader('Content-Type',types[extname(file)]||'text/plain');res.end(readFileSync(file));}catch{res.writeHead(404);res.end('not found');}}).listen(8790,'127.0.0.1');await new Promise(r=>server.once('listening',r));url='http://127.0.0.1:8790/CircuitGit/';}
const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1560,height:1080}});
const errors=[],nodeRequests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().startsWith(nodeUrl)){nodeRequests.push({url:r.url(),method:r.method()});if(pairingMode&&r.headers().authorization)code=r.headers().authorization.slice(7);}});
try {
  await page.goto(url);await page.waitForFunction(()=>document.body.dataset.studioState==='ready');
  assert.equal(nodeRequests.length,0,'No discovery before explicit connect');
  assert.equal(await page.locator('[name=endpoint]').isVisible(),false,'Advanced credentials are hidden by default');
  if(pairingMode){
    let wait=page.waitForEvent('popup');await page.getByRole('button',{name:'连接本机 Codex',exact:true}).click();let popup=await wait;
    await popup.getByRole('button',{name:'取消',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cg-node-status')?.textContent.includes('取消'));
    assert.equal(nodeRequests.length,0,'Cancelled pairing does not query projects or accounts');
    wait=page.waitForEvent('popup');await page.getByRole('button',{name:'连接本机 Codex',exact:true}).click();popup=await wait;
    await popup.getByRole('button',{name:'允许并连接',exact:true}).waitFor();
    assert.equal(nodeRequests.length,0,'No account/project reads before local confirmation');
    await popup.getByRole('button',{name:'允许并连接',exact:true}).click();
  }else{
  await page.locator('.cg-node-advanced summary').click();
  // A rejected connection remains editable and cannot mount chat.
  await page.locator('[name=endpoint]').fill(nodeUrl);await page.locator('[name=accessCode]').fill('x'.repeat(43));await page.locator('[name=consent]').check();
  await page.getByRole('button',{name:'授权并连接',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.cg-node-status')?.dataset.error==='true');
  assert.equal(await page.locator('.cg-node-chat .ic-ai-form').count(),0);
  await page.locator('[name=endpoint]').fill(nodeUrl);await page.locator('[name=accessCode]').fill(code);await page.locator('[name=consent]').check();
  await page.getByRole('button',{name:'授权并连接',exact:true}).click();
  }
  await page.waitForSelector('.cg-node-connected:not([hidden])');
  assert.equal(await page.locator('[name=accessCode]').inputValue(),'');
  await page.getByRole('combobox',{name:'运行节点项目'}).selectOption(process.env.NODE_PROJECT||'rc-smoke');
  await page.getByRole('button',{name:'打开对话',exact:true}).click();
  await page.waitForSelector('.cg-node-chat .ic-ai-form');
  await page.waitForFunction(()=>{const s=document.querySelector('.cg-node-chat .ic-ai-model');return s&&s.options.length>1;});
  assert((await page.locator('.cg-context-label').innerText()).includes('当前原理图与波形仍是公开示例'));
  const defaultValue=await page.locator('.cg-node-chat .ic-ai-model option').first().innerText();
  let inference='not_requested';
  if(process.env.NODE_SEND==='1') {
    await page.getByRole('button',{name:'新建 AI 对话',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'新建 AI 对话'});
    await dialog.getByRole('textbox',{name:'对话名称'}).fill('浏览器只读验收 '+Date.now());
    await dialog.getByRole('button',{name:'新建',exact:true}).click();await dialog.waitFor({state:'detached'});
    const active=page.locator('.ic-ai-session-panel:not([hidden])');
    const sid=await active.getAttribute('data-session-id');assert(sid&&sid!=='default');
    await page.waitForFunction(()=>!document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-model')?.disabled);
    if(process.env.NODE_MODEL)await active.locator('.ic-ai-model').evaluate((el,model)=>{if(!Array.from(el.options).some(o=>o.value===model))throw Error('Requested model was not returned by node');el.value=model;el.dispatchEvent(new Event('change',{bubbles:true}));},process.env.NODE_MODEL);
    await active.locator('.ic-ai-permission').evaluate(el=>{el.value='read_only';el.dispatchEvent(new Event('change',{bubbles:true}));});
    const input=active.getByRole('textbox',{name:'发送给电路助手的消息'});
    await input.fill('这是一条网页节点连通性测试。不要调用任何工具，不要读取或修改工程。只回复：网页节点连接成功。');
    await input.press('Enter');
    const started=Date.now();let result;
    while(Date.now()-started<100000){
      await new Promise(r=>setTimeout(r,1000));
      result=await page.evaluate(async({base,token,sid})=>{const r=await fetch(base+'/api/ai/events?session_id='+encodeURIComponent(sid)+'&after=0',{headers:{Authorization:'Bearer '+token},credentials:'omit'});return (await r.json()).data;},{base:nodeUrl,token:code,sid});
      if(result&&['complete','error','suspended'].includes(result.state))break;
    }
    if(result?.state!=='complete'){writeFileSync(out+'/last-state.json',JSON.stringify(result,null,2));throw Error('Real turn did not complete: '+result?.state);}
    const history=await page.evaluate(async({base,token,sid})=>{const r=await fetch(base+'/api/ai/history?session_id='+encodeURIComponent(sid),{headers:{Authorization:'Bearer '+token},credentials:'omit'});return (await r.json()).data;},{base:nodeUrl,token:code,sid});
    assert(history.messages.some(m=>m.role==='assistant'&&m.text.includes('网页节点连接成功')));
    await active.locator('[data-role=assistant]').filter({hasText:'网页节点连接成功'}).last().waitFor();inference='verified';
  }
  assert(code.length>=43);assert(nodeRequests.every(r=>!r.url.includes(code)));
  const storage=await page.evaluate(()=>JSON.stringify({local:Object.entries(localStorage),session:Object.entries(sessionStorage)}));assert(!storage.includes(code));
  await page.screenshot({path:out+'/connected.png',fullPage:true});
  await page.getByRole('button',{name:'断开',exact:true}).click();await page.waitForSelector('.cg-node-welcome:not([hidden])');
  const requests=nodeRequests.length;await page.waitForTimeout(1800);assert.equal(nodeRequests.length,requests,'Disconnect stops polling');
  assert.equal(await page.locator('.cg-node-chat .ic-ai-form').count(),0);assert.deepEqual(errors,[]);
  const result={status:'passed',url,crossOrigin:true,explicitConsent:true,pairingMode,rejectedConnectionRecoverable:true,contextFromNode:true,modelCatalog:true,defaultLabel:defaultValue,selectedModel:process.env.NODE_MODEL||null,inference,codeNotPersisted:true,disconnectStopsPolling:true};
  writeFileSync(out+'/acceptance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){console.log(JSON.stringify({errors,status:await page.locator('.cg-node-status').innerText().catch(()=>''),chat:await page.locator('.cg-node-chat').innerText().catch(()=>'')}));throw e;}
finally{await browser.close();server?.close();}
