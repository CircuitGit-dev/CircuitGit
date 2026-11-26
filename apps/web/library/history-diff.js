// Circuit-focused history filtering and RNL-aware diff parser for library versions.

const CIRCUIT_EXT_RE=/\.(?:scs|rnl|sp|spice|cir|cdl|ckt|net|inc|va|vams)$/i;
const RNL_EXT_RE=/\.rnl$/i;
const VA_EXT_RE=/\.(?:va|vams)$/i;
const RNL_LINE_RE=/^\s*\/\/\s*(?:@RNL\b|.*(?:@PLACE|@WIRE|@SET-SYMBOL|@DEFINE-SYMBOL|@PIN|@LINE|@CIRCLE|@RECT|@ARC|@TEXT|@VERSION|@USE-PACKAGE|@LABEL|@PORT|@STYLE|@ATTR)\b|.*=>\s*@|.*#"[^"]+"|.*&"[^"]+"|%[A-Za-z0-9_]+\s*=)/;
const RNL_START_RE=/^\s*\/\/\s*@RNL\b/;
const RNL_END_RE=/^\s*\/\/\s*\}\s*;?\s*$/;

export function isCircuitSourcePath(path){
  return typeof path==='string'&&CIRCUIT_EXT_RE.test(path.trim());
}

export function isRnlFilePath(path){
  return typeof path==='string'&&RNL_EXT_RE.test(path.trim());
}

