// Source-only browser checks. Every request is intercepted; no service, model,
// account, solver or approval operation can be reached by this fixture.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,sep,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),origin='https://workflow-fixture.test',web=resolve(root,'apps/web');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const output=process.env.EVIDENCE_DIR;if(output)await mkdir(output,{recursive:true});
const report={kind:'static-workflow-source-browser',status:'starting',checks:[],errors:[],requests:[]};
const overview=JSON.parse(await readFile(resolve(web,'workflow/data/overview.json'),'utf8'));
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push(error.message));
await context.route('**/*',async route=>{try{const url=new URL(route.request().url());assert.equal(url.origin,origin);assert.equal(route.request().method(),'GET');report.requests.push(url.pathname);assert(!/\/api\/|\/node\/|vendor\/rnl|app-server/.test(url.pathname),'unexpected runtime request');const path=resolve(web,url.pathname.slice(1));assert(path.startsWith(web+sep));await route.fulfill({contentType:extname(path)==='.css'?'text/css':extname(path)==='.js'?'text/javascript':extname(path)==='.json'?'application/json':extname(path)==='.svg'?'image/svg+xml':'text/html',body:await readFile(path)});}catch(error){report.errors.push(error.message);await route.abort();}});
const active=()=>page.locator('.stage-link[aria-current=step]');
try{
  const primary=overview.cases[0],secondary=overview.cases[1];
  await page.goto(origin+'/workflow/index.html?case='+encodeURIComponent(primary.id)+'&stage='+encodeURIComponent(primary.stages[7].id));await page.waitForFunction(()=>document.querySelector('#app').getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('.stage-link').count(),10);assert.equal(await active().locator('.stage-name').innerText(),primary.stages[7].title);assert.equal(await page.locator('.stage-heading>.status-pill').innerText(),'待人工审阅');assert.match(await page.locator('.gate-note').innerText(),/不会批准、提交/);
  assert.equal(await page.locator('.detail').count(),8);for(const title of ['用户操作','Agent 调用','确定性引擎检查','数据契约','源码与文件','公开证据','能力边界','错误与恢复'])await page.locator('.detail summary').filter({hasText:title}).waitFor();
  report.checks.push('primary deep link selects exact review stage and displays eight operation/evidence/boundary sections');
  await active().focus();await page.keyboard.press('ArrowRight');assert.equal(await active().locator('.stage-name').innerText(),primary.stages[8].title);assert.equal(await page.locator('.stage-heading>.status-pill').innerText(),'待执行');assert.match(await page.locator('.gate-note').innerText(),/没有将方法示意作为真实结果/);
  await page.keyboard.press('End');assert.equal(await active().locator('.stage-name').innerText(),primary.stages[9].title);assert.equal(await page.getByRole('button',{name:'已到最后一步'}).isDisabled(),true);await page.keyboard.press('Home');assert.equal(await active().locator('.stage-name').innerText(),primary.stages[0].title);
  report.checks.push('keyboard step navigation preserves factual review/planned statuses, updates deep links and disables endpoint controls');
  await page.getByRole('tab',{name:'源文件片段'}).click();assert.equal(await page.locator('.code-block code').innerText(),primary.stages[0].code.text);await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'证据记录'}).getAttribute('aria-selected'),'true');
  const sourceDetail=page.locator('.detail').filter({has:page.locator('summary',{hasText:'源码与文件'})});await sourceDetail.locator('summary').click();for(const href of await sourceDetail.locator('a').evaluateAll(elements=>elements.map(a=>a.getAttribute('href'))))assert(href.startsWith('data/sources/'));
  report.checks.push('source and evidence tabs expose publication-only data and keyboard tab navigation works without execution');
  await page.getByRole('button',{name:secondary.title,exact:true}).click();assert.equal(await active().locator('.stage-name').innerText(),secondary.stages[0].title);assert.equal(new URL(page.url()).searchParams.get('case'),secondary.id);assert.equal(await page.locator('.state-dot[data-status=planned]').count(),9);
  await page.getByRole('button',{name:'Embedded / 嵌入'}).click();assert.equal(await page.getByRole('button',{name:'Embedded / 嵌入'}).getAttribute('aria-pressed'),'true');assert((await page.getByRole('table').count())>=1);assert((await page.locator('.analysis-item').count())>=3);
  report.checks.push('secondary example keeps unexecuted stages planned; architecture modes and responsibility/analysis boundaries are browsable');
  if(output){await page.getByRole('button',{name:primary.title,exact:true}).click();await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:resolve(output,'workflow-desktop.png'),animations:'disabled'});await page.screenshot({path:resolve(output,'workflow-desktop-full.png'),fullPage:true,animations:'disabled'});}
  await page.setViewportSize({width:390,height:844});await page.goto(origin+'/workflow/index.html');await page.waitForFunction(()=>document.querySelectorAll('.stage-link').length===10);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.locator('.stage-link').nth(7).click();assert.equal(await page.locator('.stage-heading>.status-pill').innerText(),'待人工审阅');assert.equal(await page.locator('.activity-grid').evaluate(element=>element.scrollWidth<=element.clientWidth),true);if(output)await page.screenshot({path:resolve(output,'workflow-mobile.png'),fullPage:true,animations:'disabled'});
  report.checks.push('mobile layout fits viewport with scrollable stage navigation and readable selected-stage content');
  await page.goto(origin+'/workflow/index.html?case=unknown&stage=unknown');await page.waitForFunction(()=>document.querySelectorAll('.stage-link').length===10);assert.equal(await active().locator('.stage-name').innerText(),primary.stages[0].title);
  assert(report.requests.every(path=>path.startsWith('/workflow/')||path.startsWith('/branding/')));assert.deepEqual(report.errors,[]);report.checks.push('unknown deep links recover to the first case; all reads stay within static workflow/branding assets and no RNL workbench loads');report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;if(output)await page.screenshot({path:resolve(output,'workflow-failure.png'),fullPage:true});}
finally{if(output)await writeFile(resolve(output,'workflow-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
