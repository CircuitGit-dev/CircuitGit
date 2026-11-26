// Pure zero-DOM Spectre + RNL v0.3 parser and source rewriter for interactive schematic editing.
// Every operation mutates ONLY the target scope's Spectre netlist & RNL block and returns fresh text.

export const ORIENTATIONS=['R0','R90','R180','R270','MX','MY','MXR90','MYR90'];
const ROTATE_RING=['R0','R90','R180','R270'];

export function formatCoord(value){
  const n=Math.round(Number(value)*100)/100;
  return Object.is(n,-0)?'0':String(n);
}

export function snapCoord(value,step=1){
  const s=step>0?step:1;
  return Math.round(Number(value)/s)*s;
}

export function transformPoint(x,y,orient='R0'){
  switch(orient){
    case 'R90':return [-y,x];
    case 'R180':return [-x,-y];
    case 'R270':return [y,-x];
    case 'MX':return [x,-y];
    case 'MY':return [-x,y];
    case 'MXR90':return [y,x];
    case 'MYR90':return [-y,-x];
    default:return [x,y];
  }
}

export function nextOrientation(orient='R0',mode='rotate'){
  if(mode==='mirror-x'){
    const map={R0:'MX',MX:'R0',R90:'MYR90',MYR90:'R90',R180:'MY',MY:'R180',R270:'MXR90',MXR90:'R270'};
    return map[orient]||'MX';
  }
  if(mode==='mirror-y'){
    const map={R0:'MY',MY:'R0',R90:'MXR90',MXR90:'R90',R180:'MX',MX:'R180',R270:'MYR90',MYR90:'R270'};
    return map[orient]||'MY';
  }
  const idx=ROTATE_RING.indexOf(orient);
  if(idx>=0)return ROTATE_RING[(idx+1)%ROTATE_RING.length];
  const mirrorRing=['MX','MXR90','MY','MYR90'];
  const mIdx=mirrorRing.indexOf(orient);
  if(mIdx>=0)return mirrorRing[(mIdx+1)%mirrorRing.length];
  return 'R90';
}

export function parseParamsText(raw=''){
  const out=[];
  let i=0;
  const s=String(raw||'');
  while(i<s.length){
    while(i<s.length&&/\s/.test(s[i]))i++;
    if(i>=s.length||s.slice(i,i+2)==='//')break;
    const keyMatch=s.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/);
    if(!keyMatch){
      // Skip bare token
      while(i<s.length&&!/\s/.test(s[i]))i++;
      continue;
    }
    const name=keyMatch[1];
    i+=keyMatch[0].length;
    const start=i;
    let quote=null,depth=0;
    while(i<s.length){
      const ch=s[i];
      if(quote){if(ch==='\\'){i+=2;continue;}if(ch===quote)quote=null;}
      else if(ch==='"'||ch==="'")quote=ch;
      else if('([{'.includes(ch))depth++;
      else if(')]}'.includes(ch)){if(depth===0)break;depth--;}
      else if(depth===0&&(/\s/.test(ch)||s.slice(i,i+2)==='//'))break;
      i++;
    }
    const value=s.slice(start,i).trim();
    if(value)out.push({name,value});
  }
  return out;
}

export function formatParamsList(params){
  return (Array.isArray(params)?params:[])
    .filter(p=>p&&String(p.name||'').trim()&&String(p.value??'').trim()!=='')
    .map(p=>`${String(p.name).trim()}=${String(p.value).trim()}`)
    .join(' ');
}

function splitLines(text){
  const crlf=/\r\n/.test(text);
  return {lines:String(text??'').split(/\r?\n/),eol:crlf?'\r\n':'\n'};
}

