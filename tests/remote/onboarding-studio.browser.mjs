// Built local Studio, actual Gateway/onboarding bridge, Dockview and waveform UI.
// All HTTP is intercepted. Original waveform vectors are explicitly synthetic;
// onboarding responses use the saved native-reader fixture unchanged. No real
// gateway, historical project, model, SSH or solver is contacted.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url)),web=resolve(root,'web');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixtureRaw=await readFile(new URL('./fixtures/onboarding-waveforms.example.json',import.meta.url),'utf8');
const record=JSON.parse(fixtureRaw),descriptor=record.descriptor,signalId=descriptor.available_signal_ids[0];
const planId='b'.repeat(64),connectionId='synthetic-studio-onboarding-store',projectId='synthetic-studio-project',originalRun='synthetic-studio-original-run';
const intake={schema:'ic.onboarding.session.v1',connection_id:connectionId,intake_id:descriptor.intake_id,revision:4,
  source_sha256:descriptor.original_source_sha256,source_commit:descriptor.source_commit,
  prepared:{schema:'ic.experiment.plan.v1',state:'prepared',plan_id:planId,source_commit:descriptor.source_commit,project_id:descriptor.intake_id,recipe_id:'synthetic'},
  source_mapping:{source_commit:descriptor.source_commit,source_id:descriptor.compiled_source_path,original_source_sha256:descriptor.original_source_sha256,
    compiled_source_sha256:descriptor.compiled_source_sha256,transformation:descriptor.transformation}};
const job={schema:'ic.experiment.job.v1',plan_id:planId,project_id:descriptor.intake_id,configuration:'synthetic',job_id:descriptor.job_id,
  run_id:descriptor.run_id,source_commit:descriptor.source_commit,state:'synthetic_fixture',waveforms:descriptor};
const originalJob={job_id:originalRun,run_id:originalRun,project_id:projectId,configuration:'synthetic-original',source_commit:'c'.repeat(40),state:'collected'};
const project={projects:[{id:projectId,name:'Synthetic canonical project',source_path:'synthetic/source.scs',configurations:[]}],active_project:projectId,
  branch:'synthetic-fixture',source_commit:originalJob.source_commit,repository:'synthetic-local-only'};
const origin='https://onboarding-studio.test',calls=[],errors=[],unexpected=[],assets=new Map();
const mime={'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html','.svg':'image/svg+xml','.wasm':'application/wasm','.woff2':'font/woff2','.png':'image/png'};
const report={kind:'synthetic-built-local-studio-integration',real_network:false,real_ssh:false,real_simulation:false,real_inference:false,
  fixture_sha256:createHash('sha256').update(fixtureRaw).digest('hex'),checks:[],ai_status_reads:[],model_requests:0};
let emptyProject=true,foreign=false,waveGate=null;
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext(),page=await context.newPage({viewport:{width:1500,height:980}});
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
const response=(route,data)=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});

function originalWave(suffix){
  const wrapper=record.requests.find(row=>row.path.endsWith('/'+({signals:'catalog','waveform-map':'mapping',waveform:'window'}[suffix]))).response.data;
  const data=structuredClone(suffix==='signals'?wrapper.catalog:suffix==='waveform-map'?wrapper.mapping:wrapper.series[0]);
  data.run_id=originalRun;data.source_commit=originalJob.source_commit;
  if(data.signals)for(const signal of data.signals){signal.id='synthetic-project-out';signal.label='Project OUT';}
  if(data.signal){data.signal.id='synthetic-project-out';data.signal.label='Project OUT';}
  return data;
}

