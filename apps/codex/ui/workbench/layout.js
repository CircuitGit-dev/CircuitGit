// Pure layout operations. Closed panels retain their server view ids in the registry.
export const KINDS=['schematic','waveforms','simulation'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=prefix=>prefix+'-'+globalThis.crypto.randomUUID();
const copy=value=>structuredClone(value);
const bounded=value=>typeof value==='string'&&value.length>0&&value.length<=180;
const keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));

export function emptyLayout(){return {version:1,panels:[],tree:null,maximized:null};}
export function validateLayout(layout){
  if(!object(layout)||!keys(layout,['version','panels','tree','maximized'])||layout.version!==1||!Array.isArray(layout.panels)||layout.panels.length>16)throw Error('工作台布局格式无效。');
  const panels=new Set(),nodes=new Set(),visible=new Set();let groups=0;
  for(const panel of layout.panels){
    if(!object(panel)||!keys(panel,['id','kind','title'])||!bounded(panel.id)||!KINDS.includes(panel.kind)||typeof panel.title!=='string'||!panel.title.trim()||panel.title.length>256||panels.has(panel.id))throw Error('布局面板身份无效或重复。');
    panels.add(panel.id);
  }
  if(layout.panels.filter(panel=>panel.kind==='schematic').length>1)throw Error('当前工作台只支持一个原理图实例。');
  function walk(node,depth){
    if(!object(node)||!bounded(node.id)||nodes.has(node.id)||depth>8)throw Error('布局树身份重复或超过 8 层。');nodes.add(node.id);
    if(node.type==='group'){
      if(!keys(node,['type','id','tabs','active'])||!Array.isArray(node.tabs)||!node.tabs.length||!node.tabs.includes(node.active)||++groups>16)throw Error('标签组格式无效。');
      for(const panel of node.tabs){if(!panels.has(panel)||visible.has(panel))throw Error('布局引用未知或重复面板。');visible.add(panel);}
    }else if(node.type==='split'){
      if(!keys(node,['type','id','axis','ratio','first','second'])||!['horizontal','vertical'].includes(node.axis)||!Number.isFinite(node.ratio)||node.ratio<0.15||node.ratio>0.85)throw Error('分屏比例或方向无效。');walk(node.first,depth+1);walk(node.second,depth+1);
    }else throw Error('未知布局节点。');
  }
  if(layout.tree!==null)walk(layout.tree,1);
  if(layout.maximized!==null&&!visible.has(layout.maximized))throw Error('最大化面板必须可见。');
  return layout;
}
export function parseLayout(text){if(typeof text!=='string'||new TextEncoder().encode(text).length>128*1024)throw Error('布局超过 128 KiB。');return validateLayout(JSON.parse(text));}
export function groups(tree){if(!tree)return [];return tree.type==='group'?[tree]:[...groups(tree.first),...groups(tree.second)];}
export function visibleIds(layout){return groups(layout.tree).flatMap(group=>group.tabs);}
export function activeIds(layout){return layout.maximized?[layout.maximized]:groups(layout.tree).map(group=>group.active);}
export function findGroup(layout,panelId){return groups(layout.tree).find(group=>group.tabs.includes(panelId))||null;}
function checked(layout){return validateLayout(layout);}
function group(panelId){return {type:'group',id:id('group'),tabs:[panelId],active:panelId};}
function remove(node,panelId){
  if(!node)return null;
  if(node.type==='group'){
    const index=node.tabs.indexOf(panelId);if(index<0)return node;
    node.tabs.splice(index,1);if(!node.tabs.length)return null;
    if(node.active===panelId)node.active=node.tabs[Math.min(index,node.tabs.length-1)];return node;
  }
  node.first=remove(node.first,panelId);node.second=remove(node.second,panelId);return !node.first?node.second:!node.second?node.first:node;
}
function replace(node,nodeId,next){if(node.id===nodeId)return next;if(node.type==='split'){node.first=replace(node.first,nodeId,next);node.second=replace(node.second,nodeId,next);}return node;}
export function addPanel(layout,panel,{groupId=null,edge='center'}={}){
  const next=copy(layout),existing=next.panels.find(item=>item.id===panel.id);
  if(existing&&(existing.kind!==panel.kind||existing.title!==panel.title))throw Error('面板已绑定到另一身份。');
  if(!existing)next.panels.push(copy(panel));
  if(visibleIds(next).includes(panel.id))return activatePanel(next,panel.id);
  if(!next.tree)next.tree=group(panel.id);
  else{
    const target=groupId?groups(next.tree).find(item=>item.id===groupId):groups(next.tree).at(-1);
    if(!target)throw Error('目标标签组已变化。');
    if(edge==='center'){target.tabs.push(panel.id);target.active=panel.id;}
    else next.tree=splitAt(next.tree,target,panel.id,edge);
  }
  next.maximized=null;return checked(next);
}
function splitAt(tree,target,panelId,edge){
  if(!['left','right','top','bottom'].includes(edge))throw Error('未知停靠位置。');
  const fresh=group(panelId),before=['left','top'].includes(edge);
  return replace(tree,target.id,{type:'split',id:id('split'),axis:['left','right'].includes(edge)?'horizontal':'vertical',ratio:0.5,first:before?fresh:target,second:before?target:fresh});
}
export function movePanel(layout,panelId,groupId,edge='center',beforeId=null){
  validateLayout(layout);const source=findGroup(layout,panelId),target=groups(layout.tree).find(item=>item.id===groupId);
  if(!source||!target)throw Error('拖动面板或目标已经关闭。');
  if(source.id===target.id&&source.tabs.length===1)return copy(layout);
  if(panelId===beforeId&&source.id===target.id&&edge==='center')return copy(layout);
  const next=copy(layout);next.tree=remove(next.tree,panelId);next.maximized=null;
  const destination=groups(next.tree).find(item=>item.id===groupId);
  if(!destination)throw Error('目标标签组已变化。');
  if(edge==='center'){
    const index=beforeId?destination.tabs.indexOf(beforeId):-1;destination.tabs.splice(index<0?destination.tabs.length:index,0,panelId);destination.active=panelId;
  }else next.tree=splitAt(next.tree,destination,panelId,edge);
  return checked(next);
}
export function closePanel(layout,panelId){const next=copy(layout);next.tree=remove(next.tree,panelId);if(next.maximized===panelId)next.maximized=null;return checked(next);}
export function activatePanel(layout,panelId){const next=copy(layout),target=findGroup(next,panelId);if(!target)throw Error('面板未打开。');target.active=panelId;if(next.maximized)next.maximized=panelId;return checked(next);}
export function maximizePanel(layout,panelId){const next=activatePanel(layout,panelId);next.maximized=layout.maximized===panelId?null:panelId;return checked(next);}
export function resizeSplit(layout,nodeId,ratio){
  if(!Number.isFinite(ratio))throw Error('分屏比例必须为有限数字。');
  const next=copy(layout);let found=false;
  function walk(node){if(!node||node.type!=='split')return;if(node.id===nodeId){node.ratio=Math.max(.15,Math.min(.85,ratio));found=true;}else{walk(node.first);walk(node.second);}}
  walk(next.tree);if(!found)throw Error('分屏已不存在。');return checked(next);
}
export function resetLayout(layout){
  const next=copy(layout);next.maximized=null;
  const makeGroup=tabs=>({type:'group',id:id('group'),tabs,active:tabs[0]});
  const byKind=Object.fromEntries(KINDS.map(kind=>{const tabs=next.panels.filter(panel=>panel.kind===kind).map(panel=>panel.id);return [kind,tabs.length?makeGroup(tabs):null];}));
  const top=byKind.schematic&&byKind.simulation?{type:'split',id:id('split'),axis:'horizontal',ratio:.62,first:byKind.schematic,second:byKind.simulation}:byKind.schematic||byKind.simulation;
  next.tree=top&&byKind.waveforms?{type:'split',id:id('split'),axis:'vertical',ratio:.6,first:top,second:byKind.waveforms}:top||byKind.waveforms;
  return checked(next);
}