function escapeRegExp(s){
  return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

/**
 * Find the exact line range [startIdx, endIdx] (0-based inclusive) of `scopeName`
 * ('(top)' or a subckt name) and index all Spectre instances, RNL blocks, symbols, placements, and wires.
 */
export function parseEditableScope(text,scopeName='(top)'){
  const {lines,eol}=splitLines(text);
  const subckts=[];
  let currentSub=null;
  for(let i=0;i<lines.length;i++){
    const raw=lines[i];
    if(/^\s*(\/\/|\*)/.test(raw))continue;
    const mSub=raw.match(/^\s*(?:inline\s+)?subckt\s+(\S+)\s*(.*)$/i);
    if(mSub){
      currentSub={name:mSub[1],ports:mSub[2].replace(/\/\/.*$/,'').trim().split(/\s+/).filter(Boolean),start:i,end:lines.length-1};
      subckts.push(currentSub);
      continue;
    }
    if(/^\s*ends\b/i.test(raw)&&currentSub){
      currentSub.end=i;
      currentSub=null;
    }
  }

  let scopeStart=0,scopeEnd=lines.length-1,resolvedScope='(top)',scopePorts=[],indent='';
  if(scopeName&&scopeName!=='(top)'){
    const match=subckts.find(s=>s.name===scopeName);
    if(match){
      scopeStart=match.start+1;
      scopeEnd=match.end-1;
      resolvedScope=match.name;
      scopePorts=match.ports;
      indent='    ';
    }
  }

  // Track subckt line spans to skip when scanning top-level
  const inSubckt=idx=>resolvedScope==='(top)'&&subckts.some(s=>idx>=s.start&&idx<=s.end);

  // Parse Spectre instances in target scope
  const instances=[];
  for(let i=scopeStart;i<=scopeEnd;i++){
    if(inSubckt(i))continue;
    const raw=lines[i];
    if(/^\s*(\/\/|\*|$)/.test(raw))continue;
    const start=i;
    const lineIndent=(raw.match(/^(\s*)/)||['',''])[1];
    let stmt=raw;
    while(/\\\s*$/.test(stmt)&&i<scopeEnd){
      stmt=stmt.replace(/\\\s*$/,' ')+lines[++i].trim();
    }
    const end=i;
    const cleaned=stmt.replace(/\/\/.*$/,'').trim();
    if(/^(?:simulator|global|parameters|include|ahdl_include|save|saveOptions|tran|ac|dc|options|model|subckt|ends)\b/i.test(cleaned))continue;
    const m=cleaned.match(/^([^\s()]+)\s*\(([^)]*)\)\s+(\S+)\s*(.*)$/);
    if(m){
      const nodes=m[2].trim().split(/\s+/).filter(Boolean);
      instances.push({
        name:m[1],
        nodes,
        model:m[3],
        paramsText:m[4].trim(),
        params:parseParamsText(m[4]),
        start,
        end,
        indent:lineIndent||indent,
      });
    }
  }

  // Parse RNL header presence & RNL body blocks in target scope
  const hasRnlHeader=lines.some(l=>/^\s*\/\/\s*@RNL\s*\([^)]*type\s*=\s*"header"/i.test(l));
  const usesStdPackage=lines.some(l=>/@USE-PACKAGE\s*\([^)]*rnl-std/i.test(l));

  const rnlBlocks=[];
  for(let i=scopeStart;i<=scopeEnd;i++){
    if(inSubckt(i))continue;
    const raw=lines[i];
    if(!/^\s*\/\/\s*@RNL\b/.test(raw))continue;
    if(/type\s*=\s*"header"/i.test(raw))continue;
    const blockStart=i;
    let depth=0,started=false,blockEnd=i;
    for(let j=i;j<=scopeEnd;j++){
      const stripped=lines[j].replace(/^\s*\/\//,'');
      for(const ch of stripped){
        if(ch==='{'){depth++;started=true;}
        else if(ch==='}'){depth--;}
      }
      blockEnd=j;
      if(started&&depth<=0)break;
    }
    rnlBlocks.push({start:blockStart,end:blockEnd});
    i=blockEnd;
  }

  // Parse symbols (@DEFINE-SYMBOL), placements, symbol bindings, and wire IDs across the file/scope
  const symbols=new Map();
  const fullRnlText=lines.map(l=>/^\s*\/\//.test(l)?l.replace(/^\s*\/\//,''):'').join('\n');
  const symHeaderRe=/(%\w+)\s*=\s*@DEFINE-SYMBOL\s*(?:\(([^)]*)\))?\s*\{/g;
  let sm;
  while((sm=symHeaderRe.exec(fullRnlText))){
    const symId=sm[1];
    const attrs=sm[2]||'';
    const boxM=attrs.match(/box\s*=\s*\[\s*([^,\]]+)\s*,\s*([^,\]]+)\s*,\s*([^,\]]+)\s*,\s*([^\]]+)\s*\]/);
    const box=boxM?boxM.slice(1,5).map(Number):[-4,-4,4,4];
    let depth=1,pos=symHeaderRe.lastIndex;
    while(pos<fullRnlText.length&&depth>0){
      const ch=fullRnlText[pos++];
      if(ch==='{')depth++;
      else if(ch==='}')depth--;
    }
    const body=fullRnlText.slice(symHeaderRe.lastIndex,pos-1);
    const pins=[];
    const pinRe=/\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\)\s*@PIN\s*\(([^)]*)\)/g;
    let pm;
    while((pm=pinRe.exec(body))){
      const px=Number(pm[1]),py=Number(pm[2]),pAttrs=pm[3]||'';
      const tm=pAttrs.match(/terminal\s*=\s*(?:"([^"]+)"|(\d+))/);
      if(tm){
        const isNum=tm[2]!==undefined;
        pins.push({
          x:px,
          y:py,
          terminal:isNum?Number(tm[2]):tm[1],
          isNumeric:isNum,
        });
      }
    }
    symbols.set(symId,{id:symId,box,pins});
  }

  const placements=new Map();
  const symbolBindings=new Map();
  const wireIds=new Set();
  const blockTexts=[];
  for(const block of rnlBlocks){
    for(let i=block.start;i<=block.end;i++){
      const line=lines[i];
      blockTexts.push({lineIdx:i,text:line});
      const symBindRe=/#"([^"]+)"\s*@SET-SYMBOL\s+(%\w+)/g;
      let bm;
      while((bm=symBindRe.exec(line)))symbolBindings.set(bm[1],bm[2]);

      const placeRe=/#"([^"]+)"\s*@PLACE\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\)(?:\s*=>\s*@ORIENT\s*\(\s*"([^"]+)"\s*\))?/g;
      let plm;
      while((plm=placeRe.exec(line))){
        placements.set(plm[1],{
          x:Number(plm[2]),
          y:Number(plm[3]),
          orient:plm[4]||'R0',
          lineIdx:i,
        });
      }
      const wRe=/(%\w+)\s*=\s*&"[^"]*"\s*@WIRE\b/g;
      let wm;
      while((wm=wRe.exec(line)))wireIds.add(wm[1]);
    }
  }

  // Also collect all net names used in the scope
  const netNames=new Set(scopePorts);
  for(const inst of instances){
    for(const n of inst.nodes)netNames.add(n);
  }

  return {
    lines,
    eol,
    scopeName:resolvedScope,
    scopeStart,
    scopeEnd,
    scopePorts,
    indent,
    hasRnlHeader,
    usesStdPackage,
    subckts,
    instances,
    rnlBlocks,
    symbols,
    symbolBindings,
    placements,
    wireIds,
    netNames,
  };
}

