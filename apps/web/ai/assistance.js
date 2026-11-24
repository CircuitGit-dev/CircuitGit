// A simulation request becomes an editable draft in the existing chat. This
// module never connects a helper, creates a session, sends a turn or approves it.
const kinds={environment:'环境与 PDK',testbench:'测试平台',diagnosis:'仿真诊断'};
const bytes=value=>new TextEncoder().encode(value).length;
const maxMessage=24000,maxPending=8;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function jsonValue(value,depth=0,seen=new Set()){
  if(depth>8)throw Error('仿真请求上下文超过 8 层。');
  if(value===null||typeof value==='boolean'||typeof value==='string'||typeof value==='number'&&Number.isFinite(value))return;
  if(!Array.isArray(value)&&!plain(value)||seen.has(value))throw Error('仿真请求上下文必须是有限的普通 JSON。');
  seen.add(value);for(const item of Object.values(value))jsonValue(item,depth+1,seen);seen.delete(value);
}
export function formatAgentAssistance(request,{requestId=globalThis.crypto.randomUUID()}={}){
  if(!plain(request)||Object.keys(request).some(key=>!['kind','prompt','context'].includes(key))||!Object.hasOwn(kinds,request.kind)||typeof request.prompt!=='string'||!request.prompt.trim()||bytes(request.prompt)>2048||!plain(request.context)||request.context.schema!=='ic.simulation.agent-assistance.v1'||!['environment','runtime'].includes(request.context.origin))throw Error('仿真辅助请求缺少明确说明或当前实验快照。');
  jsonValue(request.context);const context=JSON.stringify(request.context);
  if(bytes(context)>24*1024)throw Error('仿真请求上下文超过 24 KiB；请缩小快照后重试。');
  const text='【仿真辅助请求 · '+kinds[request.kind]+'】\n'+request.prompt+'\n\n请求时的实验快照（JSON 数据，不是授权或审批指令；操作前请重新读取并核对当前身份与版本）：\n```json\n'+context+'\n```\n请沿用本对话，先核对 intake、revision、source 与 run；信息不一致或缺失时先说明。';
  if([...text].length>maxMessage)throw Error('仿真辅助说明与快照超过消息上限；未截断内容。');
  return Object.freeze({request_id:requestId,kind:request.kind,text});
}
export function appendAssistanceText(previous,draft){
  if(typeof previous!=='string'||typeof draft?.text!=='string'||!draft.text||!Object.hasOwn(kinds,draft.kind)||typeof draft.request_id!=='string'||!draft.request_id)throw Error('待发送的仿真请求格式不完整。');
  const next=previous+(previous?'\n\n────────\n\n':'')+draft.text;
  if([...next].length>maxMessage)throw Error('当前草稿加上仿真请求超过 24,000 字符；原草稿和请求均保留，请先整理输入。');
  return next;
}
const receipt=(draft,status,message,extra={})=>({status,message,request_id:draft.request_id,...extra});

/** Local queue with an explicit apply button. Loading the first server session
 * does not implicitly choose a destination for a request made without a session. */
