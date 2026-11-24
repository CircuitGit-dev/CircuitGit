// Intercepted synthetic observations only; no AI, SSH, simulator or real server.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const files=[...(await readdir(resolve(root,'modules/simulation'),{recursive:true})).filter(path=>/\.(js|css)$/.test(path)).map(path=>'modules/simulation/'+path),'modules/schematic/netlist.js','modules/schematic/instance-properties.js','tests/studio/environment.fixture.mjs','tests/studio/agent-testbench.fixture.mjs','tests/studio/runtime.fixture.mjs'];
const assets=new Map(await Promise.all(files.map(async path=>['/'+path,await readFile(resolve(root,path),'utf8')])));
const html=`<!doctype html><meta charset="utf-8"><div id="environment"></div><div id="runtime"></div><script type="module">
import {mountEnvironmentWizard} from '/modules/simulation/environment/panel.js';
import {mountRuntime} from '/modules/simulation/runtime.js';
import {agentTestbenchFixture,agentSource} from '/tests/studio/agent-testbench.fixture.mjs';
import {runtimeFixture} from '/tests/studio/runtime.fixture.mjs';
window.requests=[];window.notices=[];window.fixture=agentTestbenchFixture();window.agentSource=agentSource;window.runFixture=runtimeFixture();
const requestAgentAssistance=request=>{requests.push(structuredClone(request));return {status:'prepared'};};
window.wizard=mountEnvironmentWizard(document.getElementById('environment'),{adapter:fixture.adapter,requestAgentAssistance,notify:message=>notices.push(message)});
window.runtime=mountRuntime(document.getElementById('runtime'),{host:runFixture.host,requestAgentAssistance});
</script>`;

test('explicit assistance clicks prepare bounded drafts without model, mutation or connection actions',async()=>{
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'}),page=await browser.newPage(),errors=[],unexpected=[];
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!=='https://assistance.test'||url.pathname!=='/'&&!assets.has(url.pathname)){unexpected.push(url.href);return route.abort();}await route.fulfill({status:200,contentType:url.pathname==='/'?'text/html':url.pathname.endsWith('.css')?'text/css':'text/javascript',body:url.pathname==='/'?html:assets.get(url.pathname)});});
  try{
    await page.goto('https://assistance.test/');await page.locator('[data-runtime-run="run-1"]').waitFor();
    assert.equal(await page.evaluate(()=>requests.length),0);
    const before=await page.evaluate(()=>fixture.calls.length);
    await page.locator('#environment [data-agent-assistance="environment"]').click();
    assert.equal(await page.evaluate(()=>requests[0].context.binding.status),'unbound');assert.equal(await page.evaluate(()=>fixture.calls.length),before);
    await page.evaluate(()=>wizard.importSource(agentSource));const calls=await page.evaluate(()=>fixture.calls.length);
    await page.locator('#environment [data-agent-assistance="testbench"]').click();
    assert.deepEqual(await page.evaluate(()=>[requests[1].kind,requests[1].context.binding.intake_id,requests[1].context.binding.revision]),['testbench','synthetic-intake',1]);
    assert.equal(await page.evaluate(()=>fixture.calls.length),calls);
    await page.locator('#runtime [data-agent-assistance="diagnosis"]').click();
    assert.deepEqual(await page.evaluate(()=>[requests[2].kind,requests[2].context.run.run_id,requests[2].context.run.project_id]),['diagnosis','run-1','p']);
    assert.equal(await page.evaluate(()=>runFixture.calls.filter(row=>row.options?.method==='POST'||row.kind?.endsWith('callback')).length),0);
    await page.evaluate(async()=>{const plan=fixture.plan();fixture.saved={...fixture.saved,revision:fixture.saved.revision+1,state:'submitted',source_commit:plan.source_commit,prepared:plan,job:fixture.job(),execution_scope:{selected_ssh_targets:['synthetic-host'],candidate_host_ids:['synthetic-host-id'],selection_mode:'automatic_within_selected_hosts',resource_check_at_run:true}};await wizard.refreshCurrent(wizard.controller.currentBinding);});
    const observedCalls=await page.evaluate(()=>fixture.calls.length);
    await page.locator('#environment [data-agent-assistance="diagnosis"]').click();
    assert.deepEqual(await page.evaluate(()=>[requests[3].kind,requests[3].context.binding.intake_id,requests[3].context.run.run_id]),['diagnosis','synthetic-intake','synthetic-run']);
    assert.equal(await page.evaluate(()=>fixture.calls.length),observedCalls);
    await page.evaluate(()=>{window.oldDiagnosis=document.querySelector('#runtime [data-agent-assistance="diagnosis"]');runFixture.switchProject('new-project');oldDiagnosis.click();});
    await page.waitForFunction(()=>runFixture.calls.some(row=>row.kind==='notify'&&row.message.includes('项目已变化')));assert.equal(await page.evaluate(()=>requests.length),4);
    await page.evaluate(async()=>{wizard.destroy();const {mountEnvironmentWizard}=await import('/modules/simulation/environment/panel.js');window.wizard=mountEnvironmentWizard(document.getElementById('environment'));});
    assert.equal(await page.locator('#environment [data-agent-assistance="environment"]').isDisabled(),true);
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  }finally{await page.evaluate(()=>{wizard.destroy();runtime.destroy();}).catch(()=>{});await browser.close();}
});
