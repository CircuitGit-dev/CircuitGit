const clone=value=>structuredClone(value);
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);

/** Ignore focus and the returning float, but retain all other placement/size changes. */
export function remainingLayout(layout,ids){
  const value=clone(layout),removed=new Set(ids);delete value.activeGroup;
  for(const id of ids)delete value.panels[id];
  function strip(node){
    if(node.type==='branch')node.data.forEach(strip);
    else{delete node.data.activeView;delete node.data.activePanel;}
  }
  strip(value.grid.root);
  for(const key of ['floatingGroups','popoutGroups']){
    value[key]=(value[key]||[]).filter(g=>!g.data.views?.every(id=>removed.has(id)));
    for(const group of value[key]){delete group.data.activeView;delete group.data.activePanel;}
  }
  return stable(value);
}

/** Store neighbours in preference order, independent of ephemeral group identifiers. */
export function homeRelations(origin,groups,ids){
  const own=new Set(ids),siblings=origin.ids.filter(id=>!own.has(id));
  const result=siblings.map(id=>({id,position:'center',index:origin.ids.indexOf(ids[0])}));
  const a=origin.box;
  const scored=[];
  for(const group of groups){
    if(group.ids.some(id=>own.has(id))||group.location!=='grid')continue;
    const b=group.box,dx=a.x+a.width/2-b.x-b.width/2,dy=a.y+a.height/2-b.y-b.height/2;
    const overlapX=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x));
    const overlapY=Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
    const vertical=overlapX>0&&(overlapY===0||Math.abs(dy)>Math.abs(dx));
    const position=vertical?(dy<0?'top':'bottom'):(dx<0?'left':'right');
    const distance=vertical?Math.max(0,Math.abs(dy)-(a.height+b.height)/2):Math.max(0,Math.abs(dx)-(a.width+b.width)/2);
    const overlap=vertical?overlapX:overlapY;
    scored.push({ids:group.ids,position,score:distance-overlap});
  }
  scored.sort((a,b)=>a.score-b.score);
  for(const group of scored)for(const id of group.ids)result.push({id,position:group.position});
  return result;
}

export function boundedFloat(position,area){
  if(!position||!['left','top','width','height'].every(k=>Number.isFinite(position[k])))return {width:Math.min(640,area.width),height:Math.min(420,area.height)};
  const width=Math.max(100,Math.min(position.width,area.width)),height=Math.max(100,Math.min(position.height,area.height));
  return {width,height,left:Math.max(0,Math.min(position.left,area.width-width)),top:Math.max(0,Math.min(position.top,area.height-height))};
}

/** Share the schematic left sidebar with Verilog-A when tabbed in the same grid group. */
export function shouldShareSchematicSidebar({verilogaPanel=null,schematicPanel=null,hasVerilogaMount=false}={}){
  if(!verilogaPanel?.isVisible||!hasVerilogaMount||verilogaPanel.locationType!=='grid')return false;
  if(schematicPanel?.isVisible)return false;
  return !schematicPanel||verilogaPanel.group===schematicPanel.group;
}