await context.route('**/*',async route=>{
  try{
    const request=route.request(),url=new URL(request.url());
    assert.equal(url.origin,origin,'Unexpected external request');
    if(url.pathname.startsWith('/api/')){
      calls.push({path:url.pathname,query:url.search,method:request.method()});
      if(url.pathname.startsWith('/api/ai/')){
        report.ai_status_reads.push(url.pathname);
        throw Error('Simulation-only health must prevent all AI reads and writes');
      }
      if(url.pathname==='/api/health')return response(route,{api_version:'1',mode:'live',mutation_token:'synthetic-mutation-token',connection_id:connectionId,
        capabilities:{simulation_onboarding:true,simulation_onboarding_api_version:'1',chat:false,runner:false,publish:false,git:false,viewer:true}});
      if(url.pathname==='/api/project')return response(route,emptyProject?{projects:[],active_project:null,source_commit:null,branch:'synthetic-empty'}:project);
      if(url.pathname==='/api/jobs')return response(route,{jobs:emptyProject?[]:[originalJob]});
      if(url.pathname==='/api/tree')return response(route,{files:[]});
      if(url.pathname==='/api/file')return response(route,{path:'synthetic/source.scs',content:record.source_text,sha256:descriptor.original_source_sha256,base_commit:originalJob.source_commit,editable:false});
      if(url.pathname==='/api/schematic')return response(route,{geometry:{mode:'unavailable'}});
      if(url.pathname==='/api/supervision')return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'fixture_unavailable',message:'Supervision is intentionally unavailable in this synthetic lifecycle fixture.'}})});
      if(url.pathname.startsWith('/api/jobs/'+originalRun+'/'))return response(route,originalWave(url.pathname.split('/').at(-1)));
      if(url.pathname==='/api/simulation/onboarding/netlist'){
        assert.equal(request.method(),'POST');assert.equal(request.headers()['x-workbench-token'],'synthetic-mutation-token');
        assert.equal(request.postDataJSON().text,record.source_text);return response(route,intake);
      }
      const found=record.requests.find(row=>row.path===url.pathname);
      assert(found,'Unexpected gateway operation '+url.pathname);assert.equal(request.method(),'GET');
      assert.equal(url.searchParams.get('intake_id'),descriptor.intake_id);assert.equal(url.searchParams.get('job_id'),descriptor.job_id);
      if(waveGate&&/\/(catalog|mapping)$/.test(url.pathname)){
        const gate=waveGate;if(++gate.arrived===2)gate.ready();await gate.released;
      }
      const data=structuredClone(found.response.data);if(foreign)data.run_id='foreign-run';return response(route,data);
    }
    const file=resolve(web,'.'+url.pathname);assert(file.startsWith(web+sep));
    if(!assets.has(file))assets.set(file,await readFile(file));let body=assets.get(file);
    if(url.pathname==='/studio/dockview/waveforms.js'){
      // Observe the actual renderer's lifetime without replacing its behavior.
      body=body.toString().replace('export function mount(host,','function observedMount(host,')+`
export function mount(...args){
  const stats=window.fixtureWaveLifetimes||(window.fixtureWaveLifetimes={created:0,destroyed:0,active:0,maxActive:0});
  const result=observedMount(...args);stats.created++;stats.active++;stats.maxActive=Math.max(stats.maxActive,stats.active);
  let disposed=false;return {...result,destroy(){if(!disposed){disposed=true;stats.destroyed++;stats.active--;}return result.destroy();}};
}
`;
    }
    return route.fulfill({contentType:mime[extname(file)]||'application/octet-stream',body});
  }catch(error){unexpected.push(error.message);await route.abort();}
});

const ready=()=>page.waitForFunction(()=>window.ICRNLStudio&&window.ICStudioDock&&document.body.dataset.workbenchState==='ready');
const waveformStats=()=>page.evaluate(()=>({...window.fixtureWaveLifetimes,canvases:document.querySelectorAll('.wf-plot').length,
  signalDialogs:document.querySelectorAll('.wf-dialog-signals').length,styles:[...document.querySelectorAll('link[rel=stylesheet]')].filter(el=>el.href.endsWith('/waveforms/panel.css')).length}));
