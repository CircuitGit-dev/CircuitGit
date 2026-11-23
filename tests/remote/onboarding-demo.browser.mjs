// Built demo shell + the real onboarding transport and waveform renderer.
// Helper responses are the recorded synthetic native-reader contract; every
// browser request is intercepted. No helper, SSH, simulator or model is started.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),web=resolve(root,'web');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const record=JSON.parse(await readFile(new URL('./fixtures/onboarding-waveforms.example.json',import.meta.url),'utf8'));
const descriptor=record.descriptor,planId='b'.repeat(64),connectionId='synthetic-demo-store';
const intake={schema:'ic.onboarding.session.v1',connection_id:connectionId,intake_id:descriptor.intake_id,revision:4,source_sha256:descriptor.original_source_sha256,source_commit:descriptor.source_commit,
  prepared:{schema:'ic.experiment.plan.v1',state:'prepared',plan_id:planId,source_commit:descriptor.source_commit,project_id:descriptor.intake_id,recipe_id:'synthetic'},
  source_mapping:{source_commit:descriptor.source_commit,source_id:descriptor.compiled_source_path,original_source_sha256:descriptor.original_source_sha256,compiled_source_sha256:descriptor.compiled_source_sha256,transformation:descriptor.transformation}};
const job={schema:'ic.experiment.job.v1',plan_id:planId,project_id:descriptor.intake_id,configuration:'synthetic',job_id:descriptor.job_id,run_id:descriptor.run_id,source_commit:descriptor.source_commit,state:'synthetic_fixture',waveforms:descriptor};
const origin='https://onboarding-demo.test',helper='http://127.0.0.1:18885',prefix='/CircuitGit/',calls=[],errors=[];
const mime={'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html','.svg':'image/svg+xml','.wasm':'application/wasm','.woff2':'font/woff2'};
let foreign=false;
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext(),page=await context.newPage({viewport:{width:1500,height:980}});
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===origin){
    assert(url.pathname.startsWith(prefix));const path=resolve(web,url.pathname.slice(prefix.length));assert(path.startsWith(web+sep));
    if(url.pathname.endsWith('/demo/release.json'))return route.fulfill({contentType:'application/json',body:'{"commits":[]}'});
    let body=await readFile(path);
    // Expose the existing returned host only inside this intercepted fixture.
    if(url.pathname.endsWith('/demo/main.js'))body=body.toString().replace('  return host;','  window.fixtureHost=host;return host;');
    return route.fulfill({contentType:mime[extname(path)]||'application/octet-stream',body});
  }
  assert.equal(url.origin,helper,'Unexpected network request');
  if(url.pathname==='/connect'){
    const state=url.searchParams.get('state');
    return route.fulfill({contentType:'text/html',body:`<button id="allow">允许并连接</button><script>opener.postMessage({type:'circuitgit.local.ready',state:${JSON.stringify(state)}},${JSON.stringify(origin)});document.querySelector('#allow').onclick=()=>opener.postMessage({type:'circuitgit.local.result',state:${JSON.stringify(state)},allowed:true,accessCode:'${'x'.repeat(43)}'},${JSON.stringify(origin)});</script>`});
  }
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Private-Network':'true'}});
  calls.push({path:url.pathname,query:url.search,method:request.method()});let data;
  if(url.pathname==='/node/info')data={schema:'circuitgit.remote-node.v1',single_owner:true,auth:'bearer',connection_id:connectionId,capabilities:{chat:false,simulation_onboarding:true,simulation_onboarding_api_version:'1'}};
  else if(url.pathname==='/api/simulation/onboarding/netlist')data=intake;
  else {const found=record.requests.find(row=>row.path===url.pathname);assert(found,'Unexpected helper request');data=structuredClone(found.response.data);if(foreign)data.run_id='foreign-run';}
  return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':origin},body:JSON.stringify({ok:true,data})});
});
const report={kind:'synthetic-built-demo-integration',real_ssh:false,real_simulation:false,real_inference:false,checks:[]};
try{
  await page.goto(origin+prefix+'vendor/rnl-viewer/index.html?studio=1&layout=dockview&demo=1');
  await page.waitForFunction(()=>window.fixtureHost&&document.body.dataset.studioState==='ready',null,{timeout:45000});
  await page.waitForSelector('.wf-trace[data-trace="vout:1"]');
  const originalContext=await page.evaluate(()=>fixtureHost.context.getContext());
  const wizard=page.locator('.studio-panel-simulation [aria-label="环境与 PDK 向导"]');await wizard.waitFor();
  assert.equal(await page.getByRole('dialog',{name:'连接仿真环境',exact:true}).count(),0);
  assert.equal(await page.locator('.studio-panel-simulation [data-page="reference"]').isVisible(),false);
  assert.equal(calls.length,0,'Default inline environment must not connect or discover');
  await page.evaluate(()=>window.fixtureWizard=document.querySelector('[aria-label="环境与 PDK 向导"]'));
  await page.evaluate(()=>ICStudioDock.api.getPanel('simulation').api.close());
  await page.evaluate(()=>window.viewer.command('simulation.environment'));
  await wizard.waitFor();assert.equal(await page.evaluate(()=>fixtureWizard===document.querySelector('[aria-label="环境与 PDK 向导"]')),true);
  await page.locator('.studio-panel-simulation [data-field="page-reference"]').click();await page.locator('#demo-r').fill('2400');
  await page.locator('.studio-panel-simulation [data-field="page-environment"]').click();
  assert.equal(calls.length,0,'Opening the wizard cannot discover or connect');
  await wizard.locator('[data-environment-field="connection-port"]').fill('18885');await wizard.locator('[data-environment-field="connection-port"]').press('Tab');
  const popupReady=page.waitForEvent('popup');await wizard.getByRole('button',{name:'连接本机环境服务',exact:true}).click();const popup=await popupReady;await popup.locator('#allow').click();
  await page.waitForFunction(()=>fixtureHost.onboarding.getState().connected);assert.deepEqual(calls.map(row=>row.path),['/node/info']);
  await page.locator('.studio-panel-simulation [data-field="page-reference"]').click();assert.equal(await page.locator('#demo-r').inputValue(),'2400');
  report.checks.push('default inline environment stays mounted across close/reopen and RC switching; explicit pairing uses selected port');
  await page.evaluate(async({source,intake,job})=>{window.fixturePayload={intake,job};await fixtureHost.onboarding.inspectNetlist({file_name:'synthetic.scs',text:source});},{source:record.source_text,intake,job});
  foreign=true;
  const rejection=await page.evaluate(async()=>{try{await fixtureHost.openOnboardingWaveforms(fixturePayload);return null;}catch(error){return error.message;}});
  assert.match(rejection,/不一致/);assert.equal(await page.locator('.wf-trace').count(),2,'Rejected wave data must leave RC curves visible');
  foreign=false;await page.evaluate(()=>fixtureHost.openOnboardingWaveforms(fixturePayload));
  await page.getByRole('dialog',{name:'添加信号',exact:true}).waitFor();await page.locator(`[data-signal-id="${descriptor.available_signal_ids[0]}"]`).click();await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('.wf-status')?.textContent.includes('已加载真实运行数据'));
  assert.equal(await page.locator('.wf-trace').count(),1);assert.deepEqual(await page.evaluate(()=>fixtureHost.context.getContext()),originalContext);
  report.checks.push('actual transport unwraps verified saved waveform into real viewer without rebinding the RC schematic');
  const before=calls.length;await page.evaluate(()=>fixtureHost.onboarding.disconnect());await page.locator('.wf-plot').focus();await page.keyboard.press('+');
  await page.waitForFunction(()=>document.querySelector('.wf-status')?.textContent.includes('连接已变化'));assert.equal(calls.length,before);assert.equal(await page.locator('.wf-trace').count(),1);
  report.checks.push('disconnect preserves the curve and refuses further helper reads');
  await page.evaluate(()=>window.viewer.command('project.reference'));await page.waitForSelector('.wf-trace[data-trace="vout:1"]');assert.equal(await page.locator('.wf-trace').count(),2);
  report.checks.push('explicit return destroys independent waveform handle and restores RC references');
  const beforeImport=calls.length;
  await page.evaluate(async({text,url})=>{const {openSource}=await import(url);await openSource({name:'imported.scs',path:'/imported.scs',text},false);},{text:record.source_text,url:origin+prefix+'vendor/rnl-viewer/open.js'});
  await wizard.waitFor();assert.equal(await page.locator('.studio-panel-simulation [data-field="page-reference"]').isDisabled(),true);
  assert.equal(await page.locator('.wf-trace').count(),0);assert.equal(calls.length,beforeImport);
  assert.equal(await page.evaluate(()=>fixtureHost.context.getContext().project.id),'imported-netlist');
  report.checks.push('opening a separate netlist selects inline environment and removes unrelated RC curves without importing or probing');
  assert.equal(calls.some(row=>row.path.includes('/ai/')),false);assert.deepEqual(errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;}
finally{report.calls=calls;report.errors=errors;const output=process.env.EVIDENCE_DIR||'/tmp/circuitgit-onboarding-demo';await mkdir(output,{recursive:true});await page.screenshot({path:resolve(output,'onboarding-demo.png')});await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify(report));}
