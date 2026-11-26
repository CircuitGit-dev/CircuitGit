// Host-level enhancement for the RNL schematic sidebar without modifying vendored RNL files.
// Provides smooth dragging/width presets, decluttered single-row tabs, cleaner netlist header,
// auto-folded empty diagnostics, and an integrated Project & Circuit Hierarchy explorer in Library.
import {current,doc,path} from '../vendor/rnl-viewer/state.js';
import {uncalledRoots} from '../vendor/rnl-viewer/roots.js';
import {navigate} from '../vendor/rnl-viewer/navigation.js';
import {currentSource} from '../vendor/rnl-viewer/open.js';
import {pathRow} from '../vendor/rnl-viewer/subcircuits.js';
import {setPane,setProblems,setSidebarWidth,upright} from '../vendor/rnl-viewer/panels.js';
import {load,save} from '../vendor/rnl-viewer/util.js';
import {indexLibraryVerilogAFiles,indexSnapshotVerilogAFiles} from '../library/veriloga.js';
import {
  SIDEBAR_DEFAULT_WIDTH,
  buildCircuitHierarchyTree,
  buildProjectExplorerSummary,
  clampSidebarWidth,
  computeWideSidebarWidth,
  filterHierarchyTree,
} from './sidebar-model.js';

const SECONDARY_TABS=[
  {id:'hierarchy',label:'子电路索引与检索',shortcut:'3'},
  {id:'usages',label:'网络 / 器件用例',shortcut:'5'},
  {id:'unplaced',label:'未绘制元素',shortcut:'6'},
  {id:'solve',label:'布局求解报告',shortcut:'7'},
];

const SECONDARY_LABELS={
  hierarchy:'索引',
  usages:'用例',
  unplaced:'未绘制',
  solve:'求解',
};

