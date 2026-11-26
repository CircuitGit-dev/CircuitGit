// Clean, zero-clutter Virtuoso-style schematic editor layered over the vendored RNL viewer.
// Canvas remains unobstructed: all editing shortcuts (W/I/M/R/Q/L/Del/Ctrl+Z) work silently on
// the canvas and are documented under Help; a single "提交 PR" button lives in the provenance bar.
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
import {buildCustomDeviceSpec,buildInstanceCatalog} from './catalog.js';
import {openSavePrDialog} from './pr-dialog.js';

const SVG_NS='http://www.w3.org/2000/svg';

export const SCHEMATIC_SHORTCUTS=[
  ['I','调用并放置器件 / PDK 晶体管 / 子电路 / Verilog-A 实例'],
  ['W','正交连线（自动吸附引脚并同步合并 Spectre 网表网络；Space 切换折线方向）'],
  ['M','移动选中器件（或进入移动模式后点击目标器件）'],
  ['R / Shift+R','逆时针旋转选中器件 90° / 水平镜像翻转（放置或移动中同样生效）'],
  ['Q','编辑选中器件属性（名称、型号、端口网络与 Spectre 参数）'],
  ['L','重命名网络并添加网络标号（同步更新当前层级所有引脚与导线）'],
  ['Delete','删除选中器件及其关联 RNL 连线'],
  ['Ctrl+Z / Ctrl+Y','撤销 / 重做画布修改'],
  ['Ctrl+S','保存修改并提交 Pull Request'],
  ['Esc','退出当前连线 / 放置 / 移动模式'],
];

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
  getPdkSession=()=>null,
  onOpenPdkSetup=null,
  isProbeActive=()=>false,
  bridge=null,
  onRequireConnector=null,
  onDocumentUpdated=()=>{},
  notify=()=>{},
}={}){
  const canvas=document.getElementById('canvas');
  if(!canvas)return {refresh(){},resetBaselines(){},openSourceEditor(){},openSavePr(){},openInstancePicker(){},showShortcutsHelp(){},isDirty:()=>false,destroy(){}};

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

  const baselines=new Map();
  const undoStacks=new Map();
  const redoStacks=new Map();
  const summariesByFile=new Map();

  // --- Minimal Chrome: ONLY one "提交 PR" button in `.studio-provenance` + transient mode pill ---
  const provenance=document.getElementById('studio-provenance');
  const prButton=el('button','提交 PR','cg-ed-prov-pr');
  prButton.id='studio-pr-button';
  prButton.type='button';
  prButton.title='预览 RNL / 网表改动并提交 Pull Request (Ctrl+S)';
  prButton.addEventListener('click',()=>openSavePr());
  if(provenance)provenance.append(prButton);

  const modePill=el('div',undefined,'cg-ed-mode-pill');
  modePill.hidden=true;
  modePill.addEventListener('pointerdown',e=>e.stopPropagation());

  const overlaySvg=svgEl('svg',{class:'cg-ed-overlay','aria-hidden':'true'});
  canvas.append(overlaySvg,modePill);

  // --- Helpers ---
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

    let bestPin=null,bestDist=snapPx;
    for(const pin of worldPinsForCurrent()){
      const pt=sceneToCanvasPx(pin.x,pin.y);
      if(!pt)continue;
      const d=Math.hypot(pt.x-px.x,pt.y-px.y);
      if(d<=bestDist){bestDist=d;bestPin={kind:'pin',...pin};}
    }
    if(bestPin)return bestPin;

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

  function renderOverlay(){
    overlaySvg.replaceChildren();
    if(!view||!doc||tool==='select')return;

    if(tool==='wire'){
      for(const pin of worldPinsForCurrent()){
        const pt=sceneToCanvasPx(pin.x,pin.y);
        if(!pt)continue;
        overlaySvg.append(svgEl('circle',{cx:pt.x,cy:pt.y,r:3.5,class:'cg-ed-pin-dot'}));
      }
    }

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

  function startWireMode(){if(activeFileInfo())setTool('wire');}

  function startLabelMode(){
    if(!activeFileInfo())return;
    const obj=selected!==null&&selected!==undefined?doc?.objects?.[selected]:null;
    if(obj?.kind==='net'&&obj.name){openNetLabelDialog({oldNet:obj.name});return;}
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
      refreshUI();renderOverlay();
    }else{
      tool='move';movingInst=null;
      canvas.classList.add('cg-ed-crosshair');
      refreshUI();
      notify('请在画布上点击要移动的器件，或先选中器件再按 M。');
    }
  }

  async function handleRotate(mode='rotate'){
    if(tool==='place'&&placingSpec){placingOrient=nextOrientation(placingOrient,mode);renderOverlay();return;}
    if(tool==='move'&&movingInst){movingOrient=nextOrientation(movingOrient,mode);renderOverlay();return;}
    const info=activeFileInfo(),obj=selectedInstanceObject();
    if(!info||!obj){notify('请先选中一个器件再按 R 旋转。');return;}
    try{
      const res=rotateInstance(info.text,{scopeName:info.scopeName,instanceName:obj.name,mode});
      await applyTextChange(res.text,res.summary);
    }catch(err){notify(err.message,{kind:'error'});}
  }

  async function handleDelete(){
    const info=activeFileInfo(),obj=selectedInstanceObject();
    if(!info||!obj)return;
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
    redo.push(info.text);redoStacks.set(info.filePath,redo);
    await applyTextChange(prev,'撤销上一步修改',{recordUndo:false});
  }

  async function handleRedo(){
    const info=activeFileInfo();
    if(!info)return;
    const redo=redoStacks.get(info.filePath);
    if(!redo?.length)return;
    const next=redo.pop();
    const undo=undoStacks.get(info.filePath)||[];
    undo.push(info.text);undoStacks.set(info.filePath,undo);
    await applyTextChange(next,'重做修改',{recordUndo:false});
  }

  // --- Dialogs: Help Shortcuts, `I` Instance Picker (with PDK status + custom model), `Q` Props, `L` Label, Source, PR ---
  function showShortcutsHelp(){
    const dialog=el('dialog',undefined,'cg-ed-dialog cg-ed-shortcuts-dialog');
    dialog.setAttribute('aria-label','原理图编辑快捷键');
    const head=el('header',undefined,'cg-ed-dialog-head');
    head.append(el('strong','原理图编辑快捷键（Virtuoso 风格）'));
    const closeBtn=el('button','×','cg-ed-close');closeBtn.type='button';closeBtn.onclick=()=>dialog.close();
    head.append(closeBtn);

    const body=el('div',undefined,'cg-ed-dialog-body');
    body.append(el('p','在原理图画布中直接按键即可编辑（无需切换到额外编辑栏）；修改完成后按 Ctrl+S 或点画布右上角「提交 PR」即可预览 RNL 差异并提交 Pull Request。','cg-ed-muted'));
    const table=el('table',undefined,'cg-ed-shortcuts-table');
    const tbody=document.createElement('tbody');
    for(const [k,desc] of SCHEMATIC_SHORTCUTS){
      const tr=document.createElement('tr');
      const td1=document.createElement('td');
      td1.append(el('kbd',k,'cg-ed-kbd'));
      const td2=el('td',desc);
      tr.append(td1,td2);
      tbody.append(tr);
    }
    table.append(tbody);
    body.append(table);

    const actions=el('footer',undefined,'cg-ed-dialog-actions');
    const okBtn=el('button','知道了','cg-ed-btn cg-ed-btn-primary');okBtn.type='button';okBtn.onclick=()=>dialog.close();
    actions.append(okBtn);
    dialog.append(head,body,actions);
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    dialog.addEventListener('close',()=>dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  function openInstancePicker(){
    const info=activeFileInfo();
    if(!info)return;
    const ctx=getProjectContext()||{};
    const items=buildInstanceCatalog({
      doc,
      activeLibrary:ctx.activeLibrary||null,
      verilogaModels:getVerilogAModels()||[],
      pdkSession:getPdkSession?.()||null,
    });
    const pdkStatus=items.pdkStatus||{detected:false,label:'',pdkModelCount:0,docModelCount:0};
    const categories=['全部',...new Set(items.map(i=>i.category))];

    const dialog=el('dialog',undefined,'cg-ed-dialog cg-ed-picker-dialog');
    dialog.setAttribute('aria-label','调用器件 / 实例 (I)');
    let activeCat='全部',searchVal='',chosen=items[0]||null;
    let customName='',customParams=chosen?formatParamsList(chosen.params):'';
    let customModelName='',customKind='nmos',customModelParams='l=30n w=250n nf=1 multi=1';

    const renderPicker=()=>{
      dialog.replaceChildren();
      const head=el('header',undefined,'cg-ed-dialog-head');
      head.append(el('strong','调用器件 / 实例 (I)'));
      const closeBtn=el('button','×','cg-ed-close');closeBtn.type='button';closeBtn.onclick=()=>dialog.close();
      head.append(closeBtn);
      dialog.append(head);

      const body=el('div',undefined,'cg-ed-dialog-body');

      // Honest PDK detection status banner
      const pdkBar=el('div',undefined,'cg-ed-pdk-banner'+(pdkStatus.detected?' is-detected':''));
      const pdkText=pdkStatus.detected
        ? `● 已接入远端 PDK：${pdkStatus.label}${pdkStatus.pdkModelCount?`（已读取 ${pdkStatus.pdkModelCount} 个晶体管/器件模型）`:''}`
        : `未检测到已绑定的远端 PDK（当前列出通用器件${pdkStatus.docModelCount?`与本工程已使用的 ${pdkStatus.docModelCount} 个 PDK 型号`:''}）。`;
      pdkBar.append(el('span',pdkText));
      if(!pdkStatus.detected&&typeof onOpenPdkSetup==='function'){
        const pdkBtn=el('button','去仿真面板探测 PDK →','cg-ed-btn-mini');
        pdkBtn.type='button';
        pdkBtn.onclick=()=>{dialog.close();onOpenPdkSetup();};
        pdkBar.append(pdkBtn);
      }
      body.append(pdkBar);

      const search=document.createElement('input');
      search.type='search';search.className='cg-ed-search';search.placeholder='搜索晶体管、PDK 型号、基础器件、子电路或 Verilog-A 模块…';
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
        if(!filtered.length){list.append(el('p','没有匹配的器件；可在下方「输入自定义 PDK 型号」中直接指定任意工艺模型。','cg-ed-muted'));return;}
        for(const item of filtered){
          const rowBtn=el('button',undefined,'cg-ed-picker-item'+(chosen?.id===item.id?' is-active':''));
          rowBtn.type='button';
          rowBtn.append(el('strong',item.label),el('span',item.category,'cg-ed-cat-tag'));
          rowBtn.onclick=()=>{
            chosen=item;customName='';customParams=formatParamsList(item.params);
            renderList();renderConfig();
          };
          rowBtn.ondblclick=()=>confirmPlace();
          list.append(rowBtn);
        }
      };

      // Custom PDK model drawer for arbitrary foundry transistors/devices
      const customFold=el('details',undefined,'cg-ed-custom-fold');
      customFold.append(el('summary','输入自定义 PDK 型号（例如 nch_svt_mac / nfet_01v8 / rppoly）'));
      const customGrid=el('div',undefined,'cg-ed-custom-grid');
      const cmModel=document.createElement('input');cmModel.placeholder='PDK 型号名（如 nch_hvt_mac）';cmModel.value=customModelName;cmModel.oninput=()=>{customModelName=cmModel.value;};
      const cmKind=document.createElement('select');
      for(const [val,lbl] of [['nmos','NMOS (4T)'],['pmos','PMOS (4T)'],['resistor','电阻 (2T)'],['capacitor','电容 (2T)'],['subckt','子电路框图']]){
        cmKind.add(new Option(lbl,val));
      }
      cmKind.value=customKind;cmKind.onchange=()=>{customKind=cmKind.value;};
      const cmParams=document.createElement('input');cmParams.placeholder='参数（如 l=30n w=250n nf=1）';cmParams.value=customModelParams;cmParams.oninput=()=>{customModelParams=cmParams.value;};
      const cmUse=el('button','使用此型号放置','cg-ed-btn-mini');cmUse.type='button';
      cmUse.onclick=()=>{
        try{
          const spec=buildCustomDeviceSpec(customModelName,{kind:customKind,paramsText:customModelParams});
          placingSpec={...spec,customName:'',customParams:formatParamsList(spec.params)};
          placingOrient='R0';
          dialog.close();
          tool='place';
          canvas.classList.add('cg-ed-crosshair');
          refreshUI();renderOverlay();
          notify(`已选择自定义型号 ${spec.model}：点击画布放置（R 旋转，Esc 取消）。`);
        }catch(err){notify(err.message,{kind:'error'});}
      };
      customGrid.append(cmModel,cmKind,cmParams,cmUse);
      customFold.append(customGrid);

      const confirmPlace=()=>{
        if(!chosen)return;
        placingSpec={...chosen,customName,customParams};
        placingOrient='R0';
        dialog.close();
        tool='place';
        canvas.classList.add('cg-ed-crosshair');
        refreshUI();renderOverlay();
        notify(`已选择 ${chosen.label}：移动鼠标点击画布放置（R 旋转，Esc 取消）。`);
      };

      const actions=el('footer',undefined,'cg-ed-dialog-actions');
      const cancelBtn=el('button','取消','cg-ed-btn');cancelBtn.type='button';cancelBtn.onclick=()=>dialog.close();
      const placeBtn=el('button','去画布放置 →','cg-ed-btn cg-ed-btn-primary');placeBtn.type='button';placeBtn.onclick=confirmPlace;
      actions.append(cancelBtn,placeBtn);

      body.append(search,tabs,list,configBox,customFold);
      dialog.append(body,actions);
      renderList();renderConfig();
      requestAnimationFrame(()=>search.focus());
    };

    dialog.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(e.key==='Enter'&&e.target.tagName!=='BUTTON'&&!e.target.closest('.cg-ed-custom-fold')){e.preventDefault();dialog.querySelector('.cg-ed-btn-primary')?.click();}
    });
    dialog.addEventListener('close',()=>dialog.remove());
    document.body.append(dialog);
    renderPicker();
    dialog.showModal();
  }

  function openPropertiesDialog(){
    const info=activeFileInfo(),obj=selectedInstanceObject();
    if(!info||!obj){notify('请先选中一个器件，再按 Q 编辑属性。');return;}
    const parsed=parseEditableScope(info.text,info.scopeName);
    const inst=parsed.instances.find(i=>i.name===obj.name);
    if(!inst){notify(`未能解析器件 ${obj.name} 的网表语句，可点击「查看 / 编辑源码…」直接修改。`,{kind:'warning'});return;}

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
    body.append(el('p',`当前文件：${info.filePath} · 应用到画布后按 Ctrl+S 或点「提交 PR」即可推送 Pull Request。`,'cg-ed-muted'));
    const area=document.createElement('textarea');
    area.className='cg-ed-source-area';area.spellcheck=false;area.value=info.text;
    body.append(area);

    const actions=el('footer',undefined,'cg-ed-dialog-actions');
    const cancelBtn=el('button','关闭','cg-ed-btn');cancelBtn.type='button';cancelBtn.onclick=()=>dialog.close();
    const applyBtn=el('button','应用到画布','cg-ed-btn');applyBtn.type='button';
    applyBtn.onclick=async()=>{const ok=await applyTextChange(area.value,'编辑网表源码');if(ok)dialog.close();};
    const prBtn=el('button','应用并提交 PR →','cg-ed-btn cg-ed-btn-primary');prBtn.type='button';
    prBtn.onclick=async()=>{const ok=await applyTextChange(area.value,'编辑网表源码');if(ok){dialog.close();openSavePr();}};
    actions.append(cancelBtn,applyBtn,prBtn);
    dialog.append(head,body,actions);
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    dialog.addEventListener('close',()=>dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
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

  // --- Pointer & Keyboard Interactions ---
  const onCanvasPointerMove=e=>{
    if(disposed||tool==='select')return;
    const px=clientToCanvasPx(e.clientX,e.clientY);
    cursorScene=canvasPxToScene(px.x,px.y);
    if(tool==='wire'||tool==='label')cursorSnap=snapEndpointAt(e.clientX,e.clientY);
    renderOverlay();
  };

  const onCanvasPointerDown=e=>{
    if(disposed||tool==='select'||e.button!==0)return;
    if(e.target instanceof Element&&e.target.closest('.cg-ed-mode-pill'))return;
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
        placingSpec={...placingSpec,customName:''};
        void applyTextChange(res.text,res.summary);
      }catch(err){notify(err.message,{kind:'error'});}
      return;
    }

    if(tool==='move'){
      if(!movingInst){
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
      if(!wireStart){wireStart=snap;wireWaypoints=[];renderOverlay();return;}
      const finishWire=async endPt=>{
        const fullPts=orthogonalPoints(wireStart,wireWaypoints,endPt);
        const startCopy=wireStart;
        wireStart=null;wireWaypoints=[];renderOverlay();
        try{
          const res=connectWire(info.text,{scopeName:info.scopeName,start:startCopy,end:endPt,waypoints:fullPts.slice(1,-1)});
          await applyTextChange(res.text,res.summary);
        }catch(err){notify(err.message,{kind:'error'});}
      };
      if(snap.kind==='pin'||snap.kind==='wire'||e.detail>=2)void finishWire(snap);
      else{wireWaypoints=orthogonalPoints(wireStart,wireWaypoints,snap).slice(1);renderOverlay();}
    }
  };

  const onKeyDown=e=>{
    if(disposed||rnlTextEditing||isProbeActive())return;
    if(isEditableFocus(e.target))return;
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
      if(activeFileInfo()){e.preventDefault();e.stopImmediatePropagation();openSavePr();}
      return;
    }
    if(ctrl||e.altKey)return;

    if(e.key==='Escape'&&tool!=='select'){
      e.preventDefault();e.stopImmediatePropagation();
      if(tool==='wire'&&wireStart){wireStart=null;wireWaypoints=[];renderOverlay();}
      else setTool('select');
      return;
    }
    if(tool==='wire'&&e.key===' '){e.preventDefault();e.stopImmediatePropagation();wireBendHFirst=!wireBendHFirst;renderOverlay();return;}
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

  function refreshUI(){
    if(disposed)return;
    const info=activeFileInfo();
    const dirty=Boolean(info&&isFileDirty(info.filePath));
    prButton.disabled=!info||rebuilding;
    prButton.classList.toggle('is-dirty',dirty);
    prButton.textContent=dirty?'提交 PR ●':'提交 PR';

    if(tool==='select'){
      modePill.hidden=true;
    }else{
      modePill.hidden=false;
      modePill.textContent=tool==='wire'
        ? (wireStart?'连线中 (W) · 点击目标引脚/导线完成，Space 换折向，Enter 结束，Esc 取消':'连线模式 (W) · 点击起点引脚或导线开始，Esc 退出')
        : tool==='place'
          ? `放置器件 (I)：${placingSpec?.label||''} · 左键放置，R 旋转，Esc 退出`
          : tool==='move'
            ? (movingInst?`移动器件 (M)：${movingInst} · 左键确认位置，R 旋转，Esc 取消`:'移动模式 (M) · 点击要移动的器件，Esc 退出')
            : '标号模式 (L) · 点击画布导线或引脚重命名，Esc 退出';
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
    showShortcutsHelp,
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
      prButton.remove();
      modePill.remove();
      overlaySvg.remove();
      css.remove();
    },
  };
}
