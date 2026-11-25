import {createLibraryClient,filterLibraries} from './model.js';

/** Library browser lives with the existing RNL workspace; only explicit opens load circuit files. */
export function mountLibraryManager({toolbar,libraryPane,onOpen,onReference,onSelection=()=>{},notify=()=>{},client=createLibraryClient()}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
  const button=(label,action)=>{const b=el('button',label);b.type='button';b.onclick=action;return b;};
  const css=el('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url).href;document.head.append(css);
  const dialog=el('dialog',undefined,'cg-library-manager');dialog.setAttribute('aria-label','Library Manager');
  const head=el('header'),title=el('h2','Library Manager'),close=button('关闭',()=>dialog.close());head.append(title,close);
  const tools=el('div',undefined,'cg-library-tools'),search=el('input');search.type='search';search.placeholder='搜索库、单元或视图';search.setAttribute('aria-label','搜索库、单元或视图');
  const refresh=button('刷新目录',()=>void load()),reference=button('回到 RC 参考',()=>void openReference());tools.append(search,refresh,reference);
  const status=el('p',undefined,'cg-library-status');status.setAttribute('role','status');
  const columns=el('div',undefined,'cg-library-columns');
  function column(label,key){const box=el('label'),name=el('span',label),select=el('select');select.size=10;select.dataset.libraryField=key;select.setAttribute('aria-label',label);box.append(name,select);columns.append(box);return select;}
  const libraries=column('Library · 库','library'),cells=column('Cell · 单元','cell'),views=column('View · 视图','view');
  const description=el('div',undefined,'cg-library-description'),crumb=el('strong'),summary=el('p'),dependency=el('p'),identity=el('details'),identityTitle=el('summary','文件与身份'),identityText=el('pre');identity.append(identityTitle,identityText);description.append(crumb,summary,dependency,identity);
  const preview=el('section',undefined,'cg-library-preview');preview.hidden=true;const previewTitle=el('h3'),previewText=el('pre'),previewFiles=el('label','视图文件'),previewFile=el('select');previewFile.setAttribute('aria-label','视图文件');previewFiles.style.cssText='display:grid;gap:5px';previewFile.style.cssText='width:100%;font:inherit;padding:5px';previewFiles.append(previewFile);preview.append(previewFiles,previewTitle,previewText);
  const footer=el('footer'),basis=el('span','公开文件浏览 · AI 节点身份独立'),open=button('打开视图',()=>void openSelected());footer.append(basis,open);
  dialog.append(head,tools,status,columns,description,preview,footer);document.body.append(dialog);
  const launcher=button('电路库',()=>show());launcher.id='studio-library-button';launcher.title='按库 / 单元 / 视图浏览公开电路';toolbar.append(launcher);
  const entry=el('section',undefined,'cg-library-entry');entry.append(el('strong','公开电路库'),el('p','Library → Cell → View'),button('打开 Library Manager',()=>show()));libraryPane?.prepend(entry);
  let data=[],errors=[],loaded=false,busy=false,loading=false,request=null,disposed=false;
  let previewValue=null,previewRequest=null;
  let selected={library:null,cell:null,view:null},selectionKey='';
  const options=(node,items,current,label)=>{node.replaceChildren(...items.map(item=>{const text=label(item),opt=new Option(text,item.id);opt.title=text;return opt;}));node.value=items.some(item=>item.id===current)?current:items[0]?.id||'';node.disabled=busy||loading||!items.length;};
  function selection(){const library=data.find(x=>x.id===libraries.value),cell=library?.cells.find(x=>x.id===cells.value),view=cell?.views.find(x=>x.id===views.value);return {library,cell,view};}
  function render(){
    const filtered=filterLibraries(data,search.value);options(libraries,filtered,selected.library,x=>x.name);const library=filtered.find(x=>x.id===libraries.value);
    options(cells,library?.cells||[],selected.cell,x=>x.name);const cell=library?.cells.find(x=>x.id===cells.value);options(views,cell?.views||[],selected.view,x=>x.label);
    selected={library:libraries.value,cell:cells.value,view:views.value};const exact=selection();
    const nextKey=JSON.stringify([exact.library?.id,exact.cell?.id,exact.view?.id]);if(nextKey!==selectionKey){selectionKey=nextKey;onSelection(exact.view?exact:null);}
    crumb.textContent=exact.cell?[exact.library.name,exact.cell.name,exact.view?.label].filter(Boolean).join(' / '):loaded?'没有匹配的单元':'按库、单元和视图浏览';
    summary.textContent=exact.cell?.description||exact.library?.description||'';
    dependency.textContent=exact.cell?(exact.cell.requires_external_models?'需要外部模型 · 可查看已有原理图；本页不运行仿真。':'本页只浏览已发布文件；是否可重放仿真请查看单元说明。'):'';
    dependency.className=exact.cell?.requires_external_models?'cg-library-dependency':'';
    identity.hidden=!exact.view;identityText.textContent=exact.view?JSON.stringify({library:exact.library.id,cell:exact.cell.id,project_id:exact.cell.project_id,view:exact.view.id,kind:exact.view.kind,entry:exact.view.entry,files:exact.view.files},null,2):'';
    open.textContent=busy?'正在打开…':exact.view?.kind==='rnl'?'打开原理图':'查看文件';open.disabled=busy||loading||!exact.view;
    refresh.disabled=reference.disabled=search.disabled=busy||loading;close.disabled=busy;
    if(!busy&&!loading&&loaded)status.textContent=`${filtered.length} 个库 · ${filtered.reduce((n,l)=>n+l.cells.length,0)} 个单元`+(errors.length?` · ${errors.length} 个库读取失败：${errors.map(x=>x.name+'：'+x.message).join('；')}`:'');
  }
  async function load(){
    if(busy||loading||disposed)return;hidePreview();request?.abort();request=new AbortController();loading=true;status.textContent='读取已发布的库目录…';render();
    try{const result=await client.load({signal:request.signal});if(disposed||request.signal.aborted)return;data=result.libraries;errors=result.errors;loaded=true;}
    catch(error){if(!disposed&&!request.signal.aborted){data=[];loaded=false;status.textContent='库目录暂不可用：'+error.message+' RC 参考仍可使用。';}}
    finally{loading=false;if(!disposed)render();}
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
  async function openSelected(){
    const value=selection();if(busy||loading||!value.view)return;hidePreview();
    if(value.view.kind!=='rnl'){previewValue=value;previewFile.replaceChildren(...value.view.files.map(path=>new Option(path,path)));previewFile.value=value.view.entry;void loadPreview(value,value.view.entry);return;}
    request?.abort();request=new AbortController();busy=true;status.textContent=`读取 ${value.view.files.length} 个已列出的文件…`;render();
    let errorText='';
    try{const bundle=await client.loadView(value.view,{signal:request.signal});if(disposed||request.signal.aborted)return;
      if(value.view.kind==='rnl'){
        // The native viewer may need its own unsaved-edit confirmation dialog.
        dialog.close();const opened=await onOpen({...value,bundle});if(opened!==false)notify('已打开 '+value.cell.name+' / '+value.view.label+'；未启动仿真。');
      }
    }catch(error){if(!disposed){errorText='打开失败：'+error.message;notify(errorText,{kind:'error'});}}
    finally{busy=false;if(!disposed){render();if(errorText){status.textContent=errorText;if(!dialog.open)dialog.showModal();}}}
  }
  async function openReference(){if(busy||loading)return;hidePreview();busy=true;render();dialog.close();try{await onReference();}catch(error){notify(error.message,{kind:'error'});}finally{busy=false;render();}}
  function show(){if(disposed)return;if(!dialog.open)dialog.showModal();search.focus();if(!loaded)void load();}
  search.oninput=()=>{hidePreview();render();};
  libraries.onchange=()=>{selected={library:libraries.value,cell:null,view:null};hidePreview();render();};
  cells.onchange=()=>{selected.cell=cells.value;selected.view=null;hidePreview();render();};views.onchange=()=>{selected.view=views.value;hidePreview();render();};
  views.ondblclick=()=>void openSelected();views.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void openSelected();}};
  dialog.addEventListener('keydown',event=>event.stopPropagation());dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  render();
  return {show,destroy(){disposed=true;request?.abort();hidePreview();dialog.remove();launcher.remove();entry.remove();css.remove();}};
}
