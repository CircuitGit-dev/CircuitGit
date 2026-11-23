// Browser reload regression with intercepted local fixtures; no gateway or SSH.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const files=['modules/simulation/panel.js','modules/simulation/model.js','modules/simulation/receipts.js','modules/simulation/supervision.js','modules/simulation/runtime.js','modules/simulation/report.js','modules/simulation/style.css','tests/studio/simulation-panel.fixture.mjs','tests/studio/runtime.fixture.mjs'];
const assets=new Map(await Promise.all(files.map(async file=>['/'+file,await readFile(root+file,'utf8')])));
const html=`<!doctype html><meta charset="utf-8"><div id="simulation"></div><script type="module">
import {mount} from '/modules/simulation/panel.js';
import {createPanelFixture} from '/tests/studio/simulation-panel.fixture.mjs';
import {runtimeFixture} from '/tests/studio/runtime.fixture.mjs';
window.fixture=createPanelFixture(document);const cached=fixture.host.gateway.request;
const runtime=runtimeFixture().snapshot;runtime.project_id='fixture-project';runtime.runs=[];runtime.capabilities.direct_submit=true;
fixture.host.gateway.request=async(path,options={})=>{
  if(path.startsWith('/simulation/runtime?'))return structuredClone(runtime);
  if(path==='/simulation/control'||path.startsWith('/submissions/')){
    const response=await fetch('/api'+path,{method:options.method||'GET',body:options.body?JSON.stringify(options.body):undefined});
    const result=await response.json();if(!response.ok)throw Error('Synthetic reply lost after submission');return result;
  }
  return cached(path,options);
};
window.panel=mount(fixture.host);
</script>`;

test('direct browser preserves pending across reload, rejects wrong mapping, and only reads original key',async()=>{
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  const page=await browser.newPage({viewport:{width:500,height:1000}}),errors=[],requests=[];
  let mismatch=true;page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!=='https://direct.test')throw Error('Unexpected external request');
    if(url.pathname==='/api/simulation/control'){
      requests.push({method:request.method(),body:request.postDataJSON()});
      return route.fulfill({status:503,contentType:'application/json',body:'{}'});
    }
    if(url.pathname.startsWith('/api/submissions/')){
      const key=decodeURIComponent(url.pathname.slice('/api/submissions/'.length));requests.push({method:request.method(),key});
      return route.fulfill({contentType:'application/json',body:JSON.stringify({schema:'ic.submission.lookup.v1',submission_key:key,found:true,read_at:new Date().toISOString(),run_id:'remote-run',run:{run_id:'remote-run',project_id:'fixture-project',original_project_id:'fixture-project',source_commit:'a'.repeat(40),configuration:mismatch?'wrong':'tran',state:'submitted'}})});
    }
    if(url.pathname!=='/'&&!assets.has(url.pathname))throw Error('Unexpected asset '+url.pathname);
    return route.fulfill({contentType:url.pathname==='/'?'text/html':url.pathname.endsWith('.css')?'text/css':'text/javascript',body:url.pathname==='/'?html:assets.get(url.pathname)});
  });
  try{
    await page.goto('https://direct.test/');await page.locator('[data-field="analysis-stop"]').waitFor();
    await page.evaluate(()=>sessionStorage.setItem('unrelated','preserve'));
    await page.getByRole('button',{name:'资源与监控',exact:true}).click();
    const submit=page.locator('[data-runtime-action="submit"]');await submit.click();
    await page.locator('[data-role="direct-pending"]').waitFor();assert.equal(requests.length,1);
    const original=requests[0].body;assert.equal(original.operation,'submit');
    await page.reload();await page.locator('[data-role="direct-pending"]').waitFor();
    await page.getByRole('button',{name:'资源与监控',exact:true}).click();assert.equal(await submit.isDisabled(),true);
    await page.getByRole('button',{name:'只读核对原提交',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.ic-sim-error')?.textContent.includes('身份'));
    assert.equal(await page.locator('[data-role="direct-pending"]').count(),1);assert.equal(await submit.isDisabled(),true);
    mismatch=false;await page.getByRole('button',{name:'只读核对原提交',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[data-role="direct-pending"]'));
    assert.deepEqual(requests,[{method:'POST',body:original},{method:'GET',key:original.idempotency_key},{method:'GET',key:original.idempotency_key}]);
    assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('circuitgit.simulation.pending.')).length),0);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('unrelated')),'preserve');
    assert.equal(await page.evaluate(()=>fixture.calls.filter(call=>call.name==='selectRun').at(-1).args[0]),'remote-run');
    await page.evaluate(()=>panel.destroy());assert.equal(await page.locator('.ic-sim-panel').count(),0);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
