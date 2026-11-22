// Real browser DOM/keyboard regression, with all network and account data replaced by fixtures.
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const moduleArg = process.argv.indexOf('--playwright-module');
const {chromium} = await import(moduleArg >= 0 ? pathToFileURL(process.argv[moduleArg + 1]).href : 'playwright');
const evidence = process.env.EVIDENCE_DIR;
const report = {kind: 'real Chrome with synthetic gateway; no backend or account requests', checks: [], errors: []};
const browser = await chromium.launch({headless: true, channel: 'chrome'});
const page = await browser.newPage({viewport: {width: 1000, height: 800}});
page.on('pageerror', error => report.errors.push(error.message));
const fixtureOrigin = 'https://ic-ui-fixture.test';
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== fixtureOrigin) {report.errors.push('Unexpected network: ' + url.origin); await route.abort(); return;}
  if (url.pathname === '/') {
    await route.fulfill({contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Escape regression fixture</title><body>
      <button id="open">打开连接</button><textarea id="draft">保留草稿</textarea><div id="schematic">保留原理图</div>
      <script type="module">
      // Match the RNL document capture guard and non-typing selection handler.
      window.backgroundKeys=0; window.plotActive=false;
      document.addEventListener('keydown', e=>{if(e.key==='Escape'&&plotActive){backgroundKeys++;e.preventDefault();e.stopImmediatePropagation();}},true);
      document.addEventListener('keydown', e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!e.target.closest('input,textarea,select')){backgroundKeys++;e.preventDefault();}});
      const {mount}=await import('/source/index.js');
      window.calls=[];
      const host={registerCommand(spec){document.querySelector('#open').onclick=spec.run;return ()=>{document.querySelector('#open').onclick=null;};},gateway:{async request(path,options){
        calls.push({path,options});
        if(path==='/ai/discovery')return {schema:'ic.ai.discovery.v1',codex:{executable_found:true,source:'configured'},desktop:{installed:true,running:'unknown'}};
        if(path==='/ai/sessions')return {sessions:[{session_id:'fixture-session',name:'Fixture session',state:'idle'}]};
        if(path==='/ai/connect'){await new Promise(resolve=>setTimeout(resolve,30));return {schema:'ic.ai.connection.v1',session_id:'fixture-session',status:'partial',account:{status:'unknown',login_status:'unknown',plan_type:'unknown'},usage:{status:'unknown'},catalog:{status:'available',provider:'fixture',default_model:'fixture-model'},policy:{status:'unknown'},chat:{status:'unknown'},inference:{checked:false}};}
        throw Error('Unexpected gateway path');
      }}};
      window.controller=mount(host); window.ready=true;
      </script></body></html>`});
    return;
  }
  if (!/^\/source\/[a-z-]+\.(js|css)$/.test(url.pathname)) {report.errors.push('Unexpected asset: ' + url.pathname); await route.abort(); return;}
  const path = resolve(root, 'apps/web/studio/agent-connections', url.pathname.slice('/source/'.length));
  await route.fulfill({contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(path)});
});
try {
  await page.goto(fixtureOrigin);
  await page.waitForFunction(() => window.ready);
  const dialog = page.getByRole('dialog', {name: 'AI / MCP 连接', exact: true});
  await page.getByRole('button', {name: '打开连接', exact: true}).click();
  const connect = dialog.getByRole('button', {name: '连接并读取账号', exact: true});
  await connect.click();
  await dialog.locator('.ic-local-codex-summary').waitFor();
  report.focusAfterMetadata = await page.evaluate(() => document.activeElement.tagName);
  // Disabling the clicked button can return focus to BODY; the dialog is no longer on the key path.
  await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'hidden', timeout: 1500});
  assert.equal(await page.evaluate(() => backgroundKeys), 0);
  assert.equal(await page.locator('#draft').inputValue(), '保留草稿');
  assert.equal(await page.locator('#schematic').innerText(), '保留原理图');
  report.checks.push('Escape actually closes after fixture metadata disables the clicked button; background selection stays untouched');

  await page.getByRole('button', {name: '打开连接', exact: true}).click();
  await page.evaluate(() => {window.plotActive=true;});
  await dialog.getByRole('button', {name: '关闭', exact: true}).focus();
  await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'hidden', timeout: 1500});
  assert.equal(await page.evaluate(() => backgroundKeys), 0);
  report.checks.push('Escape closes before RNL document capture can cancel it or stop its propagation');

  await page.getByRole('button', {name: '打开连接', exact: true}).click();
  const cancelled = await dialog.evaluate(node => {const event=new Event('cancel',{cancelable:true});node.dispatchEvent(event);return event.defaultPrevented;});
  assert.equal(cancelled, true);
  await dialog.waitFor({state: 'hidden', timeout: 1500});
  report.checks.push('native cancel path explicitly closes the dialog');

  await page.getByRole('button', {name: '打开连接', exact: true}).click();
  await page.evaluate(async () => {controller.hide();controller.show();await new Promise(requestAnimationFrame);});
  await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'hidden', timeout: 1500});
  assert.equal(await page.evaluate(() => backgroundKeys), 0);
  report.checks.push('rapid hide/show keeps the new Escape guard after the queued old close event');

  await page.getByRole('button', {name: '打开连接', exact: true}).click();
  await page.evaluate(() => {window.plotActive=false;const child=document.createElement('dialog');child.id='nested';child.innerHTML='<button>另一个弹窗</button>';child.addEventListener('keydown',e=>e.stopPropagation());document.body.append(child);child.showModal();});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#nested').evaluate(node => node.open), false);
  assert.equal(await dialog.evaluate(node => node.open), true);
  await page.evaluate(() => controller.destroy());
  assert.equal(await page.locator('.ic-agent-connections').count(), 0);
  await page.locator('#open').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => backgroundKeys), 1);
  report.checks.push('another modal retains Escape; destroy removes the window capture guard');
  report.gatewayCalls = await page.evaluate(() => calls);
  assert.equal(report.gatewayCalls.filter(call => call.options?.method === 'POST').length, 1);
  assert(report.gatewayCalls.every(call => ['/ai/discovery','/ai/sessions','/ai/connect'].includes(call.path)));
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {report.status='failed';report.failure=error.stack;process.exitCode=1;}
finally {
  if (evidence) {await mkdir(evidence,{recursive:true});await writeFile(resolve(evidence,'escape-fixture.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report,null,2));
  await browser.close();
}
