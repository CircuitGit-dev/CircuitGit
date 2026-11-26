import {createAgentAssistance} from '../ai/assistance.js';
import {createLayout} from '../studio/layout.js';
import {mountWorkspaceHub} from '../studio/workspace-hub.js';
import {mountWelcomeGuide} from '../studio/welcome-guide.js';
import {buildImportedRnlSource,createProjectImporter} from '../studio/project-import.js';
import {whenVisible} from '../studio/lazy-slot.js';
import {mountWorkflowLink} from '../studio/workflow-link.js';
import {openSource,showBuilt,adoptSource,isLoading} from '../vendor/rnl-viewer/open.js';
import {doc,current,selected} from '../vendor/rnl-viewer/state.js';
import {dirtyPaths,unappliedPaths,resetBuffers,hasBuffer,fileText} from '../vendor/rnl-viewer/edits.js';
import {shell} from '../vendor/rnl-viewer/shell.js';
import {sourceOpened} from '../vendor/rnl-viewer/pool.js';
import {previewing} from '../vendor/rnl-viewer/solve.js';
import {fit,view} from '../vendor/rnl-viewer/drawing.js';
import {setPane,setSidebar} from '../vendor/rnl-viewer/panels.js';
import {registerStudioCommand} from '../vendor/rnl-viewer/commands.js';
import {setBackground} from '../vendor/rnl-viewer/background.js';
import {sha256} from '../core.js';
import {reference,referenceWindow} from './reference.js';
import {mountLibraryManager} from '../library/panel.js';
import {createLibraryClient,formatLibraryName,formatViewLabel} from '../library/model.js';
import {isVerilogAFile,indexLibraryVerilogAFiles,indexSnapshotVerilogAFiles,resolveVerilogAModel} from '../library/veriloga.js';
import {mountVerilogAPanel,attachSchematicVerilogAJump} from '../studio/veriloga-viewer.js';
import {mountSchematicSidebar} from '../studio/sidebar.js';
import {mountSchematicEditor} from '../studio/schematic-editor/controller.js';
import {createLibraryBridge} from '../remote/library-bridge.js';
import {loadSessionGrant} from '../remote/pair.js';
import {createOnboardingBridge,snapshotOnboardingSource} from '../remote/onboarding-bridge.js';
import {createOnboardingSync} from '../remote/onboarding-sync.js';
import {onboardingWaveformsAvailable} from '../../../modules/simulation/environment/model.js';
import {environmentAgentAssistance} from '../../../modules/simulation/agent-assistance.js';
import {confirmLeave} from '../vendor/rnl-viewer/editor.js';
import {enterRoot} from '../vendor/rnl-viewer/subcircuits.js';

const REPO='https://github.com/CircuitGit-dev/CircuitGit';
const RUN='rc-analytic-reference';
const PATH='/circuitgit-demo.scs';
const signals=[
  {id:'vin',label:'V(in)',psf_name:'in',unit:'V',quantity:'voltage'},
  {id:'vout',label:'V(out)',psf_name:'out',unit:'V',quantity:'voltage'},
  {id:'ir',label:'I(R0:1)',psf_name:'R0:1',unit:'A',quantity:'current',polarity:'into_terminal'},
].map(s=>({...s,status:'available',analysis:'tran',domain:[0,12e-9]}));

function dialog(title,content) {
  const d=document.createElement('dialog');d.className='demo-dialog';d.setAttribute('aria-label',title);const h=document.createElement('h2');h.textContent=title;
  const close=document.createElement('button');close.textContent='关闭';close.onclick=()=>{d.close();d.remove();};
  d.append(h,content,close);document.body.append(d);d.addEventListener('cancel',()=>d.remove(),{once:true});d.showModal();return d;
}

