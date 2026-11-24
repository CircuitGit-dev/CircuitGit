import {createAssistanceQueue} from '../../ai/assistance.js';
// Session selector only. The AI owner mounts one independent panel per explicit server id.
const idle=()=>({phase:'idle',connected:false,contextStale:false,pendingApprovalCount:0,suspendedApprovalCount:0});
const mounted=new WeakMap();

export function mountSessions(host,{createPanel}={}) {
  const slot=host?.slots?.ai;
  if(host?.version!==1||!slot?.element||typeof createPanel!=='function'||typeof host.gateway?.request!=='function'||
      !['setVisible','isVisible','setBadge'].every(key=>typeof slot[key]==='function'))throw new TypeError('Sessions require Studio host v1 and createPanel');
  const existing=mounted.get(slot.element);
  if(existing){if(existing.host!==host)throw Error('Session slot belongs to another host');return existing.controller;}
  const doc=slot.element.ownerDocument,records=new Map();
  const make=(tag,cls,text)=>{const element=doc.createElement(tag);if(cls)element.className=cls;if(text)element.textContent=text;return element;};
  const root=make('section','ic-ai-sessions'),bar=make('div','ic-ai-sessions-bar'),tabs=make('div','ic-ai-session-tabs'),actions=make('div','ic-ai-session-actions');
  const add=make('button','','新建'),manage=make('button','','管理'),retry=make('button','','重新读取'),message=make('div','ic-ai-sessions-message'),body=make('div','ic-ai-session-panels'),empty=make('p','ic-ai-sessions-empty','暂无对话，点击“新建”开始。');
  root.setAttribute('aria-label','AI 多对话');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','AI 对话');
  for(const button of [add,manage,retry])button.type='button';
  add.setAttribute('aria-label','新建 AI 对话');manage.setAttribute('aria-label','管理 AI 对话');retry.hidden=true;
  message.setAttribute('role','status');message.hidden=true;empty.hidden=true;body.append(empty);actions.append(add,manage,retry);bar.append(tabs,actions);root.append(bar,message,body);slot.element.replaceChildren(root);
  let activeId=null,loading=true,busy=false,destroyed=false,limit=8,editDialog=null,manager=null,sequence=0,controller,hostState=null;
  const applyDraft=draft=>{const record=records.get(activeId);if(!record?.panel?.appendDraft)return {status:'queued',message:'请选择或新建对话；请求已保留，尚未发送。'};return record.panel.appendDraft(draft,{focus:slot.isVisible()});};
  const draftQueue=createAssistanceQueue({element:root,apply:applyDraft,getAvailability:()=>({available:!loading&&!busy&&!!records.get(activeId)?.panel?.appendDraft,message:loading?'正在读取对话；请求已保留，随后请选择目标对话。':!activeId?'请选择或新建对话；请求已保留，尚未发送。':'请求尚未发送；可加入当前对话，或先切换目标对话。'})});
  root.insertBefore(draftQueue.element,body);
  const running=state=>['starting','running'].includes(state.phase);
  const number=value=>Number.isInteger(value)&&value>0?value:0;
  function status(state){
    const labels=[];
    if(running(state))labels.push('运行中');
    const pending=number(state.pendingApprovalCount),suspended=number(state.suspendedApprovalCount);
    if(pending)labels.push(pending+' '+(state.contextStale?'审批失效':'待批准'));
    if(suspended)labels.push(suspended+' 审批暂停');
    if(!labels.length&&['suspended','error'].includes(state.phase))labels.push('已暂停');
    return labels.join(' · ');
  }
  function publish(){
    if(destroyed)return;
    let active=0,pending=0,suspended=0;
    for(const record of records.values()){
      const selected=record.id===activeId,state=record.state,label=status(state);
      record.button.setAttribute('aria-selected',String(selected));record.button.tabIndex=selected?0:-1;
      record.button.setAttribute('aria-label',record.info.name+(label?' · '+label:''));record.button.title=record.info.name+(label?' · '+label:'');
      record.name.textContent=record.info.name;record.badge.textContent=label;record.badge.hidden=!label;
      record.container.hidden=!selected;record.container.inert=!selected;
      const visible=selected&&slot.isVisible();
      if(record.panel&&record.visible!==visible){record.visible=visible;record.panel.setVisible(visible);}
      if(running(state))active++;
      if(state.contextStale)suspended+=number(state.pendingApprovalCount);else pending+=number(state.pendingApprovalCount);
      suspended+=number(state.suspendedApprovalCount);
    }
    const labels=[];if(active)labels.push(active+' 运行中');if(pending)labels.push(pending+' 待批准');if(suspended)labels.push(suspended+' 审批暂停');
    slot.setBadge(labels.join(' · ')||null);
    add.disabled=loading||busy||records.size>=limit;manage.disabled=busy;retry.disabled=loading||busy;
    add.title=records.size>=limit?'已达到 '+limit+' 个对话上限':'新建对话；发送消息后才启动 AI';
    root.setAttribute('aria-busy',String(loading||busy));
    empty.hidden=loading||records.size>0;
    const snapshot={count:records.size,activeSessionId:activeId,loading},signature=JSON.stringify(snapshot);
    if(hostState!==signature){hostState=signature;host.aiSettings?.onSessionsChanged?.(snapshot);}
    syncManager();draftQueue.render();
  }
  function failure(error){if(destroyed)return;message.hidden=false;message.textContent=error.message||String(error);}
  function clearMessage(){message.hidden=true;message.textContent='';}
  function guardModalEscape(dialog){
    const keydown=event=>{
      if(event.key!=='Escape'||!dialog.open||[...doc.querySelectorAll('dialog[open]')].at(-1)!==dialog)return;
      event.preventDefault();event.stopImmediatePropagation();dialog.oncancel?.(event);
    };
    doc.addEventListener('keydown',keydown,true);
    dialog.addEventListener('close',()=>doc.removeEventListener('keydown',keydown,true),{once:true});
  }
  function dropRecord(id){
    const record=records.get(id);if(!record)return;
    records.delete(id);record.panel.destroy();record.button.remove();record.container.remove();
    if(activeId===id)activeId=records.keys().next().value||null;
  }
  function deleteReason(record){
    if(running(record.state))return '请先停止当前回合';
    if(number(record.state.pendingApprovalCount)||number(record.state.suspendedApprovalCount))return '仍有未处理的审批';
    if(record.info.can_delete!==true)return ({active_turn:'请先停止当前回合',pending_approval:'仍有未处理的审批',unresolved_approval:'仍有未处理的审批',metadata_busy:'正在读取连接信息，请稍后刷新',session_busy:'正在处理请求，请稍后刷新',session_closing:'对话正在关闭'})[record.info.delete_block_reason]||'暂不可删除，请刷新状态';
    return '';
  }
  function syncManager(){
    if(!manager)return;
    manager.count.textContent=`${records.size} / ${limit} 个对话`;
    manager.refresh.disabled=loading||busy;manager.add.disabled=loading||busy||records.size>=limit;
    for(const [id,row] of manager.rows){
      const record=records.get(id);if(!record)continue;
      const reason=deleteReason(record),label=status(record.state)||({complete:'已完成',idle:'未开始'})[record.state.phase]||'空闲';
      row.state.textContent=label;row.element.classList.toggle('is-current',id===activeId);row.open.textContent=id===activeId?'当前对话':'打开';
      row.open.disabled=busy;row.rename.disabled=busy||loading;row.remove.disabled=busy||loading||Boolean(reason);row.remove.title=reason||'从工作台删除此对话';row.reason.textContent=reason;
    }
  }
  function renderManager(){
    if(!manager)return;
    const query=manager.search.value.trim().toLocaleLowerCase();
    const rows=[...records.values()].filter(r=>[r.info.name,r.info.model||''].join(' ').toLocaleLowerCase().includes(query)).sort((a,b)=>(b.info.updated_at_ms||0)-(a.info.updated_at_ms||0));
    const signature=JSON.stringify(rows.map(r=>[r.id,r.info.name,r.info.model,r.info.updated_at_ms]));
    if(manager.signature===signature){syncManager();return;}
    manager.signature=signature;manager.rows.clear();manager.list.replaceChildren();
    for(const record of rows){
      const element=make('article','ic-ai-manager-row'),info=make('div','ic-ai-manager-info'),name=make('strong','',record.info.name),state=make('span','ic-ai-manager-state'),meta=make('div','ic-ai-manager-meta'),controls=make('div','ic-ai-manager-actions'),open=make('button','','打开'),rename=make('button','','重命名'),remove=make('button','ic-ai-delete','删除'),reason=make('small','ic-ai-manager-reason');
      element.setAttribute('role','listitem');element.dataset.sessionId=record.id;name.title=record.info.name;
      const timestamp=record.info.updated_at_ms;
      meta.textContent=[record.info.model||'尚未选择模型',Number.isFinite(timestamp)?new Date(timestamp).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):''].filter(Boolean).join(' · ');
      for(const button of [open,rename,remove])button.type='button';
      open.onclick=()=>{closeManager();slot.setVisible(true);select(record.id);};rename.onclick=()=>editName('rename',record.id);remove.onclick=()=>deleteSession(record.id);
      info.append(name,state,meta,reason);controls.append(open,rename,remove);element.append(info,controls);manager.list.append(element);manager.rows.set(record.id,{element,state,open,rename,remove,reason});
    }
    if(!rows.length)manager.list.append(make('p','ic-ai-manager-empty',loading?'正在读取对话…':records.size?'没有匹配的对话':'暂无对话，点击“新建对话”开始。'));
    syncManager();
  }
  function closeManager(){if(!manager)return;const dialog=manager.dialog;clearInterval(manager.timer);manager=null;dialog.close();dialog.remove();manage.focus();}
  function openManager(){
    if(destroyed)return;if(manager){manager.search.focus();return;}
    const dialog=make('dialog','ic-ai-session-dialog ic-ai-manager'),header=make('header','ic-ai-manager-header'),title=make('strong','','对话管理器'),count=make('span','ic-ai-manager-count'),close=make('button','','关闭'),toolbar=make('div','ic-ai-manager-toolbar'),search=make('input'),refresh=make('button','','刷新'),newChat=make('button','','新建对话'),list=make('div','ic-ai-manager-list'),notice=make('p','ic-ai-manager-notice');
    dialog.setAttribute('aria-label','对话管理器');search.type='search';search.placeholder='搜索对话名称或模型';search.setAttribute('aria-label','搜索对话');list.setAttribute('role','list');list.setAttribute('aria-label','对话列表');notice.setAttribute('role','status');
    for(const button of [close,refresh,newChat])button.type='button';
    close.onclick=closeManager;refresh.onclick=()=>load();newChat.onclick=()=>editName('create');search.oninput=renderManager;
    header.append(title,count,close);toolbar.append(search,refresh,newChat);dialog.append(header,toolbar,notice,list);doc.body.append(dialog);
    manager={dialog,search,refresh,add:newChat,list,count,notice,rows:new Map()};
    manager.timer=setInterval(()=>{if(manager&&!loading&&!busy&&!editDialog&&doc.visibilityState!=='hidden')void load();},3000);
    dialog.oncancel=e=>{e.preventDefault();closeManager();};dialog.addEventListener('keydown',e=>e.stopPropagation());
    guardModalEscape(dialog);dialog.showModal();renderManager();search.focus();void load();
  }
  function deleteSession(id){
    const target=records.get(id);if(destroyed||busy||loading||editDialog||!target||deleteReason(target))return;
    const dialog=make('dialog','ic-ai-session-dialog'),heading=make('strong','','删除对话'),description=make('p','',`删除“${target.info.name}”？此对话将从工作台移除并释放名额。本地历史、图片和操作回执保留。`),error=make('p','ic-ai-session-dialog-error'),buttons=make('div','ic-ai-session-dialog-actions'),cancel=make('button','','取消'),confirm=make('button','ic-ai-delete','删除对话');
    dialog.setAttribute('aria-label','删除对话');error.setAttribute('role','status');error.hidden=true;cancel.type=confirm.type='button';buttons.append(cancel,confirm);dialog.append(heading,description,error,buttons);doc.body.append(dialog);editDialog=dialog;
    const close=()=>{if(busy)return;dialog.close();dialog.remove();editDialog=null;};cancel.onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};dialog.addEventListener('keydown',e=>e.stopPropagation());
    confirm.onclick=async()=>{
      if(busy||destroyed)return;busy=true;cancel.disabled=confirm.disabled=true;publish();
      try{
        const receipt=await host.gateway.request('/ai/sessions/delete',{method:'POST',body:{session_id:id}});
        if(destroyed)return;
        if(receipt?.session_id!==id||receipt.deleted!==true)throw Error('删除回执的会话身份不匹配');
        dropRecord(id);busy=false;close();renderManager();if(manager)manager.notice.textContent=`已删除“${target.info.name}”。`;
      }catch(cause){
        if(!destroyed){error.hidden=false;error.textContent=(cause.message||String(cause))+' 请关闭此窗口后刷新管理器核对结果；不会自动重试。';}
      }finally{busy=false;if(!destroyed){cancel.disabled=false;publish();}}
    };
    guardModalEscape(dialog);dialog.showModal();cancel.focus();
  }
  function validate(info){
    if(!info||typeof info.session_id!=='string'||!info.session_id||typeof info.name!=='string'||!info.name.trim()||[...info.name].length>64)throw Error('会话接口返回了无效身份或名称。');
    return {...info};
  }
  function mountRecord(info){
    info=validate(info);if(records.has(info.session_id))throw Error('会话列表包含重复身份。');
    const container=make('div','ic-ai-session-panel'),button=make('button','ic-ai-session-tab'),name=make('span','ic-ai-session-name'),badge=make('span','ic-ai-session-badge');
    const domId='ic-ai-session-'+crypto.randomUUID();container.id=domId;container.setAttribute('role','tabpanel');container.setAttribute('aria-label',info.name);container.dataset.sessionId=info.session_id;container.hidden=true;container.inert=true;
    button.id=domId+'-tab';button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-controls',domId);container.setAttribute('aria-labelledby',button.id);button.append(name,badge);
    const record={id:info.session_id,info,container,button,name,badge,panel:null,visible:null,state:{...idle(),phase:info.state||'idle',pendingApprovalCount:number(info.pending_approval_count),suspendedApprovalCount:number(info.suspended_approval_count)}};
    records.set(record.id,record);tabs.append(button);body.append(container);button.onclick=()=>select(record.id);
    try{
      record.panel=createPanel(container,{sessionId:record.id,onStateChange(state){if(destroyed||records.get(record.id)!==record)return;record.state={...idle(),...state};publish();}});
      if(!record.panel||!['getState','focusInput','openDetails','setVisible','destroy'].every(key=>typeof record.panel[key]==='function'))throw Error('AI 面板没有满足冻结的会话挂点。');
      record.state={...idle(),...record.panel.getState()};
    }catch(error){record.panel?.destroy?.();records.delete(record.id);button.remove();container.remove();throw error;}
    return record;
  }
  function select(id,{focus=true}={}){
    if(destroyed||!records.has(id))return;
    activeId=id;publish();
    const record=records.get(id);record.button.scrollIntoView?.({block:'nearest',inline:'nearest'});
    if(focus&&slot.isVisible())record.panel.focusInput();
    draftQueue.flush();
  }
  tabs.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const entries=[...records.values()],index=entries.findIndex(record=>record.button===event.target);if(index<0)return;
    event.preventDefault();event.stopPropagation();
    const next=event.key==='Home'?0:event.key==='End'?entries.length-1:(index+(event.key==='ArrowRight'?1:-1)+entries.length)%entries.length;
    select(entries[next].id,{focus:false});entries[next].button.focus();
  });
  async function load(){
    if(destroyed||busy)return;loading=true;retry.hidden=true;clearMessage();publish();const ticket=++sequence;
    if(manager)manager.notice.textContent='';
    try{
      const result=await host.gateway.request('/ai/sessions');if(destroyed||ticket!==sequence)return;
      if(!Array.isArray(result?.sessions)||!Number.isInteger(result.max_sessions)||result.max_sessions<1||result.max_sessions>8||result.sessions.length>result.max_sessions)throw Error('会话列表不符合最多 8 个会话的契约。');
      const infos=result.sessions.map(validate);if(new Set(infos.map(info=>info.session_id)).size!==infos.length)throw Error('会话列表包含重复身份。');
      limit=result.max_sessions;
      const ids=new Set(infos.map(info=>info.session_id));for(const id of [...records.keys()])if(!ids.has(id))dropRecord(id);
      for(const info of infos){const existing=records.get(info.session_id);if(existing){existing.info=info;existing.container.setAttribute('aria-label',info.name);}else mountRecord(info);}
      if(!activeId)activeId=records.keys().next().value||null;
    }catch(error){failure(error);if(manager)manager.notice.textContent=error.message||String(error);retry.hidden=false;}
    finally{if(!destroyed&&ticket===sequence){loading=false;renderManager();publish();}}
  }
  function editName(kind,id=activeId){
    if(destroyed||loading||busy||editDialog||(kind==='rename'&&!activeId)||(kind==='create'&&records.size>=limit))return;
    const target=kind==='rename'?records.get(id):null;if(kind==='rename'&&!target)return;
    const dialog=make('dialog','ic-ai-session-dialog'),form=make('form'),heading=make('strong','',kind==='create'?'新建 AI 对话':'重命名 AI 对话'),label=make('label','','名称'),input=make('input'),error=make('p','ic-ai-session-dialog-error'),buttons=make('div','ic-ai-session-dialog-actions'),cancel=make('button','','取消'),save=make('button','',kind==='create'?'新建':'保存名称');
    dialog.setAttribute('aria-label',heading.textContent);input.required=true;input.maxLength=64;input.value=target?.info.name||'新对话';input.setAttribute('aria-label','对话名称');error.setAttribute('role','status');error.hidden=true;cancel.type='button';save.type='submit';label.append(input);buttons.append(cancel,save);form.append(heading,label,error,buttons);dialog.append(form);doc.body.append(dialog);editDialog=dialog;
    const close=()=>{if(busy)return;dialog.close();dialog.remove();editDialog=null;};cancel.onclick=close;dialog.oncancel=event=>{event.preventDefault();close();};
    dialog.addEventListener('keydown',event=>event.stopPropagation());
    form.onsubmit=async event=>{
      event.preventDefault();if(busy||destroyed)return;
      const name=input.value.trim();if(!name||[...name].length>64){error.hidden=false;error.textContent='名称需要 1–64 个字符。';return;}
      if(target&&name===target.info.name){close();return;}
      busy=true;input.disabled=cancel.disabled=save.disabled=true;error.hidden=true;clearMessage();publish();
      try{
        const info=validate(await host.gateway.request(kind==='create'?'/ai/sessions':'/ai/sessions/rename',{method:'POST',body:target?{session_id:target.id,name}:{name}}));
        if(destroyed)return;
        if(target){if(info.session_id!==target.id)throw Error('重命名回执的会话身份不匹配。');target.info=info;target.container.setAttribute('aria-label',info.name);}
        else{if(records.has(info.session_id)||records.size>=limit)throw Error('新建回执包含重复身份或超过会话上限。');mountRecord(info);}
        busy=false;close();if(!target)select(info.session_id);renderManager();
      }catch(cause){if(!destroyed){error.hidden=false;error.textContent=(cause.message||String(cause))+' 未自动重试。';}}
      finally{busy=false;if(!destroyed){input.disabled=cancel.disabled=save.disabled=false;publish();}}
    };
    guardModalEscape(dialog);dialog.showModal();input.focus();input.select();
  }
  add.onclick=()=>editName('create');manage.onclick=openManager;retry.onclick=load;
  function show(){if(destroyed)return;slot.setVisible(true);publish();records.get(activeId)?.panel.focusInput();}
  function hide(){if(!destroyed){slot.setVisible(false);publish();}}
  function toggle(){if(destroyed)return;if(slot.isVisible())hide();else show();}
  // Host toolbar and Window commands can toggle the frozen slot directly.
  const visibilityObserver=new MutationObserver(publish);
  for(let parent=slot.element;parent;parent=parent.parentElement)visibilityObserver.observe(parent,{attributes:true,attributeFilter:['hidden','class']});
  function destroy(){
    if(destroyed)return;destroyed=true;++sequence;
    visibilityObserver.disconnect();
    closeManager();
    if(editDialog){editDialog.close();editDialog.remove();editDialog=null;}
    draftQueue.destroy();for(const record of records.values())record.panel.destroy();records.clear();root.remove();slot.setBadge(null);mounted.delete(slot.element);
  }
  controller=Object.freeze({show,hide,toggle,openManager,queueDraft(draft){if(!loading&&!busy&&activeId){try{const result=applyDraft(draft);if(result.status==='prepared')return result;}catch(error){failure(error);}}return draftQueue.enqueue(draft);},takePendingDrafts:()=>draftQueue.take(),openCreate(){editName('create');},openDetails(){if(!destroyed){show();records.get(activeId)?.panel.openDetails();}},getState(){return Object.freeze({...idle(),...records.get(activeId)?.panel.getState()});},destroy});
  mounted.set(slot.element,{host,controller});publish();void load();return controller;
}
