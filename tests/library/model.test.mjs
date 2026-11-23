import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryClient,repositoryPath,validateCatalog,validateLibrary,filterLibraries} from '../../apps/web/library/model.js';
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
