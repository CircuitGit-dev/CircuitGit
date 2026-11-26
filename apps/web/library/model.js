// Public, indexed text files only. No backend project registration or runtime actions.
import {isVerilogAFile,verilogaModuleBasename,indexLibraryVerilogAFiles} from './veriloga.js';

const VIEW_IDS=new Set(['schematic','symbol','veriloga','netlist','simulation','docs']);
const VIEW_KINDS=new Set(['rnl','veriloga','spectre','json','markdown']);
const CELL_KINDS=new Set(['circuit','testbench','primitive']);
export const ARCHIVED_LIBRARY_IDS=new Set(['pipetisar-research','pipesar-original']);

export function isArchivedLibrary(library){
  const id=typeof library==='string'?library:library?.id;
  return Boolean(id&&ARCHIVED_LIBRARY_IDS.has(id));
}

export function formatLibraryName(library){
  if(!library)return '';
  const id=library.id,raw=String(library.name||id||'');
  if(id==='pipetisar-real')return '1G 12-bit PIPE–TI–SAR ADC';
  if(id==='basics')return '基础示例电路';
  if(id==='pipetisar-research')return '历史研究归档 · PIPE–TI–SAR research';
  if(id==='pipesar-original')return '历史研究归档 · Original 9-bit SAR';
  return raw;
}

export function visibleLibraries(libraries,{includeArchived=false}={}){
  const list=Array.isArray(libraries)?libraries:[];
  if(includeArchived)return list;
  const primary=list.filter(lib=>!isArchivedLibrary(lib));
  return primary.length?primary:list;
}
const text=(value,label)=>{if(typeof value!=='string'||!value.trim())throw Error(label+' 必须是非空文本。');return value;};
const object=(value,label)=>{if(!value||Array.isArray(value)||typeof value!=='object')throw Error(label+' 格式无效。');return value;};
function unique(items,key,label){const seen=new Set();for(const item of items){const value=text(item[key],label);if(seen.has(value))throw Error(label+' 重复：'+value);seen.add(value);}}
export function repositoryPath(value){
  text(value,'文件路径');
  if(!/^(lib|projects)\//.test(value)||/[\\%?#:\x00-\x1f\x7f]/.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('不安全的库文件路径：'+value);
  return value;
}
export function viewAliases(view){
  const aliases=view.aliases===undefined?{}:view.aliases;object(aliases,'源文件映射');
  if(Object.keys(aliases).length>8192)throw Error('源文件映射过大。');
  for(const [logical,canonical] of Object.entries(aliases)){
    repositoryPath(logical);repositoryPath(canonical);
    if(!view.files.includes(canonical)||view.files.includes(logical)&&logical!==canonical)throw Error('源文件映射必须指向清单中的权威文件，不能覆盖其它文件。');
  }
  return aliases;
}
function validateViewFiles(view){
  repositoryPath(view.entry);
  if(!Array.isArray(view.files)||!view.files.length||view.files.length>4096)throw Error('视图文件清单为空或过大。');view.files.forEach(repositoryPath);
  if(new Set(view.files).size!==view.files.length||!view.files.includes(view.entry))throw Error('视图文件清单重复或缺少入口。');
  return viewAliases(view);
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
      validateViewFiles(view);
    }
  }
  return value;
}
export function filterLibraries(libraries,query=''){
  const q=query.trim().toLocaleLowerCase(),matches=(...parts)=>!q||parts.filter(Boolean).join(' ').toLocaleLowerCase().includes(q);
  return libraries.map(library=>{
    const all=matches(library.id,library.name,library.description);
    const cells=library.cells.map(cell=>{
      const visibleViews=displayViewsForCell(cell,{library,libraries});
      const hasDisplayMatch=visibleViews.some(v=>matches(v.id,v.label,formatViewLabel(v),v.kind,v.moduleName));
      const matchedViews=cell.views.filter(view=>all||matches(cell.id,cell.name,cell.description)||matches(view.id,view.label,formatViewLabel(view),view.kind));
      return {...cell,views:matchedViews.length||!hasDisplayMatch?matchedViews:cell.views};
    }).filter(cell=>{
      const visibleViews=displayViewsForCell(cell,{library,libraries});
      return cell.views.length||all||matches(cell.id,cell.name,cell.description)||visibleViews.some(v=>matches(v.id,v.label,formatViewLabel(v),v.kind,v.moduleName));
    });
    return {...library,cells};
  }).filter(library=>library.cells.length||matches(library.id,library.name,library.description));
}

