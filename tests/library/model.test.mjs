import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryClient,repositoryPath,validateCatalog,validateLibrary,filterLibraries,classifyLibraryHierarchy,primaryProjectEntry,formatLibraryName,formatViewLabel,displayViewsForCell,isArchivedLibrary,visibleLibraries,LIBRARY_VIEW_TYPES,availableViewTypesForCell,normalizeLiveCatalog,buildCreateViewArgs} from '../../apps/web/library/model.js';
const entry='lib/synthetic/cell/schematic/view.scs',dependency='lib/synthetic/cell/schematic/support/circuit.scs';
const view={id:'schematic',label:'Synthetic native schematic',kind:'rnl',entry,files:[entry,dependency],level:'@top'};
const library={schema:'circuitgit.library.v1',id:'synthetic',name:'Synthetic library',description:'Test only',cells:[{id:'cell',name:'Synthetic cell',kind:'circuit',directory:'lib/synthetic/cell',readme:'lib/synthetic/cell/README.md',project_id:null,requires_external_models:false,views:[view,{id:'docs',label:'Readme',kind:'markdown',entry:'lib/synthetic/cell/README.md',files:['lib/synthetic/cell/README.md']}]}]};
const catalog={schema:'circuitgit.libraries.v1',libraries:[{id:library.id,name:library.name,manifest:'lib/synthetic/library.json'}]};
function fixture(overrides={}){
  const records=[],data=new Map([['lib/catalog.json',JSON.stringify(catalog)],['lib/synthetic/library.json',JSON.stringify(library)],[entry,'include "support/circuit.scs"'],[dependency,'// Synthetic dependency'],['lib/synthetic/cell/README.md','# Test only']]);
  const client=createLibraryClient({baseURL:'https://example.test/CircuitGit/library-files/',fetcher:async(url,options)=>{records.push({url:String(url),options});const path=decodeURI(url.pathname.slice('/CircuitGit/library-files/'.length));return new Response(data.get(path)||'',{status:data.has(path)?200:404});},...overrides});
  return {client,data,records};
}
test('frozen schemas accept native levels and original RC source paths',()=>{
  assert.equal(validateCatalog(structuredClone(catalog)).libraries.length,1);assert.equal(validateLibrary(structuredClone(library),'synthetic').cells[0].views[0].level,'@top');
  assert.equal(repositoryPath('projects/rc-smoke/circuit.scs'),'projects/rc-smoke/circuit.scs');
  assert.throws(()=>validateLibrary(library,'other'),/身份/);
});
test('all URLs/traversal/encoding and duplicate or incomplete closure declarations are rejected',()=>{
  for(const path of ['/lib/a','https://x/a','lib/../secrets','lib/x/./a','lib/x//a','lib/x/a?x','lib/x/a#x','lib/x/%2e%2e/a','lib/x/a\\b','lib/x/a\n','config/site.json'])assert.throws(()=>repositoryPath(path),/路径/);
  for(const files of [[dependency],[entry,entry],[]]){const bad=structuredClone(library);bad.cells[0].views[0].files=files;assert.throws(()=>validateLibrary(bad,'synthetic'));}
  const bad=structuredClone(library);bad.cells[0].views[0].level=0;assert.throws(()=>validateLibrary(bad,'synthetic'),/原生层级/);
});
test('loads only listed catalog and manifests using the published subdirectory root',async()=>{
  const f=fixture(),result=await f.client.load();assert.equal(result.libraries.length,1);assert.deepEqual(result.errors,[]);
  assert.deepEqual(f.records.map(r=>r.url),['https://example.test/CircuitGit/library-files/lib/catalog.json','https://example.test/CircuitGit/library-files/lib/synthetic/library.json']);
  assert.ok(f.records.every(r=>r.options.credentials==='omit'&&r.options.redirect==='error'));
});
test('RNL source eagerly contains every declared dependency and cannot read outside its snapshot',async()=>{
  const f=fixture(),bundle=await f.client.loadView(view);
  assert.equal(f.records.length,2);assert.deepEqual(bundle.paths,[entry,dependency]);assert.equal(bundle.source.path,'/'+entry);assert.equal(bundle.source.readonly,true);
  assert.equal((await bundle.source.open()).text,'include "support/circuit.scs"');assert.equal(await bundle.source.read('/'+dependency),'// Synthetic dependency');
  assert.equal(await (await bundle.source.files.get('/'+dependency)()).text(),'// Synthetic dependency');
  await assert.rejects(bundle.source.read('/projects/rc-smoke/unrelated.scs'),/不在已发布/);
});
test('missing dependency rejects the whole view before the renderer can receive it',async()=>{
  const f=fixture();f.data.delete(dependency);await assert.rejects(f.client.loadView(view),/读取失败/);
});
test('failed manifest is explicit partial coverage and never replaced with another library',async()=>{
  const f=fixture();f.data.set('lib/catalog.json',JSON.stringify({...catalog,libraries:[...catalog.libraries,{id:'missing',name:'Missing',manifest:'lib/missing/library.json'}]}));
  const result=await f.client.load();assert.equal(result.libraries.length,1);assert.equal(result.errors[0].id,'missing');
});
test('text views read only their declared entry; search respects library/cell/view matches',async()=>{
  const f=fixture(),bundle=await f.client.loadView(library.cells[0].views[1]);assert.equal(bundle.text,'# Test only');assert.equal(f.records.length,1);
  assert.equal(filterLibraries([library],'SYNTHETIC CELL')[0].cells[0].views.length,2);
  assert.equal(filterLibraries([library],'readme')[0].cells[0].views[0].kind,'markdown');assert.deepEqual(filterLibraries([library],'no match'),[]);
});
test('byte limits and malformed UTF-8 are rejected; cancellation propagates',async()=>{
  const f=fixture({maxFileBytes:5});await assert.rejects(f.client.loadView(view),/大小限制/);
  const utf=createLibraryClient({baseURL:'https://example.test/library-files/',fetcher:async()=>new Response(new Uint8Array([255]))});await assert.rejects(utf.loadView({...view,files:[entry]}),/UTF-8/);
  const abort=new AbortController();abort.abort();const cancelled=fixture();await assert.rejects(cancelled.client.loadView(view,{signal:abort.signal}),{name:'AbortError'});
});
test('canonical sources are fetched once while original include paths remain in memory',async()=>{
  const canonical='lib/packages/synthetic/resistor.scs',secondAlias='lib/another/cell/support/circuit.scs';
  const f=fixture(),content=f.data.get(dependency);f.data.delete(dependency);f.data.set(canonical,content);
  const aliased={...view,files:[entry,canonical],aliases:{[dependency]:canonical,[secondAlias]:canonical}};
  const manifest=structuredClone(library);manifest.cells[0].views[0]=aliased;validateLibrary(manifest,'synthetic');
  const bundle=await f.client.loadView(aliased);
  assert.deepEqual(bundle.paths,[entry,canonical]);assert.equal(f.records.length,2);assert.ok(f.records.every(row=>!row.url.endsWith('/support/circuit.scs')));
  assert.equal(bundle.bytes,Buffer.byteLength(f.data.get(entry))+Buffer.byteLength(content));
  for(const path of [canonical,dependency,secondAlias]){assert.equal(await bundle.source.read('/'+path),content);assert.equal(await (await bundle.source.files.get('/'+path)()).text(),content);}
  f.data.set(canonical,'// Canonical edit');const updated=await f.client.loadView(aliased);
  assert.equal(updated.source.snapshot['/'+dependency],'// Canonical edit');assert.equal(updated.source.snapshot['/'+secondAlias],'// Canonical edit');
});
test('invalid alias authority is rejected before any file request',async()=>{
  const canonical='lib/packages/synthetic/resistor.scs',unknown='lib/packages/synthetic/missing.scs';
  const cases=[null,[],{[dependency]:unknown},{[entry]:canonical},{'lib/../escape.scs':canonical},{[dependency]:'lib/%2e%2e/escape.scs'},Object.fromEntries(Array.from({length:8193},(_,i)=>['lib/virtual/'+i+'.scs',canonical]))];
  for(const aliases of cases){const f=fixture(),bad={...view,files:[entry,canonical],aliases};await assert.rejects(f.client.loadView(bad));assert.equal(f.records.length,0);const manifest=structuredClone(library);manifest.cells[0].views[0]=bad;assert.throws(()=>validateLibrary(manifest,'synthetic'));}
  const f=fixture();await assert.rejects(f.client.loadView({...view,entry:dependency,files:[entry,canonical],aliases:{[dependency]:canonical}}),/缺少入口/);assert.equal(f.records.length,0);
});
test('identity aliases are allowed without extra fetches and missing canonical bytes fail closed',async()=>{
  const f=fixture(),bundle=await f.client.loadView({...view,aliases:{[entry]:entry}});assert.equal(bundle.text,f.data.get(entry));assert.equal(f.records.length,2);
  const canonical='lib/packages/synthetic/missing.scs';await assert.rejects(f.client.loadView({...view,files:[entry,canonical],aliases:{[dependency]:canonical}}),/读取失败/);
});
test('classifyLibraryHierarchy separates top-level entries from internal submodules using RNL closures',()=>{
  const lib={
    id:'adc',name:'ADC Project',
    cells:[
      {id:'sub_comp',name:'sub_comp',kind:'circuit',directory:'lib/adc/sub_comp',project_id:null,views:[{id:'schematic',kind:'rnl',entry:'lib/adc/sub_comp/s.scs',files:['lib/adc/sub_comp/s.scs']}]},
      {id:'dut_top',name:'dut_top',kind:'circuit',directory:'lib/adc/dut_top',project_id:null,views:[{id:'schematic',kind:'rnl',entry:'lib/adc/dut_top/s.scs',files:['lib/adc/dut_top/s.scs','lib/adc/sub_comp/s.scs']}]},
      {id:'tb_top',name:'tb_top',kind:'testbench',directory:'lib/adc/tb_top',project_id:'adc-tb_top',views:[{id:'schematic',kind:'rnl',entry:'lib/adc/tb_top/s.scs',files:['lib/adc/tb_top/s.scs','lib/adc/dut_top/s.scs','lib/adc/sub_comp/s.scs']}]},
    ],
  };
  const h=classifyLibraryHierarchy(lib);
  assert.equal(h.primary.id,'tb_top');
  assert.equal(primaryProjectEntry(lib).id,'tb_top');
  assert.deepEqual(h.topLevel.map(c=>c.id),['tb_top','dut_top']);
  assert.deepEqual(h.submodules.map(c=>c.id),['sub_comp']);
});
test('formatViewLabel and displayViewsForCell normalize labels and surface embedded RNL symbol views',()=>{
  assert.equal(formatViewLabel({id:'schematic',label:'Native schematic'}),'原理图 (schematic)');
  assert.equal(formatViewLabel({id:'simulation',label:'Historical inputs — models incomplete'}),'仿真配置 (simulation · 历史输入/需外部 PDK)');
  assert.equal(formatViewLabel({id:'docs',label:'Evidence and dependencies'}),'说明与依赖文档 (docs)');
  assert.equal(formatViewLabel({id:'symbol',label:'Native symbol'}),'符号 (symbol)');

  const circuitViews=displayViewsForCell({kind:'circuit',views:[view,{id:'docs',label:'Evidence and dependencies',kind:'markdown'}]});
  assert.deepEqual(circuitViews.map(v=>v.id),['schematic','symbol','docs']);
  assert.equal(circuitViews[1].virtualSymbol,true);
  assert.equal(circuitViews[1].backingViewId,'schematic');
  assert.equal(formatViewLabel(circuitViews[1]),'符号 (symbol · 内嵌于 RNL)');

  // Testbench cells stay schematic-first without a synthetic symbol view.
  const tbViews=displayViewsForCell({kind:'testbench',views:[view,{id:'docs',label:'Evidence and dependencies',kind:'markdown'}]});
  assert.deepEqual(tbViews.map(v=>v.id),['schematic','docs']);

  // Cells that already declare a standalone symbol view do not duplicate it.
  const standaloneViews=displayViewsForCell({kind:'circuit',views:[{id:'symbol',label:'Native symbol',kind:'rnl'}]});
  assert.deepEqual(standaloneViews.map(v=>v.id),['symbol']);
  assert.equal(standaloneViews[0].virtualSymbol,undefined);
});

