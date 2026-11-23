// Actual environment, bridge and AI-result synchronizer with intercepted,
// explicitly synthetic transport. No model, host, solver, listener or live state.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),built=process.env.WORKBENCH_TEST_ASSETS==='built';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const origin='http://127.0.0.1:18884',reviewOrigin='http://127.0.0.1:8766';
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:560,height:1050}}),page=await context.newPage();
const errors=[],unexpected=[],reviews=[],report={kind:'synthetic-agent-testbench-browser',asset_mode:built?'built':'source',real_model:false,real_ssh:false,real_solver:false,checks:[]};
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(7000);
const remote=built?'/remote':'/apps/web/remote';
const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/modules/simulation/style.css"><style>body{margin:0}.ic-sim-panel{padding:10px;box-sizing:border-box;min-width:0}input,select,textarea{box-sizing:border-box}button{max-width:100%}</style><main class="ic-sim-panel"><div id="environment"></div></main><script type="module">
import {mountEnvironmentWizard} from '/modules/simulation/environment/panel.js';
import {createOnboardingBridge} from '${remote}/onboarding-bridge.js';
import {createOnboardingSync} from '${remote}/onboarding-sync.js';
import {agentSource,agentTestbenchFixture,testbench} from '/tests/studio/agent-testbench.fixture.mjs';
import {analysisSession,analysisCatalog} from '/tests/studio/analysis.fixture.mjs';
window.currentSource=structuredClone(agentSource);window.fixture=agentTestbenchFixture();window.calls=[];window.testbench=testbench;
window.analysisExample=(await (await fetch('/tests/remote/fixtures/onboarding-analysis.example.json')).json()).analysis;
window.spectrumExample=(await (await fetch('/tests/remote/fixtures/onboarding-analysis.spectrum.example.json')).json()).analysis;
window.lutReceipt={schema:'ic.onboarding.pdk-lut.v1',probe_id:'synthetic-probe-0',ssh_target:'synthetic-host',status:'hit',observed_at:'2026-11-22T12:34:56Z',cache_id:'synthetic-cache',fresh_dependency_audit_required:true,remote_freshness_verified:false,ready_to_run:false,network_operations:0,scan_performed:false,missing:[],coverage:{candidate_count:1}};
const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(n=>n.toString(16).padStart(2,'0')).join('');
const inspect=fixture.adapter.inspectNetlist;fixture.adapter.inspectNetlist=async args=>{await inspect(args);const hash=await sha(args.text);fixture.saved={...fixture.saved,source_sha256:hash,source:{...fixture.saved.source,source_sha256:hash}};return fixture.saved;};
const transport={base:location.origin,health:async()=>({connection_id:'synthetic-store',capabilities:{simulation_onboarding:true,simulation_onboarding_api_version:'1'}}),request:async(path,options={})=>{
  calls.push({path,...structuredClone(options)});
  if(path.endsWith('/netlist'))return fixture.adapter.inspectNetlist(options.body);
  if(path.endsWith('/agent-tb/draft'))return fixture.adapter.saveAgentTestbench(options.body);
  if(path.endsWith('/agent-tb/prepare'))return fixture.adapter.prepareAgentTestbench(options.body);
  if(path.endsWith('/discover-pdk')){await fixture.adapter.discoverPdk(options.body);const value=fixture.saved;value.discovery.lut=[{...lutReceipt,status:'refresh_required',scan_performed:true,storage:{schema:'ic.onboarding.pdk-lut.v1',status:'stored',observed_at:'2026-11-23T01:00:00Z'}}];fixture.saved=value;return fixture.saved;}
  if(path.includes('/session?'))return fixture.saved;
  if(path.includes('/waveforms/catalog?')){const s=fixture.saved,w=s.job.waveforms;return {schema:'ic.onboarding.waveforms.v1',operation:'catalog',...Object.fromEntries(['intake_id','job_id','run_id','source_commit','archive_sha256','original_source_sha256','compiled_source_sha256','compiled_source_path','transformation'].map(key=>[key,w[key]])),read_only:true,probe:w.probe,catalog:analysisCatalog(analysisExample)};}
  if(path.endsWith('/analysis'))return structuredClone(analysisExample);
  throw Error('Unexpected synthetic operation '+path);
}};
window.bridge=createOnboardingBridge({win:window,gateway:transport});await bridge.connect();
window.wizard=mountEnvironmentWizard(document.querySelector('#environment'),{adapter:bridge,getSource:()=>currentSource});await wizard.controller.ready;
window.sync=createOnboardingSync({bridge,getSource:()=>currentSource,hashText:sha,interval:60000});sync.register(wizard.controller);
window.authorDraft=async()=>{await fixture.authorDraft();return sync.handleToolResult({tool:'ic_onboarding_agent_tb_draft',result:{ok:true,data:fixture.saved}});};
window.loadAnalysis=async value=>{if(value)analysisExample=value;currentSource={file_name:'example.scs',mode:'agent-tb',text:'subckt Example IN OUT\\nR1 (IN OUT) resistor r=1000\\nends Example\\n'};fixture.saved=analysisSession(fixture.saved,analysisExample);fixture.saved={...fixture.saved,source:{...fixture.saved.source,file_name:'example.scs',requirements:{instances:[],interfaces:[{name:'Example',ports:['IN','OUT']}],required_masters:[],issues:[],confirmation_required:[]}}};await sync.handleToolResult({tool:'ic_onboarding_netlist',result:{ok:true,data:fixture.saved}});};
window.ready=true;
</script>`;
await context.route('**/*',async route=>{
  try{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===reviewOrigin){
      assert.equal(url.pathname,'/agent-tb/review');
      if(request.method()==='POST'){
        reviews.push(request.postDataJSON());
        await page.evaluate(()=>{const s=fixture.saved;fixture.saved={...s,revision:s.revision+1,state:'submitted',agent_tb_review:{...s.agent_tb_review,state:'approved'},job:{...fixture.job(),configuration:'agent-testbench',source_commit:s.prepared.source_commit}};});
        return route.fulfill({contentType:'application/json',body:JSON.stringify({synthetic:true,state:'submitted'})});
      }
      return route.fulfill({contentType:'text/html',body:`<h1>隔离测试：人工审阅表单</h1><p>不会批准或启动真实任务。</p><button id="confirm">模拟人工确认</button><script>document.querySelector('#confirm').onclick=async()=>{await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({synthetic:true,review_id:new URLSearchParams(location.search).get('review_id')})});document.querySelector('#confirm').disabled=true;};</script>`});
    }
    assert.equal(url.origin,origin);if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
    const path=url.pathname.slice(1);assert(['core.js','apps/web/core.js'].includes(path)||/^(modules\/|apps\/web\/remote\/|remote\/|tests\/studio\/|tests\/remote\/fixtures\/)/.test(path),'Unexpected asset '+path);
    const base=built&&!path.startsWith('tests/')?resolve(root,'web'):resolve(root),file=resolve(base,path);assert(file.startsWith(base+sep));
    const body=await readFile(file),mime={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json'};
    await route.fulfill({contentType:mime[extname(file)]||'text/plain',body});
  }catch(error){unexpected.push(error.message);await route.abort();}
});
const button=label=>page.getByRole('button',{name:label,exact:true}),field=key=>page.locator('[data-environment-field="'+key+'"]');
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready);assert.equal(await field('import-mode').inputValue(),'agent-tb');
  await button('导入当前网表').click();await page.waitForFunction(()=>wizard.controller.state.session?.mode==='agent-tb');
  assert.equal(await page.evaluate(()=>calls.find(row=>row.path.endsWith('/netlist')).body.mode),'agent-tb');
  assert.equal(await page.locator('[data-environment-confirm-run]').count(),0);assert.match(await page.locator('[data-agent-testbench]').innerText(),/Agent 编写完整 Spectre/);
  await page.evaluate(async()=>{let s=fixture.saved;await fixture.adapter.probeHost({intake_id:s.intake_id,revision:s.revision,ssh_targets:['synthetic-host']});s=fixture.saved;await fixture.adapter.discoverPdk({intake_id:s.intake_id,revision:s.revision,probe_ids:['synthetic-probe-0']});const value=fixture.saved;value.discovery.lut=[{...lutReceipt,rebound_source_sha256:value.source_sha256}];fixture.saved=value;await sync.handleToolResult({tool:'ic_onboarding_pdk',result:{ok:true,data:fixture.saved}});});
  assert.match(await page.locator('[data-pdk-lut]').innerText(),/命中已有观察/);assert.match(await page.locator('[data-pdk-lut]').innerText(),/2026-11-22T12:34:56Z/);assert.match(await page.locator('[data-pdk-lut]').innerText(),/运行前仍需重新核对/);
  await page.locator('[data-environment-detail="pdk-advanced"]>summary').click();await button('忽略索引并重新扫描').click();await page.waitForFunction(()=>calls.some(row=>row.path.endsWith('/discover-pdk')));
  assert.equal(await page.evaluate(()=>calls.find(row=>row.path.endsWith('/discover-pdk')).body.refresh),true);assert.match(await page.locator('[data-pdk-lut]').innerText(),/本次扫描已保存/);
  report.checks.push('LUT shows observed timestamp and freshness limits; explicit rescan sends refresh:true and retains separate lookup/storage status');
  await page.evaluate(()=>authorDraft());await page.locator('[data-agent-field="code"]').waitFor();
  assert.match(await field('agent-code').inputValue(),/VINP/);assert.match(await field('agent-code').inputValue(),/VINN/);
  await field('agent-code').fill((await field('agent-code').inputValue())+'// local reviewed change\n');
  assert.equal(await button('生成审阅计划').isDisabled(),true);assert.equal(await button('审阅通过并运行仿真').isDisabled(),true);
  await button('保存草稿并撤销旧审阅').click();await page.waitForFunction(()=>!wizard.controller.agentEditor.dirty);
  await button('生成审阅计划').click();await page.waitForFunction(()=>wizard.controller.state.session.agent_tb_review?.state==='pending');
  const popupEvent=page.waitForEvent('popup');await button('审阅通过并运行仿真').click();const popup=await popupEvent;await popup.locator('#confirm').waitFor();
  assert.equal(new URL(popup.url()).origin,reviewOrigin);assert.equal(await popup.evaluate(()=>opener),null);
  assert.equal(await page.evaluate(()=>calls.some(row=>row.path.endsWith('/run'))),false);await popup.locator('#confirm').click();await popup.waitForFunction(()=>document.querySelector('#confirm').disabled);await popup.close();
  await button('刷新当前实验').click();await page.waitForFunction(()=>wizard.controller.state.session.job?.job_id==='synthetic-run');assert.equal(reviews.length,1);
  assert.equal(await page.evaluate(()=>calls.some(row=>row.path.endsWith('/run'))),false);
  report.checks.push('generic two-input circuit and complete Agent-authored Spectre survive editing; a trusted click opens an isolated local form; form confirmation creates one synthetic receipt with zero frontend /run calls');
  await field('agent-code').fill((await field('agent-code').inputValue())+'// local unsaved\n');
  await page.evaluate(async()=>{const s=fixture.saved;await fixture.adapter.saveAgentTestbench({intake_id:s.intake_id,revision:s.revision,testbench:{...s.agent_tb.testbench,text:s.agent_tb.testbench.text+'// agent remote change\n'},selection:s.agent_tb.selection});await sync.handleToolResult({tool:'ic_onboarding_agent_tb_draft',result:{ok:true,data:fixture.saved}});});
  assert.match(await field('agent-code').inputValue(),/local unsaved/);assert.equal(await button('保存草稿并撤销旧审阅').isDisabled(),true);assert.match(await page.locator('[data-agent-testbench]').innerText(),/你的本地修改仍保留/);
  await button('读取后台新草稿').click();assert.match(await field('agent-code').inputValue(),/agent remote change/);
  report.checks.push('remote Agent draft changes preserve local edits and block stale review until explicit reconciliation');
  await page.evaluate(()=>loadAnalysis());await button('读取此任务信号').waitFor();await button('读取此任务信号').click();await field('analysis-operation').waitFor();
  assert.match(await field('analysis-input-samples').innerText(),/out · V/);
  await page.evaluate(()=>sync.handleToolResult({tool:'ic_onboarding_analysis',result:{ok:true,data:analysisExample}}));
  await page.locator('[data-analysis-metric="sndr_db"]').waitFor();assert.match(await page.locator('[data-analysis-metric="sndr_db"]').innerText(),/65/);assert.match(await page.locator('[data-analysis-panel]').innerText(),/21 个原始样本/);
  assert.match(await page.locator('[data-analysis-panel]').innerText(),/探索性分析/);
  const initial=await page.locator('[data-analysis-id]').getAttribute('data-analysis-id');
  await page.evaluate(()=>sync.handleToolResult({tool:'ic_onboarding_analysis',result:{ok:true,data:{...analysisExample,job_id:'foreign-run'}}}));assert.equal(await page.locator('[data-analysis-id]').getAttribute('data-analysis-id'),initial);
  await page.evaluate(()=>loadAnalysis(spectrumExample));await button('读取此任务信号').click();await field('analysis-operation').waitFor();
  await field('analysis-backend').selectOption('spiceowl');await field('analysis-input-samples').selectOption(await page.evaluate(()=>analysisExample.request.inputs.samples));
  await page.locator('[data-environment-detail="analysis-options"]>summary').click();
  await field('analysis-parameters').fill(await page.evaluate(()=>{const value={...analysisExample.request.parameters};delete value.backend;return JSON.stringify(value);}));
  await field('analysis-criteria').fill(await page.evaluate(()=>JSON.stringify(analysisExample.request.criteria)));
  await button('分析原始数据').click();await page.locator('[data-analysis-spectrum] svg').waitFor();assert(!/NaN|Infinity/.test(await page.locator('.ic-env-spectrum-line').getAttribute('d')));
  assert.match(await page.locator('[data-analysis-spectrum]').innerText(),/dBFS\/bin/);
  assert.equal(await page.evaluate(()=>calls.filter(row=>row.path.endsWith('/analysis')).length),1);
  assert.deepEqual(await page.evaluate(()=>calls.find(row=>row.path.endsWith('/analysis')).body.parameters),await page.evaluate(()=>analysisExample.request.parameters));
  for(const width of [320,560,1000]){await page.setViewportSize({width,height:1050});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  report.checks.push('actual full-resolution serializer result renders units, scientific status and provenance; wrong-run analysis is rejected; actual SpiceOwl FFT serializer fixture on synthetic coherent samples renders responsively in dBFS/bin after an exact UI request');
  const output=process.env.EVIDENCE_DIR||'/tmp/circuitgit-agent-testbench-browser';await mkdir(output,{recursive:true});await page.screenshot({path:resolve(output,'agent-testbench-analysis.png'),fullPage:true});
  await page.evaluate(async()=>{const s=fixture.saved;fixture.saved={...s,revision:s.revision+1,state:'recovery_required',recovery:{status:'interrupted',operation:'discover-pdk',operation_id:'e'.repeat(32),started_at:'2026-11-23T02:00:00Z',requires_human:true,automatic_retry:false,original_records_preserved:true}};await sync.handleToolResult({tool:'ic_onboarding_session',result:{ok:true,data:fixture.saved}});});
  await page.locator('[data-environment-interrupted]').waitFor();assert.match(await page.locator('[data-environment-interrupted]').innerText(),/discover-pdk/);assert.equal(await button('分析原始数据').isDisabled(),true);assert.equal(await button('核对原会话').isEnabled(),true);assert.equal(await page.evaluate(()=>wizard.controller.state.busy),null);
  const beforeRecovery=await page.evaluate(()=>calls.length);await page.evaluate(async()=>{try{await bridge.discoverPdk({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision,probe_ids:['synthetic-probe-0']});throw Error('Expected recovery_required');}catch(error){if(error.data?.code!=='recovery_required')throw error;}});assert.equal(await page.evaluate(()=>calls.length),beforeRecovery);
  report.checks.push('interrupted operation displays original identity, ends the busy state and blocks writes before transport while keeping explicit session readback available');
  await page.evaluate(()=>{sync.destroy();wizard.destroy();bridge.disconnect();localStorage.clear();});
  await page.reload();await page.waitForFunction(()=>window.ready);await field('import-mode').selectOption('legacy');await button('导入当前网表').click();await page.waitForFunction(()=>wizard.controller.state.intake.status==='complete');
  assert.equal(await page.evaluate(()=>Object.hasOwn(calls.find(row=>row.path.endsWith('/netlist')).body,'mode')),false);assert.equal(await page.evaluate(()=>wizard.controller.state.session.mode),'legacy');
  report.checks.push('explicit legacy selection overrides an incoming source agent-tb hint and does not alter legacy controller semantics');
  await page.evaluate(()=>{sync.destroy();wizard.destroy();bridge.disconnect();});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){console.error(JSON.stringify({errors,unexpected,body:await page.locator('body').innerText()}));throw error;}finally{await browser.close();}
