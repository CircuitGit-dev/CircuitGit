// Bounded Spectre source index; drawing is rendered by the actual upstream RNL core.
// It is not a Spectre netlister or an OA reader.
export const supportedScopes=['Switch','PIPE_OTA_Diff_Ideal'];
export const hashText=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
const decoded=s=>s.replace(/\\([<>\[\]])/g,'$1');
const key=(path,scope,kind,name)=>[path,scope,kind,name].map(encodeURIComponent).join('::');
export function indexSpectre(text,path){
  if(typeof text!=='string'||text.length>4*1024*1024)throw Error('Source is absent or exceeds 4 MiB');
  const lines=text.split('\n'), scopes=[], objects=[], seen=new Set();let scope=null;
  for(let i=0;i<lines.length;i++){
    const raw=lines[i];if(/^\s*(?:\/\/|\*|$)/.test(raw))continue;
    let statement=raw,start=i+1;
    while(/\\\s*$/.test(statement)&&i+1<lines.length){statement=statement.replace(/\\\s*$/,' ')+' '+lines[++i].trim();}
    const sub=/^\s*subckt\s+(\S+)\s*(.*)$/.exec(statement);
    if(sub){if(scope)throw Error('Nested subcircuits are not supported');scope={name:sub[1],line_start:start,line_end:null,ports:sub[2].trim().split(/\s+/),instances:[]};scopes.push(scope);continue;}
    if(/^\s*ends(?:\s|$)/.test(statement)){if(!scope)throw Error('Unexpected ends');scope.line_end=i+1;scope=null;continue;}
    const m=/^\s*([^\s()]+)\s+\(([^)]*)\)\s+(\S+)(.*)$/.exec(statement);
    if(!m){
      if(/^\s*(?:simulator|global|parameters|include|ahdl_include|save|saveOptions|simulatorOptions|tran)\b/.test(statement)||/^\s*\S+\s+info\b/.test(statement))continue;
      throw Error(`Unsupported or malformed source statement at line ${start}; preview was not synchronized`);
    }
    const name=decoded(m[1]),sc=scope?.name??'(top)',id=key(path,sc,'instance',name);
    if(seen.has(id))throw Error('Duplicate instance name in scope');seen.add(id);
    const obj={kind:'instance',id,name,scope:sc,source_path:path,line_start:start,line_end:i+1,master:m[3],parameters:m[4].trim(),nodes:m[2].trim().split(/\s+/).map(decoded)};
    objects.push(obj);scope?.instances.push(obj);
    for(const net of new Set(obj.nodes)){
      const nid=key(path,sc,'net',net);let n=objects.find(o=>o.id===nid);
      if(!n){n={kind:'net',id:nid,name:net,scope:sc,source_path:path,line_start:start,line_end:i+1,locations:[]};objects.push(n);}
      n.locations.push({line_start:start,line_end:i+1,instance_id:id});
    }
  }
  if(scope)throw Error('Unclosed subcircuit');
  return {schema:'ic.source-map.v1',source_path:path,scopes,objects};
}
const positions={Switch:{R0:[8,4,'R90'],W0:[22,4,'R0']},PIPE_OTA_Diff_Ideal:{I0:[0,12,'R0'],E4:[12,10,'R0'],R0:[36,0,'R0'],R4:[44,0,'R0'],G0:[28,10,'R0'],G1:[36,-12,'R0'],G3:[44,-12,'R0']}};
export function deriveView(text,path,requestedScope){
  const mapping=indexSpectre(text,path);
  if(mapping.scopes.length&&(!requestedScope||!supportedScopes.includes(requestedScope)))return deriveHierarchy(text,path,mapping,requestedScope);
  const scope=mapping.scopes.find(s=>s.name===(requestedScope||'Switch')&&supportedScopes.includes(s.name))??mapping.scopes.find(s=>supportedScopes.includes(s.name));
  // Flat R/C circuits are useful for the gateway smoke project; no fabricated ADC hierarchy.
  const flat=!scope&&!mapping.scopes.length&&mapping.objects.filter(o=>o.kind==='instance').every(o=>['resistor','capacitor','vsource','isource'].includes(o.master));
  if(!scope&&!flat)throw Error('No supported display scope; source remains editable');
  const name=scope?.name??'(top)',start=scope?.line_start??1,end=scope?.line_end??text.split('\n').length;
  const sourceLines=text.split('\n').slice(start-1,end),inst=mapping.objects.filter(o=>o.kind==='instance'&&o.scope===name);
  if(sourceLines.some(line=>/^\s*(?:include|ahdl_include)\s/i.test(line)||line.includes('@RNL')))throw Error('Preview scope must not contain external includes or authored RNL; original text remains available');
  if(!inst.length)throw Error('Supported display has no instances');
  const annotation=['// @RNL {'];
  for(let i=0;i<inst.length;i++){
    const o=inst[i];if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.name))throw Error('Unsupported display instance spelling');
    const [x,y,rotation]=positions[name]?.[o.name]??[i*12,0,'R0'];
    annotation.push(`//   #${o.name} @PLACE(${x}, ${y}); #${o.name} @ORIENT("${rotation}");`);
  }
  for(const n of mapping.objects.filter(o=>o.kind==='net'&&o.scope===name)){
    const pins=inst.flatMap(o=>o.nodes.map((node,i)=>node===n.name?`#${o.name}:${i+1}`:null).filter(Boolean));
    if(pins.length>1)annotation.push(`//   &${JSON.stringify(n.name)} @WIRE {${pins.join(' ')}};`);
  }
  annotation.push('// }');
  if(scope)sourceLines.splice(sourceLines.length-1,0,...annotation);else sourceLines.push(...annotation);
  const header=['// Derived display only. Authoritative circuit remains in the source editor.','simulator lang=spectre','// @RNL(type="header") { @VERSION("0.3"); @USE-PACKAGE(name="rnl-std-fill") {} }'];
  return {text:header.concat(sourceLines).join('\n')+'\n',name:'derived.scs',scope:name,mapping,
    coverage:{drawn_scope:name,drawn_instances:inst.length,total_instances:mapping.objects.filter(o=>o.kind==='instance').length,
      geometry:'derived display placement; not original OA geometry',source_line_start:start,source_line_end:end},
    limitations:['Only supported module geometry is displayed','PDK/device behavior is not simulated by the viewer','No OA geometry synchronization is claimed']};
}

