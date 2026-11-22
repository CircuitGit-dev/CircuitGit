// Independent wave UI mounted through an explicit host-contract fixture; real local saved reads only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const gateway=new URL(process.env.IC_GATEWAY_URL||'http://127.0.0.1:8766');assert.equal(gateway.hostname,'127.0.0.1');
const run='20261109T054442Z-1d9279ef0b-014b97a6',out=resolve(process.env.EVIDENCE_DIR||root+'/test-results/codex-waveforms');await mkdir(out,{recursive:true});
const report={status:'running',scope:'host-contract fixture and existing real saved-waveform GETs; view writes remain in-memory fixtures; no native MCP mount claim',checks:[],hostCalls:[],gatewayReads:[],modelContexts:[],errors:[],mutationsOnGateway:0};
const originalRoot=process.env.IC_RUNS_ROOT;
const sha=b=>createHash('sha256').update(b).digest('hex');
async function hashes(){if(!originalRoot)return null;const result={};for(const rid of ['20261109T054143Z-1d9279ef0b-5380487a',run,'20261109T071529Z-ba49b4ff1c-955216aa'])for(const name of ['run.json','waveforms.csv','full-results.tar.gz'])result[rid+'/'+name]=sha(await readFile(resolve(originalRoot,rid,name)));return result;}
const before=await hashes();
async function readGateway(path){assert(/^\/api\/jobs$/.test(path)||new RegExp('^/api/jobs/'+run+'/(signals|waveform-map|waveform)(\\?|$)').test(path));const r=await fetch(new URL(path,gateway));const b=await r.json();report.gatewayReads.push({path,status:r.status});if(!r.ok||!b.ok)throw Object.assign(Error(b.error?.message||'Gateway error'),{code:b.error?.code||'gateway_error'});return b.data;}
const catalog=await readGateway('/api/jobs/'+run+'/signals'),mapping=await readGateway('/api/jobs/'+run+'/waveform-map'),jobs=await readGateway('/api/jobs');
const ids=catalog.signals.filter(s=>s.status==='available').map(s=>s.id);assert.equal(ids.length,6);
const views=new Map(),summaries=new Map();let conflictNextSelection=false;
function fixtureView(instance){return {schema:'ic.view.v1',view_id:'v_'+(instance==='a'?'1':'3').repeat(32),workspace_id:'w_'+(instance==='a'?'2':'4').repeat(32),kind:'waveforms',revision:1,
 identity:{project_id:'real-sar-20261106',source_commit:catalog.source_commit,source_sha256:mapping.source.sha256,path:null,configuration:'PIPE_LOW',run_id:run},selection:null,
 readiness:{state:'requested',basis:'server-request',message:null},ui:{resource_uri:'ui://ic-workbench/waveforms.html',available:true,mounted:null},visible:true,display_mode:'inline',draft_dirty:false,review_id:null,plan_ready:false,requests:[],workspace_revision:1};}
