import {
  createLibraryClient,
  filterLibraries,
  classifyLibraryHierarchy,
  formatLibraryName,
  formatViewLabel,
  displayViewsForCell,
  isArchivedLibrary,
  visibleLibraries,
  availableViewTypesForCell,
  normalizeLiveCatalog,
  buildCreateViewArgs,
} from './model.js';
import {verilogaModuleBasename} from './veriloga.js';

/** Library browser & CRUD manager paired with the existing RNL workspace; only explicit opens load circuit files. */
export function mountLibraryManager({
  toolbar,
  libraryPane,
  onOpen,
  onOpenVerilogA=null,
  onReference,
  onSelection=()=>{},
  notify=()=>{},
  client=createLibraryClient(),
  bridge=null,
  onConnect=null,
  onMutated=null,
}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
  const button=(label,action)=>{const b=el('button',label);b.type='button';b.onclick=action;return b;};
  const css=el('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url).href;document.head.append(css);
  const dialog=el('dialog',undefined,'cg-library-manager');dialog.setAttribute('aria-label','Library Manager');
  const head=el('header'),title=el('h2','Library Manager'),close=button('关闭',()=>dialog.close());head.append(title,close);
  const tools=el('div',undefined,'cg-library-tools'),search=el('input');search.type='search';search.placeholder='搜索项目、顶层或子模块';search.setAttribute('aria-label','搜索库、单元或视图');
  const archiveLabel=el('label',undefined,'cg-library-archive-toggle'),archiveToggle=document.createElement('input');archiveToggle.type='checkbox';archiveToggle.checked=false;archiveLabel.append(archiveToggle,document.createTextNode('显示历史归档库'));archiveLabel.hidden=true;
  const refresh=button('刷新目录',()=>void load()),reference=button('回到 RC 参考',()=>void openReference());tools.append(search,archiveLabel,refresh,reference);
  const crudBar=el('div',undefined,'cg-library-crud-bar');
  const crudDrawer=el('form',undefined,'cg-library-crud-drawer');crudDrawer.hidden=true;
  const status=el('p',undefined,'cg-library-status');status.setAttribute('role','status');
  const columns=el('div',undefined,'cg-library-columns');
  function column(label,key){const box=el('label'),name=el('span',label),select=el('select');select.size=10;select.dataset.libraryField=key;select.setAttribute('aria-label',label);box.append(name,select);columns.append(box);return select;}
  const libraries=column('Project / Library · 项目','library'),cells=column('Hierarchy · 顶层与模块','cell'),views=column('View · 视图','view');
  const description=el('div',undefined,'cg-library-description'),crumb=el('strong'),summary=el('p'),dependency=el('p'),identity=el('details'),identityTitle=el('summary','文件与身份'),identityText=el('pre');identity.append(identityTitle,identityText);description.append(crumb,summary,dependency,identity);
  const preview=el('section',undefined,'cg-library-preview');preview.hidden=true;const previewTitle=el('h3'),previewText=el('pre'),previewFiles=el('label','视图文件'),previewFile=el('select');previewFile.setAttribute('aria-label','视图文件');previewFiles.style.cssText='display:grid;gap:5px';previewFile.style.cssText='width:100%;font:inherit;padding:5px';previewFiles.append(previewFile);preview.append(previewFiles,previewTitle,previewText);
  const footer=el('footer'),basis=el('span','按项目统一管理；打开顶层原理图后可双击下钻任意子模块'),footerActions=el('div',undefined,'cg-library-footer-actions'),openTop=button('打开项目顶层',()=>void openProjectTop()),open=button('打开视图',()=>void openSelected());footerActions.append(openTop,open);footer.append(basis,footerActions);
  dialog.append(head,tools,crudBar,crudDrawer,status,columns,description,preview,footer);document.body.append(dialog);
  const launcher=button('项目 / 电路库',()=>show());launcher.id='studio-library-button';launcher.title='按项目与顶层层级浏览并切换电路';toolbar.append(launcher);
  const entry=el('section',undefined,'cg-library-entry');entry.append(el('strong','项目与电路库'),el('p','Project → 顶层原理图 → 双击下钻子模块'),button('打开 Library Manager',()=>show()));libraryPane?.prepend(entry);
  let data=[],errors=[],loaded=false,busy=false,loading=false,request=null,disposed=false;
  let previewValue=null,previewRequest=null;
  let selected={library:null,cell:null,view:null},selectionKey='';
  let usingLiveCatalog=false,liveBaseCommit=null,liveCapabilities=null,publishedFallback=null;
  let crudMode=null,crudBusy=false,crudError='',crudForm={};
  const bridgeConnected=()=>bridge?.getState?.()?.connected===true;
  const options=(node,items,current,label)=>{node.replaceChildren(...items.map(item=>{const text=label(item),opt=new Option(text,item.id);opt.title=text;return opt;}));node.value=items.some(item=>item.id===current)?current:items[0]?.id||'';node.disabled=busy||loading||crudBusy||!items.length;};
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
    cells.disabled=busy||loading||crudBusy||!library.cells.length;
    return h;
  }
  function selection(){const library=data.find(x=>x.id===libraries.value),cell=library?.cells.find(x=>x.id===cells.value),cellViews=displayViewsForCell(cell,{library,libraries:data}),view=cellViews.find(x=>x.id===views.value);return {library,cell,view};}
  function liveViewClient(value){
    const base=new URL('https://circuitgit.local/library-files/');
    return createLibraryClient({
      baseURL:base,
      fetcher:async(url,{signal}={})=>{
        if(signal?.aborted)throw new DOMException('已取消','AbortError');
        const requested=new URL(url);
        if(requested.origin!==base.origin||!requested.pathname.startsWith(base.pathname))throw Error('本机文件请求越界。');
        const path=decodeURIComponent(requested.pathname.slice(base.pathname.length));
        const file=await bridge.request('read_file',{library_id:value.library.id,cell_id:value.cell.id,path});
        if(file.path!==path||typeof(file.text??file.content)!=='string')throw Error('节点返回的视图文件身份无效。');
        return new Response(file.text??file.content,{status:200,headers:{'Content-Type':'text/plain;charset=utf-8'}});
      },
    });
  }
  function loadViewForValue(value,viewOverride,{signal}={}){
    const crossLibraryVirtual=Boolean(value.view?.virtualVerilogA&&value.view?.sourceLibraryId&&value.view.sourceLibraryId!==value.library?.id);
    if(usingLiveCatalog&&bridgeConnected()&&!crossLibraryVirtual){
      return liveViewClient(value).loadView(viewOverride,{signal});
    }
    return client.loadView(viewOverride,{signal});
  }
  function openCrud(mode){
    if(busy||loading||crudBusy)return;
    if(crudMode===mode){crudMode=null;crudError='';renderCrud();return;}
    const exact=selection();
    crudMode=mode;crudError='';
    if(mode==='create_library'){
      crudForm={library_id:'',name:'',description:''};
    }else if(mode==='create_cell'){
      crudForm={library_id:exact.library?.id||data[0]?.id||'',cell_id:'',name:'',kind:'circuit',description:'',autoOpen:true};
    }else if(mode==='clone_cell'){
      if(!exact.cell){crudMode=null;return;}
      crudForm={source_library_id:exact.library.id,source_cell_id:exact.cell.id,library_id:exact.library.id,cell_id:exact.cell.id+'_v2',name:'',autoOpen:true};
    }else if(mode==='create_view'){
      if(!exact.cell){crudMode=null;return;}
      const choices=availableViewTypesForCell(exact.cell);
      const firstOpen=choices.find(c=>!c.exists);
      if(!firstOpen){crudMode=null;return;}
      crudForm={library_id:exact.library.id,cell_id:exact.cell.id,view_id:firstOpen.id,label:'',filename:'',level:'',autoOpen:true};
    }
    renderCrud();
  }
  function fieldInput(labelText,key,{placeholder='',disabled=false}={}){
    const wrap=el('label'),input=el('input');
    wrap.append(el('span',labelText));
    input.type='text';input.value=crudForm[key]??'';input.placeholder=placeholder;input.disabled=crudBusy||disabled;
    input.setAttribute('aria-label',labelText);
    input.oninput=()=>{crudForm[key]=input.value;};
    wrap.append(input);
    return {wrap,input};
  }
  function renderCrud(exact=selection()){
    crudBar.replaceChildren();
    crudDrawer.replaceChildren();
    if(!bridge){crudBar.hidden=true;crudDrawer.hidden=true;return;}
    crudBar.hidden=false;
    const connected=bridgeConnected();
    if(!connected){
      crudDrawer.hidden=true;
      crudBar.append(el('span','连接本机工作台后可直接新建电路库、单元与视图。','cg-library-crud-hint'));
      if(typeof onConnect==='function'){
        const connectBtn=button('连接本机',()=>void onConnect());
        connectBtn.disabled=busy||loading||crudBusy;
        crudBar.append(connectBtn);
      }
      return;
    }
    const execOps=new Set(liveCapabilities?.execute_operations||[]);
    const canExec=op=>!liveCapabilities||execOps.has(op);
    const viewChoices=exact.cell?availableViewTypesForCell(exact.cell):[];
    const hasMissingView=viewChoices.some(v=>!v.exists);
    const addBtn=(mode,text,disabled)=>{
      const btn=button(text,()=>openCrud(mode));
      btn.classList.toggle('is-active',crudMode===mode);
      btn.disabled=busy||loading||crudBusy||disabled;
      crudBar.append(btn);
    };
    addBtn('create_library','+ 新建电路库',!canExec('create_library'));
    addBtn('create_cell','+ 新建单元',!canExec('create_cell')||!data.length);
    addBtn('clone_cell','克隆单元',!canExec('clone_cell')||!exact.cell);
    addBtn('create_view','+ 新建视图',!canExec('create_view')||!exact.cell||!hasMissingView);
    if(crudMode==='clone_cell'&&(!exact.cell||exact.library?.id!==crudForm.source_library_id||exact.cell?.id!==crudForm.source_cell_id)){
      if(exact.cell)crudForm={...crudForm,source_library_id:exact.library.id,source_cell_id:exact.cell.id,library_id:exact.library.id,cell_id:exact.cell.id+'_v2'};
      else crudMode=null;
    }
    if(crudMode==='create_view'){
      if(!exact.cell||!hasMissingView)crudMode=null;
      else if(exact.library?.id!==crudForm.library_id||exact.cell?.id!==crudForm.cell_id){
        const firstOpen=viewChoices.find(c=>!c.exists);
        crudForm={...crudForm,library_id:exact.library.id,cell_id:exact.cell.id,view_id:firstOpen?.id||''};
      }
    }
    if(!crudMode){crudDrawer.hidden=true;return;}
    crudDrawer.hidden=false;
    const headRow=el('div',undefined,'cg-library-crud-head');
    const titles={create_library:'新建电路库 (New Library)',create_cell:'新建单元 (New Cell)',clone_cell:'克隆单元 (Clone Cell)',create_view:'新建视图 (New View)'};
    headRow.append(el('strong',titles[crudMode]));
    const cancelTop=button('取消',()=>{crudMode=null;crudError='';renderCrud();});cancelTop.disabled=crudBusy;
    headRow.append(cancelTop);
    crudDrawer.append(headRow);
    const grid=el('div',undefined,'cg-library-crud-grid');
    if(crudMode==='create_library'){
      grid.append(
        fieldInput('电路库 ID *','library_id',{placeholder:'如 my-analog-lib'}).wrap,
        fieldInput('显示名称','name',{placeholder:'可选，默认同 ID'}).wrap,
        fieldInput('说明','description',{placeholder:'可选描述'}).wrap,
      );
    }else if(crudMode==='create_cell'){
      const libWrap=el('label'),libSel=el('select');
      libWrap.append(el('span','所属电路库 *'));
      for(const lib of data)libSel.add(new Option(`${formatLibraryName(lib)} (${lib.id})`,lib.id));
      libSel.value=data.some(l=>l.id===crudForm.library_id)?crudForm.library_id:(data[0]?.id||'');
      crudForm.library_id=libSel.value;libSel.disabled=crudBusy;
      libSel.onchange=()=>{crudForm.library_id=libSel.value;};
      libWrap.append(libSel);
      const kindWrap=el('label'),kindSel=el('select');
      kindWrap.append(el('span','单元类型'));
      kindSel.add(new Option('电路单元 (circuit)','circuit'));
      kindSel.add(new Option('测试台 (testbench)','testbench'));
      kindSel.value=crudForm.kind||'circuit';kindSel.disabled=crudBusy;
      kindSel.onchange=()=>{crudForm.kind=kindSel.value;};
      kindWrap.append(kindSel);
      grid.append(
        libWrap,
        fieldInput('单元 ID *','cell_id',{placeholder:'如 ota_two_stage'}).wrap,
        fieldInput('显示名称','name',{placeholder:'可选，默认同 ID'}).wrap,
        kindWrap,
        fieldInput('说明','description',{placeholder:'可选描述'}).wrap,
      );
    }else if(crudMode==='clone_cell'){
      const srcWrap=el('label'),srcInput=el('input');
      srcWrap.append(el('span','源单元'));
      srcInput.type='text';srcInput.value=`${crudForm.source_library_id} / ${crudForm.source_cell_id}`;srcInput.readOnly=true;srcInput.disabled=true;
      srcWrap.append(srcInput);
      const libWrap=el('label'),libSel=el('select');
      libWrap.append(el('span','目标电路库 *'));
      for(const lib of data)libSel.add(new Option(`${formatLibraryName(lib)} (${lib.id})`,lib.id));
      libSel.value=data.some(l=>l.id===crudForm.library_id)?crudForm.library_id:crudForm.source_library_id;
      crudForm.library_id=libSel.value;libSel.disabled=crudBusy;
      libSel.onchange=()=>{crudForm.library_id=libSel.value;};
      libWrap.append(libSel);
      grid.append(
        srcWrap,
        libWrap,
        fieldInput('新单元 ID *','cell_id',{placeholder:`${crudForm.source_cell_id}_v2`}).wrap,
        fieldInput('显示名称','name',{placeholder:'可选，默认同新 ID'}).wrap,
      );
    }else if(crudMode==='create_view'){
      const targetWrap=el('label'),targetInput=el('input');
      targetWrap.append(el('span','目标单元'));
      targetInput.type='text';targetInput.value=`${exact.library.id} / ${exact.cell.id}`;targetInput.readOnly=true;targetInput.disabled=true;
      targetWrap.append(targetInput);
      const viewWrap=el('label'),viewSel=el('select');
      viewWrap.append(el('span','视图类型 *'));
      for(const spec of viewChoices){
        const opt=new Option(spec.exists?`${spec.label}（已存在）`:spec.label,spec.id);
        opt.disabled=spec.exists;
        viewSel.add(opt);
      }
      const chosenSpec=viewChoices.find(c=>c.id===crudForm.view_id&&!c.exists)||viewChoices.find(c=>!c.exists);
      crudForm.view_id=chosenSpec?.id||'';
      viewSel.value=crudForm.view_id;viewSel.disabled=crudBusy;
      viewSel.onchange=()=>{crudForm.view_id=viewSel.value;renderCrud(selection());};
      viewWrap.append(viewSel);
      grid.append(
        targetWrap,
        viewWrap,
        fieldInput('显示标签','label',{placeholder:chosenSpec?.defaultLabel||'可选'}).wrap,
        fieldInput('文件名','filename',{placeholder:chosenSpec?chosenSpec.defaultFilename(exact.cell.id):'可选'}).wrap,
      );
      if(chosenSpec?.kind==='rnl'){
        grid.append(fieldInput('原生层级 (RNL level)','level',{placeholder:'可选，如 @top 或子电路名'}).wrap);
      }
    }
    crudDrawer.append(grid);
    if(crudError)crudDrawer.append(el('p',crudError,'cg-library-crud-error'));
    const actionsRow=el('div',undefined,'cg-library-crud-actions');
    if(crudMode!=='create_library'){
      const chkLabel=el('label',undefined,'cg-library-crud-check'),chk=document.createElement('input');
      chk.type='checkbox';chk.checked=crudForm.autoOpen!==false;chk.disabled=crudBusy;
      chk.onchange=()=>{crudForm.autoOpen=chk.checked;};
      chkLabel.append(chk,document.createTextNode(crudMode==='create_cell'?'创建后立即打开原理图':'创建后立即打开视图'));
      actionsRow.append(chkLabel);
    }else{
      actionsRow.append(el('span','将自动提交到当前本地分支。','cg-library-crud-hint'));
    }
    const submitBtn=el('button',crudBusy?'提交中…':'创建并提交','cg-library-crud-submit');
    submitBtn.type='submit';submitBtn.disabled=crudBusy;
    actionsRow.append(submitBtn);
    crudDrawer.append(actionsRow);
    crudDrawer.onsubmit=event=>{event.preventDefault();void submitCrud();};
  }
  async function submitCrud(){
    if(crudBusy||!crudMode||!bridgeConnected())return;
    const mode=crudMode;
    crudError='';
    let operation=mode,args=null,targetLib='',targetCell='',targetView='',autoOpen=crudForm.autoOpen!==false;
    try{
      if(mode==='create_library'){
        targetLib=String(crudForm.library_id||'').trim();
        if(!targetLib)throw Error('请填写电路库 ID。');
      }else if(mode==='create_cell'){
        targetLib=String(crudForm.library_id||'').trim();
        targetCell=String(crudForm.cell_id||'').trim();
        if(!targetLib||!targetCell)throw Error('请选择电路库并填写单元 ID。');
        targetView='schematic';
      }else if(mode==='clone_cell'){
        targetLib=String(crudForm.library_id||'').trim();
        targetCell=String(crudForm.cell_id||'').trim();
        if(!targetLib||!targetCell)throw Error('请选择目标电路库并填写新单元 ID。');
      }else if(mode==='create_view'){
        targetLib=String(crudForm.library_id||'').trim();
        targetCell=String(crudForm.cell_id||'').trim();
        targetView=String(crudForm.view_id||'').trim();
        buildCreateViewArgs({libraryId:targetLib,cellId:targetCell,viewId:targetView,baseCommit:'0'.repeat(40),label:crudForm.label,filename:crudForm.filename,level:crudForm.level});
      }
      crudBusy=true;render();
      const freshCat=await bridge.request('catalog',{});
      const baseCommit=freshCat?.base_commit;
      if(!baseCommit)throw Error('未能获取当前 Git 基线提交，请刷新目录后重试。');
      if(mode==='create_library'){
        args={library_id:targetLib,name:String(crudForm.name||'').trim()||targetLib,description:String(crudForm.description||'').trim(),base_commit:baseCommit};
      }else if(mode==='create_cell'){
        args={library_id:targetLib,cell_id:targetCell,kind:crudForm.kind||'circuit',base_commit:baseCommit};
        const nm=String(crudForm.name||'').trim(),desc=String(crudForm.description||'').trim();
        if(nm)args.name=nm;
        if(desc)args.description=desc;
      }else if(mode==='clone_cell'){
        args={source_library_id:crudForm.source_library_id,source_cell_id:crudForm.source_cell_id,library_id:targetLib,cell_id:targetCell,base_commit:baseCommit};
        const nm=String(crudForm.name||'').trim();
        if(nm)args.name=nm;
      }else if(mode==='create_view'){
        args=buildCreateViewArgs({libraryId:targetLib,cellId:targetCell,viewId:targetView,baseCommit,label:crudForm.label,filename:crudForm.filename,level:crudForm.level});
      }
      const key='lm-'+operation+'-'+(globalThis.crypto?.randomUUID?.()||(Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10)));
      const result=await bridge.request('execute',{operation,args,idempotency_key:key});
      crudMode=null;crudError='';crudBusy=false;
      await load({force:true});
      selected={library:targetLib||selected.library,cell:targetCell||null,view:targetView||null};
      render();
      onMutated?.({operation,result,args});
      const msg=operation==='create_library'?`已创建电路库 ${targetLib}。`:operation==='create_cell'?`已在 ${targetLib} 创建单元 ${targetCell}。`:operation==='clone_cell'?`已克隆单元到 ${targetLib}/${targetCell}。`:`已在 ${targetLib}/${targetCell} 创建视图 ${targetView}。`;
      notify(msg);
      if(autoOpen&&operation!=='create_library'){
        const opened=selection();
        if(opened.view)await openValue(opened,{closeDialog:true});
      }
    }catch(error){
      crudError=error?.message||String(error);
      notify(crudError,{kind:'error'});
    }finally{
      crudBusy=false;
      if(!disposed)render();
    }
  }
  function render(){
    const archivedCount=data.filter(isArchivedLibrary).length;
    archiveLabel.hidden=archivedCount===0;
    if(archivedCount>0)archiveLabel.lastChild.textContent=`显示历史研究归档 (${archivedCount})`;
    const baseLibs=visibleLibraries(data,{includeArchived:archiveToggle.checked||Boolean(search.value.trim())});
    const filtered=filterLibraries(baseLibs,search.value);options(libraries,filtered,selected.library,formatLibraryName);const library=filtered.find(x=>x.id===libraries.value);
    const hierarchy=populateCells(library,selected.cell);const cell=library?.cells.find(x=>x.id===cells.value);const cellViews=displayViewsForCell(cell,{library,libraries:data});options(views,cellViews,selected.view,formatViewLabel);
    selected={library:libraries.value,cell:cells.value,view:views.value};const exact=selection();
    renderCrud(exact);
    const canonicalView=exact.view?.backingViewId?exact.cell?.views.find(v=>v.id===exact.view.backingViewId)||exact.view:exact.view;
    const nextKey=JSON.stringify([exact.library?.id,exact.cell?.id,canonicalView?.id]);if(nextKey!==selectionKey){selectionKey=nextKey;onSelection(canonicalView?{library:exact.library,cell:exact.cell,view:canonicalView}:null);}
    crumb.textContent=exact.cell?[formatLibraryName(exact.library),exact.cell.name,exact.view?formatViewLabel(exact.view):''].filter(Boolean).join(' / '):loaded?'没有匹配的单元':'按项目、顶层与视图浏览';
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
    openTop.disabled=busy||loading||crudBusy||!topRnl;
    openTop.textContent=topCell?`打开项目顶层 (${topCell.name})`:'打开项目顶层';
    open.textContent=busy?'正在打开…':exact.view?.id==='veriloga'?'打开 Verilog-A 代码':exact.view?.id==='symbol'?'打开符号视图':exact.view?.kind==='rnl'?'打开原理图':'查看文件';open.disabled=busy||loading||crudBusy||!exact.view;
    refresh.disabled=reference.disabled=search.disabled=archiveToggle.disabled=busy||loading||crudBusy;close.disabled=busy||crudBusy;
    const hiddenArchiveNote=archivedCount>0&&!archiveToggle.checked&&!search.value.trim()?`（已隐藏 ${archivedCount} 个历史研究归档库）`:'';
    if(!busy&&!loading&&loaded)status.textContent=`${filtered.length} 个项目 · ${filtered.reduce((n,l)=>n+l.cells.length,0)} 个单元${hiddenArchiveNote}${usingLiveCatalog?' · 本机实时目录':''}`+(errors.length?` · ${errors.length} 个库读取失败：${errors.map(x=>x.name+'：'+x.message).join('；')}`:'');
  }
  async function load({force=false}={}){
    if(busy||disposed||(loading&&!force))return;hidePreview();request?.abort();request=new AbortController();loading=true;status.textContent=bridgeConnected()?'读取本机电路库目录…':'读取已发布的库目录…';render();
    try{
      if(bridgeConnected()){
        const [cap,liveCat]=await Promise.all([bridge.request('capability',{}),bridge.request('catalog',{})]);
        if(disposed||request.signal.aborted)return;
        const normalized=normalizeLiveCatalog(liveCat,publishedFallback||(usingLiveCatalog?[]:data));
        data=normalized.libraries;errors=[];loaded=true;usingLiveCatalog=true;liveBaseCommit=normalized.baseCommit;liveCapabilities=cap;
      }else{
        const result=await client.load({signal:request.signal});
        if(disposed||request.signal.aborted)return;
        data=result.libraries;errors=result.errors;loaded=true;usingLiveCatalog=false;liveBaseCommit=null;liveCapabilities=null;publishedFallback=result.libraries;
      }
    }
    catch(error){if(!disposed&&!request.signal.aborted){data=[];loaded=false;usingLiveCatalog=false;liveBaseCommit=null;liveCapabilities=null;status.textContent='库目录暂不可用：'+error.message+' RC 参考仍可使用。';}}
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
    try{const bundle=await loadViewForValue(value,{...value.view,entry:path},{signal:current.signal});if(disposed||current.signal.aborted||previewRequest!==current||previewValue!==value)return;previewText.textContent=bundle.text;preview.hidden=false;status.textContent='已读取 '+path;}
    catch(error){if(disposed||current.signal.aborted||previewRequest!==current||previewValue!==value)return;previewText.textContent='打开失败：'+error.message;preview.hidden=false;status.textContent=previewText.textContent;notify(previewText.textContent,{kind:'error'});}
    finally{if(previewRequest===current)previewRequest=null;}
  }
  previewFile.onchange=()=>{if(previewValue)void loadPreview(previewValue,previewFile.value);};
  async function openValue(value,{closeDialog=true}={}){
    if(busy||loading||crudBusy||!value?.view)return false;hidePreview();
    const openMeta={origin:usingLiveCatalog?'working':'published',base_commit:liveBaseCommit};
    if((value.view.id==='veriloga'||value.view.kind==='veriloga')&&typeof onOpenVerilogA==='function'){
      request?.abort();request=new AbortController();busy=true;status.textContent=`读取 Verilog-A 模型 ${value.view.entry.split('/').pop()}…`;render();
      let errorText='',result=false;
      try{
        const entryBundle=await loadViewForValue(value,{...value.view,entry:value.view.entry},{signal:request.signal});
        if(disposed||request.signal.aborted)return false;
        const siblings=value.view.files.map(path=>({
          path,
          moduleName:verilogaModuleBasename(path),
          libraryId:value.view.sourceLibraryId||value.library.id,
          libraryName:value.library.name,
          text:path===value.view.entry?entryBundle.text:null,
        }));
        if(closeDialog&&dialog.open)dialog.close();
        const opened=await onOpenVerilogA({...value,...openMeta,path:value.view.entry,text:entryBundle.text,siblings,client});
        if(opened!==false){result=true;notify(`已打开 Verilog-A 模型 ${verilogaModuleBasename(value.view.entry)}。`);}
      }catch(error){if(!disposed){errorText='打开 Verilog-A 失败：'+error.message;notify(errorText,{kind:'error'});}}
      finally{busy=false;if(!disposed){render();if(errorText&&closeDialog){status.textContent=errorText;if(!dialog.open)dialog.showModal();}}}
      return result;
    }
    if(value.view.kind!=='rnl'){previewValue=value;previewFile.replaceChildren(...value.view.files.map(path=>new Option(path,path)));previewFile.value=value.view.entry;void loadPreview(value,value.view.entry);return false;}
    request?.abort();request=new AbortController();busy=true;status.textContent=`读取 ${value.view.files.length} 个已列出的文件…`;render();
    let errorText='',result=false;
    try{const bundle=await loadViewForValue(value,value.view,{signal:request.signal});if(disposed||request.signal.aborted)return false;
      if(closeDialog&&dialog.open)dialog.close();
      const opened=await onOpen({...value,...openMeta,bundle});
      if(opened!==false){result=true;notify(value.view.virtualSymbol?('已打开 '+value.cell.name+' 的符号视图（左侧「符号」面板可查看 SVG、引脚坐标与定义源码）。'):('已打开项目 '+formatLibraryName(value.library)+' · '+value.cell.name+'；可在原理图内双击下钻子模块。'));}
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
  async function openReference(){if(busy||loading||crudBusy)return;hidePreview();busy=true;render();dialog.close();try{await onReference();}catch(error){notify(error.message,{kind:'error'});}finally{busy=false;render();}}
  function show(){if(disposed)return;if(!dialog.open)dialog.showModal();search.focus();if(!loaded||(bridgeConnected()&&!usingLiveCatalog))void load();}
  const offBridge=bridge?.subscribe?.(()=>{if(disposed)return;loaded=false;if(dialog.open)void load({force:true});else render();});
  const offMutation=bridge?.subscribeMutation?.(event=>{
    if(disposed||crudBusy)return;
    if(['create_library','create_cell','clone_cell','create_view','create_branch','switch_branch','restore'].includes(event?.operation)){
      loaded=false;if(dialog.open)void load({force:true});
    }
  });
  search.oninput=()=>{hidePreview();render();};
  archiveToggle.onchange=()=>{selected={library:null,cell:null,view:null};hidePreview();render();};
  libraries.onchange=()=>{selected={library:libraries.value,cell:null,view:null};hidePreview();render();};
  cells.onchange=()=>{selected.cell=cells.value;selected.view=null;hidePreview();render();};views.onchange=()=>{selected.view=views.value;hidePreview();render();};
  views.ondblclick=()=>void openSelected();views.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void openSelected();}};
  dialog.addEventListener('keydown',event=>event.stopPropagation());dialog.addEventListener('cancel',event=>{if(busy||crudBusy)event.preventDefault();});
  render();
  return {show,openProjectTop,ensureLoaded,getLibraries:()=>data,getClient:()=>client,destroy(){disposed=true;offBridge?.();offMutation?.();request?.abort();hidePreview();dialog.remove();launcher.remove();entry.remove();css.remove();}};
}
