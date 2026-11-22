export async function createLayout(){
  const ui=createLegacyLayout();
  if(new URLSearchParams(location.search).get("layout")==="dockview"){
    const {mountDockview}=await import("./dockview/layout.js");return mountDockview(ui);
  }
  return ui;
}

function createLegacyLayout(){
  document.body.classList.add('ic-studio');document.title='CircuitGit';
  const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url);document.head.append(css);
  const node=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e;};
  const toolbar=node('header','studio-toolbar');toolbar.id='studio-toolbar';
  toolbar.innerHTML='<strong class="studio-brand">CircuitGit</strong><label>项目 <select id="studio-project" aria-label="项目"></select></label><label class="studio-entry-label">原生入口 <select id="studio-entry" aria-label="原生入口"></select></label><label>运行 <select id="studio-run" aria-label="已保存运行"><option value="">未选择运行</option></select></label><span id="studio-identity"></span><button id="studio-simulation-toggle" type="button">仿真</button><button id="studio-ai-toggle" type="button">AI</button>';
  document.getElementById('menubar').after(toolbar);
  const workspace=node('div','studio-workspace');workspace.id='studio-workspace';const app=document.getElementById('app');app.before(workspace);workspace.append(app);
  function slot(id,title){const panel=node('section','studio-dock studio-'+id);panel.id='studio-'+id;panel.setAttribute('aria-label',title);const bar=node('header','studio-dock-head');const name=node('strong','',title),badge=node('span','studio-badge'),close=node('button','','隐藏');close.type='button';close.setAttribute('aria-label','隐藏'+title);const element=node('div','studio-dock-content');element.id='studio-'+id+'-content';bar.append(name,badge,close);panel.append(bar,element);element.append(node('p','studio-empty','组件加载中…'));
    let visible=true;const api={element,setVisible(value){visible=!!value;panel.hidden=!visible;document.body.classList.toggle(id+'-hidden',!visible);window.dispatchEvent(new Event('resize'));},toggle(){api.setVisible(!visible);},isVisible:()=>visible,setBadge(text){badge.textContent=text||'';document.getElementById('studio-'+id+'-toggle').textContent=(id==='ai'?'AI':'仿真')+(text?' · '+text:'');}};close.onclick=api.toggle;document.getElementById('studio-'+id+'-toggle').onclick=api.toggle;return {panel,api};}
  const sim=slot('simulation','Simulation'),ai=slot('ai','AI Assistant');
  function splitter(id,orientation,property,min,max){const e=node('div','studio-split studio-split-'+orientation);e.id=id;e.tabIndex=0;e.setAttribute('role','separator');e.setAttribute('aria-orientation',orientation==='x'?'vertical':'horizontal');e.setAttribute('aria-label',orientation==='x'?'调整仿真面板宽度':'调整 AI 面板高度');
    const change=v=>{const n=Math.max(min,Math.min(max(),v));document.body.style.setProperty(property,n+'px');e.setAttribute('aria-valuenow',String(Math.round(n)));window.dispatchEvent(new Event('resize'));};
    e.onpointerdown=event=>{e.setPointerCapture(event.pointerId);const start=orientation==='x'?event.clientX:event.clientY;const size=orientation==='x'?sim.panel.getBoundingClientRect().width:ai.panel.getBoundingClientRect().height;const move=ev=>change(size+start-(orientation==='x'?ev.clientX:ev.clientY));const up=()=>{e.removeEventListener('pointermove',move);e.removeEventListener('pointerup',up);};e.addEventListener('pointermove',move);e.addEventListener('pointerup',up);};
    e.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const size=orientation==='x'?sim.panel.offsetWidth:ai.panel.offsetHeight;change(size+(['ArrowLeft','ArrowUp'].includes(event.key)?20:-20));};return e;}
  const rightSplit=splitter('studio-sim-split','x','--studio-right-width',240,()=>innerWidth*.55);workspace.append(rightSplit,sim.panel);
  const bottomSplit=splitter('studio-ai-split','y','--studio-ai-height',100,()=>innerHeight*.6);workspace.after(bottomSplit,ai.panel);
  const versionDialog=node('dialog','studio-versions-dialog');versionDialog.id='studio-versions-dialog';versionDialog.setAttribute('aria-label','版本管理');
  const versionHead=node('header'),versionClose=node('button','','关闭'),versionContent=node('div','studio-dock-content');versionContent.id='studio-versions-content';versionClose.type='button';versionHead.append(node('strong','','版本管理'),versionClose);versionDialog.append(versionHead,versionContent);document.body.append(versionDialog);
  const versions={element:versionContent,setVisible(value){if(value&&!versionDialog.open)versionDialog.showModal();else if(!value&&versionDialog.open)versionDialog.close();},isVisible:()=>versionDialog.open,setBadge(){},toggle(){versions.setVisible(!versions.isVisible());}};versionClose.onclick=()=>versions.setVisible(false);
  const provenance=node('div','studio-provenance');provenance.id='studio-provenance';provenance.innerHTML='<span id="studio-native-note">连接私有网关…</span><label id="studio-history-label" hidden><input id="studio-history" type="checkbox"> 显示历史几何</label><button id="studio-source-button" type="button">Canonical 源码…</button>';
  const drawing=document.querySelector('main.drawing');drawing.insertBefore(provenance,document.getElementById('canvas'));
  const message=node('span','studio-notification');message.id='studio-message';message.setAttribute('role','status');const plotBadge=node('span','studio-plot-state');plotBadge.id='studio-plot-state';plotBadge.hidden=true;document.querySelector('.statusbar').prepend(plotBadge,message);
  return {slots:{simulation:sim.api,ai:ai.api,versions},notify(text,{kind='info'}={}){message.textContent=text;message.dataset.kind=kind;message.title=text;},setNativeState({loading=false,hidden=false}={}){document.body.classList.toggle('studio-native-loading',loading);document.body.classList.toggle('studio-native-hidden',hidden);}};
}
