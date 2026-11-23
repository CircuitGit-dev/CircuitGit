import {parseEnvironmentJson} from './json.js';

const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=512;
const canonical=value=>JSON.stringify(value,(_key,item)=>object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export const AGENT_TESTBENCH_SCHEMA='ic.agent_testbench.v1';

export function checkTestbenchHelpers(value={},supportNames=[]){
  if(!object(value)||Object.keys(value).length>48)throw Error('测试平台最多可包含 48 个辅助文件。');
  const names=new Set(['dut.scs','tb.scs','pdk.scs','agent-testbench.json',...supportNames.map(name=>name.toLowerCase())]);
  for(const [name,text]of Object.entries(value)){
    const parts=name.split('/'),lower=name.toLowerCase();
    if(!name||name.length>240||parts.some(part=>part==='.'||part==='..'||!/^[A-Za-z0-9_.-]{1,128}$/.test(part))||['constants.vams','disciplines.vams'].includes(parts.at(-1).toLowerCase()))throw Error('辅助文件需使用明确的相对路径；标准头文件请通过服务器观察绑定。');
    if([...names].some(other=>lower===other||lower.startsWith(other+'/')||other.startsWith(lower+'/')))throw Error('辅助文件路径重复，或与已有 DUT 支持文件、保留文件及目录冲突。');
    if(typeof text!=='string'||!text.length||new TextEncoder().encode(text).length>512*1024||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(new TextEncoder().encode(text))!==text)throw Error('辅助文件需为不超过 512 KiB 的完整 UTF-8 文本。');
    names.add(lower);
  }
  return clone(value);
}

export function decodeTestbenchHelper(bytes){
  try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw Error('辅助文件不是有效 UTF-8；未修改其字节或替换字符。');}
}

export function editTestbenchHelper(manifest,name,text,{remove=false,supportNames=[]}={}){
  const metadata=parseEnvironmentJson(manifest),helpers=checkTestbenchHelpers(Object.hasOwn(metadata,'helper_files')?metadata.helper_files:{},supportNames);
  if(remove){if(!Object.hasOwn(helpers,name))throw Error('辅助文件已变化，请重新核对。');delete helpers[name];}
  else Object.defineProperty(helpers,name,{value:text,enumerable:true,writable:true,configurable:true});
  metadata.helper_files=checkTestbenchHelpers(helpers,supportNames);return JSON.stringify(metadata,null,2)+'\n';
}

// Textareas normalize CR/CRLF. Preserve the original bytes outside the edited
// span and use the file's existing newline form for newly inserted lines.
export function preserveHelperLineEndings(previous,next){
  const normalized=previous.replace(/\r\n?/g,'\n');if(normalized===next)return previous;
  let start=0,end=0;while(start<normalized.length&&start<next.length&&normalized[start]===next[start])start++;
  while(end<normalized.length-start&&end<next.length-start&&normalized[normalized.length-end-1]===next[next.length-end-1])end++;
  const offsets=[0];for(let index=0;index<previous.length;){if(previous[index++]==='\r'&&previous[index]==='\n')index++;offsets.push(index);}
  const newline=previous.match(/\r\n|\r|\n/)?.[0]||'\n';
  return previous.slice(0,offsets[start])+next.slice(start,next.length-end).replace(/\n/g,newline)+previous.slice(offsets[normalized.length-end]);
}

export function checkTestbenchHeaderSelection(selection,session){
  if(!selection||!Object.hasOwn(selection,'veriloga_header_id'))return;
  const candidate=session?.discovery?.candidates?.find(row=>row.candidate_id===selection.candidate_id),header=session?.veriloga_headers?.find(row=>row.id===selection.veriloga_header_id);
  if(!header||!candidate||!/^headers_[a-f0-9]{64}$/.test(selection.veriloga_header_id)||header.probe_id!==candidate.probe_id||!session.probes?.some(row=>row.probe_id===header.probe_id))throw Error('标准头文件必须来自所选 PDK 对应的当前主机观察。');
  if(header.status!=='observed'||header.coverage?.complete!==true||!Array.isArray(header.missing)||header.missing.length)throw Error('标准头文件观察不完整；请核对缺失项后重新探测。');
}

export function checkTestbenchDocument(value){
  if(!object(value)||value.schema!==AGENT_TESTBENCH_SCHEMA||typeof value.text!=='string'||!value.text.trim()||
     new TextEncoder().encode(value.text).length>1024*1024||!object(value.interface)||
     typeof value.interface.subckt!=='string'||typeof value.interface.instance!=='string'||!object(value.interface.port_bindings)||
     Object.values(value.interface.port_bindings).some(value=>typeof value!=='string')||
     ['analyses','stimuli','objectives','criteria'].some(key=>!Array.isArray(value[key]))||!object(value.postprocess))
    throw Error('测试平台文档缺少完整 Spectre、接口或实验说明。');
  // Exact operation fields and scientific validity are checked by the backend's
  // canonical validator. Preserve all author-supplied metadata in the editor.
  checkTestbenchHelpers(Object.hasOwn(value,'helper_files')?value.helper_files:{});
  return clone(value);
}

