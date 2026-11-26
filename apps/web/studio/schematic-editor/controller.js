// Interactive Virtuoso-style schematic editor layered cleanly over the vendored RNL viewer.
// Supports W (wire + netlist connectivity), I (add instance), M (move), R (rotate),
// Q (properties), L (net label), Del (delete), Undo/Redo, editable source, Save, and PR creation.
import {current,doc,selected} from '../../vendor/rnl-viewer/state.js';
import {view} from '../../vendor/rnl-viewer/drawing.js';
import {hitsAt} from '../../vendor/rnl-viewer/hits.js';
import {adoptSource,currentSource,isLoading,showBuilt} from '../../vendor/rnl-viewer/open.js';
import {resetBuffers} from '../../vendor/rnl-viewer/edits.js';
import {shell} from '../../vendor/rnl-viewer/shell.js';
import {editing as rnlTextEditing} from '../../vendor/rnl-viewer/editor.js';
import {
  addInstance,
  computeWorldPins,
  connectWire,
  deleteInstance,
  formatCoord,
  formatParamsList,
  labelNet,
  moveInstance,
  nextOrientation,
  parseEditableScope,
  rotateInstance,
  snapCoord,
  transformPoint,
  updateInstanceProperties,
} from './rnl-codec.js';
import {buildInstanceCatalog} from './catalog.js';
import {openSavePrDialog} from './pr-dialog.js';

const SVG_NS='http://www.w3.org/2000/svg';

function svgEl(tag,attrs={}){
  const node=document.createElementNS(SVG_NS,tag);
  for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));
  return node;
}

function isEditableFocus(target){
  if(!target||!(target instanceof Element))return false;
  return Boolean(target.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""],dialog[open]'));
}