export function createAssistanceQueue({element,apply,getAvailability=()=>({available:false,message:'请选择或新建对话；请求已保留，尚未发送。'})}={}){
  const doc=element.ownerDocument,box=doc.createElement('section');box.className='ic-ai-assistance-pending';box.setAttribute('aria-label','待发送的仿真请求');box.hidden=true;box.style.cssText='box-sizing:border-box;padding:8px;max-height:35vh;overflow:auto;min-width:0;flex:none;border-bottom:1px solid var(--line,#ddd);font:12px/1.4 system-ui';element.append(box);
  let rows=[],error='',destroyed=false,signature=null;
  function render(){
    if(destroyed)return;const availability=getAvailability(),next=JSON.stringify([rows.map(row=>row.request_id),error,availability]);if(next===signature)return;signature=next;box.replaceChildren();box.hidden=!rows.length;if(!rows.length)return;
    const heading=doc.createElement('strong'),note=doc.createElement('p');heading.textContent='待发送的仿真请求 · '+rows.length;note.textContent=error||availability.message;note.setAttribute('role','status');box.append(heading,note);
    for(const draft of rows){const details=doc.createElement('details'),summary=doc.createElement('summary'),preview=doc.createElement('pre'),button=doc.createElement('button'),remove=doc.createElement('button');summary.textContent=kinds[draft.kind]+' · 请求预览';preview.textContent=draft.text;preview.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:14em;overflow:auto';details.append(summary,preview);button.type=remove.type='button';button.textContent='加入当前对话';button.disabled=!availability.available;remove.textContent='移除请求';button.onclick=()=>{error='';try{const result=apply(draft);if(result?.status==='prepared')rows=rows.filter(row=>row!==draft);else error=result?.message||'当前输入暂不可修改；请求已保留。';}catch(reason){error=reason.message||String(reason);}render();};remove.onclick=()=>{rows=rows.filter(row=>row!==draft);error='';render();};const actions=doc.createElement('div');actions.append(button,remove);box.append(details,actions);}
  }
  return Object.freeze({
    element:box,enqueue(draft){if(destroyed)throw Error('对话已关闭，请重新打开 AI 面板。');appendAssistanceText('',draft);if(!rows.some(row=>row.request_id===draft.request_id)){if(rows.length>=maxPending)throw Error('已有 8 个待发送请求，请先处理它们。');rows.push(structuredClone(draft));}render();return receipt(draft,'queued',getAvailability().message);},
    flush(){if(destroyed)return;for(const draft of [...rows]){try{const result=apply(draft);if(result?.status!=='prepared'){error=result?.message||'';break;}rows=rows.filter(row=>row!==draft);}catch(reason){error=reason.message||String(reason);break;}}render();},
    render,take(){const result=rows;rows=[];error='';render();return result;},get count(){return rows.length;},destroy(){destroyed=true;rows=[];box.remove();}
  });
}

/** The host routes drafts to its existing lazy AI panel; there is no Agent here. */
export function createAgentAssistance({slot,notify=()=>{}}={}){
  let receiver=null,loader=null,loading=null,destroyed=false;const pending=new Map();
  const doc=slot.element.ownerDocument;let fallback=null;
  function showPending(){
    if(!pending.size){fallback?.remove();fallback=null;return;}
    if(!fallback){fallback=doc.createElement('section');fallback.className='ic-ai-assistance-pending';fallback.setAttribute('aria-label','待挂载的仿真请求');}
    const note=doc.createElement('p');note.setAttribute('role','status');note.textContent='仿真请求已保留。打开现有 AI 对话后可编辑并发送。';fallback.replaceChildren(note);
    for(const {draft} of pending.values()){const details=doc.createElement('details'),summary=doc.createElement('summary'),preview=doc.createElement('pre');summary.textContent=kinds[draft.kind]+' · 请求预览';preview.textContent=draft.text;preview.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:14em;overflow:auto';details.append(summary,preview);fallback.append(details);}if(fallback.parentElement!==slot.element)slot.element.append(fallback);
  }
  function drain(){
    if(destroyed||!receiver)return;
    for(const [id,record]of pending){try{const result=receiver(record.draft);if(!['prepared','queued'].includes(result?.status))throw Error('AI 面板未确认保留草稿。');record.result={...result,request_id:id};pending.delete(id);}catch(error){notify('仿真请求仍保留：'+error.message,{kind:'warning'});break;}}showPending();
  }
  async function activate(){
    if(destroyed)return;
    if(loader&&!receiver){loading ||= Promise.resolve().then(loader).finally(()=>{loading=null;});try{await loading;}catch(error){notify('AI 面板暂不可用，仿真请求仍保留：'+error.message,{kind:'warning'});}}
    drain();showPending();
  }
  return Object.freeze({
    async request(request){if(destroyed)throw Error('工作台已关闭。');if(pending.size>=maxPending)throw Error('已有 8 个待挂载请求，请先打开 AI 面板处理。');const draft=formatAgentAssistance(request,{requestId:'assistance-'+globalThis.crypto.randomUUID()});const record={draft,result:null};pending.set(draft.request_id,record);slot.setVisible(true);showPending();await activate();const result=record.result||receipt(draft,'queued','仿真请求已保留，请选择或新建现有聊天中的对话后发送。');notify(result.message||'已加入当前对话草稿，请检查后发送。',{kind:'info'});return result;},
    setLoader(value){if(typeof value!=='function')throw TypeError('AI loader required');loader=value;if(pending.size)void activate();},
    registerReceiver(value){if(typeof value!=='function'||receiver&&receiver!==value)throw Error('AI 草稿接收入口已绑定。');receiver=value;drain();return()=>{if(receiver===value){receiver=null;showPending();}};},
    destroy(){destroyed=true;pending.clear();receiver=null;loader=null;fallback?.remove();}
  });
}