/** Derive real Project -> Top-Level -> Sub-module hierarchy from each cell's RNL closure. */
export function classifyLibraryHierarchy(library){
  const cells=Array.isArray(library?.cells)?library.cells:[];
  const fileCountById=new Map();
  const referencedBy=new Map(cells.map(c=>[c.id,new Set()]));
  const dirEntries=cells.map(c=>({id:c.id,prefix:(c.directory||'').replace(/\/+$/,'')+'/'}));
  for(const cell of cells){
    const rnlViews=(cell.views||[]).filter(v=>v.kind==='rnl');
    const paths=new Set();
    for(const v of rnlViews){
      for(const f of v.files||[])paths.add(f);
      for(const k of Object.keys(v.aliases||{}))paths.add(k);
    }
    fileCountById.set(cell.id,paths.size);
    if(!paths.size)continue;
    for(const target of dirEntries){
      if(target.id===cell.id||target.prefix==='/')continue;
      for(const p of paths){
        if(p.startsWith(target.prefix)){referencedBy.get(target.id).add(cell.id);break;}
      }
    }
  }
  const byId=new Map(cells.map(c=>[c.id,c]));
  const maxFiles=Math.max(0,...fileCountById.values());
  const roots=new Set(cells.filter(c=>referencedBy.get(c.id).size===0).map(c=>c.id));
  // Promote direct DUT top-levels that are referenced only by root testbenches.
  const topSet=new Set(roots);
  for(const cell of cells){
    if(topSet.has(cell.id)||cell.kind!=='circuit')continue;
    const parents=[...referencedBy.get(cell.id)];
    if(parents.length>0&&parents.every(pid=>roots.has(pid)&&byId.get(pid)?.kind==='testbench')){
      if((fileCountById.get(cell.id)||0)>=8||/TOP/i.test(cell.id))topSet.add(cell.id);
    }
  }
  // In large hierarchical projects, keep small standalone helper/unit cells out of the top-level group.
  if(maxFiles>=12){
    const systemThreshold=Math.max(12,Math.floor(maxFiles*0.4));
    for(const id of [...topSet]){
      const cell=byId.get(id),files=fileCountById.get(id)||0;
      if(!cell?.project_id&&files<systemThreshold&&!/TOP/i.test(id))topSet.delete(id);
    }
  }
  const rank=(a,b)=>{
    const pa=a.project_id?1:0,pb=b.project_id?1:0;
    if(pa!==pb)return pb-pa;
    const fa=fileCountById.get(a.id)||0,fb=fileCountById.get(b.id)||0;
    if(fa!==fb)return fb-fa;
    const ta=a.kind==='testbench'?1:0,tb=b.kind==='testbench'?1:0;
    if(ta!==tb)return tb-ta;
    return String(a.name||a.id).localeCompare(String(b.name||b.id));
  };
  const topLevel=cells.filter(c=>topSet.has(c.id)).sort(rank);
  const testbenches=cells.filter(c=>!topSet.has(c.id)&&c.kind==='testbench').sort(rank);
  const submodules=cells.filter(c=>!topSet.has(c.id)&&c.kind!=='testbench').sort(rank);
  const primary=topLevel.find(c=>c.views?.some(v=>v.kind==='rnl'))||topLevel[0]||testbenches[0]||cells[0]||null;
  return {topLevel,testbenches,submodules,primary,fileCountById};
}

export function primaryProjectEntry(library){
  return classifyLibraryHierarchy(library).primary;
}

/** Human-friendly Virtuoso/EDA display labels for library views without altering manifest data. */
export function formatViewLabel(view){
  if(!view)return '';
  const id=view.id,raw=String(view.label||'');
  if(id==='schematic')return '原理图 (schematic)';
  if(id==='symbol')return view.virtualSymbol?'符号 (symbol · 内嵌于 RNL)':'符号 (symbol)';
  if(id==='veriloga'){
    const count=Array.isArray(view.files)?view.files.length:0;
    return count>1?`Verilog-A 行为模型 (veriloga · ${count} 个模块)`:'Verilog-A 行为模型 (veriloga)';
  }
  if(id==='netlist')return '网表 (netlist)';
  if(id==='simulation')return /incomplete|models/i.test(raw)?'仿真配置 (simulation · 历史输入/需外部 PDK)':'仿真配置 (simulation)';
  if(id==='docs')return '说明与依赖文档 (docs)';
  return raw||id;
}

