// Real browser + a synthetic local helper. Every request is intercepted; no model,
// existing helper, SSH, PDK, previous profile or simulator is contacted.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const origin='https://onboarding-fixture.test',helper='http://127.0.0.1:18885',calls=[],errors=[],token='f'.repeat(43),intake='intake-browser-fixture',plan='plan-browser-fixture';
const session=revision=>({schema:'ic.onboarding.session.v1',connection_id:'fixture-fresh-store',intake_id:intake,revision,source_commit:null});
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext(),page=await context.newPage();
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===origin){
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><meta charset="utf-8"><button id="connect">连接仿真环境</button><button id="import">导入测试网表</button><button id="run">提交模拟请求</button><button id="restore">核对原请求</button><button id="disconnect">断开</button><pre id="status"></pre><script type="module">
      import {createOnboardingBridge} from '/src/apps/web/remote/onboarding-bridge.js';
      const bridge=createOnboardingBridge();window.bridge=bridge;const status=document.querySelector('#status');
      const action=fn=>async()=>{try{status.textContent=JSON.stringify(await fn());}catch(error){status.textContent=JSON.stringify({error:error.data?.code||error.message});}};
      document.querySelector('#connect').onclick=action(()=>bridge.connect({port:18885}));
      document.querySelector('#import').onclick=action(()=>bridge.inspectNetlist({file_name:'fixture.scs',text:'// Synthetic test only'}));
      document.querySelector('#run').onclick=action(()=>bridge.runPrepared({intake_id:${JSON.stringify(intake)},revision:0,plan_id:${JSON.stringify(plan)}}));
      document.querySelector('#restore').onclick=action(()=>bridge.readSubmission({intake_id:${JSON.stringify(intake)},plan_id:${JSON.stringify(plan)}}));
      document.querySelector('#disconnect').onclick=()=>bridge.disconnect();window.ready=true;
    </script></html>`});
    assert(url.pathname.startsWith('/src/'));const path=resolve(root,url.pathname.slice(5));assert(path.startsWith(root+sep));
    return route.fulfill({contentType:'text/javascript',body:await readFile(path)});
  }
  assert.equal(url.origin,helper,'unexpected external request');
  if(url.pathname==='/connect'){
    const state=url.searchParams.get('state');assert.equal(url.searchParams.get('origin'),origin);
    return route.fulfill({contentType:'text/html',body:`<button id="allow">允许并连接</button><script>opener.postMessage({type:'circuitgit.local.ready',state:${JSON.stringify(state)}},${JSON.stringify(origin)});document.querySelector('#allow').onclick=()=>opener.postMessage({type:'circuitgit.local.result',state:${JSON.stringify(state)},allowed:true,accessCode:${JSON.stringify(token)}},${JSON.stringify(origin)});</script>`});
  }
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Private-Network':'true'}});
  assert.equal(request.headers().authorization,'Bearer '+token);calls.push({path:url.pathname,method:request.method(),query:url.search});let data;
  if(url.pathname==='/node/info')data={schema:'circuitgit.remote-node.v1',single_owner:true,auth:'bearer',node_id:'fixture-node',connection_id:'fixture-fresh-store',capabilities:{chat:false,simulation_onboarding:true,simulation_onboarding_api_version:'1'}};
  else if(url.pathname==='/api/simulation/onboarding/netlist')data=session(0);
  else if(url.pathname==='/api/simulation/onboarding/run')return route.abort('failed');
  else if(url.pathname==='/api/simulation/onboarding/submission')data={intake_id:intake,plan_id:plan,found:false,submission_key:'experiment-'+plan,replay_permitted:false};
  else throw Error('Unexpected fixture operation '+url.pathname);
  return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':origin},body:JSON.stringify({ok:true,data})});
});
async function connect(){const popupReady=page.waitForEvent('popup');await page.locator('#connect').click();const popup=await popupReady;await popup.locator('#allow').click();await page.waitForFunction(()=>window.bridge.getState().connected);}
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready);assert.equal(calls.length,0);
  await connect();assert.deepEqual(calls.map(call=>call.path),['/node/info']);
  await page.locator('#import').click();await page.waitForFunction(()=>window.bridge.getState().selectedIntakeId!==null);
  await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('transport_unknown'));
  const original=await page.evaluate(()=>bridge.pendingStore.load({connectionId:bridge.getState().connectionId}));assert.equal(original[0].submission_key,'experiment-'+plan);
  await page.reload();await page.waitForFunction(()=>window.ready);const before=calls.length;await connect();assert.equal(calls.length,before+1,'reconnect only reads helper identity');
  await page.locator('#restore').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('"found":false'));
  await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('replay_forbidden'));
  assert.equal(calls.filter(call=>call.path.endsWith('/run')).length,1);assert.equal(calls.some(call=>call.path.includes('/ai/')),false);assert.deepEqual(errors,[]);
  const report={status:'passed',fixture:true,real_inference:false,real_ssh:false,real_simulation:false,checks:['explicit pairing at selected port','chat=false supported','no automatic AI or discovery calls','durable original run key','reload original-key lookup only','found=false never replays'],calls,errors};
  if(process.env.EVIDENCE_DIR){await mkdir(process.env.EVIDENCE_DIR,{recursive:true});await writeFile(resolve(process.env.EVIDENCE_DIR,'onboarding-adapter-report.json'),JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report));
}finally{await browser.close();}