function deriveHierarchy(text,path,mapping,requestedScope){
  if(text.includes('@RNL'))throw Error('Authored RNL requires a dedicated mapping adapter');
  const desired=requestedScope??(mapping.scopes.find(s=>s.name==='PIPE_TOP_F4_RS9_N06')?.name??mapping.scopes.at(-1)?.name);
  if(desired!=='(top)'&&!mapping.scopes.some(s=>s.name===desired))throw Error('Requested scope does not exist');
  const all=mapping.objects.filter(o=>o.kind==='instance');
  if(all.length>2000)throw Error('Hierarchy exceeds this adapter’s 2000-instance limit');
  const lines=text.split('\n'),omitted=[];
  // Includes are intentionally omitted only from the derived display so vendor/private paths
  // are never fetched. Every device/subcircuit line remains byte-for-byte unchanged.
  for(let i=0;i<lines.length;i++)if(/^\s*(?:include|ahdl_include)\s/.test(lines[i])){omitted.push(i+1);lines[i]='// External include omitted from display only';}
  function records(scope){
    const inst=all.filter(o=>o.scope===scope),r=['// @RNL {'];
    const cols=Math.max(2,Math.ceil(Math.sqrt(inst.length*1.6))),rowHeight=22;
    const builtin=new Set(['resistor','capacitor','vsource','isource','inductor','vcvs','vccs','relay']);
    const block=new Map();
    for(const o of inst)if(!builtin.has(o.master)&&!/^(nch|pch)/.test(o.master)){
      const signature=o.master+'/'+o.nodes.length;
      if(block.has(signature))continue;
      const sym='$IC_BLOCK_'+block.size;block.set(signature,sym);
      r.push(`// ${sym} = @DEFINE-SYMBOL {`);
      const half=Math.ceil(o.nodes.length/2);
      for(let i=0;i<o.nodes.length;i++){
        const left=i<half,j=left?i:i-half,count=left?half:o.nodes.length-half;
        const y=count<=1?0:4-j*8/(count-1);
        r.push(`// (${left?-8:8},${y.toFixed(4)}) @PIN(terminal=${i+1},direction="${left?'left':'right'}");`);
      }
      r.push('// @LINE {(-8,5) (8,5) (8,-5) (-8,-5) (-8,5)};',
        '// ? @TEXT("${name}",key="name",size=0.8) => @PLACE(0,6);',
        `// ? @TEXT("${o.nodes.length} ports",key="ports",size=0.6) => @PLACE(0,0);`,
        '// };');
    }
    for(let i=0;i<inst.length;i++){
      const o=inst[i],ref='#'+JSON.stringify(o.name),[x,y,rot]=positions[scope]?.[o.name]??[(i%cols)*26,-Math.floor(i/cols)*rowHeight,'R0'];
      r.push(`// ${ref} @PLACE(${x},${y}); ${ref} @ORIENT("${rot}");`);
      if(/^(nch|pch)/.test(o.master))r.push(`// ${ref} @SET-SYMBOL $${o.master.startsWith('n')?'NMOS':'PMOS'}_4TERM;`);
      const sym=block.get(o.master+'/'+o.nodes.length);if(sym)r.push(`// ${ref} @SET-SYMBOL ${sym};`);
    }
    for(const net of mapping.objects.filter(o=>o.kind==='net'&&o.scope===scope)){
      const pins=inst.flatMap(o=>o.nodes.map((node,i)=>node===net.name?'#'+JSON.stringify(o.name)+':'+(i+1):null).filter(Boolean));
      if(pins.length>1)r.push(`// &${JSON.stringify(net.name)} @WIRE {${pins.join(' ')}};`);
    }
    r.push('// }');return r;
  }
  for(const scope of [...mapping.scopes].reverse())lines.splice(scope.line_end-1,0,...records(scope.name));
  lines.push(...records('(top)'));
  const header=['// Derived hierarchy display. Electrical source remains authoritative.','// @RNL(type="header") { @VERSION("0.3"); @USE-PACKAGE(name="rnl-std-fill") {} }'];
  return {text:header.concat(lines).join('\n'),name:'derived.scs',scope:desired,mapping,
    coverage:{drawn_scope:desired,drawn_instances:all.filter(o=>o.scope===desired).length,total_instances:all.length,
      available_scopes:['(top)',...mapping.scopes.map(s=>s.name)],placed_instances:all.length,
      geometry:'derived block/device placement with true terminal connections; not original OA geometry',external_include_lines_omitted:omitted},
    limitations:['PDK/standard-cell/behavioral masters without definitions are terminal boxes','Dense nets may overlap in the derived placement','Source instances and ports preserved; external include implementations omitted','Original OA geometry is a separate immutable snapshot']};
}