test('visibleLibraries hides archived research libraries by default while preserving catalog access and clean display names',()=>{
  const all=[
    {id:'pipetisar-real',name:'PIPE–TI–SAR real SAR snapshot',cells:[]},
    {id:'pipetisar-research',name:'PIPE–TI–SAR research library',cells:[]},
    {id:'pipesar-original',name:'Original 9-bit SAR library',cells:[]},
    {id:'basics',name:'基础电路',cells:[]},
  ];
  assert.equal(isArchivedLibrary('pipetisar-research'),true);
  assert.equal(isArchivedLibrary('pipesar-original'),true);
  assert.equal(isArchivedLibrary('pipetisar-real'),false);
  assert.deepEqual(visibleLibraries(all).map(l=>l.id),['pipetisar-real','basics']);
  assert.deepEqual(visibleLibraries(all,{includeArchived:true}).map(l=>l.id),['pipetisar-real','pipetisar-research','pipesar-original','basics']);
  assert.equal(formatLibraryName(all[0]),'1G 12-bit PIPE–TI–SAR ADC');
  assert.equal(formatLibraryName(all[3]),'基础示例电路');
});

test('availableViewTypesForCell ignores synthetic views and buildCreateViewArgs validates inputs',()=>{
  assert.equal(LIBRARY_VIEW_TYPES.length,6);
  const cell={
    id:'ota',kind:'circuit',
    views:[
      {id:'schematic',label:'Schematic',kind:'rnl',entry:'lib/demo/ota/schematic/ota.scs',files:['lib/demo/ota/schematic/ota.scs']},
      {id:'docs',label:'Documentation',kind:'markdown',entry:'lib/demo/ota/README.md',files:['lib/demo/ota/README.md']},
    ],
  };
  const choices=availableViewTypesForCell(cell);
  assert.equal(choices.find(v=>v.id==='schematic').exists,true);
  assert.equal(choices.find(v=>v.id==='docs').exists,true);
  assert.equal(choices.find(v=>v.id==='symbol').exists,false);
  assert.equal(choices.find(v=>v.id==='veriloga').exists,false);
  assert.equal(choices.find(v=>v.id==='simulation').defaultFilename('ota'),'config.json');

  const args=buildCreateViewArgs({
    libraryId:'demo',cellId:'ota',viewId:'symbol',baseCommit:'a'.repeat(40),
    label:'OTA Symbol',filename:'ota.rnl',level:'OTA_SYM',
  });
  assert.deepEqual(args,{
    library_id:'demo',cell_id:'ota',view_id:'symbol',kind:'rnl',base_commit:'a'.repeat(40),
    label:'OTA Symbol',filename:'ota.rnl',level:'OTA_SYM',
  });
  assert.throws(()=>buildCreateViewArgs({libraryId:'demo',cellId:'ota',viewId:'veriloga',baseCommit:'a'.repeat(40),level:'BAD'}),/原生层级/);
  assert.throws(()=>buildCreateViewArgs({libraryId:'demo',cellId:'ota',viewId:'unknown',baseCommit:'a'.repeat(40)}),/不支持/);
});

