// Real Chrome with source UI and a synthetic helper; no models, user chats or circuit writes.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const evidence=process.env.EVIDENCE_DIR;if(evidence)await mkdir(evidence,{recursive:true});
const origin='https://library-ai-fixture.test',node='http://127.0.0.1:8767',token='x'.repeat(43),calls=[];
const registry=JSON.parse(await readFile(resolve(root,'lib/catalog.json'))),projects=[];
for(const library of registry.libraries){
  const manifest=JSON.parse(await readFile(resolve(root,library.manifest)));
  for(const cell of manifest.cells)projects.push({id:'library:'+library.id+'/'+cell.id,name:library.id+' / '+cell.id,
    kind:'library',library_id:library.id,cell_id:cell.id,can_edit:true,can_simulate:false,pdk_required_for_edit:false,configurations:[]});
}
assert.equal(projects.length,97);
const rc='library:basics/rc-smoke',other=projects.find(p=>p.id!==rc).id,unavailable={can_resume:false,reason:'not_terminal',expected_turn_id:null};
const rows=[{session_id:'default',name:'旧默认对话',state:'idle',pending_approval_count:0,suspended_approval_count:0,can_delete:true}],histories=new Map();
const history=id=>({session_id:id,state:'idle',cursor:0,pending:[],turns:[],messages:[],recovery:unavailable});histories.set('default',history('default'));
const report={status:'starting',kind:'real Chrome, synthetic library AI helper, no inference',checks:[],errors:[]};
let freshMode='valid',freshHash='b'.repeat(64),created=0,holdRefresh=null;
function source(id,path){
  const p=projects.find(p=>p.id===id);assert(p);
  const hash=path?freshHash:'b'.repeat(64),commit=path?'c'.repeat(40):'a'.repeat(40);
  const value={version:1,revision:1,mode:'live',library:{library_id:p.library_id,cell_id:p.cell_id},
    project:{id,sourceCommit:commit},file:{path:path||`lib/${p.library_id}/${p.cell_id}/schematic/input.rnl`,baseCommit:commit,
      persistedSha256:hash,currentTextSha256:hash,dirty:false,editable:true}};
  if(path){
    if(freshMode==='missing-scope')delete value.library;
    if(freshMode==='wrong-cell')value.library.cell_id='other-cell';
    if(freshMode==='bad-hash')value.file.persistedSha256='invalid';
    if(freshMode==='wrong-path')value.file.path='lib/other/cell/source.rnl';
    if(freshMode==='wrong-base')value.file.baseCommit='e'.repeat(40);
  }
  return value;
}
const browser=await chromium.launch({headless:true,channel:'chrome'}),ctx=await browser.newContext({viewport:{width:920,height:900}}),page=await ctx.newPage();
ctx.on('page',p=>p.on('pageerror',error=>report.errors.push(error.message)));page.on('pageerror',error=>report.errors.push(error.message));
await ctx.route('**/*',async route=>{
  try{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===origin){
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:12px;font:13px system-ui}#host{width:min(480px,100%);height:820px;border:1px solid #ddd}[hidden]{display:none!important}</style><main id="host"></main><script type="module">
        import {mountRemoteNode} from '/src/remote/panel.js';let visible=true;window.canvas={project:{id:'rc-demo'}};
        const slot={element:document.querySelector('#host'),setVisible:v=>visible=v,isVisible:()=>visible,toggle:()=>visible=!visible,setBadge(){}};
        window.app=mountRemoteNode({version:1,slots:{ai:slot},context:{getContext:()=>structuredClone(window.canvas)},registerCommand:()=>()=>{}});window.ready=true;
        </script></html>`});
      assert(url.pathname.startsWith('/src/'));const path=resolve(root,'apps/web',url.pathname.slice(5));assert(path.startsWith(resolve(root,'apps/web')+sep));
      return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/javascript',body:await readFile(path)});
    }
    assert.equal(url.origin,node);
    if(url.pathname==='/connect'){
      const state=url.searchParams.get('state'),target=url.searchParams.get('origin');assert.equal(target,origin);
      return route.fulfill({contentType:'text/html; charset=utf-8',body:`<button id="allow">允许并连接</button><script>const state=${JSON.stringify(state)},target=${JSON.stringify(target)};opener.postMessage({type:'circuitgit.local.ready',state},target);document.querySelector('#allow').onclick=()=>opener.postMessage({type:'circuitgit.local.result',state,allowed:true,accessCode:${JSON.stringify(token)},endpoint:${JSON.stringify(node)}},target);</script>`});
    }
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Private-Network':'true'}});
    assert.equal(request.headers().authorization,'Bearer '+token);
    const method=request.method(),path=url.pathname,body=method==='POST'?request.postDataJSON():null;calls.push({method,path,query:url.search,body});let data;
    const sid=body?.session_id||url.searchParams.get('session_id')||'default',h=histories.get(sid);
    if(path==='/node/info')data={schema:'circuitgit.remote-node.v1',single_owner:true,auth:'bearer',capabilities:{chat:true,local_login:true,library_workflow:true}};
    else if(path==='/api/ai/catalog')data={projects};
    else if(path==='/api/ai/auth/status')data={account:{account_type:'chatgpt',plan_type:'Pro',login_status:'signed_in'},can_login:false,login_state:'idle'};
    else if(path==='/api/ai/context'){
      if(url.searchParams.has('path')&&holdRefresh)await holdRefresh;
      data=source(url.searchParams.get('project_id'),url.searchParams.get('path'));
    }else if(path==='/api/ai/sessions'&&method==='GET')data={sessions:rows,max_sessions:8};
    else if(path==='/api/ai/sessions'&&method==='POST'){
      assert.deepEqual(Object.keys(body),['name']);data={session_id:'s_fixture_'+(++created),name:body.name,state:'idle',can_delete:true};rows.push(data);histories.set(data.session_id,history(data.session_id));
    }else if(path==='/api/ai/sessions/delete'){
      assert.equal(method,'POST');const index=rows.findIndex(r=>r.session_id===sid);assert(index>=0);assert.notEqual(histories.get(sid).state,'running');rows.splice(index,1);data={session_id:sid,deleted:true};
    }else if(path==='/api/ai/models')data={default_model:'fixture',models:[{id:'fixture',model:'fixture',displayName:'Synthetic model',inputModalities:['text'],supportedReasoningEfforts:[]}]};
    else if(path==='/api/ai/development')data={available:false,workspace:null,access:'manual',reason:'fixture'};
    else if(path==='/api/ai/history'){assert(h);data=h;}
    else if(path==='/api/ai/events'){assert(h);data={state:h.state,cursor:h.cursor,events:[],pending:[],recovery:unavailable};}
    else if(path==='/api/ai/turn'){
      assert(h);assert.equal(freshMode,'valid');assert(body.context.library);assert.equal(body.context.file.persistedSha256,freshHash);
      assert.equal(body.context.file.baseCommit,body.context.project.sourceCommit);assert.equal(body.context.project.sourceCommit,'c'.repeat(40));
      assert.equal(body.library,undefined);assert.equal(body.file,undefined);assert.equal(body.project,undefined);
      data={key:body.idempotency_key,state:'complete',thread_id:'fixture-thread',turn_id:'fixture-turn'};
      h.state='complete';h.turns.push(data);h.messages.push({role:'user',request_key:data.key,text:body.message});rows.find(r=>r.session_id===sid).state='complete';
    }else assert.fail('Unexpected synthetic endpoint '+method+' '+path);
    return route.fulfill({headers:{'Access-Control-Allow-Origin':origin},contentType:'application/json',body:JSON.stringify({ok:true,data})});
  }catch(error){report.errors.push(error.stack);await route.abort();}
});
const active=()=>page.locator('.ic-ai-session-panel:not([hidden])'),posts=()=>calls.filter(c=>c.path==='/api/ai/turn'),shot=async name=>{if(evidence)await page.screenshot({path:resolve(evidence,name)});};
async function openSettings(){
  if(!await active().locator('.ic-ai-settings').isVisible())await active().getByRole('button',{name:'AI设置',exact:true}).click();
  if(!await page.locator('.cg-node-connection-settings').evaluate(n=>n.open))await page.locator('.cg-node-connection-settings > summary').click();
}
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready);assert.equal(calls.length,0);
  await page.getByRole('button',{name:'AI连接设置',exact:true}).click();const popupEvent=page.waitForEvent('popup');await page.getByRole('button',{name:'连接本机 Codex',exact:true}).click();
  const popup=await popupEvent;await popup.getByRole('button',{name:'允许并连接'}).click();
  const selector=page.locator('.cg-node-project select');await page.waitForFunction(()=>document.querySelector('.cg-node-project select').options.length===98);
  assert.equal(await selector.inputValue(),rc);assert.equal(await selector.locator('option:disabled').count(),0);
  await page.getByRole('button',{name:'打开对话',exact:true}).click();await active().getByRole('textbox',{name:'发送给电路助手的消息'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-model').options.length>1);
  assert.equal(await page.locator('.cg-node-initial-settings').isVisible(),false);assert.equal(await page.locator('.cg-node-connected').isVisible(),false);assert.equal(await page.getByRole('button',{name:'AI设置',exact:true}).count(),1);
  report.checks.push('97 real catalog identities are selectable without PDK/runtime registration; RC is the initial canvas default; compact header has one gear');
  await openSettings();await page.evaluate(id=>{const [libraryId,cellId]=id.slice(8).split('/');window.canvas={project:{id:'public-library:'+libraryId+':'+cellId,libraryId,cellId}};},other);
  await page.getByRole('button',{name:'使用当前电路',exact:true}).click();await page.waitForFunction(id=>document.querySelector('.cg-context-label').textContent.includes(id),other);
  assert.equal(await page.locator('.ic-ai-session-panel').count(),1);assert.equal(calls.filter(c=>c.path==='/api/ai/sessions'&&c.method==='POST').length,0);
  for(const project of projects){
    await page.evaluate(async id=>{const select=document.querySelector('.cg-node-project select');select.value=id;await document.querySelector('[data-action=open-project]').onclick();},project.id);
    assert((await page.locator('.cg-context-label').textContent()).includes(project.id));
  }
  assert.equal(posts().length,0);assert.equal(await page.locator('.ic-ai-session-panel').count(),1);
  report.checks.push('all 97 cells open synthetic exact source context; canvas switch and repeated selection preserve the existing conversation without model calls');
  const label=await page.locator('.cg-context-label').textContent(),before=calls.filter(c=>c.path==='/api/ai/context').length;
  rows[0].state=histories.get('default').state='running';
  await page.evaluate(async id=>{document.querySelector('.cg-node-project select').value=id;await document.querySelector('[data-action=open-project]').onclick();},other);
  assert.equal(await page.locator('.cg-context-label').textContent(),label);assert.equal(calls.filter(c=>c.path==='/api/ai/context').length,before);assert.match(await page.locator('.cg-node-status').textContent(),/仍在执行/);
  rows[0].state=histories.get('default').state='idle';
  await page.evaluate(async()=>{document.querySelector('.cg-node-project select').value='library:basics/rc-smoke';await document.querySelector('[data-action=open-project]').onclick();});
  await page.evaluate(()=>window.canvas={project:{id:'unregistered-canvas'}});const previousValue=await selector.inputValue();
  await page.evaluate(()=>document.querySelector('[data-action=use-canvas]').onclick());assert.equal(await selector.inputValue(),previousValue);assert.match(await page.locator('.cg-node-status').textContent(),/未在连接的库中登记/);
  report.checks.push('running conversations prevent context switches; unknown canvas identity never silently selects another circuit');
  if(await active().locator('.ic-ai-settings').isVisible())await active().getByRole('button',{name:'AI设置',exact:true}).click();
  for(const mode of ['missing-scope','wrong-cell','bad-hash','wrong-path','wrong-base']){
    freshMode=mode;await active().getByRole('textbox',{name:'发送给电路助手的消息'}).fill('fixture '+mode);await active().getByRole('textbox',{name:'发送给电路助手的消息'}).press('Enter');
    await active().getByRole('button',{name:'核对发送结果',exact:true}).waitFor();assert.equal(posts().length,0);
    await active().getByRole('button',{name:'核对发送结果',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-image-reconcile').hidden);
  }
  report.checks.push('missing/wrong library scope, bad hash, changed file path and inconsistent base commit all stop before the model POST');
  let releaseRefresh;holdRefresh=new Promise(resolve=>releaseRefresh=resolve);freshMode='missing-scope';
  const readsBefore=calls.filter(c=>c.path==='/api/ai/context').length;
  await active().getByRole('textbox',{name:'发送给电路助手的消息'}).fill('fixture in-flight source read');await active().getByRole('textbox',{name:'发送给电路助手的消息'}).press('Enter');
  while(calls.filter(c=>c.path==='/api/ai/context').length===readsBefore)await page.waitForTimeout(10);
  const boundLabel=await page.locator('.cg-context-label').textContent();
  await page.evaluate(async id=>{document.querySelector('.cg-node-project select').value=id;await document.querySelector('[data-action=open-project]').onclick();},other);
  assert.equal(await page.locator('.cg-context-label').textContent(),boundLabel);assert.equal(await selector.inputValue(),rc);assert.match(await page.locator('.cg-node-status').textContent(),/仍在执行/);
  releaseRefresh();holdRefresh=null;await active().getByRole('button',{name:'核对发送结果',exact:true}).waitFor();assert.equal(posts().length,0);
  await active().getByRole('button',{name:'核对发送结果',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-image-reconcile').hidden);
  report.checks.push('an in-flight source refresh blocks rebinding before the backend records a running turn');
  freshMode='valid';freshHash='d'.repeat(64);await active().getByRole('textbox',{name:'发送给电路助手的消息'}).fill('fixture exact fresh hash');await active().getByRole('textbox',{name:'发送给电路助手的消息'}).press('Enter');
  await page.waitForFunction(()=>[...document.querySelectorAll('.ic-ai-delivery')].some(n=>n.textContent==='已提交'));
  assert.equal(posts().length,1);assert.equal(posts()[0].body.context.library.cell_id,'rc-smoke');assert.equal(posts()[0].body.session_id,'default');
  assert.equal(await active().locator('.ic-ai').getAttribute('data-stale'),'false');
  report.checks.push('fresh source hash reaches context nested in the turn body and does not mark its own new turn stale');
  await page.waitForFunction(()=>document.querySelector('.ic-ai-session-panel:not([hidden]) textarea').readOnly===false);
  await page.getByRole('button',{name:'管理 AI 对话',exact:true}).click();const manager=page.getByRole('dialog',{name:'对话管理器'});
  await manager.locator('[data-session-id=default]').getByRole('button',{name:'删除',exact:true}).click();const confirm=page.getByRole('dialog',{name:'删除对话'});await confirm.getByRole('button',{name:'删除对话',exact:true}).click();await confirm.waitFor({state:'detached'});
  assert.equal(rows.length,0);assert.equal(await page.locator('.ic-ai-session-panel').count(),0);await manager.getByRole('button',{name:'刷新',exact:true}).click();
  await manager.getByText('暂无对话，点击“新建对话”开始。',{exact:true}).waitFor();await manager.getByRole('button',{name:'关闭',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'AI连接设置',exact:true}).isVisible(),true);assert.equal(await page.locator('.ic-ai-form').count(),0);assert.equal(calls.filter(c=>c.path==='/api/ai/sessions'&&c.method==='POST').length,0);
  await page.setViewportSize({width:320,height:900});await shot('remote-library-zero-chats.png');
  await page.getByRole('button',{name:'新建 AI 对话',exact:true}).click();const create=page.getByRole('dialog',{name:'新建 AI 对话'});await create.getByRole('textbox',{name:'对话名称'}).fill('fixture after zero');await create.getByRole('button',{name:'新建',exact:true}).click();await create.waitFor({state:'detached'});
  await active().getByRole('textbox',{name:'发送给电路助手的消息'}).waitFor();assert.equal(rows.length,1);assert.equal(rows[0].session_id,'s_fixture_1');assert.equal(posts().length,1);
  assert.equal(await page.locator('.cg-node-initial-settings').isVisible(),false);assert.equal(await page.locator('.cg-node-connected').isVisible(),false);assert.equal(await page.getByRole('button',{name:'AI设置',exact:true}).count(),1);await shot('remote-library-compact-narrow.png');
  report.checks.push('legacy default deletion reaches zero chats without recreation; settings stay accessible and explicit new chat restores one compact gear at 320px');
  await page.evaluate(()=>window.app.destroy());const final=calls.length;await page.waitForTimeout(1400);assert.equal(calls.length,final);assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;await shot('remote-library-failure.png');}
finally{report.catalogCells=projects.length;report.contextReads=calls.filter(c=>c.path==='/api/ai/context').length;report.syntheticModelPosts=posts().length;report.actualModelCalls=0;if(evidence)await writeFile(resolve(evidence,'remote-library-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
