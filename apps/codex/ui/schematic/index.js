import {descriptor,sameView,nativeModel,policy,dataCall,readClosure} from './data.js';
import {createRenderer} from './renderer.js';
import {selectionForHost} from './selection.js';

export async function mount(root,host){
  if(!host?.call||!host?.onResult||!host?.assetBytes||!host?.assetText)throw Error('Schematic requires the MCP view host and registered assets');
  const doc=root.ownerDocument;let visible=true,closing=false,pendingResult=null,localState=null;let view=descriptor(host.initial),model=null,entry=null,status=null,renderer=null,disposed=false,generation=0,binding=null,busy=false,rawSelection=null,serial=Promise.resolve();
  root.classList.add('ic-schematic');root.classList.toggle('embedded',host.embedded===true);
  const make=(tag,cls,text)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
  const controls=make('div','ic-schematic-controls'),filter=make('input'),entries=make('select'),refresh=make('button','','重新读取'),fullscreen=make('button','','全屏'),history=make('label'),check=make('input');
  filter.placeholder='筛选入口';filter.setAttribute('aria-label','筛选原图入口');entries.setAttribute('aria-label','原图入口');check.type='checkbox';history.append(check,doc.createTextNode('查看过期原图'));history.hidden=true;
  refresh.type=fullscreen.type='button';controls.append(filter,entries,refresh,fullscreen,history);
  const notice=make('div','ic-schematic-status','读取固定版本原图…'),canvas=make('div'),selectionBox=make('div','ic-schematic-selection'),selectionName=make('strong','','未选择对象'),terminal=make('select'),publish=make('button','','发送选择到工作区'),note=make('small'),identity=make('div','ic-schematic-identity');
  notice.setAttribute('role','status');terminal.setAttribute('aria-label','器件端口');terminal.hidden=true;publish.type='button';publish.disabled=true;selectionBox.append(selectionName,terminal,publish,note,identity);root.append(controls,notice,canvas,selectionBox);
  const style=make('style');style.dataset.icSchematicStyle='true';root.prepend(style);
  function identityText(){identity.textContent=`${view.identity.project_id} · source ${view.identity.source_commit.slice(0,12)} · run ${view.identity.run_id||'未绑定'} · view ${view.view_id} · r${view.revision}`;}
  function current(ticket){return !disposed&&generation===ticket;}
  function updateControls(){entries.disabled=filter.disabled=refresh.disabled=busy;publish.disabled=busy||!rawSelection||!status?.selectionEnabled;history.hidden=!status?.stale;canvas.hidden=!!status?.stale&&!check.checked;note.textContent=status?.snapshotOnly?'独立库快照：无 canonical 映射，选择仅作原图参考。':status?.stale?'电气源与原图不一致，选择与探针已禁用。':'原图只读；端口须明确选择。当前窗口没有已验证的仿真探针映射。';identityText();}
  function fail(error){if(disposed)return;busy=false;status=status?{...status,selectionEnabled:false}:null;notice.textContent=error.message||String(error);publish.disabled=true;updateControls();}
  function accept(next){next=descriptor(next);if(!sameView(view,next)||JSON.stringify(next.identity)!==JSON.stringify(view.identity)||next.revision<view.revision)throw Error('View result identity/revision mismatch');view=next;identityText();return view;}
  function receiveResult(next){try{if(disposed)return;if(next.revision>view.revision){generation++;busy=false;rawSelection=null;publish.disabled=true;}accept(next);}catch(error){fail(error);}}
  const unsubscribe=host.onResult(next=>{if(!visible||closing){pendingResult=next;return;}receiveResult(next);});
  function mutate(name,args){
    const operation=serial.then(async()=>{if(disposed)throw Error('Schematic disposed');const before=view;return accept(await host.call(name,{workspace_id:before.workspace_id,view_id:before.view_id,expected_revision:before.revision,...args}));});
    serial=operation.catch(()=>{});return operation;
  }
  function list(){const query=filter.value.trim().toLocaleLowerCase();entries.replaceChildren(...model.entries.filter(e=>(e.label+' '+e.id).toLocaleLowerCase().includes(query)).map(e=>new Option(e.label,e.id)));if(entry&&[...entries.options].some(o=>o.value===entry.id))entries.value=entry.id;}
  async function publishSelection(){
    if(busy||!rawSelection||!status?.selectionEnabled)return;
    const chosen=terminal.hidden||!terminal.value?null:terminal.value;
    const selected=selectionForHost(rawSelection,{model,entry,status,view},chosen);busy=true;updateControls();
    try{const updated=await mutate('ic_view_select',{selection:selected.selection});
      await host.updateModelContext({...selected.context,view_revision:updated.revision,workspace_revision:updated.workspace_revision,selection:updated.selection});
      notice.textContent='选择已保存到工作区；这是原图元数据，不代表仿真探针已验证。';
    }catch(error){fail(error);}finally{busy=false;updateControls();}
  }
  async function loadEntry(id){
    const selected=model.entries.find(e=>e.id===id);if(!selected)throw Error('Entry not in native catalog');
    const ticket=++generation,readView=structuredClone(view);entry=selected;status=policy(model,entry,view);rawSelection=null;terminal.hidden=true;selectionName.textContent='未选择对象';check.checked=false;busy=true;updateControls();
    try{
      notice.textContent='校验并读取原图文件…';
      const closure=await readClosure(host,readView,entry,{current:()=>current(ticket),progress:(done,total)=>{if(current(ticket))notice.textContent=`读取原图 ${done}/${total}`;}});
      if(!current(ticket))return;
      binding=crypto.randomUUID();await renderer.load({...closure,binding,root_entry:model.defaultEntry.entrypoint});
    }catch(error){if(current(ticket))fail(error);}finally{if(current(ticket)){busy=false;updateControls();}}
  }
  async function load(){
    const ticket=++generation;busy=true;updateControls();
    try{const latest=await host.call('ic_view_get',{workspace_id:view.workspace_id,view_id:view.view_id});if(!current(ticket))return;accept(latest);
      const payload=await dataCall(host,view,{kind:'schematic'});if(!current(ticket))return;model=nativeModel(payload,view);entry=model.entries.find(e=>e.id===(entry?.id||localState?.entry))||model.defaultEntry;list();await loadEntry(entry.id);
      if(localState){if(localState.renderer)renderer.restore(localState.renderer);filter.value=localState.filter||'';list();check.checked=localState.showHistorical===true;updateControls();localState=null;}
    }catch(error){if(current(ticket))fail(error);}
  }
  function rendererEvent(event){
    if(disposed||event.binding!==binding)return;
    if(event.type==='error'){fail(Error(event.message));return;}
    if(event.type==='selection'){
      rawSelection=event.selection;selectionName.textContent=rawSelection.kind+' · '+rawSelection.name;
      terminal.replaceChildren(new Option('整个器件（未指定端口）',''),...rawSelection.terminals.map(t=>new Option(t,t)));terminal.hidden=rawSelection.terminals.length===0;
      updateControls();
    }else if(event.type==='level'){rawSelection=null;selectionName.textContent='未选择对象';terminal.hidden=true;updateControls();}
    else if(event.type==='loaded'){
      const s=event.summary;notice.textContent=`原图已读取 · ${model.entries.length} 个入口 · 当前 ${s.instances} 器件 / ${s.levels} 层级${s.unplaced?' · '+s.unplaced+' 个未绘制对象':''}${s.warnings?' · '+s.warnings+' 条渲染警告':''}。未重新布局。`;
      void mutate('ic_view_state',{client_state:'loaded',message:'Client rendered pinned native RNL; visible host mount is not asserted'}).catch(fail);
    }
  }
  filter.oninput=()=>{if(model)list();};entries.onchange=()=>void loadEntry(entries.value).catch(fail);refresh.onclick=()=>void load();publish.onclick=()=>void publishSelection();check.onchange=updateControls;
  fullscreen.onclick=async()=>{try{const result=await host.requestDisplayMode('fullscreen');notice.textContent='宿主返回显示模式：'+(typeof result==='string'?result:JSON.stringify(result));}catch(error){notice.textContent=error.message;}};
  const dispose=()=>{if(disposed)return;disposed=true;generation++;unsubscribe?.();renderer?.dispose();root.replaceChildren();root.classList.remove('ic-schematic','embedded');};
  function localBinding(){return {workspace_id:view.workspace_id,view_id:view.view_id,identity:view.identity};}
  async function beforeClose(){
    if(disposed)return;closing=true;
    try{await serial;if(typeof host.saveLocalState!=='function')throw Error('宿主尚未提供原图视图保存；请保持面板打开。');
      await host.saveLocalState({schema:'ic.schematic.local.v1',binding:localBinding(),entry:entry?.id||null,renderer:renderer?.snapshot()||null,filter:filter.value,showHistorical:check.checked});
    }catch(error){closing=false;notice.textContent=error.message;throw error;}
  }
  function setVisible(value){if(disposed)return;visible=value===true;root.inert=!visible;renderer?.setVisible(visible);
    if(visible&&pendingResult){const next=pendingResult;pendingResult=null;receiveResult(next);}if(visible)renderer?.resize();}
  function resize(){if(!disposed&&visible)renderer?.resize();}
  if(host.embedded){fullscreen.hidden=true;const diagnostics=make('details','ic-schematic-diagnostics');diagnostics.append(make('summary','','原图身份与限制'),note,identity);selectionBox.append(diagnostics);}
  try{
    localState=await host.loadLocalState?.()||null;
    if(localState&&(localState.schema!=='ic.schematic.local.v1'||JSON.stringify(localState.binding)!==JSON.stringify(localBinding())))throw Error('原图恢复状态与当前固定源不一致。');
    style.textContent=await host.assetText('apps/codex/ui/schematic/style.css');
    const wasm=await host.assetBytes('apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm');
    if(disposed)return {beforeClose,setVisible,resize,dispose};renderer=createRenderer(canvas,{wasm,onEvent:rendererEvent});await load();
  }catch(error){fail(error);}
  return {beforeClose,setVisible,resize,dispose};
}
