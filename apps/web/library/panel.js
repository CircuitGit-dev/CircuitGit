import {createLibraryClient,filterLibraries,classifyLibraryHierarchy,formatViewLabel,displayViewsForCell} from './model.js';
import {verilogaModuleBasename} from './veriloga.js';

/** Library browser lives with the existing RNL workspace; only explicit opens load circuit files. */
export function mountLibraryManager({toolbar,libraryPane,onOpen,onOpenVerilogA=null,onReference,onSelection=()=>{},notify=()=>{},client=createLibraryClient()}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
  const button=(label,action)=>{const b=el('button',label);b.type='button';b.onclick=action;return b;};
  const css=el('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url).href;document.head.append(css);
  const dialog=el('dialog',undefined,'cg-library-manager');dialog.setAttribute('aria-label','Library Manager');
  const head=el('header'),title=el('h2','Library Manager'),close=button('关闭',()=>dialog.close());head.append(title,close);
  const tools=el('div',undefined,'cg-library-tools'),search=el('input');search.type='search';search.placeholder='搜索项目、顶层或子模块';search.setAttribute('aria-label','搜索库、单元或视图');
  const refresh=button('刷新目录',()=>void load()),reference=button('回到 RC 参考',()=>void openReference());tools.append(search,refresh,reference);
  const status=el('p',undefined,'cg-library-status');status.setAttribute('role','status');
  const columns=el('div',undefined,'cg-library-columns');
  function column(label,key){const box=el('label'),name=el('span',label),select=el('select');select.size=10;select.dataset.libraryField=key;select.setAttribute('aria-label',label);box.append(name,select);columns.append(box);return select;}
  const libraries=column('Project / Library · 项目','library'),cells=column('Hierarchy · 顶层与模块','cell'),views=column('View · 视图','view');
  const description=el('div',undefined,'cg-library-description'),crumb=el('strong'),summary=el('p'),dependency=el('p'),identity=el('details'),identityTitle=el('summary','文件与身份'),identityText=el('pre');identity.append(identityTitle,identityText);description.append(crumb,summary,dependency,identity);
  const preview=el('section',undefined,'cg-library-preview');preview.hidden=true;const previewTitle=el('h3'),previewText=el('pre'),previewFiles=el('label','视图文件'),previewFile=el('select');previewFile.setAttribute('aria-label','视图文件');previewFiles.style.cssText='display:grid;gap:5px';previewFile.style.cssText='width:100%;font:inherit;padding:5px';previewFiles.append(previewFile);preview.append(previewFiles,previewTitle,previewText);
  const footer=el('footer'),basis=el('span','按项目统一管理；打开顶层原理图后可双击下钻任意子模块'),footerActions=el('div',undefined,'cg-library-footer-actions'),openTop=button('打开项目顶层',()=>void openProjectTop()),open=button('打开视图',()=>void openSelected());footerActions.append(openTop,open);footer.append(basis,footerActions);
  dialog.append(head,tools,status,columns,description,preview,footer);document.body.append(dialog);
  const launcher=button('项目 / 电路库',()=>show());launcher.id='studio-library-button';launcher.title='按项目与顶层层级浏览并切换电路';toolbar.append(launcher);
  const entry=el('section',undefined,'cg-library-entry');entry.append(el('strong','项目与电路库'),el('p','Project → 顶层原理图 → 双击下钻子模块'),button('打开 Library Manager',()=>show()));libraryPane?.prepend(entry);
  let data=[],errors=[],loaded=false,busy=false,loading=false,request=null,disposed=false;
  let previewValue=null,previewRequest=null;
  let selected={library:null,cell:null,view:null},selectionKey='';
  const options=(node,items,current,label)=>{node.replaceChildren(...items.map(item=>{const text=label(item),opt=new Option(text,item.id);opt.title=text;return opt;}));node.value=items.some(item=>item.id===current)?current:items[0]?.id||'';node.disabled=busy||loading||!items.length;};
  function populateCells(library,current){
    if(!library||!library.cells.length){cells.replaceChildren();cells.value='';cells.disabled=true;return null;}
    const h=classifyLibraryHierarchy(library);
    const hasHierarchy=h.submodules.length>0;
    const makeOpt=(cell,tag='')=>{
      const count=h.fileCountById.get(cell.id)||0;
      const suffix=hasHierarchy&&tag?(count>1?` (${tag} · ${count} 文件)`:` (${tag})`):'';
      const opt=new Option(cell.name+suffix,cell.id);
      opt.title=cell.name+(suffix||'');
      return opt;
    };
    if(!hasHierarchy){
      const ordered=[...h.topLevel,...h.testbenches,...h.submodules];
      cells.replaceChildren(...ordered.map(c=>makeOpt(c)));
    }else{
      const groups=[];
      const addGroup=(label,items,tag)=>{
        if(!items.length)return;
        const g=document.createElement('optgroup');
        g.label=label;
        for(const item of items)g.append(makeOpt(item,tag));
        groups.push(g);
      };
      addGroup('★ 项目顶层（推荐 · 完整层级入口）',h.topLevel,'顶层');
      addGroup('其他测试台 (Testbench)',h.testbenches,'测试台');
      addGroup('内部子模块（可从顶层原理图双击下钻）',h.submodules,'');
      cells.replaceChildren(...groups);
    }
    const allIds=new Set(library.cells.map(c=>c.id));
    cells.value=current&&allIds.has(current)?current:(h.primary?.id||library.cells[0]?.id||'');
    cells.disabled=busy||loading||!library.cells.length;
    return h;
  }
  function selection(){const library=data.find(x=>x.id===libraries.value),cell=library?.cells.find(x=>x.id===cells.value),cellViews=displayViewsForCell(cell,{library,libraries:data}),view=cellViews.find(x=>x.id===views.value);return {library,cell,view};}
  function render(){
    const filtered=filterLibraries(data,search.value);options(libraries,filtered,selected.library,x=>x.name);const library=filtered.find(x=>x.id===libraries.value);
    const hierarchy=populateCells(library,selected.cell);const cell=library?.cells.find(x=>x.id===cells.value);const cellViews=displayViewsForCell(cell,{library,libraries:data});options(views,cellViews,selected.view,formatViewLabel);
    selected={library:libraries.value,cell:cells.value,view:views.value};const exact=selection();
    const canonicalView=exact.view?.backingViewId?exact.cell?.views.find(v=>v.id===exact.view.backingViewId)||exact.view:exact.view;
    const nextKey=JSON.stringify([exact.library?.id,exact.cell?.id,canonicalView?.id]);if(nextKey!==selectionKey){selectionKey=nextKey;onSelection(canonicalView?{library:exact.library,cell:exact.cell,view:canonicalView}:null);}
    crumb.textContent=exact.cell?[exact.library.name,exact.cell.name,exact.view?formatViewLabel(exact.view):''].filter(Boolean).join(' / '):loaded?'没有匹配的单元':'按项目、顶层与视图浏览';
    summary.textContent=exact.view?.virtualSymbol
      ?'该单元的符号（@DEFINE-SYMBOL）内嵌于 RNL 原理图源码中；打开后会自动展开左侧「符号」面板查看 SVG 符号、引脚坐标与定义代码。'
      :exact.view?.id==='veriloga'
        ?(exact.view.files?.length>1
          ?`包含本单元引用的 ${exact.view.files.length} 个 Verilog-A (.va) 行为模型；打开后会在原理图同组的「Verilog-A」标签页展示源码。`
          :`Verilog-A 行为模型源码（${exact.view.entry.split('/').pop()}）；打开后会在原理图同组的「Verilog-A」标签页查看端口、参数与完整代码。`)
        :(exact.cell?.description||exact.library?.description||'');
    dependency.textContent=exact.cell?(exact.cell.requires_external_models?'需要外部模型 · 可查看已有原理图；本页不运行仿真。':'本页只浏览已发布文件；是否可重放仿真请查看单元说明。'):'';
    dependency.className=exact.cell?.requires_external_models?'cg-library-dependency':'';
    identity.hidden=!exact.view;identityText.textContent=exact.view?JSON.stringify({library:exact.library.id,cell:exact.cell.id,project_id:exact.cell.project_id,view:exact.view.id,kind:exact.view.kind,entry:exact.view.entry,files:exact.view.files,...(exact.view.virtualSymbol?{embedded_in:'schematic'}:{}),...(exact.view.sourceLibraryId&&exact.view.sourceLibraryId!==exact.library.id?{source_library:exact.view.sourceLibraryId}:{})},null,2):'';
    const topCell=hierarchy?.primary||null,topRnl=topCell?.views?.find(v=>v.kind==='rnl')||null;
    openTop.hidden=!topRnl||exact.cell?.id===topCell?.id&&exact.view?.id===topRnl?.id;
    openTop.disabled=busy||loading||!topRnl;
    openTop.textContent=topCell?`打开项目顶层 (${topCell.name})`:'打开项目顶层';
    open.textContent=busy?'正在打开…':exact.view?.id==='veriloga'?'打开 Verilog-A 代码':exact.view?.id==='symbol'?'打开符号视图':exact.view?.kind==='rnl'?'打开原理图':'查看文件';open.disabled=busy||loading||!exact.view;
    refresh.disabled=reference.disabled=search.disabled=busy||loading;close.disabled=busy;
    if(!busy&&!loading&&loaded)status.textContent=`${filtered.length} 个项目 · ${filtered.reduce((n,l)=>n+l.cells.length,0)} 个单元`+(errors.length?` · ${errors.length} 个库读取失败：${errors.map(x=>x.name+'：'+x.message).join('；')}`:'');
  }
  async function load(){
    if(busy||loading||disposed)return;hidePreview();request?.abort();request=new AbortController();loading=true;status.textContent='读取已发布的库目录…';render();
    try{const result=await client.load({signal:request.signal});if(disposed||request.signal.aborted)return;data=result.libraries;errors=result.errors;loaded=true;}
    catch(error){if(!disposed&&!request.signal.aborted){data=[];loaded=false;status.textContent='库目录暂不可用：'+error.message+' RC 参考仍可使用。';}}
    finally{loading=false;if(!disposed)render();}
  }
  async function ensureLoaded(){
    if(!loaded)await load();
    return data;
  }
  function hidePreview(){previewRequest?.abort();previewRequest=null;previewValue=null;preview.hidden=true;}
  async function loadPreview(value,path){
    if(disposed||value!==previewValue||value.view.kind==='rnl'||!value.view.files.includes(path))return;
    previewRequest?.abort();const current=new AbortController();previewRequest=current;previewTitle.textContent=path;previewText.textContent='正在读取…';status.textContent='读取 '+path+'…';
    try{const bundle=await client.loadView({...value.view,entry:path},{signal:current.signal});if(disposed||current.signal.aborted||previewRequest!==current||previewValue!==value)return;previewText.textContent=bundle.text;preview.hidden=false;status.textContent='已读取 '+path;}
    catch(error){if(disposed||current.signal.aborted||previewRequest!==current||previewValue!==value)return;previewText.textContent='打开失败：'+error.message;preview.hidden=false;status.textContent=previewText.textContent;notify(previewText.textContent,{kind:'error'});}
    finally{if(previewRequest===current)previewRequest=null;}
  }
  previewFile.onchange=()=>{if(previewValue)void loadPreview(previewValue,previewFile.value);};
  async function openValue(value,{closeDialog=true}={}){
    if(busy||loading||!value?.view)return false;hidePreview();
    if((value.view.id==='veriloga'||value.view.kind==='veriloga')&&typeof onOpenVerilogA==='function'){
      request?.abort();request=new AbortController();busy=true;status.textContent=`读取 Verilog-A 模型 ${value.view.entry.split('/').pop()}…`;render();
      let errorText='',result=false;
      try{
        const entryBundle=await client.loadView({...value.view,entry:value.view.entry},{signal:request.signal});
        if(disposed||request.signal.aborted)return false;
        const siblings=value.view.files.map(path=>({
          path,
          moduleName:verilogaModuleBasename(path),
          libraryId:value.view.sourceLibraryId||value.library.id,
          libraryName:value.library.name,
          text:path===value.view.entry?entryBundle.text:null,
        }));
        if(closeDialog&&dialog.open)dialog.close();
        const opened=await onOpenVerilogA({...value,path:value.view.entry,text:entryBundle.text,siblings,client});
        if(opened!==false){result=true;notify(`已打开 Verilog-A 模型 ${verilogaModuleBasename(value.view.entry)}。`);}
      }catch(error){if(!disposed){errorText='打开 Verilog-A 失败：'+error.message;notify(errorText,{kind:'error'});}}
      finally{busy=false;if(!disposed){render();if(errorText&&closeDialog){status.textContent=errorText;if(!dialog.open)dialog.showModal();}}}
      return result;
    }
    if(value.view.kind!=='rnl'){previewValue=value;previewFile.replaceChildren(...value.view.files.map(path=>new Option(path,path)));previewFile.value=value.view.entry;void loadPreview(value,value.view.entry);return false;}
    request?.abort();request=new AbortController();busy=true;status.textContent=`读取 ${value.view.files.length} 个已列出的文件…`;render();
    let errorText='',result=false;
    try{const bundle=await client.loadView(value.view,{signal:request.signal});if(disposed||request.signal.aborted)return false;
      if(closeDialog&&dialog.open)dialog.close();
      const opened=await onOpen({...value,bundle});
      if(opened!==false){result=true;notify(value.view.virtualSymbol?('已打开 '+value.cell.name+' 的符号视图（左侧「符号」面板可查看 SVG、引脚坐标与定义源码）。'):('已打开项目 '+value.library.name+' · '+value.cell.name+'；可在原理图内双击下钻子模块。'));}
    }catch(error){if(!disposed){errorText='打开失败：'+error.message;notify(errorText,{kind:'error'});}}
    finally{busy=false;if(!disposed){render();if(errorText&&closeDialog){status.textContent=errorText;if(!dialog.open)dialog.showModal();}}}
    return result;
  }
  async function openSelected(){return openValue(selection(),{closeDialog:true});}
  async function openProjectTop(libraryId=null,cellId=null){
    await ensureLoaded();
    const library=libraryId?data.find(x=>x.id===libraryId):data.find(x=>x.id===libraries.value);
    if(!library)return false;
    const h=classifyLibraryHierarchy(library);
    const cell=(cellId?library.cells.find(c=>c.id===cellId):null)||h.primary;
    const view=cell?.views?.find(v=>v.kind==='rnl')||h.primary?.views?.find(v=>v.kind==='rnl');
    if(!cell||!view)return false;
    selected={library:library.id,cell:cell.id,view:view.id};
    render();
    return openValue({library,cell,view},{closeDialog:dialog.open});
  }
  async function openReference(){if(busy||loading)return;hidePreview();busy=true;render();dialog.close();try{await onReference();}catch(error){notify(error.message,{kind:'error'});}finally{busy=false;render();}}
  function show(){if(disposed)return;if(!dialog.open)dialog.showModal();search.focus();if(!loaded)void load();}
  search.oninput=()=>{hidePreview();render();};
  libraries.onchange=()=>{selected={library:libraries.value,cell:null,view:null};hidePreview();render();};
  cells.onchange=()=>{selected.cell=cells.value;selected.view=null;hidePreview();render();};views.onchange=()=>{selected.view=views.value;hidePreview();render();};
  views.ondblclick=()=>void openSelected();views.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void openSelected();}};
  dialog.addEventListener('keydown',event=>event.stopPropagation());dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  render();
  return {show,openProjectTop,ensureLoaded,getLibraries:()=>data,getClient:()=>client,destroy(){disposed=true;request?.abort();hidePreview();dialog.remove();launcher.remove();entry.remove();css.remove();}};
}