async function exactlyOne(){
  await page.waitForFunction(()=>window.fixtureWaveLifetimes?.active===1&&document.querySelectorAll('.wf-plot').length===1);
  const stats=await waveformStats();assert.equal(stats.active,1);assert.equal(stats.maxActive,1);assert.equal(stats.canvases,1);assert.equal(stats.signalDialogs,1);assert.equal(stats.styles,1);
  return stats;
}
async function connect(){await page.evaluate(()=>ICRNLStudio.onboarding.connect());assert.equal(await page.evaluate(()=>ICRNLStudio.onboarding.getState().connected),true);}
async function importIntake(){await page.evaluate(async source=>{await ICRNLStudio.onboarding.inspectNetlist({file_name:'synthetic-waveform.scs',text:source});},record.source_text);}
async function openOnboarding(){await page.evaluate(payload=>ICRNLStudio.openOnboardingWaveforms(payload),{intake,job});await addSignal(signalId);}
async function addSignal(id){
  if(!await page.getByRole('dialog',{name:'添加信号',exact:true}).isVisible())await page.evaluate(()=>viewer.command('plot.signals'));
  await page.getByRole('dialog',{name:'添加信号',exact:true}).waitFor();await page.locator(`[data-signal-id="${id}"]`).click();await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('.wf-status')?.textContent==='已加载真实运行数据。');await exactlyOne();
}
async function unchanged(original){assert.deepEqual(await page.evaluate(()=>ICRNLStudio.context.getContext()),original);}

