import {loadCore} from '../../../web/vendor/rnl-viewer/core/core.js';
import {files as packageFiles,packageDirs} from '../../../web/vendor/rnl-viewer/core/packages.js';
import {svgViewer} from '../../../web/vendor/rnl-viewer/svg-viewer.js';
import {hitsAt} from '../../../web/vendor/rnl-viewer/hits.js';
import {objectSelection,rootVisit} from './selection.js';

const ALLOWED=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','title','desc']);
export function safeSVG(text,doc=document){
  const parsed=new DOMParser().parseFromString(text,'image/svg+xml');
  if(parsed.querySelector('parsererror')||parsed.documentElement.localName!=='svg')throw Error('RNL renderer returned invalid SVG');
  for(const node of [...parsed.querySelectorAll('*')]){
    if(!ALLOWED.has(node.localName)){node.remove();continue;}
    for(const attribute of [...node.attributes])if(/^on/i.test(attribute.name)||/href|src/i.test(attribute.name)||/url\s*\(|javascript:|data:/i.test(attribute.value))node.removeAttribute(attribute.name);
  }
  return doc.importNode(parsed.documentElement,true);
}

// The MCP resource already owns an independent document. State is instance-local.
export function createRenderer(root,{wasm,onEvent=()=>{}}){
  const document=root.ownerDocument;
  root.classList.add('ic-schematic-renderer');
  const bar=document.createElement('div');bar.className='rnl-toolbar';
  const back=document.createElement('button'),pathLabel=document.createElement('span'),levels=document.createElement('select'),enter=document.createElement('button'),canvas=document.createElement('div');
  back.textContent='上一级';back.disabled=true;enter.textContent='进入选中器件';enter.disabled=true;pathLabel.className='rnl-path';levels.setAttribute('aria-label','显示层级');canvas.className='rnl-canvas';
  for(const button of [back,enter])button.type='button';
  bar.append(back,pathLabel,levels,enter);root.append(bar,canvas);
  const abort=new AbortController();
  let corePromise=loadCore(wasm),doc=null,current=0,path=[],binding=null,manifest=null,rootEntry=null,selection=null,cleanup=null,svg=null,disposed=false,picker=null,press=null,visible=true,savedViewport=null;
  corePromise.catch(()=>{}); // The bounded load path reports initialization failures.
  const send=(type,data={})=>{if(!disposed)onEvent({type,binding,...data});};
  function clear(){cleanup?.();cleanup=null;picker?.remove();picker=null;canvas.replaceChildren();selection=null;enter.disabled=true;}
  function choose(index){
    const selected=objectSelection(doc,current,path,index,rootEntry,manifest);if(!selected)return;
    selection=selected;enter.disabled=selected.opens===null;
    const ids=new Set(doc.levels[current].hits.filter(h=>h.objects.includes(index)).map(h=>h.id));
    for(const group of svg.querySelectorAll('[data-id]'))group.classList.toggle('selected',ids.has(group.getAttribute('data-id')));
    send('selection',{selection:selected});
  }
  function draw(viewport=null){
    clear();const level=doc.levels[current];levels.value=String(current);back.disabled=path.length<2;pathLabel.textContent=path.map(p=>p.title).join(' › ');
    if(!level.svg){canvas.textContent='本层没有已放置的原图；未进行自动布局。';return;}
    svg=safeSVG(level.svg,document);
    if(viewport&&Array.isArray(viewport.center)&&viewport.center.length===2&&viewport.center.every(Number.isFinite)&&Number.isFinite(viewport.k)&&viewport.k>0&&canvas.clientWidth>24&&canvas.clientHeight>24){
      const w=canvas.clientWidth,h=canvas.clientHeight,k=viewport.k;
      svg.setAttribute('viewBox',`${viewport.center[0]-(w-24)/(2*k)} ${viewport.center[1]-(h-24)/(2*k)} ${(w-24)/k} ${(h-24)/k}`);
    }
    cleanup=svgViewer(canvas,svg,level.scale);
    send('level',{level:level.title,occurrence_path:path.map(p=>p.via).filter(Boolean)});
  }
  function navigate(index,via=null){if(!doc?.levels[index])return;if(via===null)path=rootVisit(doc,index);else path.push({level:index,title:doc.levels[index].title,via});current=index;draw();}
  back.onclick=()=>{if(path.length>1){path.pop();current=path.at(-1).level;draw();}};
  enter.onclick=()=>{if(selection?.opens!==null&&selection)navigate(selection.opens,selection.name);};
  levels.onchange=()=>navigate(Number(levels.value));
  canvas.addEventListener('pointerdown',event=>{press={x:event.clientX,y:event.clientY};},{capture:true,signal:abort.signal});
  canvas.addEventListener('click',event=>{
    if(!visible||!doc||!svg||event.target.closest('button')||!press||Math.hypot(event.clientX-press.x,event.clientY-press.y)>4)return;
    const box=canvas.getBoundingClientRect(),v=svg.viewBox.baseVal,k=box.width/v.width;
    const {hits}=hitsAt(doc.levels[current],{x:v.x,y:v.y,k},{x:event.clientX-box.left,y:event.clientY-box.top});
    const indices=[...new Set(hits.flatMap(h=>h.objects))].filter(i=>['instance','net'].includes(doc.objects[i]?.kind));
    if(indices.length===1)choose(indices[0]);else if(indices.length>1){
      picker?.remove();picker=document.createElement('dialog');picker.className='rnl-picker';picker.append(document.createTextNode('此处有多个对象，请明确选择'));
      for(const index of indices.slice(0,32)){const b=document.createElement('button');b.textContent=doc.objects[index].kind+' · '+doc.objects[index].name;b.onclick=()=>{choose(index);picker.close();picker.remove();picker=null;};picker.append(b);}
      const cancel=document.createElement('button');cancel.textContent='取消';cancel.onclick=()=>{picker.close();picker.remove();picker=null;};picker.append(cancel);document.body.append(picker);picker.showModal();
    }
  },{signal:abort.signal});
  async function load(m){
    if(!m||disposed)return;
    binding=m.binding;const expected=binding;clear();doc=null;manifest=m.manifest;rootEntry=m.root_entry;
    try{
      const core=await corePromise;if(disposed||binding!==expected)return;
      if(m.request.auto_include!==false)throw Error('Automatic layout/include is not allowed');
      const built=core.build({...m.request,files:{...packageFiles,...m.request.files},package_dirs:packageDirs});
      if(built.failed||built.missing.length||built.diagnostics.some(d=>d.severity==='error'))throw Error('Pinned RNL closure failed to render');
      if(disposed||binding!==expected)return;doc=built;
      const index=manifest.level==='@top'||manifest.level==='(top)'?0:doc.levels.findIndex(l=>l.title===manifest.level);
      if(index<0)throw Error('Requested entry level is absent');
      levels.replaceChildren(...doc.levels.map((l,i)=>new Option(l.title,String(i))));current=index;path=rootVisit(doc,index);draw();
      send('loaded',{summary:{objects:doc.objects.length,instances:doc.objects.filter(o=>o.kind==='instance').length,levels:doc.levels.length,
        unplaced:doc.levels.reduce((n,l)=>n+l.unplaced.length,0),warnings:doc.diagnostics.filter(d=>d.severity==='warning').length,level:doc.levels[index].title}});
    }catch(error){if(binding===expected){clear();canvas.textContent=error.message;send('error',{message:error.message});}}
  }
  function snapshot(){
    if(!doc||!svg)return null;
    const b=svg.viewBox.baseVal;if(canvas.clientWidth>0&&b.width>0)savedViewport={center:[b.x+b.width/2,b.y+b.height/2],k:canvas.clientWidth/b.width};
    return {level:doc.levels[current].title,path:path.map(p=>({title:p.title,via:p.via??null})),viewport:savedViewport};
  }
  function restore(saved){
    if(disposed||!doc||!saved)return;
    const index=doc.levels.findIndex(l=>l.title===saved.level);if(index<0)throw Error('保存的原理图层级已不存在。');
    let visits=[];
    for(const [n,item] of (Array.isArray(saved.path)?saved.path:[]).entries()){
      const level=doc.levels.findIndex(l=>l.title===item.title);if(level<0)throw Error('保存的层级路径无效。');
      if(n>0&&!doc.objects.some(o=>o.kind==='instance'&&o.name===item.via&&o.level===doc.levels[visits[n-1].level].host&&o.opens===level))throw Error('保存的 occurrence 路径无法核验。');
      visits.push({level,title:item.title,via:n===0?null:item.via});
    }
    if(!visits.length)visits=rootVisit(doc,index);if(visits.at(-1).level!==index)throw Error('保存的层级路径与入口不一致。');
    current=index;path=visits;savedViewport=saved.viewport;draw(savedViewport);
  }
  function setVisible(value){if(disposed)return;if(!value)snapshot();visible=value===true;canvas.inert=!visible;}
  return {load,snapshot,restore,setVisible,resize(){if(!disposed&&visible&&svg)canvas.dispatchEvent(new Event('resize'));},dispose(){if(disposed)return;disposed=true;abort.abort();clear();doc=null;corePromise=null;root.replaceChildren();}};
}
