// Synthetic provider + real browser renderer. No helper, SSH, simulator or model.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=resolve(root,'test-results/onboarding-waveforms');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const mime={'.js':'text/javascript','.css':'text/css','.json':'application/json'};
const server=createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,'http://fixture').pathname;
    if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#15191f;color:white}#waves{height:560px;width:900px;max-width:100vw}</style><div id="waves"><p id="old">Prior waveform</p></div>');return;}
    assert(/^\/(apps\/web|modules)\//.test(path));const file=resolve(root,'.'+path);assert(file.startsWith(root));
    res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1100,height:800}});
const report={kind:'synthetic-browser-fixture',native_simulation:false,checks:[],errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));
try{
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async()=>{
    const {openOnboardingWaveforms}=await import('/apps/web/remote/onboarding-waveforms.js');
    const hash='c'.repeat(64),commit='a'.repeat(40),plan='b'.repeat(64);
    const signal={id:'fixture-signal',label:'Fixture OUT',psf_name:'OUT',analysis:'tran',unit:'V',quantity:'voltage',status:'available',domain:[0,1e-8]};
    const identity={run_id:'fixture-run',source_commit:commit,archive_sha256:hash,raw_signature:hash,effective_config_sha256:hash,csv_sha256:hash};
    const intake={schema:'ic.onboarding.session.v1',intake_id:'fixture-intake',source_sha256:hash,source_commit:commit,
      prepared:{schema:'ic.experiment.plan.v1',state:'prepared',plan_id:plan,source_commit:commit,project_id:'fixture-project',recipe_id:'fixture'}};
    const job={schema:'ic.experiment.job.v1',plan_id:plan,project_id:'fixture-project',configuration:'fixture',source_commit:commit,run_id:'fixture-run',job_id:'fixture-run',state:'simulator_complete_pending_measurements'};
    const connection={connected:true,connectionId:'fixture-store',revision:1},listeners=new Set(),commands=new Map();
    const fixture=window.fixture={preparations:0,reads:0,foreign:true,notices:[],commands,connection};
    const provider={catalog:async()=>({...identity,run_id:fixture.foreign?'foreign-run':'fixture-run',signals:[signal]}),
      mapping:async()=>({...identity,schema:'ic.waveform-map.v1',status:'unmapped',objects:[]}),
      waveform:async(_run,_id,params)=>{fixture.reads++;return {...identity,signal,points:Array.from({length:101},(_,i)=>[i*1e-10,.45+.45*Math.sin(i/10)]),
        measurement:{cursors:{},delta:null,basis:'synthetic_fixture',uses_display_samples:false},display:{returned_points:101,input_points:101,decimated:false,method:'all_window_points'},window:{returned:[0,1e-8],requested:[params.start,params.end],clipped:false}};}};
    const host={slots:{waveforms:{element:document.getElementById('waves'),isVisible:()=>true,setVisible:()=>{}}},
      notify:message=>fixture.notices.push(message),registerCommand:item=>{commands.set(item.id,item);return()=>commands.delete(item.id);},
      prepareOnboardingWaveformSlot:()=>{fixture.preparations++;document.getElementById('waves').replaceChildren();},
      onboarding:{getState:()=>({...connection}),waveformApi:()=>provider,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}}};
    fixture.open=()=>openOnboardingWaveforms(host,{intake,job});fixture.disconnect=()=>{connection.connected=false;for(const fn of listeners)fn();};
    try{await fixture.open();throw Error('Foreign run unexpectedly opened');}catch(error){fixture.rejection=error.message;}
    fixture.foreign=false;
  });
  assert.match(await page.evaluate(()=>fixture.rejection),/其它运行/);assert.equal(await page.locator('#old').count(),1);assert.equal(await page.evaluate(()=>fixture.preparations),0);
  report.checks.push('foreign-run data rejected before replacing the prior panel');
  await page.evaluate(async()=>{fixture.handle=await fixture.open();});
  await page.getByRole('dialog',{name:'添加信号',exact:true}).waitFor();await page.locator('[data-signal-id="fixture-signal"]').click();await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('.wf-status')?.textContent.includes('已加载真实运行数据'));
  assert.equal(await page.locator('.wf-trace').count(),1);assert.equal(await page.locator('.wf-cursors').count(),1);
  assert.equal(await page.evaluate(()=>fixture.commands.size),5);
  report.checks.push('real waveform renderer opens the scoped synthetic signal with keyboard controls');
  const before=await page.locator('.wf-plot').boundingBox();await page.evaluate(()=>document.getElementById('waves').style.width='620px');
  await page.waitForFunction(()=>document.querySelector('.wf-plot').clientWidth<600);
  assert((await page.locator('.wf-plot').boundingBox()).width<before.width);
  report.checks.push('waveform canvas follows its panel width');
  const reads=await page.evaluate(()=>fixture.reads);await page.evaluate(()=>fixture.disconnect());await page.locator('.wf-plot').focus();await page.keyboard.press('+');
  await page.waitForFunction(()=>document.querySelector('.wf-status')?.textContent.includes('连接已变化'));
  assert.equal(await page.evaluate(()=>fixture.reads),reads);assert.equal(await page.locator('.wf-trace').count(),1);
  report.checks.push('disconnection retains the curve and rejects further provider reads');
  await mkdir(out,{recursive:true});await page.screenshot({path:out+'/fixture.png'});
  await page.evaluate(()=>{fixture.handle.destroy();fixture.handle.destroy();});assert.equal(await page.evaluate(()=>fixture.commands.size),0);
  assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;}
finally{await mkdir(out,{recursive:true});await writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser.close();await new Promise(r=>server.close(r));console.log(JSON.stringify(report));}
