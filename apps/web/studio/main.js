import {createAgentAssistance} from '../ai/assistance.js';
import {Gateway} from '../api.js';
import {sha256,lineRange} from '../core.js';
import {createWorkbenchContext} from '../context/workbench.js';
import {normalizeNative,entryStatus,sourceSelection,viewerSourcePath,localURL} from '../native-viewer/model.js';
import {checkManifest} from '../vendor/rnl-viewer/manifest.js';
import {sourceFromManifestJson} from '../vendor/rnl-viewer/shells/web.js';
import {openSource as openNativeSource,currentSource} from '../vendor/rnl-viewer/open.js';
import {doc,current,selected,path as visitPath,setDoc} from '../vendor/rnl-viewer/state.js';
import {selectionMetadata} from '../vendor/rnl-viewer/ic-context-metadata.js';
import {enterRoot} from '../vendor/rnl-viewer/subcircuits.js';
import {registerStudioCommand,command} from '../vendor/rnl-viewer/commands.js';
import {setSidebarWidth,setPane} from '../vendor/rnl-viewer/panels.js';
import {clearSelection} from '../vendor/rnl-viewer/selection.js';
import {clearDrawing,fit} from '../vendor/rnl-viewer/drawing.js';
import {clearSource} from '../vendor/rnl-viewer/text.js';
import {renderHierarchy} from '../vendor/rnl-viewer/hierarchy.js';
import {createLayout} from './layout.js';
import {mountWorkspaceHub} from './workspace-hub.js';
import {whenVisible} from './lazy-slot.js';
import {createCommitMessage} from '../../../modules/workspace/commit-message.js';
import {createOnboardingBridge,snapshotOnboardingSource} from '../remote/onboarding-bridge.js';
import {createOnboardingSync} from '../remote/onboarding-sync.js';
import {hasBuffer,fileText} from '../vendor/rnl-viewer/edits.js';

const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const clone=v=>v==null?null:freeze(structuredClone(v));
const projectId=p=>p?.project_id||p?.id;
const runId=j=>j?.run_id||j?.job_id||j?.id;
const $=id=>document.getElementById(id);