/**
 * Expose embedded RNL `@DEFINE-SYMBOL` definitions as a `symbol` view entry for circuit cells
 * that do not already declare a standalone `symbol` view, and surface Verilog-A (`.va`/`.vams`)
 * behavioral models as a `veriloga` view without mutating archived library manifests.
 */
export function displayViewsForCell(cell,{library=null,libraries=null}={}){
  const raw=Array.isArray(cell?.views)?cell.views:[];
  const hasSymbol=raw.some(v=>v.id==='symbol');
  const hasVerilogA=raw.some(v=>v.id==='veriloga');
  const schematic=raw.find(v=>v.id==='schematic'&&v.kind==='rnl');
  let virtualVa=null;
  if(!hasVerilogA&&cell){
    const catalog=Array.isArray(libraries)&&libraries.length?libraries:(library?[library]:[]);
    if(catalog.length){
      const vaIndex=indexLibraryVerilogAFiles(catalog,library?.id||null);
      const direct=vaIndex.byKey.get(String(cell.id||'').toLowerCase())||vaIndex.byKey.get(String(cell.name||'').toLowerCase());
      if(direct){
        virtualVa={
          id:'veriloga',
          label:'Verilog-A behavioral model',
          kind:'veriloga',
          entry:direct.path,
          files:[direct.path],
          moduleName:direct.moduleName,
          sourceLibraryId:direct.libraryId,
          virtualVerilogA:true,
        };
      }
    }
    if(!virtualVa){
      const seen=new Set(),vaPaths=[];
      for(const v of raw){
        for(const f of v?.files||[]){
          if(!isVerilogAFile(f))continue;
          const key=verilogaModuleBasename(f).toLowerCase();
          if(key&&!seen.has(key)){seen.add(key);vaPaths.push(f);}
        }
      }
      if(vaPaths.length){
        virtualVa={
          id:'veriloga',
          label:'Verilog-A models',
          kind:'veriloga',
          entry:vaPaths[0],
          files:vaPaths,
          moduleName:vaPaths.length===1?verilogaModuleBasename(vaPaths[0]):null,
          virtualVerilogA:true,
        };
      }
    }
  }
  const out=[];
  let vaInserted=false;
  for(const view of raw){
    out.push(view);
    if(view===schematic&&!hasSymbol&&cell?.kind==='circuit'){
      out.push({...schematic,id:'symbol',label:'Embedded symbol',virtualSymbol:true,backingViewId:schematic.id});
    }
    if(virtualVa&&!vaInserted&&(view===schematic||view.id==='symbol')){
      out.push(virtualVa);
      vaInserted=true;
    }
  }
  if(virtualVa&&!vaInserted)out.unshift(virtualVa);
  return out;
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
    const aliases=validateViewFiles(view),paths=view.kind==='rnl'?view.files:[view.entry],snapshot=Object.create(null);let bytes=0;
    await pooled(paths,async path=>{const file=await read(path,{signal});bytes+=file.bytes;if(bytes>maxViewBytes)throw Error('视图文件集合超出读取大小限制。');snapshot['/'+path]=file.text;});
    if(view.kind==='rnl')for(const [logical,canonical] of Object.entries(aliases))snapshot['/'+logical]=snapshot['/'+canonical];
    if(signal?.aborted)throw new DOMException('已取消','AbortError');
    const path='/'+view.entry,source={name:view.entry,path,readonly:true,snapshot,files:new Map(Object.entries(snapshot).map(([path,text])=>[path,()=>new Blob([text],{type:'text/plain'})])),
      open:async()=>({path,text:snapshot[path]}),read:async requested=>{if(!Object.hasOwn(snapshot,requested))throw Error('依赖不在已发布文件清单中：'+requested);return snapshot[requested];}};
    return {source,text:snapshot[path],paths:[...paths],bytes};
  }
  return {load,loadView,urlFor};
}
