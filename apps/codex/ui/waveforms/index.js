import {mountWaveformPanel} from '../../../../modules/waveforms/panel.js';
import {createViewAdapter,panelContext} from './adapter.js';
import {selectionContext} from './summary.js';
import {workspaceSelection,resolveLinkedSelection} from './link.js';


export function validateWaveformLocalState(saved,binding,signals){
  if(saved?.schema!=='ic.waveforms.local.v1'||JSON.stringify(saved.binding)!==JSON.stringify(binding))throw Error('波形恢复状态与此视图/run/source不一致。');
  const selected=saved.panel?.signals||[];
  if(!Array.isArray(selected)||selected.length>16||new Set(selected.map(s=>s.id)).size!==selected.length||selected.some(s=>typeof s.id!=='string'||!signals.some(x=>x.id===s.id&&x.status==='available')))throw Error('恢复信号不在此运行的可读目录中。');
  return selected;
}

export function mount(root,host){
  if(!root||!host?.call||!host?.updateModelContext)throw Error('MCP Apps host contract required');
  const styleLink=host.assetURL?Object.assign(document.createElement('link'),{rel:'stylesheet',href:host.assetURL('apps/codex/ui/waveforms/style.css')}):null;
  if(styleLink)root.ownerDocument.head.append(styleLink);
  root.classList.add('ic-mcp-waveforms');root.classList.toggle('embedded',host.embedded===true);root.setAttribute('aria-label','已保存波形视图');
  root.innerHTML=`<header><div><h1>已保存波形</h1><p>从此运行的实际信号目录选取曲线，游标读取完整源数据。</p></div><button type="button" class="mcp-expand">全屏显示</button></header>
    <div class="mcp-identity"></div><div class="mcp-controls"><button type="button" class="mcp-refresh">刷新本视图</button><button type="button" class="mcp-share">更新模型上下文</button><span class="mcp-view-status"></span></div>
    <p class="mcp-feedback" role="status" aria-live="polite"></p><section class="mcp-link"><div class="mcp-link-controls"><button type="button" class="mcp-link-read">读取原理图选择</button><label><input type="checkbox" class="mcp-link-follow">跟随同工作区原图（2秒，可停止）</label></div><p class="mcp-link-status" role="status">仅接收此 workspace 的已发布原理图选择；依照本 run 的精确映射核验。</p><div class="mcp-link-choices"></div></section><section class="mcp-panel"></section>
    <details><summary>运行与视图身份</summary><div class="mcp-details"></div></details>
    <p class="mcp-probe-note">本窗口只读已保存结果。源或原理图映射过期不影响历史目录浏览；此选择不证明当前电路已仿真。其他运行请打开另一个固定 run 的波形视图。</p>`;
  const $=s=>root.querySelector(s),section=$('.mcp-panel');
  let visible=true,closing=false,localState=null,deferredSelection=false;
  let disposed=false,panel=null,initializing=true,syncTimer=null,syncing=false,needsSync=false,lastSelection='[]',lastSummary='',dataError=null,restoreKey=null,writingSelection=false,syncBlocked=false,linkTimer=null,linkBusy=false,linkKey=null,pendingLink=null,lastLinked=null;
  const feedback=(message,kind='info')=>{if(disposed)return;$('.mcp-feedback').textContent=message;$('.mcp-feedback').dataset.kind=kind;};
  const fail=error=>{if(error.name!=='AbortError')feedback(error.message||String(error),'error');};
  function identity(view){
    const i=view.identity;$('.mcp-identity').textContent=`工程 ${i.project_id} · run ${i.run_id}\n运行源 ${i.source_commit}${i.source_sha256?' · SHA256 '+i.source_sha256:''}`;
    $('.mcp-details').textContent=`Workspace ${view.workspace_id} · View ${view.view_id} · Revision ${view.revision}${i.configuration?' · 配置 '+i.configuration:''}`;
    $('.mcp-view-status').textContent=`修订 ${view.revision} · ${view.readiness?.state==='loaded'?'客户端已读取目录':'等待数据'} · 宿主挂载未核验`;
  }
  const adapter=createViewAdapter(host,{
    onView(view,reason){if(disposed)return;identity(view);
      if(!initializing&&reason==='result'&&!writingSelection){if(!visible||closing)deferredSelection=true;else void restoreSelection({replace:true}).then(scheduleSync).catch(fail);}
    },
    onCatalog(){dataError=null;},onMapping(data,error){if(error)feedback('原理图映射不可用；仍可选择此运行已保存信号。','info');},
    onWaveform(){scheduleSync();},onError(error){dataError=error;section.inert=true;fail(error);}
  });
  identity(adapter.view);
  const contextAdapter=Object.freeze({getContext:()=>panelContext(adapter.view),subscribe:()=>()=>{}});
  function summary(){const v=adapter.view;const result=selectionContext({view_id:v.view_id,workspace_id:v.workspace_id,revision:v.revision,
    project_id:v.identity.project_id,run_id:v.identity.run_id,run_source_commit:v.identity.source_commit,source_sha256:v.identity.source_sha256},panel.snapshot(),adapter.catalog,adapter.readings);if(lastLinked)result.last_linked_schematic=lastLinked;return result;}
  function scheduleSync(){if(disposed||initializing||!visible||closing)return;clearTimeout(syncTimer);syncTimer=setTimeout(()=>void synchronize().catch(fail),150);}
  async function synchronize(force=false){
    if(disposed||!visible||closing||!panel||initializing||syncBlocked||dataError)return;
    if(syncing){needsSync=true;return;}
    const snapshot=panel.snapshot();if(snapshot.signals.some(s=>!s.loaded))return;
    syncing=true;
    try{
      const ids=snapshot.signals.map(s=>s.id),key=JSON.stringify(ids);
      if(key!==lastSelection){writingSelection=true;try{await adapter.select(ids);}finally{writingSelection=false;}if(disposed)return;lastSelection=key;}
      const value=summary(),encoded=JSON.stringify(value);
      if(force||encoded!==lastSummary){await host.updateModelContext(value);if(disposed)return;lastSummary=encoded;feedback(ids.length?`已向模型更新 ${ids.length} 条已保存信号的身份与简明游标上下文。`:'当前未选曲线；模型上下文已清空。');}
    }catch(error){syncBlocked=true;throw error;}finally{syncing=false;if(needsSync&&!syncBlocked){needsSync=false;scheduleSync();}}
  }
  async function restoreSelection({replace=false}={}){
    const v=adapter.view,sel=v.selection;
    if(!sel||sel.kind!=='signals'||sel.verification!=='saved-signal-catalog'){if(sel===null)lastSelection='[]';if(replace&&sel===null){for(const b of section.querySelectorAll('.wf-trace button[aria-label]'))b.click();lastSelection='[]';}return;}
    const key=JSON.stringify([sel.source_commit,sel.run_id,sel.signal_ids]);if(restoreKey===key)return;
    if(sel.source_commit!==v.identity.source_commit||sel.run_id!==v.identity.run_id)throw Error('已保存的选择来自其他源或运行。');
    const ids=[...new Set(sel.signal_ids||[])];if(ids.length>16||ids.some(id=>!adapter.catalog?.signals.some(s=>s.id===id&&s.status==='available')))throw Error('已保存选择超出此运行可读信号目录。');
    restoreKey=key;lastSelection=JSON.stringify(ids);
    if(replace){for(const trace of section.querySelectorAll('.wf-trace')){const id=trace.dataset.trace?.replace(/:1$/, '');if(!ids.includes(id))trace.querySelector('button[aria-label]')?.click();}}
    // Reuse the shared panel's existing catalog actions; no schematic selection or event is fabricated.
    for(const id of ids){if(panel.snapshot().signals.some(s=>s.id===id))continue;const button=[...section.querySelectorAll('.wf-list button')].find(b=>b.dataset.signalId===id);button?.click();}
  }
  const observer=new MutationObserver(()=>scheduleSync());observer.observe(section,{childList:true,subtree:true,characterData:true});
  async function load({refresh=false}={}){
    initializing=true;dataError=null;syncBlocked=false;clearTimeout(syncTimer);$('.mcp-refresh').disabled=true;$('.mcp-share').disabled=true;
    try{
      if(refresh)await adapter.refresh();if(disposed)return;
      panel?.destroy();adapter.clearData();section.inert=false;restoreKey=null;lastSummary='';
      panel=mountWaveformPanel(section,{contextAdapter,api:adapter.api,managedRun:true,manualSignals:true,followSelection:false,probeAllowed:()=>false});
      await panel.setRun(adapter.view.identity.run_id);if(disposed)return;
      if(!adapter.catalog||panel.snapshot().runId!==adapter.view.identity.run_id)throw dataError||Error('目录读取未完成，请刷新本视图。');
      await adapter.reportLoaded();if(disposed)return;
      if(localState){await restoreLocalState(localState);localState=null;}else await restoreSelection();
      feedback(`目录已读取：${adapter.catalog.signals.filter(s=>s.status==='available').length} 条可显示曲线。选择信号或“绘制已导出波形”。`);
    }catch(error){dataError=error;fail(error);}finally{initializing=false;if(!disposed){$('.mcp-refresh').disabled=false;$('.mcp-share').disabled=false;scheduleSync();}}
  }
  const linkMessage=text=>{if(!disposed)$('.mcp-link-status').textContent=text;};
  function stopFollowing(){clearTimeout(linkTimer);linkTimer=null;if(!disposed)$('.mcp-link-follow').checked=false;}
  function scheduleFollow(){clearTimeout(linkTimer);if(!disposed&&visible&&!closing&&$('.mcp-link-follow').checked)linkTimer=setTimeout(()=>void readLinked(),2000);}
  function clearLinkChoice(){pendingLink=null;$('.mcp-link-choices').replaceChildren();}
  function sourceIn(workspace,source){return workspace.views?.find(v=>v.view_id===source.view_id&&v.kind==='schematic'&&v.revision===source.revision&&JSON.stringify(v.selection)===JSON.stringify(source.selection));}
  async function applyLinked(result){
    const signal=result.signal,ids=[...new Set([...panel.snapshot().signals.map(s=>s.id),signal.id])];
    if(ids.length>16)throw Error('最多16条曲线；请先移除部分曲线。');
    writingSelection=true;
    try{await adapter.select(ids);}finally{writingSelection=false;}
    if(disposed)return;lastSelection=JSON.stringify(ids);restoreKey=null;
    lastLinked={view_id:result.source.view_id,revision:result.source.revision,source_commit:result.source.source_commit,source_sha256:result.source.source_sha256,
      name:result.source.selection.name,kind:result.source.selection.kind,occurrence_path:result.source.selection.occurrence_path,terminal:result.mapping.selector.terminal_name??null,
      signal_id:signal.id,verification:'exact-saved-run-mapping'};
    await restoreSelection();linkMessage(`已核验并添加 ${signal.psf_name} · run ${adapter.view.identity.run_id}`);scheduleSync();
  }
  async function chooseTerminal(item){
    if(linkBusy||!pendingLink||disposed||!visible||closing)return;const prior=pendingLink;linkBusy=true;
    try{
      const workspace=await adapter.workspace();if(disposed||!visible||closing)return;
      const source=sourceIn(workspace,prior.source);if(!source)throw Error('端口选择期间原理图已变化，请重新读取选择。');
      const result=resolveLinkedSelection({source,selection:source.selection,waveView:adapter.view,mapping:adapter.mapping,catalog:adapter.catalog},item.selector.terminal_name);
      if(result.status!=='resolved')throw Error(result.message||'端口映射未能唯一解析。');
      clearLinkChoice();await applyLinked(result);
    }catch(error){clearLinkChoice();stopFollowing();linkMessage(error.message);}
    finally{linkBusy=false;scheduleFollow();}
  }
  async function readLinked(){
    if(disposed||initializing||linkBusy||!visible||closing){scheduleFollow();return;}linkBusy=true;$('.mcp-link-read').disabled=true;
    try{
      const workspace=await adapter.workspace();if(disposed||!visible||closing)return;
      if(pendingLink&&!sourceIn(workspace,pendingLink.source)){clearLinkChoice();linkMessage('原理图选择已变化，待选端口已取消。');}
      const selected=workspaceSelection(workspace,adapter.view);
      if(selected.status==='self')return;
      if(selected.status!=='selected'){clearLinkChoice();linkMessage(selected.message);return;}
      if(selected.key===linkKey)return;linkKey=selected.key;clearLinkChoice();
      const result=resolveLinkedSelection({source:selected.source,selection:selected.selection,waveView:adapter.view,mapping:adapter.mapping,catalog:adapter.catalog});
      if(result.status==='resolved'){await applyLinked(result);return;}
      linkMessage(result.message||'没有唯一可用映射。');
      if(result.status==='terminal_required'){
        pendingLink=selected;
        for(const item of result.choices||[]){
          const terminal=item.selector?.terminal_name;if(!terminal)continue;
          const button=document.createElement('button');button.type='button';button.textContent=`${item.selector.name} · ${terminal} · ${item.polarity||'方向未核验'}`;
          button.onclick=()=>void chooseTerminal(item);$('.mcp-link-choices').append(button);
        }
      }
    }catch(error){stopFollowing();clearLinkChoice();linkMessage(error.message||String(error));}
    finally{linkBusy=false;if(!disposed){$('.mcp-link-read').disabled=false;scheduleFollow();}}
  }
  async function display(){
    if(!host.requestDisplayMode){feedback('当前宿主未提供全屏能力。');return;}
    try{const result=await host.requestDisplayMode('fullscreen');if(disposed)return;if(result?.supported===false){feedback('当前宿主未提供全屏能力；保留现有显示模式。');return;}feedback(`宿主显示模式：${typeof result==='string'?result:result?.mode||result?.displayMode||'以宿主响应为准'}`);}catch(error){fail(error);}
  }
  const click=e=>{
    if(e.target.closest('.mcp-refresh')){linkKey=null;clearLinkChoice();void load({refresh:true});}
    if(e.target.closest('.mcp-link-read')){linkKey=null;void readLinked();}
    if(e.target.closest('.mcp-share'))void synchronize(true).catch(fail);
    if(e.target.closest('.mcp-expand'))void display();
    if(e.target.closest('.wf-legend'))scheduleSync();
  };
  root.addEventListener('click',click);
  const change=e=>{if(e.target.matches('.mcp-link-follow')){if(e.target.checked)void readLinked();else stopFollowing();}};root.addEventListener('change',change);
  function localIdentity(){const v=adapter.view;return {workspace_id:v.workspace_id,view_id:v.view_id,identity:v.identity};}
  async function restoreLocalState(saved){
    const selected=validateWaveformLocalState(saved,localIdentity(),adapter.catalog.signals);
    const click=action=>section.querySelector('[data-action="'+action+'"]')?.click();
    const range=saved.panel?.window;if(Array.isArray(range)&&range.length===2&&range.every(Number.isFinite)&&range[0]<range[1]){section.querySelector('.wf-start').value=range[0];section.querySelector('.wf-end').value=range[1];click('window');}
    const cursors=saved.panel?.cursors;if(cursors&&Number.isFinite(cursors.a)&&Number.isFinite(cursors.b)){section.querySelector('.wf-a').value=cursors.a;section.querySelector('.wf-b').value=cursors.b;click('measure');}
    for(const item of selected){const button=[...section.querySelectorAll('.wf-list button')].find(b=>b.dataset.signalId===item.id);button?.click();}
    for(const item of selected)if(item.visible===false){const trace=[...section.querySelectorAll('.wf-trace')].find(t=>t.dataset.trace===item.id+':1');trace?.querySelector('button[aria-pressed="true"]')?.click();}
    section.querySelector('.wf-search').value=typeof saved.search==='string'?saved.search:'';section.querySelector('.wf-search').dispatchEvent(new Event('input'));
    if(['A','B'].includes(saved.cursorMode))section.querySelector('.wf-cursor-mode').value=saved.cursorMode;
    $('.mcp-link-follow').checked=saved.follow===true;(root.querySelector('.mcp-diagnostics')||root.querySelector('details')).open=saved.detailsOpen===true;
    lastSelection=JSON.stringify(adapter.view.selection?.signal_ids||[]);scheduleFollow();
  }
  function snapshot(){return {schema:'ic.waveforms.local.v1',binding:localIdentity(),panel:panel?.snapshot()||null,
    search:section.querySelector('.wf-search')?.value||'',cursorMode:section.querySelector('.wf-cursor-mode')?.value||'A',follow:$('.mcp-link-follow').checked,detailsOpen:(root.querySelector('.mcp-diagnostics')||root.querySelector('details'))?.open===true};}
  async function beforeClose(){
    if(disposed)return;closing=true;clearTimeout(syncTimer);clearTimeout(linkTimer);
    try{await ready;if(typeof host.saveLocalState!=='function')throw Error('宿主尚未提供视图快照保存；请保持面板打开。');await host.saveLocalState(snapshot());}
    catch(error){closing=false;fail(error);scheduleSync();scheduleFollow();throw error;}
  }
  function resize(){if(disposed||!visible)return;const plot=section.querySelector('.wf-plot');if(plot)plot.dispatchEvent(new Event('resize'));}
  function setVisible(value){if(disposed)return;visible=value===true;root.inert=!visible;
    if(!visible){clearTimeout(syncTimer);clearTimeout(linkTimer);clearLinkChoice();}
    else{if(deferredSelection){deferredSelection=false;void restoreSelection({replace:true}).then(scheduleSync).catch(fail);}scheduleSync();scheduleFollow();resize();}}
  if(host.embedded){const details=root.querySelector('details');details.classList.add('mcp-diagnostics');for(const node of [$('.mcp-identity'),$('.mcp-view-status'),$('.mcp-probe-note')])details.append(node);
    const link=docLinkDetails();$('.mcp-link').before(link);link.append($('.mcp-link'));
  }
  function docLinkDetails(){const details=document.createElement('details');details.className='mcp-link-details';const summary=document.createElement('summary');summary.textContent='节点联动';details.append(summary);return details;}
  const ready=(async()=>{try{localState=await host.loadLocalState?.()||null;}catch(error){fail(error);}if(!disposed)await load();})();
  return {ready,beforeClose,setVisible,resize,dispose(){if(disposed)return;disposed=true;clearTimeout(syncTimer);clearTimeout(linkTimer);observer.disconnect();root.removeEventListener('click',click);root.removeEventListener('change',change);panel?.destroy();adapter.dispose();styleLink?.remove();root.replaceChildren();root.classList.remove('ic-mcp-waveforms','embedded');}};
}
