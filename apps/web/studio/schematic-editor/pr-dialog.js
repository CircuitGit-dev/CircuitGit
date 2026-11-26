// Save, Commit, and Create/Update Pull Request dialog with structured RNL red/green diff preview.
import {parseCircuitDiff,selectDiffSections,shortFileName} from '../../library/history-diff.js';

function createUnifiedDiff(path,beforeText,afterText){
  const a=String(beforeText??'').split(/\r?\n/);
  const b=String(afterText??'').split(/\r?\n/);
  if(a.length===b.length&&a.every((v,i)=>v===b[i]))return '';
  let start=0,end=0;
  while(start<a.length&&start<b.length&&a[start]===b[start])start++;
  while(end<a.length-start&&end<b.length-start&&a[a.length-1-end]===b[b.length-1-end])end++;
  const ctx=2;
  const fromStart=Math.max(0,start-ctx);
  const aSlice=a.slice(fromStart,Math.min(a.length,a.length-end+ctx));
  const bSlice=b.slice(fromStart,Math.min(b.length,b.length-end+ctx));
  const headCtx=a.slice(fromStart,start).map(l=>' '+l);
  const removed=a.slice(start,a.length-end).map(l=>'-'+l);
  const added=b.slice(start,b.length-end).map(l=>'+'+l);
  const tailCtx=a.slice(a.length-end,Math.min(a.length,a.length-end+ctx)).map(l=>' '+l);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${fromStart+1},${aSlice.length} +${fromStart+1},${bSlice.length} @@`,
    ...headCtx,
    ...removed,
    ...added,
    ...tailCtx,
  ].join('\n');
}

function downloadFile(fileName,text){
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  const a=document.createElement('a');
  a.href=url;a.download=fileName;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function openSavePrDialog({
  target,
  baselineText,
  currentText,
  editSummaries=[],
  bridge=null,
  onRequireConnector=null,
  onSaved=null,
  notify=()=>{},
}={}){
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const dialog=el('dialog',undefined,'cg-ed-dialog cg-ed-pr-dialog');
  dialog.setAttribute('aria-label','保存电路并提交 Pull Request');

  const connected=()=>bridge?.getState?.()?.connected===true;
  const hasCellScope=Boolean(target?.library_id&&target?.cell_id&&target?.path);
  const dirty=currentText!==baselineText;
  const relPath=target?.path||target?.fileName||'circuit.scs';
  const fileBase=shortFileName(relPath);
  const rawDiff=createUnifiedDiff(relPath,baselineText,currentText);
  const parsedDiff=parseCircuitDiff(rawDiff,{fallbackPath:relPath});

  let busy=false,diffMode=parsedDiff.hasRnlChanges?'rnl':'circuit',statusText='',errorText='',prResult=null,savedCommit=null;
  const defaultTitle=editSummaries.length
    ? `更新 ${target?.cell_name||fileBase}：${editSummaries.slice(-2).join('、')}`.slice(0,96)
    : `更新 ${target?.cell_name||fileBase} 原理图与网表`;
  const defaultBody=[
    ...parsedDiff.summary.map(s=>`- ${s}`),
    ...(editSummaries.length?['','画布操作记录：',...editSummaries.slice(-8).map(s=>`- ${s}`)]:[]),
  ].join('\n');

  let titleVal=defaultTitle,bodyVal=defaultBody,branchVal='';

  function render(){
    dialog.replaceChildren();
    const head=el('header',undefined,'cg-ed-dialog-head');
    head.append(el('strong','保存修改 & 提交 Pull Request'));
    const closeBtn=el('button','×','cg-ed-close');closeBtn.type='button';closeBtn.disabled=busy;closeBtn.onclick=()=>dialog.close();
    head.append(closeBtn);
    dialog.append(head);

    const body=el('div',undefined,'cg-ed-dialog-body');
    const meta=el('div',undefined,'cg-ed-meta-bar');
    meta.append(
      el('span',hasCellScope?`${target.library_name||target.library_id} / ${target.cell_name||target.cell_id}`:fileBase,'cg-ed-meta-cell'),
      el('code',relPath,'cg-ed-meta-path'),
      el('span',dirty?'有未保存画布改动':'当前已同步','cg-ed-pill'+(dirty?' is-dirty':'')),
    );
    body.append(meta);

    if(errorText)body.append(el('p',errorText,'cg-ed-error'));
    if(statusText)body.append(el('p',statusText,'cg-ed-status'));
    if(prResult){
      const prBox=el('div',undefined,'cg-ed-pr-receipt');
      prBox.append(el('strong',`Pull Request ${prResult.action==='update'?'已更新':'已创建'}${prResult.number?' #'+prResult.number:''}`));
      if(prResult.branch)prBox.append(el('span',`分支：${prResult.branch}`,'cg-ed-meta-path'));
      if(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(prResult.url||'')){
        const a=el('a','前往 GitHub 查看 Pull Request ↗','cg-ed-link');
        a.href=prResult.url;a.target='_blank';a.rel='noopener';
        prBox.append(a);
      }
      body.append(prBox);
    }

    // Structured RNL + Netlist diff preview
    if(dirty){
      const diffWrap=el('section',undefined,'cg-ed-diff-box');
      if(parsedDiff.summary.length){
        const sum=el('div',undefined,'cg-ed-diff-summary');
        for(const line of parsedDiff.summary)sum.append(el('p',line));
        diffWrap.append(sum);
      }
      const modeBar=el('div',undefined,'cg-ed-diff-modes');
      for(const [id,label,disabled] of [
        ['rnl',`仅 RNL 变动 (${parsedDiff.rnlAdded+parsedDiff.rnlRemoved})`,!parsedDiff.hasRnlChanges],
        ['circuit',`网表与 RNL (${parsedDiff.circuitAdded+parsedDiff.circuitRemoved})`,!parsedDiff.hasCircuitChanges],
      ]){
        const btn=el('button',label,'cg-ed-mode-btn'+(diffMode===id?' is-active':''));
        btn.type='button';btn.disabled=disabled;
        btn.onclick=()=>{diffMode=id;render();};
        modeBar.append(btn);
      }
      diffWrap.append(modeBar);

      const sections=selectDiffSections(parsedDiff,diffMode);
      const code=el('div',undefined,'cg-ed-diff-lines');
      if(!sections.length){
        code.append(el('p','当前筛选下无可展示差异行。','cg-ed-muted'));
      }else{
        for(const sec of sections){
          for(const hunk of sec.hunks){
            code.append(el('div',hunk.header,'cg-ed-diff-hunk'));
            for(const row of hunk.lines.slice(0,120)){
              const r=el('div',undefined,'cg-ed-diff-line is-'+row.type);
              r.append(el('span',row.sign,'cg-ed-diff-sign'),el('span',row.text,'cg-ed-diff-text'));
              code.append(r);
            }
          }
        }
      }
      diffWrap.append(code);
      body.append(diffWrap);
    }else{
      body.append(el('p','当前画布与最近一次保存一致；如果本机已有已提交修改，仍可直接创建或更新 PR。','cg-ed-muted'));
    }

    // Commit / PR form
    const canGit=connected()&&hasCellScope;
    if(canGit){
      const form=el('div',undefined,'cg-ed-form');
      const l1=el('label');l1.append(el('span','提交 / PR 标题'));
      const inpTitle=document.createElement('input');inpTitle.value=titleVal;inpTitle.maxLength=120;inpTitle.disabled=busy;
      inpTitle.oninput=()=>{titleVal=inpTitle.value;};
      l1.append(inpTitle);

      const l2=el('label');l2.append(el('span','更新说明（会写入 Commit 与 PR 描述）'));
      const inpBody=document.createElement('textarea');inpBody.rows=3;inpBody.value=bodyVal;inpBody.disabled=busy;
      inpBody.oninput=()=>{bodyVal=inpBody.value;};
      l2.append(inpBody);

      const l3=el('label');l3.append(el('span','PR 分支名（留空自动生成）'));
      const inpBranch=document.createElement('input');inpBranch.value=branchVal;inpBranch.placeholder=`codex/library/${target.library_id}/${target.cell_id}`;inpBranch.disabled=busy;
      inpBranch.oninput=()=>{branchVal=inpBranch.value.trim();};
      l3.append(inpBranch);

      form.append(l1,l2,l3);
      body.append(form);
    }else{
      const hint=el('div',undefined,'cg-ed-connect-hint');
      hint.append(el('p',!connected()
        ?'当前为网页预览模式（未连接本机节点）。你可以直接下载修改后的 .scs 文件，或连接本机节点后一键保存并提交 GitHub Pull Request。'
        :'当前电路来自临时/外部导入网表，尚未归属到可写电路库单元；可直接下载修改后的 .scs 文件。'));
      body.append(hint);
    }

    const actions=el('footer',undefined,'cg-ed-dialog-actions');
    const dlBtn=el('button','下载 .scs 文件','cg-ed-btn');
    dlBtn.type='button';dlBtn.disabled=busy;
    dlBtn.onclick=()=>{downloadFile(fileBase,currentText);notify(`已下载 ${fileBase}`);};
    actions.append(dlBtn);

    if(!connected()&&typeof onRequireConnector==='function'){
      const connBtn=el('button','连接本机以提交 PR','cg-ed-btn cg-ed-btn-primary');
      connBtn.type='button';
      connBtn.onclick=()=>{dialog.close();onRequireConnector('保存电路并提交 Pull Request');};
      actions.append(connBtn);
    }

    if(canGit){
      const saveOnlyBtn=el('button',busy?'处理中…':'仅保存到本机','cg-ed-btn');
      saveOnlyBtn.type='button';saveOnlyBtn.disabled=busy||!dirty;
      saveOnlyBtn.onclick=()=>void runPipeline({doCommit:false,doPr:false});

      const commitBtn=el('button',busy?'处理中…':'保存并 Commit','cg-ed-btn');
      commitBtn.type='button';commitBtn.disabled=busy||!titleVal.trim();
      commitBtn.onclick=()=>void runPipeline({doCommit:true,doPr:false});

      const prBtn=el('button',busy?'正在提交 PR…':'保存并提交 Pull Request','cg-ed-btn cg-ed-btn-primary');
      prBtn.type='button';prBtn.disabled=busy||!titleVal.trim();
      prBtn.onclick=()=>void runPipeline({doCommit:true,doPr:true,prAction:'create'});

      actions.append(saveOnlyBtn,commitBtn,prBtn);
    }

    dialog.append(body,actions);
  }

  async function saveToLocal(){
    const scopeArgs={library_id:target.library_id,cell_id:target.cell_id};
    const fileInfo=await bridge.request('read_file',{...scopeArgs,path:target.path});
    if(!fileInfo?.editable)throw Error('当前单元文件在本机节点上不可写，请检查本机仓库状态。');
    const res=await bridge.request('execute',{
      operation:'save',
      args:{...scopeArgs,path:target.path,content:currentText,base_sha256:fileInfo.sha256},
      idempotency_key:'ed-save-'+crypto.randomUUID(),
    });
    const state=res?.receipt?.state||res?.state||'unknown';
    if(!['complete','completed','succeeded'].includes(state)){
      throw Error(`保存未确认完成（状态：${state}），请在「版本管理」核对。`);
    }
    onSaved?.({text:currentText,path:target.path});
    return true;
  }

  async function runPipeline({doCommit,doPr,prAction='create'}){
    if(busy)return;
    busy=true;errorText='';statusText='正在保存电路文件到本机工作区…';render();
    const scopeArgs={library_id:target.library_id,cell_id:target.cell_id};
    try{
      if(currentText!==baselineText){
        await saveToLocal();
        baselineText=currentText;
      }
      if(!doCommit){
        statusText='已保存到本机工作区并保留保存点。';
        notify(`已保存 ${fileBase} 到本机工作区。`);
        return;
      }
      statusText='正在读取本机 Git 基线并创建提交…';render();
      const cur=await bridge.request('current',scopeArgs);
      let commitSha=cur?.base_commit||savedCommit;
      if(cur?.changes?.length){
        const commitRes=await bridge.request('execute',{
          operation:'commit',
          args:{...scopeArgs,base_commit:cur.base_commit,title:titleVal.trim(),body:bodyVal.trim()},
          idempotency_key:'ed-commit-'+crypto.randomUUID(),
        });
        const cState=commitRes?.receipt?.state||commitRes?.state||'unknown';
        if(!['complete','completed','succeeded'].includes(cState)){
          throw Error(`Git 提交未确认完成（状态：${cState}）。`);
        }
        commitSha=commitRes?.result?.commit||commitRes?.commit||(await bridge.request('current',scopeArgs))?.base_commit;
        savedCommit=commitSha;
      }
      if(!doPr){
        statusText=`已保存并提交到本机 Git（${String(commitSha||'').slice(0,8)}）。`;
        notify(`已提交 ${fileBase} 到本机 Git。`);
        return;
      }
      statusText='正在推送电路分支并创建 GitHub Pull Request…';render();
      const prArgs={
        ...scopeArgs,
        commit:commitSha,
        title:titleVal.trim(),
        body:bodyVal.trim(),
        action:prAction,
        ...(branchVal?{branch:branchVal}:{}),
      };
      let prRes;
      try{
        prRes=await bridge.request('execute',{operation:'pr',args:prArgs,idempotency_key:'ed-pr-'+crypto.randomUUID()});
      }catch(firstErr){
        // If branch already has an open PR, surface clear guidance
        throw firstErr;
      }
      const pState=prRes?.receipt?.state||prRes?.state||'unknown';
      if(!['complete','completed','succeeded'].includes(pState)){
        throw Error(`PR 请求未确认完成（状态：${pState}），请在「版本管理」检查回执。`);
      }
      prResult=prRes?.result?.pull_request||prRes?.result||prRes?.pull_request||prRes;
      statusText='Pull Request 已提交成功！';
      notify(`已为 ${fileBase} 提交 Pull Request。`);
    }catch(err){
      errorText=err?.message||String(err);
      statusText='';
      notify(errorText,{kind:'error'});
    }finally{
      busy=false;
      render();
    }
  }

  dialog.addEventListener('keydown',e=>e.stopPropagation());
  dialog.addEventListener('close',()=>dialog.remove());
  document.body.append(dialog);
  render();
  dialog.showModal();
  return dialog;
}
