/** Independent mount. contextAdapter is the ONE explicit adapter shared with the waveform panel. */
export function mountAI(root, {contextAdapter, apiBase='/api/ai', healthPath='/api/health'}) {
  if (!contextAdapter?.getContext || !contextAdapter?.subscribe) throw Error('Explicit context adapter required');
  root.classList.add('ic-ai');
  const make=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
  const bar=make('div','ic-ai-bar'), status=make('span','ic-ai-status','尚未连接 Codex'), inspect=make('button','','检查连接'), stop=make('button','','中断 AI');stop.type=inspect.type='button';
  bar.append(status,inspect,stop);
  const provenance=make('div','ic-ai-provenance'), log=make('div','ic-ai-log');log.setAttribute('aria-live','polite');
  const pending=make('div','ic-ai-pending'), form=make('form','ic-ai-form'), input=make('textarea');input.placeholder='例如：读取当前电路并解释 R0 的参数。修改前请先展示 diff。';input.rows=3;input.setAttribute('aria-label','发送给电路助手的消息');
  const send=make('button','','发送');send.type='submit';form.append(input,send);
  const note=make('p','ic-ai-note','副作用等待人工审批。中断 AI 不会取消已提交的 Spectre 作业。');root.append(bar,provenance,log,pending,form,note);
  let token=null,cursor=0,events=null,activeMessage=null,activeRevision=null,lastContext=null;
  const rendered=new Set();
  async function post(path,body={}) {if(!token){const h=await (await fetch(healthPath)).json();if(!h.ok)throw Error(h.error.message);token=h.data.mutation_token;}
    const r=await fetch(apiBase+path,{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Token':token},body:JSON.stringify(body)});const j=await r.json();if(!j.ok)throw Error(j.error.message);return j.data;}
  function add(title,value,cls='') {const box=make('article','ic-ai-entry '+cls);box.append(make('strong','',title));const pre=make('pre','',typeof value==='string'?value:JSON.stringify(value,null,2));box.append(pre);log.append(box);log.scrollTop=log.scrollHeight;return pre;}
  function showError(e){status.textContent='已暂停 · '+e.message;add('错误 / 未自动重试',e.message,'error');send.disabled=false;}
  function update(context){lastContext=context;const f=context?.file,p=context?.project;provenance.textContent=p?`${p.id} · ${f?.baseCommit?.slice(0,12)||'未知 commit'} · ${f?.persistedSha256?.slice(0,12)||'未知 hash'} · ${f?.dirty?'有未保存修改':'已保存'}`:'等待项目上下文';
    if(activeRevision!==null&&context?.revision!==activeRevision){root.dataset.stale='true';note.textContent='当前上下文已变化；已有 AI 答复绑定先前版本。新修改需要重新读取与审阅。';for(const b of pending.querySelectorAll('button'))b.disabled=true;}}
  const unsubscribe=contextAdapter.subscribe(update);update(contextAdapter.getContext());
  function approval(a){if(rendered.has(a.approval_id))return;rendered.add(a.approval_id);const card=make('article','ic-ai-approval');card.dataset.approvalId=a.approval_id;
    card.append(make('strong','',a.kind==='workbench'?'待人工批准：'+a.request.operation:'Codex 实际审批请求：'+a.method));
    const detail=a.request?.review?.diff || a.request?.review || a.params;card.append(make('pre','',typeof detail==='string'?detail:JSON.stringify(detail,null,2)));
    if(a.request)card.append(make('small','',`请求 ${a.request.request_id} · ${a.request.fingerprint}`));
    const yes=make('button','','批准这次操作'),no=make('button','','拒绝');yes.type=no.type='button';yes.disabled=a.kind!=='workbench'||root.dataset.stale==='true';
    if(a.kind!=='workbench')card.append(make('p','','此桥接不执行任意 shell/文件写入。请求已保留，可拒绝或中断。'));
    async function decide(decision){yes.disabled=no.disabled=true;try{if(decision==='approve'&&root.dataset.stale==='true')throw Error('上下文已变化；本请求不能在新上下文中批准');await post('/approval',{approval_id:a.approval_id,decision});card.dataset.resolved=decision;card.append(make('p','',decision==='approve'?'人工决定已发送；查看实际回执。':'已拒绝并中断依赖操作。'));}catch(e){showError(e);card.append(make('p','','审批投递失败，操作暂停。'));}}
    yes.onclick=()=>decide('approve');no.onclick=()=>decide('deny');card.append(yes,no);pending.append(card);
  }
  function handle(e){const p=e.params;
    if(e.method==='item/agentMessage/delta'){if(!activeMessage)activeMessage=add('Codex','');activeMessage.textContent+=p.delta||'';log.scrollTop=log.scrollHeight;}
    else if(e.method==='tool/result')add('实际工具结果 · '+p.tool,p.result);
    else if(e.method==='approval/required')approval(p);
    else if(e.method==='approval/resolved')add('审批回执',p);
    else if(e.method==='session/ready'){status.textContent=`Codex · ${p.model} · ${p.approvalsReviewer}`;add('会话连接',p);}
    else if(e.method==='session/error'||e.method==='error'){showError(Error(p.message||p.error?.message||JSON.stringify(p)));}
    else if(e.method==='turn/completed'){status.textContent='回合：'+p.turn.status;send.disabled=false;activeMessage=null;}
    else if(e.method==='session/interrupted'||e.method==='transport/disconnected'){status.textContent='已暂停 · 不重放';send.disabled=true;add('中断/断线',p);for(const b of pending.querySelectorAll('button'))b.disabled=true;}
    else if(e.method==='turn/diff/updated')add('Codex diff',p.diff||p);
    else if(e.method==='item/started'&&p.item?.type==='agentMessage')activeMessage=null;
  }
  function connect(){if(events)return;events=new EventSource(apiBase+'/events?after='+cursor);events.onmessage=event=>{const d=JSON.parse(event.data);if(d.gap){showError(Error('事件历史有缺口；只恢复事件，不重发操作'));}for(const e of d.events){if(e.sequence>cursor){handle(e);cursor=e.sequence;}}for(const p of d.pending||[])if(p.status==='pending')approval(p);};events.onerror=()=>{status.textContent='事件连接中断 · 仅重连事件，不重发';};}
  inspect.onclick=async()=>{try{const d=await post('/doctor');add('真实连接检查',d.codex);status.textContent='app-server 可读；尚未证明模型回合可用';}catch(e){showError(e);}};
  stop.onclick=async()=>{try{await post('/interrupt');}catch(e){showError(e);}};
  form.onsubmit=async e=>{e.preventDefault();const message=input.value.trim();if(!message)return;
    const context=contextAdapter.getContext();if(!context||context.file?.dirty){showError(Error('请先保存并审阅当前源码，再发起 AI 回合'));return;}
    activeRevision=context.revision;root.dataset.stale='false';activeMessage=null;add('你',message);input.value='';send.disabled=true;status.textContent='正在连接/执行…';connect();
    try{const r=await post('/turn',{message,context,idempotency_key:crypto.randomUUID()});add('回合回执',r);}catch(err){showError(err);}};
  return {showError,destroy(){events?.close();unsubscribe?.();root.replaceChildren();}};
}
