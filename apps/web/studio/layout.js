import {stylesheet} from './styles.js';

const TITLES={simulation:'仿真',ai:'AI',versions:'版本管理',waveforms:'波形'};
const node=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e;};
let pending;

export function createLayout(){
  return pending ||= buildLayout();
}
async function buildLayout(){
  const docked=new URLSearchParams(location.search).get('layout')==='dockview'||document.body.classList.contains('workbench-entry');
  // Start the Dockview download alongside CSS, without constructing an intermediate layout.
  const dock=docked?import('./dockview/layout.js'):null;
  await stylesheet('./style.css');
  const ui=createChrome();
  if(docked)return (await dock).mountDockview(ui);
  return mountLegacy(ui);
}

function createChrome(){
  document.body.classList.add('ic-studio');document.title='CircuitGit';
  const toolbar=node('header','studio-toolbar');toolbar.id='studio-toolbar';
  toolbar.innerHTML='<strong class="studio-brand">CircuitGit</strong><label>项目 <select id="studio-project" aria-label="项目" disabled></select></label><label class="studio-entry-label">原生入口 <select id="studio-entry" aria-label="原生入口" disabled></select></label><label>运行 <select id="studio-run" aria-label="已保存运行" disabled><option value="">未选择运行</option></select></label><span id="studio-identity"></span><button id="studio-simulation-toggle" type="button">仿真</button><button id="studio-ai-toggle" type="button">AI</button>';
  document.getElementById('menubar').after(toolbar);
  const slots={};
  for(const [id,title] of Object.entries(TITLES)){
    const element=node('div','studio-dock-content');element.id='studio-'+id+'-content';
    element.append(node('p','studio-empty',title+'加载中…'));
    const listeners=new Set();let shown=false;
    slots[id]={element,onVisibility(fn){listeners.add(fn);return()=>listeners.delete(fn);},visibilityChanged(value){shown=value;for(const fn of listeners)fn(value);},isVisible:()=>shown,
      setBadge(text){const button=document.getElementById('studio-'+id+'-toggle');if(button)button.textContent=title+(text?' · '+text:'');}};
  }
  const message=node('span','studio-notification');message.id='studio-message';message.setAttribute('role','status');
  const plotBadge=node('span','studio-plot-state');plotBadge.id='studio-plot-state';plotBadge.hidden=true;
  document.querySelector('.statusbar').prepend(plotBadge,message);
  attachSchematicChrome();
  return {slots,notify(text,{kind='info'}={}){message.textContent=text;message.dataset.kind=kind;message.title=text;},setNativeState({loading=false,hidden=false}={}){document.body.classList.toggle('studio-native-loading',loading);document.body.classList.toggle('studio-native-hidden',hidden);}};
}

/** Called again when the deferred schematic DOM is installed. */
export function attachSchematicChrome(){
  const drawing=document.querySelector('main.drawing');if(!drawing||document.getElementById('studio-provenance'))return;
  const provenance=node('div','studio-provenance');provenance.id='studio-provenance';
  provenance.innerHTML='<span id="studio-native-note">正在读取电路…</span><label id="studio-history-label" hidden><input id="studio-history" type="checkbox"> 显示历史几何</label><button id="studio-source-button" type="button" disabled>Canonical 源码…</button>';
  drawing.insertBefore(provenance,document.getElementById('canvas'));
}

function mountLegacy(ui){
  const app=document.getElementById('app'),workspace=node('div','studio-workspace');workspace.id='studio-workspace';app.before(workspace);workspace.append(app);
  function panel(id){
    const slot=ui.slots[id],panel=node('section','studio-dock studio-'+id);panel.id='studio-'+id;panel.setAttribute('aria-label',TITLES[id]);
    const bar=node('header','studio-dock-head'),close=node('button','','隐藏');close.type='button';close.setAttribute('aria-label','隐藏'+TITLES[id]);bar.append(node('strong','',TITLES[id]),close);panel.append(bar,slot.element);
    slot.setVisible=value=>{panel.hidden=!value;document.body.classList.toggle(id+'-hidden',!value);slot.visibilityChanged(value);window.dispatchEvent(new Event('resize'));};
    slot.toggle=()=>slot.setVisible(!slot.isVisible());close.onclick=slot.toggle;document.getElementById('studio-'+id+'-toggle').onclick=slot.toggle;slot.visibilityChanged(true);return panel;
  }
  const sim=panel('simulation'),ai=panel('ai');
  function splitter(id,orientation,property,min,max){
    const e=node('div','studio-split studio-split-'+orientation);e.id=id;e.tabIndex=0;e.setAttribute('role','separator');e.setAttribute('aria-orientation',orientation==='x'?'vertical':'horizontal');e.setAttribute('aria-label',orientation==='x'?'调整仿真面板宽度':'调整 AI 面板高度');
    const change=v=>{const n=Math.max(min,Math.min(max(),v));document.body.style.setProperty(property,n+'px');e.setAttribute('aria-valuenow',String(Math.round(n)));window.dispatchEvent(new Event('resize'));};
    e.onpointerdown=event=>{e.setPointerCapture(event.pointerId);const start=orientation==='x'?event.clientX:event.clientY,size=orientation==='x'?sim.getBoundingClientRect().width:ai.getBoundingClientRect().height;const move=ev=>change(size+start-(orientation==='x'?ev.clientX:ev.clientY));const up=()=>{e.removeEventListener('pointermove',move);e.removeEventListener('pointerup',up);};e.addEventListener('pointermove',move);e.addEventListener('pointerup',up);};
    e.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();change((orientation==='x'?sim.offsetWidth:ai.offsetHeight)+(['ArrowLeft','ArrowUp'].includes(event.key)?20:-20));};return e;
  }
  workspace.append(splitter('studio-sim-split','x','--studio-right-width',240,()=>innerWidth*.55),sim);
  workspace.after(splitter('studio-ai-split','y','--studio-ai-height',100,()=>innerHeight*.6),ai);
  const dialog=node('dialog','studio-versions-dialog');dialog.id='studio-versions-dialog';dialog.setAttribute('aria-label','版本管理');
  const head=node('header',''),close=node('button','','关闭');close.type='button';head.append(node('strong','','版本管理'),close);dialog.append(head,ui.slots.versions.element);document.body.append(dialog);
  const slot=ui.slots.versions;slot.setVisible=value=>{if(value&&!dialog.open)dialog.showModal();else if(!value&&dialog.open)dialog.close();slot.visibilityChanged(value);};slot.toggle=()=>slot.setVisible(!slot.isVisible());close.onclick=()=>slot.setVisible(false);dialog.addEventListener('close',()=>slot.visibilityChanged(false));
  delete ui.slots.waveforms;
  return ui;
}
