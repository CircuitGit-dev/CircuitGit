// Real Chrome acceptance with synthetic, isolated gateway responses. No real model or engineering operation.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const arg=process.argv.indexOf('--playwright-module');
const {chromium}=await import(arg>=0?pathToFileURL(process.argv[arg+1]).href:'playwright');
const report={status:'starting',kind:'synthetic recovery / isolated gateway / real Chrome',checks:[],errors:[]};
const evidence=process.env.EVIDENCE_DIR;
if(evidence)await mkdir(evidence,{recursive:true});
const origin='https://ic-recovery-fixture.test',sessionId='recovery-browser-fixture',threadId='thread-fixture',turnId='turn-fixture';
const unavailable={can_resume:false,reason:'no_terminal_failure',expected_turn_id:null};
const catalog={default_model:'sol',models:[{id:'argon',model:'argon',displayName:'Argon fixture',inputModalities:['text','image']},{id:'sol',model:'sol',displayName:'Sol fixture',inputModalities:['text','image']}]};
const calls=[],events=[];
const history={session_id:sessionId,state:'idle',cursor:0,messages:[],turns:[],pending:[],recovery:unavailable};
function emit(method,params){events.push({sequence:++history.cursor,request_key:history.active_request_key,thread_id:threadId,turn_id:turnId,method,params});}
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:1000,height:800}});
page.on('pageerror',error=>report.errors.push(error.message));
await page.route('**/*',async route=>{
  try{
    const request=route.request(),url=new URL(request.url());
    assert.equal(url.origin,origin,'Unexpected external network origin');
    if(url.pathname==='/'){
      await route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
      <link rel="stylesheet" href="/src/studio/ai/style.css"><link rel="stylesheet" href="/src/studio/dockview/style.css">
      <style>body{margin:16px;font-family:system-ui}.host{width:min(760px,100%);height:620px;border:1px solid #ccc}[hidden]{display:none!important}</style>
      <body class="ic-dockview"><section class="host"><div id="ai" class="ic-ai-studio"></div></section>
      <script type="module">
      import {mountAI} from '/src/ai/ai-panel.js';
      const context={version:1,revision:1,mode:'live',project:{id:'fixture'},file:{dirty:false,currentTextSha256:'hash',persistedSha256:'hash'}};
      const root=document.querySelector('#ai');
      window.panel=mountAI(root,{presentation:'clean',sessionId:'${sessionId}',contextAdapter:{getContext:()=>context,subscribe:()=>()=>{}},
        getRequest:async path=>{const response=await fetch('/fixture-api'+path);if(!response.ok)throw Error('Fixture GET failed');return response.json();},
        postRequest:async(path,body)=>{const response=await fetch('/fixture-api'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw Error('Fixture POST failed');return response.json();}});
      const composer=root.querySelector('.ic-ai-form'),details=document.createElement('div');details.className='ic-ai-dock-details';
      for(const child of [...root.children])if(child!==composer)details.append(child);root.insertBefore(details,composer);
      panel.setVisible(true);window.ready=true;
      </script></html>`});return;
    }
    if(url.pathname.startsWith('/fixture-api/')){
      const path=url.pathname.slice('/fixture-api'.length),method=request.method();
      const body=method==='POST'?request.postDataJSON():null;calls.push({method,path,body});
      assert.equal(method==='POST'?body.session_id:url.searchParams.get('session_id'),sessionId);
      let result;
      if(method==='GET'&&path==='/models')result=catalog;
      else if(method==='GET'&&path==='/development')result={available:false,workspace:null,reason:'Fixture not configured'};
      else if(method==='GET'&&path==='/history')result=history;
      else if(method==='GET'&&path==='/events')result={state:history.state,cursor:history.cursor,recovery:history.recovery,pending:history.pending,events:events.filter(e=>e.sequence>Number(url.searchParams.get('after')||0))};
      else if(method==='POST'&&path==='/turn'){
        assert.equal(history.state,'idle');assert.equal(body.model,'argon');
        result={key:body.idempotency_key,state:'running',thread_id:threadId,turn_id:turnId,selected_model_id:body.model};
        Object.assign(history,{state:'running',active_request_key:result.key,active_turn_id:turnId,thread_id:threadId});
        history.turns.push(result);history.messages.push({role:'user',request_key:result.key,text:body.message});
      }else if(method==='POST'&&path==='/resume'){
        assert.deepEqual(body,{session_id:sessionId,expected_turn_id:turnId});assert.equal(history.recovery.can_resume,true);
        Object.assign(history,{state:'complete',active_request_key:null,active_turn_id:null,recovery:unavailable});
        history.turns.at(-1).input_resumed_at_ms=Date.now();
        result={session_id:sessionId,state:'complete',resumed:true,automatic_retry:false,history_retained:true};
      }else assert.fail('Unexpected fixture endpoint: '+method+' '+path);
      await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});return;
    }
    assert(url.pathname.startsWith('/src/'),'Unexpected fixture asset path');
    const source=resolve(root,'apps/web',url.pathname.slice(5));assert(source.startsWith(resolve(root,'apps/web')+sep));
    await route.fulfill({contentType:source.endsWith('.css')?'text/css':'text/javascript',body:await readFile(source)});
  }catch(error){report.errors.push(error.message);await route.abort();}
});
const screenshot=async name=>{if(evidence)await page.screenshot({path:resolve(evidence,name)});};
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready);
  const host=page.locator('.host'),input=host.getByRole('textbox',{name:'发送给电路助手的消息'}),model=host.getByRole('combobox',{name:'下一条消息的模型',includeHidden:true});
  const send=host.locator('button[type=submit]'),resume=host.getByRole('button',{name:'恢复输入 / 更换模型',exact:true});
  await model.locator('option[value=argon]').waitFor({state:'attached'});await host.getByRole('button',{name:'AI设置'}).click();await model.selectOption('argon');await host.getByRole('button',{name:'AI设置'}).click();
  await input.fill('只回复连接正常');await input.press('Enter');
  await page.waitForFunction(()=>panel.getState().phase==='running');
  emit('error',{threadId,turnId,willRetry:true,error:{message:'Reconnecting... 1/5',additionalDetails:'high demand'}});
  await host.getByText(/模型连接重试中 · [\d.]+ 秒/).waitFor();
  assert.equal(await send.isDisabled(),true);assert.equal(await model.isDisabled(),true);assert.equal(await resume.isVisible(),false);
  await input.fill('失败后待发送的新问题');await input.press('Enter');assert.equal(calls.filter(c=>c.path==='/turn').length,1);
  await screenshot('recovery-retrying.png');report.checks.push('willRetry keeps progress active, send/model locked, and Enter cannot issue another turn');

  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=128;c.height=64;const x=c.getContext('2d');x.fillStyle='#fafafa';x.fillRect(0,0,128,64);x.fillStyle='#124f9e';x.fillRect(16,12,32,32);x.fillText('fixture',56,35);return c.toDataURL('image/png');});
  await host.locator('input[type=file]').setInputFiles({name:'recovery-draft.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
  await host.locator('.ic-ai-image-preview').waitFor();
  const error={message:'No available channel for model argon',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503}}};
  emit('turn/completed',{threadId,turn:{id:turnId,status:'failed',durationMs:32141,error}});
  Object.assign(history.turns.at(-1),{state:'suspended',terminal_status:'failed',terminal_error:error,duration_ms:32141});
  history.state='suspended';history.recovery={can_resume:true,reason:'terminal_failure',expected_turn_id:turnId};
  await resume.waitFor();await page.waitForFunction(()=>!document.querySelector('.ic-ai-resume').disabled);
  assert.match(await host.locator('.ic-ai-progress').innerText(),/失败 · 32\.1 秒/);
  assert.match(await host.locator('.ic-ai-failure-button').innerText(),/模型通道不可用/);
  assert.equal(await send.isDisabled(),true);assert.equal(await model.isDisabled(),true);
  await screenshot('recovery-failed-desktop.png');report.checks.push('only terminal failure exposes recovery, with correct model-channel diagnosis and terminal duration');

  report.layouts=[];
  for(const width of [400,260]){
    await page.setViewportSize({width,height:800});
    const bounds=await host.evaluate(element=>{const box=element.getBoundingClientRect(),form=element.querySelector('.ic-ai-form'),button=form.querySelector('.ic-ai-resume'),b=button.getBoundingClientRect();return {host:{left:box.left,right:box.right,bottom:box.bottom},input:form.querySelector('textarea').getBoundingClientRect().width,recovery:{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom},controls:[...form.querySelectorAll('button,select,textarea')].filter(n=>n.getClientRects().length).map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right};})};});
    assert(bounds.input>=Math.min(160,width-64),'Narrow dock must retain usable input');
    assert(bounds.controls.every(b=>b.left>=bounds.host.left&&b.right<=bounds.host.right),'Composer controls must stay inside dock');
    assert(bounds.recovery.width>=120&&bounds.recovery.height>=24,'Recovery button must be a usable click target');
    assert(bounds.recovery.y>=0&&bounds.recovery.bottom<=800,'Recovery button must remain within viewport');
    report.layouts.push({width,...bounds});await screenshot('recovery-narrow-'+width+'.png');
  }
  report.checks.push('400px and 260px layouts keep input, image draft, and recovery button within the dock and viewport');
  const failedBefore=structuredClone(history.turns),postsBefore=calls.filter(c=>c.path==='/turn').length;
  await resume.click();await page.waitForFunction(()=>panel.getState().phase==='complete'&&!document.querySelector('.ic-ai-model').disabled);
  assert.equal(await input.inputValue(),'失败后待发送的新问题');assert.equal(await model.inputValue(),'argon');
  assert.equal(await host.locator('.ic-ai-image-preview').count(),1);assert.equal(await resume.isVisible(),false);
  assert.deepEqual(history.turns.map(({input_resumed_at_ms,...turn})=>turn),failedBefore);
  assert.equal(history.active_request_key,null);assert.equal(history.active_turn_id,null);
  assert.equal(calls.filter(c=>c.path==='/turn').length,postsBefore);assert.equal(calls.filter(c=>c.path==='/resume').length,1);
  await screenshot('recovery-resumed-narrow.png');report.checks.push('real 260px button click resumes input, retains draft text/image/model/history, clears active turn, and never resends');

  await page.setViewportSize({width:1000,height:800});await page.reload();await page.waitForFunction(()=>window.ready&&panel.getState().phase==='complete'&&!document.querySelector('.ic-ai-model').disabled);
  assert.equal(await model.inputValue(),'argon');assert.equal(await send.isEnabled(),true);
  assert.match(await host.locator('.ic-ai-message[data-role=user]').innerText(),/只回复连接正常/);
  assert.match(await host.locator('.ic-ai-progress').innerText(),/失败 · 32\.1 秒/);
  assert.equal(calls.filter(c=>c.path==='/turn').length,postsBefore);assert.equal(calls.filter(c=>c.path==='/resume').length,1);
  await screenshot('recovery-reloaded.png');report.checks.push('reload preserves the resumed receipt model and historical failure without issuing another turn or resume');
  assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;await screenshot('recovery-failure.png');}
finally{
  report.posts=calls.filter(c=>c.method==='POST').map(c=>({path:c.path,session_id:c.body.session_id,model:c.body.model??null,expected_turn_id:c.body.expected_turn_id??null}));
  if(evidence)await writeFile(resolve(evidence,'recovery-browser.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));await browser.close();
}
