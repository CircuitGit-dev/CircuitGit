import {
  extractInstanceMaster,
  parseVerilogAModule,
  tokenizeVerilogALine,
  verilogaModuleBasename,
} from '../library/veriloga.js';
import {boxAt,hitsAt} from '../vendor/rnl-viewer/hits.js';
import {opens} from '../vendor/rnl-viewer/subcircuits.js';

function el(tag,cls,text){
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(text!==undefined)node.textContent=text;
  return node;
}

function downloadText(name,text){
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  const a=document.createElement('a');
  a.href=url;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/**
 * Mount the Verilog-A behavioral model code viewer inside a Studio dock slot.
 * Renders safe tokenized syntax highlighting (via textContent only), port & parameter
 * summaries, schematic instance binding context, and module switcher.
 */
export function mountVerilogAPanel({
  slot,
  loadLibraryFile=null,
  notify=()=>{},
}={}){
  const root=slot.element;
  const shell=el('section','cg-va-panel');
  shell.setAttribute('aria-label','Verilog-A 行为模型代码');

  const header=el('header','cg-va-head');
  const titleWrap=el('div','cg-va-title-wrap');
  const badge=el('span','cg-va-badge','Verilog-A');
  const select=document.createElement('select');
  select.className='cg-va-select';
  select.setAttribute('aria-label','切换 Verilog-A 模块');
  select.hidden=true;
  const title=el('strong','cg-va-title','Verilog-A 代码');
  titleWrap.append(badge,title,select);

  const actions=el('div','cg-va-actions');
  const jumpAnalogBtn=el('button','cg-va-btn','跳至 analog');
  jumpAnalogBtn.type='button';
  jumpAnalogBtn.hidden=true;
  const copyBtn=el('button','cg-va-btn','复制代码');
  copyBtn.type='button';
  const downloadBtn=el('button','cg-va-btn','下载 .va');
  downloadBtn.type='button';
  actions.append(jumpAnalogBtn,copyBtn,downloadBtn);
  header.append(titleWrap,actions);

  const provenance=el('div','cg-va-provenance is-empty');
  const sidebarToggleBtn=el('button','cg-va-sidebar-toggle','☰ 侧边栏');
  sidebarToggleBtn.id='studio-veriloga-sidebar-toggle';
  sidebarToggleBtn.type='button';
  sidebarToggleBtn.title='展开或收起网表与层级侧边栏';
  sidebarToggleBtn.onclick=()=>{try{window.viewer?.command?.('toggle-netlist');}catch{}};
  const provenanceText=el('span','cg-va-provenance-text','');
  provenance.append(sidebarToggleBtn,provenanceText);
  const instanceCard=el('section','cg-va-instance');
  instanceCard.hidden=true;
  const metaBar=el('section','cg-va-meta');
  metaBar.hidden=true;

  const codeWrap=el('div','cg-va-code-wrap');
  const emptyBox=el('div','cg-va-empty');

  shell.append(header,provenance,instanceCard,metaBar,codeWrap,emptyBox);
  root.replaceChildren(shell);

  let current=null;
  let available=[];
  let activeLine=null;
  let loadEpoch=0;
  const textCache=new Map();

  function cacheKey(item){
    return `${item?.libraryId||''}::${item?.path||item?.moduleName||''}`;
  }

  function renderEmpty(){
    title.textContent='Verilog-A 行为模型';
    select.hidden=true;
    jumpAnalogBtn.hidden=true;
    copyBtn.disabled=true;
    downloadBtn.disabled=true;
    provenanceText.textContent='选择左侧电路层级或下方模型即可查看 Verilog-A 源码';
    provenanceText.title='';
    provenance.classList.add('is-empty');
    instanceCard.hidden=true;
    metaBar.hidden=true;
    codeWrap.hidden=true;
    emptyBox.hidden=false;
    emptyBox.replaceChildren();

    const heading=el('h3',undefined,'尚未打开 Verilog-A 模块');
    const desc=el('p',undefined,'在原理图中单击或双击 Verilog-A 元件（例如 PIPE_RailClamp、PIPE_Clock250_250_500、RS9_IO_N06 等），或在 Library Manager 的视图栏中选择「Verilog-A 行为模型 (veriloga)」，即可在此查看行为模型源码。');
    emptyBox.append(heading,desc);

    if(available.length){
      const sub=el('div','cg-va-empty-sub','当前项目 / 电路库中可用的 Verilog-A 模型：');
      const chips=el('div','cg-va-empty-list');
      for(const item of available){
        const btn=el('button','cg-va-chip-btn',item.moduleName||verilogaModuleBasename(item.path));
        btn.type='button';
        btn.title=item.path||'';
        btn.onclick=()=>void openEntry(item,{reveal:true});
        chips.append(btn);
      }
      emptyBox.append(sub,chips);
    }
  }

  function highlightLine(lineNum,{scroll=true}={}){
    activeLine=lineNum;
    for(const row of codeWrap.querySelectorAll('.cg-va-line.is-active')){
      row.classList.remove('is-active');
    }
    if(!lineNum)return;
    const row=codeWrap.querySelector(`.cg-va-line[data-line="${lineNum}"]`);
    if(row){
      row.classList.add('is-active');
      if(scroll)row.scrollIntoView({block:'center',behavior:'smooth'});
    }
  }

  function renderCode(text,parsed){
    codeWrap.replaceChildren();
    const list=el('div','cg-va-code');
    list.setAttribute('role','region');
    list.setAttribute('aria-label',`${parsed.moduleName||'Verilog-A'} 源码`);

    const lines=String(text??'').split(/\r?\n/);
    let inBlock=false;
    for(let i=0;i<lines.length;i++){
      const lineNo=i+1;
      const row=el('div','cg-va-line');
      row.dataset.line=String(lineNo);
      if(lineNo===parsed.moduleLine)row.classList.add('is-landmark');
      if(parsed.analogLine&&lineNo===parsed.analogLine)row.classList.add('is-landmark');

      const gutter=el('span','cg-va-ln',String(lineNo));
      const content=el('span','cg-va-src');
      const res=tokenizeVerilogALine(lines[i],inBlock);
      inBlock=res.inBlockComment;
      if(!res.tokens.length){
        content.textContent='\u00A0';
      }else{
        for(const tok of res.tokens){
          if(tok.type==='plain'){
            content.append(document.createTextNode(tok.text));
          }else{
            content.append(el('span','cg-va-tok-'+tok.type,tok.text));
          }
        }
      }
      row.append(gutter,content);
      list.append(row);
    }
    codeWrap.append(list);
    codeWrap.hidden=false;
    if(activeLine)highlightLine(activeLine,{scroll:false});
  }

  function renderCurrent(){
    if(!current){renderEmpty();return;}
    emptyBox.hidden=true;
    const parsed=current.parsed||parseVerilogAModule(current.text,current.moduleName||verilogaModuleBasename(current.path));
    current.parsed=parsed;
    const displayName=parsed.moduleName||current.moduleName||verilogaModuleBasename(current.path)||'Verilog-A';
    const fileBase=(current.path||'').split('/').pop()||(displayName+'.va');

    // Module switcher when multiple models exist.
    const switcherItems=current.siblings?.length?current.siblings:available;
    if(switcherItems.length>1){
      select.replaceChildren(...switcherItems.map(item=>{
        const name=item.moduleName||verilogaModuleBasename(item.path);
        const opt=new Option(`${name} (${(item.path||'').split('/').pop()||name})`,item.path||name);
        opt.title=item.path||name;
        return opt;
      }));
      const selectedVal=current.path||displayName;
      if([...select.options].some(o=>o.value===selectedVal)){
        select.value=selectedVal;
      }else{
        const extra=new Option(`${displayName} (${fileBase})`,selectedVal);
        select.prepend(extra);
        select.value=selectedVal;
      }
      select.hidden=false;
      title.hidden=true;
    }else{
      select.hidden=true;
      title.hidden=false;
      title.textContent=`${displayName} · ${fileBase}`;
    }

    jumpAnalogBtn.hidden=!parsed.analogLine;
    copyBtn.disabled=!current.text;
    downloadBtn.disabled=!current.text;

    const metaParts=[
      current.origin?`来源：${current.origin}`:'',
      current.path||fileBase,
      `${parsed.lineCount} 行`,
    ].filter(Boolean);
    provenanceText.textContent=metaParts.join(' · ');
    provenanceText.title=current.path||fileBase;
    provenance.classList.remove('is-empty');

    // Render schematic instance context card if opened by clicking/double-clicking an instance.
    if(current.instance){
      const inst=current.instance;
      instanceCard.replaceChildren();
      const head=el('div','cg-va-instance-head');
      head.append(
        el('strong',undefined,`原理图实例 ${inst.instanceName}`),
        el('span','cg-va-instance-loc',inst.file?(inst.line?`${inst.file}:${inst.line}`:inst.file):'当前原理图')
      );
      instanceCard.append(head);

      if(inst.ports?.length){
        const portRow=el('div','cg-va-kv-row');
        portRow.append(el('span','cg-va-kv-label','端口连接'));
        const chips=el('div','cg-va-chips');
        const formalNames=parsed.expandedPorts?.length===inst.ports.length
          ? parsed.expandedPorts
          : parsed.ports.length===inst.ports.length
            ? parsed.ports.map(p=>p.name)
            : [];
        const maxShow=12;
        inst.ports.slice(0,maxShow).forEach((net,idx)=>{
          const formal=formalNames[idx];
          chips.append(el('span','cg-va-chip',formal?`${formal} → ${net}`:net));
        });
        if(inst.ports.length>maxShow){
          chips.append(el('span','cg-va-chip is-muted',`+${inst.ports.length-maxShow} 端口`));
        }
        portRow.append(chips);
        instanceCard.append(portRow);
      }

      if(inst.params?.length){
        const paramRow=el('div','cg-va-kv-row');
        paramRow.append(el('span','cg-va-kv-label','实例参数'));
        const chips=el('div','cg-va-chips');
        const paramLineByName=new Map(parsed.parameters.map(p=>[p.name.toLowerCase(),p.line]));
        for(const p of inst.params){
          const targetLine=paramLineByName.get(p.name.toLowerCase())||null;
          if(targetLine){
            const btn=el('button','cg-va-chip is-param',`${p.name}=${p.value}`);
            btn.type='button';
            btn.title=`跳转到第 ${targetLine} 行参数声明`;
            btn.onclick=()=>highlightLine(targetLine,{scroll:true});
            chips.append(btn);
          }else{
            chips.append(el('span','cg-va-chip is-param',`${p.name}=${p.value}`));
          }
        }
        paramRow.append(chips);
        instanceCard.append(paramRow);
      }
      instanceCard.hidden=false;
    }else{
      instanceCard.hidden=true;
    }

    // Module ports & parameters summary bar.
    metaBar.replaceChildren();
    if(parsed.ports.length){
      const pWrap=el('div','cg-va-meta-group');
      pWrap.append(el('span','cg-va-kv-label',`端口 (${parsed.ports.length})`));
      const text=parsed.ports.slice(0,16).map(p=>p.name).join(', ')+(parsed.ports.length>16?` … (+${parsed.ports.length-16})`:'');
      const code=el('code','cg-va-port-list',text);
      code.title=parsed.ports.map(p=>[p.direction,p.discipline,p.name].filter(Boolean).join(' ')).join(', ');
      pWrap.append(code);
      metaBar.append(pWrap);
    }
    if(parsed.parameters.length){
      const paramWrap=el('div','cg-va-meta-group');
      paramWrap.append(el('span','cg-va-kv-label',`参数 (${parsed.parameters.length})`));
      const chips=el('div','cg-va-chips');
      for(const p of parsed.parameters){
        const btn=el('button','cg-va-chip is-decl',`${p.name}=${p.defaultValue}`);
        btn.type='button';
        btn.title=`第 ${p.line} 行：parameter ${p.type} ${p.name}=${p.defaultValue}${p.range?' '+p.range:''}`;
        btn.onclick=()=>highlightLine(p.line,{scroll:true});
        chips.append(btn);
      }
      paramWrap.append(chips);
      metaBar.append(paramWrap);
    }
    metaBar.hidden=metaBar.childElementCount===0;

    renderCode(current.text,parsed);
  }

  async function resolveText(entry){
    if(typeof entry?.text==='string')return entry.text;
    const key=cacheKey(entry);
    if(textCache.has(key))return textCache.get(key);
    if(typeof loadLibraryFile==='function'&&entry?.path){
      const text=await loadLibraryFile(entry.path,entry);
      textCache.set(key,text);
      return text;
    }
    throw Error('无法读取 Verilog-A 源码：'+(entry?.path||entry?.moduleName||'未知文件'));
  }

  async function openEntry(entry,{instance=null,siblings=null,reveal=true,focusLine=null}={}){
    if(!entry)return false;
    const epoch=++loadEpoch;
    if(reveal)slot.setVisible(true);

    // Show loading feedback immediately if fetching from library.
    if(typeof entry.text!=='string'&&!textCache.has(cacheKey(entry))){
      emptyBox.hidden=true;
      codeWrap.hidden=false;
      codeWrap.replaceChildren(el('p','cg-va-loading',`正在读取 ${entry.path||entry.moduleName}…`));
    }
    try{
      const text=await resolveText(entry);
      if(epoch!==loadEpoch)return false;
      const parsed=parseVerilogAModule(text,entry.moduleName||verilogaModuleBasename(entry.path));
      current={
        moduleName:parsed.moduleName||entry.moduleName||verilogaModuleBasename(entry.path),
        path:entry.path||`${parsed.moduleName||'model'}.va`,
        origin:entry.origin||entry.libraryName||'',
        libraryId:entry.libraryId||null,
        text,
        parsed,
        instance:instance||null,
        siblings:Array.isArray(siblings)&&siblings.length?siblings:(Array.isArray(entry.siblings)&&entry.siblings.length?entry.siblings:available),
      };
      activeLine=focusLine||parsed.moduleLine||1;
      renderCurrent();
      if(focusLine)highlightLine(focusLine,{scroll:true});
      return true;
    }catch(error){
      if(epoch!==loadEpoch)return false;
      notify('打开 Verilog-A 代码失败：'+(error?.message||error),{kind:'error'});
      renderCurrent();
      return false;
    }
  }

  select.onchange=()=>{
    const items=current?.siblings?.length?current.siblings:available;
    const next=items.find(item=>(item.path||item.moduleName)===select.value);
    if(next)void openEntry(next,{instance:null,siblings:items,reveal:true});
  };
  jumpAnalogBtn.onclick=()=>{
    if(current?.parsed?.analogLine)highlightLine(current.parsed.analogLine,{scroll:true});
  };
  copyBtn.onclick=async()=>{
    if(!current?.text)return;
    try{
      await navigator.clipboard.writeText(current.text);
      notify(`已复制 ${current.moduleName||current.path} 的 Verilog-A 源码。`);
    }catch{
      notify('当前浏览器不允许自动复制，请手动选择代码复制。',{kind:'warning'});
    }
  };
  downloadBtn.onclick=()=>{
    if(!current?.text)return;
    const name=(current.path||'').split('/').pop()||`${current.moduleName||'model'}.va`;
    downloadText(name,current.text);
  };

  renderEmpty();

  return {
    openModel:openEntry,
    setAvailableModels(models){
      available=Array.isArray(models)?models:[];
      if(!current)renderEmpty();
      else if(!current.siblings?.length){current.siblings=available;renderCurrent();}
    },
    getCurrent:()=>current,
    destroy(){
      loadEpoch++;
      textCache.clear();
      shell.remove();
    },
  };
}

/**
 * Connect schematic canvas selection (single-click), double-click, and Enter key to
 * jump directly from Verilog-A behavioral instances (`obj.opens === null`) to their `.va` code.
 * Does not modify vendored RNL core files or interfere with subcircuit descent / waveform probing.
 */
export function attachSchematicVerilogAJump({
  getDoc,
  getCurrent,
  getSelected,
  getView,
  getCanvas=()=>document.getElementById('canvas'),
  getProvenance=()=>document.getElementById('studio-provenance'),
  isProbeActive=()=>false,
  resolveMaster,
  openModel,
}={}){
  let activeHit=null;
  let pill=null;
  let pillLabel=null;
  let pillBtn=null;
  let provBtn=null;
  let boundCanvas=null;

  function ensureControls(){
    const canvas=getCanvas();
    if(canvas&&(!pill||pill.parentElement!==canvas)){
      pill?.remove();
      pill=el('div','cg-va-canvas-pill');
      pill.id='studio-veriloga-pill';
      pill.hidden=true;
      pillLabel=el('span','cg-va-canvas-pill-text');
      pillBtn=el('button','cg-va-canvas-pill-btn','查看代码 ↗');
      pillBtn.type='button';
      pill.append(pillLabel,pillBtn);
      // Stop canvas pan/zoom/dblclick from hijacking clicks on the floating pill.
      for(const evt of ['pointerdown','mousedown','dblclick','click']){
        pill.addEventListener(evt,e=>e.stopPropagation());
      }
      pillBtn.onclick=()=>triggerOpen(activeHit);
      canvas.append(pill);
    }
    const prov=getProvenance();
    if(prov&&(!provBtn||provBtn.parentElement!==prov)){
      provBtn?.remove();
      provBtn=el('button','cg-va-prov-btn');
      provBtn.id='studio-veriloga-button';
      provBtn.type='button';
      provBtn.hidden=true;
      provBtn.onclick=()=>triggerOpen(activeHit);
      const sourceBtn=prov.querySelector('#studio-source-button');
      if(sourceBtn)prov.insertBefore(provBtn,sourceBtn);
      else prov.append(provBtn);
    }
    if(canvas&&boundCanvas!==canvas){
      if(boundCanvas){
        boundCanvas.removeEventListener('dblclick',onCanvasDblClick,true);
        boundCanvas.removeEventListener('keydown',onCanvasKeyDown,true);
      }
      boundCanvas=canvas;
      boundCanvas.addEventListener('dblclick',onCanvasDblClick,true);
      boundCanvas.addEventListener('keydown',onCanvasKeyDown,true);
    }
  }

  function hide(){
    activeHit=null;
    if(pill)pill.hidden=true;
    if(provBtn)provBtn.hidden=true;
  }

  function resolveObject(objIndex){
    const doc=getDoc?.();
    const levelIndex=getCurrent?.();
    if(!doc||objIndex===null||objIndex===undefined)return null;
    if(opens(objIndex)!==null)return null;
    const info=extractInstanceMaster(doc,levelIndex,objIndex);
    if(!info||info.opens!==null||!info.masterName)return null;
    const model=resolveMaster?.(info.masterName);
    if(!model)return null;
    return {info,model};
  }

  function triggerOpen(hit){
    if(!hit)return;
    void openModel?.(hit.model,{instance:hit.info,siblings:hit.model.siblings,reveal:true});
  }

  function updateFromSelection(){
    ensureControls();
    if(isProbeActive?.()){hide();return;}
    const hit=resolveObject(getSelected?.());
    if(!hit){hide();return;}
    activeHit=hit;
    const fileBase=(hit.model.path||'').split('/').pop()||`${hit.model.moduleName}.va`;
    if(pill&&pillLabel){
      pillLabel.textContent=`Verilog-A · ${hit.info.instanceName} (${fileBase})`;
      pill.title=`双击元件或点击右侧按钮可跳转到 ${fileBase}`;
      pill.hidden=false;
    }
    if(provBtn){
      provBtn.textContent=`Verilog-A: ${fileBase}`;
      provBtn.title=`查看实例 ${hit.info.instanceName} 对应的 Verilog-A 源码 (${hit.model.path||fileBase})`;
      provBtn.hidden=false;
    }
  }

  function hitObjectAtEvent(e){
    const doc=getDoc?.();
    const levelIndex=getCurrent?.();
    const view=getView?.();
    const canvas=getCanvas?.();
    if(!doc||!view||!canvas)return null;
    const level=doc.levels?.[levelIndex];
    if(!level)return null;
    const rect=canvas.getBoundingClientRect();
    const pt={x:e.clientX-rect.left,y:e.clientY-rect.top};

    const box=boxAt(level,view,pt);
    if(box){
      // Let native subcircuit descent handle anything that has an RNL subckt level.
      if(box.objects.some(k=>opens(k)!==null))return null;
      for(const k of box.objects){
        const hit=resolveObject(k);
        if(hit)return hit;
      }
      return null;
    }

    // Fallback: user double-clicked the instance's text label rather than its symbol box.
    const {hits}=hitsAt(level,view,pt);
    for(const h of hits){
      if(h.kind!=='label'&&h.kind!=='box')continue;
      if(h.objects.some(k=>opens(k)!==null))return null;
      for(const k of h.objects){
        const hit=resolveObject(k);
        if(hit)return hit;
      }
    }
    return null;
  }

  function onCanvasDblClick(e){
    if(isProbeActive?.())return;
    if(e.target?.closest?.('#enter-badge, #studio-veriloga-pill'))return;
    const hit=hitObjectAtEvent(e);
    if(!hit)return;
    // Prevent RNL's doubleAt() from falling back to fit() zoom-reset on non-subckt instances.
    e.stopImmediatePropagation();
    e.preventDefault();
    activeHit=hit;
    updateFromSelection();
    triggerOpen(hit);
  }

  function onCanvasKeyDown(e){
    if(isProbeActive?.())return;
    if(e.key!=='Enter'||e.metaKey||e.ctrlKey||e.altKey)return;
    const hit=resolveObject(getSelected?.());
    if(!hit)return;
    e.stopImmediatePropagation();
    e.preventDefault();
    triggerOpen(hit);
  }

  window.addEventListener('viewer-selection',updateFromSelection);
  window.addEventListener('viewer-level',hide);
  ensureControls();

  return {
    refresh:updateFromSelection,
    clear:hide,
    destroy(){
      window.removeEventListener('viewer-selection',updateFromSelection);
      window.removeEventListener('viewer-level',hide);
      if(boundCanvas){
        boundCanvas.removeEventListener('dblclick',onCanvasDblClick,true);
        boundCanvas.removeEventListener('keydown',onCanvasKeyDown,true);
      }
      pill?.remove();
      provBtn?.remove();
    },
  };
}
