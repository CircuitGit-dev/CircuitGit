import {createVersionModel} from './model.js';

const mounted=new WeakMap();
const short=sha=>sha?.slice(0,8)||'—';
const date=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?String(value||''):d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});};
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}

export function mount(host){
  if(mounted.has(host))return mounted.get(host);
  const slot=host.slots.versions;if(!slot)return null;
  const css=node('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url);document.head.append(css);
  const root=node('section','ic-versions');root.setAttribute('aria-label','工程版本管理');slot.element.replaceChildren(root);
  let busy=false,actionError='',model,restoreDialog=null,restoreUncertain=false;
  const button=(label,action,cls='')=>{const b=node('button',cls,label);b.type='button';b.onclick=action;return b;};
  async function act(fn){if(busy)return;busy=true;actionError='';render(model.getState());try{await fn();await model.refresh();}catch(error){actionError=error.message;host.notify(error.message,{kind:'error'});}finally{busy=false;render(model.getState());}}
  function render(state){
    root.replaceChildren();const {summary,project,draft}=state;
    const head=node('header','ic-version-head');const title=node('div');title.append(node('strong','','电路版本'),node('span','ic-version-sha',short(project?.sourceCommit)));head.append(title);
    const refresh=button('刷新',()=>model.refresh(),'ic-version-refresh');refresh.disabled=state.loading||busy||!project;head.append(refresh);root.append(head);
    const repo=node('p','ic-version-repo',project?.repository||project?.id||'等待项目加载');repo.title=repo.textContent;root.append(repo);
    const workflow=node('div','ic-version-workflow');workflow.setAttribute('aria-label','版本管理流程');for(const [i,label]of ['编辑','审阅差异','提交','同步'].entries()){if(i)workflow.append(node('span','','›'));workflow.append(node('span','',label));}root.append(workflow);
    const actions=node('div','ic-version-actions');const edit=button(draft?'审阅草稿':'编辑 / 审阅',()=>act(()=>host.openSource()));edit.disabled=busy||!project;
    const sync=button('拉取更新',()=>act(()=>host.versioning.sync()));sync.disabled=busy||!!draft||!project;sync.title=draft?'请先处理源码草稿':'检查远端并快进更新；不会自动提交或推送';actions.append(edit,sync);root.append(actions);
    if(actionError)root.append(node('p','ic-version-error',actionError));
    if(state.error)root.append(node('p','ic-version-error',state.error));
    if(state.loading)root.append(node('p','ic-version-note','正在读取工程版本…'));
    if(!summary&&!draft)return;
    const dirty=summary?.dirty||summary?.clean===false;
    const status=node('div','ic-version-status');status.append(node('span',dirty||draft?'ic-version-modified':'',draft?'有未提交源码草稿':dirty?'工程有修改':'工程工作区干净'));
    const upstream=summary?.upstream;
    root.append(status);
    const tabs=node('nav','ic-version-tabs');tabs.setAttribute('aria-label','版本视图');
    for(const [id,label]of [['changes',`当前修改${(summary?.changes?.length||0)+(draft?1:0)?' · '+((summary?.changes?.length||0)+(draft?1:0)):''}`],['history','提交历史']]){const b=button(label,()=>model.tab(id));b.setAttribute('aria-pressed',String(state.tab===id));tabs.append(b);}root.append(tabs);
    if(state.tab==='changes')renderChanges(state);else renderHistory(state);
    if(summary){const footer=node('details','ic-version-meta');footer.append(node('summary','','版本范围'));const p=node('p','ic-version-note',`仅当前工程可编辑的电路网表、层级源文件和仿真配置；不含网页代码或只读来源记录。${upstream?.available?'整个运行分支相对 '+(upstream.ref||summary.tracking_branch||'跟踪分支')+' 的本地缓存：↑ '+upstream.ahead+' / ↓ '+upstream.behind+'；未实时检查远端。':'远端同步状态未知。'}`);footer.append(p);footer.append(node('code','',project?.branch||''),node('code','',project?.sourceCommit||''));root.append(footer);}
  }
  function renderChanges({summary,draft}){
    const list=node('div','ic-version-changes');
    if(draft){const row=node('div','ic-version-change');row.append(node('span','ic-version-tag','草稿'),node('code','',draft.path));row.append(button('审阅',()=>act(()=>host.openSource(draft.path))));list.append(row);}
    for(const item of summary?.changes||[]){const row=node('div','ic-version-change');row.append(node('span','ic-version-tag',item.status||'M'),node('code','',item.path));row.append(node('span','ic-version-note',item.staged?'已暂存':item.unstaged?'未暂存':'未跟踪'));list.append(row);}
    if(!list.childNodes.length)list.append(node('p','ic-version-empty','当前工程没有待提交修改。'));
    list.append(node('p','ic-version-note','源码草稿通过“编辑 / 审阅”预览并提交；仿真参数草稿在仿真配置中保存。'));root.append(list);
  }
  function renderHistory(state){
    if(state.selected){
      root.append(button('‹ 返回提交历史',()=>model.back(),'ic-version-back'));
      if(state.detailLoading)root.append(node('p','ic-version-note','正在读取变更…'));
      if(state.detailError)root.append(node('p','ic-version-error',state.detailError));
      if(!state.detail)return;
      const {commit,files,diff,truncated}=state.detail;
      const header=node('div','ic-version-commit-head');header.append(node('strong','',commit.subject||commit.design_summary),node('p','ic-version-note',`${short(commit.sha)} · ${commit.author||''} · ${date(commit.date)}`));if(commit.design_summary)header.append(node('p','ic-version-note','工程概览：'+commit.design_summary));root.append(header);
      const original=node('details','ic-version-meta');original.append(node('summary','','原始 Git 提交说明'),node('p','',commit.subject||'无标题'));if(commit.body)original.append(node('p','ic-version-body',commit.body));root.append(original);
      const restore=button('回档到此版本…',()=>openRestore(commit.sha),'ic-version-restore');restore.disabled=busy||restoreUncertain||!!state.draft||!!state.summary?.dirty;root.append(restore,node('p','ic-version-note','先预览电路与配置差异，再确认生成新提交；原有历史保留。'));
      const list=node('div','ic-version-files');for(const file of files||[]){const row=node('div');row.append(node('code','',file.path),node('span','ic-version-added',file.additions==null?'':`+${file.additions}`),node('span','ic-version-deleted',file.deletions==null?'':`−${file.deletions}`));list.append(row);}root.append(list);
      const pre=node('pre','ic-version-diff');pre.setAttribute('aria-label','提交差异');for(const line of String(diff||'此提交没有可显示的文本差异。').split('\n'))pre.append(node('span',line.startsWith('+')&&!line.startsWith('+++')?'ic-version-line-add':line.startsWith('-')&&!line.startsWith('---')?'ic-version-line-del':line.startsWith('@@')?'ic-version-line-hunk':'',line||' '));root.append(pre);
      if(truncated)root.append(node('p','ic-version-note','差异超过显示上限，当前仅展示部分内容。'));
      return;
    }
    const filter=node('label','ic-version-filter'),checkbox=node('input');checkbox.type='checkbox';checkbox.checked=state.includeCosmetic;checkbox.disabled=state.loading||busy;checkbox.onchange=()=>model.includeCosmetic(checkbox.checked);filter.append(checkbox,document.createTextNode('显示注释 / 格式变更'));root.append(filter);
    if(state.summary?.cosmetic_hidden)root.append(node('p','ic-version-note',`本次检查 ${state.summary.history_scanned} 条工程记录，隐藏 ${state.summary.cosmetic_hidden} 条仅注释 / 格式变更。`));
    if(state.summary?.scanning_limited)root.append(node('p','ic-version-note','已达到本次历史扫描上限；更早记录尚未检查。'));
    const list=node('ol','ic-version-history');
    for(const commit of state.summary?.commits||[]){const item=node('li');const b=button('',()=>model.select(commit.sha));b.dataset.commit=commit.sha;b.append(node('strong','',commit.subject||commit.design_summary||'无提交说明'),node('span','ic-version-note',`${short(commit.sha)} · ${commit.author||''} · ${date(commit.date)}`));if(commit.design_summary)b.append(node('span','ic-version-count','工程概览：'+commit.design_summary));else if(commit.files_count!=null)b.append(node('span','ic-version-count',`${commit.files_count} 个文件`));item.append(b);list.append(item);}root.append(list);
    if(!list.childNodes.length)root.append(node('p','ic-version-empty','当前工程尚无可显示的提交。'));
    if(state.summary?.has_more)root.append(node('p','ic-version-note','显示最近 20 条工程提交。'));
  }
  async function openRestore(sha){
    if(restoreUncertain){host.notify('上次回档结果未知，请先核对Git版本；当前禁止重复回档。',{kind:'error'});return;}
    if(busy)return;busy=true;actionError='';render(model.getState());
    try{
      const proposal=await model.restorePreview(sha);
      const dialog=node('dialog','ic-version-restore-dialog');dialog.setAttribute('aria-label','回档电路版本');restoreDialog=dialog;
      const title=node('strong','','回档电路版本 · '+short(sha)),note=node('p','ic-version-note','以下内容将恢复当前工程的电路和仿真配置，并生成一个新提交。请检查差异和提交说明。');
      const diff=node('pre','ic-version-diff',proposal.preview.diff);diff.setAttribute('aria-label','回档差异');
      const titleLabel=node('label','','提交标题'),titleInput=node('input');titleInput.maxLength=80;titleInput.setAttribute('aria-label','回档提交标题');titleLabel.append(titleInput);
      const bodyLabel=node('label','','更新说明'),bodyInput=node('textarea');bodyInput.rows=3;bodyInput.maxLength=300;bodyInput.setAttribute('aria-label','回档更新说明');bodyLabel.append(bodyInput);
      const status=node('p','ic-version-note');status.setAttribute('role','status');
      const pushLabel=node('label','ic-version-filter'),push=node('input');push.type='checkbox';pushLabel.append(push,document.createTextNode('提交后推送到 GitHub'));
      let saving=false,attempted=false,draft;
      const cancel=button('取消',()=>{if(!saving){dialog.close();dialog.remove();}}),save=button('确认回档并生成新提交',async()=>{
        if(saving||attempted)return;
        try{
          const context=host.context.getContext();
          if(context?.project?.id!==proposal.project_id||context.project.sourceCommit!==proposal.base_commit||context.file?.dirty)throw Error('当前项目或源码已经变化，请关闭后重新预览。');
          const message=draft.message();draft.freeze();saving=true;attempted=true;restoreUncertain=true;save.disabled=cancel.disabled=true;titleInput.disabled=bodyInput.disabled=push.disabled=true;
          const result=await host.gateway.save({base_commit:proposal.base_commit,changes:proposal.changes,message,push:push.checked});
          if(!/^[a-f0-9]{40}$/.test(result?.source_commit||'')||result.push_status!==(push.checked?'confirmed':'not_requested'))throw Error('回档提交或推送结果未确认，请核对版本；不会重复提交。');
          restoreUncertain=false;
          status.textContent='已生成提交 '+short(result.source_commit)+(push.checked?' 并推送。':'，未推送。');
          await host.refresh({project:true});await model.refresh();cancel.textContent='关闭';
        }catch(error){status.textContent=error.message;status.className='ic-version-error';host.notify(error.message,{kind:'error'});}
        finally{saving=false;cancel.disabled=false;save.disabled=attempted;}
      });
      if(!host.createCommitMessage)throw Error('当前宿主尚未提供提交说明组件。');
      draft=host.createCommitMessage({onChange:s=>{titleInput.value=s.title;bodyInput.value=s.body;status.textContent=s.status==='running'?'AI（本地默认模型）正在拟写回档说明…':s.error?'自动摘要失败：'+s.error+' 可手动填写。':s.status==='complete'?'AI 草稿已生成，请检查或修改。':'请填写提交说明。';if(!saving&&!attempted){try{draft.message();save.disabled=false;}catch{save.disabled=true;}}}});
      titleInput.oninput=()=>draft.setTitle(titleInput.value);bodyInput.oninput=()=>draft.setBody(bodyInput.value);
      dialog.addEventListener('close',()=>{draft.destroy();if(restoreDialog===dialog)restoreDialog=null;});dialog.oncancel=e=>{if(saving)e.preventDefault();};
      const actions=node('div','ic-version-actions');actions.append(cancel,save);dialog.append(title,note,diff,titleLabel,bodyLabel,status,pushLabel,actions);document.body.append(dialog);dialog.showModal();save.disabled=true;
      void draft.prepare({project_id:proposal.project_id,base_commit:proposal.base_commit,review_id:proposal.preview.review_id});
    }catch(error){actionError=error.message;host.notify(error.message,{kind:'error'});}
    finally{busy=false;render(model.getState());}
  }
  model=createVersionModel({gateway:host.gateway,onChange:render});render(model.getState());
  model.context(host.context.getContext());const unsubscribe=host.context.subscribe(context=>model.context(context));
  const commands=[host.registerCommand({id:'git.versions',menu:'git',label:'版本管理…',run:()=>slot.setVisible(true)}),host.registerCommand({id:'window.versions',menu:'window',label:'版本管理',run:slot.toggle,checked:slot.isVisible})];
  const controller={model,destroy(){unsubscribe();commands.forEach(fn=>fn?.());model.destroy();if(restoreDialog){restoreDialog.close();restoreDialog.remove();}root.remove();css.remove();mounted.delete(host);}};mounted.set(host,controller);return controller;
}