export function circuitFileKind(path){
  if(!path)return '网表';
  if(VA_EXT_RE.test(path))return 'Verilog-A';
  if(RNL_EXT_RE.test(path)||/\/schematic\//i.test(path))return '原理图 / RNL';
  if(/\/simulation\//i.test(path))return '仿真网表';
  return '网表';
}

export function isDiffLimitError(error){
  if(!error)return false;
  if(error.status===413||error.data?.code==='diff_limit')return true;
  return /diff_limit|exceeds\s+(?:the\s+)?review\s+(?:bounds|limit)/i.test(String(error.message||error));
}

export function shortFileName(path){
  if(typeof path!=='string')return '';
  const clean=path.replace(/^[ab]\//,'');
  return clean.split('/').pop()||clean;
}

/**
 * Filter commit history to commits that touch actual schematic/netlist/RNL/Verilog-A sources.
 * Commits touching only README.md, provenance.json, source-bindings.json, ci.json, etc. are hidden by default.
 */
export function filterCircuitCommits(commits,{includeNonCircuit=false}={}){
  const list=Array.isArray(commits)?commits:[];
  const visible=[];
  let hiddenCount=0;
  for(const commit of list){
    if(!commit)continue;
    if(!Array.isArray(commit.files)){
      visible.push({...commit,circuitFiles:[]});
      continue;
    }
    const paths=commit.files.map(item=>typeof item==='string'?item:item?.path).filter(Boolean);
    const circuitFiles=paths.filter(isCircuitSourcePath);
    if(circuitFiles.length>0){
      // Prefer schematic/RNL files ahead of simulation copies
      const sorted=[...circuitFiles].sort((a,b)=>{
        const sa=/\/schematic\//i.test(a)||RNL_EXT_RE.test(a)?0:1;
        const sb=/\/schematic\//i.test(b)||RNL_EXT_RE.test(b)?0:1;
        return sa-sb||a.localeCompare(b);
      });
      visible.push({...commit,circuitFiles:sorted});
    }else if(includeNonCircuit){
      visible.push({...commit,circuitFiles:[],nonCircuitOnly:true});
    }else{
      hiddenCount++;
    }
  }
  return {visible,hiddenCount};
}

function cleanDiffPath(headerLine){
  const raw=headerLine.replace(/^(?:---|\+\+\+)\s+/,'').trim().split('\t')[0].trim();
  if(raw==='/dev/null')return null;
  return raw.replace(/^[ab]\//,'');
}

function classifyCodeLine(text,{isCircuit,isRnlFile,inRnlBlock}){
  if(!isCircuit)return {category:'doc',nextInRnl:false};
  const trimmed=text.trim();
  if(isRnlFile){
    return {category:trimmed?'rnl':'comment',nextInRnl:false};
  }
  if(RNL_START_RE.test(text)){
    const closesSameLine=/\{.*\}/.test(text);
    return {category:'rnl',nextInRnl:!closesSameLine};
  }
  if(inRnlBlock){
    if(RNL_END_RE.test(text))return {category:'rnl',nextInRnl:false};
    if(/^\s*\/\//.test(text))return {category:'rnl',nextInRnl:true};
    // Exited comment block without explicit closing brace
    return {category:trimmed?'netlist':'comment',nextInRnl:false};
  }
  if(RNL_LINE_RE.test(text)){
    return {category:'rnl',nextInRnl:false};
  }
  if(!trimmed||/^\s*(?:\/\/|\*)/.test(text)){
    return {category:'comment',nextInRnl:false};
  }
  return {category:'netlist',nextInRnl:false};
}

function detectRnlTopics(lines){
  const topics=[];
  const joined=lines.join('\n');
  const checks=[
    [/@PLACE\b/,'器件摆放'],
    [/@WIRE\b/,'连线路由'],
    [/@(?:SET-SYMBOL|DEFINE-SYMBOL)\b/,'符号定义'],
    [/@PIN\b/,'引脚'],
    [/@(?:TEXT|LABEL)\b/,'文字标注'],
    [/@(?:LINE|CIRCLE|RECT|ARC)\b/,'图形元素'],
    [/@(?:USE-PACKAGE|VERSION)\b/,'RNL 头部配置'],
  ];
  for(const [re,label] of checks){
    if(re.test(joined))topics.push(label);
  }
  return topics;
}

function detectNetlistEntities(lines){
  const names=[];
  const seen=new Set();
  for(const line of lines){
    const trimmed=line.trim();
    if(!trimmed)continue;
    let name=null;
    const sub=/^(?:\.?subckt)\s+([A-Za-z0-9_.$]+)/i.exec(trimmed);
    const param=/^parameters\b/i.exec(trimmed);
    const inc=/^include\s+"?([^"\s]+)"?/i.exec(trimmed);
    const inst=/^([A-Za-z_][A-Za-z0-9_<>:.$]*)\s*\(/.exec(trimmed);
    if(sub)name=`subckt ${sub[1]}`;
    else if(param)name='parameters';
    else if(inc)name=`include ${inc[1].split('/').pop()}`;
    else if(inst&&!/^(?:simulator|global|save|saveOptions|tran|ac|dc|options|ends)$/i.test(inst[1]))name=inst[1];
    if(name&&!seen.has(name)){
      seen.add(name);
      names.push(name);
      if(names.length>=6)break;
    }
  }
  return names;
}

/**
 * Parse a unified diff (single or multi-file, or headerless snippet) into structured file blocks
 * with RNL vs Netlist vs Doc line classification and human-readable Chinese summaries.
 */
export function parseCircuitDiff(rawDiff,{fallbackPath=''}={}){
  const text=typeof rawDiff==='string'?rawDiff:'';
  const rawLines=text.split(/\r?\n/);
  const files=[];
  let currentFile=null;
  let currentHunk=null;
  let inRnlBlock=false;

  const ensureFile=(path)=>{
    const clean=path||fallbackPath||'当前网表';
    const isCircuit=path?isCircuitSourcePath(clean):true;
    const file={
      path:clean,
      name:shortFileName(clean),
      isCircuit,
      isRnlFile:isRnlFilePath(clean),
      kind:isCircuit?circuitFileKind(clean):'文档 / 配置',
      hunks:[],
      rnlAdded:0,
      rnlRemoved:0,
      netlistAdded:0,
      netlistRemoved:0,
      totalAdded:0,
      totalRemoved:0,
    };
    files.push(file);
    currentFile=file;
    currentHunk=null;
    inRnlBlock=false;
    return file;
  };

  const ensureHunk=(header='@@ 改动片段 @@')=>{
    if(!currentFile)ensureFile(fallbackPath||'');
    const hunk={header,lines:[]};
    currentFile.hunks.push(hunk);
    currentHunk=hunk;
    inRnlBlock=false;
    return hunk;
  };

  for(let i=0;i<rawLines.length;i++){
    const line=rawLines[i];
    if(line.startsWith('diff --git '))continue;
    if(line.startsWith('--- ')&&i+1<rawLines.length&&rawLines[i+1].startsWith('+++ ')){
      const fromPath=cleanDiffPath(line);
      const toPath=cleanDiffPath(rawLines[i+1]);
      ensureFile(toPath||fromPath||fallbackPath||'未知文件');
      i++;
      continue;
    }
    if(line.startsWith('@@ ')){
      ensureHunk(line);
      continue;
    }
    if(line.startsWith('\\ No newline at end of file'))continue;
    if(!line&&i===rawLines.length-1)continue;

    const sign=line[0];
    if(sign==='+'||sign==='-'||sign===' '){
      if(!currentHunk)ensureHunk();
      const content=line.slice(1);
      const {category,nextInRnl}=classifyCodeLine(content,{
        isCircuit:currentFile.isCircuit,
        isRnlFile:currentFile.isRnlFile,
        inRnlBlock,
      });
      inRnlBlock=nextInRnl;
      const type=sign==='+'?'add':sign==='-'?'del':'ctx';
      currentHunk.lines.push({type,sign,text:content,category});
      if(type==='add'){
        currentFile.totalAdded++;
        if(category==='rnl')currentFile.rnlAdded++;
        else if(category==='netlist')currentFile.netlistAdded++;
      }else if(type==='del'){
        currentFile.totalRemoved++;
        if(category==='rnl')currentFile.rnlRemoved++;
        else if(category==='netlist')currentFile.netlistRemoved++;
      }
    }
  }

  const circuitFiles=files.filter(f=>f.isCircuit);
  const nonCircuitFiles=files.filter(f=>!f.isCircuit);
  const rnlLines=[],netlistLines=[];
  let rnlAdded=0,rnlRemoved=0,netlistAdded=0,netlistRemoved=0,circuitAdded=0,circuitRemoved=0;

  for(const f of circuitFiles){
    rnlAdded+=f.rnlAdded;rnlRemoved+=f.rnlRemoved;
    netlistAdded+=f.netlistAdded;netlistRemoved+=f.netlistRemoved;
    circuitAdded+=f.totalAdded;circuitRemoved+=f.totalRemoved;
    for(const h of f.hunks){
      for(const row of h.lines){
        if(row.type==='ctx')continue;
        if(row.category==='rnl')rnlLines.push(row.text);
        else if(row.category==='netlist')netlistLines.push(row.text);
      }
    }
  }

  const rnlTopics=detectRnlTopics(rnlLines);
  const netlistEntities=detectNetlistEntities(netlistLines);
  const summary=[];
  if(rnlAdded+rnlRemoved>0){
    const topicText=rnlTopics.length?`（涉及：${rnlTopics.join('、')}）`:'';
    summary.push(`RNL 原理图变动：+${rnlAdded} / -${rnlRemoved} 行${topicText}`);
  }
  if(netlistAdded+netlistRemoved>0){
    const entityText=netlistEntities.length?`（涉及：${netlistEntities.join('、')}）`:'';
    summary.push(`网表电路变动：+${netlistAdded} / -${netlistRemoved} 行${entityText}`);
  }
  if(!summary.length&&circuitAdded+circuitRemoved>0){
    summary.push(`网表注释/格式变动：+${circuitAdded} / -${circuitRemoved} 行`);
  }
  if(!circuitFiles.length&&nonCircuitFiles.length){
    summary.push('本次提交仅修改了说明文档或元数据，未修改原理图与网表。');
  }

  const defaultMode=(rnlAdded+rnlRemoved)>0?'rnl':'circuit';

  return {
    files,
    circuitFiles,
    nonCircuitFiles,
    rnlAdded,
    rnlRemoved,
    netlistAdded,
    netlistRemoved,
    circuitAdded,
    circuitRemoved,
    rnlTopics,
    netlistEntities,
    summary,
    defaultMode,
    hasRnlChanges:rnlAdded+rnlRemoved>0,
    hasCircuitChanges:circuitAdded+circuitRemoved>0,
  };
}

/**
 * Extract filtered file sections & changed lines for a specific view mode:
 * - 'rnl': ONLY changed RNL schematic lines (+/-) inside circuit files
 * - 'circuit': ALL changed lines in circuit files (RNL + Spectre/SPICE netlist + Verilog-A)
 * - 'all': all files including docs/JSON
 */
export function selectDiffSections(parsed,mode='rnl'){
  if(!parsed)return [];
  const sourceFiles=mode==='all'?parsed.files:parsed.circuitFiles;
  const out=[];
  for(const file of sourceFiles){
    const hunks=[];
    let added=0,removed=0;
    for(const hunk of file.hunks){
      let lines;
      if(mode==='rnl'){
        lines=hunk.lines.filter(row=>row.type!=='ctx'&&row.category==='rnl');
      }else if(mode==='circuit'){
        // Keep changed lines plus up to 1 line of adjacent context for readability
        const keep=new Set();
        hunk.lines.forEach((row,idx)=>{
          if(row.type!=='ctx'){
            keep.add(idx);
            if(idx>0&&hunk.lines[idx-1].type==='ctx')keep.add(idx-1);
            if(idx+1<hunk.lines.length&&hunk.lines[idx+1].type==='ctx')keep.add(idx+1);
          }
        });
        lines=hunk.lines.filter((_,idx)=>keep.has(idx));
      }else{
        lines=hunk.lines;
      }
      if(!lines.length)continue;
      for(const row of lines){
        if(row.type==='add')added++;
        else if(row.type==='del')removed++;
      }
      hunks.push({header:hunk.header,lines});
    }
    if(!hunks.length)continue;
    out.push({...file,hunks,added,removed});
  }
  return out;
}
