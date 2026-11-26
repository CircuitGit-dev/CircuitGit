import {createLibraryClient,repositoryPath} from './model.js';
import {
  circuitFileKind,
  filterCircuitCommits,
  isCircuitSourcePath,
  isDiffLimitError,
  parseCircuitDiff,
  selectDiffSections,
  shortFileName,
} from './history-diff.js';

const short=value=>typeof value==='string'?value.slice(0,8):'—';
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
const key=scope=>scope?JSON.stringify([scope.library_id,scope.cell_id,scope.entry,scope.source_sha256]):'';
export const receiptState=value=>value?.receipt?.state||value?.receipt?.status||value?.state||(value?.human_review_state==='expired'?'expired':value?.status)||'unknown';
export const receiptReleased=value=>['complete','completed','succeeded','rejected','cancelled','denied','expired','rolled_back'].includes(receiptState(value))||(['failed','not_found','prepared'].includes(receiptState(value))&&(value?.receipt?.dispatched??value?.dispatched)===false);
export function writable(description,scope,operation){return !!scope&&description?.library_id===scope.library_id&&description?.cell_id===scope.cell_id&&description?.capabilities?.[operation]===true;}
export function publishedCell(value,scope){return value?.cells?.find(cell=>cell.library_id===scope.library_id&&cell.cell_id===scope.cell_id&&cell.directory===scope.directory)||null;}
export function commitDraft(scope,changes){const paths=(changes||[]).map(item=>item.path);return {title:`更新 ${scope.cell||scope.cell_id}${paths.length?' · '+paths.length+' 个文件':''}`,body:paths.map(path=>'• '+path).join('\n')};}
export const testbenchExecutionLabel=status=>({passed:'已运行命名分析并满足验收条件',failed:'已运行命名分析，未满足验收条件',invalid:'分析或验收数据无效',unknown:'分析结果尚未确认；保留原请求，未自动重跑',not_run:'尚未运行 CI'}[status]||'CI 状态尚未确认');
export function createPublishedHistoryLoader({fetcher=fetch,url=new URL('../library-files/lib/history.json',import.meta.url)}={}){return async(scope,{signal}={})=>{const response=await fetcher(url,{signal,credentials:'omit',redirect:'error'});if(!response.ok)throw Error('当前发布尚未包含电路历史。');const data=await response.json();return publishedCell(data,scope);};}

export function textDiff(before,after){
  if(before===after)return '尚无修改。';
  if(before.length+after.length>524288)return '文件较大；保存后查看工作区完整差异。';
  const a=before.split('\n'),b=after.split('\n');let start=0,end=0;
  while(start<a.length&&start<b.length&&a[start]===b[start])start++;
  while(end<a.length-start&&end<b.length-start&&a[a.length-end-1]===b[b.length-end-1])end++;
  const removed=a.slice(start,a.length-end),added=b.slice(start,b.length-end),limit=120;
  return [`@@ -${start+1},${removed.length} +${start+1},${added.length} @@`,...removed.slice(0,limit).map(line=>'-'+line),...added.slice(0,limit).map(line=>'+'+line),...(removed.length>limit||added.length>limit?['… 差异显示已截断；保存使用完整文本。']:[])].join('\n');
}
export function createPendingStore(storage){
  if(storage===undefined){try{storage=globalThis.sessionStorage;}catch{}}
  const storageKey='circuitgit.pending-library-writes.v1';let records=[];
  try{const value=JSON.parse(storage?.getItem(storageKey)||'[]');if(Array.isArray(value))records=value.filter(row=>row&&typeof row.idempotency_key==='string'&&row.idempotency_key.length>=8&&['save','save_files','commit','restore','pr','ci','create_library','create_cell','clone_cell','create_branch','switch_branch'].includes(row.operation)&&typeof row.repository==='string'&&typeof row.library_id==='string'&&typeof row.cell_id==='string');}catch{}
  const persist=()=>{try{storage?.setItem(storageKey,JSON.stringify(records));}catch{}};
  return {find(scope,repository){return records.find(row=>row.library_id===scope?.library_id&&row.cell_id===scope?.cell_id&&(!repository||row.repository===repository))||null;},
    remember(value){const record={idempotency_key:value.idempotency_key,operation:value.operation,library_id:value.library_id,cell_id:value.cell_id,repository:value.repository,paths:Array.isArray(value.paths)?value.paths.filter(path=>typeof path==='string'):[],created_at:value.created_at||new Date().toISOString()};records=records.filter(row=>row.idempotency_key!==record.idempotency_key);records.push(record);persist();return record;},
    forget(value){records=records.filter(row=>row.idempotency_key!==value.idempotency_key);persist();}};
}