/** Static RC demo. A separate AI node connection starts only after explicit user authorization. */
export async function mountStudio({ui:providedUI}={}) {
  const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url);document.head.append(css);
  const ui=providedUI||await createLayout(),agentAssistance=createAgentAssistance({slot:ui.slots.ai,notify:ui.notify});document.body.classList.add('circuitgit-demo');document.title='CircuitGit';
  // Dockview can temporarily detach inactive tab containers. Resolve owned controls
  // within their panel roots, including while restoring a saved layout.
  const $=id=>document.getElementById(id)||Object.values(ui.slots).map(slot=>slot.element?.querySelector('#'+id)).find(Boolean);
  const brand=document.querySelector('.studio-brand');
  brand.replaceChildren();const image=document.createElement('img');image.src=new URL('../branding/circuitgit.svg',import.meta.url);image.alt='';brand.append(image,document.createTextNode('CircuitGit'));
  $('studio-project').replaceChildren(new Option('RC · 入门电路','rc-demo'));$('studio-project').disabled=true;
  $('studio-entry').replaceChildren(new Option('RNL 原理图','rc'));$('studio-entry').disabled=true;
  $('studio-run').replaceChildren(new Option('未关联仿真运行',''));$('studio-run').disabled=true;
  $('studio-identity').textContent='网页模式';$('studio-identity').className='demo-badge';
  const repository=document.createElement('a');repository.href=REPO;repository.textContent='GitHub ↗';repository.target='_blank';repository.rel='noopener';repository.className='demo-link';$('studio-toolbar').append(repository);
  const fav=document.createElement('link');fav.rel='icon';fav.type='image/svg+xml';fav.href=new URL('../branding/circuitgit-small.svg',import.meta.url);document.head.append(fav);
  const baseText=await fetch(new URL('./rc.scs',import.meta.url)).then(r=>{if(!r.ok)throw Error('RC example unavailable');return r.text();});
  let source=baseText,hash=await sha256(source),points=null,plotController=null,mode='none';
  const referenceSource=(text=source)=>({
    name:'circuitgit-demo.scs',
    path:PATH,
    text,
    temporary:true,
    open:async()=>({path:PATH,text}),
    read:async requested=>requested===PATH?text:null,
    files:new Map([[PATH,()=>new Blob([text],{type:'text/plain'})]]),
  });
  let activeLibrary=null,importedProject=null,versionSelection=null,libraryVersions=null,switching=false,waveformMount=null,referenceObserver=null,onboardingWaves=false,onboardingWaveEpoch=0;
  let loadedWatch=null,hotTask=null,hotController=null,hotQueued=false,hotDeferred=false,hotNotice='';
  let parameters={resistance:1000,capacitance:1e-12,stop:12e-9};
  const listeners=new Set();
  let context={project:{id:'rc-demo',sourceCommit:null},run:{runId:RUN},selection:null,
    file:{path:PATH,currentTextSha256:hash,dirty:false},geometry:{bundleCommit:null,manifestSha256:hash,sourceMatch:true,state:'ready'}};
  const emit=()=>listeners.forEach(fn=>fn(structuredClone(context)));
  const contextAdapter={getContext:()=>structuredClone(context),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  const mapping=()=>({source_commit:null,source:{path:PATH,sha256:hash},geometry:{bundle_commit:null,manifest_sha256:hash,entry_id:'rc-demo'},
    objects:signals.map(s=>({selector:{name:s.id==='vin'?'in':s.id==='vout'?'out':'R0',kind:s.quantity==='current'?'terminal':'net',scope:'(top)',viewer_source_path:PATH,native_entry_id:'rc-demo',occurrence_path:[],terminal_name:s.quantity==='current'?'1':null},
      status:'available',signal_id:s.id,psf_name:s.psf_name,unit:s.unit,analysis:'tran',polarity:s.polarity}))});
  const jobs=[{run_id:RUN,project_id:'rc-demo',configuration:'解析参考 / analytical',state:'reference'}];
  const referenceActive=()=>!activeLibrary&&!switching&&context.file?.path===PATH;
  const requireReference=run=>{if(!referenceActive()||run!==RUN)throw Error('当前原理图没有关联的 RC 解析参考。');};
  const api={jobs:async()=>({jobs:referenceActive()?jobs:[]}),catalog:async run=>{requireReference(run);return {signals,source_commit:null,csv_sha256:null};},mapping:async run=>{requireReference(run);return mapping();},
    waveform:async(run,id,params)=>{requireReference(run);points ||= reference(parameters);if(!points[id])throw Error('Unknown reference signal');return referenceWindow(points[id],params);}};
  const register=item=>registerStudioCommand({...item,run:()=>Promise.resolve().then(item.run).catch(e=>ui.notify(e.message,{kind:'error'}))});
  const host={version:1,agentAssistance,requestAgentAssistance:request=>agentAssistance.request(request),slots:ui.slots,context:contextAdapter,notify:ui.notify,registerCommand:register,
    getRuns:()=>referenceActive()?jobs:[],refresh:async()=>{},selectRun:async id=>{requireReference(id);context.run={runId:id};emit();},
    plot:{attach(controller){plotController=controller;controller.setPlotMode(mode);return()=>controller.destroy();}}};
  const workflowLink=mountWorkflowLink(host);
  window.addEventListener('pagehide',()=>workflowLink.destroy(),{once:true});
  host.libraryBridge=createLibraryBridge();
  let pairedFromOnboarding=null,remoteAI=null,workspaceHub=null,welcomeGuide=null,projectImporter=null;
  host.onboarding=createOnboardingBridge({
    win:window,
    onPaired:({client,info,local})=>{
      pairedFromOnboarding={client,info,local};
      if(info?.capabilities?.library_workflow===true)host.libraryBridge.bind(client,{supported:local});
      if(remoteAI)void remoteAI.adoptClient(client,info,{local});
      workspaceHub?.update();welcomeGuide?.update();
    },
    onDisconnected:()=>{
      pairedFromOnboarding=null;
      host.libraryBridge.unbind();
      workspaceHub?.update();welcomeGuide?.update();
    },
  });
  host.getOnboardingSource=()=>snapshotOnboardingSource(doc,{hasBuffer,fileText});
  host.prepareOnboardingWaveformSlot=()=>{stopReference();onboardingWaves=true;ui.slots.waveforms.setVisible(true);};
  host.openOnboardingWaveforms=async payload=>{
    const generation=++onboardingWaveEpoch;
    const {openOnboardingWaveforms}=await import('../remote/onboarding-waveforms.js');
    if(generation!==onboardingWaveEpoch)return null;
    const waveformHost={...host,prepareOnboardingWaveformSlot(){if(generation!==onboardingWaveEpoch)throw Error('波形打开请求已被新的选择取代。');host.prepareOnboardingWaveformSlot();}};
    const handle=await openOnboardingWaveforms(waveformHost,payload);
    if(generation!==onboardingWaveEpoch){handle?.destroy();return null;}
    waveformMount=handle;return handle;
  };
  host.onboardingSync=createOnboardingSync({bridge:host.onboarding,getSource:host.getOnboardingSource,openWaveforms:host.openOnboardingWaveforms});
  const simulationShell=document.createElement('section');simulationShell.className='ic-sim-panel';simulationShell.setAttribute('aria-label','仿真配置与任务');
  const simulationNav=document.createElement('nav');simulationNav.className='ic-sim-nav';simulationNav.setAttribute('aria-label','仿真工作流');
  const environmentTab=document.createElement('button'),runsTab=document.createElement('button');
  environmentTab.type=runsTab.type='button';
  environmentTab.textContent='环境与配置';environmentTab.dataset.field='page-environment';
  runsTab.textContent='运行与波形';runsTab.dataset.field='page-runs';
  simulationNav.append(environmentTab,runsTab);
  simulationNav.style.gridTemplateColumns='repeat(2,minmax(0,1fr))';
  const environmentPage=document.createElement('div'),runsPage=document.createElement('div');
  environmentPage.className=runsPage.className='ic-sim-page';
  environmentPage.dataset.page='environment';runsPage.dataset.page='runs';
  const circuitSummary=document.createElement('section');circuitSummary.className='ic-sim-circuit-bar';
  const environmentRoot=document.createElement('section');
  environmentPage.append(circuitSummary,environmentRoot);
  simulationShell.append(simulationNav,environmentPage,runsPage);ui.slots.simulation.element.replaceChildren(simulationShell);
  const simulationStyle=document.createElement('link');simulationStyle.rel='stylesheet';simulationStyle.href=new URL('../../../modules/simulation/style.css',import.meta.url);document.head.append(simulationStyle);
  let simulationPage='environment',environmentMount=null,unregisterEnvironment=null;
  function renderCircuitSummary(){
    circuitSummary.replaceChildren();
    const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
    const head=el('div',undefined,'ic-sim-circuit-head');
    const titleWrap=el('div',undefined,'ic-sim-circuit-title');
    const actions=el('div',undefined,'ic-sim-circuit-actions');
    if(importedProject){
      titleWrap.append(
        el('strong',importedProject.fileName),
        el('span',importedProject.origin==='ssh'?`SSH · ${importedProject.sshTarget}`:'本地导入','ic-sim-status active'),
      );
      const meta=importedProject.origin==='ssh'
        ? `${importedProject.remotePath||importedProject.fileName}${importedProject.supportCount?` · 含 ${importedProject.supportCount} 个依赖`:''}`
        : `${importedProject.name}${importedProject.supportCount?` · 含 ${importedProject.supportCount} 个依赖`:''}`;
      const reimp=el('button','更换网表','ic-sim-quiet');reimp.type='button';
      reimp.onclick=()=>projectImporter?.open(importedProject.origin==='ssh'?'ssh':'local');
      actions.append(reimp);
      head.append(titleWrap,actions);
      circuitSummary.append(head,el('p',meta,'ic-sim-note'));
    }else if(activeLibrary){
      const libLabel=formatLibraryName(activeLibrary.library);
      titleWrap.append(
        el('strong',activeLibrary.cell.name),
        el('span',libLabel,'ic-sim-status active'),
      );
      const vaCount=activeLibrary.cell.views?.flatMap(v=>v.files||[]).filter(isVerilogAFile).length||0;
      const meta=[
        `${activeLibrary.bundle.paths.length} 个电路文件`,
        vaCount?`含 Verilog-A 模型`:'',
        activeLibrary.cell.requires_external_models?'需匹配远端 PDK 模型':'',
      ].filter(Boolean).join(' · ');
      const browse=el('button','切换项目','ic-sim-quiet');browse.type='button';
      browse.onclick=()=>libraryManager?.show();
      const imp=el('button','导入网表','ic-sim-quiet');imp.type='button';
      imp.onclick=()=>projectImporter?.open('local');
      actions.append(browse,imp);
      head.append(titleWrap,actions);
      circuitSummary.append(head,el('p',meta,'ic-sim-note'));
    }else{
      titleWrap.append(
        el('strong','当前画布 · RC 入门示例'),
        el('span','未导入工程','ic-sim-status'),
      );
      const openAdc=el('button','打开 1G 12-bit ADC','ic-sim-quiet');openAdc.type='button';
      openAdc.onclick=()=>void host.openProjectCanvas({libraryId:'pipetisar-real',cellId:'TB_PIPE_RS9_N06'});
      const imp=el('button','导入网表…','ic-sim-quiet');imp.type='button';
      imp.onclick=()=>projectImporter?.open('local');
      actions.append(openAdc,imp);
      head.append(titleWrap,actions);
      circuitSummary.append(head,el('p','可导入本地 / SSH 任意 Spectre 或 SPICE 网表，或打开电路库项目后配置远端仿真。','ic-sim-note'));
    }
  }
  function renderRunsTab(){
    const envSession=environmentMount?.controller?.state?.session||null,envJob=envSession?.job||null;
    runsTab.textContent=envJob?'运行与波形 · 1':'运行与波形';
    runsPage.replaceChildren();
    const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
    if(envJob){
      const card=el('article',undefined,'ic-sim-job is-onboarding-run');
      const head=el('div',undefined,'ic-sim-section-head');
      head.append(el('h3',`${envSession.source?.file_name||'当前网表'} · ${envJob.configuration||'远端仿真'}`),el('span',envJob.state||'已提交','ic-sim-status'));
      card.append(head);
      const known=el('div',undefined,'ic-sim-known-data');
      known.append(el('span','远端 SSH / SpiceOwl','ic-sim-status'));
      if(envJob.execution_target)known.append(el('span','主机 '+envJob.execution_target,'ic-sim-status'));
      const waveReady=onboardingWaveformsAvailable({intake:envSession,job:envJob});
      if(waveReady)known.append(el('span','波形就绪 · 支持原理图点选探针','ic-sim-status'));
      card.append(known);
      const bar=el('div',undefined,'ic-sim-toolbar');
      if(waveReady){
        const waveBtn=el('button','查看波形（原理图探针）','ic-sim-primary');waveBtn.type='button';
        waveBtn.onclick=()=>void host.openOnboardingWaveforms({intake:envSession,job:envJob}).catch(e=>ui.notify(e.message,{kind:'error'}));
        bar.append(waveBtn);
      }
      const refreshBtn=el('button','刷新远端状态');refreshBtn.type='button';
      refreshBtn.onclick=()=>void environmentMount.controller.inspect().catch(e=>ui.notify(e.message,{kind:'error'}));
      const detailBtn=el('button','环境与分析详情 →','ic-sim-quiet');detailBtn.type='button';
      detailBtn.onclick=()=>{simulationPage='environment';renderSimulationPage();};
      const aiBtn=el('button','请 AI 诊断','ic-sim-quiet');aiBtn.type='button';
      aiBtn.onclick=()=>void host.requestAgentAssistance(environmentAgentAssistance('diagnosis',environmentMount.controller.state,environmentMount.controller.agentEditor)).catch(e=>ui.notify(e.message,{kind:'error'}));
      bar.append(refreshBtn,detailBtn,aiBtn);card.append(bar);runsPage.append(card);
    }else{
      const empty=el('section',undefined,'ic-sim-card');
      empty.append(el('h3','尚无远端仿真运行记录'),el('p',host.onboarding.getState().connected?'在「环境与配置」中导入网表、探测 SSH 服务器并提交仿真后，运行进度、结果报告与原理图点选波形会显示在这里。':'连接本机连接器即可通过你的 SSH 配置在远端 EDA 服务器上运行 Spectre 仿真，并在本网页直接点图查看波形。','ic-sim-note'));
      const bar=el('div',undefined,'ic-sim-toolbar');
      if(!host.onboarding.getState().connected){
        const connBtn=el('button','连接本机 SSH 服务器…','ic-sim-primary');connBtn.type='button';
        connBtn.onclick=()=>workspaceHub?.requireConnector('远端 SSH 服务器仿真');
        bar.append(connBtn);
      }
      const goEnv=el('button','前往环境与配置 →');goEnv.type='button';
      goEnv.onclick=()=>void showEnvironment().catch(panelError);
      bar.append(goEnv);empty.append(bar);runsPage.append(empty);
    }
  }
  function renderSimulationPage(){
    if(simulationPage!=='environment'&&simulationPage!=='runs')simulationPage='environment';
    environmentPage.hidden=simulationPage!=='environment';runsPage.hidden=simulationPage!=='runs';
    for(const [tab,id] of [[environmentTab,'environment'],[runsTab,'runs']]){tab.classList.toggle('is-active',simulationPage===id);tab.setAttribute('aria-pressed',String(simulationPage===id));}
    renderCircuitSummary();
    renderRunsTab();
  }
  const environmentLoader=whenVisible(ui.slots.simulation,async()=>{
    environmentRoot.textContent='正在打开环境配置…';
    try{const {mountEnvironmentWizard}=await import('../../../modules/simulation/environment/panel.js');
      environmentMount=mountEnvironmentWizard(environmentRoot,{requestAgentAssistance:host.requestAgentAssistance,adapter:host.onboarding,pendingStore:host.onboarding.pendingStore,getSource:host.getOnboardingSource,openWaveforms:host.openOnboardingWaveforms,onRequireConnector:feature=>workspaceHub?.requireConnector(feature),onOpenSshSetup:()=>host.onboarding.openSshSetup(),notify:ui.notify,onRun:job=>{renderRunsTab();ui.notify('远端仿真已提交：'+(job.job_id||job.run_id||'')+'；可在「运行与波形」跟踪进度。');}});
      unregisterEnvironment=host.onboardingSync.register(environmentMount.controller);renderRunsTab();return environmentMount;
    }catch(error){environmentRoot.textContent='环境配置加载失败：'+error.message;throw error;}
  },{onError:error=>ui.notify(error.message,{kind:'error'})});
  const offOnboardingSync=host.onboardingSync.subscribe(()=>renderRunsTab());
  const offOnboardingState=host.onboarding.subscribe(()=>{
    const connected=host.onboarding.getState().connected||host.libraryBridge.getState().connected||Boolean(remoteAI?.getConnectionState?.().connected);
    $('studio-identity').textContent=connected?'本机已连接':'网页模式';
    renderRunsTab();
  });
  async function showEnvironment(){
    simulationPage='environment';renderSimulationPage();ui.slots.simulation.setVisible(true);return environmentLoader.ensure();
  }
  function showRuns(){simulationPage='runs';renderSimulationPage();ui.slots.simulation.setVisible(true);void environmentLoader.ensure().then(renderRunsTab).catch(()=>{});}
  environmentTab.onclick=()=>void showEnvironment().catch(error=>ui.notify(error.message,{kind:'error'}));runsTab.onclick=showRuns;renderSimulationPage();
  window.addEventListener('pagehide',()=>{offOnboardingSync?.();offOnboardingState?.();verilogaJump?.destroy();verilogaPanel?.destroy();projectImporter?.destroy();welcomeGuide?.destroy();workspaceHub?.destroy();agentAssistance.destroy();aiLoader.dispose();environmentLoader.dispose();unregisterEnvironment?.();environmentMount?.destroy();host.onboardingSync.destroy();host.onboarding.disconnect();},{once:true});
  let waveModule=null,waveMountTask=null;
  async function mountReferenceWaves(){
    if(waveformMount||!referenceActive()||onboardingWaves)return;
    if(waveMountTask)return waveMountTask;
    waveMountTask=(async()=>{
      waveModule ||= await import('../studio/dockview/waveforms.js');
      if(!referenceActive()||waveformMount||onboardingWaves)return;
      waveformMount=waveModule.mount(host,{api,labels:{loaded:'已加载浏览器计算的 RC 解析参考；不是 Spectre 仿真结果。',
        catalog:'RC 解析参考信号（浏览器计算，非 PSF 导出）。',provenance:'Piecewise-linear RC analytical reference · no Spectre execution',
        measurement:'RC 解析参考 / 线性插值',dataNote:'RC 一阶方程的分段线性输入解析解；每 5 ps 取样。显示使用保峰抽样，游标使用完整参考向量。'}});
      showReferenceTraces();
    })();
    try{await waveMountTask;}finally{waveMountTask=null;}
  }
  const panelError=error=>ui.notify('面板加载失败：'+error.message,{kind:'warning'});
  const showWaves=shown=>{if(shown)void mountReferenceWaves().catch(panelError);};
  ui.slots.waveforms.onVisibility?.(showWaves);showWaves(ui.slots.waveforms.isVisible());

  const canOnboardingProbe=()=>onboardingWaves&&Boolean(waveformMount?.canProbe?.());
  function setMode(value){
    if(value!=='none'&&!canOnboardingProbe()&&(!referenceActive()||onboardingWaves)){
      const reason=onboardingWaves?waveformMount?.probeStatus?.()?.reason:null;
      throw Error(reason||'当前波形未建立电路节点映射，请从信号列表添加曲线。');
    }
    mode=value;plotController?.setPlotMode(value);if(onboardingWaves)waveformMount?.controller?.setPlotMode?.(value);
    $('studio-plot-state').hidden=value==='none';
    $('studio-plot-state').textContent=value==='voltage'?'电压探针 · Esc退出':value==='current'?(onboardingWaves?'电流探针 · Esc退出':'电流探针 · R0 端口1 · Esc退出'):'';
  }
  for(const [value,label] of [['voltage','电压探针：点击节点'],['current','电流探针：点击器件']])register({id:'plot.'+value,menu:'plot',label,enabled:()=>(referenceActive()&&!onboardingWaves)||canOnboardingProbe(),run:async()=>{
    if(canOnboardingProbe()){ui.slots.waveforms.setVisible(true);waveformMount.controller.openWindow();setMode(value);ui.notify(value==='voltage'?'远端波形电压探针：点击原理图节点；Esc 退出。':'远端波形电流探针：点击原理图器件；Esc 退出。');return;}
    if(!referenceActive()||onboardingWaves)throw Error('当前波形未建立电路节点映射。');
    ui.slots.waveforms.setVisible(true);await mountReferenceWaves();if(!referenceActive()||!plotController)return;plotController.openWindow();setMode(value);ui.notify(label);
  },checked:()=>mode===value});
  register({id:'plot.exit',menu:'plot',label:'退出探针 (Esc)',run:()=>setMode('none')});
  register({id:'window.reset',menu:'window',label:'恢复默认布局',run:()=>ui.resetLayout()});
  register({id:'git.history',menu:'git',label:'电路版本管理',run:async()=>{ui.slots.versions.setVisible(true);const versions=await versionLoader.ensure();await versions.activate();}});
  register({id:'project.source',menu:'project',label:'查看 / 下载当前网表',run:()=>showSource()});
  register({id:'simulation.local',menu:'simulation',label:'如何连接本地仿真',run:()=>showGuide()});
  register({id:'simulation.environment',menu:'simulation',label:'连接服务器与匹配 PDK',run:showEnvironment});
  register({id:'simulation.runs',menu:'simulation',label:'运行记录与波形',run:showRuns});
  register({id:'window.help.demo',menu:'help',label:'CircuitGit 演示与本地使用',run:()=>showGuide()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&mode!=='none'){setMode('none');ui.notify('已退出探针。');}});
  window.addEventListener('viewer-selection',()=>{
    if(mode==='none')return;
    if(onboardingWaves){
      if(dirtyPaths().length||unappliedPaths().length){ui.notify('当前原理图有未保存修改；远端波形探针已暂停。',{kind:'warning'});return;}
      const status=waveformMount?.probeStatus?.();
      if(!status?.ok){ui.notify(status?.reason||'当前画布与远端仿真源版本不一致；已暂停点选探针。',{kind:'warning'});return;}
      const object=doc?.objects[selected];if(!object)return;
      const expected=mode==='voltage'?'net':'instance';if(object.kind!==expected)return;
      const scope=doc.levels?.find(l=>l.host===object.level)?.kind==='file'?'(top)':(object.level_title||'(top)');
      const selection={kind:object.kind,name:object.name,scope,viewerSourcePath:context.file?.path||doc.path,nativeEntryId:status.entryId,occurrencePath:[],terminalName:null};
      context.selection=selection;emit();waveformMount.probe(selection);
      return;
    }
    if(doc?.path!==PATH||dirtyPaths().length||unappliedPaths().length){ui.notify('示例源已修改或已切换文档；请重置示例后使用参考探针。',{kind:'warning'});return;}
    const object=doc?.objects[selected];if(!object)return;
    const kind=mode==='voltage'?'net':'instance';if(object.kind!==kind)return;
    if(mode==='voltage'&&!['in','out'].includes(object.name)||mode==='current'&&object.name!=='R0'){ui.notify('此公开示例提供 V(in)、V(out) 与 I(R0:1)。');return;}
    context.selection={kind:mode==='current'?'terminal':'net',name:object.name,terminalName:mode==='current'?'1':null,
      scope:'(top)',viewerSourcePath:PATH,nativeEntryId:'rc-demo',occurrencePath:[]};emit();plotController.onSelection(contextAdapter.getContext());
  });
  function showSource(){
    if(schematicEditor){schematicEditor.openSourceEditor();return;}
    const area=document.createElement('textarea');area.readOnly=true;area.value=activeLibrary?activeLibrary.bundle.text:importedProject?importedProject.text:source;dialog(activeLibrary?activeLibrary.cell.name+' · '+formatViewLabel(activeLibrary.view):importedProject?importedProject.label:'当前网表源码',area);
  }
  function showGuide(){const e=document.createElement('div');e.className='demo-section';e.innerHTML=`<p><strong>CircuitGit 网页工作台</strong>提供完整的原理图（RNL）、电路库、波形探针、远端 SSH 仿真（SpiceOwl）、AI 助手（Codex）与 Git 版本管理交互。</p><p><strong>免安装功能</strong>：直接浏览电路库、查看与编辑原理图、点选参考波形并体验游标测量。</p><p><strong>本机 SSH / AI / Git 连接</strong>：点击顶栏「连接本机 (SSH / AI)」即可通过 <code>circuitgit://</code> 协议一键唤起本机连接器；首次使用仅需下载项目并双击一次启动器（Windows: <code>Start CircuitGit.bat</code>，macOS: <code>Start CircuitGit.command</code>），之后所有日常操作均在本网页内完成。</p><p><a href="${REPO}/blob/main/docs/remote-node.md" target="_blank" rel="noopener">本机连接器与后台自启说明 ↗</a></p>`;dialog('CircuitGit 使用说明',e);}
  $('studio-source-button').disabled=false;
  $('studio-source-button').onclick=showSource;
  let libraryManager=null,verilogaPanel=null,verilogaJump=null,schematicSidebar=null,schematicEditor=null;
  verilogaPanel=mountVerilogAPanel({
    slot:ui.slots.veriloga,
    loadLibraryFile:async path=>{
      const client=libraryManager?.getClient?.()||createLibraryClient();
      const bundle=await client.loadView({id:'veriloga',kind:'veriloga',label:'Verilog-A',entry:path,files:[path]});
      return bundle.text;
    },
    notify:ui.notify,
  });
  function syncAvailableVerilogA(){
    if(importedProject){
      const snap=Object.create(null);
      if(importedProject.rnlSnapshot)Object.assign(snap,importedProject.rnlSnapshot);
      if(importedProject.supportFiles){
        for(const [k,v] of Object.entries(importedProject.supportFiles)){
          if(!Object.hasOwn(snap,k)&&!Object.hasOwn(snap,'/'+k))snap[k]=v;
        }
      }
      if(importedProject.fileName&&isVerilogAFile(importedProject.fileName)&&typeof importedProject.text==='string'){
        snap[importedProject.fileName]=importedProject.text;
      }
      const idx=indexSnapshotVerilogAFiles(snap,{origin:importedProject.origin==='ssh'?`SSH · ${importedProject.sshTarget||''}`:'本地导入'});
      verilogaPanel.setAvailableModels(idx.list);
      return;
    }
    const libs=libraryManager?.getLibraries?.()||[];
    if(!libs.length){verilogaPanel.setAvailableModels([]);return;}
    const preferred=activeLibrary?.library?.id||null;
    const idx=indexLibraryVerilogAFiles(libs,preferred);
    const scoped=preferred?idx.list.filter(item=>item.libraryId===preferred):idx.list;
    verilogaPanel.setAvailableModels(scoped.length?scoped:idx.list);
  }
  libraryManager=mountLibraryManager({
    toolbar:$('studio-toolbar'),
    libraryPane:$('pane-files'),
    onOpen:openLibrary,
    onOpenVerilogA:async value=>{
      syncAvailableVerilogA();
      return verilogaPanel.openModel({
        path:value.path,
        text:value.text,
        moduleName:value.view?.moduleName||null,
        libraryId:value.view?.sourceLibraryId||value.library?.id||null,
        origin:value.library?.name||'',
        siblings:value.siblings,
      },{reveal:true});
    },
    onReference:openReference,
    onSelection:value=>{versionSelection=value;emit();},
    notify:ui.notify,
  });
  verilogaJump=attachSchematicVerilogAJump({
    getDoc:()=>doc,
    getCurrent:()=>current,
    getSelected:()=>selected,
    getView:()=>view,
    isProbeActive:()=>mode!=='none',
    resolveMaster:masterName=>resolveVerilogAModel({
      masterName,
      importedProject,
      doc,
      libraries:libraryManager.getLibraries(),
      activeLibraryId:activeLibrary?.library?.id||null,
    }),
    openModel:(model,opts)=>verilogaPanel.openModel(model,opts),
  });
  schematicSidebar=mountSchematicSidebar({
    getProjectState:()=>({activeLibrary,importedProject,isReference:referenceActive()}),
    onOpenLibraryManager:()=>libraryManager.show(),
    onOpenImport:()=>projectImporter?.openLocal(),
    onOpenCell:({library,cell})=>{
      if(library?.id&&cell?.id)void libraryManager.openProjectTop(library.id,cell.id);
    },
    onOpenQuickProject:()=>{void host.openProjectCanvas({libraryId:'pipetisar-real'});},
    onOpenVerilogA:(model,opts)=>verilogaPanel.openModel(model,opts),
    resolveVerilogA:masterName=>resolveVerilogAModel({
      masterName,
      importedProject,
      doc,
      libraries:libraryManager.getLibraries(),
      activeLibraryId:activeLibrary?.library?.id||null,
    }),
  });
  schematicEditor=mountSchematicEditor({
    getProjectContext:()=>({activeLibrary,importedProject,isReference:referenceActive()}),
    getLibraries:()=>libraryManager?.getLibraries?.()||[],
    getVerilogAModels:()=>{
      if(importedProject?.rnlSnapshot)return indexSnapshotVerilogAFiles(importedProject.rnlSnapshot).list;
      const libs=libraryManager?.getLibraries?.()||[];
      const preferred=activeLibrary?.library?.id||null;
      return libs.length?indexLibraryVerilogAFiles(libs,preferred).list:[];
    },
    isProbeActive:()=>mode!=='none',
    bridge:host.libraryBridge,
    onRequireConnector:feature=>workspaceHub?.requireConnector(feature),
    onDocumentUpdated:({filePath,text,dirty,source:nextSource})=>{
      if(filePath===PATH&&referenceActive()){
        source=text;
      }else if(activeLibrary?.bundle){
        activeLibrary={...activeLibrary,bundle:{...activeLibrary.bundle,source:nextSource,...(activeLibrary.bundle.source?.path===filePath?{text}:{})}};
      }else if(importedProject){
        importedProject={...importedProject,...(context.file?.path===filePath?{text}:{}),rnlSnapshot:nextSource?.snapshot||importedProject.rnlSnapshot};
      }
      context={...context,file:{...context.file,dirty:Boolean(dirty)}};emit();
      schematicSidebar?.refresh();
    },
    notify:ui.notify,
  });
  register({id:'project.add_instance',menu:'project',label:'调用器件 / 子电路实例 (I)…',run:()=>schematicEditor?.openInstancePicker()});
  register({id:'project.save_pr',menu:'project',label:'保存修改并提交 Pull Request…',run:()=>schematicEditor?.openSavePr()});
  register({id:'window.veriloga',menu:'window',label:'Verilog-A 行为模型代码',run:()=>{ui.slots.veriloga.setVisible(true);void libraryManager.ensureLoaded().then(syncAvailableVerilogA).catch(()=>{});syncAvailableVerilogA();}});
  host.openLibraryManager=()=>libraryManager.show();
  host.openProjectCanvas=async({libraryId,cellId}={})=>{
    if(!libraryId)return false;
    if(libraryId==='basics'&&cellId==='rc-smoke'){
      if(referenceActive())return true;
      return openReference();
    }
    if(activeLibrary?.library.id===libraryId&&(!cellId||activeLibrary.cell.id===cellId))return true;
    return libraryManager.openProjectTop(libraryId,cellId||null);
  };
  for(const id of ['studio-project','studio-entry']){const label=$(id)?.closest('label');if(label){label.classList.add('demo-library-trigger');label.title='点击浏览并切换公开电路库';label.addEventListener('click',()=>libraryManager.show());}}
  register({id:'project.import.local',menu:'project',label:'导入本地网表 / 文件夹…',run:()=>projectImporter?.openLocal()});
  register({id:'project.import.ssh',menu:'project',label:'从 SSH 服务器导入网表…',run:()=>projectImporter?.openSsh()});
  register({id:'project.library',menu:'project',label:'Library Manager…',run:()=>libraryManager.show()});
  register({id:'project.reference',menu:'project',label:'返回 RC 解析参考',run:openReference});
  function stopReference(){
    onboardingWaves=false;
    setMode('none');referenceObserver?.disconnect();referenceObserver=null;waveformMount?.destroy();waveformMount=null;plotController=null;
    const root=ui.slots.waveforms.element;root.replaceChildren();root.classList.remove('wf-panel','wf-minimal');root.removeAttribute('title');root.setAttribute('aria-label','库视图的数据状态');
    const empty=document.createElement('section');empty.className='cg-library-empty-wave';
    const heading=document.createElement('strong'),note=document.createElement('p');heading.textContent='此视图尚未关联仿真波形';note.textContent='已清除 RC 解析参考。公开原理图与运行结果分别管理，加载电路不会启动仿真。';empty.append(heading,note);root.append(empty);
  }
  function libraryInformation(){
    simulationPage='environment';renderSimulationPage();
  }
  async function importNetlistProject(payload){
    if(switching)return false;
    if(!await confirmLeave('导入你的电路项目'))return false;
    hotController?.abort();loadedWatch?.();loadedWatch=null;
    ++onboardingWaveEpoch;switching=true;activeLibrary=null;
    stopReference();
    const rnlSource=buildImportedRnlSource(payload);
    const supportFiles=payload.supportFiles||{};
    const supportCount=Object.keys(supportFiles).length;
    const displayLabel=payload.origin==='ssh'
      ? `SSH · ${payload.sshTarget} / ${payload.fileName}`
      : `本地 · ${payload.projectName||payload.fileName}`;
    const projectBadge=payload.origin==='ssh'?`SSH · ${payload.sshTarget}`:`本地 · ${payload.projectName||payload.fileName}`;
    if(isVerilogAFile(payload.fileName)){
      importedProject={
        origin:payload.origin||'local',
        name:payload.projectName||payload.fileName,
        fileName:payload.fileName,
        label:displayLabel,
        sshTarget:payload.sshTarget||null,
        remotePath:payload.remotePath||null,
        supportCount,
        supportFiles,
        rnlSnapshot:rnlSource.snapshot,
        text:payload.text,
      };
      syncAvailableVerilogA();
      await verilogaPanel.openModel({
        path:payload.remotePath||payload.entryPath||payload.fileName,
        text:payload.text,
        origin:payload.origin==='ssh'?`SSH · ${payload.sshTarget||''}`:'本地导入',
      },{reveal:true});
      switching=false;
      welcomeGuide?.setStep?.(3);
      welcomeGuide?.update();
      ui.notify(`已在 Verilog-A 代码面板打开「${payload.fileName}」。`);
      return true;
    }
    $('studio-project').replaceChildren(new Option(projectBadge,'imported-netlist'));
    $('studio-entry').replaceChildren(new Option(payload.fileName,rnlSource.path));
    $('studio-run').replaceChildren(new Option('未关联仿真运行',''));
    context={project:{id:'imported-netlist',name:payload.projectName||payload.fileName,sourceCommit:null},run:null,selection:null,loading:true,loadState:'loading',
      file:{path:rnlSource.path,currentTextSha256:null,dirty:false},geometry:{bundleCommit:null,manifestSha256:null,sourceMatch:null,state:'snapshot'}};emit();
    ui.setNativeState({loading:true,hidden:false});$('studio-native-note').textContent='正在加载导入的网表…';
    try{
      const opened=await openSource(rnlSource,false,undefined,false,null,null,true);
      if(!opened||!doc||doc.failed)throw Error('导入的网表未能完成 RNL 解析；请检查 Problems 诊断。');
      const errors=doc.diagnostics.filter(d=>d.severity==='error');
      const textHash=await sha256(payload.text);
      importedProject={
        origin:payload.origin||'local',
        name:payload.projectName||payload.fileName,
        fileName:payload.fileName,
        label:displayLabel,
        sshTarget:payload.sshTarget||null,
        remotePath:payload.remotePath||null,
        supportCount,
        supportFiles,
        rnlSnapshot:rnlSource.snapshot,
        text:payload.text,
      };
      syncAvailableVerilogA();
      verilogaJump?.clear();
      schematicSidebar?.refresh();
      schematicEditor?.resetBaselines();
      context={...context,loading:false,loadState:errors.length?'error':'ready',file:{...context.file,currentTextSha256:textHash}};emit();
      fit();ui.slots.schematic?.setVisible(true);
      const depNote=supportCount?`（含 ${supportCount} 个依赖文件）`:'';
      $('studio-native-note').textContent=`${displayLabel}${depNote} · ${errors.length?errors.length+' 项 RNL 诊断':'可直接与 AI 协作或配置远端 SSH 仿真'}`;
      simulationPage='environment';renderSimulationPage();
      welcomeGuide?.setStep?.(3);
      if(host.onboarding.getState().connected){
        try{
          const netArgs=supportCount
            ? {file_name:payload.fileName,text:payload.text,mode:'agent-tb',support_files:supportFiles}
            : {file_name:payload.fileName,text:payload.text,mode:'agent-tb'};
          try{await host.onboarding.inspectNetlist(netArgs);}
          catch(firstErr){
            if(supportCount)throw firstErr;
            await host.onboarding.inspectNetlist({file_name:payload.fileName,text:payload.text});
          }
          await host.onboardingSync.refresh().catch(()=>{});
          const aiSynced=await remoteAI?.syncOnboardingProject?.().catch(()=>false);
          ui.notify(`已导入「${payload.fileName}」${depNote}，已同步到${aiSynced?' AI 对话与':''}远端仿真会话。`);
        }catch(syncErr){
          ui.notify(`原理图已打开「${payload.fileName}」，同步仿真会话提示：${syncErr?.message||syncErr}`,{kind:'warning'});
        }
      }else{
        ui.notify(`已在画布打开「${payload.fileName}」${depNote}；连接本机后即可与 Agent 协作并运行远端 SSH 仿真。`);
      }
      if(errors.length)ui.notify('原理图存在 '+errors.length+' 项 RNL 诊断；请查看左侧「问题」。',{kind:'warning'});
      welcomeGuide?.update();
      return true;
    }catch(error){
      context={...context,loading:false,loadState:'error'};emit();
      $('studio-native-note').textContent='导入网表加载失败 · '+payload.fileName;
      throw error;
    }finally{
      switching=false;ui.setNativeState({loading:false,hidden:false});
    }
  }
  async function openLibrary(value){
    if(switching)return false;
    if(!await confirmLeave('打开公开库视图'))return false;
    hotController?.abort();loadedWatch?.();loadedWatch=null;
    const canonicalView=value.view?.backingViewId?(value.cell.views.find(v=>v.id===value.view.backingViewId)||value.view):value.view;
    ++onboardingWaveEpoch;switching=true;activeLibrary={...value,view:canonicalView};importedProject=null;versionSelection={...value,view:canonicalView};stopReference();libraryInformation(value);
    const viewLabel=formatViewLabel(value.view),libLabel=formatLibraryName(value.library);
    $('studio-project').replaceChildren(new Option(libLabel,value.library.id));$('studio-entry').replaceChildren(new Option(value.cell.name+' / '+viewLabel,value.view.entry));$('studio-run').replaceChildren(new Option('未关联仿真运行',''));
    context={project:{id:(value.origin==='working'?'local-library:':'public-library:')+value.library.id+':'+value.cell.id,sourceCommit:value.origin==='working'?value.base_commit:null,libraryId:value.library.id,cellId:value.cell.id},run:null,selection:null,loading:true,loadState:'loading',file:{path:value.bundle.source.path,currentTextSha256:null,dirty:false},geometry:{bundleCommit:null,manifestSha256:null,sourceMatch:null,state:'snapshot'}};emit();
    ui.setNativeState({loading:true,hidden:false});$('studio-native-note').textContent='读取公开库视图…';
    try{
      const opened=await openSource(value.bundle.source,false,undefined,false,null,null,true);
      if(!opened||!doc||doc.path!==value.bundle.source.path||doc.failed)throw Error('库视图未能完成加载；请查看 RNL 诊断。');
      if(value.view.level!==undefined){const level=value.view.level==='@top'?0:doc.levels.findIndex(l=>l.title===value.view.level);if(level<0)throw Error('清单指定的原生层级不存在：'+value.view.level);await enterRoot(level,{here:true,newWindow:false});}
      const errors=doc.diagnostics.filter(d=>d.severity==='error');
      context={...context,loading:false,loadState:errors.length?'error':'ready',file:{...context.file,currentTextSha256:await sha256(value.bundle.text)}};emit();
      fit();ui.slots.schematic?.setVisible(true);
      if(value.view?.virtualSymbol){setSidebar(true);setPane('symbol');}
      syncAvailableVerilogA();verilogaJump?.clear();schematicSidebar?.refresh();schematicEditor?.resetBaselines();
      if(!libraryManager.getLibraries().length)void libraryManager.ensureLoaded().then(syncAvailableVerilogA).catch(()=>{});
      $('studio-native-note').textContent=[formatLibraryName(value.library),value.cell.name,viewLabel].join(' / ')+(value.origin==='working'?' · 本机快照 · ':' · 公开文件 · ')+(errors.length?errors.length+' 项 RNL 诊断':'未关联仿真');
      if(errors.length)ui.notify('原理图已打开，存在 '+errors.length+' 项 RNL 诊断；请查看 Problems。',{kind:'warning'});
      watchLoadedLibrary();
      if(remoteAI?.getConnectionState?.().connected&&value.library?.id){
        void remoteAI.syncProjectFromCanvas?.(value.library.id).catch(()=>{});
      }
      return true;
    }catch(error){context={...context,loading:false,loadState:'error'};emit();$('studio-native-note').textContent='库视图加载失败 · '+value.cell.name+' · 未关联仿真';throw error;}
    finally{switching=false;ui.setNativeState({loading:false,hidden:false});}
  }
  async function openReference(){
    if(switching)return false;
    if(!await confirmLeave('返回 RC 解析参考'))return false;
    hotController?.abort();loadedWatch?.();loadedWatch=null;
    ++onboardingWaveEpoch;switching=true;stopReference();context={...context,run:null,selection:null,loading:true};emit();ui.setNativeState({loading:true,hidden:false});
    try{
      const opened=await openSource(referenceSource(source),false,undefined,false,null,null,true);
      if(!opened||!doc||doc.failed||doc.diagnostics.some(d=>d.severity==='error'))throw Error('RC schematic failed to compile');
      activeLibrary=null;importedProject=null;context={project:{id:'rc-demo',sourceCommit:null},run:{runId:RUN},selection:null,loading:false,loadState:'ready',file:{path:PATH,currentTextSha256:hash,dirty:false},geometry:{bundleCommit:null,manifestSha256:hash,sourceMatch:true,state:'ready'}};
      $('studio-project').replaceChildren(new Option('RC · 入门电路','rc-demo'));$('studio-entry').replaceChildren(new Option('RNL 原理图','rc'));$('studio-run').replaceChildren(new Option('未关联仿真运行',''));
      $('studio-native-note').textContent='内置 RC 入门电路 · RNL 布局 · 连接本机后可跑真实远端 Spectre 仿真';switching=false;simulationPage='environment';renderSimulationPage();emit();if(ui.slots.waveforms.isVisible())await mountReferenceWaves();showReferenceTraces();fit();ui.slots.schematic?.setVisible(true);syncAvailableVerilogA();verilogaJump?.clear();schematicSidebar?.refresh();schematicEditor?.resetBaselines();return true;
    }catch(error){context={...context,run:null,selection:null,loading:false,loadState:'error'};emit();$('studio-native-note').textContent='RC 参考加载失败 · 无关联波形';throw error;}
    finally{switching=false;ui.setNativeState({loading:false,hidden:false});}
  }
  function libraryVersionSelection(){
    if(!versionSelection)return null;
    const {library,cell,view}=versionSelection;
    const matches=!context.loading&&activeLibrary?.library.id===library.id&&activeLibrary?.cell.id===cell.id&&activeLibrary?.view.id===view.id;
    return {library_id:library.id,cell_id:cell.id,library:library.name,cell:cell.name,view_id:view.id,view:view.label,directory:cell.directory,entry:view.entry,
      files:[...new Set(cell.views.flatMap(item=>item.files))],has_schematic:cell.views.some(item=>item.kind==='rnl'),source_sha256:matches?context.file.currentTextSha256:null};
  }
  async function ensureVersionSelection(){
    if(versionSelection)return;
    const catalog=await createLibraryClient().load();if(versionSelection)return;
    const library=catalog.libraries.find(item=>item.id==='basics'),cell=library?.cells.find(item=>item.id==='rc-smoke'),view=cell?.views.find(item=>item.id==='netlist');
    if(library&&cell&&view){versionSelection={library,cell,view};emit();}
  }
  async function loadWorkingBundle(value,{signal}={}){
    const prefix=new URL('../library-files/',import.meta.url),client=createLibraryClient({baseURL:prefix,fetcher:async url=>{
      if(signal?.aborted)throw Error('源同步已取消。');
      const requested=new URL(url);if(requested.origin!==prefix.origin||!requested.pathname.startsWith(prefix.pathname))throw Error('本机文件请求越界。');
      const path=decodeURIComponent(requested.pathname.slice(prefix.pathname.length));if(!value.view.files.includes(path))throw Error('文件不在当前视图清单内。');
      const file=await host.libraryBridge.request('read_file',{library_id:value.library.id,cell_id:value.cell.id,path});
      if(file.path!==path||typeof(file.text??file.content)!=='string')throw Error('节点返回的原理图文件身份无效。');
      return new Response(file.text??file.content,{status:200,headers:{'Content-Type':'text/plain;charset=utf-8'}});
    }});
    return client.loadView(value.view,{signal});
  }
  async function openWorkingLibrary(description){
    const selected=versionSelection;if(!selected||description.library_id!==selected.library.id||description.cell_id!==selected.cell.id)throw Error('当前电路单元已变化，请重新读取本机版本。');
    const view=selected.view.kind==='rnl'?selected.view:selected.cell.views.find(item=>item.kind==='rnl');if(!view)throw Error('此单元没有可打开的 RNL 原理图视图。');
    if(activeLibrary?.library.id===selected.library.id&&activeLibrary?.cell.id===selected.cell.id&&activeLibrary.view.entry===view.entry)return refreshLoadedLibrary();
    const value={...selected,view},bundle=await loadWorkingBundle(value);if(versionSelection!==selected)throw Error('读取期间电路单元已变化，未打开旧快照。');
    await openLibrary({...value,bundle,origin:'working',base_commit:description.base_commit});
  }
  function sourceSyncNote(text){$('studio-native-note').textContent=text;if(text!==hotNotice){hotNotice=text;ui.notify(text,{kind:'warning'});}}
  function watchLoadedLibrary(){
    loadedWatch?.();loadedWatch=null;if(!activeLibrary)return;
    const value=activeLibrary;
    loadedWatch=host.libraryBridge.watchCell({library_id:value.library.id,cell_id:value.cell.id},{isVisible:()=>!!activeLibrary&&activeLibrary.library.id===value.library.id&&activeLibrary.cell.id===value.cell.id&&(ui.slots.schematic?.isVisible?.()??true),
      onCurrent(_state,{initial,changed}){if(initial||changed||hotDeferred)void refreshLoadedLibrary();},onError(error){sourceSyncNote('本机同步暂不可用：'+error.message+'；保留当前画布。');}});
  }
  async function refreshLoadedLibrary(){
    if(hotTask){hotQueued=true;return hotTask;}
    if(!activeLibrary||!host.libraryBridge.getState().connected)return false;if(switching||isLoading()){hotDeferred=true;return false;}
    if(dirtyPaths().length||unappliedPaths().length||previewing()||schematicEditor?.isDirty?.()){hotDeferred=true;sourceSyncNote('画布有未保存修改或布局预览，自动同步已暂缓。');return false;}
    const value=activeLibrary,revision=host.libraryBridge.getState().revision,controller=new AbortController();hotController=controller;hotQueued=false;hotDeferred=false;
    const scope={library_id:value.library.id,cell_id:value.cell.id},stillCurrent=()=>!controller.signal.aborted&&activeLibrary===value&&!switching&&host.libraryBridge.getState().revision===revision&&host.libraryBridge.getState().connected;
    hotTask=(async()=>{let candidate;
      try{
        const before=await host.libraryBridge.request('current',scope),bundle=await loadWorkingBundle(value,{signal:controller.signal}),after=await host.libraryBridge.request('current',scope);
        if(!stillCurrent())return false;
        if((before.fingerprint||before.revision)&&(before.fingerprint||before.revision)!==(after.fingerprint||after.revision)){hotQueued=true;return false;}
        const prior=value.bundle.source.snapshot||{},next=bundle.source.snapshot||{};
        if(bundle.paths.length===value.bundle.paths.length&&bundle.paths.every(path=>prior['/'+path]===next['/'+path]))return true;
        context={...context,run:null,selection:null,geometry:{...context.geometry,sourceMatch:false,state:'stale'}};stopReference();emit();
        const textHash=await sha256(bundle.text);candidate=await shell.build(bundle.source,undefined,undefined,undefined,controller.signal);
        if(!stillCurrent())return false;
        const errors=candidate?.diagnostics?.filter(item=>item.severity==='error')||[];
        const expected=value.view.level==='@top'?0:candidate?.levels?.findIndex(level=>level.title===value.view.level);
        if(!candidate||candidate.failed||errors.length||(value.view.level!==undefined&&expected<0))throw Error(errors[0]?.message||'新的原理图未通过解析。');
        resetBuffers(candidate);showBuilt(candidate,true);adoptSource(bundle.source);
        activeLibrary={...value,bundle,origin:'working',base_commit:after.base_commit};
        if(versionSelection?.library.id===value.library.id&&versionSelection?.cell.id===value.cell.id&&versionSelection?.view.id===value.view.id)versionSelection=activeLibrary;
        context={...context,project:{...context.project,id:'local-library:'+value.library.id+':'+value.cell.id,sourceCommit:after.base_commit},run:null,selection:null,loading:false,loadState:'ready',file:{...context.file,currentTextSha256:textHash,dirty:false},geometry:{bundleCommit:null,manifestSha256:null,sourceMatch:true,state:'snapshot'}};
        libraryInformation(activeLibrary);emit();schematicSidebar?.refresh();hotNotice='';$('studio-native-note').textContent=value.library.name+' / '+value.cell.name+' · 已同步本机原理图 · 未关联仿真';
        await sourceOpened(bundle.source,candidate,false);return true;
      }catch(error){if(!controller.signal.aborted){sourceSyncNote('源码已变化，画布保留最后可读版本：'+(error.message||String(error)));}return false;}
      finally{if(candidate)shell.discardBuild?.(candidate);hotController=null;}
    })();
    try{return await hotTask;}finally{hotTask=null;if(hotQueued){hotQueued=false;setTimeout(()=>void refreshLoadedLibrary(),2500);}}
  }
  host.libraryBridge.subscribeMutation(event=>{if(activeLibrary?.library.id===event.args.library_id&&activeLibrary?.cell.id===event.args.cell_id)void refreshLoadedLibrary();});
  host.libraryBridge.subscribe(state=>{if(!state.connected)hotController?.abort();});
  window.addEventListener('viewer-navigate',()=>{
    if(switching||!doc||doc.path===PATH)return;
    // Descending/ascending subcircuits inside the already-open library or imported project
    // stays in the same document and must not discard library context or overwrite project state.
    if(activeLibrary&&doc.path===activeLibrary.bundle?.source?.path)return;
    if(importedProject&&doc.path===context.file?.path)return;
    const openedDoc=doc,snapshot=host.getOnboardingSource();hotController?.abort();loadedWatch?.();loadedWatch=null;activeLibrary=null;
    ++onboardingWaveEpoch;stopReference();renderCircuitSummary();schematicSidebar?.refresh();
    context={project:{id:'imported-netlist',sourceCommit:null},run:null,selection:null,loading:false,loadState:'ready',
      file:{path:openedDoc.path,currentTextSha256:null,dirty:false},geometry:{bundleCommit:null,manifestSha256:null,sourceMatch:null,state:'snapshot'}};
    $('studio-project').replaceChildren(new Option('已导入网表','imported-netlist'));$('studio-entry').replaceChildren(new Option(openedDoc.name||openedDoc.path,openedDoc.path));$('studio-run').replaceChildren(new Option('未关联仿真运行',''));
    $('studio-native-note').textContent='已导入网表 · 在 Simulation 配置服务器与 PDK';emit();void showEnvironment().catch(panelError);
    if(snapshot)void sha256(snapshot.text).then(hash=>{if(doc===openedDoc&&context.file?.path===openedDoc.path){context={...context,file:{...context.file,currentTextSha256:hash}};emit();}});
  });
  const aiLoader=whenVisible(ui.slots.ai,async()=>{
    const module=await import('../remote/panel.js');
    const handle=module.mountRemoteNode(host);
    remoteAI=handle;
    handle.subscribeConnection(()=>{
      const connected=host.onboarding.getState().connected||host.libraryBridge.getState().connected||Boolean(handle.getConnectionState().connected);
      $('studio-identity').textContent=connected?'本机已连接':'网页模式';
      workspaceHub?.update();welcomeGuide?.update();
    });
    if(pairedFromOnboarding)void handle.adoptClient(pairedFromOnboarding.client,pairedFromOnboarding.info,{local:pairedFromOnboarding.local});
    workspaceHub?.update();welcomeGuide?.update();
    return handle;
  },{onError:panelError});agentAssistance.setLoader(()=>aiLoader.ensure());
  const readHubStatus=()=>{
    const ob=host.onboarding.getState(),aiState=remoteAI?.getConnectionState?.()||{};
    const lib=host.libraryBridge.getState();
    return {ai:Boolean(aiState.connected),simulation:Boolean(ob.connected),library:Boolean(lib.connected),connecting:Boolean(ob.connecting||aiState.connecting),detail:ob.endpoint?'连接器地址：'+ob.endpoint:''};
  };
  const subscribeHub=fn=>{const off1=host.onboarding.subscribe(fn),off2=host.libraryBridge.subscribe(fn),off3=contextAdapter.subscribe(fn);return()=>{off1?.();off2?.();off3?.();};};
  const connectDirect=()=>remoteAI
    ? remoteAI.connectLocal()
    : host.onboarding.connect().then(()=>{void aiLoader.ensure();}).catch(e=>{
        const msg=String(e?.message||e||'');
        if(/未检测到本机连接助手/.test(msg))workspaceHub?.open({feature:'连接本机 Agent 与远端 SSH 仿真'});
        ui.notify(msg,{kind:'error'});
      });
  workspaceHub=mountWorkspaceHub({
    toolbar:$('studio-toolbar'),
    mode:'demo',
    getStatus:readHubStatus,
    subscribe:subscribeHub,
    onConnect:connectDirect,
    onDisconnect:()=>{remoteAI?.disconnect?.();host.onboarding.disconnect();},
    onOpenAI:()=>{ui.slots.ai.setVisible(true);void aiLoader.ensure();},
    onOpenSimulation:()=>{void showEnvironment().catch(panelError);},
  });
  projectImporter=createProjectImporter({
    doc:document,
    onboarding:host.onboarding,
    getConnected:()=>Boolean(host.onboarding.getState().connected),
    subscribe:subscribeHub,
    onConnect:connectDirect,
    onOpenHub:()=>workspaceHub?.open({feature:'从 SSH 服务器浏览并导入网表'}),
    onImport:importNetlistProject,
    notify:ui.notify,
  });
  host.openProjectImport=(tab='local')=>projectImporter.open(tab);
  welcomeGuide=mountWelcomeGuide({
    toolbar:$('studio-toolbar'),
    anchor:document.getElementById('studio-dockview')||document.getElementById('studio-workspace')||$('studio-toolbar').nextElementSibling,
    getStatus:readHubStatus,
    subscribe:subscribeHub,
    getCurrentProject:()=>importedProject?{origin:importedProject.origin,name:importedProject.name,label:importedProject.label}:activeLibrary?{libraryId:activeLibrary.library.id,cellId:activeLibrary.cell.id,label:activeLibrary.library.name}:{libraryId:'basics',cellId:'rc-smoke',label:'RC · 入门电路'},
    onConnect:connectDirect,
    onOpenProject:item=>host.openProjectCanvas(item),
    onImportLocal:()=>projectImporter.openLocal(),
    onImportSsh:()=>projectImporter.openSsh(),
    onBrowseProjects:()=>libraryManager.show(),
    onOpenAI:()=>{ui.slots.ai.setVisible(true);void aiLoader.ensure();},
    onOpenSimulation:()=>{void showEnvironment().catch(panelError);},
    onOpenHub:()=>workspaceHub?.open(),
  });
  host.requireLocalConnector=feature=>workspaceHub?.requireConnector(feature);
  const versionLoader=whenVisible(ui.slots.versions,async()=>{const {mountLibraryVersions}=await import('../library/versions.js');libraryVersions=mountLibraryVersions({element:ui.slots.versions.element,getSelection:libraryVersionSelection,subscribeSelection:fn=>contextAdapter.subscribe(fn),bridge:host.libraryBridge,notify:ui.notify,onBrowse:()=>libraryManager.show(),onOpenWorking:openWorkingLibrary,deferLoad:true,onActivate:ensureVersionSelection});return libraryVersions;},{onError:panelError});
  setPane('files');setBackground('light',{persist:false});
  await openSource(referenceSource(source),false);
  if(!doc||doc.failed||doc.diagnostics.some(d=>d.severity==='error'))throw Error('RC schematic failed to compile');
  fit();schematicSidebar?.refresh();schematicEditor?.resetBaselines();ui.setNativeState({loading:false,hidden:false});$('studio-native-note').textContent='内置 RC 入门电路 · RNL 布局 · 连接本机后可跑真实远端 Spectre 仿真';
  document.body.dataset.studioState='ready';
  if(loadSessionGrant(window.sessionStorage)){void aiLoader.ensure().then(handle=>handle?.tryResumeSession?.()).catch(()=>{});}
  ui.notify('欢迎使用 CircuitGit。打开电路库选择电路，或点击顶栏「连接本机」接入远端 SSH 仿真与 AI。');
  // Auto-show two voltage references after the shared catalog has loaded.
  function showReferenceTraces(){
    referenceObserver?.disconnect();
    const ready=()=>{if(!referenceActive()||onboardingWaves)return true;const buttons=ui.slots.waveforms.element.querySelectorAll('[data-signal-id]');if(buttons.length>=2){buttons[0].click();buttons[1].click();return true;}return false;};
    if(!ready()){const observer=new MutationObserver(()=>{if(ready())observer.disconnect();});referenceObserver=observer;observer.observe(ui.slots.waveforms.element,{subtree:true,childList:true});setTimeout(()=>observer.disconnect(),10000);}
  }
  showReferenceTraces();
  window.CircuitGitDemo=Object.freeze({getContext:contextAdapter.getContext,get reference(){return referenceActive();},getLibrarySelection:()=>activeLibrary?{library:activeLibrary.library.id,cell:activeLibrary.cell.id,view:activeLibrary.view.id,files:[...activeLibrary.bundle.paths]}:null});
  return host;
}
