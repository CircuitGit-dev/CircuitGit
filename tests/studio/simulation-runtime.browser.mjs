// Source-only browser checks with intercepted assets and a synthetic runtime adapter.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const files=['modules/simulation/runtime.js','modules/simulation/report.js','modules/simulation/http.js','modules/simulation/style.css','tests/studio/runtime.fixture.mjs','tests/studio/simulation-report.fixture.mjs'];
const assets=new Map(await Promise.all(files.map(async path=>['/'+path,await readFile(resolve(root,path),'utf8')])));
const html='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/modules/simulation/style.css"><style>body{margin:0}</style><section class="ic-sim-panel"><div id="runtime"></div></section><script type="module">import {mountRuntime} from "/modules/simulation/runtime.js";import {runtimeFixture} from "/tests/studio/runtime.fixture.mjs";window.fixture=runtimeFixture();window.runtime=mountRuntime(document.getElementById("runtime"),{host:fixture.host,actions:fixture.actions,actionPolicy:()=>fixture.policy});</script>';

test('runtime browser shows cached evidence gates actions and disposes visible polling',async t=>{
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  const page=await browser.newPage({viewport:{width:340,height:960}}),errors=[],unexpected=[];
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());
    if(url.origin!=='https://runtime.test'||url.pathname!=='/'&&!assets.has(url.pathname)){unexpected.push(url.href);return route.abort();}
    await route.fulfill({status:200,contentType:url.pathname==='/'?'text/html':url.pathname.endsWith('.css')?'text/css':'text/javascript',body:url.pathname==='/'?html:assets.get(url.pathname)});
  });
  const action=name=>page.locator(`[data-runtime-action="${name}"]`);
  const count=method=>page.evaluate(method=>fixture.calls.filter(c=>c.options?.method===method).length,method);
  const refresh=async()=>{await page.evaluate(()=>runtime.controller.refresh({force:true}));};
  try{
    await page.clock.install({time:new Date('2026-11-23T12:00:00Z')});
    await page.goto('https://runtime.test/');await page.locator('[data-runtime-host="node-a"]').waitFor();
    await t.test('unknown resources and original stale timestamps are visible without a scan',async()=>{
      assert.equal(await count('POST'),0);assert.equal(await count('GET'),1);
      const second=page.locator('[data-runtime-host="node-b"]');assert.match(await second.innerText(),/未知/);assert.match(await second.innerText(),/资源观察已过期/);assert.match(await second.innerText(),/2026-01-01T00:00:00Z/);
      assert.equal(await page.locator('[data-report-status="unknown"]').count(),5);assert.equal(await action('submit').isDisabled(),true);assert.equal(await action('collect').isDisabled(),true);
    });
    await t.test('five scoped verdicts show function pass independently of SOA and dependency failures',async()=>{
      await page.evaluate(async()=>{const {simulationReport}=await import('/tests/studio/simulation-report.fixture.mjs');const run=fixture.snapshot.runs[0];run.report=simulationReport();run.execution={state:'completed',exit_code:0};run.acceptance={...run.report.diagnostics.scientific_acceptance};run.diagnostics=structuredClone(run.report.diagnostics);});await refresh();
      assert.deepEqual(await page.locator('[data-report-dimension]').evaluateAll(nodes=>nodes.map(node=>[node.dataset.reportDimension,node.dataset.reportStatus])),[
        ['execution_status','completed'],['measurement_validity','valid'],['functional_performance','pass'],['operating_qualification','violations_detected'],['dependency_provenance','incomplete']]);
      assert.match(await page.locator('[data-report-warnings]').innerText(),/54.*30,703/);
      assert.equal(await page.getByText('全部通过',{exact:true}).count(),0);
      const evidence=page.locator('[data-runtime-detail="report-run-1"]');
      await evidence.locator('summary').click();await refresh();assert.equal(await evidence.getAttribute('open'),'');
      assert.match(await evidence.innerText(),/TMI 未在运行前登记/);assert.match(await evidence.innerText(),/电压 SOA/);
      for(const width of [260,340,640]){await page.setViewportSize({width,height:960});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
      if(process.env.EVIDENCE_DIR){await mkdir(process.env.EVIDENCE_DIR,{recursive:true});await page.setViewportSize({width:340,height:960});await page.screenshot({path:resolve(process.env.EVIDENCE_DIR,'diagnostic-report-340.png'),fullPage:true});}
      await evidence.locator('summary').click();
      await page.evaluate(()=>{delete fixture.snapshot.runs[0].report;});await refresh();
      assert.equal(await page.locator('[data-report-status="unknown"]').count(),5,'Exit 0 and legacy pass cannot manufacture report verdicts');
    });
    await t.test('five-second reads pause while hidden and never become resource scans',async()=>{
      const before=await count('GET');await page.clock.runFor(5000);assert.equal(await count('GET'),before+1);
      await page.evaluate(()=>{document.getElementById('runtime').hidden=true;});await page.clock.runFor(10000);assert.equal(await count('GET'),before+1);
      await page.evaluate(()=>{document.getElementById('runtime').hidden=false;});await page.clock.runFor(5000);assert.equal(await count('GET'),before+2);assert.equal(await count('POST'),0);
    });
    await t.test('explicit resource scan posts only the current project and disables while running',async()=>{
      await action('scan').click();await page.waitForFunction(()=>fixture.calls.some(c=>c.options?.method==='POST'));
      assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(c=>c.options?.method==='POST').map(c=>c.options.body)),[{project_id:'p'}]);
      assert.equal(await action('scan').isDisabled(),true);await page.clock.runFor(5000);assert.equal(await count('POST'),1);
      await page.evaluate(()=>{fixture.snapshot.pool.configured=false;fixture.snapshot.pool.scan_in_progress=false;});await refresh();assert.equal(await action('scan').isDisabled(),true);
    });
    await t.test('diagnostic code category actions and excerpts remain literal untrusted text',async()=>{
      await page.evaluate(()=>{const finding=fixture.snapshot.runs[0].diagnostics.diagnostics[0];finding.code='<img src=x onerror="window.injected=1">';finding.category='<script>window.injected=1</script>';finding.suggested_actions=['<svg onload="window.injected=1">'];finding.redacted_excerpt='<iframe src="https://evil.invalid"></iframe>';});await refresh();
      await page.locator('[data-runtime-detail="diagnostics-run-1"] summary').click();
      assert.match(await page.locator('.ic-runtime-finding').innerText(),/<img src=x/);assert.equal(await page.locator('#runtime img,#runtime script,#runtime svg,#runtime iframe').count(),0);
      assert.equal(await page.evaluate(()=>window.injected),undefined);
    });
    await t.test('direct actions need both explicit capabilities and callback policy',async()=>{
      await page.evaluate(()=>{fixture.snapshot.capabilities.direct_submit=true;fixture.snapshot.capabilities.direct_collect=true;fixture.policy.submit=false;});await refresh();
      assert.equal(await action('submit').isDisabled(),true);assert.equal(await action('collect').isEnabled(),true);
      await page.evaluate(()=>{fixture.snapshot.runs[0].execution.state='running';fixture.snapshot.runs[0].collectable=false;});await refresh();
      assert.equal(await action('collect').isDisabled(),true);
      await page.evaluate(()=>{fixture.snapshot.runs[0].execution.state='failed';fixture.snapshot.runs[0].execution.raw_state='preflight_failed';});await refresh();
      assert.equal(await action('collect').isDisabled(),true,'Failure without a remote terminal record is not collectable');
      await page.evaluate(()=>{delete fixture.snapshot.runs[0].collectable;});await refresh();
      assert.equal(await action('collect').isDisabled(),true,'Missing capability does not enable collection');
      await page.evaluate(()=>{fixture.snapshot.runs[0].execution.state='completed';fixture.snapshot.runs[0].collectable=true;});await refresh();
      assert.equal(await action('collect').isEnabled(),true);
      await action('collect').click();await page.waitForFunction(()=>fixture.calls.some(c=>c.kind==='collect-callback'));
      assert.equal(await page.evaluate(()=>fixture.calls.find(c=>c.kind==='collect-callback').run_id),'run-1');
      await page.evaluate(()=>{fixture.policy.submit=true;runtime.update();});await action('submit').click();await page.waitForFunction(()=>fixture.calls.some(c=>c.kind==='submit-callback'));
      assert.equal(await count('POST'),1); // The only direct HTTP mutation remains the explicit scan.
    });
    await t.test('260/340/640px render without document overflow',async()=>{
      await page.evaluate(()=>{fixture.snapshot.pool.configured=true;const finding=fixture.snapshot.runs[0].diagnostics.diagnostics[0];finding.code='spectre_suspected_oom';finding.category='suspected_oom';finding.suggested_actions=['Inspect run-bound kernel or cgroup OOM evidence before assigning a cause.'];finding.redacted_excerpt='Process exited with code 137';});await refresh();
      for(const width of [260,340,640]){await page.setViewportSize({width,height:960});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
      if(process.env.EVIDENCE_DIR){await mkdir(process.env.EVIDENCE_DIR,{recursive:true});await page.setViewportSize({width:340,height:960});await page.screenshot({path:resolve(process.env.EVIDENCE_DIR,'runtime-340.png'),fullPage:true});}
    });
    await t.test('dispose stops recurring cache reads and removes context listener',async()=>{
      const before=await count('GET');await page.evaluate(()=>runtime.destroy());await page.clock.runFor(10000);
      assert.equal(await count('GET'),before);assert.equal(await page.evaluate(()=>fixture.listeners.size),0);assert.equal(await page.locator('.ic-runtime-host').count(),0);
    });
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  }finally{await browser.close();}
});
