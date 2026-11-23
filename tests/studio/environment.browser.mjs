// Intercepted synthetic onboarding fixture. No simulator, SSH, host inventory,
// real PDK, model request, HTTP listener or historical runtime data is used.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const files=['modules/simulation/environment/model.js','modules/simulation/environment/panel.js','modules/simulation/environment/style.css','modules/simulation/style.css','modules/simulation/report.js','modules/schematic/netlist.js','modules/schematic/instance-properties.js','tests/studio/environment.fixture.mjs'];
const assets=new Map(await Promise.all(files.map(async path=>['/'+path,await readFile(resolve(root,path),'utf8')])));
const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/modules/simulation/style.css"><style>body{margin:0}.ic-sim-panel{padding:10px;box-sizing:border-box;min-width:0}input,select,textarea{box-sizing:border-box}button{max-width:100%}</style><div class="ic-sim-panel"><div id="environment"></div></div><script type="module">
import {mountEnvironmentWizard} from '/modules/simulation/environment/panel.js';
import {environmentFixture,source,intent} from '/tests/studio/environment.fixture.mjs';
window.fixture=environmentFixture();window.intent=intent;window.source=source;
if(sessionStorage.getItem('synthetic-session')){fixture.saved=JSON.parse(sessionStorage.getItem('synthetic-session'));fixture.setConnection({selectedIntakeId:fixture.saved.intake_id});}
fixture.pendingStore.load=async()=>JSON.parse(sessionStorage.getItem('synthetic-pending')||'[]');
fixture.pendingStore.put=async record=>{sessionStorage.setItem('synthetic-pending',JSON.stringify([record]));return record;};
fixture.pendingStore.remove=async()=>sessionStorage.setItem('synthetic-pending','[]');
window.currentSourceReads=0;
window.wizard=mountEnvironmentWizard(document.querySelector('#environment'),{adapter:fixture.adapter,getSource:()=>{currentSourceReads++;return source;}});
</script>`;
test('environment wizard explicitly chooses source, hosts, PDK and complete intent; uncertain run survives reload',async()=>{
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'}),page=await browser.newPage({viewport:{width:340,height:1000}}),errors=[],unexpected=[];
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!=='https://environment.test'||url.pathname!=='/'&&!assets.has(url.pathname)){unexpected.push(url.href);return route.abort();}await route.fulfill({contentType:url.pathname==='/'?'text/html':url.pathname.endsWith('.css')?'text/css':'text/javascript',body:url.pathname==='/'?html:assets.get(url.pathname)});});
  const button=label=>page.getByRole('button',{name:label,exact:true}),field=key=>page.locator(`[data-environment-field="${key}"]`);
  const change=async(key,value)=>{await field(key).fill(value);await field(key).press('Tab');};
  try{
    await page.goto('https://environment.test/');await button('导入当前网表').waitFor();
    assert.equal(await page.evaluate(()=>currentSourceReads),0);assert.deepEqual(await page.evaluate(()=>fixture.calls),[]);assert.equal(await field('intent-supply_v').inputValue(),'');assert.equal(await field('intent-nominal_temperature_c').inputValue(),'');
    await button('导入当前网表').click();await page.waitForFunction(()=>wizard.controller.state.intake.status==='complete');assert.equal(await page.evaluate(()=>currentSourceReads),1);
    await page.locator('summary').filter({hasText:'器件、尺寸与连接节点'}).click();assert.match(await page.locator('.ic-env-devices').innerText(),/\(W\*2\)/);assert.match(await page.locator('.ic-env-devices').innerText(),/LVAR/);
    await button('读取本机别名').click();await page.waitForFunction(()=>wizard.controller.state.aliases.status==='complete');assert.equal(await page.evaluate(()=>fixture.calls.some(call=>call.method==='probeHost')),false);
    await page.getByLabel('synthetic-host',{exact:true}).check();assert.equal(await page.evaluate(()=>fixture.calls.some(call=>call.method==='probeHost')),false);await button('探测所选主机').click();await page.waitForFunction(()=>wizard.controller.state.probe.status==='complete');assert.match(await page.locator('.ic-env-probe').innerText(),/未执行 license checkout/);
    await button('按网表模型匹配 PDK').click();await page.waitForFunction(()=>wizard.controller.state.discovery.status==='complete');assert.equal(await page.locator('[data-environment-directory]:checked').count(),0);const beforeDirectory=await page.evaluate(()=>fixture.calls.length);await page.locator('[data-environment-directory="synthetic-directory"]').check();assert.equal(await page.evaluate(()=>fixture.calls.length),beforeDirectory);assert.equal(await page.locator('input[type="radio"]').isDisabled(),true);assert.match(await page.locator('[data-environment-step="3"]').innerText(),/仅缩小搜索范围/);await button('按网表模型匹配 PDK').click();await page.waitForFunction(()=>wizard.controller.state.discovery.status==='complete');assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(call=>call.method==='discoverPdk').at(-1).args.search_directory_ids),['synthetic-directory']);
    assert.equal(await page.locator('input[type="radio"]:checked').count(),0);await page.getByLabel('Synthetic PDK candidate',{exact:false}).check();assert.equal(await page.locator('.ic-env-sections input:checked').count(),0);await page.getByLabel('synthetic-section',{exact:true}).check();
    const values=await page.evaluate(()=>intent);for(const [key,value]of Object.entries(values))await change('intent-'+key,value);
    assert.equal(await button('准备实验').isDisabled(),true);await field('confirm-intent').check();await button('准备实验').click();await page.waitForFunction(()=>wizard.controller.state.preparation.status==='complete');assert.equal(await field('execution-target').count(),0);
    for(const width of [260,340,640]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No overflow at '+width);const candidate=await page.locator('.ic-env-candidate').boundingBox(),radio=await page.locator('.ic-env-candidate input').boundingBox();assert.ok(candidate.height<180,'Candidate stays readable at '+width);assert.ok(radio.width<=20,'Radio does not stretch at '+width);if(process.env.EVIDENCE_DIR){await mkdir(process.env.EVIDENCE_DIR,{recursive:true});await page.screenshot({path:resolve(process.env.EVIDENCE_DIR,`environment-${width}.png`),fullPage:true});}}
    await page.evaluate(()=>{sessionStorage.setItem('synthetic-session',JSON.stringify(fixture.saved));fixture.adapter.runPrepared=args=>{fixture.calls.push({method:'synthetic-lost-run',args});throw Error('Synthetic lost response');};});
    await button('提交仿真任务').click();await page.waitForFunction(()=>wizard.controller.state.run.status==='unknown');const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('synthetic-pending'))[0]);assert.equal(pending.submission_key,'experiment-'+'c'.repeat(64));await page.reload();await page.locator('[data-environment-recovery]').waitFor();assert.equal(await button('导入当前网表').isDisabled(),true);assert.deepEqual(await page.evaluate(()=>fixture.calls),[]);
    await page.evaluate(()=>{fixture.adapter.readSubmission=()=>({found:false,run_id:null,submission_key:'experiment-'+'c'.repeat(64),replay_permitted:false,job:null});});await button('核对原请求').click();await page.waitForFunction(()=>wizard.controller.state.run.status==='unknown');assert.match(await page.locator('#environment').innerText(),/禁止重新提交/);assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('synthetic-pending'))[0]),pending);assert.equal(await page.evaluate(()=>fixture.calls.some(call=>call.method==='runPrepared')),false);
    await page.evaluate(()=>{fixture.adapter.readSubmission=()=>({found:true,run_id:'synthetic-run',submission_key:'experiment-'+'c'.repeat(64),replay_permitted:false,job:fixture.job()});});await button('核对原请求').click();await page.waitForFunction(()=>wizard.controller.state.run.status==='complete');assert.equal(await page.locator('[data-environment-recovery]').count(),0);assert.equal(await page.getByRole('list').count(),0);assert.match(await page.locator('#environment').innerText(),/synthetic-run/);
    assert.equal(await button('查看波形').isDisabled(),true);assert.match(await page.locator('#environment').innerText(),/尚无此运行已导出的可用波形/);
    await page.evaluate(()=>{fixture.saved={...fixture.saved,job:fixture.job()};sessionStorage.setItem('synthetic-session',JSON.stringify(fixture.saved));});await page.reload();await button('恢复上次网表与实验').waitFor();assert.deepEqual(await page.evaluate(()=>fixture.calls),[]);await button('恢复上次网表与实验').click();await page.waitForFunction(()=>wizard.controller.state.intake.status==='complete');assert.deepEqual(await page.evaluate(()=>fixture.calls.map(call=>call.method)),['getSession']);assert.equal(await button('提交仿真任务').isDisabled(),true);assert.equal(await field('intent-supply_v').inputValue(),'0.8');assert.equal(await field('intent-nominal_temperature_c').inputValue(),'27');
    await button('更新进度与结果').click();await page.waitForFunction(()=>wizard.controller.state.run.result.inspection_state==='pending');
    await page.evaluate(()=>wizard.destroy());assert.equal(await page.evaluate(()=>fixture.listenerCount),0);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  }finally{await browser.close();}
});
