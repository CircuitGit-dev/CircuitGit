// Synthetic saved-library choices only; every request is intercepted and no
// remote scan, SSH, simulation, model or real repository write is performed.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),origin='http://127.0.0.1:18927';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:560,height:1000}}),page=await context.newPage(),errors=[],unexpected=[];
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(7000);
const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/modules/simulation/style.css"><style>body{margin:0}</style><main class="ic-sim-panel"><div id="environment"></div></main><script type="module">
import {mountEnvironmentWizard} from '/modules/simulation/environment/panel.js';
import {agentSource,agentTestbenchFixture} from '/tests/studio/agent-testbench.fixture.mjs';
window.fixture=agentTestbenchFixture();window.wizard=mountEnvironmentWizard(document.querySelector('#environment'),{adapter:fixture.adapter});await wizard.controller.ready;await wizard.controller.importSource(agentSource);
await fixture.adapter.probeHost({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision,ssh_targets:['synthetic-host']});await fixture.adapter.discoverPdk({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision,probe_ids:['synthetic-probe-0']});await fixture.authorDraft();fixture.setConnection({selectedIntakeId:fixture.saved.intake_id});
window.libraryId='a'.repeat(64);window.choiceIds=['b'.repeat(64),'c'.repeat(64)];window.queryCalls=[];
window.choiceScope={library_id:libraryId,status:'partial',missing:[{code:'binding_query_size'}],entry_choices:[{library_candidate_id:choiceIds[0],label:'first.scs',section_candidates:['tt'],covered_model_count:2},{library_candidate_id:choiceIds[1],label:'second.scs',section_candidates:[null,'ff'],covered_model_count:3}]};
window.installChoices=async nested=>{fixture.saved={...fixture.saved,revision:fixture.saved.revision+1,discovery:{...fixture.saved.discovery,lut:[{schema:'ic.onboarding.pdk-lut.v1',probe_id:'synthetic-probe-0',ssh_target:'synthetic-host',...(nested?{status:'stored',projection:structuredClone(choiceScope)}:structuredClone(choiceScope))}]}};await wizard.controller.refreshCurrent({...wizard.controller.currentBinding,revision:fixture.saved.revision});};
fixture.adapter.discoverPdk=async args=>{queryCalls.push(structuredClone(args));fixture.saved={...fixture.saved,revision:fixture.saved.revision+1,discovery:{...fixture.saved.discovery,lut:[{schema:'ic.onboarding.pdk-lut.v1',probe_id:'synthetic-probe-0',ssh_target:'synthetic-host',library_id:libraryId,status:'hit'}]}};return fixture.saved;};
await installChoices(false);window.ready=true;
</script>`;
await context.route('**/*',async route=>{try{const url=new URL(route.request().url());assert.equal(url.origin,origin);if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});const path=url.pathname.slice(1);assert(/^(modules\/|tests\/studio\/)/.test(path));const file=resolve(root,path);assert(file.startsWith(root));await route.fulfill({contentType:{'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[extname(file)]||'text/plain',body:await readFile(file)});}catch(error){unexpected.push(error.message);await route.abort();}});
const field=page.locator('[data-environment-field="pdk-library-synthetic-probe-0"]'),query=page.locator('[data-pdk-library-query="synthetic-probe-0"]');
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready);await page.locator('[data-pdk-library-choices]>summary').click();assert.equal(await field.inputValue(),'');assert.equal(await query.isDisabled(),true);assert.match(await field.innerText(),/second.scs · 全局 \/ ff · 3 个型号/);assert.equal(await page.evaluate(()=>queryCalls.length),0);
  await page.evaluate(()=>{wizard.controller.setHint('search_paths','/explicit/unrelated/search');wizard.controller.setHint('cds_lib_hint','/explicit/unrelated/cds.lib');});
  await field.selectOption(await page.evaluate(()=>choiceIds[1]));assert.equal(await page.evaluate(()=>queryCalls.length),0);const binding=await page.evaluate(()=>({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision}));await query.click();await page.waitForFunction(()=>queryCalls.length===1);
  assert.deepEqual(await page.evaluate(()=>queryCalls[0]),{...binding,probe_ids:['synthetic-probe-0'],library_selection:{probe_id:'synthetic-probe-0',library_id:'a'.repeat(64),library_candidate_id:'c'.repeat(64)}});assert.equal(await page.locator('[data-pdk-library-choices]').count(),0);
  await page.evaluate(()=>installChoices(true));assert.equal(await field.inputValue(),'');await field.selectOption(await page.evaluate(()=>choiceIds[0]));
  await page.locator('[data-agent-field="code"]').fill((await page.locator('[data-agent-field="code"]').inputValue())+'// local draft\n');assert.equal(await query.isDisabled(),true);await page.getByRole('button',{name:'撤销本地修改',exact:true}).click();assert.equal(await query.isDisabled(),false);
  await page.evaluate(()=>installChoices(true));assert.equal(await field.inputValue(),'');assert.equal(await query.isDisabled(),true);assert.equal(await page.evaluate(()=>queryCalls.length),1);
  await field.selectOption(await page.evaluate(()=>choiceIds[0]));await query.click();await page.waitForFunction(()=>queryCalls.length===2);assert.equal(await page.evaluate(()=>queryCalls[1].library_selection.library_candidate_id),'b'.repeat(64));
  await page.evaluate(()=>installChoices(true));for(const width of [320,560,1000]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await page.evaluate(()=>wizard.destroy());assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log(JSON.stringify({kind:'synthetic-pdk-library-browser',checks:['direct and nested public choices render without default selection','explicit click sends only current identity and exact observed probe/library/entry IDs despite unrelated scan hints','dirty draft blocks query and refreshed revision clears local choice','320/560/1000 responsive; no SSH or simulation']}));
}catch(error){console.error(JSON.stringify({errors,unexpected,body:await page.locator('body').innerText()}));throw error;}finally{await browser.close();}
