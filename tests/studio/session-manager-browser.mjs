// Real browser UI with synthetic session metadata; no provider or model requests.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const origin='https://ic-sessions-fixture.test',report={status:'starting',checks:[],errors:[]},output=process.env.EVIDENCE_DIR;
if(output)await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1000,height:800}});
page.on('pageerror',error=>report.errors.push(error.message));
await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin);
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/studio/ai/sessions.css"><style>body{font-family:system-ui}#root{height:600px;width:100%;max-width:850px}textarea{width:80%;height:100px}</style><main id="root"></main><script type="module">
  import {mountSessions} from '/src/studio/ai/sessions.js';
  window.escaped=0;document.addEventListener('keydown',e=>{if(e.key==='Escape')escaped++;});
  window.mock={calls:[],mode:'normal',destroyed:[],hostStates:[],panels:{},rows:(new URL(location.href).searchParams.has('empty')?[]:[
    ['default','默认对话','idle',true,null],['s1','设计讨论','complete',true,null],['s2','空对话','idle',true,null],['s3','运行任务','running',false,'active_turn'],['s4','待审批','suspended',false,'pending_approval'],['s5','连接检查','idle',false,'metadata_busy'],['s6','草稿 A','idle',true,null],['s7','草稿 B','idle',true,null]
  ]).map(([session_id,name,state,can_delete,delete_block_reason],i)=>({session_id,name,state,can_delete,delete_block_reason,model:'fixture-model',updated_at_ms:1700000000000+i*1000,pending_approval_count:0,suspended_approval_count:session_id==='s4'?1:0}))};
  const element=document.querySelector('#root');let visible=true;
  const host={version:1,aiSettings:{onSessionsChanged:snapshot=>mock.hostStates.push(snapshot)},slots:{ai:{element,isVisible:()=>visible,setVisible:v=>{visible=v;element.hidden=!v;},setBadge:()=>{}}},gateway:{request:async(path,options)=>{
    mock.calls.push({path,options:structuredClone(options)});
    if(!options){if(path!=='/ai/sessions')throw Error('Unexpected read');return {sessions:structuredClone(mock.rows),max_sessions:8};}
    const body=options.body;
    if(path==='/ai/sessions/rename'){const row=mock.rows.find(r=>r.session_id===body.session_id);row.name=body.name;return {...row};}
    if(path==='/ai/sessions'){if(mock.rows.length>=8)throw Error('Full');const row={session_id:'new-session',name:body.name,state:'idle',can_delete:true,updated_at_ms:1800000000000};mock.rows.push(row);return {...row};}
    if(path==='/ai/sessions/delete'){const row=mock.rows.find(r=>r.session_id===body.session_id);if(!row?.can_delete)throw Error('Protected');mock.rows=mock.rows.filter(r=>r!==row);if(mock.mode==='lost-delete')throw Error('Synthetic lost deletion response');return {session_id:body.session_id,deleted:true,history_retained:true};}
    throw Error('Unexpected mutation');
  }}};
  window.controller=mountSessions(host,{createPanel:(container,{sessionId,onStateChange})=>{
    const input=document.createElement('textarea');input.setAttribute('aria-label','会话草稿');container.append(input);
    const info=mock.rows.find(r=>r.session_id===sessionId),state={phase:info.state,connected:false,pendingApprovalCount:info.pending_approval_count||0,suspendedApprovalCount:info.suspended_approval_count||0};
    mock.panels[sessionId]={state,onStateChange};
    return {getState:()=>state,focusInput:()=>input.focus(),openDetails:()=>{},setVisible:()=>{},destroy:()=>{mock.destroyed.push(sessionId);input.remove();}};
  }});window.ready=true;
  </script>`});
  const source=resolve(root,'apps/web',url.pathname.replace(/^\/src\//,''));assert(source.startsWith(resolve(root,'apps/web')+sep));
  await route.fulfill({contentType:source.endsWith('.css')?'text/css':'text/javascript',body:await readFile(source)});
});
const manager=()=>page.getByRole('dialog',{name:'对话管理器',exact:true});
const row=id=>manager().locator('.ic-ai-manager-row[data-session-id="'+id+'"]');
const manage=async()=>{await page.getByRole('button',{name:'管理 AI 对话',exact:true}).click();await manager().getByRole('button',{name:'刷新',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.ic-ai-manager-toolbar button').disabled);};
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready&&document.querySelectorAll('[role=tab]').length===8);await manage();
  assert.equal(await manager().getByRole('listitem').count(),8);
  for(const id of ['s3','s4','s5'])assert.equal(await row(id).getByRole('button',{name:'删除',exact:true}).isDisabled(),true);
  assert.equal(await row('default').getByRole('button',{name:'删除',exact:true}).isDisabled(),false);
  assert.equal(await manager().getByRole('button',{name:'新建对话',exact:true}).isDisabled(),true);
  report.checks.push('manager lists all eight sessions; legacy default is deletable while active, approval and metadata-busy rows remain protected');
  await page.evaluate(()=>{const row=mock.rows.find(r=>r.session_id==='s5');row.can_delete=true;row.delete_block_reason=null;});
  await page.waitForFunction(()=>!document.querySelector('.ic-ai-manager-row[data-session-id=s5] .ic-ai-delete').disabled,null,{timeout:8000});
  report.checks.push('open manager refreshes transient busy status automatically without a mutation');
  const search=manager().getByRole('searchbox',{name:'搜索对话',exact:true});await search.fill('草稿 B');assert.equal(await manager().getByRole('listitem').count(),1);await search.fill('');
  await row('s1').getByRole('button',{name:'打开',exact:true}).click();
  await page.locator('[role=tabpanel]:not([hidden]) textarea').fill('保留文字和未发送草稿');await manage();
  await row('s2').getByRole('button',{name:'重命名',exact:true}).click();
  const rename=page.getByRole('dialog',{name:'重命名 AI 对话',exact:true});await rename.getByRole('textbox',{name:'对话名称',exact:true}).fill('改名后的对话');await rename.getByRole('button',{name:'保存名称',exact:true}).click();await rename.waitFor({state:'hidden'});
  assert.equal(await row('s2').locator('strong').innerText(),'改名后的对话');await manager().getByRole('button',{name:'关闭',exact:true}).click();
  assert.equal(await page.locator('[role=tabpanel]:not([hidden])').getAttribute('data-session-id'),'s1');assert.equal(await page.locator('[role=tabpanel]:not([hidden]) textarea').inputValue(),'保留文字和未发送草稿');
  report.checks.push('search and rename work without switching the current session or clearing its draft');
  await manage();await row('s1').getByRole('button',{name:'删除',exact:true}).click();
  let confirmation=page.getByRole('dialog',{name:'删除对话',exact:true});assert.match(await confirmation.innerText(),/本地历史、图片和操作回执保留/);
  await page.keyboard.press('Escape');await confirmation.waitFor({state:'hidden'});assert.equal(await manager().isVisible(),true);
  assert.equal(await page.evaluate(()=>mock.calls.filter(c=>c.path==='/ai/sessions/delete').length),0);
  await row('s1').getByRole('button',{name:'删除',exact:true}).click();await confirmation.getByRole('button',{name:'删除对话',exact:true}).click();await confirmation.waitFor({state:'hidden'});
  assert.equal(await manager().getByRole('listitem').count(),7);assert.equal(await page.locator('[role=tabpanel]:not([hidden])').getAttribute('data-session-id'),'default');
  assert.deepEqual(await page.evaluate(()=>mock.destroyed),['s1']);
  assert.equal(await manager().getByRole('button',{name:'新建对话',exact:true}).isDisabled(),false);
  report.checks.push('cancel sends nothing; confirmed deletion removes only its panel, selects default and frees a slot');
  await manager().getByRole('button',{name:'新建对话',exact:true}).click();const create=page.getByRole('dialog',{name:'新建 AI 对话',exact:true});
  await create.getByRole('textbox',{name:'对话名称',exact:true}).fill('管理器中新建');await create.getByRole('button',{name:'新建',exact:true}).click();await create.waitFor({state:'hidden'});assert.equal(await manager().getByRole('listitem').count(),8);
  await page.evaluate(()=>mock.mode='lost-delete');await row('s2').getByRole('button',{name:'删除',exact:true}).click();await confirmation.getByRole('button',{name:'删除对话',exact:true}).click();
  await confirmation.getByText(/不会自动重试/).waitFor();assert.equal(await confirmation.getByRole('button',{name:'删除对话',exact:true}).isDisabled(),true);
  await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('Escape');await confirmation.waitFor({state:'hidden'});
  assert.equal(await manager().isVisible(),true);assert.equal(await page.evaluate(()=>escaped),0);
  await manager().getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.ic-ai-manager-row').length===7);
  assert.equal(await row('s2').count(),0);assert.equal(await page.evaluate(()=>mock.calls.filter(c=>c.path==='/ai/sessions/delete').length),2);
  report.checks.push('new session uses freed slot; lost delete response is reconciled by list refresh without another mutation');
  if(output)await page.screenshot({path:resolve(output,'manager-desktop.png')});
  await page.setViewportSize({width:400,height:700});const box=await manager().boundingBox();assert(box.x>=0&&box.x+box.width<=400);
  if(output)await page.screenshot({path:resolve(output,'manager-narrow.png')});
  await page.keyboard.press('Escape');await manager().waitFor({state:'hidden'});assert.equal(await page.locator('[role=tabpanel]:not([hidden]) textarea').inputValue(),'');
  await page.setViewportSize({width:1000,height:800});await page.evaluate(()=>mock.mode='normal');await manage();
  await row('default').getByRole('button',{name:'删除',exact:true}).click();
  await confirmation.getByRole('button',{name:'删除对话',exact:true}).click();await confirmation.waitFor({state:'hidden'});
  assert.equal(await row('default').count(),0);assert.equal(await page.getByRole('tab',{name:'默认对话',exact:true}).count(),0);
  assert.equal(await page.locator('[role=tabpanel]:not([hidden])').getAttribute('data-session-id'),'new-session');
  await page.evaluate(()=>{mock.mode='normal';for(const info of mock.rows){info.state='idle';info.can_delete=true;info.delete_block_reason=null;info.pending_approval_count=info.suspended_approval_count=0;const panel=mock.panels[info.session_id];Object.assign(panel.state,{phase:'idle',pendingApprovalCount:0,suspendedApprovalCount:0});panel.onStateChange(panel.state);}});
  await manager().getByRole('button',{name:'刷新',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.ic-ai-manager-toolbar button').disabled);
  for(const id of await page.evaluate(()=>mock.rows.map(r=>r.session_id))){
    await row(id).getByRole('button',{name:'删除',exact:true}).click();
    await confirmation.getByRole('button',{name:'删除对话',exact:true}).click();await confirmation.waitFor({state:'hidden'});
  }
  assert.equal(await manager().getByRole('listitem').count(),0);
  await manager().getByText('暂无对话，点击“新建对话”开始。',{exact:true}).waitFor();
  await manager().getByRole('button',{name:'刷新',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.ic-ai-manager-toolbar button').disabled);
  assert.equal(await manager().getByRole('listitem').count(),0);
  await manager().getByRole('button',{name:'关闭',exact:true}).click();
  assert.equal(await page.getByRole('tab').count(),0);
  await page.getByText('暂无对话，点击“新建”开始。',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>mock.hostStates.at(-1)),{count:0,activeSessionId:null,loading:false});
  report.checks.push('legacy default deletes normally; deleting the last chat shows an empty manager and notifies host so connection settings stay reachable');
  await page.goto(origin+'/?empty');await page.waitForFunction(()=>window.ready&&mock.hostStates.at(-1)?.loading===false);
  assert.equal(await page.getByRole('tab').count(),0);assert.equal(await page.evaluate(()=>mock.calls.some(c=>c.options)),false);
  assert.equal(await page.evaluate(()=>Object.keys(mock.panels).length),0);
  await page.getByRole('button',{name:'新建 AI 对话',exact:true}).click();
  const explicitCreate=page.getByRole('dialog',{name:'新建 AI 对话',exact:true});
  await explicitCreate.getByRole('textbox',{name:'对话名称',exact:true}).fill('首个显式对话');
  await explicitCreate.getByRole('button',{name:'新建',exact:true}).click();await explicitCreate.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('tab').count(),1);assert.equal(await page.getByRole('tab',{name:'首个显式对话',exact:true}).count(),1);
  assert.equal(await page.evaluate(()=>mock.calls.filter(c=>c.options?.method==='POST').length),1);
  report.checks.push('fresh empty mount starts no chat or panel; only an explicit New action creates the first named session');
  assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;if(output)await page.screenshot({path:resolve(output,'manager-failed.png')});}
finally{if(output)await writeFile(resolve(output,'manager-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