try{
  await page.goto(origin+'/studio/index.html?layout=dockview');await ready();
  assert.equal(await page.locator('#studio-project').isDisabled(),true);assert.match(await page.locator('#studio-project').innerText(),/导入网表后开始/);
  assert.equal(await page.evaluate(()=>ICRNLStudio.getProject().projects.length),0);
  await connect();assert.equal(await page.evaluate(()=>ICRNLStudio.onboarding.getState().mode),'same-origin');
  assert.equal(calls.some(row=>row.path==='/node/info'),false);
  report.checks.push('empty /api/project catalogue reaches ready Studio; same-origin onboarding connects through /api/health');

  emptyProject=false;await page.reload();await ready();
  await page.waitForFunction(id=>ICRNLStudio.getRuns().some(row=>row.run_id===id),originalRun);
  await page.evaluate(id=>ICRNLStudio.selectRun(id),originalRun);await addSignal('synthetic-project-out');
  let originalContext=await page.evaluate(()=>ICRNLStudio.context.getContext());
  assert.equal(originalContext.project.id,projectId);assert.equal(originalContext.run.runId,originalRun);
  await connect();await importIntake();
  foreign=true;const rejection=await page.evaluate(async payload=>{try{await ICRNLStudio.openOnboardingWaveforms(payload);return null;}catch(error){return error.message;}},{intake,job});
  assert.match(rejection,/不一致/);foreign=false;assert.equal(await page.locator('.wf-trace').count(),1);await unchanged(originalContext);await exactlyOne();
  report.checks.push('foreign onboarding run is rejected without destroying the selected project waveform');

  let releaseRace,requestsArrived;
  const arrived=new Promise(resolve=>requestsArrived=resolve),released=new Promise(resolve=>releaseRace=resolve);
  waveGate={arrived:0,ready:requestsArrived,released,release:releaseRace};
  await page.evaluate(payload=>{window.fixtureRaceResult=null;window.fixtureRace=ICRNLStudio.openOnboardingWaveforms(payload).then(()=>{fixtureRaceResult={opened:true};},error=>{fixtureRaceResult={error:error.message};});},{intake,job});
  let raceTimeout;await Promise.race([arrived,new Promise((_,reject)=>raceTimeout=setTimeout(()=>reject(Error('Delayed waveform requests did not arrive')),5000))]).finally(()=>clearTimeout(raceTimeout));
  const beforeRace=await waveformStats();await page.evaluate(id=>ICRNLStudio.selectRun(id),originalRun);
  waveGate=null;releaseRace();await page.evaluate(()=>fixtureRace);
  assert.match(await page.evaluate(()=>fixtureRaceResult.error),/窗口或电路已变化/);
  assert.equal(await page.evaluate(()=>ICRNLStudio.context.getContext().run.runId),originalRun);
  assert.equal((await exactlyOne()).created,beforeRace.created);
  const afterSelection=await page.evaluate(()=>ICRNLStudio.context.getContext());
  assert.deepEqual({...afterSelection,revision:originalContext.revision},originalContext);
  originalContext=afterSelection;
  report.checks.push('selectRun cancels a delayed onboarding open before it can replace the newly selected project renderer');

  await openOnboarding();await unchanged(originalContext);
  assert.equal(await page.locator('.wf-trace').count(),1);assert.match(await page.locator('.wf-legend').innerText(),/out/);
  await page.evaluate(()=>window.fixtureCanvas=document.querySelector('.wf-plot'));const mounted=await waveformStats();
  await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.close());
  assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms')===undefined),true);
  await page.evaluate(()=>viewer.command('plot.open'));await page.locator('.wf-plot').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>window.fixtureCanvas===document.querySelector('.wf-plot')),true);
  assert.equal((await exactlyOne()).created,mounted.created);await unchanged(originalContext);
  report.checks.push('onboarding replaces the project renderer once; close/reopen preserves the exact curve canvas and schematic context');

  await page.evaluate(()=>{const api=ICStudioDock.api;api.getPanel('waveforms').api.moveTo({group:api.getPanel('simulation').group,position:'center'});api.getPanel('simulation').api.setActive();});
  assert.equal(await page.evaluate(()=>ICStudioDock.api.getPanel('waveforms').api.isVisible),false);
  assert.equal(await page.evaluate(()=>document.querySelector('.wf-plot').isConnected),true);
  await openOnboarding();await unchanged(originalContext);await exactlyOne();
  report.checks.push('a replacement opened from an inactive waveform tab remounts once into its owned panel');

  await page.evaluate(()=>window.fixtureCanvas=document.querySelector('.wf-plot'));const beforeReset=await waveformStats();
  await page.evaluate(()=>ICStudioDock.reset());await page.locator('.wf-plot').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>window.fixtureCanvas===document.querySelector('.wf-plot')),true);
  assert.equal((await exactlyOne()).created,beforeReset.created);await unchanged(originalContext);
  report.checks.push('Dockview reset preserves the onboarding controller and displayed curve instead of mounting duplicates');

  await page.evaluate(()=>viewer.command('plot.project'));await addSignal('synthetic-project-out');await unchanged(originalContext);
  assert.equal(await page.locator('.wf-trace').count(),1);assert.match(await page.locator('.wf-legend').innerText(),/Project OUT/);
  report.checks.push('explicit return destroys the onboarding renderer and restores the original registered project run');

  // Saved closed panels exercise lazyPlot.ensure before any original renderer
  // has attached in the new document, not merely a close/reopen of live DOM.
  await page.evaluate(()=>{ICStudioDock.api.getPanel('waveforms').api.close();ICStudioDock.api.getPanel('ai').api.close();});
  await page.waitForTimeout(250);await page.reload();await ready();
  assert.equal(await page.locator('.wf-plot').count(),0);assert.equal(await page.evaluate(()=>!!ICStudioDock.api.getPanel('waveforms')),false);
  const emptyRunContext=await page.evaluate(()=>ICRNLStudio.context.getContext());await connect();await importIntake();await openOnboarding();
  await unchanged(emptyRunContext);assert.equal((await exactlyOne()).active,1);
  report.checks.push('saved-closed waveform panel lazily initializes and opens onboarding with one live controller');

  const beforeDisconnect=calls.length;await page.evaluate(()=>ICRNLStudio.onboarding.disconnect());await page.locator('.wf-plot').focus();await page.keyboard.press('+');
  await page.waitForFunction(()=>document.querySelector('.wf-status')?.textContent.includes('连接已变化'));
  assert.equal(calls.length,beforeDisconnect);assert.equal(await page.locator('.wf-trace').count(),1);
  report.checks.push('disconnect keeps the saved curve and stops subsequent provider reads');

  assert.equal(calls.some(row=>row.method!=='GET'&&row.path!=='/api/simulation/onboarding/netlist'),false);
  assert.equal(calls.some(row=>/\/(?:probe|run|inspect|preflight|collect|publish|scan)$/.test(row.path)),false);
  assert.deepEqual(report.ai_status_reads,[]);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);report.status='passed';report.lifecycle=await waveformStats();
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;}
finally{
  waveGate?.release();
  report.calls=calls;report.errors=errors;report.unexpected=unexpected;
  const output=process.env.EVIDENCE_DIR||'/tmp/circuitgit-onboarding-studio';await mkdir(output,{recursive:true});
  await page.screenshot({path:resolve(output,'onboarding-studio.png')});await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
  await browser.close();console.log(JSON.stringify(report));
}
