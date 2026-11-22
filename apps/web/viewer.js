import {indexSpectre,references} from './core.js';
const ns='http://www.w3.org/2000/svg';
function svg(tag,attrs={},text){const el=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attrs))el.setAttribute(key,value);if(text!==undefined)el.textContent=text;return el;}
export function createViewer({viewport,scopeSelect,netList,onSelect}){
  let scopes=[],selectedScope=null,extent,view,drag,svgRoot,selectedNet=null;
  function choose(instance,net){
    viewport.querySelectorAll('.node').forEach(el=>el.classList.toggle('selected',net?references(selectedScope,net).some(i=>i.name===el.dataset.name):el.dataset.name===instance.name));
    onSelect(net?references(selectedScope,net):[instance],net?`网络 ${net}`:`${instance.name} · ${instance.model}`,selectedScope.name);
  }
  function draw(){
    const name=scopeSelect.value;selectedScope=scopes.find(s=>s.name===name);netList.replaceChildren();viewport.replaceChildren();selectedNet=null;
    if(!selectedScope){const p=document.createElement('p');p.className='empty';p.textContent='当前文件没有可索引的 Spectre 实例。文本编辑仍可用。';viewport.append(p);return;}
    // A connectivity index: generic instance boxes and net labels, never represented as original OA geometry.
    const instances=selectedScope.instances.slice(0,80);const cols=instances.length<=2?instances.length:Math.min(4,Math.ceil(Math.sqrt(instances.length)));
    const rows=Math.ceil(instances.length/cols);extent=[0,0,Math.max(420,cols*235+30),rows*145+35];view=[...extent];
    svgRoot=svg('svg',{viewBox:view.join(' '),role:'group','aria-label':selectedScope.name+' instance connectivity'});
    instances.forEach((instance,index)=>{
      const x=35+(index%cols)*235,y=30+Math.floor(index/cols)*145;const group=svg('g',{class:'node',tabindex:'0',role:'button','aria-label':`实例 ${instance.name}`,transform:`translate(${x} ${y})`});group.dataset.name=instance.name;
      group.append(svg('rect',{class:'node-body',x:0,y:0,width:185,height:83,rx:5}),svg('text',{x:12,y:22},instance.name),svg('text',{x:12,y:41,class:'model'},instance.model.length>26?instance.model.slice(0,23)+'…':instance.model),svg('text',{x:12,y:65,class:'pin'},instance.nodes.slice(0,4).join(' · ').slice(0,30)+(instance.nodes.length>4?' …':'')));
      const title=svg('title',{},`${instance.scope}/${instance.name}\n${instance.nodes.join(' ')}\n${instance.model}\nL${instance.start}–${instance.end}`);group.append(title);
      // Pin stubs are local terminal marks only; inter-instance wires are not fabricated.
      instance.nodes.slice(0,4).forEach((net,pin)=>{const px=25+pin*42;group.append(svg('path',{class:'net-wire',d:`M${px},83 v12`}),svg('circle',{class:'net-dot',cx:px,cy:95,r:2}));});
      group.addEventListener('click',()=>choose(instance));group.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();choose(instance);}});svgRoot.append(group);
    });viewport.append(svgRoot);
    if(selectedScope.instances.length>80){const note=document.createElement('span');note.className='panel-note';note.textContent='仅展示前 80 个实例。缩小子电路范围可查看其余实例。';viewport.append(note);}
    const nets=[...new Set(selectedScope.instances.flatMap(i=>i.nodes))];
    nets.slice(0,120).forEach(net=>{const button=document.createElement('button');button.textContent=net;button.dataset.net=net;button.title=`定位 ${references(selectedScope,net).length} 处实例引用`;button.addEventListener('click',()=>{selectedNet=net;netList.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.net===net));choose(null,net);});netList.append(button);});
  }
  scopeSelect.addEventListener('change',draw);
  viewport.addEventListener('wheel',event=>{if(!svgRoot)return;event.preventDefault();const factor=event.deltaY>0?1.13:.885;const r=viewport.getBoundingClientRect();const px=(event.clientX-r.left)/r.width,py=(event.clientY-r.top)/r.height;const w=Math.min(extent[2]*8,Math.max(extent[2]/8,view[2]*factor)),h=w*view[3]/view[2];view=[view[0]+(view[2]-w)*px,view[1]+(view[3]-h)*py,w,h];svgRoot.setAttribute('viewBox',view.join(' '));},{passive:false});
  viewport.addEventListener('pointerdown',e=>{if(!svgRoot||e.target.closest('.node')||e.button!==0)return;drag={x:e.clientX,y:e.clientY,view:[...view]};viewport.setPointerCapture(e.pointerId);});
  viewport.addEventListener('pointermove',e=>{if(!drag)return;const r=viewport.getBoundingClientRect();view=[drag.view[0]-(e.clientX-drag.x)*drag.view[2]/r.width,drag.view[1]-(e.clientY-drag.y)*drag.view[3]/r.height,drag.view[2],drag.view[3]];svgRoot.setAttribute('viewBox',view.join(' '));});
  viewport.addEventListener('pointerup',()=>drag=null);viewport.addEventListener('pointercancel',()=>drag=null);
  return {update(text){const old=scopeSelect.value;scopes=indexSpectre(text);scopeSelect.replaceChildren(...scopes.map(scope=>new Option(`${scope.name} · ${scope.instances.length}`,scope.name)));scopeSelect.value=scopes.some(s=>s.name===old)?old:(scopes.find(s=>s.name==='PIPE_TOP_F4_RS9_N06')?.name||scopes.find(s=>s.name==='Switch')?.name||scopes[0]?.name||'');draw();},fit(){if(svgRoot){view=[...extent];svgRoot.setAttribute('viewBox',view.join(' '));}},get scope(){return selectedScope;}};
}