/**
 * Compute world-space RNL coordinates for every pin of every placed instance in `scopeName`.
 */
export function computeWorldPins(text,scopeName='(top)'){
  const parsed=parseEditableScope(text,scopeName);
  const subcktPortsByName=new Map(parsed.subckts.map(s=>[s.name,s.ports]));
  const pins=[];
  for(const inst of parsed.instances){
    const place=parsed.placements.get(inst.name);
    const symId=parsed.symbolBindings.get(inst.name);
    const sym=symId?parsed.symbols.get(symId):null;
    if(!place||!sym||!sym.pins.length)continue;
    const modelPorts=subcktPortsByName.get(inst.model)||[];
    for(const pin of sym.pins){
      let portIndex=-1;
      if(pin.isNumeric){
        portIndex=Number(pin.terminal)-1;
      }else{
        portIndex=modelPorts.indexOf(String(pin.terminal));
      }
      const [dx,dy]=transformPoint(pin.x,pin.y,place.orient);
      pins.push({
        instance:inst.name,
        model:inst.model,
        terminal:pin.terminal,
        isNumeric:pin.isNumeric,
        portIndex,
        net:portIndex>=0&&portIndex<inst.nodes.length?inst.nodes[portIndex]:null,
        x:place.x+dx,
        y:place.y+dy,
      });
    }
  }
  return pins;
}

export function suggestUniqueName(existingNames,prefix='X'){
  const used=new Set([...existingNames].map(n=>String(n).toLowerCase()));
  let idx=1;
  while(used.has(`${prefix}${idx}`.toLowerCase()))idx++;
  return `${prefix}${idx}`;
}

export function suggestUniqueNet(existingNets,prefix='net'){
  const used=new Set([...existingNets].map(n=>String(n).toLowerCase()));
  let idx=1;
  while(used.has(`${prefix}${idx}`.toLowerCase()))idx++;
  return `${prefix}${idx}`;
}

function suggestUniqueWireId(wireIds){
  let idx=1;
  while(wireIds.has(`%cg_w${idx}`))idx++;
  return `%cg_w${idx}`;
}

function ensureHeader(lines){
  const hasHeader=lines.some(l=>/^\s*\/\/\s*@RNL\s*\([^)]*type\s*=\s*"header"/i.test(l));
  if(hasHeader)return 0;
  lines.unshift('// @RNL(type="header") { @VERSION("0.3") }');
  return 1;
}

/**
 * Append one or more RNL statements (without leading `// `) into the target scope's last RNL block,
 * or create a fresh `// @RNL { ... // }` block inside the scope if none exists.
 */
