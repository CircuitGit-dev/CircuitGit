// Browser-only synthetic VA fixtures. All asset requests are intercepted; no
// simulator, SSH connection, model, approval or real environment is invoked.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const origin='http://127.0.0.1:18926',browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:560,height:1050}}),page=await context.newPage();
const errors=[],unexpected=[],report={kind:'synthetic-veriloga-browser',real_ssh:false,real_solver:false,checks:[]};
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(7000);
const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/modules/simulation/style.css"><style>body{margin:0}</style><main class="ic-sim-panel"><div id="environment"></div></main><script type="module">
import {mountEnvironmentWizard} from '/modules/simulation/environment/panel.js';
import {agentSource,agentTestbenchFixture} from '/tests/studio/agent-testbench.fixture.mjs';
window.fixture=agentTestbenchFixture();window.notices=[];window.headerId='headers_'+'a'.repeat(64);
window.sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(n=>n.toString(16).padStart(2,'0')).join('');
const save=fixture.adapter.saveAgentTestbench;fixture.adapter.saveAgentTestbench=async args=>{await save(args);const hashes={};for(const [name,text]of Object.entries(args.testbench.helper_files||{}))hashes[name]=await sha(text);fixture.saved={...fixture.saved,agent_tb:{...fixture.saved.agent_tb,helper_sha256:hashes}};return fixture.saved;};
fixture.adapter.probeVerilogaHeaders=async args=>{fixture.calls.push({method:'probeVerilogaHeaders',args:structuredClone(args)});if(args.intake_id!==fixture.saved.intake_id||args.revision!==fixture.saved.revision)throw Error('Synthetic stale probe');fixture.saved={...fixture.saved,revision:fixture.saved.revision+1,state:'headers_observed',prepared:null,agent_tb_review:null,veriloga_headers:[{id:headerId,probe_id:args.probe_id,status:'observed',headers:[{name:'disciplines.vams',alias:'VA_HEADER_SYNTHETIC',sha256:'b'.repeat(64)}],coverage:{complete:true,files:1},missing:[]}]};return fixture.saved;};
window.wizard=mountEnvironmentWizard(document.querySelector('#environment'),{adapter:fixture.adapter,notify:message=>notices.push(message)});await wizard.controller.ready;await wizard.controller.importSource(agentSource);
await fixture.adapter.probeHost({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision,ssh_targets:['synthetic-host']});await fixture.adapter.discoverPdk({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision,probe_ids:['synthetic-probe-0']});await fixture.authorDraft();fixture.setConnection({selectedIntakeId:fixture.saved.intake_id});await wizard.controller.refreshCurrent({...wizard.controller.currentBinding,revision:fixture.saved.revision});window.ready=true;
</script>`;
await context.route('**/*',async route=>{try{const url=new URL(route.request().url());assert.equal(url.origin,origin);if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});const path=url.pathname.slice(1);assert(/^(modules\/|tests\/studio\/)/.test(path),'Unexpected asset '+path);const file=resolve(root,path);assert(file.startsWith(root));const mime={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'};await route.fulfill({contentType:mime[extname(file)]||'text/plain',body:await readFile(file)});}catch(error){unexpected.push(error.message);await route.abort();}});
const field=key=>page.locator('[data-environment-field="'+key+'"]'),button=name=>page.getByRole('button',{name,exact:true}),helperName='behavior/source.va';
const raw='\ufeff// UTF-8 原文\r\nmodule source(p,n);\r\ninout p,n;\relectrical p,n;\nendmodule\r\n',digest=text=>createHash('sha256').update(text).digest('hex');
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready);
  assert.match(await page.getByLabel('导入独立网表',{exact:true}).getAttribute('accept'),/\.va,.vams/);
  await page.locator('[data-environment-detail="support-files"]>summary').click();assert.match(await page.getByLabel('附加网表支持文件',{exact:true}).getAttribute('accept'),/\.va,.vams/);
  await page.locator('[data-environment-detail="agent-helpers"]>summary').click();await field('agent-helper-path').fill(helperName);
  await page.getByLabel('导入测试平台辅助文件',{exact:true}).setInputFiles({name:'source.va',mimeType:'text/plain',buffer:Buffer.from(raw)});
  await page.waitForFunction(name=>JSON.parse(wizard.controller.agentEditor.manifest).helper_files?.[name],helperName);
  assert.equal(await page.evaluate(name=>JSON.parse(wizard.controller.agentEditor.manifest).helper_files[name],helperName),raw);
  await page.waitForFunction(({name,hash})=>[...document.querySelectorAll('[data-helper-hash]')].find(row=>row.dataset.helperHash===name)?.dataset.sha256===hash,{name:helperName,hash:digest(raw)});
  assert.equal(await button('生成审阅计划').isDisabled(),true);await button('保存草稿并撤销旧审阅').click();await page.waitForFunction(()=>!wizard.controller.agentEditor.dirty);
  assert.equal(await page.evaluate(name=>fixture.saved.agent_tb.helper_sha256[name],helperName),digest(raw));
  const area=page.getByLabel('辅助文件 '+helperName,{exact:true});await area.fill((await area.inputValue()).replace('source(p,n)','driver(p,n)'));
  assert.equal(await page.evaluate(name=>JSON.parse(wizard.controller.agentEditor.manifest).helper_files[name],helperName),raw.replace('source(p,n)','driver(p,n)'));
  await button('保存草稿并撤销旧审阅').click();await page.waitForFunction(()=>!wizard.controller.agentEditor.dirty);
  report.checks.push('UTF-8 BOM and mixed CRLF/CR/LF survive file import; editing changes only authored bytes; current and saved SHA-256 match exact helper text');
  await field('agent-helper-path').fill(helperName);await page.getByLabel('导入测试平台辅助文件',{exact:true}).setInputFiles({name:'duplicate.va',mimeType:'text/plain',buffer:Buffer.from('other')});await page.waitForFunction(()=>notices.some(message=>message.includes('已存在')));assert.equal(await page.evaluate(()=>wizard.controller.agentEditor.dirty),false);
  await field('agent-helper-path').fill('invalid.va');await page.getByLabel('导入测试平台辅助文件',{exact:true}).setInputFiles({name:'invalid.va',mimeType:'text/plain',buffer:Buffer.from([0xff])});await page.waitForFunction(()=>notices.some(message=>message.includes('有效 UTF-8')));assert.equal(await page.evaluate(()=>wizard.controller.agentEditor.dirty),false);
  await page.locator('[data-environment-detail="veriloga-headers"]>summary').click();assert.equal(await field('veriloga-roots').inputValue(),'');assert.equal(await field('veriloga-probe').inputValue(),'');
  await field('veriloga-probe').selectOption('synthetic-probe-0');await field('veriloga-roots').fill('/');await field('veriloga-roots').blur();await button('探测所选标准头文件').click();assert.equal(await page.evaluate(()=>fixture.calls.filter(row=>row.method==='probeVerilogaHeaders').length),0);
  await field('veriloga-roots').fill('/explicit/simulator/include');await field('veriloga-roots').blur();const beforeProbe=await page.evaluate(()=>({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision}));
  await button('探测所选标准头文件').click();await page.locator('[data-veriloga-observation]').waitFor();assert.deepEqual(await page.evaluate(()=>fixture.calls.find(row=>row.method==='probeVerilogaHeaders').args),{...beforeProbe,probe_id:'synthetic-probe-0',roots:['/explicit/simulator/include']});
  assert.match(await page.locator('[data-veriloga-observation]').innerText(),/disciplines.vams/);assert.match(await page.locator('[data-veriloga-observation]').innerText(),/覆盖/);
  await field('agent-veriloga-header').selectOption(await page.evaluate(()=>headerId));assert.equal(await button('探测所选标准头文件').isDisabled(),true);await button('保存草稿并撤销旧审阅').click();await page.waitForFunction(()=>!wizard.controller.agentEditor.dirty);assert.equal(await page.evaluate(()=>fixture.saved.agent_tb.selection.veriloga_header_id),await page.evaluate(()=>headerId));
  report.checks.push('no guessed installation paths or default host; exact user roots/probe and intake revision reach the controller; complete same-probe header binding enters the reviewed draft');
  await page.locator('[data-environment-detail="agent-selection"]>summary').click();await field('agent-selection').fill(await page.evaluate(()=>JSON.stringify({...fixture.saved.agent_tb.selection,veriloga_header_id:'headers_'+'f'.repeat(64)})));
  assert.equal(await button('保存草稿并撤销旧审阅').isDisabled(),true);assert.equal(await button('生成审阅计划').isDisabled(),true);assert.match(await page.locator('[data-agent-testbench]').innerText(),/当前主机观察/);await button('撤销本地修改').click();
  await area.fill((await area.inputValue())+'// local helper change\n');await page.evaluate(async()=>{const s=fixture.saved;await fixture.adapter.saveAgentTestbench({intake_id:s.intake_id,revision:s.revision,testbench:{...s.agent_tb.testbench,text:s.agent_tb.testbench.text+'// remote edit\n'},selection:s.agent_tb.selection});await wizard.controller.refreshCurrent({...wizard.controller.currentBinding,revision:fixture.saved.revision});});
  assert.match(await area.inputValue(),/local helper change/);assert.equal(await button('保存草稿并撤销旧审阅').isDisabled(),true);await button('读取后台新草稿').click();
  await field('agent-helper-path').fill('delayed.va');await page.evaluate(()=>{window.originalArrayBuffer=File.prototype.arrayBuffer;File.prototype.arrayBuffer=function(){const file=this;return new Promise(resolve=>{window.finishImport=async()=>resolve(await originalArrayBuffer.call(file));});};});
  await page.getByLabel('导入测试平台辅助文件',{exact:true}).setInputFiles({name:'delayed.va',mimeType:'text/plain',buffer:Buffer.from('module delayed; endmodule\n')});await page.waitForFunction(()=>!!window.finishImport);
  await field('agent-code').fill((await field('agent-code').inputValue())+'// concurrent edit\n');await page.evaluate(async()=>{await finishImport();File.prototype.arrayBuffer=originalArrayBuffer;});await page.waitForFunction(()=>notices.some(message=>message.includes('读取文件时草稿或连接已变化')));
  assert.equal(await page.evaluate(()=>Object.hasOwn(JSON.parse(wizard.controller.agentEditor.manifest).helper_files,'delayed.va')),false);assert.match(await field('agent-code').inputValue(),/concurrent edit/);
  report.checks.push('duplicate/invalid UTF-8 imports do not replace text; mismatched header identity blocks save; remote draft conflicts and delayed file reads preserve concurrent edits');
  for(const width of [320,560,1000]){await page.setViewportSize({width,height:1050});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  const output=process.env.EVIDENCE_DIR||'/tmp/circuitgit-veriloga-browser';await mkdir(output,{recursive:true});await page.screenshot({path:resolve(output,'veriloga-editor.png'),fullPage:true});await page.evaluate(()=>wizard.destroy());assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){console.error(JSON.stringify({errors,unexpected,body:await page.locator('body').innerText()}));throw error;}finally{await browser.close();}
