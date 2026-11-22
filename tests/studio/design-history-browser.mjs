// Real component UI, synthetic Git/summary/save responses. No real model, Git or simulation writes.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const arg=process.argv.indexOf('--playwright-module');
const {chromium}=await import(arg>=0?pathToFileURL(process.argv[arg+1]).href:'playwright');
const origin='https://design-history-fixture.test',report={status:'starting',kind:'synthetic engineering versions / agent summary browser fixture',checks:[],errors:[]};
const evidence=process.env.EVIDENCE_DIR;if(evidence)await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1240,height:1000}});
page.on('pageerror',e=>report.errors.push(e.message));
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.origin!==origin){report.errors.push('Unexpected network');await route.abort();return;}
 if(url.pathname==='/'){
  await route.fulfill({contentType:'text/html',body:`<!doctype html><html><meta charset="utf-8"><style>body{font-family:system-ui;margin:16px;background:#eef2f6}main{display:grid;grid-template-columns:420px 1fr;gap:16px}#versions,#simulation{height:920px;overflow:auto;background:white}[hidden]{display:none!important}</style><main><section id="versions"></section><section id="simulation"></section></main><script type="module">
  import {mount as mountVersions} from '/repo/apps/web/studio/versions/index.js';
  import {mount as mountSimulation} from '/repo/modules/simulation/panel.js';
  import {createCommitMessage} from '/repo/modules/workspace/commit-message.js';
  import {createPanelFixture} from '/repo/tests/studio/simulation-panel.fixture.mjs';
  const A='a'.repeat(40),B='b'.repeat(40),R='1'.repeat(64),C='c'.repeat(40),path='projects/demo/circuit.scs',listeners=new Set();
  window.calls=[];window.source=A;window.context={project:{id:'demo',sourceCommit:A,repository:'fixture/private',branch:'codex/synthetic'},file:{dirty:false}};
  const commits=[{sha:A,subject:'Old web-facing title',design_summary:'更新电路 1 个文件',author:'Fixture',date:'2026-11-20T09:00:00Z',files_count:1},{sha:B,subject:'Initial fixture',design_summary:'新增电路 1 个文件',author:'Fixture',date:'2026-11-19T09:00:00Z',files_count:1}];
  const gateway={async request(url,options){calls.push({kind:'version',url,options});const u=new URL(url,location.href);
   if(u.pathname==='/version-control')return {project_id:'demo',source_commit:source,commits:u.searchParams.has('include_cosmetic')?[...commits,{sha:C,subject:'Browser acceptance',design_summary:'注释 / 格式整理',cosmetic_only:true}]:commits,clean:true,dirty:false,changes:[],cosmetic_hidden:u.searchParams.has('include_cosmetic')?0:1,history_scanned:3,scope:{kind:'project_design',paths:[path]},upstream:{available:false}};
   if(u.pathname==='/version-control/commit')return {project_id:'demo',source_commit:source,commit:{...commits.find(c=>c.sha===u.searchParams.get('commit')),body:'Actual circuit update description'},files:[{path,additions:1,deletions:1}],diff:'--- a/'+path+'\\n+++ b/'+path+'\\n-R0 r=1k\\n+R0 r=2k',truncated:false};
   if(u.pathname==='/version-control/restore-preview')return {schema:'ic.version-control.restore-preview.v1',project_id:'demo',base_commit:source,target_commit:options.body.commit,changes:[{path,content:'R0 r=1k\\n',sha256:'2'.repeat(64)}],preview:{base_commit:source,review_id:R,diff:'-R0 r=2k\\n+R0 r=1k'},automatic_commit:false};
   if(u.pathname==='/changes/summary')return {summary_id:'fixture-summary',project_id:'demo',base_commit:source,review_id:R,state:'complete',title:'恢复输入电阻',body:'将输入电阻从2k恢复至1k。',model:'fixture'};
   throw Error('Unexpected fixture request '+url);
  },async save(body){calls.push({kind:'version-save',body});source='d'.repeat(40);return {source_commit:source,push_status:body.push?'confirmed':'not_requested'};}};
  const host={slots:{versions:{element:document.querySelector('#versions'),setVisible(){},toggle(){},isVisible:()=>true}},context:{getContext:()=>context,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}},gateway,openSource(){},notify(message){calls.push({kind:'notice',message})},registerCommand:()=>()=>{},versioning:{sync:async()=>{}},createCommitMessage:options=>createCommitMessage({gateway,...options}),async refresh(){context={...context,project:{...context.project,sourceCommit:source}};for(const fn of listeners)fn(context);}};
  window.versions=mountVersions(host);
  const f=createPanelFixture(document),request=f.host.gateway.request;
  f.host.gateway.request=async(url,options)=>{if(url.startsWith('/changes/summary')){calls.push({kind:'simulation-summary',url,options});return {summary_id:'simulation-summary',...options.body,state:'complete',title:'调整仿真采样参数',body:'将N调整为32，保留其余配置。',model:'fixture'};}return request(url,options);};
  f.host.createCommitMessage=options=>createCommitMessage({gateway:f.host.gateway,...options});window.simulation=mountSimulation(f.host);window.simCalls=f.calls;
  window.ready=true;
  </script></html>`});return;
 }
 if(!url.pathname.startsWith('/repo/')){await route.abort();return;}
 const file=resolve(root,url.pathname.slice(6));if(!file.startsWith(root+sep)){await route.abort();return;}
 try{await route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await readFile(file)});}catch(error){report.errors.push(error.message);await route.abort();}
});
try{
 await page.goto(origin);await page.waitForFunction(()=>window.ready);
 const versions=page.locator('#versions');await versions.getByText('工程概览：更新电路 1 个文件',{exact:true}).waitFor();
 assert.match(await versions.innerText(),/隐藏 1 条/);await versions.getByRole('checkbox',{name:'显示注释 / 格式变更'}).check();await versions.getByText('工程概览：注释 / 格式整理',{exact:true}).waitFor();
 report.checks.push('Default circuit view explains hidden cosmetic history and can show it without a write');
 await versions.getByRole('button').filter({hasText:'新增电路 1 个文件'}).click();await versions.getByText('原始 Git 提交说明',{exact:true}).click();await versions.getByText('Actual circuit update description',{exact:true}).waitFor();
 await versions.getByRole('button',{name:'回档到此版本…',exact:true}).click();let dialog=page.getByRole('dialog',{name:'回档电路版本'});
 await page.waitForFunction(()=>document.querySelector('[aria-label="回档提交标题"]')?.value==='恢复输入电阻');
 assert.equal(await dialog.getByRole('textbox',{name:'回档更新说明'}).inputValue(),'将输入电阻从2k恢复至1k。');
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.kind==='version-save').length),0);
 await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.evaluate(()=>calls.filter(c=>c.kind==='version-save').length),0);
 report.checks.push('Restore opens a diff and agent draft; cancelling never creates a commit');
 await versions.getByRole('button',{name:'回档到此版本…',exact:true}).click();dialog=page.getByRole('dialog',{name:'回档电路版本'});await page.waitForFunction(()=>document.querySelector('[aria-label="回档提交标题"]')?.value==='恢复输入电阻');
 await dialog.getByRole('textbox',{name:'回档提交标题'}).fill('人工检查后的回档');await dialog.getByRole('button',{name:'确认回档并生成新提交'}).click();await dialog.getByText(/已生成提交/).waitFor();
 const save=await page.evaluate(()=>calls.find(c=>c.kind==='version-save'));assert.equal(save.body.message,'人工检查后的回档\n\n将输入电阻从2k恢复至1k。');assert.equal(save.body.push,false);assert.equal(save.body.base_commit,'a'.repeat(40));
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();report.checks.push('Explicit restore confirmation makes one new synthetic commit with the editable title/body and push=false');
 const sim=page.locator('#simulation');await sim.locator('[data-field="parameter-N"]').fill('32');await sim.locator('[data-field="parameter-N"]').dispatchEvent('change');await sim.getByRole('button',{name:'提交',exact:true}).click();await sim.getByRole('button',{name:'预览差异',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-field="commit-title"]')?.value==='调整仿真采样参数');
 await sim.locator('[data-field="commit-title"]').fill('我确认的采样配置');await sim.getByRole('button',{name:'保存配置',exact:true}).click();
 await page.waitForFunction(()=>simCalls.some(c=>c.name==='save'));const saved=await page.evaluate(()=>simCalls.find(c=>c.name==='save').args[0]);
 assert.equal(saved.message,'我确认的采样配置\n\n将N调整为32，保留其余配置。');assert.equal(saved.push,false);
 report.checks.push('Simulation configuration uses the same agent draft and preserves an edited title when explicitly saved');
 assert.deepEqual(report.errors,[]);if(evidence)await page.screenshot({path:resolve(evidence,'design-history.png')});report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;if(evidence)await page.screenshot({path:resolve(evidence,'failure.png')});}
finally{if(evidence)await writeFile(resolve(evidence,'design-history-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
