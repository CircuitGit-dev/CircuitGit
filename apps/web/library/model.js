// Public, indexed text files only. No backend project registration or runtime actions.
const VIEW_IDS=new Set(['schematic','symbol','netlist','simulation','docs']);
const VIEW_KINDS=new Set(['rnl','spectre','json','markdown']);
const CELL_KINDS=new Set(['circuit','testbench','primitive']);
const text=(value,label)=>{if(typeof value!=='string'||!value.trim())throw Error(label+' 必须是非空文本。');return value;};
const object=(value,label)=>{if(!value||Array.isArray(value)||typeof value!=='object')throw Error(label+' 格式无效。');return value;};
function unique(items,key,label){const seen=new Set();for(const item of items){const value=text(item[key],label);if(seen.has(value))throw Error(label+' 重复：'+value);seen.add(value);}}
export function repositoryPath(value){
  text(value,'文件路径');
  if(!/^(lib|projects)\//.test(value)||/[\\%?#:\x00-\x1f\x7f]/.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('不安全的库文件路径：'+value);
  return value;
}
export function validateCatalog(value){
  object(value,'库目录');if(value.schema!=='circuitgit.libraries.v1'||!Array.isArray(value.libraries))throw Error('库目录协议不匹配。');
  for(const item of value.libraries){object(item,'库');text(item.name,'库名称');repositoryPath(item.manifest);if(!/^lib\/[^/]+\/library\.json$/.test(item.manifest))throw Error('库清单路径无效。');}
  unique(value.libraries,'id','库 ID');return value;
}
export function validateLibrary(value,expectedId){
  object(value,'库清单');if(value.schema!=='circuitgit.library.v1'||value.id!==expectedId||!Array.isArray(value.cells))throw Error('库清单身份或协议不匹配。');text(value.name,'库名称');
  unique(value.cells,'id','单元 ID');
  for(const cell of value.cells){
    object(cell,'单元');text(cell.name,'单元名称');if(!CELL_KINDS.has(cell.kind))throw Error('单元类型不支持。');repositoryPath(cell.directory);repositoryPath(cell.readme);
    if(typeof cell.requires_external_models!=='boolean'||!(cell.project_id===null||typeof cell.project_id==='string'))throw Error('单元依赖或项目身份缺失。');
    if(!Array.isArray(cell.views))throw Error('视图清单缺失。');unique(cell.views,'id','视图 ID');
    for(const view of cell.views){
      if(!VIEW_IDS.has(view.id)||!VIEW_KINDS.has(view.kind))throw Error('视图类型不支持。');text(view.label,'视图名称');repositoryPath(view.entry);
      if(view.level!==undefined)text(view.level,'原生层级');
      if(!Array.isArray(view.files)||!view.files.length||view.files.length>4096)throw Error('视图文件清单为空或过大。');view.files.forEach(repositoryPath);
      if(new Set(view.files).size!==view.files.length||!view.files.includes(view.entry))throw Error('视图文件清单重复或缺少入口。');
    }
  }
  return value;
}
export function filterLibraries(libraries,query=''){
  const q=query.trim().toLocaleLowerCase(),matches=(...parts)=>!q||parts.filter(Boolean).join(' ').toLocaleLowerCase().includes(q);
  return libraries.map(library=>{
    const all=matches(library.id,library.name,library.description);
    const cells=library.cells.map(cell=>({...cell,views:cell.views.filter(view=>all||matches(cell.id,cell.name,cell.description)||matches(view.id,view.label,view.kind))})).filter(cell=>cell.views.length||all||matches(cell.id,cell.name,cell.description));
    return {...library,cells};
  }).filter(library=>library.cells.length||matches(library.id,library.name,library.description));
}
async function pooled(items,task,concurrency=4){
  let index=0;const result=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(items.length,concurrency)},async()=>{while(index<items.length){const i=index++;result[i]=await task(items[i],i);}}));return result;
}
export function createLibraryClient({baseURL=new URL('../library-files/',import.meta.url),fetcher=fetch,maxFileBytes=32*1024*1024,maxViewBytes=128*1024*1024}={}){
  const base=new URL(baseURL);if(!base.pathname.endsWith('/'))throw Error('库根路径需要以 / 结尾。');
  const urlFor=path=>new URL(repositoryPath(path).split('/').map(encodeURIComponent).join('/'),base);
  async function read(path,{signal,limit=maxFileBytes}={}){
    const response=await fetcher(urlFor(path),{signal,credentials:'omit',redirect:'error'});
    if(!response.ok)throw Error(`${path} 读取失败 (${response.status})。`);
    if(Number(response.headers?.get('content-length'))>limit)throw Error(path+' 超出读取大小限制。');
    const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength>limit)throw Error(path+' 超出读取大小限制。');
    try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),bytes:bytes.byteLength};}catch{throw Error(path+' 不是可读取的 UTF-8 文本。');}
  }
  async function load({signal}={}){
    const catalog=validateCatalog(JSON.parse((await read('lib/catalog.json',{signal,limit:2*1024*1024})).text));
    const results=await pooled(catalog.libraries,async item=>{try{return {library:validateLibrary(JSON.parse((await read(item.manifest,{signal,limit:8*1024*1024})).text),item.id)};}catch(error){if(signal?.aborted)throw error;return {error:{id:item.id,name:item.name,message:error.message}};}});
    return {libraries:results.filter(x=>x.library).map(x=>x.library),errors:results.filter(x=>x.error).map(x=>x.error)};
  }
  async function loadView(view,{signal}={}){
    const paths=view.kind==='rnl'?view.files:[view.entry],snapshot=Object.create(null);let bytes=0;
    await pooled(paths,async path=>{const file=await read(path,{signal});bytes+=file.bytes;if(bytes>maxViewBytes)throw Error('视图文件集合超出读取大小限制。');snapshot['/'+path]=file.text;});
    if(signal?.aborted)throw new DOMException('已取消','AbortError');
    const path='/'+view.entry,source={name:view.entry,path,readonly:true,snapshot,files:new Map(Object.entries(snapshot).map(([path,text])=>[path,()=>new Blob([text],{type:'text/plain'})])),
      open:async()=>({path,text:snapshot[path]}),read:async requested=>{if(!Object.hasOwn(snapshot,requested))throw Error('依赖不在已发布文件清单中：'+requested);return snapshot[requested];}};
    return {source,text:snapshot[path],paths:[...paths],bytes};
  }
  return {load,loadView,urlFor};
}