/** Scoped circuit data UI. The browser never receives GitHub credentials or arbitrary commands. */
export function mountLibraryVersions({element,getSelection,subscribeSelection,bridge,loadPublished=createPublishedHistoryLoader(),notify=()=>{},onBrowse=()=>{},onOpenWorking=null,onSourceChange=async()=>{},pendingStorage,deferLoad=false,onActivate=async()=>{},publishedClient=createLibraryClient()}){
  const css=node('link');css.rel='stylesheet';css.href=new URL('./versions.css',import.meta.url).href;document.head.append(css);
  const root=node('section',undefined,'cg-cell-versions');root.setAttribute('aria-label','电路版本管理');element.replaceChildren(root);
  let scope=null,generation=0,fileGeneration=0,disposed=false,abort=null,loading=false,busy=false,tab='files',description=null,current=null,history=[],checkpoints=[],ci=null,published=null,detail=null,editor=null,error='',message='',unknown=null;
  let activated=!deferLoad,activating=false,reviewLink=null,branchInfo=null;
  let diffMode=null,diffExpanded=false,showNonCircuitHistory=false;
  const drafts=new Map(),pending=createPendingStore(pendingStorage);let unwatch=null,lastFingerprint=null;let title='',body='',lastPR=null,lastPRBranch='',remotePR=null;
  let newBranch='',switchTarget='',newCellId='',cloneCellId='',newLibId='',newLibName='',relatedCellsText='';
  const connected=()=>bridge?.getState?.()?.connected===true;
  const allowed=operation=>connected()&&!unknown&&writable(description,scope,operation);
  const args=()=>({library_id:scope.library_id,cell_id:scope.cell_id});
  const read=(operation,extra={})=>bridge.request(operation,{...args(),...(operation==='describe'&&scope.source_sha256?{published_entry:scope.entry,source_sha256:scope.source_sha256}:{}),...extra});
  const files=()=>description?.files?.length?description.files:(scope?.files||[]).map(path=>({path,editable:false}));
  const draftKey=path=>JSON.stringify([scope.library_id,scope.cell_id,path]);
  function button(label,action,disabled=false){const b=node('button',label);b.type='button';b.disabled=disabled;b.onclick=()=>Promise.resolve().then(action).catch(fail);return b;}
  function fail(e){error=e?.message||String(e);notify(error,{kind:'error'});render();}
  function note(text,cls='cg-cv-note'){return node('p',text,cls);}
  function pre(text,label){const el=node('pre',text||'没有文本差异。','cg-cv-diff');el.setAttribute('aria-label',label);return el;}
  function row(...items){const el=node('div',undefined,'cg-cv-row');el.append(...items);return el;}
  function render(){
    if(disposed)return;root.replaceChildren();
    const head=node('header');head.append(node('strong','电路版本'),button('刷新',refresh,busy||loading||!scope));root.append(head);
    if(!scope){root.append(note('在 Library Manager 中打开一个电路单元，查看它的源文件与版本。'),button('打开 Library Manager',onBrowse));return;}
    root.append(node('p',`${scope.library||scope.library_id} / ${scope.cell||scope.cell_id}`,'cg-cv-identity'),note(scope.view||scope.view_id||''));
    if(description)root.append(note(`${description.repository||'本机仓库'} · ${description.branch||'未命名分支'} · ${short(current?.base_commit||description.base_commit)}`));
    const matched=allowed('save')||allowed('commit');
    root.append(note(!connected()?'公开快照 · 只读。连接本机节点后可编辑。':matched?'本机工作区 · 保存即时生效并保留保存点。':description?.reason||'正在读取当前单元的本机工作区。'));
    if(connected()&&description?.source_match===false)root.append(note('公开快照与本机版本不同；编辑器显示本机当前文件。'));
    if(onOpenWorking&&matched&&scope.has_schematic!==false)root.append(button('查看本机原理图',async()=>{busy=true;render();try{await onOpenWorking(description);}finally{busy=false;render();}},busy||loading));
    if(error)root.append(note(error,'cg-cv-error'));if(message)root.append(note(message));if(loading)root.append(note('正在读取电路版本…'));
    if(unknown)root.append(note('上次操作尚未确认，正在保留原请求键。请先核对回执。','cg-cv-error'),button('检查原请求状态',checkReceipt,busy||!connected()));
    const tabs=node('nav');tabs.setAttribute('aria-label','电路版本视图');for(const [id,label]of [['files','文件'],['history','历史'],['submit','提交 / PR'],['ci','Testbench CI']]){const b=button(label,()=>{tab=id;render();});b.setAttribute('aria-pressed',String(tab===id));tabs.append(b);}root.append(tabs);
    if(tab==='files')renderFiles();else if(tab==='history')renderHistory();else if(tab==='submit')renderSubmit();else renderCI();
  }
  function renderFiles(){
    const changed=current?.changes||[];root.append(note(current?`${changed.length} 个待提交文件`:'文件来自当前单元的已发布清单。'));
    if(changed.length){const list=node('div',undefined,'cg-cv-list');for(const item of changed)list.append(button(`${item.status||'M'}  ${item.path}`,()=>openFile(item.path),busy));root.append(list);}
    const label=node('label','源文件'),select=node('select');select.setAttribute('aria-label','版本源文件');for(const file of files())select.add(new Option(file.path,file.path));select.value=editor?.path||scope.entry;select.disabled=busy||loading;select.onchange=()=>void openFile(select.value);label.append(select);root.append(label);
    if(!editor){root.append(button('读取文件',()=>openFile(select.value),busy||loading||!select.value));return;}
    const editable=allowed('save')&&editor.editable===true&&editor.origin==='live'&&!editor.conflict;
    const area=node('textarea',undefined,'cg-cv-source');area.setAttribute('aria-label','电路源码');area.spellcheck=false;area.value=editor.text;area.readOnly=!editable;area.disabled=busy;area.rows=14;
    const save=button('保存',()=>execute('save',{path:editor.path,content:editor.text,base_sha256:editor.sha256}),!editable||busy||editor.text===editor.original);
    const hint=note(`${editor.origin==='live'?'本机文件':'公开快照'} · ${short(editor.sha256)}${editor.dirty?' · 未保存草稿':''}`);
    const liveDiff=pre(textDiff(editor.original,editor.text),'编辑器实时差异');liveDiff.classList.add('cg-cv-live-diff');
    area.oninput=()=>{editor.text=area.value;editor.dirty=editor.text!==editor.original;drafts.set(draftKey(editor.path),{...editor});save.disabled=!editable||busy||!editor.dirty;hint.textContent=`本机文件 · ${short(editor.sha256)}${editor.dirty?' · 未保存草稿':''}`;liveDiff.textContent=textDiff(editor.original,editor.text);};
    const editorGrid=node('div',undefined,'cg-cv-editor-grid');editorGrid.append(area,liveDiff);root.append(hint,editorGrid,row(save,button(editor.dirty?'丢弃草稿并重新读取':'重新读取',()=>openFile(editor.path,{discard:true}),busy)));
    const retained=drafts.get(draftKey(editor.path));if(retained&&retained.sha256!==editor.sha256){const box=node('details');box.append(node('summary','查看保留的旧草稿'),pre(retained.text,'保留的旧草稿'));root.append(box);}
    if(current?.diff){root.append(node('strong','工作区差异'),renderStructuredDiff(current.diff,{label:'工作区差异',fallbackPath:editor?.path||scope.entry}));}renderCheckpoints(5);
  }
  function renderStructuredDiff(rawDiff,{label='版本差异',fallbackPath=''}={}){
    const parsed=parseCircuitDiff(rawDiff,{fallbackPath});
    const activeMode=diffMode||(parsed.hasRnlChanges?'rnl':'circuit');
    const wrap=node('section',undefined,'cg-cv-diff-view');
    wrap.setAttribute('aria-label',label);

    if(parsed.summary.length){
      const sumBox=node('div',undefined,'cg-cv-diff-summary');
      for(const line of parsed.summary)sumBox.append(node('p',line));
      wrap.append(sumBox);
    }

    const bar=node('div',undefined,'cg-cv-diff-modes');
    const modes=[
      ['rnl',`仅 RNL 变动 (${parsed.rnlAdded+parsed.rnlRemoved})`,!parsed.hasRnlChanges],
      ['circuit',`网表与 RNL (${parsed.circuitAdded+parsed.circuitRemoved})`,!parsed.hasCircuitChanges],
    ];
    for(const [id,text,disabled] of modes){
      const b=button(text,()=>{diffMode=id;diffExpanded=false;render();},disabled);
      b.setAttribute('aria-pressed',String(activeMode===id));
      bar.append(b);
    }
    if(parsed.nonCircuitFiles.length){
      bar.append(node('span',`已忽略 ${parsed.nonCircuitFiles.length} 个文档/配置文件`,'cg-cv-diff-ignored'));
    }
    wrap.append(bar);

    const sections=selectDiffSections(parsed,activeMode);
    if(!sections.length){
      wrap.append(note(activeMode==='rnl'
        ?'此次提交未修改 RNL 原理图布局行，可切换到「网表与 RNL」查看器件/参数改动。'
        :'此次提交没有原理图或网表改动。'));
      return wrap;
    }

    const MAX_PREVIEW_LINES=100;
    let shownLines=0,hiddenLines=0;
    for(const file of sections){
      const card=node('div',undefined,'cg-cv-diff-file');
      const head=node('div',undefined,'cg-cv-diff-file-head');
      head.append(
        node('strong',file.name,'cg-cv-diff-file-name'),
        node('span',file.kind,'cg-cv-diff-tag'),
        node('span',`+${file.added} / -${file.removed}`,'cg-cv-diff-stat'),
      );
      head.title=file.path;
      card.append(head);

      const code=node('div',undefined,'cg-cv-diff-lines');
      let fileRendered=0;
      for(const hunk of file.hunks){
        if(!diffExpanded&&shownLines>=MAX_PREVIEW_LINES){
          hiddenLines+=hunk.lines.length;
          continue;
        }
        code.append(node('div',hunk.header,'cg-cv-diff-hunk'));
        for(const line of hunk.lines){
          if(!diffExpanded&&shownLines>=MAX_PREVIEW_LINES){
            hiddenLines++;
            continue;
          }
          shownLines++;
          fileRendered++;
          const rowEl=node('div',undefined,'cg-cv-diff-line is-'+line.type+(line.category==='rnl'?' is-rnl':''));
          rowEl.append(node('span',line.sign,'cg-cv-diff-sign'),node('span',line.text,'cg-cv-diff-text'));
          code.append(rowEl);
        }
      }
      if(fileRendered>0){
        card.append(code);
        wrap.append(card);
      }
    }
    if(hiddenLines>0&&!diffExpanded){
      wrap.append(button(`展开剩余 ${hiddenLines} 行改动`,()=>{diffExpanded=true;render();}));
    }
    return wrap;
  }
  function renderHistory(){
    if(detail){
      const titleBar=node('div',undefined,'cg-cv-detail-head');
      titleBar.append(
        button('‹ 返回历史',()=>{detail=null;diffMode=null;diffExpanded=false;render();}),
        node('strong',detail.commit?.subject||detail.summary||'电路修改记录'),
      );
      root.append(titleBar);
      const circuitFiles=(detail.files||[])
        .map(item=>typeof item==='string'?item:item.path)
        .filter(isCircuitSourcePath);
      const repoSlug=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(description?.repository||'')?description.repository:'CircuitGit-dev/CircuitGit';
      const commitSha=detail.commit?.sha||'';
      const githubLink=()=>{
        if(!/^[0-9a-f]{40}$/i.test(commitSha))return null;
        const gh=node('a','在 GitHub 查看完整提交差异 ↗','cg-cv-ext-link');
        gh.href=`https://github.com/${repoSlug}/commit/${commitSha}`;
        gh.target='_blank';gh.rel='noopener';
        return gh;
      };
      if(detail.diffOversized){
        const box=node('div',undefined,'cg-cv-diff-summary');
        box.append(
          node('p','本次提交包含大批量电路/网表导入文件，总差异超过单次 256 KB 预览上限，已跳过全量文本展开。'),
          node('p','后续针对原理图（RNL）或单个网表的常规修改提交，会在此直接展示精简的 RNL 红绿差异。'),
        );
        root.append(box);
        if(circuitFiles.length){
          const fileList=node('div',undefined,'cg-cv-oversized-files');
          for(const p of circuitFiles.slice(0,24)){
            const r=node('div',undefined,'cg-cv-oversized-row');
            r.append(node('span',shortFileName(p),'cg-cv-diff-file-name'),node('span',circuitFileKind(p),'cg-cv-diff-tag'));
            r.title=p;
            fileList.append(r);
          }
          if(circuitFiles.length>24)fileList.append(note(`其余 ${circuitFiles.length-24} 个网表文件已折叠。`));
          root.append(fileList);
        }
        const gh=githubLink();if(gh)root.append(gh);
      }else if(detail.diff!==undefined&&detail.diff!==null){
        if(detail.truncated){
          root.append(note('本次提交体积较大，已优先展示原理图与核心网表差异（其余大文件已省略）。'));
        }
        root.append(renderStructuredDiff(detail.diff,{label:'版本差异',fallbackPath:circuitFiles[0]||scope.entry}));
        if(detail.truncated){const gh=githubLink();if(gh)root.append(gh);}
      }else{
        root.append(note('当前为静态网页只读模式，未打包历史 diff；连接本机节点后可在此查看 RNL 与网表差异。'));
        const gh=githubLink();if(gh)root.append(gh);
      }
      if(!detail.diffOversized&&circuitFiles.length){
        root.append(note('涉及电路文件：'+circuitFiles.map(shortFileName).join('、')));
      }
      if(detail.commit?.sha){
        root.append(note('恢复目标：'+shortFileName(editor?.path||scope.entry)),button('恢复选中文件',()=>restore({commit:detail.commit.sha}),busy||!allowed('restore')));
      }
      return;
    }
    const filtered=filterCircuitCommits(history,{includeNonCircuit:showNonCircuitHistory});
    const list=node('div',undefined,'cg-cv-list');
    for(const commit of filtered.visible){
      const item=button('',()=>showCommit(commit));
      item.append(node('strong',commit.subject||'无提交说明'));
      const fileSummary=commit.circuitFiles?.length
        ? commit.circuitFiles.slice(0,2).map(shortFileName).join('、')+(commit.circuitFiles.length>2?` 等 ${commit.circuitFiles.length} 个文件`:'')
        : commit.nonCircuitOnly?'仅文档/配置':'';
      const meta=[short(commit.sha),commit.timestamp||commit.date||'',fileSummary].filter(Boolean).join(' · ');
      item.append(node('span',meta));
      list.append(item);
    }
    root.append(list);
    if(!filtered.visible.length){
      root.append(note('当前单元暂无原理图或网表修改记录；修改网表并提交后会显示在这里。'));
    }
    if(filtered.hiddenCount>0&&!showNonCircuitHistory){
      const foot=node('div',undefined,'cg-cv-history-filter');
      foot.append(
        node('span',`已自动隐藏 ${filtered.hiddenCount} 条非网表（文档/配置）记录`,'cg-cv-note'),
        button('查看全部',()=>{showNonCircuitHistory=true;render();}),
      );
      root.append(foot);
    }else if(showNonCircuitHistory){
      const foot=node('div',undefined,'cg-cv-history-filter');
      foot.append(
        node('span','当前包含非网表文档/配置提交','cg-cv-note'),
        button('仅看原理图/网表',()=>{showNonCircuitHistory=false;render();}),
      );
      root.append(foot);
    }
    renderCheckpoints();
    root.append(note(connected()?'仅追踪当前单元的原理图（RNL）与网表修改记录。':'仅展示当前单元的原理图/网表提交历史；连接本机节点可查看完整 RNL 差异与恢复版本。'));
  }
  function renderCheckpoints(limit=30){if(!checkpoints.length)return;const box=node('section',undefined,'cg-cv-checkpoints');box.append(node('strong',`保存点 · ${checkpoints.length}`));for(const checkpoint of checkpoints.slice(0,limit))box.append(row(note(`${checkpoint.path} · ${checkpoint.created_at||''}`),...(checkpoint.restore_versions||['after']).map(version=>button(version==='before'?'恢复保存前':'恢复保存后',()=>restore({checkpoint_id:checkpoint.checkpoint_id,path:checkpoint.path,checkpoint_version:version}),busy||!allowed('restore')||checkpoint.state==='unknown'))));root.append(box);}
  function renderSubmit(){
    const a=node('label','提交标题'),input=node('input');input.setAttribute('aria-label','电路提交标题');input.maxLength=120;input.value=title;input.oninput=()=>{title=input.value;};a.append(input);
    const b=node('label','更新说明'),area=node('textarea');area.setAttribute('aria-label','电路更新说明');area.rows=4;area.maxLength=8000;area.value=body;area.oninput=()=>{body=area.value;};b.append(area);root.append(a,b);
    const disabled=busy||loading;root.append(row(button('根据修改生成说明',()=>{({title,body}=commitDraft(scope,current?.changes));render();},disabled||!current?.changes?.length),button('提交',()=>{if(!title.trim())throw Error('请填写提交标题。');return execute('commit',{base_commit:current.base_commit,title:title.trim(),body});},disabled||!allowed('commit')||!current?.changes?.length)));
    root.append(note('提交保存到本机 Git；创建或更新 PR 会推送该单元允许的文件。'));
    const branchLabel=node('label','PR 分支（留空使用节点默认）'),branchInput=node('input');branchInput.setAttribute('aria-label','PR 分支');branchInput.value=lastPRBranch;branchInput.placeholder=`codex/library/${scope.library_id}/${scope.cell_id}`;branchInput.oninput=()=>{lastPRBranch=branchInput.value.trim();};branchLabel.append(branchInput);root.append(branchLabel);
    const relLabel=node('label','关联单元（可选，跨 Cell PR 每行 library/cell）'),relArea=node('textarea');relArea.setAttribute('aria-label','关联单元');relArea.rows=2;relArea.placeholder='例如：basics/rc-smoke';relArea.value=relatedCellsText;relArea.oninput=()=>{relatedCellsText=relArea.value;};relLabel.append(relArea);root.append(relLabel);
    root.append(row(button('创建 PR',()=>pr('create'),disabled||!allowed('pr')||!current?.base_commit),button('更新现有 PR',()=>pr('update'),disabled||!allowed('pr')||!current?.base_commit)));
    const prState=lastPR||current?.pull_request||description?.pull_request;if(prState){root.append(note(`PR ${prState.action==='update'?'已更新':prState.action==='create'?'已创建':prState.number?'#'+prState.number:''} · ${prState.state||prState.status||'状态未知'}`));if(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(prState.url||'')){const link=node('a','查看 PR ↗');link.href=prState.url;link.target='_blank';link.rel='noopener';root.append(link);}root.append(note('以上为本次操作回执；合并与 CI 状态以 GitHub 为准。'));}
    root.append(button('刷新 PR 状态',checkPR,busy||!connected()||!lastPRBranch));if(remotePR){root.append(note(`GitHub 当前状态：${remotePR.state||'未知'} · ${remotePR.branch||lastPRBranch}`));for(const pr of remotePR.pull_requests||[])root.append(note(`#${pr.number} · ${pr.state} · ${(pr.statusCheckRollup||[]).map(check=>[check.name||check.context,check.conclusion||check.status||check.state].filter(Boolean).join(': ')).join('；')||'没有已报告的检查状态'}`));}
    if(current?.branch)root.append(note(`当前分支 ${current.branch} · 基线 ${short(current.base_commit)}`));
    if(connected()&&(allowed('create_branch')||allowed('switch_branch')||allowed('create_cell')||allowed('clone_cell')||allowed('create_library'))){
      const tools=node('details');tools.append(node('summary','分支切换与新建库 / 单元'));
      const base=current?.base_commit||description?.base_commit;
      if(branchInfo?.branches?.length&&allowed('switch_branch')){
        const sel=node('select');sel.setAttribute('aria-label','切换本地分支');
        for(const b of branchInfo.branches)sel.add(new Option(b.name+(b.is_current?' (当前)':''),b.name));
        sel.value=switchTarget||branchInfo.current_branch||branchInfo.branches[0].name;switchTarget=sel.value;
        sel.onchange=()=>{switchTarget=sel.value;};
        tools.append(row(sel,button('切换分支',()=>execute('switch_branch',{branch:switchTarget,base_commit:base}),disabled||!base||branchInfo.dirty||switchTarget===branchInfo.current_branch)));
      }
      if(allowed('create_branch')){
        const nb=node('input');nb.setAttribute('aria-label','新分支名称');nb.placeholder='feat/my-circuit-variant';nb.value=newBranch;nb.oninput=()=>{newBranch=nb.value.trim();};
        tools.append(row(nb,button('新建并切换分支',()=>{if(!newBranch)throw Error('请填写新分支名称。');return execute('create_branch',{branch:newBranch,base_commit:base,checkout:true});},disabled||!base)));
      }
      if(allowed('create_library')){
        const nl=node('input');nl.setAttribute('aria-label','新建电路库 ID');nl.placeholder='my-analog-lib';nl.value=newLibId;nl.oninput=()=>{newLibId=nl.value.trim();};
        const nn=node('input');nn.setAttribute('aria-label','新建电路库名称');nn.placeholder='显示名称（可选）';nn.value=newLibName;nn.oninput=()=>{newLibName=nn.value.trim();};
        tools.append(row(nl,nn,button('新建电路库',()=>{if(!newLibId)throw Error('请填写新电路库 ID。');return execute('create_library',{library_id:newLibId,name:newLibName||newLibId,base_commit:base});},disabled||!base)));
      }
      if(allowed('create_cell')){
        const nc=node('input');nc.setAttribute('aria-label','新建单元 ID');nc.placeholder='my-new-cell';nc.value=newCellId;nc.oninput=()=>{newCellId=nc.value.trim();};
        tools.append(row(nc,button('在当前库新建单元',()=>{if(!newCellId)throw Error('请填写新单元 ID。');return execute('create_cell',{library_id:scope.library_id,cell_id:newCellId,base_commit:base});},disabled||!base)));
      }
      if(allowed('clone_cell')){
        const cc=node('input');cc.setAttribute('aria-label','克隆目标单元 ID');cc.placeholder=scope.cell_id+'-v2';cc.value=cloneCellId;cc.oninput=()=>{cloneCellId=cc.value.trim();};
        tools.append(row(cc,button('克隆当前单元',()=>{if(!cloneCellId)throw Error('请填写克隆目标单元 ID。');return execute('clone_cell',{source_library_id:scope.library_id,source_cell_id:scope.cell_id,library_id:scope.library_id,cell_id:cloneCellId,base_commit:base});},disabled||!base)));
      }
      root.append(tools);
    }
  }
  function parseRelatedCells(){
    const lines=relatedCellsText.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if(!lines.length)return undefined;
    return lines.map(line=>{const parts=line.split('/');if(parts.length!==2||!parts[0]||!parts[1])throw Error('关联单元格式应为 library_id/cell_id：'+line);return {library_id:parts[0].trim(),cell_id:parts[1].trim()};});
  }
  function pr(action){if(!title.trim())throw Error('请填写 PR 标题。');const rel=parseRelatedCells();return execute('pr',{commit:current.base_commit,title:title.trim(),body,action,...(lastPRBranch?{branch:lastPRBranch}:{}),...(rel?{related_cells:rel}:{})});}
  async function checkPR(){const ticket=generation,branch=lastPRBranch;if(busy||!branch)return;busy=true;render();try{const result=await read('pr_status',{branch});if(ticket===generation)remotePR=result;}catch(e){if(ticket===generation)error=e.message;}finally{if(ticket===generation){busy=false;render();}}}
  function renderCI(){
    if(!ci){root.append(note(connected()?'当前节点未返回此单元的 CI 配置。':'连接本机节点后可查看和配置此单元的 Testbench CI。'));return;}
    if((ci.testbenches||[]).length){
    const selected=new Set(ci.config?.testbench_ids||[]),enabled=node('input');enabled.type='checkbox';enabled.checked=ci.config?.enabled===true;enabled.disabled=busy||!allowed('ci');const label=node('label',undefined,'cg-cv-check');label.append(enabled,document.createTextNode('启用 Testbench CI'));root.append(label);
    const choices=[];for(const tb of ci.testbenches||[]){const input=node('input');input.type='checkbox';input.value=tb.id;input.checked=selected.has(tb.id);input.disabled=busy||!allowed('ci')||tb.available===false;choices.push(input);const line=node('label',undefined,'cg-cv-check');line.append(input,document.createTextNode(tb.label||tb.id));root.append(line,note([tb.engine,tb.configuration_path,tb.workflow_path,tb.requires_external_models?'需要外部模型':null,tb.available===false?'当前不可用':null].filter(Boolean).join(' · ')));}
    if(!choices.length)root.append(note('此单元尚未注册可选 Testbench。'));
    root.append(button('保存 CI 配置',()=>execute('ci',{enabled:enabled.checked,testbench_ids:choices.filter(x=>x.checked).map(x=>x.value),base_sha256:ci.sha256??null}),busy||!allowed('ci')),
      note('这里保存 Testbench 与工作流配置。保存配置不会证明仿真或 CI 已运行。'));
    }
    if(ci.status||ci.runs)root.append(pre(JSON.stringify({status:ci.status,runs:ci.runs},null,2),'CI 状态'));
    renderAgentTestbenches(ci.agent_testbenches);
  }
  function digestDetails(binding){const box=node('details');box.append(node('summary','核对版本与内容摘要'));const labels={source_commit:'电路基线提交',source_sha256:'电路内容',testbench_sha256:'Testbench',analysis_sha256:'分析脚本',manifest_sha256:'实验配置',criteria_sha256:'验收条件'};for(const [name,label]of Object.entries(labels)){const value=binding?.[name];if(value)box.append(note(label),node('code',value,'cg-cv-digest'));}return box;}
  function renderAgentTestbenches(data){
    root.append(node('strong','Agent Testbench CI'),note('Agent 提供完整测试电路、分析脚本和验收条件；审阅后注册为当前单元的 Git 版本。注册不会提交远端仿真。'));
    if(!data){root.append(note('当前节点尚未提供 Agent Testbench CI。'));return;}
    for(const tb of data.bundles||[]){const card=node('section',undefined,'cg-cv-testbench');card.append(node('strong',tb.title||tb.id),note(`${tb.id} · 注册提交 ${short(tb.registration_commit)}`),note(tb.source_matches?'源电路与审阅版本一致':'源电路已变化，需要重新审阅此测试包',tb.source_matches?'cg-cv-note':'cg-cv-error'),note(testbenchExecutionLabel(tb.execution_status)),digestDetails(tb.binding));if(tb.latest_result){const result=node('details');result.append(node('summary',`结果 · ${tb.latest_result.job_id||''}`),pre(JSON.stringify(tb.latest_result.evaluation,null,2),'CI 验收结果'),note(`分析 ${tb.latest_result.analysis_id||'—'} · 结果 ${tb.latest_result.result_id||'—'}`));card.append(result);}card.append(note('分析采用已注册的 SpiceOwl 算法；Python 脚本保留供审阅，不作为任意命令执行。'));root.append(card);}
    if(!(data.bundles||[]).length)root.append(note('此单元尚未注册 Agent 测试包。'));
    for(const proposal of data.proposals||[]){if(['complete','completed'].includes(proposal.state))continue;const card=node('section',undefined,'cg-cv-testbench');card.append(node('strong',proposal.title||proposal.id),note(`待审阅 · ${proposal.id} · ${short(proposal.base_commit)}`),digestDetails(proposal.binding));for(const file of proposal.per_file_diffs||[]){const detail=node('details');detail.append(node('summary',file.path),pre(file.diff,'测试包文件差异 '+file.path));card.append(detail);}card.append(button('打开完整审阅',()=>reviewTestbench(proposal),busy||!allowed('testbench_review')||proposal.source_matches!==true));if(proposal.source_matches!==true)card.append(note('源电路或基线已更新，请 Agent 重新生成审阅。','cg-cv-error'));root.append(card);}
    if(reviewLink){const a=node('a','前往人工审阅页面 ↗');a.href=reviewLink.url;a.target='_blank';a.rel='noopener';root.append(row(a,button('核对审阅结果',checkTestbenchReview,busy)));}
  }
  async function reviewTestbench(proposal){const ticket=generation;busy=true;error='';render();try{const result=await bridge.request('review_testbench',{...args(),review_id:proposal.review_id});if(ticket!==generation||disposed)return;const url=new URL(result.url);if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/library/review'||typeof result.ticket!=='string')throw Error('审阅页面身份无效。');reviewLink={ticket:result.ticket,url:url.href};message='完整冻结差异已准备，请在人工审阅页面确认。';}catch(e){if(ticket===generation)error=e.message;}finally{if(ticket===generation){busy=false;render();}}}
  async function checkTestbenchReview(){if(!reviewLink||busy)return;const ticket=generation;busy=true;error='';render();try{const result=await bridge.request('review_status',{ticket:reviewLink.ticket});if(ticket!==generation||disposed)return;if(['complete','completed'].includes(result.state)){reviewLink=null;message='Testbench CI 已注册并保存为电路 Git 版本；尚未运行仿真。';busy=false;await refresh({liveOnly:true});}else message=({pending:'仍在等待人工审阅。',denied:'本次注册已取消。',expired:'审阅已过期，请重新打开完整审阅。',unknown:'注册结果尚未确认，保留原审阅请求。',running:'正在注册，请稍后核对原请求。'}[result.state]||'审阅结果尚未确认。');}catch(e){if(ticket===generation)error=e.message;}finally{if(ticket===generation){busy=false;render();}}}
  async function openFile(path,{discard=false}={}){
    if(busy||!scope)return;repositoryPath(path);if(!files().some(file=>file.path===path))throw Error('文件不在当前单元清单内。');
    const ticket=generation,fileTicket=++fileGeneration;loading=true;error='';render();
    try{let file;if(connected()&&description?.library_id===scope.library_id&&description?.cell_id===scope.cell_id){file=await read('read_file',{path});file={...file,text:file.text??file.content,origin:'live'};}else{const bundle=await publishedClient.loadView({kind:'markdown',entry:path,files:[path]},{signal:abort.signal});file={path,text:bundle.text,sha256:null,editable:false,origin:'published'};}
      if(ticket!==generation||fileTicket!==fileGeneration||disposed)return;if(file.path!==path||typeof file.text!=='string')throw Error('节点返回的文件身份无效。');
      if(discard)drafts.delete(draftKey(path));const draft=drafts.get(draftKey(path));editor=draft?.dirty?{...draft,editable:file.editable,origin:file.origin,conflict:draft.sha256!==file.sha256}:{...file,original:file.text,dirty:false};if(editor.conflict)error='本机文件已更新；编辑器保留未保存草稿。复制需要的内容后，可丢弃草稿并重新读取。';
    }catch(e){if(ticket===generation&&fileTicket===fileGeneration&&!abort.signal.aborted)error=e.message;}
    finally{if(ticket===generation&&fileTicket===fileGeneration&&!disposed){loading=false;render();}}
  }
  async function showCommit(commit){
    if(busy||loading)return;const ticket=generation;diffMode=null;diffExpanded=false;error='';loading=true;render();
    try{const result=connected()?await read('commit_detail',{commit:commit.sha}):{commit,diff:commit.diff,files:commit.files};if(ticket===generation)detail=result;}
    catch(e){
      if(ticket===generation){
        if(isDiffLimitError(e)){
          error='';
          detail={commit,files:commit.files||[],diff:null,diffOversized:true};
        }else{
          error=e.message;
        }
      }
    }finally{if(ticket===generation){loading=false;render();}}
  }
  async function restore(target){
    const ticket=generation,path=target.path||editor?.path||scope.entry;const file=await read('read_file',{path});if(ticket!==generation||disposed)return;if(file.path!==path||!file.editable)throw Error('所选文件不可恢复。');
    await execute('restore',{...target,path,base_sha256:file.sha256});
  }
  async function applyReceipt(result,record,{refreshView=true}={}){
    const state=receiptState(result),done=['complete','completed','succeeded'].includes(state);
    if(receiptReleased(result)){pending.forget(record);if(unknown?.idempotency_key===record.idempotency_key)unknown=null;
      if(done){if(record.operation==='pr'){lastPR=result.result?.pull_request||result.result||result.pull_request||result;lastPRBranch=lastPR.branch||lastPRBranch;}if(['save','save_files'].includes(record.operation))for(const path of record.paths||[])drafts.delete(JSON.stringify([record.library_id,record.cell_id,path]));}
      if(scope?.library_id===record.library_id&&scope?.cell_id===record.cell_id){message=done?'已'+({save:'保存',save_files:'保存文件',restore:'恢复并记录保存点',commit:'提交',pr:'完成 PR 操作',ci:'保存 CI 配置',create_library:'新建电路库',create_cell:'新建电路单元',clone_cell:'克隆电路单元',create_branch:'新建分支',switch_branch:'切换分支'}[record.operation]||'完成操作')+'。':state==='rolled_back'?'操作未完成，已回退到写入前的文件。':'原请求未执行，可重新修改后提交。';busy=false;if(refreshView)await refresh();}
      return done;
    }
    unknown={...record,state};message=state==='partial'?'部分文件写入未完成，请核对文件和原请求；未自动重试。':'结果尚未确认；未重发操作。';return false;
  }
  async function execute(operation,payload){
    if(busy||loading||!allowed(operation==='save_files'?'save':operation))return;
    const ticket=generation,record=pending.remember({idempotency_key:'cell-'+crypto.randomUUID(),operation,...args(),repository:description.repository,paths:payload.path?[payload.path]:(payload.files||[]).map(file=>file.path)});
    const execArgs=['create_branch','switch_branch'].includes(operation)?payload:operation==='create_library'?payload:{library_id:record.library_id,cell_id:record.cell_id,...payload};
    unknown={...record,state:'pending'};busy=true;error='';message='';render();
    try{const result=await bridge.request('execute',{operation,args:execArgs,idempotency_key:record.idempotency_key});
      const done=['complete','completed','succeeded'].includes(receiptState(result));if(ticket!==generation||disposed){if(done)pending.forget(record);return;}await applyReceipt(result,record);
    }catch(e){if(ticket===generation&&!disposed){const code=e.data?.code||'';if([400,403,404,409,422].includes(e.status)&&!['outcome_unknown','transport_unknown','idempotency_conflict'].includes(code)){pending.forget(record);unknown=null;}else unknown={...record,state:'unknown'};error=e.message;}}
    finally{if(ticket===generation&&!disposed){busy=false;render();}}
  }
  async function checkReceipt(){
    if(!unknown||busy||!connected())return;const ticket=generation,record=unknown;busy=true;error='';render();
    try{const result=await bridge.request('receipt',{idempotency_key:record.idempotency_key});if(ticket!==generation||disposed)return;await applyReceipt(result,record);}
    catch(e){if(ticket===generation){error=e.message;unknown={...record,state:'unknown'};}}
    finally{if(ticket===generation){busy=false;render();}}
  }
  function watchScope(){
    unwatch?.();unwatch=null;lastFingerprint=null;if(!scope||!activated||!bridge.watchCell)return;
    const watched={library_id:scope.library_id,cell_id:scope.cell_id};
    unwatch=bridge.watchCell(watched,{isVisible:()=>!disposed&&root.getClientRects().length>0,onCurrent(value,{fingerprint,changed}){
      if(disposed||scope?.library_id!==watched.library_id||scope?.cell_id!==watched.cell_id)return;
      if(fingerprint===lastFingerprint||busy||loading)return;
      lastFingerprint=fingerprint;current=value;void refresh({liveOnly:true});
    },onError(e){if(!busy&&!loading&&error!==e.message){error=e.message;render();}}});
  }
  async function refresh({liveOnly=false}={}){
    if(!scope||disposed)return;activated=true;const ticket=++generation;abort?.abort();abort=new AbortController();loading=true;error='';render();
    if(!liveOnly)try{const found=await loadPublished(scope,{signal:abort.signal});if(ticket!==generation)return;published=found;history=found?.commits||[];}catch(e){if(ticket===generation&&!connected())error=e.message;}
    if(ticket!==generation||disposed)return;
    if(connected()){
      const calls=await Promise.allSettled([...['describe','current','history','checkpoints','get_ci'].map(operation=>read(operation)),bridge.request('branches',{}).catch(()=>null)]);
      if(ticket!==generation||disposed)return;
      const [d,c,h,p,t,br]=calls;description=d.status==='fulfilled'?d.value:null;current=c.status==='fulfilled'?c.value:null;if(h.status==='fulfilled')history=h.value.commits||[];checkpoints=p.status==='fulfilled'?p.value.checkpoints||[]:[];ci=t.status==='fulfilled'?t.value:null;branchInfo=br.status==='fulfilled'?br.value:null;
      const failure=calls.slice(0,5).find(item=>item.status==='rejected');if(failure)error=failure.reason.message;
      if(description&&(description.library_id!==scope.library_id||description.cell_id!==scope.cell_id)){description=null;current=null;history=published?.commits||[];checkpoints=[];ci=null;error='节点返回了其他电路单元，已停止后续操作。';}
    }else{description=null;current=null;checkpoints=[];ci=null;branchInfo=null;}
    unknown=pending.find(scope,description?.repository);lastFingerprint=current?.fingerprint||current?.revision||lastFingerprint;loading=false;render();if(tab==='files'){const path=editor?.path||scope.entry;if(files().some(file=>file.path===path))await openFile(path);}
  }
  function change(){const next=getSelection();if(key(next)===key(scope))return;scope=next;generation++;abort?.abort();reviewLink=null;description=current=published=detail=editor=ci=null;history=[];checkpoints=[];unknown=pending.find(scope);lastPR=null;lastPRBranch='';remotePR=null;title=body=error=message='';busy=loading=false;render();watchScope();if(scope&&activated)void refresh();}
  const offSelection=subscribeSelection(change),offBridge=bridge?.subscribe?.(()=>{description=null;current=null;editor=null;detail=null;generation++;busy=false;unknown=pending.find(scope);if(activated)void refresh();else render();});
  const offMutation=bridge?.subscribeMutation?.(event=>{if(scope?.library_id!==event.args.library_id||scope?.cell_id!==event.args.cell_id||disposed)return;void onSourceChange(event);if(!busy&&!loading&&activated)void refresh({liveOnly:true});});change();render();
  async function activate(){if(activated||activating||disposed)return;activating=true;try{await onActivate();if(disposed)return;activated=true;change();watchScope();if(scope&&!loading)await refresh();}catch(e){fail(e);}finally{activating=false;}}
  const visibility=deferLoad&&typeof IntersectionObserver!=='undefined'?new IntersectionObserver(entries=>{if(entries.some(item=>item.isIntersecting))void activate();}):null;visibility?.observe(root);
  return {refresh,activate,destroy(){visibility?.disconnect();disposed=true;generation++;abort?.abort();offSelection?.();offBridge?.();offMutation?.();unwatch?.();root.remove();css.remove();}};
}
