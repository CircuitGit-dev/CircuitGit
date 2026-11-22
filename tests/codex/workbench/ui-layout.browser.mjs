// Explicit lifecycle fixture only. Real engineering component acceptance is owned by Root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');

test('dock DOM lifecycle, physical drag/resize, restore, CAS persistence and failure controls',async t=>{
  const css=await readFile(repo+'/apps/codex/ui/workbench/style.css','utf8');
  const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://fixture').pathname;if(path==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>Dock layout fixture</title><style>body{margin:0}#root{height:780px}</style><div id="root"></div>');return;}if(!['/index.js','/layout.js'].includes(path))throw Error('not fixture');res.setHeader('content-type','text/javascript');res.end(await readFile(repo+'/apps/codex/ui/workbench'+path));}catch{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1400,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(10000);
  async function start({text=null,views=[],explicit=true,currentRevision=1}={}){
    await page.goto('http://127.0.0.1:'+server.address().port+'/');
    await page.evaluate(async({css,text,views,explicit,currentRevision})=>{
      const {mount}=await import('/index.js');window.calls=[];window.handles={};window.snapshots={};window.nodes={};window.failClose=null;window.failSave=false;
      const descriptors=new Map(views.map(v=>[v.view_id,v]));let counter=0,persisted=text;
      const initial={schema:'ic.view.v1',kind:'workbench',workspace_id:'ws',view_id:'wb',revision:1,identity:{project_id:'fixture',configuration:explicit?'tran':null},workbench_run_id:explicit?'run-1':null};let current=initial,serverCurrent={...initial,revision:currentRevision};
      window.host={initial,get view(){return current;},assetText:async()=>css,requestDisplayMode:async mode=>({mode}),async call(name,args){
        calls.push({name,args});if(name==='ic_view_get'){if(args.workspace_id!==initial.workspace_id||args.view_id!==initial.view_id)throw Error('wrong parent');current=serverCurrent;return current;}
        if(name==='ic_workbench_layout'){if(failSave)throw Error('SYNTHETIC layout write failed');if(args.expected_revision!==serverCurrent.revision)throw Error('stale CAS');persisted=args.text;serverCurrent={...serverCurrent,revision:serverCurrent.revision+1};current=serverCurrent;return current;}
        if(name!=='ic_view_data')throw Error('Unexpected fixture tool');if(args.revision!==serverCurrent.revision)throw Error('SYNTHETIC stale data revision');return {view:serverCurrent,payload:args.query.kind==='layout'?{text:persisted,views:[...descriptors.values()]}:args.query.kind==='project'?{projects:[{id:'fixture',configurations:[{id:'tran',name:'Transient'},{id:'ac',name:'AC'}]}]}:{jobs:[{run_id:'run-1',configuration:'tran'},{run_id:'run-2',configuration:'ac'}]}};
      },async openPanel(kind,args){calls.push({name:'openPanel',kind,args});const view={schema:'ic.view.v1',kind,workspace_id:'ws',view_id:'view-'+kind+'-'+(++counter),revision:1,identity:{project_id:'fixture',configuration:args.configuration||null,run_id:args.run_id||null}};descriptors.set(view.view_id,view);return view;},async getPanel(id){calls.push({name:'getPanel',id});return descriptors.get(id);},async mountPanel(container,view){
        const id=view.view_id;calls.push({name:'mountPanel',id});const input=document.createElement('textarea');input.setAttribute('aria-label','fixture-'+id);input.value=snapshots[id]||'';const label=document.createElement('p');label.textContent='Lifecycle fixture '+view.kind;container.append(label,input);nodes[id]=input;
        const handle={visible:[],resizes:0,disposed:0,closes:0,async beforeClose(){handle.closes++;if(failClose===id)throw Error('SYNTHETIC snapshot failed');snapshots[id]=input.value;},setVisible(v){handle.visible.push(v);},resize(){handle.resizes++;},dispose(){handle.disposed++;container.replaceChildren();}};handles[id]??=[];handles[id].push(handle);return handle;
      }};
      window.saved=()=>persisted;window.descriptors=()=>[...descriptors.values()];window.controller=await mount(document.querySelector('#root'),host);
    },{css,text,views,explicit,currentRevision});
    await page.waitForFunction(()=>!document.querySelector('.wb-save-state').textContent.includes('读取'));
  }
  const tab=id=>page.locator('[data-tab-id="'+id+'"]');
  async function saved(){await page.waitForFunction(()=>document.querySelector('.wb-save-state').textContent==='布局已保存');return page.evaluate(()=>JSON.parse(saved()));}
  try{
    await start();const defaults=await saved(),ids=Object.fromEntries(defaults.panels.map(p=>[p.kind,p.id]));assert.equal(defaults.panels.length,3);assert.equal(await page.locator('.wb-panel:not([hidden])').count(),3);
    await t.test('default uses explicit identities and full-width lower waveform at 40 percent',async()=>{
      const calls=await page.evaluate(()=>calls.filter(c=>c.name==='openPanel'));assert.deepEqual(calls.map(c=>[c.kind,c.args]),[['schematic',{}],['simulation',{configuration:'tran'}],['waveforms',{run_id:'run-1'}]]);
      assert.equal(defaults.tree.axis,'vertical');assert.equal(defaults.tree.ratio,.6);assert.equal(defaults.tree.first.axis,'horizontal');
      const wave=await page.locator('.wb-group').filter({has:tab(ids.waveforms)}).boundingBox(),schematic=await page.locator('.wb-group').filter({has:tab(ids.schematic)}).boundingBox(),simulation=await page.locator('.wb-group').filter({has:tab(ids.simulation)}).boundingBox(),area=await page.locator('.wb-layout').boundingBox();
      assert.ok(Math.abs(wave.width-area.width)<2);assert.ok(Math.abs(wave.height-(area.height-6)*.4)<2);assert.ok(wave.y>schematic.y+schematic.height);assert.ok(Math.abs(schematic.y-simulation.y)<2);
    });
    await t.test('reload refreshes stale initial parent revision before reading saved layout',async()=>{
      const views=await page.evaluate(()=>descriptors());await page.evaluate(()=>controller.dispose());
      await start({text:JSON.stringify(defaults),views,currentRevision:11});await saved();
      const state=await page.evaluate(()=>({initial:host.initial.revision,current:host.view.revision,calls,text:saved()}));
      assert.equal(state.initial,1);assert.equal(state.current,11);
      assert.deepEqual(state.calls[0],{name:'ic_view_get',args:{workspace_id:'ws',view_id:'wb'}});
      assert.deepEqual(state.calls[1],{name:'ic_view_data',args:{workspace_id:'ws',view_id:'wb',revision:11,query:{kind:'layout'}}});
      assert.ok(state.calls.filter(call=>call.name==='ic_view_data').every(call=>call.args.revision===11));
      assert.equal(state.calls.filter(call=>call.name==='openPanel'||call.name==='ic_workbench_layout').length,0);
      assert.deepEqual(JSON.parse(state.text),defaults);assert.equal(await page.locator('.wb-panel:not([hidden])').count(),3);
      assert.equal(await page.locator('.wb-notice').isVisible(),false);
    });
    await page.getByLabel('fixture-'+ids.schematic).fill('keep schematic draft');
    await t.test('physical tab merge retains original component DOM and pauses inactive panel',async()=>{
      const from=await tab(ids.waveforms).boundingBox(),target=await page.locator('.wb-group').filter({has:tab(ids.schematic)}).boundingBox();
      await page.mouse.move(from.x+15,from.y+15);await page.mouse.down();await page.mouse.move(target.x+target.width*.5,target.y+target.height*.5,{steps:8});await page.mouse.up();await saved();
      assert.equal(await page.locator('.wb-group').count(),2);assert.equal(await page.evaluate(id=>nodes[id].isConnected,ids.schematic),true);
      await tab(ids.schematic).click();assert.equal(await page.getByLabel('fixture-'+ids.schematic).inputValue(),'keep schematic draft');assert.equal(await page.evaluate(id=>handles[id].length,ids.schematic),1);
    });
    await t.test('edge drop splits, divider resizes, and keyboard clamp stays bounded',async()=>{
      const from=await tab(ids.waveforms).boundingBox(),target=await page.locator('.wb-group').filter({has:tab(ids.schematic)}).boundingBox();
      await page.mouse.move(from.x+15,from.y+15);await page.mouse.down();await page.mouse.move(target.x+target.width*.5,target.y+target.height-8,{steps:8});await page.mouse.up();await saved();assert.equal(await page.locator('.wb-group').count(),3);
      const divider=page.locator('.wb-layout > .wb-split > .wb-divider'),box=await divider.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+100,box.y+box.height/2,{steps:5});await page.mouse.up();const resized=await saved();assert.notEqual(resized.tree.ratio,.62);
      await divider.focus();await page.keyboard.press('Home');const value=await saved();assert.equal(value.tree.ratio,.5);assert.equal(await page.evaluate(id=>handles[id][0].resizes>1,ids.schematic),true);
    });
    await t.test('maximize and restore retain all panel instances',async()=>{const group=page.locator('.wb-group').filter({has:tab(ids.schematic)});await group.getByRole('button',{name:/^最大化/}).click();await saved();assert.equal(await page.locator('.wb-panel:not([hidden])').count(),1);await page.getByRole('button',{name:'还原面板',exact:true}).click();await saved();assert.equal(await page.evaluate(id=>handles[id].length,ids.waveforms),1);});
    await t.test('snapshot failure keeps panel open; close succeeds then reopen reuses server id and draft',async()=>{
      await page.evaluate(id=>window.failClose=id,ids.schematic);await page.getByRole('button',{name:'关闭 原理图',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.wb-notice').textContent.includes('snapshot failed'));assert.equal(await page.evaluate(id=>handles[id][0].disposed,ids.schematic),0);
      await page.evaluate(()=>window.failClose=null);await page.getByRole('button',{name:'关闭 原理图',exact:true}).click();await saved();assert.equal(await page.evaluate(id=>handles[id][0].disposed,ids.schematic),1);
      await page.getByRole('button',{name:'打开原理图',exact:true}).click();await saved();assert.equal(await page.getByLabel('fixture-'+ids.schematic).inputValue(),'keep schematic draft');assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='openPanel'&&c.kind==='schematic').length),0);
    });
    await t.test('layout save errors keep visible layout and require explicit retry',async()=>{
      await page.evaluate(()=>window.failSave=true);await page.getByRole('button',{name:'恢复默认工作台布局',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.wb-save-state').textContent==='布局未保存');const count=await page.evaluate(()=>calls.filter(c=>c.name==='ic_workbench_layout').length);await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='ic_workbench_layout').length),count);
      await page.evaluate(()=>window.failSave=false);await page.getByRole('button',{name:'重试保存布局',exact:true}).click();await saved();
    });
    await t.test('close all remembers closed registry and remount restores no default panels',async()=>{
      for(const name of ['关闭 原理图','关闭 波形 · run-1','关闭 仿真 · tran']){await page.getByRole('button',{name,exact:true}).click();await saved();}
      const state=await saved(),views=await page.evaluate(()=>descriptors());assert.equal(state.tree,null);assert.equal(state.panels.length,3);
      await page.evaluate(()=>controller.dispose());await start({text:JSON.stringify(state),views,currentRevision:11});assert.equal(await page.locator('.wb-panel').count(),0);assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='openPanel').length),0);
      assert.equal(await page.locator('.wb-empty').getByRole('button',{name:'恢复 原理图',exact:true}).isVisible(),true);assert.equal(await page.evaluate(()=>host.view.revision),11);
      await page.locator('.wb-empty').getByRole('button',{name:'恢复 原理图',exact:true}).click();await saved();assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='getPanel').length),1);
    });
    await t.test('fresh workbench without config/run opens only actual schematic',async()=>{await page.evaluate(()=>controller.dispose());await start({explicit:false});await saved();assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.name==='openPanel').map(c=>c.kind)),['schematic']);await page.evaluate(()=>controller.dispose());});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
