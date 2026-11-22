// Built web + existing read-only gateway data. AI responses are explicit UI fixtures.
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const webRoot=resolve(process.env.IC_WEB_ROOT||root+'/web');
const upstream=new URL(process.env.IC_GATEWAY_URL||'http://127.0.0.1:8766');
assert.equal(upstream.hostname,'127.0.0.1');
const output=resolve(process.env.EVIDENCE_DIR||root+'/test-results/dockview-browser');await mkdir(output,{recursive:true});
const report={kind:'built source with real saved data; AI UI fixtures only',checks:[],errors:[],productionPosts:0,modelTurns:0,waveformReads:[]};
const mime={'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png'};
let origin,browser;
function json(res,data){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,data}));}
const server=createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://local');
  if(req.method!=='GET'){report.productionPosts++;res.writeHead(405);res.end('Read-only validation');return;}
  if(u.pathname.startsWith('/api/ai/')){
   if(u.pathname.endsWith('/sessions'))return json(res,{sessions:[{session_id:'default',name:'界面预览 · 未连接模型',state:'idle',pending_approval_count:0,suspended_approval_count:0}],max_sessions:8});
   if(u.pathname.endsWith('/history'))return json(res,{session_id:'default',messages:[],turns:[],cursor:0,state:'idle',pending:[]});
   if(u.pathname.endsWith('/events'))return json(res,{events:[],cursor:0,state:'idle',pending:[]});
   if(u.pathname.endsWith('/models'))return json(res,{models:[],default_model:null,inference_verified:false});
   res.writeHead(404);res.end();return;
  }
  if(u.pathname.startsWith('/api/')){
   // Only known local read endpoints. Never proxy live status/collect/publish/model actions.
   assert(/^\/api\/(health|project|jobs|tree|file|schematic|configuration)$/.test(u.pathname)||
          /^\/api\/version-control(?:\/commit)?$/.test(u.pathname)||
          /^\/api\/geometry\/(file|viewer-manifest)$/.test(u.pathname)||
          /^\/api\/jobs\/[A-Za-z0-9_-]+\/(signals|waveform-map|waveform|results)$/.test(u.pathname));
   const remote=request(new URL(req.url,upstream),{method:'GET',headers:{Host:upstream.host}},r=>{
    const chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>{
     let bytes=Buffer.concat(chunks);const type=r.headers['content-type']||'application/octet-stream';
     if(type.includes('json'))bytes=Buffer.from(bytes.toString().split(upstream.origin).join(origin));
     res.writeHead(r.statusCode,{'Content-Type':type,'Cache-Control':'no-store'});res.end(bytes);
     if(u.pathname.endsWith('/waveform'))report.waveformReads.push(r.statusCode);
    });
   });remote.on('error',e=>{res.writeHead(502);res.end(e.message);});remote.end();return;
  }
  const path=resolve(webRoot,'.'+(u.pathname==='/'?'/index.html':decodeURIComponent(u.pathname)));
  assert(path.startsWith(webRoot+sep));const bytes=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
 }catch(e){res.writeHead(404);res.end(e.message);}
});

