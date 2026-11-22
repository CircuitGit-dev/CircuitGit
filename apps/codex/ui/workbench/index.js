import {emptyLayout,parseLayout,validateLayout,groups,visibleIds,activeIds,findGroup,addPanel,movePanel,closePanel,activatePanel,maximizePanel,resizeSplit,resetLayout} from './layout.js';

const labels={schematic:'原理图',waveforms:'波形',simulation:'仿真'};
const symbols={schematic:'◇',waveforms:'∿',simulation:'▤'};

export async function mount(root,host){
  if(!root||host?.initial?.kind!=='workbench'||!['call','openPanel','mountPanel','getPanel','assetText'].every(key=>typeof host[key]==='function'))throw Error('工作台需要有效的 workbench host。');
  const doc=root.ownerDocument,win=doc.defaultView,initial=host.initial,records=new Map();let layout=emptyLayout(),disposed=false,booting=true,actionBusy=false,focusedGroup=null;
  let saveTimer=null,savePromise=null,saveBlocked=false,changeVersion=0,savedVersion=0,frame=null,drag=null,resize=null,readFailed=false,shown=true;
  const make=(tag,cls,text)=>{const node=doc.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const button=(text,label,action)=>{const node=make('button','',text);node.type='button';node.setAttribute('aria-label',label||text);node.addEventListener('click',()=>{Promise.resolve().then(action).catch(fail);});return node;};
  const shell=make('section','ic-workbench'),toolbar=make('header','wb-toolbar'),brand=make('div','wb-brand'),dot=make('span','wb-brand-dot','◆'),title=make('strong','',initial.identity.project_id);
  brand.append(dot,title,make('span','wb-subtitle','工作台'));
  const menu=make('details','wb-view-menu'),menuTitle=make('summary','','视图'),menuBody=make('div','wb-menu-body');menu.append(menuTitle,menuBody);
  const openSchematic=button('原理图','打开原理图',()=>open('schematic'));
  const config=make('select'),run=make('select');config.setAttribute('aria-label','选择仿真配置');run.setAttribute('aria-label','选择已保存运行');
  config.append(new Option('选择配置…',''));run.append(new Option('选择运行…',''));
  const configLabel=make('label','wb-selector'),runLabel=make('label','wb-selector');configLabel.append(make('span','','配置'),config);runLabel.append(make('span','','运行'),run);
  const openSimulation=button('仿真','打开选定配置的仿真',()=>open('simulation',{configuration:config.value}));
  const openWaveform=button('波形','打开选定运行的波形',()=>open('waveforms',{run_id:run.value}));
  const reset=button('重置布局','恢复默认工作台布局',()=>resetAll()),fullscreen=button('全屏','请求宿主全屏',async()=>{const reply=await host.requestDisplayMode('fullscreen');if(reply?.supported===false)fail(Error('宿主未提供全屏模式。'));});
  toolbar.append(brand,menu,openSchematic,configLabel,openSimulation,runLabel,openWaveform,reset,fullscreen);
  const notice=make('div','wb-notice'),noticeText=make('span'),retry=button('重试保存','重试保存布局',()=>flush(true)),reload=button('重新读取','重新读取工作台',()=>initialize());notice.setAttribute('role','status');notice.hidden=true;notice.append(noticeText,retry,reload);retry.hidden=reload.hidden=true;
  const stage=make('div','wb-stage'),treeRoot=make('div','wb-layout'),layer=make('div','wb-panel-layer'),empty=make('div','wb-empty'),preview=make('div','wb-drop-preview');preview.hidden=true;
  stage.append(treeRoot,layer,empty,preview);const footer=make('footer','wb-footer'),hint=make('span','','拖动标签到边缘分屏，放到中间合并；双击标签最大化'),saveState=make('span','wb-save-state','读取布局…');footer.append(hint,saveState);shell.append(toolbar,notice,stage,footer);root.append(shell);
  const style=make('style');style.textContent=await host.assetText('apps/codex/ui/workbench/style.css');root.prepend(style);
  const abort=new AbortController(),observer=new ResizeObserver(()=>scheduleGeometry());observer.observe(stage);
  function parentArgs(){const view=host.view||host.initial;return {workspace_id:initial.workspace_id,view_id:initial.view_id,expected_revision:view.revision};}
  async function data(kind){const args=parentArgs();const result=await host.call('ic_view_data',{workspace_id:args.workspace_id,view_id:args.view_id,revision:args.expected_revision,query:{kind}});return result?.payload??result;}
  function fail(error){if(disposed)return;notice.hidden=false;notice.dataset.kind='error';noticeText.textContent=error.message||String(error);reload.hidden=!readFailed;controls();}
  function clearError(){notice.hidden=true;noticeText.textContent='';}
  function controls(){
    const blocked=booting||actionBusy||readFailed;
    openSchematic.disabled=blocked;openSimulation.disabled=blocked||!config.value;openWaveform.disabled=blocked||!run.value;config.disabled=run.disabled=blocked;
    reset.disabled=blocked||!layout.panels.length;fullscreen.disabled=typeof host.requestDisplayMode!=='function';
    retry.hidden=!saveBlocked;retry.disabled=!!savePromise;saveState.textContent=booting?'读取布局…':saveBlocked?'布局未保存':savePromise?'保存布局…':savedVersion<changeVersion?'布局待保存':'布局已保存';
  }
  function dirty(){changeVersion++;if(!saveBlocked){clearTimeout(saveTimer);saveTimer=setTimeout(()=>void flush().catch(()=>{}),220);}controls();}
  async function flush(explicit=false){
    clearTimeout(saveTimer);saveTimer=null;if(disposed||booting||(!explicit&&saveBlocked))return;
    if(savePromise){await savePromise;return;}
    if(explicit)saveBlocked=false;
    savePromise=(async()=>{
      while(!disposed&&savedVersion<changeVersion){
        const ticket=changeVersion,text=JSON.stringify(validateLayout(layout));
        try{await host.call('ic_workbench_layout',{...parentArgs(),text});savedVersion=ticket;}
        catch(error){saveBlocked=true;fail(Error('布局保存失败，当前排列仍保留：'+(error.message||error)));throw error;}
      }
      if(!saveBlocked&&noticeText.textContent.startsWith('布局保存失败'))clearError();
    })();controls();
    try{await savePromise;}finally{savePromise=null;controls();}
  }
  function apply(next,{persist=true}={}){layout=validateLayout(next);render();if(persist)dirty();}
  function panelInfo(view){
    if(view?.schema!=='ic.view.v1'||!labels[view.kind]||view.workspace_id!==initial.workspace_id||view.identity?.project_id!==initial.identity.project_id||typeof view.view_id!=='string')throw Error('面板不属于当前工作区或工程。');
    return {id:view.view_id,kind:view.kind,title:labels[view.kind]+(view.kind==='simulation'?' · '+view.identity.configuration:view.kind==='waveforms'?' · '+view.identity.run_id:'')};
  }
  function recordFor(panel){
    if(!records.has(panel.id)){
      const container=make('section','wb-panel');container.dataset.panelId=panel.id;container.setAttribute('aria-label',panel.title);container.hidden=true;container.inert=true;layer.append(container);
      const record={panel,container,handle:null,mounting:null,closing:false,visible:false,rect:null,error:null};
      container.addEventListener('pointerdown',()=>{focusedGroup=findGroup(layout,panel.id)?.id||null;});records.set(panel.id,record);
    }
    return records.get(panel.id);
  }
  async function ensurePanel(panel,descriptor=null){
    const record=recordFor(panel);if(record.handle)return record;if(record.mounting)return record.mounting;
    record.mounting=(async()=>{
      record.container.replaceChildren(make('p','wb-panel-loading','正在读取'+labels[panel.kind]+'…'));record.error=null;
      try{
        const view=descriptor||await host.getPanel(panel.id),identity=panelInfo(view);if(identity.id!==panel.id||identity.kind!==panel.kind)throw Error('恢复面板的 view 身份不一致。');
        record.container.replaceChildren();const handle=await host.mountPanel(record.container,view);
        if(!handle||typeof handle.dispose!=='function')throw Error('面板缺少 dispose 生命周期。');
        if(disposed){await handle.dispose();return record;}record.handle=handle;record.visible=null;scheduleGeometry();
      }catch(error){
        if(!disposed){record.error=error;record.container.replaceChildren(make('p','wb-panel-error',error.message||String(error)),button('重新加载面板','重新加载 '+panel.title,async()=>{await ensurePanel(panel);}));fail(error);}
      }finally{record.mounting=null;}
      return record;
    })();return record.mounting;
  }
  async function open(kind,args={}){
    if(actionBusy||booting||readFailed)return;
    if(kind==='simulation'&&!args.configuration)throw Error('请选择具体仿真配置。');if(kind==='waveforms'&&!args.run_id)throw Error('请选择具体的已保存运行。');
    if(kind==='schematic'){const known=layout.panels.find(panel=>panel.kind==='schematic');if(known){await reopen(known.id);return;}}
    if(layout.panels.length>=16)throw Error('当前工作台已登记 16 个面板，请恢复已有面板。');
    actionBusy=true;controls();
    try{
      const view=await host.openPanel(kind,args);if(disposed)return;const panel=panelInfo(view);
      const similar=layout.panels.find(item=>item.kind===kind&&visibleIds(layout).includes(item.id)),sameKind=similar&&findGroup(layout,similar.id);
      const target=sameKind||groups(layout.tree).find(group=>group.id===focusedGroup)||groups(layout.tree).at(-1);
      apply(addPanel(layout,panel,{groupId:target?.id,edge:target&&!sameKind?'right':'center'}));await ensurePanel(panel,view);
    }finally{actionBusy=false;controls();}
  }
  async function reopen(panelId){
    const panel=layout.panels.find(panel=>panel.id===panelId);if(!panel)throw Error('未登记此面板。');
    if(records.get(panelId)?.closing)return;
    if(visibleIds(layout).includes(panelId)){apply(activatePanel(layout,panelId));return;}
    apply(addPanel(layout,panel));await ensurePanel(panel);
  }
  async function close(panelId){
    const record=records.get(panelId);if(!record||record.closing)return;
    record.closing=true;render();
    try{
      if(record.mounting)await record.mounting;
      await record.handle?.beforeClose?.();if(disposed)return;
      // beforeClose persists the exact child snapshot; failure leaves the panel mounted/open.
      const next=closePanel(layout,panelId);record.handle?.setVisible?.(false);await record.handle?.dispose();record.handle=null;record.visible=false;record.rect=null;record.container.replaceChildren();apply(next);
    }catch(error){fail(Error('关闭失败，面板仍保留：'+(error.message||error)));}
    finally{record.closing=false;if(!disposed)render();}
  }
  async function resetAll(){
    if(actionBusy||booting)return;actionBusy=true;controls();
    try{apply(resetLayout(layout));for(const panel of layout.panels){if(disposed)return;await ensurePanel(panel);}}finally{actionBusy=false;controls();}
  }
  function renderMenu(){
    menuBody.replaceChildren(make('strong','wb-menu-caption','已登记视图'));
    const visible=new Set(visibleIds(layout));
    for(const panel of layout.panels){const entry=button((visible.has(panel.id)?'✓ ':'↶ ')+panel.title,(visible.has(panel.id)?'聚焦 ':'恢复 ')+panel.title,async()=>{menu.open=false;await reopen(panel.id);});entry.title=panel.id;menuBody.append(entry);}
    if(!layout.panels.length)menuBody.append(make('p','','尚无面板'));
  }
  function render(){
    if(disposed)return;observer.disconnect();observer.observe(stage);treeRoot.replaceChildren();renderMenu();
    const drawn=layout.maximized?{...findGroup(layout,layout.maximized),active:layout.maximized}:layout.tree;
    function nodeView(node){
      if(node.type==='split'){
        const box=make('div','wb-split wb-'+node.axis);box.dataset.splitId=node.id;box.style.setProperty('--wb-ratio',node.ratio);
        const first=make('div','wb-split-first'),second=make('div','wb-split-second'),divider=make('div','wb-divider');first.append(nodeView(node.first));second.append(nodeView(node.second));
        divider.tabIndex=0;divider.setAttribute('role','separator');divider.setAttribute('aria-label',node.axis==='horizontal'?'调整左右分屏':'调整上下分屏');divider.setAttribute('aria-orientation',node.axis==='horizontal'?'vertical':'horizontal');divider.setAttribute('aria-valuemin','15');divider.setAttribute('aria-valuemax','85');divider.setAttribute('aria-valuenow',String(Math.round(node.ratio*100)));
        divider.addEventListener('pointerdown',event=>beginResize(event,node,box,divider));divider.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();event.stopPropagation();apply(resizeSplit(layout,node.id,event.key==='Home'?.5:node.ratio+(['ArrowRight','ArrowDown'].includes(event.key)?.025:-.025)));});box.append(first,divider,second);return box;
      }
      const group=make('section','wb-group');group.dataset.groupId=node.id;
      const head=make('header','wb-group-header'),tabs=make('div','wb-tabs'),tools=make('div','wb-group-tools');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','工作台视图标签');
      for(const panelId of node.tabs){
        const panel=layout.panels.find(panel=>panel.id===panelId),tab=button('',panel.title,()=>{focusedGroup=node.id;if(node.active!==panelId)apply(activatePanel(layout,panelId));});tab.className='wb-tab';tab.dataset.tabId=panelId;tab.title=panel.title+'\n'+panelId;tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(node.active===panelId));tab.tabIndex=node.active===panelId?0:-1;tab.append(make('span','wb-tab-icon',symbols[panel.kind]),make('span','wb-tab-title',panel.title));
        if(records.get(panelId)?.closing){tab.disabled=true;tab.append(make('span','wb-saving-dot','…'));}
        tab.addEventListener('pointerdown',event=>beginDrag(event,panelId,tab));tab.addEventListener('dblclick',()=>apply(maximizePanel(layout,panelId)));
        tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();const at=node.tabs.indexOf(panelId),next=event.key==='Home'?0:event.key==='End'?node.tabs.length-1:(at+(event.key==='ArrowRight'?1:-1)+node.tabs.length)%node.tabs.length;apply(activatePanel(layout,node.tabs[next]));treeRoot.querySelectorAll('[data-tab-id]').forEach(item=>{if(item.dataset.tabId===node.tabs[next])item.focus();});});tabs.append(tab);
      }
      const active=layout.panels.find(panel=>panel.id===node.active),maximize=button(layout.maximized?'▣':'□',layout.maximized?'还原面板':'最大化 '+active.title,()=>apply(maximizePanel(layout,node.active))),closeButton=button('×','关闭 '+active.title,()=>close(node.active));closeButton.disabled=!!records.get(node.active)?.closing;tools.append(maximize,closeButton);head.append(tabs,tools);
      const slot=make('div','wb-body-slot');slot.dataset.activeId=node.active;group.append(head,slot);observer.observe(slot);return group;
    }
    if(drawn)treeRoot.append(nodeView(drawn));
    empty.hidden=!!layout.tree;empty.replaceChildren();
    if(!layout.tree){empty.append(make('div','wb-empty-icon','▦'),make('h2','','工作台已清空'),make('p','','恢复已关闭的视图，或从工具栏打开原理图、仿真与已保存波形。'));const choices=make('div','wb-empty-actions');for(const panel of layout.panels)choices.append(button('恢复 '+panel.title,'恢复 '+panel.title,()=>reopen(panel.id)));if(!layout.panels.length&&!booting&&!readFailed)choices.append(button('打开原理图','打开原理图',()=>open('schematic')));empty.append(choices);}
    controls();scheduleGeometry();
  }
  function scheduleGeometry(){if(!disposed&&frame===null)frame=win.requestAnimationFrame(()=>{frame=null;geometry();});}
  function geometry(){
    if(disposed)return;const bounds=stage.getBoundingClientRect(),active=new Set(activeIds(layout)),slots=new Map([...treeRoot.querySelectorAll('.wb-body-slot')].map(node=>[node.dataset.activeId,node]));
    for(const [panelId,record] of records){
      const slot=slots.get(panelId),visible=shown&&active.has(panelId)&&!!slot;record.container.hidden=!visible;record.container.inert=!visible;
      if(record.handle&&record.visible!==visible){record.visible=visible;try{record.handle.setVisible?.(visible);}catch(error){fail(error);}}
      if(!visible)continue;const rect=slot.getBoundingClientRect(),size=[rect.left-bounds.left,rect.top-bounds.top,rect.width,rect.height];
      Object.assign(record.container.style,{left:size[0]+'px',top:size[1]+'px',width:size[2]+'px',height:size[3]+'px'});
      const key=size.join(':');if(key!==record.rect){record.rect=key;try{record.handle?.resize?.();}catch(error){fail(error);}}
    }
  }
  function beginResize(event,node,box,divider){
    if(event.button!==0||drag||resize)return;event.preventDefault();divider.setPointerCapture?.(event.pointerId);const bounds=box.getBoundingClientRect();resize={nodeId:node.id,axis:node.axis,box,divider,bounds,pointerId:event.pointerId,ratio:node.ratio,original:node.ratio};shell.classList.add('wb-resizing');
  }
  function beginDrag(event,panelId,tab){if(event.button!==0||records.get(panelId)?.closing||resize)return;drag={panelId,tab,x:event.clientX,y:event.clientY,pointerId:event.pointerId,active:false,target:null};}
  function dragTarget(x,y){
    const element=doc.elementFromPoint(x,y),group=element?.closest('.wb-group');if(!group||!treeRoot.contains(group))return null;
    const rect=group.getBoundingClientRect(),rx=(x-rect.left)/rect.width,ry=(y-rect.top)/rect.height;
    const tab=element.closest('[data-tab-id]');let edge='center';
    if(!element.closest('.wb-group-header')){const distance=Math.min(rx,1-rx,ry,1-ry);if(distance<.24)edge=distance===rx?'left':distance===1-rx?'right':distance===ry?'top':'bottom';}
    return {groupId:group.dataset.groupId,edge,beforeId:tab?.dataset.tabId||null,rect};
  }
  function pointerMove(event){
    if(resize&&event.pointerId===resize.pointerId){event.preventDefault();const r=resize,raw=r.axis==='horizontal'?(event.clientX-r.bounds.left)/r.bounds.width:(event.clientY-r.bounds.top)/r.bounds.height;r.ratio=Math.max(.15,Math.min(.85,raw));layout=resizeSplit(layout,r.nodeId,r.ratio);r.box.style.setProperty('--wb-ratio',r.ratio);r.divider.setAttribute('aria-valuenow',String(Math.round(r.ratio*100)));scheduleGeometry();return;}
    if(!drag||event.pointerId!==drag.pointerId)return;
    if(!drag.active&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<5)return;
    if(!drag.active){drag.active=true;shell.classList.add('wb-dragging');}
    event.preventDefault();drag.target=dragTarget(event.clientX,event.clientY);preview.hidden=!drag.target;
    if(drag.target){const {rect,edge}=drag.target,bounds=stage.getBoundingClientRect();let x=rect.left-bounds.left,y=rect.top-bounds.top,width=rect.width,height=rect.height;if(['left','right'].includes(edge)){width/=2;if(edge==='right')x+=width;}if(['top','bottom'].includes(edge)){height/=2;if(edge==='bottom')y+=height;}Object.assign(preview.style,{left:x+'px',top:y+'px',width:width+'px',height:height+'px'});preview.textContent=edge==='center'?'合并标签':({left:'向左分屏',right:'向右分屏',top:'向上分屏',bottom:'向下分屏'})[edge];}
  }
  function stopPointer(event,cancelled=false){
    if(resize&&event.pointerId===resize.pointerId){const target=resize;resize=null;shell.classList.remove('wb-resizing');if(cancelled)layout=resizeSplit(layout,target.nodeId,target.original);render();if(!cancelled)dirty();return;}
    if(!drag||event.pointerId!==drag.pointerId)return;const current=drag;drag=null;preview.hidden=true;shell.classList.remove('wb-dragging');
    if(current.active){suppressClick=true;win.setTimeout(()=>suppressClick=false,0);if(!cancelled&&current.target)try{apply(movePanel(layout,current.panelId,current.target.groupId,current.target.edge,current.target.beforeId));}catch(error){fail(error);}}
  }
  let suppressClick=false;shell.addEventListener('click',event=>{if(suppressClick){event.preventDefault();event.stopImmediatePropagation();}},true);
  doc.addEventListener('pointermove',pointerMove,{signal:abort.signal,passive:false});doc.addEventListener('pointerup',event=>stopPointer(event),{signal:abort.signal});doc.addEventListener('pointercancel',event=>stopPointer(event,true),{signal:abort.signal});
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'&&(drag||resize)){const pointerId=drag?.pointerId??resize.pointerId;stopPointer({pointerId},true);event.preventDefault();}}, {signal:abort.signal});
  config.onchange=run.onchange=controls;
  async function initialize(){
    if(disposed)return;booting=true;readFailed=false;clearError();controls();
    try{
      await host.call('ic_view_get',{workspace_id:initial.workspace_id,view_id:initial.view_id});if(disposed)return;
      const saved=await data('layout');if(disposed)return;
      if(saved?.text!==null&&typeof saved?.text!=='string')throw Error('工作台布局回执无效。');
      const known=new Map((saved.views||[]).map(view=>[view.view_id,view]));
      if(saved.text!==null){
        const restored=parseLayout(saved.text);
        for(const panel of restored.panels){const view=known.get(panel.id);if(!view||panelInfo(view).kind!==panel.kind)throw Error('保存的布局包含未知或不匹配的面板。');}
        apply(restored,{persist:false});for(const panel of restored.panels.filter(panel=>visibleIds(restored).includes(panel.id))){if(disposed)return;await ensurePanel(panel);}
      }
      else{
        // Only the root descriptor's explicit configuration/run authorize default extra panels.
        let next=emptyLayout();const defaults=[['schematic',{}]];
        if(initial.identity.configuration)defaults.push(['simulation',{configuration:initial.identity.configuration}]);
        if(initial.workbench_run_id)defaults.push(['waveforms',{run_id:initial.workbench_run_id}]);
        for(const [kind,args] of defaults){try{const view=await host.openPanel(kind,args);if(disposed)return;const panel=panelInfo(view);next=addPanel(next,panel);apply(resetLayout(next),{persist:false});await ensurePanel(panel,view);}catch(error){fail(error);}}
        apply(resetLayout(next),{persist:false});changeVersion++;
      }
      try{
        const project=await data('project'),active=project.projects?.find(project=>(project.id||project.project_id)===initial.identity.project_id);config.replaceChildren(new Option('选择配置…',''),...(active?.configurations||[]).map(configuration=>new Option(configuration.name||configuration.id,configuration.id)));if(initial.identity.configuration)config.value=initial.identity.configuration;
        const runs=await data('runs'),jobs=Array.isArray(runs)?runs:runs.jobs||[];run.replaceChildren(new Option('选择运行…',''),...jobs.map(job=>new Option((job.configuration||job.configuration_id||'运行')+' · '+(job.run_id||job.job_id),job.run_id||job.job_id)));if(initial.workbench_run_id)run.value=initial.workbench_run_id;
      }catch(error){fail(error);}
    }catch(error){readFailed=true;fail(Error('布局未能读取，未重置已有工作台：'+(error.message||error)));}
    finally{booting=false;controls();render();if(changeVersion>savedVersion&&!readFailed)dirty();}
  }
  render();await initialize();
  return {async beforeClose(){for(const record of records.values())if(record.handle)await record.handle.beforeClose?.();if(saveBlocked)throw Error('布局尚未保存，请先明确重试保存。');await flush();},setVisible(visible){shown=!!visible;shell.hidden=!shown;if(!shown){for(const record of records.values())if(record.handle){record.handle.setVisible?.(false);record.visible=false;}}else scheduleGeometry();},resize:scheduleGeometry,async dispose(){if(disposed)return;disposed=true;clearTimeout(saveTimer);if(frame!==null)win.cancelAnimationFrame(frame);abort.abort();observer.disconnect();for(const record of records.values()){if(record.mounting)await record.mounting;await record.handle?.dispose();}records.clear();shell.remove();style.remove();}};
}
