// Built UI + actual finite bridge; all connection replies are synthetic.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const built=resolve(process.env.WEB_ROOT||'web');
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:760,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('http://localhost:43213/**',route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><main style="width:540px"></main>'});
  if(!/^\/(library|remote)\/[A-Za-z0-9_.-]+$/.test(pathname))return route.fulfill({status:404,body:''});
  return route.fulfill({contentType:pathname.endsWith('.css')?'text/css':'text/javascript',body:readFileSync(resolve(built,'.'+pathname),'utf8')});
 });
 await page.goto('http://localhost:43213/');
 await page.evaluate(async()=>{
  const [{mountLibraryVersions},{createLibraryBridge}]=await Promise.all([import('/library/versions.js'),import('/remote/library-bridge.js')]);
  window.calls=[];window.approved=false;window.stale=false;
  const path='lib/fixture/gain/gain.scs',commit='a'.repeat(40),binding={source_commit:commit,source_sha256:'1'.repeat(64),testbench_sha256:'2'.repeat(64),analysis_sha256:'3'.repeat(64),manifest_sha256:'4'.repeat(64),criteria_sha256:'5'.repeat(64)};
  const scope={library_id:'fixture',cell_id:'gain',directory:'lib/fixture/gain',entry:path,files:[path]};
  const proposal={id:'gain-tran',title:'Synthetic gain Testbench',review_id:'b'.repeat(64),base_commit:commit,state:'prepared',binding,
   per_file_diffs:['testbench.scs','analysis.py','manifest.json','index.json'].map(file=>({path:'lib/fixture/gain/testbenches/gain-tran/'+file,diff:'+ Synthetic '+file+'\n+ <script>window.bad=true</script>'}))};
  window.bridge=createLibraryBridge({pollInterval:10000});
  window.bridge.bind({request:async(route,{body})=>{
   window.calls.push({route,body});if(route!=='/library/read')throw Error('Unexpected mutation route');
   const {operation,args}=body;
   if(operation==='review_status')return {state:window.approved?'completed':'pending'};
   if(args.library_id!=='fixture'||args.cell_id!=='gain')throw Error('Wrong cell scope');
   if(operation==='review_testbench'){if(args.review_id!==proposal.review_id)throw Error('Wrong frozen review');return {ticket:'synthetic-review-ticket',url:'http://localhost:43213/library/review?ticket=synthetic-review-ticket'};}
   if(operation==='describe')return {...scope,repository:'synthetic/circuits',base_commit:commit,branch:'codex/synthetic',files:[{path,editable:true}],capabilities:{read:true,save:true,commit:true,testbench_review:true}};
   if(operation==='current')return {...scope,base_commit:commit,changes:[],fingerprint:'fixture'+window.approved};
   if(operation==='read_file')return {path,text:'// synthetic source',sha256:'c'.repeat(64),editable:true};
   if(operation==='history')return {commits:[]};if(operation==='checkpoints')return {checkpoints:[]};
   if(operation==='get_ci')return {testbenches:[],config:null,agent_testbenches:{...scope,
    proposals:window.approved?[]:[{...proposal,source_matches:!window.stale}],
    bundles:window.approved?[{id:'gain-tran',title:proposal.title,registration_commit:'d'.repeat(40),binding,source_matches:true,execution_status:'not_run'}]:[]}};
   throw Error('Unexpected operation '+operation);
  }});
  window.controller=mountLibraryVersions({element:document.querySelector('main'),getSelection:()=>scope,subscribeSelection:()=>()=>{},bridge:window.bridge,loadPublished:async()=>({...scope,commits:[]})});
 });
 await page.getByRole('textbox',{name:'电路源码',exact:true}).waitFor();
 await page.getByRole('button',{name:'Testbench CI',exact:true}).click();
 await page.getByRole('button',{name:'打开完整审阅',exact:true}).waitFor();
 const panel=page.getByRole('region',{name:'电路版本管理'});
 assert.match(await panel.innerText(),/Synthetic gain Testbench/);
 assert.equal(await panel.locator('details').count(),5);
 await panel.getByText('lib/fixture/gain/testbenches/gain-tran/analysis.py',{exact:true}).click();
 assert.match(await panel.getByLabel('测试包文件差异 lib/fixture/gain/testbenches/gain-tran/analysis.py').innerText(),/window.bad/);
 assert.equal(await page.evaluate(()=>window.bad),undefined);
 await page.getByRole('button',{name:'打开完整审阅',exact:true}).click();
 const link=page.getByRole('link',{name:'前往人工审阅页面 ↗'});await link.waitFor();
 assert.equal(await link.getAttribute('target'),'_blank');
 assert.match(await link.getAttribute('href'),/\/library\/review\?ticket=synthetic-review-ticket$/);
 await page.getByRole('button',{name:'核对审阅结果',exact:true}).click();
 await page.waitForFunction(()=>document.body.textContent.includes('仍在等待人工审阅'));
 await page.evaluate(()=>window.approved=true);
 await page.getByRole('button',{name:'核对审阅结果',exact:true}).click();
 await page.waitForFunction(()=>document.body.textContent.includes('Testbench CI 已注册并保存为电路 Git 版本'));
 assert.match(await panel.innerText(),/尚未运行 CI/);
 assert.match(await panel.innerText(),/Python 脚本保留供审阅/);
 assert.equal(await page.getByRole('link',{name:'前往人工审阅页面 ↗'}).count(),0);
 await page.evaluate(async()=>{window.approved=false;window.stale=true;await window.controller.refresh();});
 assert.equal(await page.getByRole('button',{name:'打开完整审阅',exact:true}).isDisabled(),true);
 assert.match(await panel.innerText(),/源电路或基线已更新/);
 const calls=await page.evaluate(()=>window.calls);
 assert.equal(calls.filter(c=>c.body.operation==='review_testbench').length,1);
 assert.equal(calls.filter(c=>c.route==='/library/execute'||c.body.operation==='confirm'||c.body.operation==='register_testbench').length,0);
 assert.deepEqual(errors,[]);
 const size=await panel.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(size.scroll<=size.width+1);
 const report={status:'passed',built:true,synthetic:true,model_calls:0,ssh_calls:0,solver_invocations:0,
  checks:['exact-cell proposal appears','complete per-file diffs stay inert','review link uses existing human form','pending/completed status readback','registration is not analysis success','stale proposal disabled','no direct confirmation or registration RPC','narrow layout'],errors};
 if(process.env.EVIDENCE_DIR){mkdirSync(process.env.EVIDENCE_DIR,{recursive:true});await page.screenshot({path:resolve(process.env.EVIDENCE_DIR,'testbench-ci.png')});writeFileSync(resolve(process.env.EVIDENCE_DIR,'testbench-browser.json'),JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report));await page.evaluate(()=>{window.controller.destroy();window.bridge.unbind();});
}finally{await browser.close();}
