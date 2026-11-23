import {createLibraryClient,repositoryPath} from './model.js';

const short=value=>typeof value==='string'?value.slice(0,8):'—';
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
const key=scope=>scope?JSON.stringify([scope.library_id,scope.cell_id,scope.entry,scope.source_sha256]):'';
export const receiptState=value=>value?.receipt?.state||value?.receipt?.status||value?.state||(value?.human_review_state==='expired'?'expired':value?.status)||'unknown';
export function writable(description,scope,operation,localAcknowledged=false){return !!scope&&description?.library_id===scope.library_id&&description?.cell_id===scope.cell_id&&(description?.source_match===true||localAcknowledged)&&description?.capabilities?.[operation]===true;}
export function publishedCell(value,scope){return value?.cells?.find(cell=>cell.library_id===scope.library_id&&cell.cell_id===scope.cell_id&&cell.directory===scope.directory)||null;}
export function commitDraft(scope,changes){const paths=(changes||[]).map(item=>item.path);return {title:`更新 ${scope.cell||scope.cell_id}${paths.length?' · '+paths.length+' 个文件':''}`,body:paths.map(path=>'• '+path).join('\n')};}
export function createPublishedHistoryLoader({fetcher=fetch,url=new URL('../library-files/lib/history.json',import.meta.url)}={}){return async(scope,{signal}={})=>{const response=await fetcher(url,{signal,credentials:'omit',redirect:'error'});if(!response.ok)throw Error('当前发布尚未包含电路历史。');const data=await response.json();return publishedCell(data,scope);};}

