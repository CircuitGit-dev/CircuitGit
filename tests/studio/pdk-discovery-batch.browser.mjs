// Intercepted assets and synthetic host observations only. No network host,
// PDK installation, model, solver or real discovery request is used.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),origin='http://127.0.0.1:18928';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:560,height:1000}}),page=await context.newPage(),errors=[],unexpected=[];
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(7000);
const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/modules/simulation/style.css"><style>body{margin:0}</style><main class="ic-sim-panel"><div id="environment"></div></main><script type="module">
import {mountEnvironmentWizard} from '/modules/simulation/environment/panel.js';
import {environmentFixture,source} from '/tests/studio/environment.fixture.mjs';
window.fixture=environmentFixture();window.wizard=mountEnvironmentWizard(document.querySelector('#environment'),{adapter:fixture.adapter});await wizard.controller.ready;await wizard.controller.importSource({...source,mode:'agent-tb'});
const discover=fixture.adapter.discoverPdk;fixture.adapter.discoverPdk=async args=>{const value=await discover(args);value.discovery.candidates[0].probe_id=args.probe_ids[0];value.discovery.search_directories=[];fixture.saved=value;return fixture.saved;};
window.ready=true;
</script>`;
await context.route('**/*',async route=>{try{const url=new URL(route.request().url());assert.equal(url.origin,origin);if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});const path=url.pathname.slice(1);assert(/^(modules\/|tests\/studio\/)/.test(path));const file=resolve(root,path);assert(file.startsWith(root));await route.fulfill({contentType:{'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[extname(file)]||'text/plain',body:await readFile(file)});}catch(error){unexpected.push(error.message);await route.abort();}});
const button=name=>page.getByRole('button',{name,exact:true}),field=name=>page.locator('[data-environment-field="'+name+'"]');
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready);
  const hosts=Array.from({length:8},(_,i)=>'synthetic-host-'+i);await field('ssh-targets').fill(hosts.join('\n'));await field('ssh-targets').blur();
  assert.equal(await button('探测并匹配 PDK').isDisabled(),true);assert.equal(await button('只探测所选主机').isEnabled(),true);
  await button('只探测所选主机').click();await page.waitForFunction(()=>wizard.controller.state.probe.status==='complete');
  assert.deepEqual(await page.evaluate(()=>fixture.calls.find(row=>row.method==='probeHost').args.ssh_targets),hosts);assert.equal(await page.evaluate(()=>fixture.calls.filter(row=>row.method==='discoverPdk').length),0);
  await page.locator('[data-environment-detail="pdk-advanced"]>summary').click();assert.equal(await page.locator('[data-pdk-probe-batch] input').count(),8);assert.equal(await page.locator('[data-pdk-probe-batch] input:checked').count(),0);assert.equal(await button('按网表模型匹配 PDK').isDisabled(),true);
  await field('pdk-probe-synthetic-probe-2').check();await field('pdk-probe-synthetic-probe-7').check();assert.equal(await field('pdk-probe-synthetic-probe-0').isDisabled(),true);assert.equal(await button('按网表模型匹配 PDK').isEnabled(),true);
  const before=await page.evaluate(()=>({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision}));await button('按网表模型匹配 PDK').click();await page.waitForFunction(()=>wizard.controller.state.discovery.status==='complete');
  assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(row=>row.method==='discoverPdk').at(-1).args),{...before,probe_ids:['synthetic-probe-2','synthetic-probe-7']});
  assert.equal(await page.evaluate(()=>fixture.calls.filter(row=>row.method==='probeHost').length),1);assert.equal(await page.locator('[data-pdk-probe-batch] input').count(),8);assert.equal(await page.evaluate(()=>wizard.controller.state.targets.length),8);
  await field('ssh-targets').fill(hosts.slice(0,2).join('\n'));await field('ssh-targets').blur();assert.equal(await page.locator('[data-pdk-probe-batch]').count(),0);assert.equal(await button('探测并匹配 PDK').isEnabled(),true);assert.equal(await button('按网表模型匹配 PDK').isDisabled(),true);
  await button('探测并匹配 PDK').click();await page.waitForFunction(()=>wizard.controller.state.discovery.status==='complete');assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(row=>row.method==='discoverPdk').at(-1).args.probe_ids),['synthetic-probe-0','synthetic-probe-1']);assert.equal(await page.locator('[data-pdk-probe-batch] input:checked').count(),0);
  for(const width of [320,560,1000]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await page.evaluate(()=>wizard.destroy());assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log(JSON.stringify({kind:'synthetic-pdk-batch-browser',checks:['standalone probe retains eight explicit hosts while combined probe/discovery stops above two','no batch auto-selection; third choice disabled after two','manual discovery submits specifically third/eighth observed probe IDs and retains all eight observations','changed host scope clears selected batch; two-host combined flow remains usable','320/560/1000 responsive']}));
}catch(error){console.error(JSON.stringify({errors,unexpected,body:await page.locator('body').innerText()}));throw error;}finally{await browser.close();}
