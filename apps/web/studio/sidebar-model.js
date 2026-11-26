// Pure data helpers for the schematic sidebar: width clamping and live circuit hierarchy trees.
import {classifyLibraryHierarchy,formatLibraryName} from '../library/model.js';

export const SIDEBAR_DEFAULT_WIDTH=280;
export const SIDEBAR_MIN_WIDTH=210;
export const SIDEBAR_CANVAS_MIN_WIDTH=220;
export const SIDEBAR_WIDE_TARGET=520;

export function sidebarBounds(containerWidth){
  const total=Number(containerWidth)||0;
  if(total<=0)return {min:SIDEBAR_MIN_WIDTH,max:Math.max(SIDEBAR_MIN_WIDTH,SIDEBAR_WIDE_TARGET)};
  const max=Math.max(SIDEBAR_MIN_WIDTH,Math.min(Math.round(total*0.75),Math.round(total-SIDEBAR_CANVAS_MIN_WIDTH)));
  return {min:SIDEBAR_MIN_WIDTH,max};
}

export function clampSidebarWidth(width,containerWidth){
  const {min,max}=sidebarBounds(containerWidth);
  const raw=Number.isFinite(Number(width))?Number(width):SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.max(min,Math.min(max,raw)));
}

export function computeWideSidebarWidth(containerWidth){
  const total=Number(containerWidth)||0;
  if(total<=0)return SIDEBAR_WIDE_TARGET;
  const target=Math.min(SIDEBAR_WIDE_TARGET,Math.round(total*0.52));
  return clampSidebarWidth(Math.max(target,380),total);
}

/**
 * Build a cycle-safe hierarchical tree from the parsed RNL `doc.levels`.
 * Each node carries the exact step chain so clicking navigates with full breadcrumbs.
 */
export function buildCircuitHierarchyTree(doc,{uncalled=[],resolveVerilogA=null}={}){
  if(!doc||!Array.isArray(doc.levels)||!doc.levels.length){
    return {root:null,uncalled:[],totalLevels:0,totalInstances:0};
  }
  const levels=doc.levels;
  let totalInstances=0;

  function buildNode(levelIndex,pathKey,depth,child,steps,ancestors){
    const lv=levels[levelIndex];
    const cycle=ancestors.includes(levelIndex);
    const rawChildren=cycle?[]:(Array.isArray(lv?.children)?lv.children:[]);
    const children=[];
    const nextAncestors=ancestors.concat(levelIndex);
    rawChildren.forEach((entry,idx)=>{
      totalInstances++;
      const childKey=`${pathKey}/${idx}`;
      if(entry.level===null||entry.level===undefined){
        const va=typeof resolveVerilogA==='function'?resolveVerilogA(entry.master):null;
        children.push({
          pathKey:childKey,
          level:null,
          depth:depth+1,
          instance:entry.instance||'',
          master:entry.master||'',
          title:entry.instance||entry.master||'unknown',
          kind:va?'veriloga':'undefined',
          veriloga:va||null,
          cycle:false,
          steps:[],
          children:[],
        });
      }else{
        const nextSteps=steps.concat({level:entry.level,via:entry.instance||null});
        children.push(buildNode(entry.level,childKey,depth+1,entry,nextSteps,nextAncestors));
      }
    });
    const definedChildCount=children.filter(c=>c.level!==null||c.kind==='veriloga').length;
    return {
      pathKey,
      level:levelIndex,
      depth,
      instance:child?child.instance:null,
      master:child?child.master:null,
      title:lv?.title||(child?.master||`level-${levelIndex}`),
      kind:child?'instance':(pathKey==='0'?'top':'uncalled-root'),
      veriloga:null,
      cycle,
      steps,
      children,
      childCount:children.length,
      definedChildCount,
    };
  }

  const root=buildNode(0,'0',0,null,[{level:0,via:null}],[]);
  const uncalledNodes=(Array.isArray(uncalled)?uncalled:[])
    .filter(idx=>Number.isInteger(idx)&&idx>0&&idx<levels.length)
    .map(idx=>buildNode(idx,`r${idx}`,0,null,[{level:idx,via:null}],[]));

  return {
    root,
    uncalled:uncalledNodes,
    totalLevels:levels.length,
    totalInstances,
  };
}

/**
 * Filter a hierarchy tree by substring on instance/master/title while keeping ancestor paths.
 */
export function filterHierarchyTree(node,query){
  if(!node)return null;
  const q=String(query||'').trim().toLowerCase();
  if(!q)return node;
  const hay=[node.instance,node.master,node.title,node.veriloga?.moduleName].filter(Boolean).join(' ').toLowerCase();
  const selfMatch=hay.includes(q);
  const keptChildren=[];
  for(const child of node.children||[]){
    const matched=filterHierarchyTree(child,q);
    if(matched)keptChildren.push(matched);
  }
  if(!selfMatch&&!keptChildren.length)return null;
  return {...node,children:keptChildren,matched:selfMatch};
}

/**
 * Derive current project overview + categorized library cells for the sidebar explorer.
 */
export function buildProjectExplorerSummary({activeLibrary=null,importedProject=null,doc=null,isReference=false}={}){
  if(activeLibrary?.library){
    const lib=activeLibrary.library;
    const h=classifyLibraryHierarchy(lib);
    return {
      kind:'library',
      title:formatLibraryName(lib),
      subtitle:activeLibrary.cell?.name||doc?.levels?.[0]?.title||'',
      badge:activeLibrary.origin==='working'?'本机库':'项目库',
      library:lib,
      activeCellId:activeLibrary.cell?.id||null,
      topLevel:h.topLevel,
      testbenches:h.testbenches,
      submodules:h.submodules,
      fileCountById:h.fileCountById,
    };
  }
  if(importedProject){
    return {
      kind:'imported',
      title:importedProject.name||importedProject.fileName||'已导入电路',
      subtitle:importedProject.fileName||doc?.levels?.[0]?.title||'',
      badge:importedProject.origin==='ssh'?'SSH 导入':'本地导入',
      supportCount:importedProject.supportCount||0,
      library:null,
      activeCellId:null,
      topLevel:[],
      testbenches:[],
      submodules:[],
      fileCountById:new Map(),
    };
  }
  if(isReference||doc?.path==='/circuitgit-demo.scs'){
    return {
      kind:'reference',
      title:'RC · 入门示例电路',
      subtitle:'circuitgit-demo.scs',
      badge:'内置示例',
      library:null,
      activeCellId:null,
      topLevel:[],
      testbenches:[],
      submodules:[],
      fileCountById:new Map(),
    };
  }
  return {
    kind:'document',
    title:doc?.name||doc?.levels?.[0]?.title||'当前电路',
    subtitle:doc?.path||'',
    badge:'当前网表',
    library:null,
    activeCellId:null,
    topLevel:[],
    testbenches:[],
    submodules:[],
    fileCountById:new Map(),
  };
}
