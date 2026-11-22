import {mountWaveformPanel} from '../../../../modules/waveforms/panel.js';
import {waveformAPI} from '../../waveforms/api.js';

export function projectRuns(jobs,projectId){return jobs.filter(job=>(job.associated_project_id||job.project_id)===projectId);}

export function mount(host,{api=waveformAPI(),labels={}}={}){
  const slot=host.slots.waveforms,root=slot.element;
  const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('../../waveforms/panel.css',import.meta.url);document.head.append(css);
  let mode='none';
  const panel=mountWaveformPanel(root,{contextAdapter:host.context,api,labels,followSelection:false,manualSignals:true,
    probeAllowed:ctx=>slot.isVisible()&&mode!=='none'&&(mode==='voltage'?ctx?.selection?.kind==='net':['instance','terminal'].includes(ctx?.selection?.kind))});
  root.classList.add('wf-minimal');
  const $=selector=>root.querySelector(selector),plot=$('.wf-plot'),body=$('.wf-body'),aside=body.querySelector('aside'),chart=plot.parentElement;
  const storage=document.createElement('div');storage.hidden=true;storage.className='wf-hidden-controls';root.append(storage);
  const listeners=[],dialogs=[];
  const on=(node,event,fn,options)=>{node.addEventListener(event,fn,options);listeners.push(()=>node.removeEventListener(event,fn,options));};
  function dialog(title,kind){
    const d=document.createElement('dialog');d.className='wf-dialog wf-dialog-'+kind;d.setAttribute('aria-label',title);
    const head=document.createElement('header'),label=document.createElement('strong'),close=document.createElement('button');label.textContent=title;close.textContent='×';close.type='button';close.setAttribute('aria-label','关闭'+title);close.onclick=()=>d.close();head.append(label,close);d.append(head);root.append(d);dialogs.push(d);
    d.addEventListener('close',()=>plot.focus({preventScroll:true}));d.addEventListener('keydown',e=>e.stopPropagation());return d;
  }
  const signals=dialog('添加信号','signals');
  for(const node of [...aside.children])signals.append(node);
  const details=dialog('波形测量与数据','details');
  for(const selector of ['.wf-provenance','.wf-banner','.wf-cursors','.wf-data-note','.wf-status','.wf-choices','.wf-proposal'])details.append($(selector));
  for(const toolbar of [...chart.querySelectorAll('.wf-toolbar')])details.append(toolbar);
  // Only the selected trace list and a full-size canvas remain in the panel.
  const runs=dialog('打开已有运行','runs');
  const runSelect=document.createElement('select');runSelect.className='wf-run-picker';runSelect.size=8;runSelect.setAttribute('aria-label','当前项目的已有运行');
  const runInfo=document.createElement('p');runInfo.setAttribute('role','status');
  const runActions=document.createElement('div');runActions.className='wf-run-actions';
  const refresh=document.createElement('button');refresh.type='button';refresh.textContent='刷新列表';
  const open=document.createElement('button');open.type='button';open.textContent='打开';
  runActions.append(refresh,open);runs.append(runInfo,runSelect,runActions);
  let runRequest=0,opening=false;
  async function listRuns(){
    const ticket=++runRequest,project=host.context.getContext()?.project?.id;
    runInfo.textContent='读取已有运行…';runSelect.disabled=open.disabled=refresh.disabled=true;
    try{await host.refresh({runs:true});if(ticket!==runRequest||project!==host.context.getContext()?.project?.id)return;
      const jobs=projectRuns(host.getRuns(),project),current=host.context.getContext()?.run?.runId;
      runSelect.replaceChildren(...jobs.map(job=>{const id=job.run_id||job.job_id||job.id;return new Option(`${job.configuration||job.configuration_id||'运行'} · ${id} · ${job.state||'已有记录'}`,id);}));
      runSelect.value=jobs.some(job=>(job.run_id||job.job_id||job.id)===current)?current:'';
      runInfo.textContent=jobs.length?`${project} · ${jobs.length} 个已有运行`:'当前项目还没有运行记录。';
    }catch(error){runInfo.textContent='读取失败：'+error.message;runSelect.replaceChildren();}
    finally{if(ticket===runRequest){runSelect.disabled=refresh.disabled=false;open.disabled=!runSelect.value;}}
  }
  async function openRun(){
    if(opening||!runSelect.value)return;opening=true;open.disabled=refresh.disabled=runSelect.disabled=true;
    try{const id=runSelect.value;await host.selectRun(id);if(lastRun!==id){lastRun=id;runLoading=panel.setRun(id);}await runLoading;
      if(host.context.getContext()?.run?.runId!==id)throw Error('运行选择已变化，请重新打开。');
      if(runs.open)runs.close();plot.focus();const addAll=$('[data-action=add-all]');if(!addAll.disabled)addAll.click();
    }catch(error){runInfo.textContent=error.message;}finally{opening=false;open.disabled=!runSelect.value;refresh.disabled=runSelect.disabled=false;}
  }
  refresh.onclick=()=>void listRuns();open.onclick=()=>void openRun();runSelect.onchange=()=>{open.disabled=!runSelect.value;};runSelect.ondblclick=()=>void openRun();
  on(runSelect,'keydown',event=>{if(event.key==='Enter'){event.preventDefault();void openRun();}});
  const runButton=document.createElement('button');runButton.type='button';runButton.className='wf-open-run';runButton.textContent='打开运行…';runButton.title='打开已有运行 (O)';runButton.onclick=()=>{show(runs);void listRuns();};aside.append(runButton);
  aside.append($('.wf-legend'));
  const add=document.createElement('button');add.type='button';add.className='wf-add-signals';add.textContent='+ 添加信号';add.title='添加信号 (L)';add.onclick=()=>show(signals);aside.append(add);
  chart.classList.add('wf-chart');
  for(const node of [...chart.children])if(node!==plot)storage.append(node);
  if($('.wf-top'))storage.append($('.wf-top'));
  const help=dialog('波形快捷键','help');
  const keys=[['O','打开已有运行'],['F','适配全部时间范围'],['Z → 拖选','放大选定时间段'],['Shift+Z / −','缩小'],['+ / 滚轮','缩放'],['← / → / 拖动','平移'],['A / B → 点击','放置 A / B 游标'],['L','添加或搜索信号'],['M','查看测量值与数据详情'],['Delete','移除焦点所在信号'],['Esc','退出拖选 / 关闭对话框'],['?','快捷键帮助']];
  const table=document.createElement('table');for(const [key,description] of keys){const row=table.insertRow();row.insertCell().textContent=key;row.insertCell().textContent=description;}help.append(table);
  function show(d){if(!slot.isVisible())slot.setVisible(true);for(const other of dialogs)if(other.open&&other!==d)other.close();if(!d.open)d.showModal();if(d===signals)$('.wf-search').focus();}
  // Successful operations stay quiet. Read failures are reported in the shared status line.
  let lastError='';const statusObserver=new MutationObserver(()=>{const text=$('.wf-status').textContent;if(/失败|需有限|未提取|没有|未保存|过期|变化/.test(text)&&text!==lastError){lastError=text;host.notify(text,{kind:'warning'});}});
  statusObserver.observe($('.wf-status'),{childList:true,characterData:true,subtree:true});
  // A current probe can require an explicit terminal choice; do not hide that prompt.
  const choiceObserver=new MutationObserver(()=>{if(mode!=='none'&&slot.isVisible()&&$('.wf-choices button'))show(details);});
  choiceObserver.observe($('.wf-choices'),{childList:true});
  const metadata=()=>{const ctx=host.context.getContext(),id=ctx?.run?.runId;root.title=`${id||'未选择运行'} · M 查看运行与测量详情 · ? 快捷键`;runButton.textContent=id?'切换运行…':'打开运行…';runButton.title=`${id||'打开已有运行'} (O)`;};
  let lastRun='',runLoading=Promise.resolve();
  const unsubscribe=host.context.subscribe(ctx=>{metadata();const id=ctx?.run?.runId||'';if(id!==lastRun){lastRun=id;runLoading=panel.setRun(id);}});
  const current=host.context.getContext()?.run?.runId;if(current){lastRun=current;runLoading=panel.setRun(current);}metadata();
  function key(e){
    // A waveform keystroke must not reach the schematic's document-level bindings.
    e.stopPropagation();
    if(e.defaultPrevented||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||e.target.closest('input,textarea,select,[contenteditable=true]'))return;
    const k=e.key.toLowerCase(),click=action=>$(`[data-action="${action}"]`).click();
    if(k==='o'){e.preventDefault();show(runs);void listRuns();}
    else if(k==='l'){e.preventDefault();show(signals);}
    else if(k==='m'){e.preventDefault();show(details);}
    else if(k==='?'){e.preventDefault();show(help);}
    else if(k==='a'||k==='b'){e.preventDefault();$('.wf-cursor-mode').value=k.toUpperCase();panel.setInteraction('pan');plot.focus();host.notify(`点击波形放置 ${k.toUpperCase()} 游标`);}
    else if(k==='z'){e.preventDefault();if(e.shiftKey)click('zoom-out');else{panel.setInteraction('zoom');plot.focus();host.notify('拖选时间段放大 · Esc 退出');}}
    else if(k==='escape'){e.preventDefault();panel.setInteraction('pan');plot.focus();}
    else if(k==='delete'||k==='backspace'){const trace=e.target.closest('.wf-trace');if(trace){e.preventDefault();trace.querySelector('button[aria-label]').click();}}
    else if(k==='f'){e.preventDefault();click('fit');}
    else if(k==='+'||k==='='){e.preventDefault();click('zoom-in');}
    else if(k==='-'){e.preventDefault();click('zoom-out');}
  }
  on(root,'keydown',key);
  on(plot,'contextmenu',e=>{e.preventDefault();show(help);});
  plot.title='O 运行 · F 适配 · Z 拖选放大 · A/B 游标 · L 信号 · M 测量 · ? 帮助';
  const unregister=[
    host.registerCommand({id:'window.waveforms.dock',menu:'window',label:'波形面板',run:()=>slot.setVisible(true)}),
    host.registerCommand({id:'plot.run',menu:'plot',label:'打开已有运行 (O)',run:()=>{show(runs);void listRuns();}}),
    host.registerCommand({id:'plot.signals',menu:'plot',label:'添加信号 (L)',run:()=>show(signals)}),
    host.registerCommand({id:'plot.measurements',menu:'plot',label:'波形测量 (M)',run:()=>show(details)}),
    host.registerCommand({id:'plot.shortcuts',menu:'plot',label:'波形快捷键 (?)',run:()=>show(help)})
  ];
  let destroyed=false;
  const controller={setPlotMode(value){mode=value;},openWindow(){slot.setVisible(true);plot.focus();return {opened:true};},onSelection(ctx){void panel.probe(ctx);},destroy(){if(destroyed)return;destroyed=true;unsubscribe();statusObserver.disconnect();choiceObserver.disconnect();listeners.forEach(fn=>fn());unregister.forEach(fn=>fn?.());for(const d of dialogs){if(d.open)d.close();d.remove();}panel.destroy();css.remove();}};
  const detach=host.plot.attach(controller);
  return {controller,destroy(){detach?.();}};
}