export async function mountStudio({ui:providedUI}={}){
  if(window.ICRNLStudio)return window.ICRNLStudio;
  const ui=providedUI||await createLayout(),api=new Gateway();
  const agentAssistance=createAgentAssistance({slot:ui.slots.ai,notify:ui.notify});
  const healthReady=api.health().catch(error=>({error}));
  const state={mode:'connecting',project:null,active:null,file:null,files:[],baseline:'',dirty:false,jobs:[],job:null,projectLoadState:'idle',nativeFiles:[]};
  let text='',contextSelection=null,nativePayload=null,nativeState=null,nativeModel=null,nativeEntry=null,manifest=null;
  let epoch=0,entryEpoch=0,runEpoch=0,editEpoch=0,nativeLoading=false,nativeError='',nativeQueue=Promise.resolve(),sourceDialog=null,plotController=null,lazyPlot=null,addonsReady=Promise.resolve(),plotMode='none',pendingPreview=null;
  let legacyWaveformMount=null,onboardingWaveformMount=null,waveformSwitch=0;
  const contextOwner=createWorkbenchContext(()=>({state,text,selection:contextSelection,nativeState,nativePayload,nativeFiles:state.nativeFiles,historicalSnapshotVisible:!!nativeState?.stale&&$('studio-history').checked}));
  Object.defineProperty(window,'ICWorkbenchContext',{value:contextOwner.api,writable:false,configurable:false});
  const refreshContext=()=>contextOwner.update();
  const notify=(message,options)=>ui.notify(message,options);
  function safeAction(fn){try{const result=fn();if(result?.catch)result.catch(error=>notify(error.message,{kind:'error'}));return result;}catch(error){notify(error.message,{kind:'error'});}}
  function register(item){if(!/^[a-z][\w.-]+$/.test(item.id))throw Error('Invalid command id');return registerStudioCommand({...item,run:()=>safeAction(item.run)});}
  const controls=()=>{
    $('studio-project').disabled=state.dirty||!state.project?.projects?.length;
    $('studio-entry').disabled=!$('studio-entry').options.length;
    $('studio-run').disabled=!state.jobs.length;
    $('studio-identity').textContent=state.mode==='live'?`${state.project?.branch||''} · ${(state.project?.source_commit||'').slice(0,8)}`:state.mode;
    $('studio-source-button').disabled=!state.file;
    document.body.dataset.studioState=state.projectLoadState;
    refreshContext();
  };
  const identity=()=>clone(state.project?{...state.project,activeProjectId:projectId(state.active)}:null);
  function publishNative(){
    if(nativeLoading||nativeError){nativeState=null;contextSelection=null;$('studio-native-note').textContent=nativeError?'原生图加载失败：'+nativeError:'正在读取固定版本的原生图…';$('studio-native-note').title=nativeError;$('studio-history-label').hidden=true;ui.setNativeState({loading:nativeLoading,hidden:!nativeLoading});refreshContext();return;}
    if(nativeModel&&nativeEntry){nativeState={...entryStatus(nativeModel,nativeEntry,state.file?.currentHash,{dirty:state.dirty}),entry:nativeEntry.id,displayedLevel:doc?.levels[current]?.title||null,files:manifest?.files||[]};}
    const n=nativeState;const rootPath=manifest?`/${manifest.id}/${manifest.entry}`:null;const foreign=doc&&rootPath&&doc.path!==rootPath;if(foreign){nativeState=null;contextSelection=null;refreshContext();$('studio-native-note').textContent='Viewer 本地文档 · 未绑定 canonical 源或仿真结果';ui.setNativeState({loading:false,hidden:false});return;}
    const liveSync=n?.layoutSync;
    const liveLabel=liveSync?`实时 RNL 原理图 · 保留 ${liveSync.preserved_instances?.length||0}/${(liveSync.preserved_instances?.length||0)+(liveSync.added_instances?.length||0)} 元件布局`:'实时 RNL 原理图';
    const label=n?.snapshotOnly?'独立库 / 符号快照 · 无 canonical 映射':n?.stale?'电气源已变化 · 原理图历史快照':n?.mode==='live-rnl'?liveLabel:n?'原生 Virtuoso · '+(n.fidelity||'partial'):'无可同步的原生图';
    $('studio-native-note').textContent=label+(contextSelection?` · ${contextSelection.kind} ${contextSelection.name}${contextSelection.canonical?' → L'+contextSelection.line_start:''}`:'');
    $('studio-native-note').title=n?JSON.stringify({bundle:n.bundleCommit,source:n.sourceCommit,source_sha256:n.boundSourceHash,entry:n.entry,coverage:n.coverage,losses:n.losses},null,2):label;
    $('studio-history-label').hidden=!n?.stale;
    ui.setNativeState({loading:nativeLoading,hidden:!n||(n.stale&&!$('studio-history').checked)});
    refreshContext();
  }
  function invalidateProject(id){
    ++epoch;++entryEpoch;++runEpoch;++editEpoch;pendingPreview=null;nativeLoading=false;nativeError='';
    state.active=state.project?.projects?.find(p=>projectId(p)===id)||null;
    Object.assign(state,{projectLoadState:'loading',file:null,files:[],baseline:'',dirty:false,nativeFiles:[],job:null,jobs:[]});
    text='';contextSelection=null;nativePayload=null;nativeState=null;nativeModel=null;nativeEntry=null;manifest=null;
    if(sourceDialog){sourceDialog.close();sourceDialog.remove();sourceDialog=null;}
    $('studio-entry').replaceChildren();$('studio-run').replaceChildren(new Option('未选择运行',''));$('studio-history').checked=false;
    setPlotMode('none');refreshContext();publishNative();controls();
    if(!document.body.classList.contains('busy')){clearSelection();setDoc(null);clearDrawing('正在加载新项目');clearSource('正在加载新项目');renderHierarchy();}
  }
  async function loadProject(id=projectId(state.active),{preserveDraft=false}={}){
    if(state.dirty&&!preserveDraft)throw Error('请先提交或放弃当前 canonical 草稿。');
    invalidateProject(id);const generation=epoch;
    try{
      const project=await api.project();if(generation!==epoch)return;
      if(!Array.isArray(project.projects))throw Error('工程目录响应缺少项目列表。');
      if(!project.projects.length){
        state.project=project;state.active=null;state.projectLoadState='ready';
        $('studio-project').replaceChildren(new Option('导入网表后开始',''));
        $('studio-project').disabled=true;
        clearDrawing('尚未导入电路；在 Simulation 导入网表并配置服务器与 PDK。');
        publishNative();controls();return;
      }
      state.project=project;state.active=project.projects.find(p=>projectId(p)===id)||project.projects.find(p=>projectId(p)===project.active_project)||project.projects[0];
      $('studio-project').replaceChildren(...project.projects.map(p=>new Option(p.name||projectId(p),projectId(p))));$('studio-project').value=projectId(state.active);
      refreshContext();
      void Promise.allSettled([
        api.files(projectId(state.active)).then(tree=>{if(generation===epoch)state.files=Array.isArray(tree)?tree:tree.files||tree.entries||[];}),
        refreshRuns(),
      ]).then(results=>{if(generation===epoch)for(const result of results)if(result.status==='rejected')notify('项目附加数据读取失败：'+result.reason.message,{kind:'warning'});});
      const source=state.active.source_path||state.active.canonical_source;await loadCanonical(source,generation);if(generation!==epoch)return;
      controls();
    }catch(error){if(generation!==epoch)return;state.projectLoadState='error';controls();publishNative();throw error;}
  }
  async function loadCanonical(path,generation=epoch){
    const file=await api.file(path);if(generation!==epoch)return;
    if(file.path&&file.path!==path)throw Error('Source response path mismatch');
    if(typeof file.content!=='string')throw Error('Source response lacks text');
    const hash=await sha256(file.content);if(generation!==epoch)return;if(file.sha256&&hash!==file.sha256)throw Error('Canonical source SHA256 mismatch');
    state.file={...file,path,currentHash:hash};text=file.content;state.baseline=text;state.dirty=false;state.projectLoadState='ready';contextSelection=null;controls();
    nativePayload=null;nativeModel=null;nativeState=null;manifest=null;state.nativeFiles=[];
    if(!path.endsWith('.scs')){publishNative();return;}
    const payload=await api.schematic(projectId(state.active),path,hash);if(generation!==epoch)return;
    let activePayload=payload;
    if(payload.geometry?.mode!=='native'||!payload.geometry?.available||payload.geometry?.stale){
      try{
        const live=await api.liveSchematic(projectId(state.active),path,hash);if(generation!==epoch)return;
        if(live?.geometry?.mode==='live-rnl'&&live.geometry.available)activePayload=live;
      }catch{}
    }
    if(!['native','live-rnl'].includes(activePayload.geometry?.mode)||!activePayload.geometry?.available){publishNative();return;}
    nativePayload=activePayload;nativeModel=normalizeNative(activePayload,location.href);
    $('studio-entry').replaceChildren(...nativeModel.entries.map(e=>new Option(e.label?.startsWith(e.export_namespace+':')?e.label:e.export_namespace?`${e.export_namespace}: ${e.label}`:e.label,e.id)));
    try{await loadEntry(nativeModel.defaultEntry.id);}catch(error){notify('原理图加载提示：'+error.message,{kind:'warning'});}
  }
  async function loadEntry(id){
    if(!nativeModel)return;const revision=++entryEpoch,generation=epoch,model=nativeModel;
    const entry=model.entries.find(e=>e.id===id);if(!entry)throw Error('Native entry absent');
    nativeEntry=entry;manifest=null;state.nativeFiles=[];contextSelection=null;nativeLoading=true;nativeError='';$('studio-entry').value=id;publishNative();
    try{
    const response=await fetch(entry.manifest,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Native manifest HTTP '+response.status);
    const raw=await response.json();const checked=checkManifest(raw);for(const file of checked.files)localURL(file.url||new URL(file.path,checked.base).href,location.href);
    if(checked.settings.autoInclude!==false)throw Error('Native closure must disable automatic include');
    if(revision!==entryEpoch||generation!==epoch)return;
    // Full Viewer builds remain serialized, while context epochs reject obsolete results.
    const operation=async()=>{
      if(revision!==entryEpoch||generation!==epoch)return;
      const source=sourceFromManifestJson(raw,entry.label);await openNativeSource(source,false);
      if(revision!==entryEpoch||generation!==epoch)return;
      if(!doc||doc.failed||doc.diagnostics.some(d=>d.severity==='error'))throw Error('Native Viewer could not read the pinned closure');
      const level=entry.level==='@top'?0:doc.levels.findIndex(l=>l.title===entry.level);if(level<0)throw Error('Native entry level absent');
      await enterRoot(level,{here:true,newWindow:false});
      if(revision!==entryEpoch||generation!==epoch)return;
      manifest=checked;state.nativeFiles=checked.files;nativeLoading=false;fit();publishNative();notify('视图入口已加载：'+entry.label);
    };
    nativeQueue=nativeQueue.catch(()=>{}).then(operation);
    await nativeQueue;
    }catch(error){if(revision!==entryEpoch||generation!==epoch)return;nativeLoading=false;nativeError=error.message;nativeState=null;manifest=null;state.nativeFiles=[];contextSelection=null;publishNative();throw error;}
  }
  async function refreshRuns(){const generation=epoch;const result=await api.jobs();if(generation!==epoch)return;state.jobs=Array.isArray(result)?result:result.jobs||[];$('studio-run').replaceChildren(new Option('未选择运行',''),...state.jobs.map(j=>new Option(`${j.configuration||j.configuration_id||j.project_id||''} · ${runId(j)}`,runId(j))));$('studio-run').value=runId(state.job)||'';$('studio-run').disabled=!state.jobs.length;refreshContext();}
  async function selectRun(id){
    const generation=epoch,revision=++runEpoch,request=++waveformSwitch;
    const current=()=>generation===epoch&&revision===runEpoch&&request===waveformSwitch;
    if(onboardingWaveformMount&&await restoreProjectWaveforms(request)===false)return;
    if(!current())return;
    state.job=null;refreshContext();if(!id){$('studio-run').value='';return;}
    let job=state.jobs.find(j=>runId(j)===id);
    if(!job){await refreshRuns();job=state.jobs.find(j=>runId(j)===id);}
    if(!current())return;if(!job)throw Error('运行不在已登记列表中。');
    const associated=job.associated_project_id||job.project_id;if(associated!==projectId(state.active))throw Error('该运行不属于当前项目。');
    state.job=job;$('studio-run').value=runId(job);refreshContext();
  }

  function setPlotMode(mode){if(!['none','voltage','current'].includes(mode))throw Error('Unknown plot mode');plotMode=mode;document.body.dataset.studioPlot=mode;$('studio-plot-state').hidden=mode==='none';$('studio-plot-state').textContent=mode==='voltage'?'Plot · 电压 · Esc退出':mode==='current'?'Plot · 电流 · Esc退出':'';plotController?.setPlotMode(mode);onboardingWaveformMount?.controller?.setPlotMode?.(mode);$('studio-message').dataset.plot=mode;if(mode!=='none')notify(mode==='voltage'?'电压探针：在原图选择节点；Esc 退出。':'电流探针：选择器件，再明确端口；Esc 退出。');}
  function openPlot(){if(onboardingWaveformMount)return onboardingWaveformMount.controller.openWindow();if(!plotController&&ui.slots.waveforms){ui.slots.waveforms.setVisible(true);void addonsReady.then(()=>lazyPlot?.ensure()).then(()=>{if(!plotController)throw Error('波形组件尚未加载');plotController.openWindow();if(plotMode!=='none')plotController.onSelection(contextOwner.api.getContext());}).catch(error=>notify(error.message,{kind:'error'}));return {opened:true,pending:true};}if(!plotController){notify('Plot 组件尚未安装。',{kind:'warning'});return {opened:false,reason:'Plot component unavailable'};}const result=plotController.openWindow();if(!result?.opened)notify(result?.reason||'浏览器阻止了波形窗口；请允许弹窗后重试。',{kind:'warning'});return result;}
  const plot=Object.freeze({attach(controller){if(plotController)throw Error('Only one Plot controller may attach');plotController=controller;controller.setPlotMode(plotMode);return ()=>{if(plotController===controller){setPlotMode('none');plotController=null;controller.destroy?.();}};},setMode:setPlotMode,getMode:()=>plotMode,openWindow:openPlot});
  const onboarding=createOnboardingBridge({gateway:api,win:window});
  async function openOnboardingWaveforms(payload){
    const request=++waveformSwitch,sourceEpoch=epoch;
    const current=()=>request===waveformSwitch&&sourceEpoch===epoch;
    const module=await import('../remote/onboarding-waveforms.js');
    const scopedHost={...host,async prepareOnboardingWaveformSlot(){
      await addonsReady;await lazyPlot?.ensure();
      if(!current())throw Error('窗口或电路已变化；未替换波形。');
      setPlotMode('none');legacyWaveformMount?.destroy();legacyWaveformMount=null;
      onboardingWaveformMount?.destroy();onboardingWaveformMount=null;
    }};
    const next=await module.openOnboardingWaveforms(scopedHost,payload);
    if(!current()){next.destroy();throw Error('窗口或电路已变化；请重新选择原运行。');}
    onboardingWaveformMount=next;return next;
  }
  async function restoreProjectWaveforms(request=++waveformSwitch){
    await addonsReady;await lazyPlot?.ensure();
    if(request!==waveformSwitch)return false;
    onboardingWaveformMount?.destroy();onboardingWaveformMount=null;
    if(!legacyWaveformMount){
      const module=await import('./dockview/waveforms.js');
      if(request!==waveformSwitch)return false;
      legacyWaveformMount=module.mount(host);
    }
    ui.slots.waveforms.setVisible(true);return true;
  }
  const getOnboardingSource=()=>snapshotOnboardingSource(doc,{hasBuffer,fileText});
  const onboardingSync=createOnboardingSync({bridge:onboarding,getSource:getOnboardingSource,openWaveforms:ui.slots.waveforms?openOnboardingWaveforms:undefined});
  const getSimulationMode=()=>!state.active?.configurations?.length||!!doc&&(!manifest||!doc.path.startsWith('/'+manifest.id+'/'))?'environment':'project';
  const host=Object.freeze({version:1,agentAssistance,requestAgentAssistance:request=>agentAssistance.request(request),context:contextOwner.api,gateway:api,slots:ui.slots,registerCommand:register,notify,plot,onboarding,onboardingSync,getSimulationMode,
    ...(ui.slots.waveforms?{openOnboardingWaveforms}:{}),getOnboardingSource,getProject:identity,getRuns:()=>clone(state.jobs),selectRun,openSource:openCanonicalEditor,createCommitMessage:options=>createCommitMessage({gateway:api,...options}),versioning:Object.freeze({sync:syncRepository}),async refresh({project=false,runs=false}={}){if(project)await loadProject();if(runs)await refreshRuns();}});
  let healthCaps=null;
  const workspaceHub=mountWorkspaceHub({
    toolbar:$('studio-toolbar'),
    mode:'live',
    getStatus:()=>({
      ai:Boolean(healthCaps?.ai),
      simulation:healthCaps?.simulation_onboarding!==false,
      library:healthCaps?.git!==false,
      detail:state.project?.branch?`当前分支：${state.project.branch} · ${(state.project.source_commit||'').slice(0,8)}`:'',
    }),
    onOpenConnections:()=>{try{command('help.agent-connections');}catch(error){notify(error.message,{kind:'warning'});}},
    onOpenSimulation:()=>{ui.slots.simulation.setVisible(true);},
    onOpenAI:()=>{ui.slots.ai.setVisible(true);},
  });
  window.addEventListener('pagehide',()=>{workspaceHub.destroy();agentAssistance.destroy();onboardingSync.destroy();onboarding.disconnect();},{once:true});
  Object.defineProperty(window,'ICRNLStudio',{value:host,writable:false});
  register({id:'project.choose',menu:'project',label:'选择项目…',run:()=>$('studio-project').focus()});
  register({id:'project.source',menu:'project',label:'查看 / 编辑源码…',run:()=>openCanonicalEditor(),enabled:()=>!!state.file});
  register({id:'project.refresh',menu:'project',label:'刷新项目与入口',run:()=>loadProject(),enabled:()=>!state.dirty});
  register({id:'git.source',menu:'git',label:'编辑 / 审阅源码…',run:()=>openCanonicalEditor(),enabled:()=>!!state.file});
  register({id:'git.sync',menu:'git',label:'拉取仓库更新…',run:syncRepository,enabled:()=>!state.dirty&&state.mode==='live'});
  register({id:'git.identity',menu:'git',label:'查看版本与保真范围…',run:()=>showProvenance()});
  register({id:'simulation.panel',menu:'simulation',label:'配置与运行面板',run:()=>ui.slots.simulation.setVisible(true)});
  register({id:'window.simulation',menu:'window',label:'Simulation 面板',run:ui.slots.simulation.toggle,checked:ui.slots.simulation.isVisible});
  register({id:'window.plot',menu:'window',label:'波形窗口：打开 / 聚焦',run:openPlot});
  register({id:'window.reset',menu:'window',label:'恢复默认布局',run:()=>{if(ui.resetLayout){ui.resetLayout();return;}document.body.style.removeProperty('--studio-right-width');document.body.style.removeProperty('--studio-ai-height');$('studio-sim-split').removeAttribute('aria-valuenow');$('studio-ai-split').removeAttribute('aria-valuenow');setSidebarWidth(300);ui.slots.simulation.setVisible(true);ui.slots.ai.setVisible(true);notify('已恢复默认面板尺寸并显示仿真与 AI。');}});
  for(const [mode,label] of [['voltage','电压探针'],['current','电流探针']])register({id:'plot.'+mode,menu:'plot',label,run:async()=>{
    if(onboardingWaveformMount){
      const status=onboardingWaveformMount.probeStatus?.();
      if(status?.ok){const result=openPlot();setPlotMode(mode);if(!result.opened)notify(result.reason||'波形窗口未打开。',{kind:'warning'});return;}
      notify((status?.reason||'当前原理图与远端仿真源版本不一致，无法开启探针。')+' 仍可从信号列表查看曲线，或点“返回项目波形”。',{kind:'warning'});
      return;
    }
    if(ui.slots.waveforms&&await restoreProjectWaveforms()===false)return;
    const result=openPlot();setPlotMode(mode);if(!result.opened)notify(result.reason||'波形窗口未打开；探针模式已启用，待选信号会保留。',{kind:'warning'});
  },checked:()=>plotMode===mode});
  if(ui.slots.waveforms)register({id:'plot.project',menu:'plot',label:'返回项目波形',run:restoreProjectWaveforms});
  register({id:'plot.exit',menu:'plot',label:'退出探针 (Esc)',run:()=>setPlotMode('none'),enabled:()=>plotMode!=='none'});
  register({id:'plot.open',menu:'plot',label:'打开波形窗口',run:openPlot});
  $('studio-source-button').onclick=()=>safeAction(()=>openCanonicalEditor());
  $('studio-project').onchange=()=>safeAction(()=>loadProject($('studio-project').value));
  $('studio-entry').onchange=()=>safeAction(()=>loadEntry($('studio-entry').value));
  $('studio-run').onchange=()=>safeAction(()=>selectRun($('studio-run').value));
  $('studio-history').onchange=publishNative;
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&plotMode!=='none'){setPlotMode('none');event.preventDefault();event.stopImmediatePropagation();}},true);
  window.addEventListener('viewer-navigate',()=>{contextSelection=null;refreshContext();});
  window.addEventListener('viewer-level',()=>{if(nativeLoading)return;contextSelection=null;publishNative();});
  window.addEventListener('viewer-selection',()=>{
    if(nativeLoading||!manifest||!nativeModel)return;const o=doc?.objects[selected];
    if(!o||!['instance','net','usage'].includes(o.kind)){contextSelection=null;refreshContext();return;}
    const context=selectionMetadata(doc,visitPath,current,selected,nativeModel.defaultEntry.entrypoint);
    const sourcePath=viewerSourcePath(context?.viewerSourcePath,manifest,doc.path);
    if(!sourcePath){contextSelection=null;nativeState=null;refreshContext();return;}
    const status=entryStatus(nativeModel,nativeEntry,state.file?.currentHash,{dirty:state.dirty});
    const event={kind:o.kind,name:o.name,scope:doc.levels.find(l=>l.host===o.level)?.kind==='file'?'(top)':o.level_title,source_path:sourcePath};
    const metadata=status.snapshotOnly?{...context,viewerSourcePath:sourcePath,occurrencePath:null,occurrenceResolved:false,occurrenceReason:'Independent export has no simulation TB occurrence',occurrenceEvidence:null}:{...context,viewerSourcePath:sourcePath};
    const mapped=status.canonicalMappingEnabled?sourceSelection(nativeModel.mapping,event,state.file?.currentHash,{allowCanonical:status.sourceMatch&&!status.stale}):null;
    contextSelection=mapped?{...mapped,entry_id:nativeEntry.id,context:metadata,export_lines:o.lines}:{...event,entry_id:nativeEntry.id,export_source_path:sourcePath,export_lines:o.lines,context:metadata,readonly:true,reason:'No current canonical mapping'};
    publishNative();if(sourceDialog?.open&&contextSelection.canonical)highlightSource();
    if(plotMode!=='none'){
      if(onboardingWaveformMount?.canProbe?.()){
        const status=onboardingWaveformMount.probeStatus();
        onboardingWaveformMount.probe({kind:o.kind,name:o.name,scope:event.scope,viewerSourcePath:state.file?.path||sourcePath,nativeEntryId:status.entryId,occurrencePath:[],terminalName:null});
      }else plotController?.onSelection(contextOwner.api.getContext());
    }
  });
  window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});

  function highlightSource(){if(!contextSelection?.canonical||!sourceDialog)return;const area=sourceDialog.querySelector('textarea');const [start,end]=lineRange(text,contextSelection.line_start,contextSelection.line_end);area.setSelectionRange(start,end);area.scrollTop=Math.max(0,(contextSelection.line_start-4)*19);}
  async function openCanonicalEditor(path){
    if(!state.file)return;if(path&&path!==state.file.path){if(state.dirty)throw Error('请先提交当前草稿。');await loadCanonical(path);}
    if(sourceDialog){sourceDialog.showModal();highlightSource();return;}
    const dialog=document.createElement('dialog');dialog.className='studio-source-dialog';dialog.id='studio-source-editor';sourceDialog=dialog;
    dialog.innerHTML='<div class="studio-source-head"><strong></strong><button type="button" data-action="close">关闭</button></div><div class="studio-source-state"></div><textarea spellcheck="false" aria-label="Canonical 源码"></textarea><pre class="studio-diff" hidden></pre><section class="studio-commit-message"><label>提交标题<input aria-label="提交标题" maxlength="80" placeholder="预览差异后由 AI 生成，也可以手写"></label><label>更新说明<textarea aria-label="更新说明" rows="3" maxlength="300" placeholder="说明电路或仿真配置发生了什么变化"></textarea></label><p data-role="summary-status" role="status">预览差异后自动生成标题和更新说明。</p></section><label class="studio-source-state"><input type="checkbox" data-action="push" checked> 提交后推送到已配置的私有 GitHub</label><div class="studio-source-state" data-role="save-status" role="status" hidden></div><div class="studio-source-tools"><button type="button" data-action="preview">预览 diff</button><button type="button" data-action="commit" disabled>确认提交并推送</button><button type="button" data-action="discard">放弃草稿</button></div>';
    document.body.append(dialog);dialog.querySelector('strong').textContent=state.file.path;const area=dialog.querySelector('textarea'),info=dialog.querySelector('.studio-source-state'),diff=dialog.querySelector('pre'),commit=dialog.querySelector('[data-action=commit]');area.value=text;area.readOnly=state.file.editable===false||state.mode!=='live';
    const push=dialog.querySelector('[data-action=push]'),messageInput=dialog.querySelector('[aria-label="提交标题"]'),bodyInput=dialog.querySelector('[aria-label="更新说明"]'),summaryStatus=dialog.querySelector('[data-role=summary-status]'),saveStatus=dialog.querySelector('[data-role=save-status]');let saving=false;
    const canCommit=()=>{try{messageDraft.message();return !!pendingPreview&&!saving;}catch{return false;}};
    const messageDraft=createCommitMessage({gateway:api,onChange:s=>{if(messageInput.value!==s.title)messageInput.value=s.title;if(bodyInput.value!==s.body)bodyInput.value=s.body;summaryStatus.textContent=s.status==='running'?'AI（本地默认模型）正在拟写提交说明…':s.status==='complete'?'AI 草稿已生成；请检查，可直接修改。':s.error?'自动摘要失败：'+s.error+' 可手动填写。':'预览差异后自动生成标题和更新说明。';commit.disabled=!canCommit();}});
    messageInput.oninput=()=>messageDraft.setTitle(messageInput.value);bodyInput.oninput=()=>messageDraft.setBody(bodyInput.value);
    dialog.addEventListener('close',()=>messageDraft.freeze());
    push.onchange=()=>{commit.textContent=push.checked?'确认提交并推送':'确认提交（不推送）';};
    const update=()=>{info.textContent=`${state.dirty?'未提交草稿':'网关源文件'} · base ${state.file?.base_commit?.slice(0,12)||'unknown'} · SHA ${(state.file?.currentHash||'计算中').slice(0,12)}；原生导出仍只读。`;};update();
    dialog.querySelector('[data-action=close]').onclick=()=>{if(!saving)dialog.close();};dialog.oncancel=event=>{if(saving)event.preventDefault();};
    area.oninput=()=>{text=area.value;state.dirty=text!==state.baseline;state.file.currentHash=null;contextSelection=null;pendingPreview=null;messageDraft.invalidate();commit.disabled=true;$('studio-history').checked=false;const generation=epoch,revision=++editEpoch;controls();publishNative();update();sha256(text).then(hash=>{if(generation!==epoch||revision!==editEpoch)return;state.file.currentHash=hash;publishNative();update();});};
    dialog.querySelector('[data-action=preview]').onclick=()=>safeAction(async()=>{if(saving)return;const generation=epoch,captured=text;if(!state.dirty)throw Error('没有未提交修改。');const request={base_commit:state.file.base_commit||state.project.source_commit,changes:[{path:state.file.path,content:captured}]};const response=await api.preview(request);if(generation!==epoch||captured!==text||saving)throw Error('预览期间源或提交状态已变化，请重新预览。');diff.hidden=false;diff.textContent=response.diff||response.unified_diff||JSON.stringify(response,null,2);if(response.valid===false||response.blockers?.length)throw Error('网关预览存在阻碍。');pendingPreview={request,epoch,captured};commit.disabled=!canCommit();void messageDraft.prepare({project_id:projectId(state.active),base_commit:request.base_commit,review_id:response.review_id});});
    commit.onclick=()=>safeAction(async()=>{
      if(saving)return;const preview=pendingPreview;if(!preview||preview.epoch!==epoch||preview.captured!==text)throw Error('Diff 已过期，请重新预览。');
      const request={...preview.request,message:messageDraft.message(),push:push.checked};messageDraft.freeze();saving=true;pendingPreview=null;saveStatus.hidden=false;saveStatus.textContent=request.push?'正在提交并推送；请等待网关回执。':'正在提交（不推送）；请等待网关回执。';
      const wasReadonly=area.readOnly;area.readOnly=true;dialog.querySelectorAll('input,button').forEach(e=>e.disabled=true);bodyInput.disabled=true;
      let response;
      try{response=await api.save(request);}catch(error){if(preview.epoch===epoch){saveStatus.textContent=`提交或推送结果未确认，push_status 未返回：${error.message}。本地提交可能已完成；请先核对网关版本及远端状态。草稿已保留，未自动重试。`;notify(saveStatus.textContent,{kind:'error'});}return;}
      finally{saving=false;area.readOnly=wasReadonly;dialog.querySelectorAll('input,button').forEach(e=>e.disabled=false);bodyInput.disabled=false;commit.disabled=true;}
      if(preview.epoch!==epoch)return;state.dirty=false;dialog.close();dialog.remove();sourceDialog=null;
      let refreshError='';try{await loadProject();}catch(error){refreshError=error.message;}
      const status=typeof response.push_status==='string'?response.push_status:'未返回',confirmed=status==='confirmed',notRequested=status==='not_requested'&&!request.push;
      const summary=confirmed?'已推送到已配置的私有 GitHub。':notRequested?'本次未请求推送。':'推送结果未确认成功；请核对网关回执和远端状态，未自动重试。';
      const receipt=document.createElement('dialog');receipt.id='studio-save-receipt';receipt.className='studio-confirm';const heading=document.createElement('strong'),details=document.createElement('p'),close=document.createElement('button');
      heading.textContent='源码提交回执';details.textContent=`commit：${response.source_commit||response.commit||'未返回'}；请求推送：${request.push?'是':'否'}；push_status：${status}。${summary}${refreshError?' 项目重新读取失败：'+refreshError:''}`;close.type='button';close.textContent='关闭';close.onclick=()=>{receipt.close();receipt.remove();};receipt.oncancel=()=>receipt.remove();receipt.append(heading,details,close);document.body.append(receipt);receipt.showModal();notify(details.textContent,{kind:confirmed||notRequested?'info':'warning'});
    });
    dialog.querySelector('[data-action=discard]').onclick=()=>safeAction(async()=>{if(!state.dirty||await confirmAction('放弃草稿','将恢复上一次从网关读取的源码。','放弃')){text=state.baseline;area.value=text;state.dirty=false;state.file.currentHash=await sha256(text);pendingPreview=null;messageDraft.invalidate();commit.disabled=true;diff.hidden=true;controls();publishNative();update();}});
    dialog.showModal();highlightSource();
  }
  async function syncRepository(){
    if(state.dirty)throw Error('请先处理未提交的源码草稿。');
    if(state.mode!=='live')throw Error('请先连接工程网关。');
    if(await confirmAction('拉取仓库更新','检查远端并快进更新工程。仿真配置草稿仍按原版本保留；源码草稿需先处理。','拉取')){await api.sync();await loadProject();}
  }
  function confirmAction(title,message,accept){return new Promise(resolve=>{const d=document.createElement('dialog');d.className='studio-confirm';const h=document.createElement('strong'),p=document.createElement('p'),menu=document.createElement('menu'),cancel=document.createElement('button'),ok=document.createElement('button');h.textContent=title;p.textContent=message;cancel.textContent='取消';ok.textContent=accept;menu.append(cancel,ok);d.append(h,p,menu);document.body.append(d);const done=result=>{d.close();d.remove();resolve(result);};cancel.onclick=()=>done(false);ok.onclick=()=>done(true);d.oncancel=e=>{e.preventDefault();done(false);};d.showModal();});}
  function showProvenance(){const d=document.createElement('dialog');d.className='studio-source-dialog';const p=document.createElement('pre');p.className='studio-diff';p.style.maxHeight='none';p.textContent=JSON.stringify(contextOwner.api.getContext(),null,2);const b=document.createElement('button');b.textContent='关闭';b.onclick=()=>{d.close();d.remove();};d.append(b,p);document.body.append(d);d.showModal();}

  // Project loading must not wait for optional panels or their network requests.
  async function mountAddons(){
    const response=await fetch(new URL('./addons.json',import.meta.url));if(!response.ok)throw Error('扩展目录读取失败');
    const config=await response.json();
    await Promise.all(config.modules.map(async relative=>{
      const url=new URL(relative,import.meta.url);
      if(url.origin!==location.origin||!url.pathname.startsWith(new URL('./',import.meta.url).pathname))throw Error('Addon outside Studio');
      const kind=relative.includes('/simulation/')?'simulation':relative.includes('/ai/')?'ai':relative.includes('/versions/')?'versions':relative.includes('/plot/')&&ui.slots.waveforms?'waveforms':null;
      const placeholders=[];
      const mount=async()=>{
        if((kind==='ai'||relative==='./connection.js')&&(await healthReady).capabilities?.chat===false){
          if(kind==='ai'){
            const message=document.createElement('p');message.setAttribute('role','status');
            message.textContent='当前服务仅提供仿真功能，未启用 AI 对话。';ui.slots.ai.element.replaceChildren(message);
          }
          return {unavailable:true};
        }
        const module=await import(url.href);for(const remove of placeholders.splice(0))remove();
        const value=await module.mount(host);if(kind==='waveforms')legacyWaveformMount=value;return value;
      };
      const onError=error=>{
        notify('扩展加载失败 '+relative+' · '+error.message,{kind:'warning'});
        if(kind){const root=ui.slots[kind].element,message=document.createElement('p'),retry=document.createElement('button');message.textContent='面板加载失败：'+error.message;retry.textContent='重试';retry.onclick=()=>void loader.retry().catch(()=>{});root.replaceChildren(message,retry);}
      };
      let loader;
      if(kind){loader=whenVisible(ui.slots[kind],mount,{onError});if(kind==='ai')agentAssistance.setLoader(()=>loader.ensure());
        // Commands must remain discoverable even when a panel was closed in the saved layout.
        const actions=kind==='waveforms'?[['plot.run','plot','打开已有运行 (O)'],['plot.signals','plot','添加信号 (L)'],['plot.measurements','plot','波形测量 (M)'],['plot.shortcuts','plot','波形快捷键 (?)']]:kind==='versions'?[['git.versions','git','版本管理…'],['window.versions','window','版本管理']]:kind==='ai'?[['ai.toggle','window','AI：显示 / 隐藏对话'],['ai.show','window','AI：聚焦对话输入'],['ai.inspect','window','AI执行详情'],['ai.manage','window','AI：对话管理器…']]:kind==='simulation'?[['simulation.environment','simulation','连接仿真环境…']]:[];
        for(const [id,menu,label] of actions)placeholders.push(register({id,menu,label,run:async()=>{ui.slots[kind].setVisible(true);const value=await loader.ensure();if(!value?.unavailable&&!['window.versions','ai.toggle'].includes(id))command(id);}}));
        if(kind==='waveforms')lazyPlot=loader;
      }else void mount().catch(onError);
    }));
  }
  setSidebarWidth(300);setPane('hierarchy');
  controls();addonsReady=mountAddons();void addonsReady.catch(error=>notify(error.message,{kind:'warning'}));
  try{const health=await healthReady;healthCaps=health?.capabilities||null;workspaceHub.update();if(health.error)throw health.error;if(health.mode!=='live')throw Error('需要实际私有网关 live 模式');state.mode='live';await loadProject();workspaceHub.update();if(state.active)notify('原生图已从固定版本读取。Project/Git 管理 canonical 源；Viewer 网格与导航保持原行为。');}catch(error){state.mode='offline';state.projectLoadState='error';controls();publishNative();workspaceHub.update();notify(error.message,{kind:'error'});}
  return host;
}