if(process.argv.includes('--serve')){
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 await writeFile(output+'/preview.json',JSON.stringify({url:origin+'/studio/dockview/index.html',mode:'read-only UI preview; AI is an explicit fixture'}));
 console.log(origin+'/studio/dockview/index.html');
}else try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1600,height:1050}});page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(origin+'/studio/dockview/index.html');
 await page.waitForFunction(()=>window.ICStudioDock&&window.ICWorkbenchContext?.getContext().geometry?.sourceMatch&&!document.body.classList.contains('studio-native-loading'),null,{timeout:60000});
 await page.locator('[data-field=configuration]').waitFor();await page.locator('.ic-ai-form textarea').waitFor();
 assert.equal(await page.evaluate(()=>ICStudioDock.api.totalPanels),4);
 assert((await page.locator('.studio-panel-simulation').boundingBox()).width>=260);
 report.checks.push('four real Dockview panels load native RNL, simulation controls and AI fixture');
 const rid=process.env.IC_TEST_RUN||'20261109T054442Z-1d9279ef0b-014b97a6';
 await page.locator('.wf-plot').focus();await page.keyboard.press('o');
 await page.getByRole('dialog',{name:'打开已有运行',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('.wf-run-picker option'));
 await page.locator('.wf-run-picker').selectOption(rid);await page.getByRole('dialog',{name:'打开已有运行',exact:true}).getByRole('button',{name:'打开',exact:true}).click();
 await page.getByRole('dialog',{name:'打开已有运行',exact:true}).waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>ICWorkbenchContext.getContext().run.runId),rid);
 report.checks.push('O opens a project-filtered run picker inside waveforms and plots saved traces');
 await page.waitForFunction(()=>document.querySelectorAll('.wf-trace').length===6&&document.querySelectorAll('.wf-cursors tr').length===7&&document.querySelector('.wf-status')?.textContent==='已加载真实运行数据。',null,{timeout:45000});
 await page.evaluate(()=>{window.keptSVG=document.querySelector('#canvas>svg');window.keptWave=document.querySelector('.wf-plot');window.keptDraft=document.querySelector('[data-field=json]');window.waveKeysBubbled=[];document.addEventListener('keydown',e=>{if(e.target.closest('.wf-minimal'))waveKeysBubbled.push(e.key);});});
 report.checks.push('six real saved curves and cursor measurements loaded in the docked panel');
 assert.equal(await page.locator('.wf-toolbar:visible').count(),0);assert.equal(await page.locator('.wf-banner:visible').count(),0);assert.equal(await page.locator('.wf-cursors:visible').count(),0);
 const canvasMetrics=()=>page.locator('.wf-plot').evaluate(el=>({width:el.clientWidth,height:el.clientHeight,pixels:[el.width,el.height],dpr:devicePixelRatio,container:el.parentElement.clientHeight,overflow:el.parentElement.scrollHeight>el.parentElement.clientHeight}));
 const checkCanvas=async()=>{await page.waitForFunction(()=>{const e=document.querySelector('.wf-plot');return e.height===Math.round(e.clientHeight*devicePixelRatio)&&e.width===Math.round(e.clientWidth*devicePixelRatio);});const m=await canvasMetrics();assert.equal(m.height,m.container);assert.equal(m.overflow,false);return m;};
 const initialCanvas=await checkCanvas();
 await page.locator('.wf-plot').focus();await page.keyboard.press('z');const box=await page.locator('.wf-plot').boundingBox();
 await page.mouse.move(box.x+box.width*.3,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5,{steps:10});await page.mouse.up();
 await page.waitForFunction(()=>Number(document.querySelector('.wf-end').value)-Number(document.querySelector('.wf-start').value)<1.5e-8);
 await page.keyboard.press('f');await page.waitForFunction(()=>Number(document.querySelector('.wf-end').value)===2.4e-8);
 await page.keyboard.press('b');await page.locator('.wf-plot').click({position:{x:box.width*.6,y:80}});
 await page.waitForFunction(()=>document.querySelectorAll('.wf-cursors tr').length===7);
 await page.keyboard.press('m');await page.getByRole('dialog',{name:'波形测量与数据',exact:true}).waitFor();await page.keyboard.press('Escape');
 await page.keyboard.press('?');await page.getByRole('dialog',{name:'波形快捷键',exact:true}).waitFor();await page.keyboard.press('Escape');
 assert.deepEqual(await page.evaluate(()=>waveKeysBubbled),[]);
 report.checks.push('canvas and list only; L/F/Z/B/M/? shortcuts work without schematic bindings');
 await page.screenshot({path:output+'/studio.png',fullPage:true});
 // Float/return roundtrip must restore every panel's box, not merely the waveform width.
 const panelBoxes=()=>page.evaluate(()=>Object.fromEntries(ICStudioDock.api.panels.filter(p=>p.api.location.type==='grid').map(p=>{const r=p.group.element.getBoundingClientRect();return [p.id,{x:r.x,y:r.y,width:r.width,height:r.height}];})));
 const assertBoxes=(a,b)=>{assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort());for(const id of Object.keys(a))for(const key of ['x','y','width','height'])assert(Math.abs(a[id][key]-b[id][key])<=3,JSON.stringify({id,key,before:a[id],after:b[id]}));};
 const waveGroup=()=>page.locator('.dv-groupview').filter({has:page.locator('.dv-tab').filter({hasText:'波形'})});
 await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.setSize({height:260}));await page.waitForTimeout(200);
 const beforeFloat=await panelBoxes();
 await waveGroup().getByRole('button',{name:'浮动当前面板',exact:true}).click();
 await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.setSize({width:720,height:340}));await page.waitForTimeout(200);
 const floated=await page.evaluate(()=>ICStudioDock.api.toJSON().floatingGroups.find(g=>g.data.views.includes('waveforms')).position);
 await waveGroup().getByRole('button',{name:'放回主布局',exact:true}).click();await page.waitForTimeout(250);
 assertBoxes(beforeFloat,await panelBoxes());
 assert.equal(await page.evaluate(()=>keptWave===document.querySelector('.wf-plot')&&keptSVG===document.querySelector('#canvas>svg')),true);
 await waveGroup().getByRole('button',{name:'浮动当前面板',exact:true}).click();await page.waitForTimeout(150);
 const refloated=await page.evaluate(()=>ICStudioDock.api.toJSON().floatingGroups.find(g=>g.data.views.includes('waveforms')).position);
 assert(Math.abs(refloated.width-floated.width)<=2);assert(Math.abs(refloated.height-floated.height)<=2);
 await page.waitForTimeout(250);await page.reload();await page.waitForFunction(()=>window.ICRNLStudio&&document.querySelector('#canvas>svg'),null,{timeout:60000});
 assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.location.type),'floating');
 await waveGroup().getByRole('button',{name:'放回主布局',exact:true}).click();await page.waitForTimeout(250);assertBoxes(beforeFloat,await panelBoxes());
 // The page refresh intentionally reloads engineering data; repopulate the same explicit run.
 await page.locator('.wf-plot').focus();await page.keyboard.press('o');await page.waitForFunction(()=>document.querySelector('.wf-run-picker option'));
 await page.locator('.wf-run-picker').selectOption(rid);await page.getByRole('dialog',{name:'打开已有运行',exact:true}).getByRole('button',{name:'打开',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.wf-cursors tr').length===7);
 await page.evaluate(()=>{window.keptSVG=document.querySelector('#canvas>svg');window.keptWave=document.querySelector('.wf-plot');});
 report.checks.push('return restores original location and dimensions; floating dimensions and dock home survive reload');
 // Returning one float must not resurrect a different panel the user closed meanwhile.
 await waveGroup().getByRole('button',{name:'浮动当前面板',exact:true}).click();
 await page.evaluate(()=>ICStudioDock.api.getPanel('ai').api.close());
 await waveGroup().getByRole('button',{name:'放回主布局',exact:true}).click();await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>!!ICStudioDock.api.getPanel('ai')),false);
 assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.location.type),'grid');
 await page.evaluate(()=>ICStudioDock.reset());await page.waitForTimeout(150);
 report.checks.push('relative restore preserves unrelated panel closures');
 // Dockview's native drag: merge waveforms with the schematic group.
 const src=page.locator('.dv-tab').filter({hasText:'波形'}).first(),dst=page.locator('.dv-tab').filter({hasText:'原理图'}).first();
 await src.dragTo(dst);await page.waitForTimeout(350);
 assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').group.id===ICStudioDock.api.getPanel('schematic').group.id),true);
 assert.equal(await page.evaluate(()=>keptSVG===document.querySelector('#canvas>svg')&&keptWave===document.querySelector('.wf-plot')),true);
 report.checks.push('physical drag groups tabs without recreating circuit or waveform renderers');
 await page.evaluate(()=>ICStudioDock.api.addFloatingGroup(ICStudioDock.api.getPanel('waveforms'),{width:620,height:380}));
 assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.location.type),'floating');
 await checkCanvas();
 const wavegroup=page.locator('.dv-groupview').filter({has:page.locator('.dv-tab').filter({hasText:'波形'})});
 await wavegroup.getByRole('button',{name:'放回主布局',exact:true}).click();
 assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.location.type),'grid');
 assert.equal(await page.evaluate(()=>keptWave===document.querySelector('.wf-plot')),true);
 await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.setSize({height:150}));await page.waitForTimeout(150);const small=await checkCanvas();assert(small.height<initialCanvas.height,JSON.stringify({small,initialCanvas}));
 await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.setSize({height:450}));await page.waitForTimeout(150);const large=await checkCanvas();assert(large.height>small.height);
 await page.evaluate(()=>ICStudioDock.api.addFloatingGroup(ICStudioDock.api.getPanel('waveforms'),{width:620,height:380}));
 await page.screenshot({path:output+'/floating.png',fullPage:true});
 await page.locator('.dv-tab').filter({hasText:'波形'}).first().dragTo(page.locator('.dv-tab').filter({hasText:'原理图'}).first());
 await page.waitForFunction(()=>ICStudioDock.api.getPanel('waveforms').api.location.type==='grid');
 assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').group.id===ICStudioDock.api.getPanel('schematic').group.id),true);
 report.checks.push('floating can dock back by button and physical tab drag; canvas follows small and large bounds');
 await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.close());
 assert.equal(await page.evaluate(()=>ICStudioDock.api.totalPanels),3);
 await page.evaluate(()=>ICStudioDock.open('waveforms'));
 assert.equal(await page.evaluate(()=>keptWave===document.querySelector('.wf-plot')&&document.querySelectorAll('.wf-trace').length===6),true);
 report.checks.push('floating, close and reopen keep waveform samples');
 await page.evaluate(()=>{const p=ICStudioDock.api.getPanel('schematic').api;p.maximize();});
 assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('schematic').api.isMaximized()),true);
 await page.evaluate(()=>{ICStudioDock.api.getPanel('schematic').api.exitMaximized();ICStudioDock.reset();});
 assert.equal(await page.evaluate(()=>keptSVG===document.querySelector('#canvas>svg')),true);
 // New version view shares the right-hand group and retains state across close/float.
 await page.locator('.studio-view-menu summary').click();await page.locator('.studio-view-menu').getByRole('button',{name:'版本管理',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.ic-version-history [data-commit]'),null,{timeout:30000});
 assert.equal(await page.evaluate(()=>ICStudioDock.api.totalPanels),5);
 assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('versions').group.id===ICStudioDock.api.getPanel('simulation').group.id),true);
 assert.equal(await page.locator('.ic-version-error').count(),0);
 await page.locator('.ic-version-history [data-commit]').first().click();await page.locator('.ic-version-diff').waitFor();
 assert((await page.locator('.ic-version-diff').textContent()).includes('diff --git'));
 await page.evaluate(()=>{window.keptVersion=document.querySelector('.ic-versions');window.keptDiff=document.querySelector('.ic-version-diff');ICStudioDock.api.getPanel('versions').api.close();ICStudioDock.open('versions');});
 assert.equal(await page.evaluate(()=>keptVersion===document.querySelector('.ic-versions')&&keptDiff===document.querySelector('.ic-version-diff')),true);
 const versionGroup=()=>page.locator('.dv-groupview').filter({has:page.locator('.dv-tab').filter({hasText:'版本管理'})});
 const beforeVersionFloat=await panelBoxes();
 await versionGroup().getByRole('button',{name:'浮动当前面板',exact:true}).click();
 await page.evaluate(()=>ICStudioDock.api.getPanel('versions').api.setSize({width:520,height:580}));
 await page.screenshot({path:output+'/versions.png',fullPage:true});
 await versionGroup().getByRole('button',{name:'放回主布局',exact:true}).click();await page.waitForTimeout(200);assertBoxes(beforeVersionFloat,await panelBoxes());
 await page.locator('.ic-version-back').click();await page.locator('.ic-version-tabs').getByRole('button',{name:'当前修改'}).click();
 assert((await page.locator('.ic-version-changes').textContent()).includes('当前工程没有待提交修改'));
 await page.evaluate(()=>ICStudioDock.api.getPanel('versions').api.close());
 report.checks.push('project Git history and real diff; version window closes, reopens, floats and returns with state intact');
 await page.evaluate(()=>ICStudioDock.open('simulation'));
 await page.locator('[data-field=page-workflow]').click();assert.equal(await page.locator('[data-page=workflow]:visible').count(),1);
 assert.equal(await page.getByRole('button',{name:'提交新仿真',exact:true}).isDisabled(),true);
 await page.locator('[data-field=page-jobs]').click();assert.equal(await page.locator('.ic-sim-job:visible').count(),1);
 await page.locator('.ic-sim-job').first().getByRole('button',{name:'查看结果',exact:true}).click();
 await page.locator('.ic-sim-job').first().getByRole('table',{name:'已保存的结果指标'}).waitFor();
 await page.screenshot({path:output+'/simulation-results.png',fullPage:true});
 await page.locator('[data-field=page-config]').click();
 assert.equal(await page.locator('[data-field=json]:visible').count(),0);
 assert.equal(await page.locator('.ic-sim-parameter-table:visible').count(),1);
 await page.screenshot({path:output+'/simulation-config.png',fullPage:true});
 report.checks.push('compact configuration/workflow/results tabs; raw JSON hidden and simulation requires explicit approval');
 await page.evaluate(()=>{const editor=document.querySelector('[data-field=json]');editor.value='{"unfinished":';editor.dispatchEvent(new Event('input',{bubbles:true}));ICStudioDock.api.getPanel('simulation').api.close();ICStudioDock.open('simulation');});
 assert.equal(await page.locator('[data-field=json]').inputValue(),'{"unfinished":');
 report.checks.push('unfinished simulation JSON survives closing and reopening without any backend write');
 await page.evaluate(()=>{for(const p of [...ICStudioDock.api.panels])ICStudioDock.api.addFloatingGroup(p,{width:450,height:280});});
 assert.equal(await page.evaluate(()=>ICStudioDock.api.groups.filter(g=>g.api.location.type==='grid').length),0);
 await page.locator('.studio-view-menu summary').click();await page.getByRole('button',{name:'收回所有浮动面板',exact:true}).click();
 assert.equal(await page.evaluate(()=>ICStudioDock.api.groups.some(g=>g.api.location.type==='floating')),false);
 report.checks.push('all-floating layout can recover without clearing any component');
 await page.evaluate(()=>{for(const p of [...ICStudioDock.api.panels])p.api.close();});await page.waitForTimeout(300);await page.reload();
 await page.waitForFunction(()=>window.ICRNLStudio);assert.equal(await page.evaluate(()=>ICStudioDock.api.totalPanels),0);
 await page.getByRole('button',{name:'恢复默认布局',exact:true}).last().click();
 assert.equal(await page.evaluate(()=>ICStudioDock.api.totalPanels),4);
 report.checks.push('maximize, reset and all-closed layout survive without clearing component state');
 assert.equal(report.errors.length,0,report.errors.join('; '));assert.equal(report.productionPosts,0);
 report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;throw e;}
finally{await writeFile(output+'/report.json',JSON.stringify(report,null,2));await browser?.close();await new Promise(r=>server.close(r));console.log(JSON.stringify(report));}