export function mountSchematicEditor({
  getProjectContext=()=>({}),
  getLibraries=()=>[],
  getVerilogAModels=()=>[],
  isProbeActive=()=>false,
  bridge=null,
  onRequireConnector=null,
  onDocumentUpdated=()=>{},
  notify=()=>{},
}={}){
  const canvas=document.getElementById('canvas');
  if(!canvas)return {refresh(){},openSourceEditor(){},openSavePr(){},isDirty:()=>false,destroy(){}};

  const css=document.createElement('link');
  css.rel='stylesheet';
  css.href=new URL('./style.css',import.meta.url).href;
  document.head.append(css);

  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};

  // State
  let disposed=false,rebuilding=false;
  let tool='select'; // 'select' | 'wire' | 'place' | 'move' | 'label'
  let placingSpec=null,placingOrient='R0';
  let movingInst=null,movingOrient='R0',movingBox=[-4,-4,4,4];
  let wireStart=null,wireWaypoints=[],wireBendHFirst=true;
  let cursorScene=null,cursorSnap=null;
  let cachedPinsKey='',cachedWorldPins=[];

  // Per-file baseline, undo/redo history, and edit summaries
  const baselines=new Map(); // filePath -> originalText
  const undoStacks=new Map(); // filePath -> string[]
  const redoStacks=new Map(); // filePath -> string[]
  const summariesByFile=new Map(); // filePath -> string[]

  // --- Floating EDA Toolbar + Mode Hint + SVG Interactive Overlay ---
  const toolbar=el('div',undefined,'cg-ed-bar');
  toolbar.setAttribute('role','toolbar');
  toolbar.setAttribute('aria-label','原理图编辑工具栏');
  toolbar.addEventListener('pointerdown',e=>e.stopPropagation());
  toolbar.addEventListener('click',e=>e.stopPropagation());
  toolbar.addEventListener('wheel',e=>e.stopPropagation(),{passive:true});

  const modePill=el('div',undefined,'cg-ed-mode-pill');
  modePill.hidden=true;
  modePill.addEventListener('pointerdown',e=>e.stopPropagation());

  const overlaySvg=svgEl('svg',{class:'cg-ed-overlay','aria-hidden':'true'});
  canvas.append(overlaySvg,toolbar,modePill);

  const buttons={};
  function makeToolBtn(id,label,shortcut,title,onClick,extraClass=''){
    const btn=el('button',undefined,'cg-ed-tool'+(extraClass?' '+extraClass:''));
    btn.type='button';
    btn.dataset.tool=id;
    btn.title=title;
    btn.append(el('span',label,'cg-ed-tool-label'));
    if(shortcut)btn.append(el('kbd',shortcut,'cg-ed-kbd'));
    btn.addEventListener('click',onClick);
    buttons[id]=btn;
    return btn;
  }

  const sep=()=>el('span','','cg-ed-sep');
  toolbar.append(
    makeToolBtn('select','选择','Esc','选择 / 平移模式 (Esc)',()=>setTool('select')),
    makeToolBtn('wire','连线','W','交互正交连线并同步网表连接 (W)',()=>startWireMode()),
    makeToolBtn('place','器件','I','调用并放置器件或子电路实例 (I)',()=>openInstancePicker()),
    makeToolBtn('move','移动','M','移动选中或点击的器件 (M)',()=>startMoveMode()),
    makeToolBtn('rotate','旋转','R','逆时针旋转选中器件 90° (R)',()=>void handleRotate('rotate')),
    makeToolBtn('props','属性','Q','编辑选中器件的型号、引脚与参数 (Q)',()=>openPropertiesDialog()),
    makeToolBtn('label','标号','L','重命名并标注网络名 (L)',()=>startLabelMode()),
    makeToolBtn('delete','删除','Del','删除选中器件 (Delete)',()=>void handleDelete()),
    sep(),
    makeToolBtn('undo','↶','','撤销 (Ctrl+Z)',()=>void handleUndo()),
    makeToolBtn('redo','↷','','重做 (Ctrl+Y)',()=>void handleRedo()),
    sep(),
    makeToolBtn('source','源码','','打开可编辑网表源码并实时应用到画布',()=>openSourceEditor()),
    makeToolBtn('save','保存','Ctrl+S','保存修改到本机工作区（网页模式则打开导出/PR 窗口）',()=>void handleQuickSave(),'cg-ed-tool-save'),
    makeToolBtn('pr','提交 PR','','预览 RNL 差异、提交 Git 并创建 Pull Request',()=>openSavePr(),'cg-ed-tool-pr'),
  );

  // --- Helpers: Active level, file, scope, coordinate conversion ---
  function activeFileInfo(){
    if(!doc||!doc.levels?.length)return null;
    const lv=doc.levels[current]||doc.levels[0];
    const fileIndex=lv?.lines?.[0]??0;
    const file=doc.files?.[fileIndex]||doc.files?.[0];
    if(!file||typeof file.text!=='string')return null;
    const scopeName=current===0&&lv.kind==='file'?'(top)':(lv.title||'(top)');
    const filePath=file.path||'/circuit.scs';
    if(!baselines.has(filePath))baselines.set(filePath,file.text);
    return {lv,fileIndex,file,filePath,text:file.text,scopeName,scale:lv.scale||1};
  }

  function isFileDirty(filePath=activeFileInfo()?.filePath){
    if(!filePath)return false;
    const info=activeFileInfo();
    if(!info||info.filePath!==filePath)return false;
    return baselines.has(filePath)&&baselines.get(filePath)!==info.text;
  }

  function anyDirty(){
    const info=activeFileInfo();
    return Boolean(info&&isFileDirty(info.filePath));
  }

  function resolveGitTarget(info){
    const ctx=getProjectContext()||{};
    const relPath=String(info.filePath||'').replace(/^\/+/,'');
    const libs=getLibraries()||[];
    // 1. Exact file match across loaded libraries (handles descended subcircuit cells!)
    for(const lib of libs){
      for(const cell of lib.cells||[]){
        const dirPrefix=(cell.directory||'').replace(/\/+$/,'')+'/';
        const listed=cell.views?.some(v=>(v.files||[]).includes(relPath)||v.entry===relPath);
        if(listed||(dirPrefix.length>1&&relPath.startsWith(dirPrefix))){
          return {
            library_id:lib.id,
            library_name:lib.name,
            cell_id:cell.id,
            cell_name:cell.name,
            path:relPath,
            fileName:relPath.split('/').pop()||relPath,
          };
        }
      }
    }
    // 2. Fallback to activeLibrary if currently editing its entry
    if(ctx.activeLibrary?.library&&ctx.activeLibrary?.cell){
      return {
        library_id:ctx.activeLibrary.library.id,
        library_name:ctx.activeLibrary.library.name,
        cell_id:ctx.activeLibrary.cell.id,
        cell_name:ctx.activeLibrary.cell.name,
        path:relPath,
        fileName:relPath.split('/').pop()||relPath,
      };
    }
    return {
      library_id:null,
      library_name:ctx.importedProject?.name||'RC · 入门电路',
      cell_id:null,
      cell_name:info.scopeName==='(top)'?(relPath.split('/').pop()||'circuit.scs'):info.scopeName,
      path:relPath,
      fileName:relPath.split('/').pop()||relPath,
    };
  }

  function selectedInstanceObject(){
    if(selected===null||selected===undefined||!doc)return null;
    const obj=doc.objects?.[selected];
    if(!obj||obj.kind!=='instance')return null;
    return obj;
  }

  function clientToCanvasPx(clientX,clientY){
    const rect=canvas.getBoundingClientRect();
    return {x:clientX-rect.left,y:clientY-rect.top};
  }

  function canvasPxToScene(px,py){
    const info=activeFileInfo();
    if(!view||!info)return null;
    const u=view.x+px/view.k;
    const v=view.y+py/view.k;
    return {x:u/info.scale,y:-v/info.scale,u,v};
  }

  function sceneToCanvasPx(sx,sy){
    const info=activeFileInfo();
    if(!view||!info)return null;
    const u=sx*info.scale;
    const v=-sy*info.scale;
    return {x:(u-view.x)*view.k,y:(v-view.y)*view.k};
  }

  function gridStep(){
    const info=activeFileInfo();
    if(!view||!info)return 1;
    const pxPerUnit=view.k*info.scale;
    if(pxPerUnit>=24)return 0.5;
    if(pxPerUnit>=8)return 1;
    if(pxPerUnit>=3)return 2;
    return 4;
  }

  function worldPinsForCurrent(){
    const info=activeFileInfo();
    if(!info)return [];
    const key=`${info.filePath}:${info.scopeName}:${info.text.length}:${current}`;
    if(key===cachedPinsKey)return cachedWorldPins;
    cachedPinsKey=key;
    cachedWorldPins=computeWorldPins(info.text,info.scopeName);
    return cachedWorldPins;
  }

  function snapEndpointAt(clientX,clientY){
    const info=activeFileInfo();
    const px=clientToCanvasPx(clientX,clientY);
    const sc=canvasPxToScene(px.x,px.y);
    if(!info||!sc||!view)return null;
    const snapPx=14;

    // 1. Exact world pins from RNL codec (knows exact instance + terminal + portIndex + net!)
    let bestPin=null,bestDist=snapPx;
    for(const pin of worldPinsForCurrent()){
      const pt=sceneToCanvasPx(pin.x,pin.y);
      if(!pt)continue;
      const d=Math.hypot(pt.x-px.x,pt.y-px.y);
      if(d<=bestDist){bestDist=d;bestPin={kind:'pin',...pin};}
    }
    if(bestPin)return bestPin;

    // 2. Fallback to RNL runtime `hitsAt` for pins/wires (supports std-package symbols too!)
    const hitRes=hitsAt(info.lv,view,px);
    for(const h of hitRes.hits||[]){
      if(h.kind==='wire'&&h.objects?.length){
        const netObj=doc.objects?.[h.objects[0]];
        if(netObj?.name){
          const step=gridStep();
          return {kind:'wire',net:netObj.name,x:snapCoord(sc.x,step),y:snapCoord(sc.y,step)};
        }
      }
      if(h.kind==='pin'&&h.points?.length&&h.objects?.length){
        const netObj=doc.objects?.[h.objects[0]];
        const [u,v]=h.points[0];
        return {kind:'wire',net:netObj?.name||null,x:u/info.scale,y:-v/info.scale};
      }
    }

    const step=gridStep();
    return {kind:'point',net:null,x:snapCoord(sc.x,step),y:snapCoord(sc.y,step)};
  }

  function orthogonalPoints(startPt,waypoints,endPt){
    const pts=[{x:startPt.x,y:startPt.y}];
    for(const wp of waypoints)pts.push({x:wp.x,y:wp.y});
    const last=pts[pts.length-1];
    if(Math.abs(last.x-endPt.x)>1e-6&&Math.abs(last.y-endPt.y)>1e-6){
      const mid=wireBendHFirst?{x:endPt.x,y:last.y}:{x:last.x,y:endPt.y};
      pts.push(mid);
    }
    pts.push({x:endPt.x,y:endPt.y});
    return pts;
  }

  // --- Live WASM rebuild with preserved level, zoom, and pan ---
  function cloneSourceWithFile(baseSource,targetPath,nextText){
    const snap=Object.create(null);
    if(baseSource?.snapshot){
      for(const [k,v] of Object.entries(baseSource.snapshot))snap[k]=v;
    }
    if(doc?.files){
      for(const f of doc.files){
        if(f?.path&&typeof f.text==='string'&&!Object.hasOwn(snap,f.path))snap[f.path]=f.text;
      }
    }
    snap[targetPath]=nextText;
    const altNoSlash=targetPath.replace(/^\/+/,'');
    if(Object.hasOwn(snap,altNoSlash))snap[altNoSlash]=nextText;
    const filesMap=new Map();
    if(baseSource?.files instanceof Map){
      for(const [k,v] of baseSource.files.entries())filesMap.set(k,v);
    }
    for(const [k,v] of Object.entries(snap)){
      filesMap.set(k,()=>new Blob([v],{type:'text/plain'}));
    }
    const entryPath=baseSource?.path||doc?.path||targetPath;
    const entryText=snap[entryPath]??nextText;
    return {
      ...baseSource,
      name:baseSource?.name||doc?.name||'circuit.scs',
      path:entryPath,
      text:entryText,
      snapshot:snap,
      files:filesMap,
      open:async()=>({path:entryPath,text:snap[entryPath]??entryText}),
      read:async requested=>{
        if(Object.hasOwn(snap,requested))return snap[requested];
        if(typeof baseSource?.read==='function')return baseSource.read(requested);
        return null;
      },
    };
  }

  async function applyTextChange(nextText,summary,{recordUndo=true}={}){
    const info=activeFileInfo();
    if(!info||rebuilding||isLoading())return false;
    if(nextText===info.text)return true;
    const prevText=info.text;
    const baseSource=currentSource();
    if(!baseSource)throw Error('当前没有可编辑的原理图源。');

    rebuilding=true;
    let candidate=null;
    try{
      const nextSource=cloneSourceWithFile(baseSource,info.filePath,nextText);
      candidate=await shell.build(nextSource);
      const fatal=candidate?.diagnostics?.filter(d=>d.severity==='error'||d.severity==='fatal')||[];
      if(!candidate||candidate.failed){
        throw Error(fatal[0]?.message||'修改后的 RNL/网表未能通过解析，已自动回退。');
      }
      if(recordUndo){
        const stack=undoStacks.get(info.filePath)||[];
        stack.push(prevText);
        if(stack.length>60)stack.shift();
        undoStacks.set(info.filePath,stack);
        redoStacks.set(info.filePath,[]);
      }
      if(summary){
        const list=summariesByFile.get(info.filePath)||[];
        list.push(summary);
        if(list.length>30)list.shift();
        summariesByFile.set(info.filePath,list);
      }
      resetBuffers(candidate);
      showBuilt(candidate,true);
      adoptSource(nextSource);
      document.title='CircuitGit';
      cachedPinsKey='';
      onDocumentUpdated({
        filePath:info.filePath,
        text:nextText,
        baselineText:baselines.get(info.filePath)??prevText,
        dirty:baselines.get(info.filePath)!==nextText,
        source:nextSource,
        summary,
      });
      if(summary)notify(summary);
      return true;
    }catch(err){
      notify(err?.message||String(err),{kind:'error'});
      return false;
    }finally{
      if(candidate&&candidate!==doc)shell.discardBuild?.(candidate);
      rebuilding=false;
      refreshUI();
    }
  }

  // --- SVG Overlay rendering for W / I / M / L previews ---
  function renderOverlay(){
    overlaySvg.replaceChildren();
    if(!view||!doc||tool==='select')return;

    // Show subtle snap dots on all pins in wire mode
    if(tool==='wire'){
      for(const pin of worldPinsForCurrent()){
        const pt=sceneToCanvasPx(pin.x,pin.y);
        if(!pt)continue;
        overlaySvg.append(svgEl('circle',{cx:pt.x,cy:pt.y,r:3.5,class:'cg-ed-pin-dot'}));
      }
    }

    // Active snap ring & tag
    if((tool==='wire'||tool==='label')&&cursorSnap){
      const pt=sceneToCanvasPx(cursorSnap.x,cursorSnap.y);
      if(pt){
        const isSnapped=cursorSnap.kind==='pin'||cursorSnap.kind==='wire';
        overlaySvg.append(svgEl('circle',{
          cx:pt.x,cy:pt.y,
          r:isSnapped?7:4,
          class:isSnapped?'cg-ed-snap-ring is-locked':'cg-ed-snap-ring',
        }));
        const tag=cursorSnap.kind==='pin'
          ? `${cursorSnap.instance}:${cursorSnap.terminal}${cursorSnap.net?` (${cursorSnap.net})`:''}`
          : cursorSnap.kind==='wire'&&cursorSnap.net
            ? `导线 · ${cursorSnap.net}`
            : `(${formatCoord(cursorSnap.x)}, ${formatCoord(cursorSnap.y)})`;
        const label=svgEl('text',{x:pt.x+10,y:pt.y-8,class:'cg-ed-snap-text'});
        label.textContent=tag;
        overlaySvg.append(label);
      }
    }

    // Orthogonal wire preview
    if(tool==='wire'&&wireStart&&cursorSnap){
      const polyPts=orthogonalPoints(wireStart,wireWaypoints,cursorSnap);
      const pxPts=polyPts.map(p=>sceneToCanvasPx(p.x,p.y)).filter(Boolean);
      if(pxPts.length>=2){
        overlaySvg.append(svgEl('polyline',{
          points:pxPts.map(p=>`${p.x},${p.y}`).join(' '),
          class:'cg-ed-wire-preview',
        }));
        for(const p of pxPts.slice(0,-1)){
          overlaySvg.append(svgEl('circle',{cx:p.x,cy:p.y,r:3,class:'cg-ed-wire-node'}));
        }
      }
    }

    // Ghost box for placing (`I`) or moving (`M`)
    if((tool==='place'&&placingSpec||tool==='move'&&movingInst)&&cursorScene){
      const step=gridStep();
      const sx=snapCoord(cursorScene.x,step),sy=snapCoord(cursorScene.y,step);
      const box=tool==='place'?(placingSpec.previewBox||[-4,-3,4,3]):movingBox;
      const orient=tool==='place'?placingOrient:movingOrient;
      const corners=[[box[0],box[1]],[box[2],box[1]],[box[2],box[3]],[box[0],box[3]]].map(([lx,ly])=>{
        const [dx,dy]=transformPoint(lx,ly,orient);
        return sceneToCanvasPx(sx+dx,sy+dy);
      }).filter(Boolean);
      if(corners.length===4){
        overlaySvg.append(svgEl('polygon',{
          points:corners.map(p=>`${p.x},${p.y}`).join(' '),
          class:'cg-ed-ghost-box',
        }));
      }
      const originPx=sceneToCanvasPx(sx,sy);
      if(originPx){
        overlaySvg.append(svgEl('circle',{cx:originPx.x,cy:originPx.y,r:3.5,class:'cg-ed-ghost-origin'}));
        const caption=svgEl('text',{x:originPx.x+8,y:originPx.y-8,class:'cg-ed-snap-text'});
        caption.textContent=`${tool==='place'?placingSpec.name:movingInst} · (${formatCoord(sx)}, ${formatCoord(sy)}) · ${orient}`;
        overlaySvg.append(caption);
      }
    }
  }

  // --- Tool switching ---
  function setTool(nextTool){
    tool=nextTool;
    if(nextTool!=='wire'){wireStart=null;wireWaypoints=[];}
    if(nextTool!=='place'){placingSpec=null;placingOrient='R0';}
    if(nextTool!=='move'){movingInst=null;}
    cursorSnap=null;
    canvas.classList.toggle('cg-ed-crosshair',tool!=='select');
    refreshUI();
    renderOverlay();
  }

  function startWireMode(){
    if(!activeFileInfo())return;
    setTool('wire');
  }

  function startLabelMode(){
    const info=activeFileInfo();
    if(!info)return;
    // If a net is currently selected, open rename immediately; otherwise enter click-wire mode
    const obj=selected!==null&&selected!==undefined?doc?.objects?.[selected]:null;
    if(obj?.kind==='net'&&obj.name){
      openNetLabelDialog({oldNet:obj.name});
      return;
    }
    setTool('label');
  }

  function startMoveMode(){
    const info=activeFileInfo();
    if(!info)return;
    const obj=selectedInstanceObject();
    if(obj){
      const parsed=parseEditableScope(info.text,info.scopeName);
      const place=parsed.placements.get(obj.name);
      const symId=parsed.symbolBindings.get(obj.name);
      const sym=symId?parsed.symbols.get(symId):null;
      movingInst=obj.name;
      movingOrient=place?.orient||'R0';
      movingBox=sym?.box||[-4,-3,4,3];
      tool='move';
      canvas.classList.add('cg-ed-crosshair');
      refreshUI();
      renderOverlay();
    }else{
      tool='move';
      movingInst=null;
      canvas.classList.add('cg-ed-crosshair');
      refreshUI();
      notify('请在画布上点击要移动的器件，或先选中器件再按 M。');
    }
  }

  async function handleRotate(mode='rotate'){
    if(tool==='place'&&placingSpec){
      placingOrient=nextOrientation(placingOrient,mode);
      renderOverlay();
      return;
    }
    if(tool==='move'&&movingInst){
      movingOrient=nextOrientation(movingOrient,mode);
      renderOverlay();
      return;
    }
    const info=activeFileInfo();
    const obj=selectedInstanceObject();
    if(!info||!obj){notify('请先在画布中选中一个器件再按 R 旋转。');return;}
    try{
      const res=rotateInstance(info.text,{scopeName:info.scopeName,instanceName:obj.name,mode});
      await applyTextChange(res.text,res.summary);
    }catch(err){notify(err.message,{kind:'error'});}
  }

  async function handleDelete(){
    const info=activeFileInfo();
    const obj=selectedInstanceObject();
    if(!info||!obj){notify('请先在画布中选中要删除的器件。');return;}
    try{
      const res=deleteInstance(info.text,{scopeName:info.scopeName,instanceName:obj.name});
      await applyTextChange(res.text,res.summary);
    }catch(err){notify(err.message,{kind:'error'});}
  }

  async function handleUndo(){
    const info=activeFileInfo();
    if(!info)return;
    const stack=undoStacks.get(info.filePath);
    if(!stack?.length)return;
    const prev=stack.pop();
    const redo=redoStacks.get(info.filePath)||[];
    redo.push(info.text);
    redoStacks.set(info.filePath,redo);
    await applyTextChange(prev,'撤销上一步原理图修改',{recordUndo:false});
  }

  async function handleRedo(){
    const info=activeFileInfo();
    if(!info)return;
    const redo=redoStacks.get(info.filePath);
    if(!redo?.length)return;
    const next=redo.pop();
    const undo=undoStacks.get(info.filePath)||[];
    undo.push(info.text);
    undoStacks.set(info.filePath,undo);
    await applyTextChange(next,'重做原理图修改',{recordUndo:false});
  }

  // --- Dialogs: `I` Instance Picker, `Q` Properties, `L` Net Label, Editable Source, Save/PR ---
  function openInstancePicker(){
    const info=activeFileInfo();
    if(!info)return;
    const ctx=getProjectContext()||{};
    const items=buildInstanceCatalog({
      doc,
      activeLibrary:ctx.activeLibrary||null,
      verilogaModels:getVerilogAModels()||[],
    });
    const categories=['全部',...new Set(items.map(i=>i.category))];

    const dialog=el('dialog',undefined,'cg-ed-dialog cg-ed-picker-dialog');
    dialog.setAttribute('aria-label','调用器件 / 实例 (I)');
    let activeCat='全部',searchVal='',chosen=items[0]||null;
    let customName='',customParams=chosen?formatParamsList(chosen.params):'';

    const renderPicker=()=>{
      dialog.replaceChildren();
      const head=el('header',undefined,'cg-ed-dialog-head');
      head.append(el('strong','调用器件 / 子电路实例 (I)'));
      const closeBtn=el('button','×','cg-ed-close');closeBtn.type='button';closeBtn.onclick=()=>dialog.close();
      head.append(closeBtn);
      dialog.append(head);

      const body=el('div',undefined,'cg-ed-dialog-body');
      const search=document.createElement('input');
      search.type='search';search.className='cg-ed-search';search.placeholder='搜索器件型号、MOS、子电路或 Verilog-A 模块…';
      search.value=searchVal;
      search.oninput=()=>{searchVal=search.value;renderList();};

      const tabs=el('div',undefined,'cg-ed-cat-tabs');
      for(const cat of categories){
        const b=el('button',cat,'cg-ed-cat-btn'+(activeCat===cat?' is-active':''));
        b.type='button';
        b.onclick=()=>{activeCat=cat;renderPicker();};
        tabs.append(b);
      }

      const list=el('div',undefined,'cg-ed-picker-list');
      const configBox=el('div',undefined,'cg-ed-picker-config');

      const renderConfig=()=>{
        configBox.replaceChildren();
        if(!chosen){configBox.append(el('p','未选中器件。','cg-ed-muted'));return;}
        configBox.append(el('div',`已选：${chosen.label} · 端口：${chosen.ports.join(', ')}`,'cg-ed-picker-sel'));
        if(chosen.virtualKind!=='ground'){
          const row1=el('div',undefined,'cg-ed-inline-fields');
          const lName=el('label');lName.append(el('span','实例名（留空自动编号）'));
          const iName=document.createElement('input');iName.placeholder=`例如 ${chosen.prefix}1`;iName.value=customName;
          iName.oninput=()=>{customName=iName.value.trim();};
          lName.append(iName);
          const lParams=el('label');lParams.append(el('span','Spectre 参数'));
          const iParams=document.createElement('input');iParams.placeholder='例如 r=1k 或 w=500n l=30n';iParams.value=customParams;
          iParams.oninput=()=>{customParams=iParams.value;};
          lParams.append(iParams);
          row1.append(lName,lParams);
          configBox.append(row1);
        }
      };

      const renderList=()=>{
        list.replaceChildren();
        const q=searchVal.trim().toLowerCase();
        const filtered=items.filter(item=>(activeCat==='全部'||item.category===activeCat)&&(!q||`${item.name} ${item.label} ${item.category} ${item.model}`.toLowerCase().includes(q)));
        if(!filtered.length){list.append(el('p','没有匹配的器件或子电路。','cg-ed-muted'));return;}
        for(const item of filtered){
          const rowBtn=el('button',undefined,'cg-ed-picker-item'+(chosen?.id===item.id?' is-active':''));
          rowBtn.type='button';
          rowBtn.append(
            el('strong',item.label),
            el('span',item.category,'cg-ed-cat-tag'),
          );
          rowBtn.onclick=()=>{
            chosen=item;customName='';customParams=formatParamsList(item.params);
            renderList();renderConfig();
          };
          rowBtn.ondblclick=()=>confirmPlace();
          list.append(rowBtn);
        }
      };

      const confirmPlace=()=>{
        if(!chosen)return;
        placingSpec={...chosen,customName,customParams};
        placingOrient='R0';
        dialog.close();
        tool='place';
        canvas.classList.add('cg-ed-crosshair');
        refreshUI();
        renderOverlay();
        notify(`已选择 ${chosen.label}：移动鼠标到画布目标位置点击放置（按 R 可旋转，Esc 取消）。`);
      };

      const actions=el('footer',undefined,'cg-ed-dialog-actions');
      const cancelBtn=el('button','取消','cg-ed-btn');cancelBtn.type='button';cancelBtn.onclick=()=>dialog.close();
      const placeBtn=el('button','去画布放置 →','cg-ed-btn cg-ed-btn-primary');placeBtn.type='button';placeBtn.onclick=confirmPlace;
      actions.append(cancelBtn,placeBtn);

      body.append(search,tabs,list,configBox);
      dialog.append(body,actions);
      renderList();renderConfig();
      requestAnimationFrame(()=>search.focus());
    };

    dialog.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(e.key==='Enter'&&e.target.tagName!=='BUTTON'){e.preventDefault();dialog.querySelector('.cg-ed-btn-primary')?.click();}
    });
    dialog.addEventListener('close',()=>dialog.remove());
    document.body.append(dialog);
    renderPicker();
    dialog.showModal();
  }

  function openPropertiesDialog(){
    const info=activeFileInfo();
    const obj=selectedInstanceObject();
    if(!info||!obj){notify('请先在画布中点击选中一个器件，再按 Q 编辑属性。');return;}
    const parsed=parseEditableScope(info.text,info.scopeName);
    const inst=parsed.instances.find(i=>i.name===obj.name);
    if(!inst){notify(`未能解析器件 ${obj.name} 的网表语句，可点击「源码」直接编辑。`,{kind:'warning'});return;}

    const dialog=el('dialog',undefined,'cg-ed-dialog cg-ed-props-dialog');
    dialog.setAttribute('aria-label',`编辑器件属性 · ${inst.name}`);
    let nameVal=inst.name,modelVal=inst.model,nodesVal=inst.nodes.join(' ');
    const paramRows=inst.params.map(p=>({...p}));

    const renderProps=()=>{
      dialog.replaceChildren();
      const head=el('header',undefined,'cg-ed-dialog-head');
      head.append(el('strong',`器件属性 (Q) · ${inst.name}`));
      const closeBtn=el('button','×','cg-ed-close');closeBtn.type='button';closeBtn.onclick=()=>dialog.close();
      head.append(closeBtn);
      dialog.append(head);

      const body=el('div',undefined,'cg-ed-dialog-body');
      const form=el('div',undefined,'cg-ed-form');
      const rowTop=el('div',undefined,'cg-ed-inline-fields');
      const l1=el('label');l1.append(el('span','器件名称'));
      const i1=document.createElement('input');i1.value=nameVal;i1.oninput=()=>{nameVal=i1.value;};l1.append(i1);
      const l2=el('label');l2.append(el('span','型号 / 子电路'));
      const i2=document.createElement('input');i2.value=modelVal;i2.oninput=()=>{modelVal=i2.value;};l2.append(i2);
      rowTop.append(l1,l2);

      const l3=el('label');l3.append(el('span','端口连接网络（空格分隔）'));
      const i3=document.createElement('input');i3.value=nodesVal;i3.oninput=()=>{nodesVal=i3.value;};l3.append(i3);
      form.append(rowTop,l3);

      const pHead=el('div',undefined,'cg-ed-subhead');
      pHead.append(el('span','器件参数（Spectre 原始表达式）'));
      const addP=el('button','+ 新增参数','cg-ed-btn-mini');addP.type='button';
      addP.onclick=()=>{paramRows.push({name:'',value:''});renderProps();};
      pHead.append(addP);
      form.append(pHead);

      const pList=el('div',undefined,'cg-ed-param-list');
      paramRows.forEach((row,idx)=>{
        const r=el('div',undefined,'cg-ed-param-row');
        const kn=document.createElement('input');kn.placeholder='参数名 (如 w / l / r)';kn.value=row.name;kn.oninput=()=>{row.name=kn.value;};
        const kv=document.createElement('input');kv.placeholder='参数值 (如 500n / 2k)';kv.value=row.value;kv.oninput=()=>{row.value=kv.value;};
        const del=el('button','×','cg-ed-btn-mini');del.type='button';del.title='删除参数';del.onclick=()=>{paramRows.splice(idx,1);renderProps();};
        r.append(kn,kv,del);
        pList.append(r);
      });
      if(!paramRows.length)pList.append(el('p','当前器件无额外参数，点击「+ 新增参数」添加。','cg-ed-muted'));
      form.append(pList);
      body.append(form);

      const actions=el('footer',undefined,'cg-ed-dialog-actions');
      const cancelBtn=el('button','取消','cg-ed-btn');cancelBtn.type='button';cancelBtn.onclick=()=>dialog.close();
      const applyBtn=el('button','应用到画布','cg-ed-btn cg-ed-btn-primary');applyBtn.type='button';
      applyBtn.onclick=async()=>{
        try{
          const res=updateInstanceProperties(info.text,{
            scopeName:info.scopeName,
            instanceName:inst.name,
            newName:nameVal,
            model:modelVal,
            nodes:nodesVal.trim().split(/\s+/).filter(Boolean),
            params:paramRows,
          });
          dialog.close();
          await applyTextChange(res.text,res.summary);
        }catch(err){notify(err.message,{kind:'error'});}
      };
      actions.append(cancelBtn,applyBtn);
      dialog.append(body,actions);
    };

    dialog.addEventListener('keydown',e=>e.stopPropagation());
    dialog.addEventListener('close',()=>dialog.remove());
    document.body.append(dialog);
    renderProps();
    dialog.showModal();
  }

  function openNetLabelDialog({oldNet='',x=null,y=null}={}){
    const info=activeFileInfo();
    if(!info)return;
    const dialog=el('dialog',undefined,'cg-ed-dialog cg-ed-small-dialog');
    dialog.setAttribute('aria-label','网络标号 (L)');
    const head=el('header',undefined,'cg-ed-dialog-head');
    head.append(el('strong','网络标号 / 重命名网络 (L)'));
    const closeBtn=el('button','×','cg-ed-close');closeBtn.type='button';closeBtn.onclick=()=>dialog.close();
    head.append(closeBtn);

    const body=el('div',undefined,'cg-ed-dialog-body');
    const form=el('div',undefined,'cg-ed-form');
    if(oldNet)form.append(el('p',`原网络名：${oldNet}（将同步更新当前层级所有引用该网络的引脚和导线）`,'cg-ed-muted'));
    const lbl=el('label');lbl.append(el('span','新网络名称'));
    const inp=document.createElement('input');inp.value=oldNet||'';inp.placeholder='例如 vout / clk_a / VDD';
    lbl.append(inp);form.append(lbl);body.append(form);

    const actions=el('footer',undefined,'cg-ed-dialog-actions');
    const cancelBtn=el('button','取消','cg-ed-btn');cancelBtn.type='button';cancelBtn.onclick=()=>dialog.close();
    const okBtn=el('button','应用网络名','cg-ed-btn cg-ed-btn-primary');okBtn.type='button';
    const submit=async()=>{
      try{
        const res=labelNet(info.text,{scopeName:info.scopeName,oldNet,newNet:inp.value,x,y});
        dialog.close();
        setTool('select');
        await applyTextChange(res.text,res.summary);
      }catch(err){notify(err.message,{kind:'error'});}
    };
    okBtn.onclick=()=>void submit();
    actions.append(cancelBtn,okBtn);
    dialog.append(head,body,actions);
    dialog.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(e.key==='Enter'){e.preventDefault();void submit();}
    });
    dialog.addEventListener('close',()=>dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    requestAnimationFrame(()=>{inp.focus();inp.select();});
  }

  function openSourceEditor(){
    const info=activeFileInfo();
    if(!info)return;
    const dialog=el('dialog',undefined,'cg-ed-dialog cg-ed-source-dialog');
    dialog.setAttribute('aria-label','编辑电路源码');
    const head=el('header',undefined,'cg-ed-dialog-head');
    head.append(el('strong',`编辑源码 · ${info.filePath.split('/').pop()||info.filePath}`));
    const closeBtn=el('button','×','cg-ed-close');closeBtn.type='button';closeBtn.onclick=()=>dialog.close();
    head.append(closeBtn);

    const body=el('div',undefined,'cg-ed-dialog-body');
    body.append(el('p',`当前文件：${info.filePath} · 修改后点击「应用到画布」即可实时编译重绘，再点「提交 PR」写回本机并推送。`,'cg-ed-muted'));
    const area=document.createElement('textarea');
    area.className='cg-ed-source-area';area.spellcheck=false;area.value=info.text;
    body.append(area);

    const actions=el('footer',undefined,'cg-ed-dialog-actions');
    const cancelBtn=el('button','关闭','cg-ed-btn');cancelBtn.type='button';cancelBtn.onclick=()=>dialog.close();
    const applyBtn=el('button','应用到画布','cg-ed-btn');applyBtn.type='button';
    applyBtn.onclick=async()=>{
      const ok=await applyTextChange(area.value,'编辑网表源码');
      if(ok)dialog.close();
    };
    const savePrBtn=el('button','应用并保存 / 提交 PR →','cg-ed-btn cg-ed-btn-primary');savePrBtn.type='button';
    savePrBtn.onclick=async()=>{
      const ok=await applyTextChange(area.value,'编辑网表源码');
      if(ok){dialog.close();openSavePr();}
    };
    actions.append(cancelBtn,applyBtn,savePrBtn);
    dialog.append(head,body,actions);
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    dialog.addEventListener('close',()=>dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  async function handleQuickSave(){
    const info=activeFileInfo();
    if(!info)return;
    const target=resolveGitTarget(info);
    const connected=bridge?.getState?.()?.connected===true;
    if(!connected||!target.library_id||!target.cell_id){
      openSavePr();
      return;
    }
    if(!isFileDirty(info.filePath)){
      notify('当前画布没有未保存的改动；如需提交或创建 PR 请点击「提交 PR」。');
      return;
    }
    try{
      const scopeArgs={library_id:target.library_id,cell_id:target.cell_id};
      const fileInfo=await bridge.request('read_file',{...scopeArgs,path:target.path});
      if(!fileInfo?.editable)throw Error('当前单元文件在本机不可写。');
      const res=await bridge.request('execute',{
        operation:'save',
        args:{...scopeArgs,path:target.path,content:info.text,base_sha256:fileInfo.sha256},
        idempotency_key:'ed-qsave-'+crypto.randomUUID(),
      });
      const state=res?.receipt?.state||res?.state||'unknown';
      if(!['complete','completed','succeeded'].includes(state))throw Error(`保存状态未确认：${state}`);
      baselines.set(info.filePath,info.text);
      refreshUI();
      notify(`已保存 ${target.fileName} 到本机工作区；点击「提交 PR」即可推送并创建 Pull Request。`);
    }catch(err){
      notify(err?.message||String(err),{kind:'error'});
    }
  }

  function openSavePr(){
    const info=activeFileInfo();
    if(!info)return;
    const target=resolveGitTarget(info);
    openSavePrDialog({
      target,
      baselineText:baselines.get(info.filePath)??info.text,
      currentText:info.text,
      editSummaries:summariesByFile.get(info.filePath)||[],
      bridge,
      onRequireConnector,
      onSaved:({text})=>{
        baselines.set(info.filePath,text);
        refreshUI();
      },
      notify,
    });
  }

  // --- Pointer & Keyboard Interactions on Canvas ---
  const onCanvasPointerMove=e=>{
    if(disposed||tool==='select')return;
    const px=clientToCanvasPx(e.clientX,e.clientY);
    cursorScene=canvasPxToScene(px.x,px.y);
    if(tool==='wire'||tool==='label')cursorSnap=snapEndpointAt(e.clientX,e.clientY);
    renderOverlay();
  };

  const onCanvasPointerDown=e=>{
    if(disposed||tool==='select'||e.button!==0)return;
    if(e.target instanceof Element&&e.target.closest('.cg-ed-bar,.cg-ed-mode-pill'))return;
    e.preventDefault();
    e.stopImmediatePropagation();

    const info=activeFileInfo();
    if(!info)return;
    const px=clientToCanvasPx(e.clientX,e.clientY);
    const sc=canvasPxToScene(px.x,px.y);
    if(!sc)return;
    const step=gridStep();

    if(tool==='place'&&placingSpec){
      const sx=snapCoord(sc.x,step),sy=snapCoord(sc.y,step);
      try{
        const res=addInstance(info.text,{
          scopeName:info.scopeName,
          name:placingSpec.customName||'',
          prefix:placingSpec.prefix||'X',
          model:placingSpec.model,
          ports:placingSpec.ports,
          paramsText:placingSpec.customParams||'',
          params:placingSpec.params,
          x:sx,
          y:sy,
          orient:placingOrient,
          symbolId:placingSpec.symbolId||'',
          symbolDef:placingSpec.symbolDef||'',
          virtualKind:placingSpec.virtualKind||null,
        });
        // Keep placingSpec active so user can place multiple like Virtuoso (Esc to stop)
        placingSpec={...placingSpec,customName:''};
        void applyTextChange(res.text,res.summary);
      }catch(err){notify(err.message,{kind:'error'});}
      return;
    }

    if(tool==='move'){
      if(!movingInst){
        // Pick instance under cursor
        const hitRes=hitsAt(info.lv,view,px);
        const instHit=(hitRes.hits||[]).find(h=>h.kind==='box'&&h.objects?.length&&doc.objects?.[h.objects[0]]?.kind==='instance');
        const instObj=instHit?doc.objects[instHit.objects[0]]:null;
        if(!instObj){notify('请点击一个器件外框来移动它。');return;}
        const parsed=parseEditableScope(info.text,info.scopeName);
        const place=parsed.placements.get(instObj.name);
        const symId=parsed.symbolBindings.get(instObj.name);
        const sym=symId?parsed.symbols.get(symId):null;
        movingInst=instObj.name;
        movingOrient=place?.orient||'R0';
        movingBox=sym?.box||[-4,-3,4,3];
        refreshUI();renderOverlay();
        return;
      }
      const sx=snapCoord(sc.x,step),sy=snapCoord(sc.y,step);
      const targetName=movingInst,targetOrient=movingOrient;
      movingInst=null;
      setTool('select');
      try{
        const res=moveInstance(info.text,{scopeName:info.scopeName,instanceName:targetName,x:sx,y:sy,orient:targetOrient});
        void applyTextChange(res.text,res.summary);
      }catch(err){notify(err.message,{kind:'error'});}
      return;
    }

    if(tool==='label'){
      const snap=snapEndpointAt(e.clientX,e.clientY);
      openNetLabelDialog({oldNet:snap?.net||'',x:snap?.x??sc.x,y:snap?.y??sc.y});
      return;
    }

    if(tool==='wire'){
      const snap=snapEndpointAt(e.clientX,e.clientY);
      if(!snap)return;
      if(!wireStart){
        wireStart=snap;
        wireWaypoints=[];
        renderOverlay();
        return;
      }
      const finishWire=async endPt=>{
        const fullPts=orthogonalPoints(wireStart,wireWaypoints,endPt);
        const midWaypoints=fullPts.slice(1,-1);
        const startCopy=wireStart;
        wireStart=null;wireWaypoints=[];
        renderOverlay();
        try{
          const res=connectWire(info.text,{scopeName:info.scopeName,start:startCopy,end:endPt,waypoints:midWaypoints});
          await applyTextChange(res.text,res.summary);
        }catch(err){notify(err.message,{kind:'error'});}
      };

      if(snap.kind==='pin'||snap.kind==='wire'||e.detail>=2){
        void finishWire(snap);
      }else{
        const fullPts=orthogonalPoints(wireStart,wireWaypoints,snap);
        wireWaypoints=fullPts.slice(1);
        renderOverlay();
      }
    }
  };

  const onKeyDown=e=>{
    if(disposed||rnlTextEditing||isProbeActive())return;
    if(isEditableFocus(e.target))return;
    // Only act when schematic canvas is visible
    if(!canvas.offsetParent)return;
    const ctrl=e.ctrlKey||e.metaKey;
    const k=e.key.toLowerCase();

    if(ctrl&&k==='z'&&!e.shiftKey){
      const info=activeFileInfo();
      if(info&&undoStacks.get(info.filePath)?.length){e.preventDefault();e.stopImmediatePropagation();void handleUndo();}
      return;
    }
    if((ctrl&&k==='y')||(ctrl&&e.shiftKey&&k==='z')){
      const info=activeFileInfo();
      if(info&&redoStacks.get(info.filePath)?.length){e.preventDefault();e.stopImmediatePropagation();void handleRedo();}
      return;
    }
    if(ctrl&&k==='s'){
      if(anyDirty()){e.preventDefault();e.stopImmediatePropagation();void handleQuickSave();}
      return;
    }
    if(ctrl||e.altKey)return;

    if(e.key==='Escape'&&tool!=='select'){
      e.preventDefault();e.stopImmediatePropagation();
      if(tool==='wire'&&wireStart){wireStart=null;wireWaypoints=[];renderOverlay();}
      else setTool('select');
      return;
    }
    if(tool==='wire'&&e.key===' '){
      e.preventDefault();e.stopImmediatePropagation();
      wireBendHFirst=!wireBendHFirst;
      renderOverlay();
      return;
    }
    if(tool==='wire'&&e.key==='Enter'&&wireStart&&cursorSnap){
      e.preventDefault();e.stopImmediatePropagation();
      const info=activeFileInfo();
      if(info){
        const fullPts=orthogonalPoints(wireStart,wireWaypoints,cursorSnap);
        const startCopy=wireStart,endCopy=cursorSnap;
        wireStart=null;wireWaypoints=[];renderOverlay();
        try{
          const res=connectWire(info.text,{scopeName:info.scopeName,start:startCopy,end:endCopy,waypoints:fullPts.slice(1,-1)});
          void applyTextChange(res.text,res.summary);
        }catch(err){notify(err.message,{kind:'error'});}
      }
      return;
    }
    if(k==='w'&&!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();startWireMode();return;}
    if(k==='i'&&!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();openInstancePicker();return;}
    if(k==='m'&&!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();startMoveMode();return;}
    if(k==='r'){e.preventDefault();e.stopImmediatePropagation();void handleRotate(e.shiftKey?'mirror-x':'rotate');return;}
    if(k==='q'&&!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();openPropertiesDialog();return;}
    if(k==='l'&&!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();startLabelMode();return;}
    if(e.key==='Delete'&&selectedInstanceObject()){e.preventDefault();e.stopImmediatePropagation();void handleDelete();return;}
  };

  // --- Refresh toolbar & mode pill state ---
  function refreshUI(){
    if(disposed)return;
    const info=activeFileInfo();
    const hasDoc=Boolean(info);
    const hasInst=Boolean(selectedInstanceObject());
    const dirty=Boolean(info&&isFileDirty(info.filePath));
    const canUndo=Boolean(info&&(undoStacks.get(info.filePath)?.length||0)>0);
    const canRedo=Boolean(info&&(redoStacks.get(info.filePath)?.length||0)>0);

    for(const id of ['select','wire','place','move','label']){
      buttons[id]?.classList.toggle('is-active',tool===id);
      if(buttons[id])buttons[id].disabled=!hasDoc||rebuilding;
    }
    buttons.rotate.disabled=!hasDoc||rebuilding||(!hasInst&&tool!=='place'&&tool!=='move');
    buttons.props.disabled=!hasDoc||rebuilding||!hasInst;
    buttons.delete.disabled=!hasDoc||rebuilding||!hasInst;
    buttons.undo.disabled=!canUndo||rebuilding;
    buttons.redo.disabled=!canRedo||rebuilding;
    buttons.source.disabled=!hasDoc||rebuilding;
    buttons.save.disabled=!hasDoc||rebuilding;
    buttons.pr.disabled=!hasDoc||rebuilding;

    buttons.save.classList.toggle('is-dirty',dirty);
    buttons.save.querySelector('.cg-ed-tool-label').textContent=dirty?'保存 ●':'保存';
    buttons.pr.classList.toggle('is-highlighted',dirty);

    if(tool==='select'){
      modePill.hidden=true;
    }else{
      modePill.hidden=false;
      const msg=tool==='wire'
        ? (wireStart?'连线中 (W) · 点击目标引脚/导线完成，点空白处加拐点，Space 切换折线方向，Enter 结束，Esc 取消':'连线模式 (W) · 点击起点引脚或导线开始连线，Esc 退出')
        : tool==='place'
          ? `放置器件 (I)：${placingSpec?.label||''} · 移动鼠标对齐网格，R 旋转，左键点击放置，Esc 结束`
          : tool==='move'
            ? (movingInst?`移动器件 (M)：${movingInst} · 移动鼠标到目标位置，R 旋转，左键落地，Esc 取消`:'移动模式 (M) · 请点击画布上要移动的器件，Esc 退出')
            : '标号模式 (L) · 点击画布上的导线或引脚为其重命名，Esc 退出';
      modePill.textContent=msg;
    }
  }

  function resetBaselines(){
    baselines.clear();
    undoStacks.clear();
    redoStacks.clear();
    summariesByFile.clear();
    cachedPinsKey='';
    setTool('select');
    refreshUI();
  }

  const onViewerChange=()=>{cachedPinsKey='';refreshUI();renderOverlay();};
  canvas.addEventListener('pointermove',onCanvasPointerMove);
  canvas.addEventListener('pointerdown',onCanvasPointerDown,true);
  document.addEventListener('keydown',onKeyDown,true);
  window.addEventListener('viewer-selection',onViewerChange);
  window.addEventListener('viewer-level',onViewerChange);
  window.addEventListener('viewer-navigate',onViewerChange);
  window.addEventListener('resize',renderOverlay);

  refreshUI();

  return {
    refresh:refreshUI,
    resetBaselines,
    openSourceEditor,
    openSavePr,
    openInstancePicker,
    isDirty:anyDirty,
    destroy(){
      disposed=true;
      canvas.removeEventListener('pointermove',onCanvasPointerMove);
      canvas.removeEventListener('pointerdown',onCanvasPointerDown,true);
      document.removeEventListener('keydown',onKeyDown,true);
      window.removeEventListener('viewer-selection',onViewerChange);
      window.removeEventListener('viewer-level',onViewerChange);
      window.removeEventListener('viewer-navigate',onViewerChange);
      window.removeEventListener('resize',renderOverlay);
      canvas.classList.remove('cg-ed-crosshair');
      toolbar.remove();
      modePill.remove();
      overlaySvg.remove();
      css.remove();
    },
  };
}