const copy=x=>structuredClone(x),conflict=m=>Object.assign(Error(m),{code:'conflict'});
async function fixtureCall(instance,name,args){
 const v=views.get(instance);assert(v);assert.equal(args.workspace_id,v.workspace_id);assert.equal(args.view_id,v.view_id);report.hostCalls.push({instance,name,args});
 if(name==='ic_view_get')return copy(v);
 if(instance==='a'&&name==='ic_view_select'&&conflictNextSelection){conflictNextSelection=false;v.revision++;}
 if((args.revision??args.expected_revision)!==v.revision)throw conflict('fixture revision conflict');
 if(name==='ic_view_data'){
  const q=args.query;let payload;
  if(q.kind==='runs')payload={jobs:jobs.jobs.filter(j=>j.associated_project_id===v.identity.project_id)};
  else if(q.kind==='signals')payload=catalog;
  else if(q.kind==='mapping')payload=instance==='b'?{status:'unmapped',run_id:run,source_commit:catalog.source_commit}:mapping;
  else if(q.kind==='waveform'){const params={signal_id:q.signal_id,analysis:q.analysis||'tran'};for(const k of ['start','end','limit','cursor_a','cursor_b'])if(q[k]!==undefined)params[k]=q[k];payload=await readGateway('/api/jobs/'+run+'/waveform?'+new URLSearchParams(params));}
  else throw Error('Fixture query not allowed');
  return {view:copy(v),kind:q.kind,payload};
 }
 if(name==='ic_view_select'){
  const s=args.selection;if(s.kind==='signals')assert(s.signal_ids.every(id=>ids.includes(id)));else assert.equal(s.kind,'none');
  v.selection=s.kind==='none'?null:{...s,verification:'saved-signal-catalog',source_commit:v.identity.source_commit,run_id:run};
 }else if(name==='ic_view_state'){assert.equal(args.client_state,'loaded');v.readiness={state:'loaded',basis:'client-report',message:args.message};}else throw Error('Unexpected fixture write');
 v.revision++;v.workspace_revision++;return copy(v);
}
let browser,origin;
const server=createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://local');
 if(req.method==='POST'){
  assert(u.pathname.startsWith('/fixture-'));let body='';for await(const chunk of req){body+=chunk;assert(body.length<100000);}const {instance,...args}=JSON.parse(body);assert(['a','b'].includes(instance));let value;
  if(u.pathname==='/fixture-open'){if(!views.has(instance))views.set(instance,fixtureView(instance));value=copy(views.get(instance));}
  else if(u.pathname==='/fixture-call')value=await fixtureCall(instance,args.name,args.args);
  else if(u.pathname==='/fixture-context'){assert(JSON.stringify(args.value).length<24000);assert(!JSON.stringify(args.value).includes('"points"'));summaries.set(instance,args.value);report.modelContexts.push({instance,value:args.value});value={};}
  else throw Error('Not allowed');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({value}));return;
 }
 assert.equal(req.method,'GET');
 if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Wave UI contract fixture</title><link rel="stylesheet" href="/apps/codex/ui/waveforms/style.css"><main></main><script type="module" src="/tests/codex/waveforms/harness.js"></script>');return;}
 assert(['/apps/codex/ui/waveforms/','/modules/waveforms/','/tests/codex/waveforms/harness.js'].some(p=>u.pathname.startsWith(p)));
 const path=resolve(root,'.'+decodeURIComponent(u.pathname));assert(path.startsWith(root+sep));const bytes=await readFile(path);res.writeHead(200,{'content-type':({'.js':'text/javascript','.css':'text/css'}[extname(path)]||'application/octet-stream')});res.end(bytes);
 }catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:e.message,code:e.code||'invalid_input'}}));}});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,channel:'chrome'});const bc=await browser.newContext({viewport:{width:1360,height:1050}});
 bc.on('page',p=>p.on('pageerror',e=>report.errors.push(e.message)));
 await bc.route('**/*',route=>{const r=route.request();assert(r.url().startsWith(origin));assert(!r.url().includes('/api/'));return route.continue();});
 const page=await bc.newPage();await page.goto(origin+'/?view=a');await page.waitForFunction(()=>document.querySelectorAll('.wf-list button').length>0);assert.equal(await page.evaluate(()=>window.opener),null);assert.equal(await page.locator('.wf-trace').count(),0);
 report.checks.push('independent resource mounts without opener/popup or direct gateway request; catalog initially empty of traces');
 await page.getByRole('button',{name:'绘制已导出波形',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.wf-trace').length===6&&document.querySelector('.wf-status').textContent.includes('已加载'));
 await page.locator('.wf-a').fill('1e-8');await page.locator('.wf-b').fill('1.1e-8');await page.locator('[data-action=measure]').click();await page.waitForFunction(()=>[...document.querySelectorAll('.wf-cursors tr')].some(r=>r.textContent.includes('VDD0:p')&&r.textContent.includes('1 ns')));
 await page.waitForFunction(()=>window.fixtureModelContext?.signals.length===6&&window.fixtureModelContext?.cursors.a===1e-8&&window.fixtureModelContext?.cursors.b===1.1e-8);let selected=summaries.get('a');assert.equal(selected.signals.length,6);const current=selected.signals.find(s=>s.name==='VDD0:p');assert.equal(current.sample_count,158252);assert.equal(current.polarity,'into_terminal');assert.equal(current.measurement.uses_display_samples,false);assert(Math.abs(current.measurement.delta.dt-1e-9)<1e-22);assert.equal(current.measurement.a.y,-0.06527818549049032);
 report.checks.push('six real historical curves and1ns full-source cursors; bounded model context preserves native count/sign/source identity');
 await page.screenshot({path:out+'/six-real-waveforms.png',fullPage:true});
 const beforeCalls=report.hostCalls.length;await page.keyboard.press('Escape');assert.equal(bc.pages().length,1);assert.equal(report.hostCalls.length,beforeCalls);report.checks.push('Esc never opens a popup or creates another resource');
 const other=await bc.newPage();await other.goto(origin+'/?view=b');await other.waitForFunction(()=>document.querySelectorAll('.wf-list button').length>0);await other.locator('.wf-list button').filter({hasText:'VINP ·'}).click();await other.waitForFunction(()=>document.querySelector('.wf-status').textContent.includes('已加载'));assert.equal(await other.locator('.wf-trace').count(),1);assert.equal(await page.locator('.wf-trace').count(),6);assert.equal(views.get('a').workspace_id===views.get('b').workspace_id,false);report.checks.push('two independent view/workspace instances isolate selections; unmapped schematic does not block saved catalog');
 const viewA=copy(views.get('a'));await page.evaluate(v=>waveFixture.notification({...v,view_id:'v_'+'9'.repeat(32),revision:v.revision+10}),viewA);assert.equal(await page.locator('.wf-trace').count(),6);assert.match(await page.locator('.mcp-details').textContent(),/v_111/);report.checks.push('foreign view notification cannot rebind identity');
 await page.locator('.mcp-expand').click();await page.waitForFunction(()=>document.querySelector('.mcp-feedback').textContent.includes('does not advertise'));report.checks.push('unsupported fullscreen is explicit, not reported as opened');
 await other.setViewportSize({width:430,height:850});await other.screenshot({path:out+'/narrow-unmapped-history.png',fullPage:true});assert(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));report.checks.push('narrow standalone resource stays within viewport');
 // Exercise a CAS conflict without replaying a write; refresh remains explicit.
 const expected=views.get('a').revision;conflictNextSelection=true;const target=page.locator('.wf-trace').filter({hasText:'VALID'}).locator('button[aria-label]');await target.click();await page.waitForFunction(()=>document.querySelector('.mcp-feedback').textContent.includes('fixture revision conflict'));await page.waitForTimeout(350);assert.equal(views.get('a').revision,expected+1);const failed=report.hostCalls.filter(c=>c.name==='ic_view_select'&&c.args.expected_revision===expected);assert.equal(failed.length,1);report.checks.push('CAS conflict is surfaced once; no automatic mutation retry');
 await page.locator('.mcp-refresh').click();await page.waitForFunction(()=>document.querySelector('.mcp-view-status').textContent.includes('客户端已读取目录'));await page.waitForTimeout(500);
 await page.evaluate(()=>waveFixture.controller.dispose());assert.equal(await page.locator('main').innerText(),'');report.checks.push('dispose removes panel/listeners and ignores asynchronous completion');
 assert.deepEqual(report.errors,[]);const after=await hashes();if(before)assert.deepEqual(after,before);report.originalHashesUnchanged=before?true:null;report.originalHashes=after;report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;throw error;}finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser?.close();await new Promise(r=>server.close(r));console.log(JSON.stringify({status:report.status,checks:report.checks.length,errors:report.errors,failure:report.failure}));}