/** Scoped circuit data UI. The browser never receives GitHub credentials or arbitrary commands. */
export function mountLibraryVersions({element,getSelection,subscribeSelection,bridge,loadPublished=createPublishedHistoryLoader(),notify=()=>{},onBrowse=()=>{},onOpenWorking=null,deferLoad=false,onActivate=async()=>{},publishedClient=createLibraryClient()}){
  const css=node('link');css.rel='stylesheet';css.href=new URL('./versions.css',import.meta.url).href;document.head.append(css);
  const root=node('section',undefined,'cg-cell-versions');root.setAttribute('aria-label','电路版本管理');element.replaceChildren(root);
  let scope=null,generation=0,fileGeneration=0,disposed=false,abort=null,loading=false,busy=false,tab='files',description=null,current=null,history=[],checkpoints=[],ci=null,published=null,detail=null,editor=null,dialog=null,error='',message='',unknown=null;
  let activated=!deferLoad,activating=false;
  const drafts=new Map(),localAcknowledgements=new Set();let title='',body='',lastPR=null,lastPRBranch='',remotePR=null;
  const acknowledgementKey=()=>JSON.stringify([description?.repository,scope?.library_id,scope?.cell_id]);
  const acknowledged=()=>localAcknowledgements.has(acknowledgementKey());
  const connected=()=>bridge?.getState?.()?.connected===true;
  const allowed=operation=>connected()&&!unknown&&writable(description,scope,operation,acknowledged());
  const args=()=>({library_id:scope.library_id,cell_id:scope.cell_id});
  const read=(operation,extra={})=>bridge.request(operation,{...args(),...(operation==='describe'&&scope.source_sha256?{published_entry:scope.entry,source_sha256:scope.source_sha256}:{}),...extra});
  const files=()=>description?.files?.length?description.files:(scope?.files||[]).map(path=>({path,editable:false}));
  const draftKey=path=>JSON.stringify([scope.library_id,scope.cell_id,path]);
  function button(label,action,disabled=false){const b=node('button',label);b.type='button';b.disabled=disabled;b.onclick=()=>Promise.resolve().then(action).catch(fail);return b;}
  function fail(e){error=e?.message||String(e);notify(error,{kind:'error'});render();}
  function note(text,cls='cg-cv-note'){return node('p',text,cls);}
  function pre(text,label){const el=node('pre',text||'没有文本差异。','cg-cv-diff');el.setAttribute('aria-label',label);return el;}
  function row(...items){const el=node('div',undefined,'cg-cv-row');el.append(...items);return el;}
  function closeDialog(){dialog?.close();dialog?.remove();dialog=null;}
  function render(){
    if(disposed)return;root.replaceChildren();
    const head=node('header');head.append(node('strong','电路版本'),button('刷新',refresh,busy||loading||!scope));root.append(head);
    if(!scope){root.append(note('在 Library Manager 中打开一个电路单元，查看它的源文件与版本。'),button('打开 Library Manager',onBrowse));return;}
    root.append(node('p',`${scope.library||scope.library_id} / ${scope.cell||scope.cell_id}`,'cg-cv-identity'),note(scope.view||scope.view_id||''));
    if(description)root.append(note(`${description.repository||'本机仓库'} · ${description.branch||'未命名分支'} · ${short(current?.base_commit||description.base_commit)}`));
    const matched=allowed('save')||allowed('commit');
    root.append(note(!connected()?'公开快照 · 只读。连接本机节点后可核对仓库并编辑。':matched?'本机电路版本 · 修改先预览，再在本机确认。':description?.source_match===false?'本机分支与画布快照不同；确认使用本机版本后可编辑。':description?.reason||'等待节点核对当前库、单元和源码。'));
    if(connected()&&description&&!acknowledged()&&description.source_match!==true)root.append(button('使用本机版本',()=>{localAcknowledgements.add(acknowledgementKey());message='源码编辑使用本机分支。画布保持原视图，直到选择查看本机原理图。';render();},busy||loading));
    if(onOpenWorking&&matched&&scope.has_schematic!==false)root.append(button('查看本机原理图',async()=>{busy=true;render();try{await onOpenWorking(description);}finally{busy=false;render();}},busy||loading));
    if(error)root.append(note(error,'cg-cv-error'));if(message)root.append(note(message));if(loading)root.append(note('正在读取电路版本…'));
    if(unknown){root.append(note(['pending','prepared'].includes(unknown.state)?'原审阅尚未批准，可重新打开同一份审阅。':'上次操作结果尚未确认，请先核对原请求。','cg-cv-error'),button('检查原请求状态',checkReceipt,busy));if(['pending','prepared'].includes(unknown.state))root.append(button('重新打开原审阅',reopenReview,busy));}
    const tabs=node('nav');tabs.setAttribute('aria-label','电路版本视图');for(const [id,label]of [['files','文件'],['history','历史'],['submit','提交 / PR'],['ci','Testbench CI']]){const b=button(label,()=>{tab=id;render();});b.setAttribute('aria-pressed',String(tab===id));tabs.append(b);}root.append(tabs);
    if(tab==='files')renderFiles();else if(tab==='history')renderHistory();else if(tab==='submit')renderSubmit();else renderCI();
  }
  function renderFiles(){
    const changed=current?.changes||[];root.append(note(current?`${changed.length} 个待提交文件`:'文件来自当前单元的已发布清单。'));
    if(changed.length){const list=node('div',undefined,'cg-cv-list');for(const item of changed)list.append(button(`${item.status||'M'}  ${item.path}`,()=>openFile(item.path),busy));root.append(list);}
    const label=node('label','源文件'),select=node('select');select.setAttribute('aria-label','版本源文件');for(const file of files())select.add(new Option(file.path,file.path));select.value=editor?.path||scope.entry;select.disabled=busy||loading;select.onchange=()=>void openFile(select.value);label.append(select);root.append(label);
    if(!editor){root.append(button('读取文件',()=>openFile(select.value),busy||loading||!select.value));return;}
    const editable=allowed('save')&&editor.editable===true&&editor.origin==='live';
    const area=node('textarea',undefined,'cg-cv-source');area.setAttribute('aria-label','电路源码');area.spellcheck=false;area.value=editor.text;area.readOnly=!editable;area.disabled=busy;area.rows=14;
    const save=button('预览保存…',()=>prepare('preview_save',{path:editor.path,content:editor.text,base_sha256:editor.sha256}),!editable||busy||editor.text===editor.original);
    const hint=note(`${editor.origin==='live'?'本机文件':'公开快照'} · ${short(editor.sha256)}${editor.dirty?' · 未保存草稿':''}`);
    area.oninput=()=>{editor.text=area.value;editor.dirty=editor.text!==editor.original;drafts.set(draftKey(editor.path),{...editor});save.disabled=!editable||busy||!editor.dirty;hint.textContent=`本机文件 · ${short(editor.sha256)}${editor.dirty?' · 未保存草稿':''}`;};
    root.append(hint,area,row(save,button('重新读取',()=>openFile(editor.path,{discard:true}),busy)));
    const retained=drafts.get(draftKey(editor.path));if(retained&&retained.sha256!==editor.sha256){const box=node('details');box.append(node('summary','查看保留的旧草稿'),pre(retained.text,'保留的旧草稿'));root.append(box);}
    if(current?.diff){const box=node('details'),summary=node('summary','工作区差异');box.append(summary,pre(current.diff,'工作区差异'));root.append(box);}
  }
  function renderHistory(){
    if(detail){root.append(button('‹ 返回历史',()=>{detail=null;render();}),node('strong',detail.commit?.subject||detail.summary||'文件保存点'));if(detail.diff!==undefined)root.append(pre(detail.diff,'版本差异'));else root.append(note('公开历史未打包差异；连接本机节点后可查看该提交的完整差异。'));
      if(detail.files?.length)root.append(note(detail.files.map(item=>typeof item==='string'?item:item.path).join('\n')));
      if(detail.commit?.sha)root.append(note('恢复目标：'+(editor?.path||scope.entry)),button('恢复选中文件…',()=>restore({commit:detail.commit.sha}),busy||!allowed('restore')));
      return;
    }
    const list=node('div',undefined,'cg-cv-list');for(const commit of history){const item=button('',()=>showCommit(commit));item.append(node('strong',commit.subject||'无提交说明'),node('span',`${short(commit.sha)} · ${commit.timestamp||commit.date||''}`));list.append(item);}root.append(list);
    if(!history.length)root.append(note(published?'此单元尚无已发布提交记录。':'尚无当前单元的历史记录。'));
    if(checkpoints.length){const box=node('details'),summary=node('summary',`文件保存点 · ${checkpoints.length}`);box.append(summary);for(const checkpoint of checkpoints)box.append(row(note(`${checkpoint.path} · ${checkpoint.created_at||''}`),...((checkpoint.restore_versions||['after']).map(version=>button(version==='before'?'恢复保存前…':'恢复保存后…',()=>restore({checkpoint_id:checkpoint.checkpoint_id,path:checkpoint.path,checkpoint_version:version}),busy||!allowed('restore')||checkpoint.state==='unknown')))));root.append(box);}
    root.append(note(connected()?'只展示当前单元范围内的电路数据。':'这里展示当前发布时的单元历史；连接节点可读取最新工作区和差异。'));
  }
  function renderSubmit(){
    const a=node('label','提交标题'),input=node('input');input.setAttribute('aria-label','电路提交标题');input.maxLength=120;input.value=title;input.oninput=()=>{title=input.value;};a.append(input);
    const b=node('label','更新说明'),area=node('textarea');area.setAttribute('aria-label','电路更新说明');area.rows=4;area.maxLength=8000;area.value=body;area.oninput=()=>{body=area.value;};b.append(area);root.append(a,b);
    const disabled=busy||loading;root.append(row(button('根据修改生成说明',()=>{({title,body}=commitDraft(scope,current?.changes));render();},disabled||!current?.changes?.length),button('预览提交…',()=>{if(!title.trim())throw Error('请填写提交标题。');return prepare('preview_commit',{base_commit:current.base_commit,title:title.trim(),body});},disabled||!allowed('commit')||!current?.changes?.length)));
    root.append(note('提交与 PR 分开审阅；PR 仅包含该单元允许的文件。'));
    const branchLabel=node('label','PR 分支（留空使用节点默认）'),branchInput=node('input');branchInput.setAttribute('aria-label','PR 分支');branchInput.value=lastPRBranch;branchInput.placeholder=`codex/library/${scope.library_id}/${scope.cell_id}`;branchInput.oninput=()=>{lastPRBranch=branchInput.value.trim();};branchLabel.append(branchInput);root.append(branchLabel);
    root.append(row(button('创建 PR…',()=>pr('create'),disabled||!allowed('pr')||!current?.base_commit),button('更新现有 PR…',()=>pr('update'),disabled||!allowed('pr')||!current?.base_commit)));
    const prState=lastPR||current?.pull_request||description?.pull_request;if(prState){root.append(note(`PR ${prState.action==='update'?'已更新':prState.action==='create'?'已创建':prState.number?'#'+prState.number:''} · ${prState.state||prState.status||'状态未知'}`));if(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(prState.url||'')){const link=node('a','查看 PR ↗');link.href=prState.url;link.target='_blank';link.rel='noopener';root.append(link);}root.append(note('以上为本次操作回执；合并与 CI 状态以 GitHub 为准。'));}
    root.append(button('刷新 PR 状态',checkPR,busy||!connected()||!lastPRBranch));if(remotePR){root.append(note(`GitHub 当前状态：${remotePR.state||'未知'} · ${remotePR.branch||lastPRBranch}`));for(const pr of remotePR.pull_requests||[])root.append(note(`#${pr.number} · ${pr.state} · ${(pr.statusCheckRollup||[]).map(check=>[check.name||check.context,check.conclusion||check.status||check.state].filter(Boolean).join(': ')).join('；')||'没有已报告的检查状态'}`));}
    if(current?.branch)root.append(note(`当前分支 ${current.branch} · 基线 ${short(current.base_commit)}`));
  }
  function pr(action){if(!title.trim())throw Error('请填写 PR 标题。');return prepare('preview_pr',{commit:current.base_commit,title:title.trim(),body,action,...(lastPRBranch?{branch:lastPRBranch}:{})});}
  async function checkPR(){const ticket=generation,branch=lastPRBranch;if(busy||!branch)return;busy=true;render();try{const result=await read('pr_status',{branch});if(ticket===generation)remotePR=result;}catch(e){if(ticket===generation)error=e.message;}finally{if(ticket===generation){busy=false;render();}}}
  function renderCI(){
    if(!ci){root.append(note(connected()?'当前节点未返回此单元的 CI 配置。':'连接本机节点后可查看和配置此单元的 Testbench CI。'));return;}
    const selected=new Set(ci.config?.testbench_ids||[]),enabled=node('input');enabled.type='checkbox';enabled.checked=ci.config?.enabled===true;enabled.disabled=busy||!allowed('ci');const label=node('label',undefined,'cg-cv-check');label.append(enabled,document.createTextNode('启用 Testbench CI'));root.append(label);
    const choices=[];for(const tb of ci.testbenches||[]){const input=node('input');input.type='checkbox';input.value=tb.id;input.checked=selected.has(tb.id);input.disabled=busy||!allowed('ci')||tb.available===false;choices.push(input);const line=node('label',undefined,'cg-cv-check');line.append(input,document.createTextNode(tb.label||tb.id));root.append(line,note([tb.engine,tb.configuration_path,tb.workflow_path,tb.requires_external_models?'需要外部模型':null,tb.available===false?'当前不可用':null].filter(Boolean).join(' · ')));}
    if(!choices.length)root.append(note('此单元尚未注册可选 Testbench。'));
    root.append(button('预览 CI 配置…',()=>prepare('preview_ci',{enabled:enabled.checked,testbench_ids:choices.filter(x=>x.checked).map(x=>x.value),base_sha256:ci.sha256??null}),busy||!allowed('ci')),
      note('这里保存 Testbench 与工作流配置。保存配置不会证明仿真或 CI 已运行。'));
    if(ci.status||ci.runs)root.append(pre(JSON.stringify({status:ci.status,runs:ci.runs},null,2),'CI 状态'));
  }
  async function openFile(path,{discard=false}={}){
    if(busy||!scope)return;repositoryPath(path);if(!files().some(file=>file.path===path))throw Error('文件不在当前单元清单内。');
    if(discard&&editor?.dirty&&!globalThis.confirm('放弃此文件尚未保存的草稿并重新读取？'))return;
    const ticket=generation,fileTicket=++fileGeneration;loading=true;error='';render();
    try{let file;if(connected()&&description?.library_id===scope.library_id&&description?.cell_id===scope.cell_id){file=await read('read_file',{path});file={...file,text:file.text??file.content,origin:'live'};}else{const bundle=await publishedClient.loadView({kind:'markdown',entry:path,files:[path]},{signal:abort.signal});file={path,text:bundle.text,sha256:null,editable:false,origin:'published'};}
      if(ticket!==generation||fileTicket!==fileGeneration||disposed)return;if(file.path!==path||typeof file.text!=='string')throw Error('节点返回的文件身份无效。');
      if(discard)drafts.delete(draftKey(path));const draft=drafts.get(draftKey(path));editor=draft&&draft.sha256===file.sha256?{...draft,editable:file.editable,origin:file.origin}:{...file,original:file.text,dirty:false};if(draft&&draft.sha256!==file.sha256)error='文件已在其他地方变化；旧草稿保留，尚未覆盖新的源码。';
    }catch(e){if(ticket===generation&&fileTicket===fileGeneration&&!abort.signal.aborted)error=e.message;}
    finally{if(ticket===generation&&fileTicket===fileGeneration&&!disposed){loading=false;render();}}
  }
  async function showCommit(commit){
    if(busy||loading)return;const ticket=generation;loading=true;render();
    try{const result=connected()?await read('commit_detail',{commit:commit.sha}):{commit,diff:commit.diff,files:commit.files};if(ticket===generation)detail=result;}
    catch(e){if(ticket===generation)error=e.message;}finally{if(ticket===generation){loading=false;render();}}
  }
  async function restore(target){
    const ticket=generation,path=target.path||editor?.path||scope.entry;const file=await read('read_file',{path});if(ticket!==generation||disposed)return;if(file.path!==path||!file.editable)throw Error('所选文件不可恢复。');
    await prepare('preview_restore',{...target,path,base_sha256:file.sha256});
  }
  async function prepare(operation,payload){
    const capability=operation.replace('preview_','');if(busy||!allowed(capability))return;const ticket=generation;busy=true;error='';message='';render();
    try{const proposal=await read(operation,payload);if(ticket!==generation||disposed)return;if(!proposal?.review_id)throw Error('节点没有返回可审阅的请求。');if(operation==='preview_pr'&&proposal.payload?.pr_branch)lastPRBranch=proposal.payload.pr_branch;showReview(proposal,operation,payload,ticket);}
    catch(e){if(ticket===generation)error=e.message;}finally{if(ticket===generation){busy=false;render();}}
  }
  function showReview(proposal,operation,payload,ticket){
    closeDialog();const box=node('dialog',undefined,'cg-cv-dialog');box.setAttribute('aria-label','审阅电路操作');dialog=box;
    const status=note('请检查差异；下一步在本机窗口确认。');status.setAttribute('role','status');let attempted=false;
    const cancel=button('取消',()=>closeDialog()),confirm=button('打开本机确认',async()=>{
      if(attempted||ticket!==generation)return;attempted=true;busy=true;confirm.disabled=cancel.disabled=true;status.textContent='等待本机确认…';
      try{const result=await bridge.request('confirm',{review_id:proposal.review_id});if(ticket!==generation||disposed)return;
        const state=receiptState(result);if(['complete','completed','succeeded'].includes(state)){message='操作已完成，请核对更新后的文件与版本。';if(operation==='preview_pr')lastPR=result.result?.pull_request||result.result||result.pull_request||result;if(operation==='preview_save')drafts.delete(draftKey(payload.path));closeDialog();busy=false;await refresh();}
        else if(['denied','cancelled','expired'].includes(state)){status.textContent=state==='expired'?'审阅已过期，未执行。':'操作已取消，未执行。';unknown=null;}
        else{status.textContent=state==='pending'?'尚未批准；请求保持待处理。':'结果尚未确认，请检查原请求状态。';unknown={review_id:proposal.review_id,state,operation,payload};}
      }catch(e){status.textContent=e.message;unknown={review_id:proposal.review_id,state:'unknown',operation,payload};}
      finally{busy=false;cancel.disabled=false;cancel.textContent='关闭';if(!disposed)render();}
    });
    box.append(node('strong',proposal.summary||'审阅电路操作'),note(`${scope.library_id} / ${scope.cell_id} · ${short(proposal.base_commit)}`),pre(proposal.diff||JSON.stringify(proposal.files||[],null,2),'待确认差异'),status,row(cancel,confirm));box.addEventListener('cancel',event=>{if(busy)event.preventDefault();});document.body.append(box);box.showModal();
  }
  async function reconcileReceipt(result,record){
    const state=receiptState(result);
    if(['complete','completed','succeeded','denied','cancelled','expired','failed'].includes(state)){
      unknown=null;message='原请求状态：'+state;
      if(['complete','completed','succeeded'].includes(state)){if(record.operation==='preview_save')drafts.delete(draftKey(record.payload.path));if(record.operation==='preview_pr')lastPR=result.result?.pull_request||result.result||result.pull_request||result;}
      busy=false;await refresh();
    }else{unknown={...record,state};message=['pending','prepared'].includes(state)?'原请求尚未批准；可重新打开同一份审阅。':'原请求仍待核对：'+state;}
  }
  async function checkReceipt(){
    if(!unknown||busy)return;const ticket=generation,record=unknown;busy=true;render();
    try{const result=await bridge.request('receipt',{review_id:record.review_id});if(ticket!==generation||disposed)return;await reconcileReceipt(result,record);}
    catch(e){if(ticket===generation){error=e.message;unknown={...record,state:'unknown'};}}
    finally{if(ticket===generation){busy=false;render();}}
  }
  async function reopenReview(){
    if(!unknown||busy||!['pending','prepared'].includes(unknown.state))return;
    const ticket=generation,record=unknown;busy=true;error='';unknown={...record,state:'opening'};render();
    try{const result=await bridge.request('confirm',{review_id:record.review_id});if(ticket!==generation||disposed)return;await reconcileReceipt(result,record);}
    catch(e){if(ticket===generation){error=e.message;unknown={...record,state:'unknown'};}}
    finally{if(ticket===generation){busy=false;render();}}
  }
  async function refresh(){
    if(!scope||disposed)return;activated=true;const ticket=++generation;abort?.abort();abort=new AbortController();loading=true;error='';closeDialog();render();
    try{const found=await loadPublished(scope,{signal:abort.signal});if(ticket!==generation)return;published=found;history=found?.commits||[];}catch(e){if(ticket===generation&&!connected())error=e.message;}
    if(ticket!==generation||disposed)return;
    if(connected()){
      const calls=await Promise.allSettled(['describe','current','history','checkpoints','get_ci'].map(operation=>read(operation)));
      if(ticket!==generation||disposed)return;
      const [d,c,h,p,t]=calls;description=d.status==='fulfilled'?d.value:null;current=c.status==='fulfilled'?c.value:null;if(h.status==='fulfilled')history=h.value.commits||[];checkpoints=p.status==='fulfilled'?p.value.checkpoints||[]:[];ci=t.status==='fulfilled'?t.value:null;
      const failure=calls.find(item=>item.status==='rejected');if(failure)error=failure.reason.message;
      if(description&&(description.library_id!==scope.library_id||description.cell_id!==scope.cell_id)){description=null;current=null;history=published?.commits||[];checkpoints=[];ci=null;error='节点返回了其他电路单元，已停止后续操作。';}
    }else{description=null;current=null;checkpoints=[];ci=null;}
    loading=false;render();if(tab==='files'){const path=editor?.path||scope.entry;if(files().some(file=>file.path===path))await openFile(path);}
  }
  function change(){const next=getSelection();if(key(next)===key(scope))return;scope=next;generation++;abort?.abort();closeDialog();description=current=published=detail=editor=ci=null;history=[];checkpoints=[];unknown=null;lastPR=null;lastPRBranch='';remotePR=null;title=body=error=message='';busy=loading=false;render();if(scope&&activated)void refresh();}
  const offSelection=subscribeSelection(change),offBridge=bridge?.subscribe?.(()=>{localAcknowledgements.clear();description=null;current=null;editor=null;detail=null;closeDialog();generation++;busy=false;if(activated)void refresh();else render();});change();render();
  async function activate(){if(activated||activating||disposed)return;activating=true;try{await onActivate();if(disposed)return;activated=true;change();if(scope&&!loading)await refresh();}catch(e){fail(e);}finally{activating=false;}}
  const visibility=deferLoad&&typeof IntersectionObserver!=='undefined'?new IntersectionObserver(entries=>{if(entries.some(item=>item.isIntersecting))void activate();}):null;visibility?.observe(root);
  return {refresh,activate,destroy(){visibility?.disconnect();disposed=true;generation++;abort?.abort();offSelection?.();offBridge?.();closeDialog();root.remove();css.remove();}};
}