test('normalizeLiveCatalog merges fallback metadata and preserves live views',()=>{
  const live={
    base_commit:'b'.repeat(40),
    libraries:[{
      id:'demo',
      name:'Demo Live',
      cells:[{
        id:'ota',name:'OTA',directory:'lib/demo/ota',kind:'circuit',
        project_id:null,requires_external_models:false,source_path:'lib/demo/ota/schematic/ota.scs',
        views:[{id:'schematic',label:'Schematic',kind:'rnl',entry:'lib/demo/ota/schematic/ota.scs',files:['lib/demo/ota/schematic/ota.scs']}],
      }],
    }],
  };
  const fallback=[{
    id:'demo',name:'Demo',description:'Demo description',
    cells:[{id:'ota',description:'Two-stage OTA',readme:'lib/demo/ota/README.md'}],
  }];
  const normalized=normalizeLiveCatalog(live,fallback);
  assert.equal(normalized.baseCommit,'b'.repeat(40));
  assert.equal(normalized.libraries[0].description,'Demo description');
  assert.equal(normalized.libraries[0].cells[0].description,'Two-stage OTA');
  assert.equal(normalized.libraries[0].cells[0].readme,'lib/demo/ota/README.md');
  assert.equal(normalized.libraries[0].cells[0].views.length,1);
});
