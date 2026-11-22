import {createDockview,themeLight} from '../../vendor/dockview/dockview.js';
import {remainingLayout,homeRelations,boundedFloat} from './homes.js';

const TITLES={schematic:'原理图',simulation:'仿真',waveforms:'波形',ai:'AI',versions:'版本管理'};
const KEY='ic-studio.dockview.v1';

/** The application owns component lifetime; Dockview owns only their placement. */
export async function mountDockview(ui){
  const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url);
  await new Promise((resolve,reject)=>{css.onload=resolve;css.onerror=()=>reject(Error('Dockview 样式加载失败'));document.head.append(css);});
  document.body.classList.add('ic-dockview');document.title='CircuitGit';
  const app=document.getElementById('app'),workspace=document.getElementById('studio-workspace');
  const parking=document.createElement('div');parking.hidden=true;parking.id='studio-parked';document.body.append(parking);
  const area=document.createElement('div');area.id='studio-dockview';area.setAttribute('aria-label','可排列工作台');workspace.before(area);
  const wave=document.createElement('div');wave.id='studio-waveforms-content';wave.className='studio-waveforms-content';
  const nodes={schematic:app,simulation:ui.slots.simulation.element,ai:ui.slots.ai.element,waveforms:wave,versions:ui.slots.versions.element};
  const roots={};
  for(const [id,node] of Object.entries(nodes)){const root=document.createElement('section');root.className='studio-panel studio-panel-'+id;root.dataset.studioPanel=id;root.setAttribute('aria-label',TITLES[id]);root.append(node);parking.append(root);roots[id]=root;}
  document.getElementById('studio-versions-dialog').remove();workspace.remove();document.getElementById('studio-ai').remove();document.getElementById('studio-ai-split').remove();
  let restoring=false,saveTimer,saveFailed=false;const homes=new Map(),floatPositions=new Map(),dragHomes=new Map();
  let resizeFrame=null,schematicSize='';
  const resize=()=>{if(resizeFrame!==null)return;resizeFrame=requestAnimationFrame(()=>{resizeFrame=null;
    // Plot-only changes and floating moves must not relayout the entire RNL shell.
    const key=app.clientWidth+':'+app.clientHeight;if(key===schematicSize||!app.clientWidth||!app.clientHeight)return;
    schematicSize=key;window.dispatchEvent(new Event('resize'));
  });};
  function visibility(id,shown){if(roots[id].hidden===!shown)return;roots[id].hidden=!shown;roots[id].inert=!shown;if(id==='schematic')resize();}
  const api=createDockview(area,{
    theme:themeLight,defaultRenderer:'always',singleTabMode:'default',floatingGroupBounds:'boundedWithinViewport',
    createComponent({id}){
      if(!roots[id])throw Error('Unknown Studio panel');
      const element=document.createElement('div');element.className='studio-panel-mount';element.append(roots[id]);visibility(id,true);
      let subscription;
      return {element,init(params){subscription=params.api.onDidVisibilityChange(event=>visibility(id,event.isVisible));},layout(){if(id==='schematic')resize();},
        dispose(){subscription?.dispose();visibility(id,false);parking.append(roots[id]);}};
    },
    createRightHeaderActionComponent(group){
      const element=document.createElement('div');element.className='studio-panel-actions';
      const action=(label,text,fn)=>{const button=document.createElement('button');button.type='button';button.title=label;button.setAttribute('aria-label',label);button.textContent=text;button.onclick=fn;element.append(button);return button;};
      const float=action('浮动当前面板','↗',()=>{
        if(group.api.location.type==='floating'){dockGroup(group);return;}
        const panel=group.activePanel;if(!panel)return;
        dragHomes.delete(panel.id);const home=rememberHome(group,[panel.id]);homes.set(panel.id,home);
        api.addFloatingGroup(panel,boundedFloat(floatPositions.get(panel.id),area.getBoundingClientRect()));
        home.remaining=remainingLayout(api.toJSON(),home.ids);save();
      });
      action('最大化或还原当前面板','□',()=>{const p=group.activePanel?.api;if(p)p.isMaximized()?p.exitMaximized():p.maximize();});
      const update=()=>{const floating=group.api.location.type==='floating',label=floating?'放回主布局':'浮动当前面板';float.title=label;float.setAttribute('aria-label',label);float.textContent=floating?'↙':'↗';};
      const subscription=group.api.onDidLocationChange(update);
      return {element,init:update,dispose(){subscription.dispose();}};
    },
    createWatermarkComponent(){const element=document.createElement('div');element.className='studio-dock-empty';element.textContent='工作台已清空';const button=document.createElement('button');button.textContent='恢复默认布局';button.onclick=resetLayout;element.append(button);return {element,init(){}};}
  });
  function groupBox(group){const r=group.element.getBoundingClientRect(),parent=area.getBoundingClientRect();return {x:r.x-parent.x,y:r.y-parent.y,width:r.width,height:r.height};}
  function rememberHome(group,ids){
    const groups=api.groups.map(g=>({ids:g.panels.map(p=>p.id),box:groupBox(g),location:g.api.location.type}));
    const origin=groups.find(g=>g.ids.includes(ids[0]));
    return {ids,before:api.toJSON(),relations:homeRelations(origin,groups,ids),box:origin.box,area:{width:area.clientWidth,height:area.clientHeight}};
  }
  // Native drag-to-float also records the docked location before Dockview moves it.
  api.onWillDragPanel(event=>{if(event.panel.api.location.type==='grid')dragHomes.set(event.panel.id,rememberHome(event.panel.group,[event.panel.id]));});
  api.onWillDragGroup(event=>{const group=event.group;if(group.api.location.type==='grid'){const ids=group.panels.map(p=>p.id),home=rememberHome(group,ids);for(const id of ids)dragHomes.set(id,home);}});
  api.onDidMovePanel(event=>{if(event.panel.api.location.type==='grid')dragHomes.delete(event.panel.id);});
  function dockGroup(group){
    if(group.api.location.type!=='floating')return;
    const current=api.toJSON(),memberIds=group.panels.map(p=>p.id),home=homes.get(memberIds[0]);
    const float=current.floatingGroups?.find(g=>g.data.views?.includes(memberIds[0]));
    if(float)for(const id of memberIds)floatPositions.set(id,float.position);
    const sameMembers=home?.ids?.length===memberIds.length&&home.ids.every(id=>memberIds.includes(id));
    if(sameMembers&&home.remaining===remainingLayout(current,memberIds)){
      // No unrelated layout edit: replay the exact grid, including split sizes and tab order.
      restoring=true;try{api.fromJSON(home.before);}finally{restoring=false;}
    }else{
      const relation=home?.relations?.find(r=>api.getPanel(r.id)?.api.location.type==='grid');
      const primary=api.getPanel('schematic'),target=relation?api.getPanel(relation.id).group:(primary?.api.location.type==='grid'?primary.group:api.groups.find(g=>g.api.location.type==='grid'));
      const position=relation?.position||(memberIds.includes('waveforms')?'bottom':'right');
      group.api.moveTo(target?{group:target,position,...(relation?.index!==undefined?{index:relation.index}:{})}:{position:'right'});
      const restored=api.getPanel(memberIds[0]);
      if(home?.box&&position!=='center'&&restored){
        const width=home.box.width*area.clientWidth/(home.area?.width||area.clientWidth),height=home.box.height*area.clientHeight/(home.area?.height||area.clientHeight);
        restored.api.setSize(position==='left'||position==='right'?{width}:{height});
      }
    }
    for(const id of memberIds)homes.delete(id);
    resize();save();
  }
  const open=id=>{let panel=api.getPanel(id);if(!panel)panel=api.addPanel({id,component:id,title:TITLES[id],renderer:'always',...(id==='versions'&&api.getPanel('simulation')?{position:{referencePanel:'simulation',direction:'within'}}:{})});panel.api.setActive();visibility(id,true);return panel;};
  function resetLayout(){restoring=true;homes.clear();dragHomes.clear();try{api.clear();const s=open('schematic');api.addPanel({id:'simulation',component:'simulation',title:TITLES.simulation,renderer:'always',position:{referencePanel:s,direction:'right'},initialWidth:340,minimumWidth:260});const w=api.addPanel({id:'waveforms',component:'waveforms',title:TITLES.waveforms,renderer:'always',position:{referencePanel:s,direction:'below'},initialHeight:300});api.addPanel({id:'ai',component:'ai',title:TITLES.ai,renderer:'always',position:{referencePanel:'simulation',direction:'below'},initialHeight:300,minimumWidth:260});api.layout(area.clientWidth,area.clientHeight);api.getPanel('simulation').api.setSize({width:Math.min(360,area.clientWidth*.28)});api.getPanel('waveforms').api.setSize({height:Math.round(area.clientHeight*.40)});api.getPanel('ai').api.setSize({height:Math.round(area.clientHeight*.40)});s.api.setActive();}finally{restoring=false;}save();resize();}
  function storedLayout(){return {schema:KEY,layout:api.toJSON(),homes:Object.fromEntries(homes),floatPositions:Object.fromEntries(floatPositions)};}
  function save(){if(restoring||saveFailed)return;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{try{localStorage.setItem(KEY,JSON.stringify(storedLayout()));}catch{saveFailed=true;ui.notify('布局无法保存；当前排列仍保留。',{kind:'warning'});}},180);}
  api.onDidLayoutChange(()=>{if(restoring)return;const layout=api.toJSON();for(const [id,home] of dragHomes){if(api.getPanel(id)?.api.location.type==='floating'){home.remaining=remainingLayout(layout,home.ids);for(const member of home.ids)homes.set(member,home);dragHomes.delete(id);}}save();});
  api.onDidRemovePanel(()=>queueMicrotask(()=>{for(const id of Object.keys(roots))if(!api.getPanel(id))visibility(id,false);}));
  for(const id of Object.keys(TITLES)){
    const slot=ui.slots[id]||{element:nodes[id],setBadge(){}};
    slot.setVisible=value=>{if(value)open(id);else api.getPanel(id)?.api.close();};
    slot.isVisible=()=>!!api.getPanel(id)?.api.isVisible;
    slot.toggle=()=>slot.isVisible()?slot.setVisible(false):slot.setVisible(true);
    ui.slots[id]=slot;
  }
  // Existing toolbar and Window commands retain the same component slots.
  for(const id of ['simulation','ai'])document.getElementById('studio-'+id+'-toggle').onclick=ui.slots[id].toggle;
  const toolbar=document.getElementById('studio-toolbar');
  toolbar.querySelector('.studio-brand').innerHTML='CircuitGit';
  const menu=document.createElement('details');menu.className='studio-view-menu';const summary=document.createElement('summary');summary.textContent='窗口';menu.append(summary);
  const choices=document.createElement('div');
  for(const id of Object.keys(TITLES)){const b=document.createElement('button');b.textContent=TITLES[id];b.type='button';b.onclick=()=>{open(id);menu.open=false;};choices.append(b);}
  const reset=document.createElement('button');reset.type='button';reset.textContent='恢复默认布局';reset.onclick=()=>{resetLayout();menu.open=false;};choices.append(reset);menu.append(choices);toolbar.append(menu);
  const dockAll=document.createElement('button');dockAll.type='button';dockAll.textContent='收回所有浮动面板';dockAll.onclick=()=>{const ids=api.groups.filter(g=>g.api.location.type==='floating').map(g=>g.panels[0]?.id);for(const id of ids){const group=api.getPanel(id)?.group;if(group)dockGroup(group);}menu.open=false;};choices.insertBefore(dockAll,reset);
  let restored=false;
  try{const raw=localStorage.getItem(KEY);if(raw){const stored=JSON.parse(raw);if(stored.schema!==KEY||!stored.layout||Object.keys(stored.layout.panels||{}).some(id=>!TITLES[id]))throw Error('未知布局格式');for(const [id,home] of Object.entries(stored.homes||{}))if(TITLES[id]&&home?.before&&Array.isArray(home.ids)&&Array.isArray(home.relations))homes.set(id,home);for(const [id,position] of Object.entries(stored.floatPositions||{}))if(TITLES[id])floatPositions.set(id,position);restoring=true;api.fromJSON(stored.layout);restoring=false;restored=true;}}
  catch(error){restoring=false;ui.notify('保存的布局不可用，已恢复默认布局：'+error.message,{kind:'warning'});}
  if(!restored)resetLayout();
  window.addEventListener('beforeunload',()=>{clearTimeout(saveTimer);try{localStorage.setItem(KEY,JSON.stringify(storedLayout()));}catch{}});
  // Read-only handle for integration checks and controlled Window actions.
  Object.defineProperty(window,'ICStudioDock',{value:Object.freeze({api,open,reset:resetLayout}),writable:false});
  return {...ui,resetLayout};
}