function appendRnlStatements(lines,parsed,statements){
  const cleanStmts=statements.filter(Boolean);
  if(!cleanStmts.length)return;
  const headerShift=ensureHeader(lines);
  const scopeEnd=parsed.scopeEnd+headerShift;
  const targetBlock=parsed.rnlBlocks.length?parsed.rnlBlocks[parsed.rnlBlocks.length-1]:null;

  if(targetBlock){
    const start=targetBlock.start+headerShift;
    const end=targetBlock.end+headerShift;
    // Check if closing brace is on its own line `// }`
    const endLine=lines[end];
    const closingOnly=/^\s*\/\/\s*\}\s*$/.test(endLine);
    if(closingOnly){
      // Ensure previous non-empty RNL line ends with `;` or `{`
      for(let j=end-1;j>start;j--){
        const stripped=lines[j].replace(/^\s*\/\//,'').trim();
        if(!stripped)continue;
        if(!/[;{]$/.test(stripped))lines[j]=lines[j].replace(/\s*$/,';');
        break;
      }
      const inserted=cleanStmts.map((stmt,idx)=>{
        const trimmed=stmt.replace(/;\s*$/,'');
        const suffix=idx<cleanStmts.length-1?';':'';
        return `//   ${trimmed}${suffix}`;
      });
      lines.splice(end,0,...inserted);
    }else{
      // Single-line `// @RNL { ... }` — split before final `}`
      const closePos=endLine.lastIndexOf('}');
      const head=endLine.slice(0,closePos).replace(/\s*$/,'');
      const needsSemi=head.replace(/^\s*\/\/\s*@RNL[^{]*\{/,'').trim().length>0&&!/[;{]$/.test(head);
      lines[end]=head+(needsSemi?';':'');
      const inserted=cleanStmts.map((stmt,idx)=>`//   ${stmt.replace(/;\s*$/,'')}${idx<cleanStmts.length-1?';':''}`);
      lines.splice(end+1,0,...inserted,'// }');
    }
    return;
  }

  // Create a new RNL block right at the end of the scope (before `ends` for subckt, or EOF for top)
  const insertAt=parsed.scopeName==='(top)'?lines.length:scopeEnd+1;
  const formatted=cleanStmts.map((stmt,idx)=>`//   ${stmt.replace(/;\s*$/,'')}${idx<cleanStmts.length-1?';':''}`);
  lines.splice(insertAt,0,'// @RNL {',...formatted,'// }');
}

function formatTerminalRef(instance,terminal,isNumeric){
  if(isNumeric||/^\d+$/.test(String(terminal)))return `#"${instance}":${Number(terminal)}`;
  return `#"${instance}":"${String(terminal)}"`;
}

function replaceInstanceLine(lines,inst,nextText){
  lines.splice(inst.start,inst.end-inst.start+1,nextText);
}

function buildSpectreInstanceLine(indent,name,nodes,model,paramsText){
  const nodeStr=nodes.join(' ');
  const tail=paramsText?` ${paramsText}`:'';
  return `${indent}${name} (${nodeStr}) ${model}${tail}`;
}

/**
 * Update an instance's name, model, node connections, or Spectre parameter list (Q key).
 */
export function updateInstanceProperties(text,{scopeName='(top)',instanceName,newName,model,nodes,params,paramsText}={}){
  const parsed=parseEditableScope(text,scopeName);
  const inst=parsed.instances.find(item=>item.name===instanceName);
  if(!inst)throw Error(`未在当前层级找到器件 ${instanceName}。`);
  const finalName=String(newName||inst.name).trim();
  if(!/^[A-Za-z_][A-Za-z0-9_<>.$]*$/.test(finalName))throw Error('器件名只能包含字母、数字、下划线或总线符号。');
  if(finalName!==inst.name&&parsed.instances.some(item=>item.name===finalName)){
    throw Error(`器件名 ${finalName} 在当前层级已存在。`);
  }
  const finalModel=String(model||inst.model).trim();
  if(!finalModel)throw Error('器件型号不能为空。');
  const finalNodes=Array.isArray(nodes)&&nodes.length?nodes.map(n=>String(n).trim()).filter(Boolean):inst.nodes;
  const finalParams=paramsText!==undefined?String(paramsText).trim():Array.isArray(params)?formatParamsList(params):inst.paramsText;

  const lines=[...parsed.lines];
  replaceInstanceLine(lines,inst,buildSpectreInstanceLine(inst.indent,finalName,finalNodes,finalModel,finalParams));

  // If renamed, update all #"OLD" references in RNL blocks within the same scope
  if(finalName!==inst.name){
    const shift=1-(inst.end-inst.start+1);
    const oldRe=new RegExp(`#"${escapeRegExp(inst.name)}"`,'g');
    for(const block of parsed.rnlBlocks){
      for(let i=block.start+shift;i<=block.end+shift;i++){
        if(i>=0&&i<lines.length)lines[i]=lines[i].replace(oldRe,`#"${finalName}"`);
      }
    }
  }
  return {
    text:lines.join(parsed.eol),
    instanceName:finalName,
    summary:`更新器件 ${finalName} (${finalModel}) 参数`,
  };
}

/**
 * Generate a clean, valid RNL v0.3 rectangular block symbol definition for any subcircuit / Verilog-A module.
 */
export function buildBlockSymbolDef(symId,modelName,ports=[]){
  const list=Array.isArray(ports)&&ports.length?ports:['1','2'];
  const leftCount=Math.ceil(list.length/2);
  const rightCount=list.length-leftCount;
  const rows=Math.max(leftCount,rightCount,1);
  const halfH=Math.max(3,rows*2+1);
  const w=14;
  const stmts=[
    `@RECTANGLE {(2, ${formatCoord(-halfH)}) (${w-2}, ${formatCoord(halfH)})}`,
    `? @TEXT("\${name}", size=1, halign="middle", valign="baseline", key="name") => @PLACE(${formatCoord(w/2)}, ${formatCoord(halfH+1)})`,
    `? @TEXT("${modelName}", size=0.9, halign="middle", valign="middle", key="model") => @PLACE(${formatCoord(w/2)}, 0)`,
  ];
  for(let i=0;i<leftCount;i++){
    const py=formatCoord(halfH-2-i*4);
    const portName=list[i];
    stmts.push(`@LINE {(0, ${py}) (2, ${py})}`);
    stmts.push(`(0, ${py}) @PIN(terminal=${i+1})`);
    stmts.push(`(2.6, ${py}) @TEXT("${portName}", size=0.8, halign="start", valign="middle")`);
  }
  for(let i=0;i<rightCount;i++){
    const py=formatCoord(halfH-2-i*4);
    const portIdx=leftCount+i;
    const portName=list[portIdx];
    stmts.push(`@LINE {(${w-2}, ${py}) (${w}, ${py})}`);
    stmts.push(`(${w}, ${py}) @PIN(terminal=${portIdx+1})`);
    stmts.push(`(${w-2.6}, ${py}) @TEXT("${portName}", size=0.8, halign="end", valign="middle")`);
  }
  const inner=stmts.map((s,idx)=>`//     ${s}${idx<stmts.length-1?';':''}`).join('\n');
  return `${symId} = @DEFINE-SYMBOL(box=[0, ${formatCoord(-halfH)}, ${w}, ${formatCoord(halfH)}]) {\n${inner}\n//   }`;
}

/**
 * Insert a new Spectre instance (or virtual ground marker) and place its RNL symbol at (x, y) (I key).
 */
export function addInstance(text,{
  scopeName='(top)',
  name='',
  prefix='X',
  model,
  ports=['p','n'],
  nodes=null,
  params=[],
  paramsText='',
  x=0,
  y=0,
  orient='R0',
  symbolId='',
  symbolDef='',
  virtualKind=null,
}={}){
  const parsed=parseEditableScope(text,scopeName);
  const lines=[...parsed.lines];
  const rx=formatCoord(x),ry=formatCoord(y);

  // Virtual ground / supply marker (no electrical Spectre instance line added!)
  if(virtualKind==='ground'){
    const markerId=suggestUniqueName(parsed.wireIds,'cg_gnd_').replace(/^/,'%');
    const stmts=[];
    if(parsed.usesStdPackage){
      stmts.push(`${markerId} = $GROUND @ATTACH &"0" => @PLACE(${rx}, ${ry}) => @ORIENT("${orient}")`);
    }else{
      const gndSym='%cg_sym_gnd';
      if(!parsed.symbols.has(gndSym)){
        stmts.push(
          `${gndSym} = @DEFINE-SYMBOL(box=[-2, -3, 2, 0]) {\n`+
          `//     @LINE {(0, 0) (0, -1.2)};\n`+
          `//     @LINE {(-1.8, -1.2) (1.8, -1.2)};\n`+
          `//     @LINE {(-1.1, -2.0) (1.1, -2.0)};\n`+
          `//     @LINE {(-0.5, -2.8) (0.5, -2.8)};\n`+
          `//     (0, 0) @PIN(terminal=1)\n`+
          `//   }`,
        );
      }
      stmts.push(`@LINE {(${rx}, ${ry}) (${rx}, ${formatCoord(Number(y)-1.2)})}`);
      stmts.push(`@LINE {(${formatCoord(Number(x)-1.8)}, ${formatCoord(Number(y)-1.2)}) (${formatCoord(Number(x)+1.8)}, ${formatCoord(Number(y)-1.2)})}`);
      stmts.push(`@LINE {(${formatCoord(Number(x)-1.1)}, ${formatCoord(Number(y)-2.0)}) (${formatCoord(Number(x)+1.1)}, ${formatCoord(Number(y)-2.0)})}`);
      stmts.push(`@LINE {(${formatCoord(Number(x)-0.5)}, ${formatCoord(Number(y)-2.8)}) (${formatCoord(Number(x)+0.5)}, ${formatCoord(Number(y)-2.8)})}`);
    }
    appendRnlStatements(lines,parsed,stmts);
    return {text:lines.join(parsed.eol),instanceName:'GND',summary:`在 (${rx}, ${ry}) 放置接地符号`};
  }

  if(!model)throw Error('缺少器件型号或单元名。');
  const existingNames=parsed.instances.map(i=>i.name);
  const instName=name&&!existingNames.includes(name)?name:suggestUniqueName(existingNames,prefix);
  const portCount=Math.max(1,Array.isArray(ports)?ports.length:2);
  const assignedNets=[];
  const usedNets=new Set(parsed.netNames);
  for(let i=0;i<portCount;i++){
    const supplied=Array.isArray(nodes)&&nodes[i]?String(nodes[i]).trim():'';
    if(supplied){
      assignedNets.push(supplied);
      usedNets.add(supplied);
    }else{
      const net=suggestUniqueNet(usedNets,'net');
      assignedNets.push(net);
      usedNets.add(net);
    }
  }
  const paramStr=paramsText?String(paramsText).trim():formatParamsList(params);
  const spectreLine=buildSpectreInstanceLine(parsed.indent,instName,assignedNets,model,paramStr);

  // Insert Spectre instance right before the first RNL block in scope (or right after last instance / before `ends`)
  let insertAt;
  if(parsed.instances.length){
    insertAt=parsed.instances[parsed.instances.length-1].end+1;
  }else if(parsed.rnlBlocks.length){
    insertAt=parsed.rnlBlocks[0].start;
  }else if(parsed.scopeName==='(top)'){
    insertAt=lines.length;
  }else{
    insertAt=parsed.scopeEnd+1;
  }
  lines.splice(insertAt,0,spectreLine);

  // Re-parse so line offsets reflect the inserted Spectre statement cleanly
  const reparsed=parseEditableScope(lines.join(parsed.eol),scopeName);
  const nextLines=[...reparsed.lines];
  const symName=symbolId||`%cg_sym_${String(model).replace(/[^A-Za-z0-9_]/g,'_')}`;
  const rnlStmts=[];
  if(!reparsed.symbols.has(symName)){
    rnlStmts.push(symbolDef||buildBlockSymbolDef(symName,model,ports));
  }
  rnlStmts.push(`#"${instName}" @SET-SYMBOL ${symName}`);
  rnlStmts.push(`#"${instName}" @PLACE(${rx}, ${ry}) => @ORIENT("${orient}")`);
  appendRnlStatements(nextLines,reparsed,rnlStmts);

  return {
    text:nextLines.join(reparsed.eol),
    instanceName:instName,
    nets:assignedNets,
    summary:`放置器件 ${instName} (${model}) 到 (${rx}, ${ry})`,
  };
}

/**
 * Move an instance's RNL `@PLACE(x, y)` (and optional `@ORIENT`) inside `scopeName` (M key / drag).
 */
export function moveInstance(text,{scopeName='(top)',instanceName,x,y,orient=null}={}){
  const parsed=parseEditableScope(text,scopeName);
  const inst=parsed.instances.find(i=>i.name===instanceName);
  if(!inst)throw Error(`未在当前层级找到器件 ${instanceName}。`);
  const lines=[...parsed.lines];
  const rx=formatCoord(x),ry=formatCoord(y);
  const place=parsed.placements.get(instanceName);
  const finalOrient=orient||place?.orient||'R0';

  if(place){
    const re=new RegExp(`(#"${escapeRegExp(instanceName)}"\\s*@PLACE\\s*\\()[^)]*(\\)(?:\\s*=>\\s*@ORIENT\\s*\\(\\s*"[^"]*"\\s*\\))?)`);
    lines[place.lineIdx]=lines[place.lineIdx].replace(re,`#"${instanceName}" @PLACE(${rx}, ${ry}) => @ORIENT("${finalOrient}")`);
  }else{
    appendRnlStatements(lines,parsed,[`#"${instanceName}" @PLACE(${rx}, ${ry}) => @ORIENT("${finalOrient}")`]);
  }
  return {
    text:lines.join(parsed.eol),
    instanceName,
    x:Number(rx),
    y:Number(ry),
    orient:finalOrient,
    summary:`移动 ${instanceName} 到 (${rx}, ${ry})`,
  };
}

/**
 * Rotate or mirror an instance's `@ORIENT` in RNL (R key).
 */
export function rotateInstance(text,{scopeName='(top)',instanceName,mode='rotate'}={}){
  const parsed=parseEditableScope(text,scopeName);
  const place=parsed.placements.get(instanceName);
  if(!place)throw Error(`器件 ${instanceName} 尚未放置，无法旋转。`);
  const next=nextOrientation(place.orient,mode);
  const res=moveInstance(text,{scopeName,instanceName,x:place.x,y:place.y,orient:next});
  return {...res,summary:`旋转 ${instanceName} 为 ${next}`};
}

/**
 * Delete an instance from both the Spectre netlist and its RNL symbol/placement/wire lines.
 */
export function deleteInstance(text,{scopeName='(top)',instanceName}={}){
  const parsed=parseEditableScope(text,scopeName);
  const inst=parsed.instances.find(i=>i.name===instanceName);
  if(!inst)throw Error(`未在当前层级找到器件 ${instanceName}。`);
  const lines=[...parsed.lines];
  // Remove RNL lines belonging to this instance (bottom-up so indices stay valid)
  const instRefRe=new RegExp(`#"${escapeRegExp(instanceName)}"(?::|\\s)`);
  const rnlDrop=new Set();
  for(const block of parsed.rnlBlocks){
    for(let i=block.start+1;i<block.end;i++){
      const raw=lines[i];
      if(!instRefRe.test(raw))continue;
      // Only remove single-statement lines cleanly; if line has multiple statements separated by `;`, strip only matching statements
      const stripped=raw.replace(/^\s*\/\//,'');
      const parts=stripped.split(';').map(s=>s.trim()).filter(Boolean);
      const kept=parts.filter(part=>!instRefRe.test(part));
      if(!kept.length){
        rnlDrop.add(i);
      }else{
        const endsSemi=/;\s*$/.test(raw);
        lines[i]='//   '+kept.join('; ')+(endsSemi?';':'');
      }
    }
  }
  for(let i=inst.start;i<=inst.end;i++)rnlDrop.add(i);
  const nextLines=lines.filter((_,idx)=>!rnlDrop.has(idx));
  // Ensure last non-empty statement before closing `// }` doesn't leave a dangling `;` issue (trailing `;` before `}` is harmless or keep clean)
  return {
    text:nextLines.join(parsed.eol),
    instanceName,
    summary:`删除器件 ${instanceName}`,
  };
}

function chooseMergedNet(netA,netB,preferred=''){
  if(preferred&&preferred.trim())return preferred.trim();
  const isAuto=n=>!n||/^net_?\d+$/i.test(n);
  const isSupply=n=>/^(?:0|gnd!?|vss!?|vdd!?|vcm|vref[pn]?)$/i.test(n||'');
  if(netA&&netB&&netA===netB)return netA;
  if(isSupply(netA)&&!isSupply(netB))return netA;
  if(isSupply(netB)&&!isSupply(netA))return netB;
  if(netA&&!isAuto(netA)&&isAuto(netB))return netA;
  if(netB&&!isAuto(netB)&&isAuto(netA))return netB;
  return netA||netB||'';
}

function rewriteNetInScope(lines,parsed,oldNet,newNet){
  if(!oldNet||!newNet||oldNet===newNet)return;
  // 1. Update Spectre instances in scope
  for(let idx=parsed.instances.length-1;idx>=0;idx--){
    const inst=parsed.instances[idx];
    if(!inst.nodes.includes(oldNet))continue;
    const nextNodes=inst.nodes.map(n=>n===oldNet?newNet:n);
    replaceInstanceLine(lines,inst,buildSpectreInstanceLine(inst.indent,inst.name,nextNodes,inst.model,inst.paramsText));
  }
  // 2. Update RNL &"oldNet" references in scope
  const netRe=new RegExp(`&"${escapeRegExp(oldNet)}"`,'g');
  for(const block of parsed.rnlBlocks){
    for(let i=block.start;i<=block.end;i++){
      if(i>=0&&i<lines.length)lines[i]=lines[i].replace(netRe,`&"${newNet}"`);
    }
  }
}

function setInstancePortNet(lines,parsed,instanceName,portIndex,newNet){
  const inst=parsed.instances.find(i=>i.name===instanceName);
  if(!inst||portIndex<0||portIndex>=inst.nodes.length)return;
  if(inst.nodes[portIndex]===newNet)return;
  const nextNodes=[...inst.nodes];
  nextNodes[portIndex]=newNet;
  replaceInstanceLine(lines,inst,buildSpectreInstanceLine(inst.indent,inst.name,nextNodes,inst.model,inst.paramsText));
}

/**
 * Connect two endpoints with an orthogonal RNL `@WIRE` AND synchronize Spectre netlist connectivity (W key).
 * Endpoint shape:
 * - { kind: 'pin', instance, terminal, isNumeric, portIndex, net, x, y }
 * - { kind: 'wire', net, x, y }
 * - { kind: 'point', x, y }
 */
export function connectWire(text,{scopeName='(top)',start,end,waypoints=[],preferredNet=''}={}){
  if(!start||!end)throw Error('连线需要起点和终点。');
  const parsed=parseEditableScope(text,scopeName);
  const lines=[...parsed.lines];

  const netA=start.net||null;
  const netB=end.net||null;
  let targetNet=chooseMergedNet(netA,netB,preferredNet);
  if(!targetNet)targetNet=suggestUniqueNet(parsed.netNames,'net');

  // Synchronize Spectre electrical connectivity!
  if(start.kind==='pin'&&end.kind==='pin'){
    const dropA=netA&&netA!==targetNet;
    const dropB=netB&&netB!==targetNet;
    // If a pin was previously on an auto/single-pin net, just reassign that pin or merge the net across the scope
    if(dropA)rewriteNetInScope(lines,parsed,netA,targetNet);
    if(dropB){
      const mid=parseEditableScope(lines.join(parsed.eol),scopeName);
      rewriteNetInScope(lines,mid,netB,targetNet);
    }
    const afterMerge=parseEditableScope(lines.join(parsed.eol),scopeName);
    setInstancePortNet(lines,afterMerge,start.instance,start.portIndex,targetNet);
    const afterStart=parseEditableScope(lines.join(parsed.eol),scopeName);
    setInstancePortNet(lines,afterStart,end.instance,end.portIndex,targetNet);
  }else if(start.kind==='pin'&&end.kind==='wire'){
    if(netA&&netA!==targetNet)rewriteNetInScope(lines,parsed,netA,targetNet);
    const after=parseEditableScope(lines.join(parsed.eol),scopeName);
    setInstancePortNet(lines,after,start.instance,start.portIndex,targetNet);
  }else if(start.kind==='wire'&&end.kind==='pin'){
    if(netB&&netB!==targetNet)rewriteNetInScope(lines,parsed,netB,targetNet);
    const after=parseEditableScope(lines.join(parsed.eol),scopeName);
    setInstancePortNet(lines,after,end.instance,end.portIndex,targetNet);
  }else if(start.kind==='pin'&&end.kind==='point'){
    if(!netA)setInstancePortNet(lines,parsed,start.instance,start.portIndex,targetNet);
  }else if(start.kind==='point'&&end.kind==='pin'){
    if(!netB)setInstancePortNet(lines,parsed,end.instance,end.portIndex,targetNet);
  }

  // Re-parse after netlist updates so RNL block offsets are exact
  const reparsed=parseEditableScope(lines.join(parsed.eol),scopeName);
  const nextLines=[...reparsed.lines];
  const wireId=suggestUniqueWireId(reparsed.wireIds);

  const tokens=[];
  if(start.kind==='pin')tokens.push(formatTerminalRef(start.instance,start.terminal,start.isNumeric));
  else tokens.push(`(${formatCoord(start.x)}, ${formatCoord(start.y)})`);

  for(const pt of waypoints||[]){
    if(!pt)continue;
    const tok=`(${formatCoord(pt.x)}, ${formatCoord(pt.y)})`;
    if(tokens[tokens.length-1]!==tok)tokens.push(tok);
  }

  const endTok=end.kind==='pin'
    ? formatTerminalRef(end.instance,end.terminal,end.isNumeric)
    : `(${formatCoord(end.x)}, ${formatCoord(end.y)})`;
  if(tokens[tokens.length-1]!==endTok)tokens.push(endTok);

  appendRnlStatements(nextLines,reparsed,[
    `${wireId} = &"${targetNet}" @WIRE(mode="straight") {${tokens.join(' ')}}`,
  ]);

  return {
    text:nextLines.join(reparsed.eol),
    net:targetNet,
    wireId,
    summary:`连接网络 ${targetNet}`,
  };
}

/**
 * Rename a net across the scope's Spectre instances & RNL wires, and optionally place a net text label (L key).
 */
export function labelNet(text,{scopeName='(top)',oldNet,newNet,x=null,y=null}={}){
  const cleanNew=String(newNet||'').trim();
  if(!cleanNew||/\s/.test(cleanNew))throw Error('网络名称不能为空且不能包含空格。');
  const parsed=parseEditableScope(text,scopeName);
  const lines=[...parsed.lines];
  if(oldNet&&oldNet!==cleanNew){
    rewriteNetInScope(lines,parsed,oldNet,cleanNew);
  }
  const reparsed=parseEditableScope(lines.join(parsed.eol),scopeName);
  const nextLines=[...reparsed.lines];
  if(Number.isFinite(Number(x))&&Number.isFinite(Number(y))){
    appendRnlStatements(nextLines,reparsed,[
      `(${formatCoord(x)}, ${formatCoord(y)}) @TEXT("${cleanNew}", size=1, halign="middle", valign="baseline")`,
    ]);
  }
  return {
    text:nextLines.join(reparsed.eol),
    net:cleanNew,
    summary:oldNet&&oldNet!==cleanNew?`将网络 ${oldNet} 重命名为 ${cleanNew}`:`标注网络 ${cleanNew}`,
  };
}
