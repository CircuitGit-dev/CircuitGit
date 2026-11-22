// Real Chrome + isolated synthetic API: no local Codex, provider, simulation, or engineering writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),arg=process.argv.indexOf('--playwright-module');
const {chromium}=await import(arg>=0?pathToFileURL(process.argv[arg+1]).href:'playwright');
const developerRun=process.argv.includes('--developer'),selectedPermission=developerRun?'developer':'read_only',selectedLabel=developerRun?'开发者':'只读';
const fullDeveloper=developerRun&&process.argv.includes('--full-access'),developerPrefix=fullDeveloper?'developer-full':'developer';
const evidence=process.env.EVIDENCE_DIR;if(evidence)await mkdir(evidence,{recursive:true});
const report={status:'starting',kind:developerRun?'synthetic developer '+(fullDeveloper?'full-access':'manual')+' mode / real Chrome':'synthetic AI settings / real Chrome',checks:[],errors:[]},calls=[],states=new Map();
let development={available:false,workspace:null,reason:'Fixture not configured'};
const origin='https://ic-settings-fixture.test',unavailable={can_resume:false,reason:'not_terminal',expected_turn_id:null};
const catalog={default_model:'capable',models:[
  {id:'capable',model:'capable',displayName:'Capable fixture',inputModalities:['text','image'],defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'},{reasoningEffort:'future-effort'}]},
  {id:'limited',model:'limited',displayName:'Limited fixture',inputModalities:['text','image'],defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]},
]};
for(const id of ['a','b'])states.set(id,{session_id:id,state:'idle',cursor:0,messages:[],turns:[],pending:[],recovery:unavailable,events:[],images:{}});
const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1000,height:850}});
page.on('pageerror',error=>report.errors.push(error.message));
await page.route('**/*',async route=>{
  try{
    const req=route.request(),url=new URL(req.url());assert.equal(url.origin,origin);
    if(url.pathname==='/'){
      await route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/src/studio/ai/style.css"><link rel="stylesheet" href="/src/studio/dockview/style.css">
      <style>body{margin:16px;font-family:system-ui}.host{width:min(760px,100%);height:680px;border:1px solid #ccc}[hidden]{display:none!important}</style>
      <body class="ic-dockview"><button id="a">会话 A</button><button id="b">会话 B</button><section class="host" id="one"></section><section class="host" id="two" hidden></section>
      <script type="module">import {mountAI} from '/src/ai/ai-panel.js';window.panels={};window.active='a';
      const context={version:1,revision:1,mode:'live',project:{id:'fixture'},file:{dirty:false,currentTextSha256:'hash',persistedSha256:'hash'}};
      for(const [id,host] of [['a',document.querySelector('#one')],['b',document.querySelector('#two')]]){
        const root=document.createElement('div');root.className='ic-ai-studio';host.append(root);
        panels[id]=mountAI(root,{presentation:'clean',sessionId:id,contextAdapter:{getContext:()=>context,subscribe:()=>()=>{}},
          getRequest:async path=>{const r=await fetch('/fixture-api'+path);if(!r.ok)throw Error('Fixture GET');return r.json();},
          postRequest:async(path,body)=>{const r=await fetch('/fixture-api'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('Fixture POST');return r.json();}});
        const composer=root.querySelector('.ic-ai-form'),details=document.createElement('div');details.className='ic-ai-dock-details';for(const child of [...root.children])if(child!==composer)details.append(child);root.insertBefore(details,composer);
      }
      function select(id){panels[active].setVisible(false);document.querySelector(active==='a'?'#one':'#two').hidden=true;active=id;document.querySelector(id==='a'?'#one':'#two').hidden=false;panels[id].setVisible(true);}
      document.querySelector('#a').onclick=()=>select('a');document.querySelector('#b').onclick=()=>select('b');select('a');window.ready=true;
      </script></html>`});return;
    }
    if(url.pathname.startsWith('/fixture-api/')){
      const method=req.method(),path=url.pathname.slice('/fixture-api'.length),body=method==='POST'?req.postDataJSON():null,id=body?.session_id||url.searchParams.get('session_id'),s=states.get(id);assert(s);calls.push({method,path,body,session:id});let data;
      if(method==='GET'&&path==='/models')data=catalog;
      else if(method==='GET'&&path==='/development')data=development;
      else if(method==='GET'&&path==='/history'){const {events,images,...history}=s;data=history;}
      else if(method==='GET'&&path==='/events')data={state:s.state,cursor:s.cursor,recovery:s.recovery,pending:s.pending,events:s.events.filter(e=>e.sequence>Number(url.searchParams.get('after')||0))};
      else if(method==='GET'&&path==='/image')data={...s.images[url.searchParams.get('image_id')],session_id:id};
      else if(method==='POST'&&path==='/turn'){
        assert(['idle','complete'].includes(s.state));const images=[];
        for(const image of body.images||[]){const bytes=Buffer.from(image.data_url.split(',')[1],'base64'),image_id=createHash('sha256').update(bytes).digest('hex'),d={image_id,name:image.name,mime_type:image.mime_type,bytes:bytes.length,width:128,height:64};images.push(d);s.images[image_id]={...d,data_url:image.data_url};}
        data={key:body.idempotency_key,state:'running',thread_id:'thread-'+id,turn_id:'turn-'+s.turns.length,selected_model_id:body.model||'',reasoning_effort:body.reasoning_effort??null,permission_mode:body.permission_mode||'manual',...(body.permission_mode==='developer'?{development_access:development.access||'manual',development_workspace:development.workspace}:{}),...(images.length?{images}:{})};
        s.turns.push(data);s.messages.push({role:'user',request_key:data.key,text:body.message,images});Object.assign(s,{state:'running',active_request_key:data.key,active_turn_id:data.turn_id});
      }else if(method==='POST'&&path==='/approval'){
        assert(developerRun);assert.equal(s.turns.at(-1).permission_mode,'developer');const pending=s.pending.find(p=>p.approval_id===body.approval_id);assert(pending);assert(['approve','deny'].includes(body.decision));
        if(body.decision==='approve')assert.equal(pending.can_approve,true);
        pending.status='resolved';s.events.push({sequence:++s.cursor,request_key:s.active_request_key,method:'approval/resolved',params:{approval_id:pending.approval_id,decision:body.decision}});data={delivered:true};
      }else if(method==='POST'&&path==='/resume'){
        assert.equal(s.recovery.can_resume,true);assert.equal(body.expected_turn_id,s.active_turn_id);s.turns.at(-1).input_resumed_at_ms=Date.now();Object.assign(s,{state:'complete',active_request_key:null,active_turn_id:null,recovery:unavailable});data={session_id:id,state:'complete',resumed:true,automatic_retry:false,history_retained:true};
      }else assert.fail('Unexpected '+method+' '+path);
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});return;
    }
    assert(url.pathname.startsWith('/src/'));const source=resolve(root,'apps/web',url.pathname.slice(5));assert(source.startsWith(resolve(root,'apps/web')+sep));await route.fulfill({contentType:source.endsWith('.css')?'text/css':'text/javascript',body:await readFile(source)});
  }catch(error){report.errors.push(error.message);await route.abort();}
});
const shot=async name=>{if(evidence)await page.screenshot({path:resolve(evidence,developerRun?name.replace(/^settings/,developerPrefix):name)});};
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready);
  const host=page.locator('#one'),model=host.getByRole('combobox',{name:'下一条消息的模型',includeHidden:true}),input=host.getByRole('textbox',{name:'发送给电路助手的消息'}),settings=host.getByRole('button',{name:'AI设置'}),effort=host.getByRole('combobox',{name:'思考强度'}),permission=host.getByRole('combobox',{name:'操作权限'}),send=host.locator('button[type=submit]');
  const height=()=>input.evaluate(node=>node.getBoundingClientRect().height);
  const expectHeight=expected=>page.waitForFunction(expected=>Math.abs(document.querySelector('#one textarea').getBoundingClientRect().height-expected)<1,expected);
  await expectHeight(32);
  for(const lines of [2,3,4,5]){await input.fill(Array.from({length:lines},(_,i)=>'第 '+(i+1)+' 行输入').join('\n'));await expectHeight(12+20*Math.min(lines,4));if(lines===4)await shot('settings-four-line-input.png');}
  assert.equal(await input.evaluate(node=>node.scrollHeight>node.clientHeight),true);
  await input.fill('短消息');await expectHeight(32);
  await input.fill('自动换行测试'.repeat(12));const wideHeight=await height();assert(wideHeight>32);
  await host.evaluate(node=>node.style.width='400px');await page.waitForFunction(h=>document.querySelector('#one textarea').getBoundingClientRect().height>h,wideHeight);
  await host.evaluate(node=>node.style.removeProperty('width'));await expectHeight(wideHeight);
  await input.fill('第一行\n第二行\n第三行');await expectHeight(72);await page.locator('#b').click();await page.locator('#a').click();await expectHeight(72);assert.equal(await input.inputValue(),'第一行\n第二行\n第三行');
  await input.fill('');await expectHeight(32);assert.equal(calls.filter(c=>c.method==='POST').length,0);
  report.checks.push('input grows from one to four lines, scrolls beyond four, shrinks after deletion, reflows on dock resize, and survives session switching');
  assert.equal(await host.locator('.ic-ai-settings').isVisible(),false);assert.equal(await model.isVisible(),false);assert.equal(await settings.innerText(),'⚙');assert((await settings.boundingBox()).width<=32);assert.match(await settings.getAttribute('title'),/沿用会话 · 人工批准/);
  await settings.click();await model.selectOption('capable');assert.deepEqual(await effort.locator('option').evaluateAll(nodes=>nodes.map(n=>n.value)),['','model_default','low','medium','high','future-effort']);
  assert.equal(await settings.getAttribute('aria-controls'),await host.locator('.ic-ai-settings').getAttribute('id'));
  await input.press('Escape');assert.equal(await settings.getAttribute('aria-expanded'),'false');assert.equal(await model.isVisible(),false);assert.equal(await settings.evaluate(node=>node===document.activeElement),true);await settings.click();
  if(developerRun){await page.waitForFunction(()=>document.querySelector('#one .ic-ai-development').textContent.includes('尚未配置'));assert.equal(await permission.locator('option[value=developer]').evaluate(option=>option.disabled),true);assert.equal(await send.isEnabled(),true);development={available:true,workspace:'/fixture/application/source',reason:null,access:fullDeveloper?'full':'manual'};await settings.click();await settings.click();await page.waitForFunction(()=>!document.querySelector('#one .ic-ai-permission option[value=developer]').disabled);report.checks.push('unconfigured developer choice stays disabled while ordinary chat remains available; reread enables the server-fixed workspace');}
  await effort.selectOption('high');await permission.selectOption(selectedPermission);assert((await settings.getAttribute('title')).includes('高 · '+selectedLabel));assert.match(await host.locator('.ic-ai-settings-note').innerText(),fullDeveloper?/可读写本机文件、执行命令及联网，无需逐项审批/:developerRun?/写入和扩展执行权限需人工批准/:/查看电路和已有结果/);
  if(fullDeveloper){assert.equal(await permission.locator('option[value=developer]').innerText(),'开发者模式 · 完全访问');assert.match(await settings.getAttribute('title'),/开发者 · 完全访问/);}
  if(developerRun){await host.locator('.ic-ai-development-details summary').click();assert.match(await host.locator('.ic-ai-development-details').innerText(),/\/fixture\/application\/source/);}
  await page.locator('#b').click();const other=page.locator('#two');await other.getByRole('button',{name:'AI设置'}).click();assert.equal(await other.getByRole('combobox',{name:'思考强度'}).inputValue(),'');assert.equal(await other.getByRole('combobox',{name:'操作权限'}).inputValue(),'manual');await page.locator('#a').click();assert.equal(await effort.inputValue(),'high');assert.equal(await permission.inputValue(),selectedPermission);
  report.checks.push('one compact gear discloses model/strength/permission, Escape closes it and restores focus, and settings remain isolated across two sessions');
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=128;c.height=64;c.getContext('2d').fillRect(16,12,32,32);return c.toDataURL('image/png');});
  await host.locator('input[type=file]').setInputFiles({name:'settings-draft.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});await host.locator('.ic-ai-image-preview').waitFor();await input.fill('解释这个电路');
  await model.selectOption('limited');assert.equal(await effort.inputValue(),'high');assert.equal(await send.isDisabled(),true);assert.match(await host.locator('.ic-ai-settings-note').innerText(),/不支持当前思考强度/);await input.press('Enter');assert.equal(calls.filter(c=>c.method==='POST').length,0);assert.equal(await host.locator('.ic-ai-image-preview').count(),1);assert.equal(await input.inputValue(),'解释这个电路');
  await model.selectOption('capable');assert.equal(await effort.inputValue(),'high');assert.equal(await send.isEnabled(),true);report.checks.push('unsupported model switch preserves strength/text/image and blocks Enter until explicitly resolved');
  report.layouts=[];
  for(const width of [400,260]){await page.setViewportSize({width,height:850});const bounds=await host.evaluate(element=>{const b=element.getBoundingClientRect();return {left:b.left,right:b.right,controls:[...element.querySelectorAll('form button,form select,form textarea')].filter(n=>n.getClientRects().length).map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom};})};});assert(bounds.controls.every(b=>b.left>=bounds.left&&b.right<=bounds.right&&b.bottom<=850));report.layouts.push({width,...bounds});await shot('settings-open-'+width+'.png');}
  await settings.click();assert.equal(await host.locator('.ic-ai-settings').isVisible(),false);await shot('settings-compact-260.png');
  if(fullDeveloper){
    development.access='manual';await input.press('Enter');await page.waitForFunction(()=>document.querySelector('#one .ic-ai-image-note').textContent.includes('开发访问权限已变化')&&!document.querySelector('#one textarea').readOnly);
    assert.equal(calls.filter(c=>c.path==='/turn').length,0);assert.equal(await host.locator('.ic-ai-image-preview').count(),1);assert.equal(await input.inputValue(),'解释这个电路');
    development.access='full';await input.press('Enter');await page.waitForFunction(()=>document.querySelector('#one .ic-ai-settings-button').title.includes('完全访问')&&!document.querySelector('#one textarea').readOnly);assert.equal(calls.filter(c=>c.path==='/turn').length,0);
    report.checks.push('full/manual access drift in both directions blocks the send while preserving the image and text draft');
  }
  await input.press('Shift+Enter');assert.equal(calls.filter(c=>c.method==='POST').length,0);await input.press('Enter');await page.waitForFunction(()=>panels.a.getState().phase==='running');
  assert.equal(calls.filter(c=>c.path==='/turn').length,1);const first=calls.find(c=>c.path==='/turn').body;assert.equal(first.reasoning_effort,'high');assert.equal(first.permission_mode,selectedPermission);assert.equal(first.images.length,1);assert.equal(Object.hasOwn(first,'development_workspace'),false);assert.equal(Object.hasOwn(first,'access'),false);assert.equal(Object.hasOwn(first,'development_access'),false);
  await expectHeight(32);assert.equal(await input.inputValue(),'');
  await settings.click();assert.equal(await effort.isDisabled(),true);assert.equal(await permission.isDisabled(),true);assert.equal(await model.isDisabled(),true);report.checks.push('400px/260px layouts fit; image plus Enter sends exact selected settings once and locks controls while running');
  if(developerRun&&!fullDeveloper){
    await page.setViewportSize({width:1000,height:850});const s=states.get('a'),emit=(method,params)=>s.events.push({sequence:++s.cursor,request_key:s.active_request_key,method,params});
    emit('item/started',{item:{id:'command-1',type:'commandExecution',command:'python3 -B tests/check.py',cwd:development.workspace}});emit('item/commandExecution/outputDelta',{itemId:'command-1',delta:'fixture test output'});
    emit('item/started',{item:{id:'file-1',type:'fileChange',changes:[{path:'apps/web/example.js',diff:'- old\n+ fixed'}]}});
    for(const [id,method,can_approve,params] of [['command','item/commandExecution/requestApproval',true,{itemId:'command-1',reason:'Run fixture checks'}],['file','item/fileChange/requestApproval',true,{itemId:'file-1',reason:'Fix workbench source'}],['unsupported','item/other/requestApproval',false,{can_approve:true}]]){const p={approval_id:id,request_key:s.active_request_key,status:'pending',kind:'codex',method,can_approve,development_workspace:development.workspace,params};s.pending.push(p);emit('approval/required',p);}
    await host.locator('.ic-ai-pending-button').waitFor();await host.locator('.ic-ai-pending-button').click();const dialog=page.getByRole('dialog',{name:'审批请求'}),cards=dialog.locator('.ic-ai-approval');await cards.nth(2).waitFor();
    assert.match(await cards.nth(0).innerText(),/python3 -B tests\/check.py/);assert.match(await cards.nth(0).innerText(),/执行目录：\/fixture\/application\/source/);assert.match(await cards.nth(1).innerText(),/apps\/web\/example.js/);assert.match(await cards.nth(1).innerText(),/fixed/);
    assert.equal(await cards.nth(2).getByRole('button',{name:'批准这次操作'}).isDisabled(),true);assert.equal(calls.filter(c=>c.path==='/approval').length,0);await shot('settings-native-approval.png');
    await cards.nth(0).getByRole('button',{name:'批准这次操作'}).click();await cards.nth(1).getByRole('button',{name:'批准这次操作'}).click();await cards.nth(2).getByRole('button',{name:'拒绝',exact:true}).click();assert.deepEqual(calls.filter(c=>c.path==='/approval').map(c=>c.body.decision),['approve','approve','deny']);await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    report.checks.push('native command/cwd/reason and exact-item file patch are reviewable; only server-enabled known requests can be approved by explicit clicks');
  }
  if(fullDeveloper){await host.locator('.ic-ai-progress > summary').click();assert.match(await host.locator('.ic-ai-progress').innerText(),/本回合权限：开发者 · 完全访问/);assert.equal(await host.locator('.ic-ai-pending-button').isVisible(),false);assert.equal(calls.filter(c=>c.path==='/approval').length,0);report.checks.push('the full-access receipt is displayed without inventing approvals or transmitting browser-selected access');}
  const s=states.get('a'),receipt=s.turns.at(-1),error={message:'No available channel for model capable'};Object.assign(receipt,{state:'suspended',terminal_status:'failed',terminal_error:error,duration_ms:1000});s.events.push({sequence:++s.cursor,request_key:receipt.key,method:'turn/completed',params:{turn:{id:receipt.turn_id,status:'failed',durationMs:1000,error}}});s.state='suspended';s.recovery={can_resume:true,reason:'terminal_failure',expected_turn_id:receipt.turn_id};
  const resume=host.getByRole('button',{name:'恢复输入 / 更换模型',exact:true});await resume.waitFor();await resume.click();await page.waitForFunction(()=>panels.a.getState().phase==='complete'&&!document.querySelector('#one .ic-ai-effort').disabled);assert.equal(await effort.inputValue(),'high');assert.equal(await permission.inputValue(),selectedPermission);
  await page.setViewportSize({width:1000,height:850});await page.reload();await page.waitForFunction(()=>window.ready&&panels.a.getState().phase==='complete'&&!document.querySelector('#one .ic-ai-model').disabled);await settings.click();assert.equal(await effort.inputValue(),'high');assert.equal(await permission.inputValue(),selectedPermission);assert.equal(await model.inputValue(),'capable');await shot('settings-restored.png');
  assert.equal(calls.filter(c=>c.path==='/turn').length,1);await permission.selectOption('manual');await effort.selectOption('');await settings.click();await input.fill('新的问题');await input.press('Enter');await page.waitForFunction(()=>panels.a.getState().phase==='running');const last=calls.filter(c=>c.path==='/turn').at(-1).body;assert.equal(last.permission_mode,'manual');assert.equal(Object.hasOwn(last,'reasoning_effort'),false);
  report.checks.push('failure/resume/reload keep settings; explicit switch to manual and inherited strength affects only the next new message');assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;await shot('settings-failure.png');}
finally{report.posts=calls.filter(c=>c.method==='POST').map(c=>({path:c.path,session:c.session,reasoning_effort:c.body.reasoning_effort??null,permission_mode:c.body.permission_mode??null,imageCount:c.body.images?.length||0,...(c.path==='/approval'?{approval_id:c.body.approval_id,decision:c.body.decision}:{})}));if(evidence)await writeFile(resolve(evidence,developerRun?developerPrefix+'-browser.json':'settings-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
