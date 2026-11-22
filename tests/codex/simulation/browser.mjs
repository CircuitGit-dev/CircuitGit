// Local-only browser test of the real packaged host plus component; no live gateway.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const output=resolve(process.env.EVIDENCE_DIR||root+'/scratch/simulation-browser');await mkdir(output,{recursive:true});
const hostRoot=resolve(process.env.MCP_UI_HOST_ROOT||root);
execFileSync(process.env.PYTHON||'python3',['-B',root+'/tests/codex/simulation/bundle_fixture.py',root,hostRoot,output],{stdio:'inherit'});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
function server(base){return createServer(async(req,res)=>{
  try{
    const path=resolve(base,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!path.startsWith(base+sep))throw Error('outside root');
    const content=await readFile(path),mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'application/octet-stream';
    res.writeHead(200,{'content-type':mime,'cache-control':'no-store'});res.end(content);
  }catch{res.writeHead(404);res.end('Not found');}
});}
const outer=server(root),inner=server(output),servers=[outer,inner];
for(const s of servers)await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'}),page=await browser.newPage({viewport:{width:1500,height:1100}});
const errors=[],requests=[],checks=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(request.url()));
const outerOrigin='http://127.0.0.1:'+outer.address().port,innerOrigin='http://127.0.0.1:'+inner.address().port;
try{
  await page.goto(outerOrigin+'/tests/codex/simulation/browser.html?bundle='+encodeURIComponent(innerOrigin+'/simulation.html'));
  const a=page.frameLocator('iframe').nth(0),b=page.frameLocator('iframe').nth(1);
  await a.locator('[data-field="analysis-stop"]').waitFor();await b.getByText('历史运行窗口不提供当前配置编辑。', {exact:false}).waitFor();checks.push('real packed host initialized across origins with _meta engineering payload');
  await a.locator('[data-field="analysis-stop"]').fill('20n');await a.locator('[data-field="analysis-stop"]').press('Tab');
  await a.locator('[data-field="save-mode"]').selectOption('append');await a.locator('[data-field="kind"]').selectOption('current');
  await a.locator('[data-field="target"]').fill('R1');await a.locator('[data-field="target"]').press('Tab');await a.locator('[data-field="terminal"]').selectOption('n');
  await a.getByRole('button',{name:'加入 raw 保存',exact:true}).click();
  assert.equal(JSON.parse(await a.locator('[data-field="json"]').inputValue()).save.signals[0].terminal,'n');
  checks.push('analysis and structured current-terminal form preserves exact draft');
  await page.screenshot({path:output+'/configuration-wide.png',fullPage:true});
  await a.getByRole('button',{name:'编译 / 预览 Diff',exact:true}).click();await a.getByRole('button',{name:'申请配置提交 · 待人工审批',exact:true}).waitFor();
  await a.getByRole('button',{name:'申请配置提交 · 待人工审批',exact:true}).click();await a.getByText('等待人工审批 · 尚未执行',{exact:true}).waitFor();
  assert.equal(await a.locator('button').filter({hasText:/^(approve|deny|批准|拒绝)$/}).count(),0);
  assert.match(await a.locator('pre').allTextContents().then(x=>x.join('\n')),/--request-id [a-f0-9]{64} --fingerprint [a-f0-9]{64}/);
  await a.getByRole('button',{name:'在Codex中审核',exact:true}).click();
  await a.getByText('审核已取消，请求仍待审核。',{exact:true}).waitFor();
  const reviewCalls=await page.evaluate(()=>window.harness.records[0].fixture.calls.filter(c=>c.name==='ic_request_review'));
  assert.equal(reviewCalls.length,1);assert.deepEqual(Object.keys(reviewCalls[0].args).sort(),['fingerprint','request_id']);
  checks.push('review button sends only frozen hashes; synthetic host cancellation preserves pending receipt');
  await page.screenshot({path:output+'/pending-approval-wide.png',fullPage:true});
  await b.getByRole('button',{name:/本地任务/}).click();await b.getByRole('button',{name:'读取本地结果',exact:true}).first().click();
  assert.equal(await b.getByRole('button',{name:/申请完整收集|申请私有 GitHub 归档/}).count(),0);checks.push('historical real archived projection loads without config or write actions');
  // Denial is fixture state only; the component can only read the resulting receipt.
  await page.evaluate(()=>window.harness.human(0,'denied'));await a.getByRole('button',{name:'刷新保存的请求状态',exact:true}).click();await a.getByText('人工拒绝 · 未自动重试',{exact:true}).waitFor();
  await a.getByRole('button',{name:'重新读取窗口',exact:true}).click();await a.locator('summary').filter({hasText:'已保留草稿'}).click();
  page.once('dialog',dialog=>dialog.accept());await a.getByRole('button',{name:'丢弃此草稿',exact:true}).click();
  await a.getByRole('button',{name:'Diff / 计划',exact:true}).click();await a.getByRole('button',{name:'生成本地计划',exact:true}).click();
  await a.getByRole('button',{name:'申请仿真提交 · 待人工审批',exact:true}).click();await a.getByText('等待人工审批 · 尚未执行',{exact:true}).waitFor();
  await page.evaluate(()=>window.harness.human(0,'accepted',{run_id:'fixture-run',source_commit:'a'.repeat(40)}));
  await a.getByRole('button',{name:'刷新保存的请求状态',exact:true}).first().click();await a.getByRole('button',{name:'绑定此提交回执的运行',exact:true}).click();
  await a.getByRole('button',{name:/本地任务/}).click();await a.getByRole('button',{name:'读取本地结果',exact:true}).click();
  await a.getByRole('button',{name:'申请完整收集 · 待审批',exact:true}).click();await a.getByText('等待人工审批 · 尚未执行',{exact:true}).waitFor();
  checks.push('accepted submit binds through real host CAS then collect is still pending');
  await page.setViewportSize({width:390,height:850});await page.locator('iframe').first().screenshot({path:output+'/pending-approval-narrow.png'});
  const overflow=await page.frames()[1].evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(overflow.scroll<=overflow.width+1,JSON.stringify(overflow));checks.push('390px parent has no horizontal component overflow');
  await page.evaluate(()=>window.harness.teardown(0));await a.locator('.ic-mcp-simulation').waitFor({state:'detached'});assert.equal(await b.locator('.ic-mcp-simulation').count(),1);checks.push('teardown releases only the selected view');
  const fixture=await page.evaluate(()=>({errors:window.harness.errors,calls:window.harness.records.map(r=>r.fixture.calls),contexts:window.harness.records.map(r=>r.contexts)}));
  assert.deepEqual(errors,[]);assert.deepEqual(fixture.errors,[]);
  assert.ok(requests.every(url=>url.startsWith(outerOrigin)||url.startsWith(innerOrigin)||url.startsWith('blob:')||url.startsWith('data:')));
  assert.ok(fixture.calls.flat().every(c=>/^ic_(view_(get|data|draft|plan|request|bind_run|state)|request_review)$/.test(c.name)));
  const report={status:'passed',checks,errors,network:'two ephemeral loopback test origins plus blob/data package assets only',native_mount_verified:false,fixture_calls:fixture.calls};await writeFile(output+'/browser-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:'passed',checks,evidence:output}));
}catch(error){await page.screenshot({path:output+'/failure.png',fullPage:true});await writeFile(output+'/failure.json',JSON.stringify({error:error.message,pageErrors:errors,frames:await Promise.all(page.frames().map(async f=>({url:f.url(),text:await f.locator('body').innerText().catch(()=>null)})))},null,2));throw error;}finally{await browser.close();for(const s of servers)await new Promise(resolve=>s.close(resolve));}