export function checkAgentTestbench(session){
  const value=session?.agent_tb;if(value==null)return null;
  if(!object(value)||value.schema!=='ic.onboarding.agent-tb.v1'||!sha(value.draft_id)||!sha(value.source_sha256)||
     value.source_sha256!==session.source_sha256||!sha(value.testbench_sha256)||!sha(value.manifest_sha256)||
     !Number.isSafeInteger(value.revision)||value.revision<1||value.revision>session.revision||
     !['draft','prepared'].includes(value.status)||value.requires_human_review!==true||value.selection!==null&&!object(value.selection))throw Error('测试平台草稿与当前电路或版本不一致。');
  checkTestbenchDocument(value.testbench);return clone(value);
}

export function agentReviewIdentity(session){
  const draft=checkAgentTestbench(session),review=session?.agent_tb_review;if(!draft||!review)return null;
  if(review.state==='stale')return null;
  if(review.schema!=='ic.agent-tb.review.v1'||!sha(review.review_id)||!sha(review.review_digest)||review.connection_id!==session.connection_id||review.intake_id!==session.intake_id||
     !Number.isSafeInteger(review.revision)||review.revision<1||review.revision>session.revision||review.draft_id!==draft.draft_id||
     !sha(review.plan_id)||review.plan_id!==session.prepared?.plan_id||review.requires_human!==true||
     !['pending','approved','denied','stale'].includes(review.state))throw Error('人工审阅凭据与当前测试平台计划不一致。');
  return clone(review);
}

export function createAgentDraftEditor({changed=()=>{}}={}){
  let current=null,saved=null,observedSession=null,code='',manifest='',selection='',conflict=false;
  const parsed=()=>{
    const metadata=parseEnvironmentJson(manifest),selected=parseEnvironmentJson(selection);
    if(Object.hasOwn(metadata,'text'))throw Error('完整 Spectre 请在代码页编辑，元数据不能另含 text 字段。');
    return {testbench:checkTestbenchDocument({...metadata,text:code}),selection:Object.keys(selected).length?selected:null};
  };
  const dirty=()=>{if(!saved)return false;try{return canonical(parsed())!==canonical(saved);}catch{return true;}};
  function reset(session){
    observedSession=session;
    const draft=checkAgentTestbench(session);current=draft?{connectionId:session.connection_id,intakeId:session.intake_id,sourceSha256:session.source_sha256,revision:session.revision,draftId:draft.draft_id}:null;
    saved=draft?{testbench:clone(draft.testbench),selection:clone(draft.selection)}:null;conflict=false;
    const metadata=saved?{...saved.testbench}:{};delete metadata.text;
    code=saved?.testbench.text||'';manifest=saved?JSON.stringify(metadata,null,2)+'\n':'';selection=saved?JSON.stringify(saved.selection||{},null,2)+'\n':'';
  }
  return Object.freeze({
    get state(){let error=null;try{if(saved){const value=parsed();checkTestbenchHelpers(value.testbench.helper_files??{},Object.keys(observedSession?.agent_tb?.support_sha256||{}));checkTestbenchHeaderSelection(value.selection,observedSession);}}catch(reason){error=reason.message;}return {binding:clone(current),code,manifest,selection,dirty:dirty(),conflict,error};},
    observe(session){
      observedSession=session;
      const draft=checkAgentTestbench(session),same=current&&current.connectionId===session?.connection_id&&current.intakeId===session?.intake_id&&current.sourceSha256===session?.source_sha256;
      if(!draft){if(current&&dirty())conflict=true;else reset(null);return;}
      if(same&&current.draftId===draft.draft_id){current.revision=session.revision;return;}
      if(current&&dirty()){conflict=true;return;}
      reset(session);
    },
    edit(field,value){if(!saved||!['code','manifest','selection'].includes(field)||typeof value!=='string'||new TextEncoder().encode(value).length>1024*1024)throw Error('测试平台编辑内容超出范围。');if(field==='code')code=value;else if(field==='manifest')manifest=value;else selection=value;changed();},
    read(session){
      if(conflict||!current||current.connectionId!==session?.connection_id||current.intakeId!==session?.intake_id||current.sourceSha256!==session?.source_sha256||current.draftId!==session?.agent_tb?.draft_id)
        throw Error('测试平台已被另一操作更新；请核对新版本，尚未覆盖你的草稿。');
      const value=parsed();checkTestbenchHelpers(value.testbench.helper_files??{},Object.keys(session.agent_tb?.support_sha256||{}));checkTestbenchHeaderSelection(value.selection,session);
      return {...value,intake_id:session.intake_id,revision:session.revision};
    },
    accept(session){reset(session);changed();},
    reset(session=null){reset(session);changed();},
  });
}
