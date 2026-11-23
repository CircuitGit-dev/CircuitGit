// Real Chrome, source assets, and an isolated fake helper. No real tokens, model, or runtime mutations.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const evidence=process.env.EVIDENCE_DIR;if(evidence)await mkdir(evidence,{recursive:true});
const origin='https://circuitgit-fixture.test',node='http://127.0.0.1:8767',token='f'.repeat(43),calls=[];
const report={status:'starting',kind:'synthetic remote helper, real Chrome, no inference',checks:[],errors:[]};
const suspended={session_id:'default',state:'suspended',cursor:0,pending:[],active_request_key:'old',active_turn_id:'old-turn',messages:[{role:'user',request_key:'old',text:'已停止的原问题'}],turns:[{key:'old',state:'suspended',terminal_status:'interrupted',selected_model_id:null,permission_mode:'manual',thread_id:'old-thread',turn_id:'old-turn'}],recovery:{can_resume:false,reason:'user_interrupt',expected_turn_id:null}};
const histories=new Map([['default',suspended]]),sessionRows=[{session_id:'default',name:'默认会话',state:'suspended',pending_approval_count:0,suspended_approval_count:0,model:'argon',can_delete:false,delete_block_reason:'default_session'}];
const catalog={default_model:'argon',models:[{id:'argon',model:'argon',displayName:'Argon fixture',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}],inputModalities:['text','image']},{id:'quick-id',model:'quick',displayName:'Quick fixture',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],inputModalities:['text','image']}]};
let development={available:false,workspace:null,reason:'not_configured',access:'manual',can_configure:true};
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1000,height:900}}),page=await context.newPage();
context.on('page',p=>p.on('pageerror',e=>report.errors.push(e.message)));page.on('pageerror',e=>report.errors.push(e.message));
await context.route('**/*',async route=>{
  try{
    const req=route.request(),url=new URL(req.url());
    if(url.origin===origin){
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:16px;font:13px system-ui}#host{width:480px;height:800px;border:1px solid #ddd}[hidden]{display:none!important}</style><div id="host"></div><script type="module">
      import {mountRemoteNode} from '/src/remote/panel.js';let visible=true;const element=document.querySelector('#host'),slot={element,setVisible:v=>visible=v,isVisible:()=>visible,toggle:()=>visible=!visible,setBadge(){}};window.app=mountRemoteNode({version:1,slots:{ai:slot},registerCommand:()=>()=>{}});window.ready=true;
      </script></html>`});
      assert(url.pathname.startsWith('/src/'));const path=resolve(root,'apps/web',url.pathname.slice(5));assert(path.startsWith(resolve(root,'apps/web')+sep));return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/javascript',body:await readFile(path)});
    }
    assert.equal(url.origin,node);
    if(url.pathname==='/connect'){
      const state=url.searchParams.get('state'),target=url.searchParams.get('origin');assert.equal(target,origin);
      return route.fulfill({contentType:'text/html; charset=utf-8',body:`<button id="allow">允许并连接</button><script>const state=${JSON.stringify(state)},target=${JSON.stringify(target)};opener.postMessage({type:'circuitgit.local.ready',state},target);document.querySelector('#allow').onclick=()=>opener.postMessage({type:'circuitgit.local.result',state,allowed:true,accessCode:${JSON.stringify(token)},endpoint:${JSON.stringify(node)}},target);</script>`});
    }
    if(url.pathname==='/development/settings')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>本机开发设置（fixture）</h1><p>此测试不修改任何真实权限。</p><button onclick="fetch(\'/fixture-development-save\',{method:\'POST\'}).then(()=>window.close())">保存模拟设置并返回</button>'});
    if(url.pathname==='/fixture-development-save'){assert.equal(req.method(),'POST');development={available:true,workspace:'/fixture/owner-selected',reason:null,access:'manual',can_configure:true};return route.fulfill({contentType:'application/json',body:'{"ok":true}'});}
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Private-Network':'true'}});
    assert.equal(req.headers().authorization,'Bearer '+token);const method=req.method(),path=url.pathname,body=method==='POST'?req.postDataJSON():null;calls.push({method,path,body});let data;
    const sid=body?.session_id||url.searchParams.get('session_id')||'default',history=histories.get(sid);
    if(path==='/node/info')data={schema:'circuitgit.remote-node.v1',single_owner:true,auth:'bearer',name:'本机 Codex',capabilities:{chat:true,local_login:true}};
    else if(path==='/api/ai/catalog')data={projects:[{id:'fixture',name:'Fixture工程'}]};
    else if(path==='/api/ai/auth/status')data={account:{account_type:'chatgpt',plan_type:'Pro',login_status:'signed_in'},can_login:false,login_state:'idle'};
    else if(path==='/api/ai/context')data={version:1,project:{id:'fixture',sourceCommit:'a'.repeat(40)},file:{path:'projects/fixture/circuit.scs',persistedSha256:'b'.repeat(64),currentTextSha256:'b'.repeat(64),dirty:false}};
    else if(path==='/api/ai/sessions'&&method==='GET')data={sessions:sessionRows,max_sessions:8};
    else if(path==='/api/ai/sessions'&&method==='POST'){
      assert.deepEqual(Object.keys(body),['name']);const row={session_id:'s_fixture',name:body.name,state:'idle',pending_approval_count:0,suspended_approval_count:0,can_delete:true};sessionRows.push(row);histories.set(row.session_id,{session_id:row.session_id,state:'idle',cursor:0,pending:[],turns:[],messages:[],recovery:{can_resume:false,reason:'not_terminal',expected_turn_id:null}});data=row;
    }else if(path==='/api/ai/models')data=catalog;
    else if(path==='/api/ai/history')data=history;
    else if(path==='/api/ai/events')data={state:history.state,cursor:history.cursor,events:[],pending:[],recovery:history.recovery};
    else if(path==='/api/ai/development')data=development;
    else if(path==='/api/ai/development/settings-request'){assert.equal(method,'POST');assert.deepEqual(body,{});data={url:node+'/development/settings?request=fixture-ticket'};}
    else if(path==='/api/ai/turn'){
      assert.equal(sid,'s_fixture');assert.equal(history.state,'idle');assert.equal(body.model,'quick-id');assert.equal(body.reasoning_effort,'high');assert.equal(body.permission_mode,'read_only');
      data={key:body.idempotency_key,state:'running',thread_id:'new-thread',turn_id:'new-turn',selected_model_id:body.model,reasoning_effort:body.reasoning_effort,permission_mode:body.permission_mode};Object.assign(history,{state:'running',active_request_key:data.key,active_turn_id:data.turn_id});history.turns.push(data);
    }else assert.fail('Unexpected fake helper path '+method+' '+path);
    return route.fulfill({headers:{'Access-Control-Allow-Origin':origin},contentType:'application/json',body:JSON.stringify({ok:true,data})});
  }catch(error){report.errors.push(error.message);await route.abort();}
});
const shot=async name=>{if(evidence)await page.screenshot({path:resolve(evidence,name)});};
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready);assert.equal(calls.length,0);assert.equal(await page.getByRole('button',{name:'连接本机 Codex',exact:true}).isVisible(),false);
  await page.getByRole('button',{name:'AI连接设置',exact:true}).click();const popupEvent=page.waitForEvent('popup');await page.getByRole('button',{name:'连接本机 Codex',exact:true}).click();const popup=await popupEvent;await popup.getByRole('button',{name:'允许并连接'}).click();
  await page.getByRole('button',{name:'打开对话',exact:true}).waitFor();await page.getByRole('button',{name:'打开对话',exact:true}).click();
  await page.locator('.ic-ai-session-panel:not([hidden]) .ic-ai-form').waitFor();const active=()=>page.locator('.ic-ai-session-panel:not([hidden])');
  await page.waitForFunction(()=>document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-model').options.length>1);
  assert.equal(await page.locator('.cg-node-initial-settings').isVisible(),false);assert.equal(await page.locator('.cg-node-connected').isVisible(),false);assert.equal(await page.locator('.cg-context-label').isVisible(),false);assert.equal(await page.getByRole('button',{name:'AI设置',exact:true}).count(),1);await shot('remote-compact-connected.png');
  report.checks.push('connecting and account discovery require explicit pairing; connected chat has one gear and no connection/account/context header');
  await active().getByRole('button',{name:'AI设置',exact:true}).click();const model=active().getByRole('combobox',{name:'下一条消息的模型'}),effort=active().getByRole('combobox',{name:'思考强度'});
  assert.equal(await model.isDisabled(),true);assert((await effort.locator('option').count())>1);assert.match(await active().locator('.ic-ai-settings-state-note').innerText(),/已暂停/);
  await active().locator('.cg-node-connection-settings > summary').click();assert.equal(await page.getByRole('button',{name:'断开',exact:true}).isVisible(),true);assert.match(await page.locator('.cg-node-account').innerText(),/Pro/);assert.equal(await page.getByRole('button',{name:'重新检查',exact:true}).isVisible(),true);await shot('remote-settings-paused.png');
  await active().getByRole('button',{name:'新建对话并配置'}).click();const create=page.getByRole('dialog',{name:'新建 AI 对话'});await create.getByRole('textbox',{name:'对话名称'}).fill('新的可配置对话');await create.getByRole('button',{name:'新建',exact:true}).click();await create.waitFor({state:'detached'});
  await page.waitForFunction(()=>document.querySelector('.ic-ai-session-panel:not([hidden])').dataset.sessionId==='s_fixture'&&!document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-model').disabled);
  assert.equal(suspended.state,'suspended');assert.equal(calls.filter(c=>c.path==='/api/ai/turn'||c.path==='/api/ai/resume').length,0);
  await active().getByRole('button',{name:'AI设置',exact:true}).click();await active().getByRole('combobox',{name:'下一条消息的模型'}).selectOption('quick-id');await active().getByRole('combobox',{name:'思考强度'}).selectOption('high');await active().getByRole('combobox',{name:'操作权限'}).selectOption('read_only');
  const ownerEvent=page.waitForEvent('popup');await active().getByRole('button',{name:'配置本机开发权限…'}).click();const owner=await ownerEvent;await owner.getByRole('heading',{name:'本机开发设置（fixture）'}).waitFor();assert.equal(calls.filter(c=>c.path==='/api/ai/development/settings-request').length,1);await owner.getByRole('button',{name:'保存模拟设置并返回'}).click();
  await page.waitForFunction(()=>!document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-permission option[value=developer]').disabled&&!document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-configure-development').disabled);assert.equal(await active().getByRole('combobox',{name:'操作权限'}).inputValue(),'read_only');
  await shot('remote-settings-configurable.png');report.checks.push('paused conversation explains its lock, offers explicit independent chat, and preserves old history without resume/replay; new settings are selectable');
  await active().getByRole('button',{name:'AI设置',exact:true}).click();await active().getByRole('textbox',{name:'发送给电路助手的消息'}).fill('fixture settings request');await active().getByRole('textbox',{name:'发送给电路助手的消息'}).press('Enter');await page.waitForFunction(()=>document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-delivery')?.textContent==='已提交');assert.equal(calls.filter(c=>c.path==='/api/ai/turn').length,1);
  report.checks.push('selected model, reasoning strength and read-only permission reach the fake per-turn API unchanged; developer configuration opens only an explicit local owner page');
  await active().getByRole('button',{name:'AI设置',exact:true}).click();if(!await active().locator('.cg-node-connection-settings').evaluate(node=>node.open))await active().locator('.cg-node-connection-settings > summary').click();await page.getByRole('button',{name:'断开',exact:true}).click();assert.equal(await page.locator('.ic-ai-form').count(),0);const before=calls.length;await page.waitForTimeout(1500);assert.equal(calls.length,before);assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;await shot('remote-panel-failure.png');}
finally{report.posts=calls.filter(c=>c.method==='POST').map(c=>({path:c.path,model:c.body.model??null,reasoning_effort:c.body.reasoning_effort??null,permission_mode:c.body.permission_mode??null}));if(evidence)await writeFile(resolve(evidence,'remote-panel-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
