// UI regression and optional screenshots with fully intercepted synthetic requests.
// No build, HTTP service, real gateway, source-data mutation or simulation.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test tests/studio/simulation-panel.browser.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const assets=new Map(await Promise.all(['modules/simulation/panel.js','modules/simulation/model.js','modules/simulation/receipts.js','modules/simulation/supervision.js','modules/simulation/runtime.js','modules/simulation/report.js','modules/simulation/http.js','modules/simulation/style.css','modules/simulation/environment/model.js','modules/simulation/environment/panel.js','modules/simulation/environment/style.css','modules/schematic/netlist.js','modules/schematic/instance-properties.js','tests/studio/simulation-panel.fixture.mjs'].map(async path=>['/'+path,await readFile(resolve(root,path),'utf8')])));
const html='<!doctype html><meta charset="utf-8"><style>body{margin:0}#simulation{width:100%}</style><div id="simulation"></div><script type="module">import {mount} from "/modules/simulation/panel.js";import {createPanelFixture} from "/tests/studio/simulation-panel.fixture.mjs";window.fixture=createPanelFixture(document);window.panel=mount(fixture.host);</script>';
test('simulation panel preserves guarded actions and honest configuration displays',async t=>{
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  const page=await browser.newPage({viewport:{width:340,height:960}}),errors=[],unexpected=[];
  page.setDefaultTimeout(5000);
  page.on('pageerror',error=>{errors.push(error.message);console.error('Page error:',error.message);});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(url.origin!=='https://simulation.test'||(path!=='/'&&!assets.has(path))){unexpected.push(url.href);return route.abort();}
    await route.fulfill({status:200,contentType:path==='/'?'text/html':path.endsWith('.css')?'text/css':'text/javascript',body:path==='/'?html:assets.get(path)});
  });
  const field=key=>page.locator(`[data-field="${key}"]`),button=name=>page.getByRole('button',{name,exact:true});
  const change=async(key,value)=>{await field(key).fill(value);await field(key).press('Tab');};
  const calls=()=>page.evaluate(()=>fixture.calls.map(c=>c.name));
  const json=()=>field('json').inputValue().then(JSON.parse);
  const openDetails=async title=>{const summary=page.locator('summary').filter({hasText:title}).first();if(!await summary.evaluate(el=>el.parentElement.open))await summary.click();};
  const screenshot=async name=>{if(process.env.EVIDENCE_DIR){await mkdir(process.env.EVIDENCE_DIR,{recursive:true});await page.screenshot({path:resolve(process.env.EVIDENCE_DIR,name+'.png'),fullPage:true});}};
  try{
    await page.goto('https://simulation.test/');await field('analysis-stop').waitFor();
    await t.test('mount is read-only; transient values and separate signal counts are visible',async()=>{
      assert.deepEqual(await calls(),['request','request']);
      const requests=await page.evaluate(()=>fixture.calls.map(c=>c.args?.[0]));
      assert.equal(requests.filter(path=>path.startsWith('/supervision?')).length,1);
      assert.equal(await page.locator('.ic-sim-timeline strong').innerText(),'24 ns');
      assert.match(await page.locator('.ic-sim-timeline').innerText(),/2 ps/);
      assert.equal(await field('analysis-errpreset').isVisible(),false);assert.equal(await field('analysis-method').isVisible(),false);assert.equal(await field('analysis-maxiters').isVisible(),false);
      assert.ok(await field('parameter-search').evaluate(el=>el.getBoundingClientRect().top)<500);
      assert.equal(await page.getByRole('option',{name:/AC|交流/}).count(),0);
      assert.match(await page.locator('[data-role="raw-save"]').innerText(),/8 个显式目标/);
      assert.match(await page.locator('[data-role="export-signals"]').innerText(),/2 个信号/);
      assert.equal(await field('json').isVisible(),false);
      assert.equal(await page.getByText('fixture/config.json',{exact:true}).isVisible(),false);
      await screenshot('configuration-340');
    });
    await t.test('search filters parameters and draft/override/effective values remain distinct',async()=>{
      await field('parameter-search').fill('rval');
      assert.equal(await page.locator('[data-parameter]').count(),1);
      await change('parameter-RVAL','2k');
      const row=page.locator('[data-parameter="RVAL"]');
      assert.match(await row.innerText(),/草稿覆盖/);assert.equal(await row.locator('td').last().innerText(),'1k');
      assert.equal(await field('parameter-search').inputValue(),'rval');
      await field('parameter-search').fill('N');assert.match(await page.locator('[data-parameter="N"]').innerText(),/已存覆盖/);
      await change('parameter-N','');assert.match(await page.locator('[data-parameter="N"]').innerText(),/草稿继承/);
      assert.equal((await json()).future.keep,7);
      await field('parameter-search').fill('');await change('analysis-stop','48n');
      assert.equal(await page.locator('.ic-sim-timeline strong').innerText(),'24 ns');
      await button('提交').click();await button('预览差异').click();await button('保存配置').waitFor({state:'visible'});
      await page.waitForFunction(()=>!document.querySelector('[data-field="page-config"]').disabled&&document.querySelector('.ic-sim-parameter-table thead').textContent.includes('预览编译值'));
      await button('配置').click();assert.equal(await page.locator('.ic-sim-timeline strong').innerText(),'48 ns');
      assert.equal(await row.locator('td').last().innerText(),'2k');
      await screenshot('draft-preview-340');
    });
    await t.test('raw target editing preserves terminal identity and never changes export selection',async()=>{
      await openDetails('编辑保存目标');await field('save-mode').selectOption('append');
      await field('target-kind').selectOption('current');await change('target-path','VDD0');await field('target-terminal').selectOption('n');
      await button('添加保存目标').click();
      await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-field="json"]').value).save.signals.length===1);
      const conf=await json();assert.deepEqual(conf.save.signals,[{kind:'current',instance:'VDD0',terminal:'n'}]);assert.equal(conf.postprocess.signals.length,2);assert.equal(conf.postprocess.signals[0].keep,true);
      assert.match(await page.locator('[data-role="raw-save"]').innerText(),/8 个显式目标/);assert.match(await page.locator('[data-role="export-signals"]').innerText(),/2 个信号/);
      await button('提交').click();assert.equal(await button('保存配置').isDisabled(),true);await button('配置').click();
    });
    await t.test('drafts survive configuration/project switches and host close/reopen without remote calls',async()=>{
      const draft=await field('json').inputValue();
      await field('configuration').selectOption('short');await page.waitForFunction(()=>document.querySelector('[data-field="json"]')&&!JSON.parse(document.querySelector('[data-field="json"]').value).save);
      await field('configuration').selectOption('tran');await page.waitForFunction(()=>!!JSON.parse(document.querySelector('[data-field="json"]').value).save);
      assert.equal(await field('json').inputValue(),draft);
      await page.evaluate(()=>fixture.switchProject('other-project'));await page.waitForFunction(()=>document.querySelector('.ic-sim-project').textContent==='other-project'&&document.querySelector('[data-field="json"]'));
      assert.notEqual(await field('json').inputValue(),draft);
      await page.evaluate(()=>fixture.switchProject('fixture-project'));await page.waitForFunction(()=>!!document.querySelector('[data-field="json"]')&&!!JSON.parse(document.querySelector('[data-field="json"]').value).save);
      assert.equal(await field('json').inputValue(),draft);
      await page.evaluate(()=>fixture.host.slots.simulation.setVisible(false));await page.evaluate(()=>fixture.host.slots.simulation.setVisible(true));assert.equal(await field('json').inputValue(),draft);
      assert.equal((await calls()).some(name=>['preflight','submit','job'].includes(name)),false);
    });
    await t.test('preview/save/plan/preflight/checked consent are separate actions with exact source identity',async()=>{
      await button('提交').click();await button('预览差异').click();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='保存配置'&&!b.disabled));
      await button('保存配置').click();await page.waitForFunction(()=>document.querySelector('.ic-sim-heading').textContent.includes('已保存配置'));
      assert.equal(await field('push-config').isChecked(),false);
      assert.equal((await calls()).includes('plan'),false);await button('生成计划').click();
      await page.waitForFunction(()=>document.querySelector('[data-field="confirm-submit"]').disabled&&[...document.querySelectorAll('button')].some(b=>b.textContent==='远端预检（不启动仿真）'&&!b.disabled));
      assert.equal((await calls()).includes('preflight'),false);await button('远端预检（不启动仿真）').click();
      await page.waitForFunction(()=>!document.querySelector('[data-field="confirm-submit"]').disabled);
      assert.equal(await button('提交新仿真').isDisabled(),true);assert.equal((await calls()).includes('submit'),false);
      await field('confirm-submit').check();assert.equal(await button('提交新仿真').isEnabled(),true);
      await screenshot('workflow-340');await button('提交新仿真').click();await page.waitForFunction(()=>fixture.calls.some(c=>c.name==='selectRun'));
      const submission=await page.evaluate(()=>fixture.calls.filter(c=>c.name==='submit'));assert.equal(submission.length,1);assert.equal(submission[0].args[0].source_commit,'b'.repeat(40));assert.ok(submission[0].args[0].idempotency_key);
      assert.equal(await button('提交新仿真').isDisabled(),true);
      assert.deepEqual((await calls()).filter(name=>['save','plan','preflight','submit'].includes(name)),['save','plan','preflight','submit']);
    });
    await t.test('history reports evidence without declaring success or remotely polling archives',async()=>{
      await field('page-jobs').click();const archived=page.locator('[data-run-id="archived-run"]'),pending=page.locator('[data-run-id="pending-run"]');
      const supervision=page.getByRole('region',{name:'SpiceOwl 保存的仿真监督记录'});
      await supervision.waitFor();assert.match(await supervision.innerText(),/仅显示保存的观察/);
      const before=await calls();await page.evaluate(()=>{window.savedSupervision=document.querySelector('[aria-label="SpiceOwl 保存的仿真监督记录"]');});
      await field('page-config').click();await field('page-jobs').click();
      assert.equal(await page.evaluate(()=>window.savedSupervision===document.querySelector('[aria-label="SpiceOwl 保存的仿真监督记录"]')),true);
      assert.deepEqual(await calls(),before);
      assert.equal(await page.locator('[data-run-id=foreign-run]').count(),0);
      assert.match(await archived.innerText(),/完整 raw 已收集/);assert.match(await pending.innerText(),/仿真结束 · 待测量/);assert.doesNotMatch(await pending.innerText(),/仿真成功|完整 raw 已收集/);
      assert.equal(await archived.getByRole('button',{name:'显式更新远端状态',exact:true}).count(),0);
      assert.equal(await archived.getByRole('button',{name:'归档至私有 GitHub',exact:true}).count(),0);
      await archived.getByRole('button',{name:'查看结果',exact:true}).click();await page.waitForFunction(()=>fixture.calls.some(c=>c.name==='results'));
      const metrics=archived.getByRole('table',{name:'已保存的结果指标'});await metrics.waitFor();
      assert.match(await metrics.innerText(),/simulator_exit_code/);assert.match(await metrics.innerText(),/执行状态/);assert.match(await metrics.innerText(),/0.42/);assert.match(await metrics.innerText(),/V/);
      assert.match(await archived.innerText(),/waveforms.csv/);assert.doesNotMatch(await metrics.innerText(),/仿真成功|科学验收通过/);
      assert.equal((await calls()).includes('job'),false);await screenshot('history-340');
    });
    await t.test('260/340/640px layouts contain long identifiers and keep advanced content collapsed',async()=>{
      for(const width of [260,340,640]){
        await page.setViewportSize({width,height:960});
        for(const tab of ['config','workflow','jobs']){
          await field('page-'+tab).click();
          const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(overflow.scroll<=overflow.width+1,JSON.stringify({tab,...overflow}));
          assert.equal(await field('json').isVisible(),false);
        }
      }
      await button('配置').click();await screenshot('configuration-640');
    });
    await t.test('invalid JSON and context changes preserve drafts and stop dependent actions',async()=>{
      await openDetails('高级详情');await openDetails('完整配置 JSON');await field('json').fill('{"parameters":{},"parameters":{}}');
      assert.match(await page.locator('.ic-sim-error').first().innerText(),/重复 JSON/);
      await button('提交').click();assert.equal(await button('预览差异').isDisabled(),true);assert.equal(await button('保存配置').isDisabled(),true);
      const draft=await field('json').inputValue();await page.evaluate(()=>fixture.setDirty(true));
      assert.match(await page.locator('.ic-sim-panel').innerText(),/配置操作已暂停/);
      await page.evaluate(()=>fixture.setDirty(false));await field('json').waitFor({state:'attached'});assert.equal(await field('json').inputValue(),draft);
      assert.equal(await button('提交新仿真').isDisabled(),true);
      await page.evaluate(()=>panel.destroy());assert.equal(await page.locator('.ic-sim-panel').count(),0);assert.equal(await page.evaluate(()=>fixture.commands.size),0);
    });
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  }finally{await browser.close();}
});
