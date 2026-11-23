// Built demo, real Dockview/AI/environment components, fully intercepted transport.
// All account, model, host, PDK and run responses below are synthetic fixtures.
// No real model, SSH, simulator, listener, user browser or saved runtime is used.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {environmentFixture,source} from '../studio/environment.fixture.mjs';
import {simulationReport} from '../studio/simulation-report.fixture.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),web=resolve(root,'web');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const origin='https://onboarding-ai.test',helper='http://127.0.0.1:8767',prefix='/CircuitGit/',token='x'.repeat(43);
const sourceHash=createHash('sha256').update(source.text).digest('hex'),fixture=environmentFixture({withRecommendation:true});
await fixture.adapter.inspectNetlist(source);fixture.saved={...fixture.saved,source_sha256:sourceHash,source:{...fixture.saved.source,source_sha256:sourceHash}};
const initial=structuredClone(fixture.saved),connectionId=initial.connection_id;
await fixture.adapter.probeHost({intake_id:initial.intake_id,revision:1,ssh_targets:['synthetic-host']});
await fixture.adapter.discoverPdk({intake_id:initial.intake_id,revision:2,probe_ids:['synthetic-probe-0']});
const recommendation=structuredClone(fixture.saved),choice=recommendation.recommended_selection;
await fixture.adapter.prepareExperiment({intake_id:initial.intake_id,revision:3,accept_recommendation:true,recommendation_id:choice.recommendation_id,recommendation_revision:3});
await fixture.adapter.runPrepared({intake_id:initial.intake_id,revision:4,plan_id:fixture.saved.prepared.plan_id});
const completed={...structuredClone(fixture.saved),state:'complete',job:{...fixture.saved.job,state:'completed'}};
let saved=structuredClone(initial),sequence=0;
const calls=[],events=[],errors=[],unexpected=[];
const history={session_id:'default',state:'idle',cursor:0,pending:[],messages:[],turns:[],recovery:{can_resume:false,reason:'not_terminal',expected_turn_id:null}};
const report={kind:'synthetic-built-onboarding-ai-integration',real_network:false,real_model:false,real_ssh:false,real_simulation:false,checks:[]};
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1500,height:1000}}),page=await context.newPage();
context.on('page',p=>p.on('pageerror',error=>errors.push(error.message)));page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
const mime={'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html','.svg':'image/svg+xml','.wasm':'application/wasm','.woff2':'font/woff2','.png':'image/png'};
const reply=(route,data)=>route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':origin},body:JSON.stringify({ok:true,data})});
await context.route('**/*',async route=>{
  try{
    const req=route.request(),url=new URL(req.url());
    if(url.origin===origin){
      assert(url.pathname.startsWith(prefix));const file=resolve(web,url.pathname.slice(prefix.length));assert(file.startsWith(web+sep));
      let body=await readFile(file);
      if(url.pathname.endsWith('/demo/main.js'))body=body.toString().replace('  return host;','  window.fixtureHost=host;return host;');
      // Delay the periodic fallback so the assertions exercise AI tool/result sync.
      if(url.pathname.endsWith('/remote/onboarding-sync.js'))body=body.toString().replace('interval=2500','interval=60000');
      return route.fulfill({contentType:mime[extname(file)]||'application/octet-stream',body});
    }
    assert.equal(url.origin,helper,'Unexpected network origin');
    if(url.pathname==='/connect'){
      const state=url.searchParams.get('state');
      return route.fulfill({contentType:'text/html',body:`<button id="allow">允许模拟连接</button><script>opener.postMessage({type:'circuitgit.local.ready',state:${JSON.stringify(state)}},${JSON.stringify(origin)});document.querySelector('#allow').onclick=()=>opener.postMessage({type:'circuitgit.local.result',state:${JSON.stringify(state)},allowed:true,accessCode:${JSON.stringify(token)},endpoint:${JSON.stringify(helper)}},${JSON.stringify(origin)});</script>`});
    }
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Private-Network':'true'}});
    assert.equal(req.headers().authorization,'Bearer '+token);
    const method=req.method(),path=url.pathname,body=method==='POST'?req.postDataJSON():null;calls.push({method,path,body,query:url.search});
    if(path==='/node/info')return reply(route,{schema:'circuitgit.remote-node.v1',single_owner:true,auth:'bearer',connection_id:connectionId,capabilities:{chat:true,local_login:true,simulation_onboarding:true,simulation_onboarding_api_version:'1'}});
    if(path==='/api/ai/catalog')return reply(route,{projects:[]});
    if(path==='/api/ai/auth/status')return reply(route,{account:{account_type:'chatgpt',plan_type:'Synthetic',login_status:'signed_in'},can_login:false,login_state:'idle'});
    if(path==='/api/ai/sessions')return reply(route,{sessions:[{session_id:'default',name:'Synthetic conversation',state:history.state,pending_approval_count:0,suspended_approval_count:0,can_delete:false}],max_sessions:8});
    if(path==='/api/ai/models')return reply(route,{default_model:'synthetic-model',models:[{id:'synthetic-model',model:'synthetic-model',displayName:'Synthetic model',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}],inputModalities:['text']}]});
    if(path==='/api/ai/development')return reply(route,{available:false,workspace:null,access:'manual',reason:'synthetic_unavailable',can_configure:false});
    if(path==='/api/ai/history')return reply(route,history);
    if(path==='/api/ai/events')return reply(route,{state:history.state,cursor:sequence,events:events.filter(item=>item.sequence>Number(url.searchParams.get('after')||0)),pending:[],recovery:history.recovery});
    if(path==='/api/ai/turn'){
      assert.equal(method,'POST');assert.equal(body.context.onboarding.intake_id,saved.intake_id);assert.equal(body.context.onboarding.connection_id,connectionId);assert.equal(body.context.onboarding.source_sha256,sourceHash);
      const turn={key:body.idempotency_key,state:'running',thread_id:'synthetic-thread',turn_id:'synthetic-turn-'+(history.turns.length+1),selected_model_id:'synthetic-model',reasoning_effort:'low',permission_mode:'manual'};
      Object.assign(history,{state:'running',active_request_key:turn.key,active_turn_id:turn.turn_id});history.turns.push(turn);return reply(route,turn);
    }
    if(path==='/api/simulation/onboarding/netlist'){
      assert.equal(method,'POST');assert.deepEqual(body,{file_name:source.file_name,text:source.text});return reply(route,saved);
    }
    if(path==='/api/simulation/onboarding/session'){
      assert.equal(method,'GET');assert.equal(url.searchParams.get('intake_id'),saved.intake_id);return reply(route,saved);
    }
    assert.fail('Unexpected operation '+method+' '+path);
  }catch(error){unexpected.push(error.message);await route.abort();}
});
const turnPosts=()=>calls.filter(row=>row.path==='/api/ai/turn');
const emit=(method,params)=>events.push({sequence:++sequence,method,params,request_key:history.active_request_key,thread_id:'synthetic-thread',turn_id:history.active_turn_id});
const active=()=>page.locator('.ic-ai-session-panel:not([hidden])');
const openSource=async(value=source)=>page.evaluate(async({value,url})=>{const module=await import(url);await module.openSource({name:value.file_name,path:'/'+value.file_name,text:value.text},false);},{value,url:origin+prefix+'vendor/rnl-viewer/open.js'});
const waitSync=revision=>page.waitForFunction(revision=>fixtureHost.onboarding.getSessionState()?.revision===revision,revision);
try{
  await page.goto(origin+prefix+'studio/index.html?demo=1&layout=dockview');
  await page.waitForFunction(()=>window.fixtureHost&&document.body.dataset.workbenchState==='ready');await openSource();
  const wizard=page.locator('.studio-panel-simulation [aria-label="环境与 PDK 向导"]');await wizard.waitFor();assert.equal(calls.length,0);
  await page.getByRole('button',{name:'AI连接设置',exact:true}).click();const popupEvent=page.waitForEvent('popup');
  await page.getByRole('button',{name:'连接本机 Codex',exact:true}).click();const popup=await popupEvent;await popup.locator('#allow').click();
  await page.waitForFunction(()=>fixtureHost.onboarding.getState().connected);
  await page.getByRole('button',{name:'打开对话',exact:true}).waitFor();
  assert.equal(calls.filter(row=>row.path==='/node/info').length,1);assert.equal(await wizard.getByRole('button',{name:'连接本机环境服务',exact:true}).count(),0);
  report.checks.push('one explicit AI pairing shares its authorized helper client with the inline Simulation panel, including an empty project catalog');

  await wizard.getByRole('button',{name:'导入当前网表',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('select[aria-label="运行节点项目"]')?.value==='onboarding:synthetic-intake');
  assert.match(await wizard.locator('[data-environment-step="1"]').innerText(),/synthetic\.scs.*2 个器件/);
  const projects=page.getByRole('combobox',{name:'运行节点项目',exact:true});assert.match(await projects.innerText(),/当前网表 · synthetic\.scs/);
  await page.getByRole('button',{name:'打开对话',exact:true}).click();await active().getByRole('textbox',{name:'发送给电路助手的消息'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-model')?.options.length>0);
  const input=active().getByRole('textbox',{name:'发送给电路助手的消息'});
  assert.equal(await page.evaluate(()=>fixtureHost.onboarding.getSessionState().revision),1);
  const readsBeforeSend=calls.filter(row=>row.path==='/api/simulation/onboarding/session').length;
  saved={...saved,revision:2};
  await input.fill('Synthetic test: inspect the current netlist.');await input.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.ic-ai-session-panel:not([hidden]) .ic-ai-delivery')?.textContent==='已提交');
  assert.equal(turnPosts().length,1);const sent=turnPosts()[0].body.context;
  assert.equal(sent.project.id,'onboarding:'+initial.intake_id);assert.equal(sent.file.path,source.file_name);assert.equal(sent.file.persistedSha256,sourceHash);assert.equal(sent.onboarding.revision,2);
  assert.equal(calls.some(row=>row.path==='/api/ai/context'),false);
  report.checks.push('current-netlist choice sends the same source hash, intake, connection and revision as Simulation without a registered project');
  assert(calls.filter(row=>row.path==='/api/simulation/onboarding/session').length>readsBeforeSend);
  assert.equal(await page.evaluate(()=>fixtureHost.onboarding.getSessionState().revision),2);
  report.checks.push('sending refreshes cached revision 1 against backend revision 2 and uses revision 2 in the exact intake context');

  for(const [index,patch]of [{connection_id:'foreign-store'},{intake_id:'foreign-intake'},{source_sha256:'d'.repeat(64)}].entries())emit('tool/result',{tool:'ic_onboarding_pdk',call_id:'foreign-'+index,result:{ok:true,data:{...recommendation,...patch}}});
  await page.waitForFunction(()=>[...document.querySelectorAll('.ic-ai-steps summary')].filter(node=>node.textContent.includes('工具返回 ic_onboarding_pdk')).length===3);
  assert.equal(await page.evaluate(()=>fixtureHost.onboarding.getSessionState().revision),2);assert.doesNotMatch(await wizard.locator('[data-environment-recommendation]').innerText(),/Synthetic PDK candidate/);
  report.checks.push('foreign connection, intake and source tool results leave the current experiment unchanged');

  saved=structuredClone(recommendation);emit('tool/result',{tool:'ic_onboarding_pdk',call_id:'same-intake-pdk',result:{ok:true,data:saved}});
  await page.waitForFunction(()=>document.querySelector('[data-environment-recommendation]')?.textContent.includes('Synthetic PDK candidate'));await waitSync(3);
  assert.match(await wizard.locator('[data-environment-recommendation]').innerText(),/Synthetic PDK candidate/);
  assert.equal(await wizard.getByRole('button',{name:'确认并运行',exact:true}).isEnabled(),true);
  assert.equal(calls.some(row=>/\/(probe|pdk|prepare|run)$/.test(row.path)),false);
  report.checks.push('AI result for the selected intake reads back the exact revision and updates the PDK recommendation without automatic submission');

  saved=structuredClone(completed);emit('tool/result',{tool:'ic_onboarding_inspect',call_id:'same-intake-job',result:{ok:true,data:saved}});
  await wizard.locator('[data-report-dimension]').first().waitFor();await waitSync(5);
  assert.equal(await wizard.locator('[data-report-dimension]').count(),5);assert.match(await wizard.innerText(),/synthetic-run/);
  assert.equal(await wizard.getByRole('button',{name:'查看波形',exact:true}).isDisabled(),true);
  report.checks.push('same-intake saved run updates the five report dimensions; unavailable waveform evidence remains unavailable');

  await wizard.locator('[data-environment-detail="experiment-advanced"]>summary').click();
  const supply=wizard.locator('[data-environment-field="intent-supply_v"]');await supply.fill('0.9');await supply.press('Tab');
  saved={...saved,job:{...saved.job,report:simulationReport('synthetic-run')}};
  emit('tool/result',{tool:'ic_onboarding_inspect',call_id:'same-revision-report',result:{ok:true,data:saved}});
  await wizard.locator('[data-report-dimension="execution_status"][data-report-status="completed"]').waitFor();
  assert.equal(await page.evaluate(()=>fixtureHost.onboarding.getSessionState().revision),5);
  assert.equal(await supply.inputValue(),'0.9');assert.equal(await wizard.locator('[data-report-dimension="measurement_validity"]').getAttribute('data-report-status'),'valid');
  assert.equal(await wizard.locator('[data-report-dimension="operating_qualification"]').getAttribute('data-report-status'),'violations_detected');
  report.checks.push('same-revision inspect updates the report while retaining a user-edited 0.9 V draft and the original run identity');

  emit('turn/completed',{threadId:'synthetic-thread',turn:{id:history.active_turn_id,status:'completed'}});history.state='complete';history.turns.at(-1).state='complete';
  await page.waitForFunction(()=>document.querySelector('.ic-ai-session-panel:not([hidden]) button[type="submit"]')?.disabled===false);
  await openSource({file_name:'replacement.scs',text:source.text+'// changed source\n'});
  await page.waitForFunction(()=>![...document.querySelector('select[aria-label="运行节点项目"]').options].some(option=>option.value.startsWith('onboarding:')));
  const before=turnPosts().length;await input.fill('Synthetic test: do not send the old source.');await input.press('Enter');
  await active().getByText('当前网表已变化，请重新选择后发送。',{exact:true}).waitFor();
  assert.equal(turnPosts().length,before);assert.equal(await input.inputValue(),'Synthetic test: do not send the old source.');
  emit('tool/result',{tool:'ic_onboarding_pdk',call_id:'old-source-after-switch',result:{ok:true,data:{...recommendation,revision:6}}});
  await page.waitForFunction(()=>[...document.querySelectorAll('.ic-ai-steps summary')].filter(node=>node.textContent.includes('工具返回 ic_onboarding_pdk')).length===5);
  assert.equal(await page.evaluate(()=>fixtureHost.onboarding.getSessionState().revision),5);
  report.checks.push('changing the displayed source removes the old AI choice, blocks stale sends and ignores late old-source results');

  await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();});saved=structuredClone(initial);events.length=0;sequence=0;
  Object.assign(history,{state:'idle',cursor:0,messages:[],turns:[]});delete history.active_request_key;delete history.active_turn_id;
  const beforeCanvas=calls.length;await page.reload();await page.waitForFunction(()=>window.fixtureHost&&document.body.dataset.workbenchState==='ready');await openSource();
  await page.getByRole('button',{name:'AI连接设置',exact:true}).click();const secondPair=page.waitForEvent('popup');
  await page.getByRole('button',{name:'连接本机 Codex',exact:true}).click();await(await secondPair).locator('#allow').click();
  await page.getByRole('button',{name:'打开对话',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>fixtureHost.onboarding.getState().selectedIntakeId),null);
  assert.equal(calls.slice(beforeCanvas).some(row=>row.path==='/api/simulation/onboarding/netlist'),false);
  await page.getByRole('button',{name:'使用当前电路',exact:true}).click();await active().getByRole('textbox',{name:'发送给电路助手的消息'}).waitFor();
  const canvasCalls=calls.slice(beforeCanvas),canvasImports=canvasCalls.filter(row=>row.path==='/api/simulation/onboarding/netlist');
  assert.equal(canvasImports.length,1);assert.deepEqual(canvasImports[0].body,source);
  assert.equal(await page.evaluate(()=>fixtureHost.onboarding.getSessionState().source_sha256),sourceHash);
  assert.equal(await page.locator('select[aria-label="运行节点项目"]').inputValue(),'onboarding:'+initial.intake_id);
  assert.equal(canvasCalls.some(row=>row.path==='/api/ai/context'||row.path==='/api/ai/turn'),false);
  report.checks.push('first-use current-circuit button imports the displayed source and opens AI with an empty catalog without a fallback circuit or model call');

  assert.equal(calls.filter(row=>row.method==='POST'&&!['/api/ai/turn','/api/simulation/onboarding/netlist'].includes(row.path)).length,0);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;report.sourceSnapshot=await page.evaluate(()=>({current:fixtureHost.getOnboardingSource(),files:viewer.doc?.files,path:viewer.doc?.path})).catch(()=>null);process.exitCode=1;}
finally{
  report.calls=calls;report.errors=errors;report.unexpected=unexpected;
  const output=process.env.EVIDENCE_DIR||'/tmp/circuitgit-onboarding-ai';await mkdir(output,{recursive:true});
  await page.screenshot({path:resolve(output,'onboarding-ai.png')});await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify(report));
}