export function mountSchematicSidebar({
  getProjectState=()=>({}),
  onOpenLibraryManager=null,
  onOpenImport=null,
  onOpenCell=null,
  onOpenQuickProject=null,
  onOpenVerilogA=null,
  resolveVerilogA=null,
}={}){
  const app=document.getElementById('app');
  const sidebar=document.getElementById('sidebar');
  const vsplit=document.getElementById('vsplit');
  const paneFiles=document.getElementById('pane-files');
  const sideHead=sidebar?.querySelector('.side-head');
  const viewTabs=sidebar?.querySelector('.view-tabs');
  const hideBtn=document.getElementById('hide-sidebar');
  if(!app||!sidebar||!vsplit||!paneFiles||!sideHead||!viewTabs)return {refresh(){},destroy(){}};

  let disposed=false,query='',lastDocRef=null,lastDiagnosticsKey='',lastWidthPreset='normal',savedNormalWidth=SIDEBAR_DEFAULT_WIDTH;
  const expandedPaths=new Set(['0']);

  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};

  // --- 1. Resizable width helpers + 1-click wide/narrow toggle ---
  function applyWidth(px,{persist=false}={}){
    const clamped=clampSidebarWidth(px,app.clientWidth);
    setSidebarWidth(clamped);
    document.documentElement.style.setProperty('--sidebar-w',`${clamped}px`);
    if(persist)save('sidebar-width',clamped);
    updateWideButton(clamped);
    return clamped;
  }

  function currentSidebarWidth(){
    const measured=sidebar.getBoundingClientRect().width;
    if(measured>0)return Math.round(measured);
    const cssVal=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'));
    return Number.isFinite(cssVal)&&cssVal>0?Math.round(cssVal):SIDEBAR_DEFAULT_WIDTH;
  }

  const widthToggle=el('button','↔','cg-side-icon-btn');
  widthToggle.type='button';
  widthToggle.id='cg-sidebar-width-toggle';
  widthToggle.title='加宽侧边栏方便阅读网表（也可拖动右侧分隔线或双击分隔线）';
  widthToggle.setAttribute('aria-label','切换侧边栏宽窄');

  function updateWideButton(width=currentSidebarWidth()){
    const wideThreshold=Math.max(360,Math.round((app.clientWidth||900)*0.36));
    const isWide=width>=wideThreshold;
    widthToggle.classList.toggle('is-wide',isWide);
    widthToggle.textContent=isWide?'⇥':'↔';
    widthToggle.title=isWide?'恢复标准侧边栏宽度（也可拖动分隔线）':'加宽侧边栏以完整阅读网表（也可拖动分隔线）';
  }

  widthToggle.addEventListener('click',()=>{
    const now=currentSidebarWidth();
    const wide=computeWideSidebarWidth(app.clientWidth);
    const wideThreshold=Math.max(360,Math.round((app.clientWidth||900)*0.36));
    if(now>=wideThreshold){
      lastWidthPreset='normal';
      applyWidth(Math.min(savedNormalWidth,320),{persist:true});
    }else{
      savedNormalWidth=Math.max(240,Math.min(now,320));
      lastWidthPreset='wide';
      applyWidth(wide,{persist:true});
    }
    window.dispatchEvent(new Event('resize'));
  });

  const onSplitterDoubleClick=()=>{
    if(upright.matches)return;
    const now=currentSidebarWidth();
    if(Math.abs(now-SIDEBAR_DEFAULT_WIDTH)<=24){
      applyWidth(computeWideSidebarWidth(app.clientWidth),{persist:true});
    }else{
      applyWidth(SIDEBAR_DEFAULT_WIDTH,{persist:true});
    }
    window.dispatchEvent(new Event('resize'));
  };
  vsplit.addEventListener('dblclick',onSplitterDoubleClick);

  const onSplitterPointerUp=()=>{
    if(upright.matches)return;
    requestAnimationFrame(()=>{
      if(disposed)return;
      const cssVal=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'));
      if(Number.isFinite(cssVal)&&cssVal>0){
        const clamped=clampSidebarWidth(cssVal,app.clientWidth);
        if(Math.abs(clamped-cssVal)>1){
          document.documentElement.style.setProperty('--sidebar-w',`${clamped}px`);
          save('sidebar-width',clamped);
        }
        updateWideButton(clamped);
      }
      window.dispatchEvent(new Event('resize'));
    });
  };
  vsplit.addEventListener('pointerup',onSplitterPointerUp);
  vsplit.addEventListener('pointercancel',onSplitterPointerUp);
  vsplit.title='拖动调整侧边栏宽度（双击切换宽/窄）';

  const appResizeObserver=new ResizeObserver(()=>{
    if(disposed||upright.matches||app.classList.contains('sidebar-hidden'))return;
    const cssVal=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'));
    if(Number.isFinite(cssVal)&&cssVal>0){
      const clamped=clampSidebarWidth(cssVal,app.clientWidth);
      if(clamped<cssVal-1)document.documentElement.style.setProperty('--sidebar-w',`${clamped}px`);
      updateWideButton(clamped);
    }
  });
  appResizeObserver.observe(app);

  // Restore saved user width (defaulting to a comfortable 280px instead of cramped 200px).
  const storedWidth=load('sidebar-width',null);
  applyWidth(storedWidth&&Number(storedWidth)>=200?Number(storedWidth):SIDEBAR_DEFAULT_WIDTH,{persist:false});

  // --- 2. Decluttered single-row tabs with "更多 (···)" menu for specialist panes ---
  for(const item of SECONDARY_TABS){
    document.getElementById(`tab-${item.id}`)?.classList.add('cg-secondary-tab');
  }
  const moreWrap=el('div',undefined,'cg-side-more');
  const moreBtn=el('button','···','cg-side-icon-btn cg-side-more-btn');
  moreBtn.type='button';
  moreBtn.setAttribute('aria-haspopup','menu');
  moreBtn.setAttribute('aria-expanded','false');
  moreBtn.title='更多视图（子电路索引、用例、未绘制元素）';
  const moreMenu=el('div',undefined,'cg-side-more-menu');
  moreMenu.setAttribute('role','menu');
  moreMenu.hidden=true;
  moreWrap.append(moreBtn,moreMenu);

  const headActions=el('div',undefined,'cg-side-head-actions');
  headActions.append(moreWrap,widthToggle);
  if(hideBtn)sideHead.insertBefore(headActions,hideBtn);
  else sideHead.append(headActions);

  function closeMoreMenu(){
    moreMenu.hidden=true;
    moreBtn.setAttribute('aria-expanded','false');
  }

  function renderMoreMenu(){
    moreMenu.replaceChildren();
    let activeSecondary=null;
    for(const item of SECONDARY_TABS){
      const tab=document.getElementById(`tab-${item.id}`);
      if(!tab||tab.hidden)continue;
      const isSelected=tab.getAttribute('aria-selected')==='true';
      if(isSelected)activeSecondary=item.id;
      const btn=el('button',undefined,'cg-side-more-item'+(isSelected?' is-active':''));
      btn.type='button';
      btn.setAttribute('role','menuitem');
      const countText=item.id==='unplaced'?(document.getElementById('unplaced-tab-count')?.textContent?.trim()||''):'';
      btn.append(el('span',item.label+(countText?` (${countText})`:'')),el('kbd',item.shortcut));
      btn.addEventListener('click',()=>{
        closeMoreMenu();
        setPane(item.id);
        syncMoreButton();
      });
      moreMenu.append(btn);
    }
    moreBtn.classList.toggle('is-active',Boolean(activeSecondary));
    moreBtn.textContent=activeSecondary?SECONDARY_LABELS[activeSecondary]+' ▾':'···';
  }

  function syncMoreButton(){
    let activeSecondary=null;
    for(const item of SECONDARY_TABS){
      const tab=document.getElementById(`tab-${item.id}`);
      if(tab&&!tab.hidden&&tab.getAttribute('aria-selected')==='true'){activeSecondary=item.id;break;}
    }
    moreBtn.classList.toggle('is-active',Boolean(activeSecondary));
    moreBtn.textContent=activeSecondary?SECONDARY_LABELS[activeSecondary]+' ▾':'···';
  }

  moreBtn.addEventListener('click',event=>{
    event.stopPropagation();
    if(moreMenu.hidden){
      renderMoreMenu();
      moreMenu.hidden=false;
      moreBtn.setAttribute('aria-expanded','true');
    }else{
      closeMoreMenu();
    }
  });

  const onDocumentPointerDown=event=>{
    if(!moreMenu.hidden&&!moreWrap.contains(event.target))closeMoreMenu();
  };
  document.addEventListener('pointerdown',onDocumentPointerDown);

  const tabObserver=new MutationObserver(syncMoreButton);
  for(const item of SECONDARY_TABS){
    const tab=document.getElementById(`tab-${item.id}`);
    if(tab)tabObserver.observe(tab,{attributes:true,attributeFilter:['aria-selected','hidden']});
  }
  syncMoreButton();

  // --- 3. Cleaner Netlist bar (enable built-in Options collapse on desktop + auto-fold empty problems) ---
  const netlistOptionsBtn=document.getElementById('netlist-options-button');
  if(netlistOptionsBtn){
    netlistOptionsBtn.textContent='筛选 ▾';
    netlistOptionsBtn.title='展开或收起网表筛选选项（自动引入、仅 RNL、失效语句）';
  }

  function syncDiagnosticsFold(){
    if(!doc)return;
    const issues=(doc.diagnostics||[]).filter(d=>d.severity==='error'||d.severity==='warning');
    const key=`${doc.path||''}:${issues.length}`;
    if(key===lastDiagnosticsKey)return;
    lastDiagnosticsKey=key;
    // Collapse the empty "Problems: None" tray by default so netlist code gets full vertical space;
    // automatically expand when real errors or warnings exist.
    setProblems(issues.length>0,false);
  }

  // --- 4. Project & Circuit Hierarchy Explorer inside `#pane-files` ---
  // Move RNL's raw file-pool controls into a neat collapsed footer drawer without breaking any IDs.
  const existingPoolNodes=[...paneFiles.children].filter(node=>!node.classList.contains('cg-library-entry')&&!node.classList.contains('cg-project-explorer')&&!node.classList.contains('cg-pool-drawer'));
  const oldEntry=paneFiles.querySelector('.cg-library-entry');
  if(oldEntry)oldEntry.hidden=true;

  const explorer=el('section',undefined,'cg-project-explorer');
  explorer.setAttribute('aria-label','当前项目与电路层级');

  const poolDrawer=el('details',undefined,'cg-pool-drawer');
  const poolSummary=el('summary','高级：RNL 本地文件池与内置符号库');
  const poolBody=el('div',undefined,'cg-pool-drawer-body');
  for(const node of existingPoolNodes)poolBody.append(node);
  poolDrawer.append(poolSummary,poolBody);

  paneFiles.prepend(explorer);
  paneFiles.append(poolDrawer);

  // Build persistent header + search + scrollable tree body inside explorer
  const header=el('div',undefined,'cg-exp-header');
  const titleRow=el('div',undefined,'cg-exp-title-row');
  const titleText=el('strong','','cg-exp-title');
  const badgeText=el('span','','cg-exp-badge');
  titleRow.append(titleText,badgeText);
  const subtitleText=el('div','','cg-exp-subtitle');
  const actionRow=el('div',undefined,'cg-exp-actions');
  const managerBtn=el('button','Library Manager','cg-exp-btn cg-exp-btn-primary');
  managerBtn.type='button';
  managerBtn.title='打开 Library Manager 浏览或切换项目、单元与视图';
  managerBtn.addEventListener('click',()=>onOpenLibraryManager?.());
  actionRow.append(managerBtn);
  let importBtn=null;
  if(typeof onOpenImport==='function'){
    importBtn=el('button','导入网表','cg-exp-btn');
    importBtn.type='button';
    importBtn.title='从本地或 SSH 服务器导入电路网表';
    importBtn.addEventListener('click',()=>onOpenImport());
    actionRow.append(importBtn);
  }
  header.append(titleRow,subtitleText,actionRow);

  const searchWrap=el('div',undefined,'cg-exp-search');
  const searchInput=document.createElement('input');
  searchInput.type='search';
  searchInput.placeholder='筛选层级实例或模块名…';
  searchInput.setAttribute('aria-label','筛选当前项目电路层级');
  searchInput.spellcheck=false;
  searchInput.addEventListener('input',()=>{query=searchInput.value;renderExplorer();});
  searchInput.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&searchInput.value){searchInput.value='';query='';renderExplorer();event.stopPropagation();}
  });
  searchWrap.append(searchInput);

  const scrollBody=el('div',undefined,'cg-exp-body');
  explorer.append(header,searchWrap,scrollBody);

  function activeTreePath(){
    if(!doc||!doc.levels?.length)return null;
    const direct=pathRow();
    if(direct)return direct;
    // Fallback: locate first path reaching `current`
    const find=(lvIdx,pKey,above)=>{
      if(lvIdx===current)return pKey;
      if(above.includes(lvIdx))return null;
      const kids=doc.levels[lvIdx]?.children||[];
      for(let i=0;i<kids.length;i++){
        if(kids[i].level===null||kids[i].level===undefined)continue;
        const found=find(kids[i].level,`${pKey}/${i}`,above.concat(lvIdx));
        if(found)return found;
      }
      return null;
    };
    const fromTop=find(0,'0',[]);
    if(fromTop)return fromTop;
    for(const r of uncalledRoots()){
      const found=find(r,`r${r}`,[]);
      if(found)return found;
    }
    return null;
  }

  function ensureAncestorsExpanded(activePath){
    if(!activePath)return;
    const parts=activePath.split('/');
    for(let i=1;i<parts.length;i++){
      expandedPaths.add(parts.slice(0,i).join('/'));
    }
  }

  function navigateToNode(node){
    if(node.kind==='veriloga'&&node.veriloga&&typeof onOpenVerilogA==='function'){
      void onOpenVerilogA(node.veriloga,{instanceName:node.instance,masterName:node.master,reveal:true});
      return;
    }
    if(node.level===null||node.level===undefined||!doc)return;
    const entry=currentSource();
    const steps=(node.steps?.length?node.steps:[{level:node.level,via:null}]).map(step=>({
      level:step.level,
      via:step.via??null,
      entry,
    }));
    window.dispatchEvent(new Event('viewer-navigate'));
    void navigate({path:steps,selection:null,reveal:true});
    requestAnimationFrame(()=>renderExplorer());
  }

  function collectProjectVerilogA(state){
    if(state.importedProject?.rnlSnapshot){
      return indexSnapshotVerilogAFiles(state.importedProject.rnlSnapshot,{
        origin:state.importedProject.origin==='ssh'?`SSH · ${state.importedProject.sshTarget||''}`:'本地导入',
      }).list;
    }
    if(state.activeLibrary?.library){
      return indexLibraryVerilogAFiles([state.activeLibrary.library],state.activeLibrary.library.id).list;
    }
    return [];
  }

  function renderTreeSection(treeModel,activePath,isFiltering){
    const section=el('div',undefined,'cg-exp-section');
    const secHead=el('div',undefined,'cg-exp-sec-head');
    secHead.append(
      el('span','电路层级结构','cg-exp-sec-title'),
      el('span',treeModel.totalLevels>1?`${treeModel.totalLevels} 层 · ${treeModel.totalInstances} 实例`:'单层电路','cg-exp-sec-count'),
    );
    section.append(secHead);

    const list=el('div',undefined,'cg-exp-tree');
    list.setAttribute('role','tree');
    list.setAttribute('aria-label','当前电路层级树');

    const rootFiltered=isFiltering?filterHierarchyTree(treeModel.root,query):treeModel.root;
    const uncalledFiltered=(treeModel.uncalled||[]).map(n=>isFiltering?filterHierarchyTree(n,query):n).filter(Boolean);

    const appendNode=(node)=>{
      const hasChildren=(node.children||[]).length>0;
      const isOpen=hasChildren&&(isFiltering||expandedPaths.has(node.pathKey));
      const row=el('div',undefined,'cg-exp-node');
      row.setAttribute('role','treeitem');
      row.dataset.path=node.pathKey;
      row.style.setProperty('--depth',String(node.depth));
      const isActivePath=activePath&&node.pathKey===activePath;
      const isCurrentLevel=node.level!==null&&node.level===current;
      if(isActivePath)row.classList.add('is-active');
      else if(isCurrentLevel)row.classList.add('is-current');
      if(node.kind==='undefined')row.classList.add('is-undefined');
      if(node.kind==='veriloga')row.classList.add('is-veriloga');

      const twisty=el('button',hasChildren?(isOpen?'▾':'▸'):'','cg-exp-twisty'+(hasChildren?'':' is-leaf'));
      twisty.type='button';
      twisty.tabIndex=-1;
      if(hasChildren){
        twisty.setAttribute('aria-expanded',String(isOpen));
        twisty.setAttribute('aria-label',isOpen?'折叠子层级':'展开子层级');
        twisty.addEventListener('click',event=>{
          event.stopPropagation();
          if(expandedPaths.has(node.pathKey))expandedPaths.delete(node.pathKey);
          else expandedPaths.add(node.pathKey);
          renderExplorer();
        });
      }
      row.append(twisty);

      const labelBtn=el('button',undefined,'cg-exp-node-btn');
      labelBtn.type='button';
      labelBtn.disabled=node.kind==='undefined';
      if(node.kind==='top'){
        labelBtn.append(el('span',node.title,'cg-exp-inst'),el('span','顶层','cg-exp-tag is-top'));
        labelBtn.title=`顶层原理图：${node.title}`;
      }else if(node.kind==='uncalled-root'){
        labelBtn.append(el('span',node.title,'cg-exp-inst'),el('span','独立','cg-exp-tag'));
        labelBtn.title=`独立子电路定义：${node.title}`;
      }else{
        labelBtn.append(el('span',node.instance,'cg-exp-inst'));
        if(node.master&&node.master!==node.instance){
          labelBtn.append(el('span',node.master,'cg-exp-master'));
        }
        if(node.kind==='veriloga'){
          labelBtn.append(el('span','VA','cg-exp-tag is-va'));
          labelBtn.title=`点击查看 Verilog-A 行为模型：${node.veriloga?.moduleName||node.master}`;
        }else if(node.kind==='undefined'){
          labelBtn.append(el('span','外部','cg-exp-tag is-muted'));
          labelBtn.title=`${node.master} 未在当前网表中定义`;
        }else if(node.cycle){
          labelBtn.append(el('span','递归','cg-exp-tag is-muted'));
        }else{
          labelBtn.title=`点击进入 ${node.instance} (${node.master})`;
        }
      }
      if(hasChildren&&!isOpen){
        labelBtn.append(el('span',String(node.children.length),'cg-exp-mini-count'));
      }
      labelBtn.addEventListener('click',()=>navigateToNode(node));
      if(hasChildren){
        labelBtn.addEventListener('dblclick',()=>{
          if(expandedPaths.has(node.pathKey))expandedPaths.delete(node.pathKey);
          else expandedPaths.add(node.pathKey);
          renderExplorer();
        });
      }
      row.append(labelBtn);
      list.append(row);

      if(isOpen){
        for(const child of node.children)appendNode(child);
      }
    };

    if(rootFiltered)appendNode(rootFiltered);
    if(uncalledFiltered.length){
      list.append(el('div','未在顶层实例化的子电路','cg-exp-subdivider'));
      for(const node of uncalledFiltered)appendNode(node);
    }

    if(!rootFiltered&&!uncalledFiltered.length){
      list.append(el('p',isFiltering?'没有匹配的电路实例或模块。':'当前尚未打开电路原理图。','cg-exp-empty'));
    }
    section.append(list);

    if(!isFiltering&&treeModel.totalLevels<=1&&treeModel.root){
      const hint=el('div',undefined,'cg-exp-flat-hint');
      hint.append(el('span','当前电路为单层结构，无嵌套子模块。'));
      if(typeof onOpenQuickProject==='function'){
        const state=getProjectState()||{};
        if(state.isReference||doc?.path==='/circuitgit-demo.scs'){
          const quickBtn=el('button','打开 1G 12-bit ADC 查看多层层级 →','cg-exp-link-btn');
          quickBtn.type='button';
          quickBtn.addEventListener('click',()=>onOpenQuickProject());
          hint.append(quickBtn);
        }
      }
      section.append(hint);
    }
    return section;
  }

  function renderLibraryProjectSections(summary,vaModels,isFiltering){
    const frag=document.createDocumentFragment();
    const q=query.trim().toLowerCase();
    const matches=item=>!q||String(item.name||item.id||item.moduleName||'').toLowerCase().includes(q);

    // Top-level entries (e.g. TB_PIPE_RS9_N06, PIPE_TOP_F4_RS9_N06)
    const topItems=summary.topLevel.filter(matches);
    if(topItems.length>1||(topItems.length===1&&topItems[0].id!==summary.activeCellId)){
      const sec=el('div',undefined,'cg-exp-section');
      const head=el('div',undefined,'cg-exp-sec-head');
      head.append(el('span','项目顶层入口','cg-exp-sec-title'),el('span',String(topItems.length),'cg-exp-sec-count'));
      sec.append(head);
      const ul=el('div',undefined,'cg-exp-cell-list');
      for(const cell of topItems){
        const isCurrent=cell.id===summary.activeCellId;
        const btn=el('button',undefined,'cg-exp-cell-btn'+(isCurrent?' is-active':''));
        btn.type='button';
        btn.append(
          el('span',cell.name,'cg-exp-cell-name'),
          el('span',cell.kind==='testbench'?'测试台':'顶层 DUT','cg-exp-tag'+(isCurrent?' is-top':'')),
        );
        btn.title=isCurrent?`当前已打开：${cell.name}`:`切换到顶层原理图：${cell.name}`;
        btn.addEventListener('click',()=>{
          if(isCurrent&&doc?.levels?.length){
            navigateToNode({level:0,steps:[{level:0,via:null}]});
            return;
          }
          onOpenCell?.({library:summary.library,cell});
        });
        ul.append(btn);
      }
      sec.append(ul);
      frag.append(sec);
    }

    // Verilog-A behavioral models in this project
    const filteredVa=vaModels.filter(matches);
    if(filteredVa.length&&typeof onOpenVerilogA==='function'){
      const details=el('details',undefined,'cg-exp-fold');
      if(isFiltering)details.open=true;
      const sum=el('summary',undefined,'cg-exp-fold-head');
      sum.append(el('span','Verilog-A 行为模型','cg-exp-sec-title'),el('span',String(filteredVa.length),'cg-exp-sec-count'));
      details.append(sum);
      const ul=el('div',undefined,'cg-exp-cell-list');
      for(const model of filteredVa){
        const btn=el('button',undefined,'cg-exp-cell-btn');
        btn.type='button';
        btn.append(el('span',model.moduleName,'cg-exp-cell-name'),el('span','VA','cg-exp-tag is-va'));
        btn.title=`查看 Verilog-A 源码：${model.path}`;
        btn.addEventListener('click',()=>void onOpenVerilogA(model,{reveal:true}));
        ul.append(btn);
      }
      details.append(ul);
      frag.append(details);
    }

    // Remaining project cells (submodules / other testbenches) inside a tidy collapsible list
    const otherCells=[...summary.testbenches,...summary.submodules].filter(matches);
    if(otherCells.length){
      const details=el('details',undefined,'cg-exp-fold');
      if(isFiltering)details.open=true;
      const sum=el('summary',undefined,'cg-exp-fold-head');
      sum.append(el('span','项目内全部子单元','cg-exp-sec-title'),el('span',String(otherCells.length),'cg-exp-sec-count'));
      details.append(sum);
      const ul=el('div',undefined,'cg-exp-cell-list');
      for(const cell of otherCells){
        const isCurrent=cell.id===summary.activeCellId;
        const btn=el('button',undefined,'cg-exp-cell-btn'+(isCurrent?' is-active':''));
        btn.type='button';
        btn.append(el('span',cell.name,'cg-exp-cell-name'));
        if(cell.kind==='testbench')btn.append(el('span','TB','cg-exp-tag'));
        btn.title=`单独打开单元原理图：${cell.name}`;
        btn.addEventListener('click',()=>onOpenCell?.({library:summary.library,cell}));
        ul.append(btn);
      }
      details.append(ul);
      frag.append(details);
    }

    return frag;
  }

  function renderExplorer(){
    if(disposed)return;
    const state=getProjectState()||{};
    if(doc!==lastDocRef){
      lastDocRef=doc;
      expandedPaths.clear();
      expandedPaths.add('0');
      syncDiagnosticsFold();
    }
    const summary=buildProjectExplorerSummary({...state,doc});
    titleText.textContent=summary.title;
    titleText.title=summary.title;
    badgeText.textContent=summary.badge;
    subtitleText.textContent=summary.subtitle;
    subtitleText.hidden=!summary.subtitle||summary.subtitle===summary.title;

    const activePath=activeTreePath();
    ensureAncestorsExpanded(activePath);

    const treeModel=buildCircuitHierarchyTree(doc,{
      uncalled:doc?uncalledRoots():[],
      resolveVerilogA,
    });
    const vaModels=collectProjectVerilogA(state);
    const totalSearchable=treeModel.totalLevels+treeModel.totalInstances+summary.submodules.length+vaModels.length;
    searchWrap.hidden=totalSearchable<=4&&!query;

    scrollBody.replaceChildren();
    const isFiltering=Boolean(query.trim());
    scrollBody.append(renderTreeSection(treeModel,activePath,isFiltering));
    if(summary.kind==='library'||vaModels.length){
      scrollBody.append(renderLibraryProjectSections(summary,vaModels,isFiltering));
    }
  }

  // Keep explorer synced with schematic navigation, library switching, and RNL rebuilds
  let refreshFrame=0;
  const scheduleRefresh=()=>{
    if(disposed||refreshFrame)return;
    refreshFrame=requestAnimationFrame(()=>{refreshFrame=0;renderExplorer();});
  };
  const onViewerEvent=()=>scheduleRefresh();
  window.addEventListener('viewer-navigate',onViewerEvent);
  window.addEventListener('library-shown',onViewerEvent);
  const levelPathEl=document.getElementById('level-path');
  const pathObserver=levelPathEl?new MutationObserver(scheduleRefresh):null;
  if(levelPathEl&&pathObserver)pathObserver.observe(levelPathEl,{childList:true,subtree:true,characterData:true});

  renderExplorer();
  syncDiagnosticsFold();

  return {
    refresh(){syncDiagnosticsFold();renderExplorer();},
    setWidth(px,{persist=false}={}){return applyWidth(px,{persist});},
    destroy(){
      disposed=true;
      if(refreshFrame)cancelAnimationFrame(refreshFrame);
      appResizeObserver.disconnect();
      tabObserver.disconnect();
      pathObserver?.disconnect();
      window.removeEventListener('viewer-navigate',onViewerEvent);
      window.removeEventListener('library-shown',onViewerEvent);
      document.removeEventListener('pointerdown',onDocumentPointerDown);
      vsplit.removeEventListener('dblclick',onSplitterDoubleClick);
      vsplit.removeEventListener('pointerup',onSplitterPointerUp);
      vsplit.removeEventListener('pointercancel',onSplitterPointerUp);
      headActions.remove();
      explorer.remove();
      for(const node of [...poolBody.children])paneFiles.append(node);
      poolDrawer.remove();
      if(oldEntry)oldEntry.hidden=false;
    },
  };
}
