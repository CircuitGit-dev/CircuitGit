import {createLayout} from '../studio/layout.js';
import {whenVisible} from '../studio/lazy-slot.js';
import {openSource,showBuilt,adoptSource,isLoading} from '../vendor/rnl-viewer/open.js';
import {doc,current,selected} from '../vendor/rnl-viewer/state.js';
import {dirtyPaths,unappliedPaths,resetBuffers,hasBuffer,fileText} from '../vendor/rnl-viewer/edits.js';
import {shell} from '../vendor/rnl-viewer/shell.js';
import {sourceOpened} from '../vendor/rnl-viewer/pool.js';
import {previewing} from '../vendor/rnl-viewer/solve.js';
import {fit} from '../vendor/rnl-viewer/drawing.js';
import {setSidebarWidth,setPane} from '../vendor/rnl-viewer/panels.js';
import {registerStudioCommand} from '../vendor/rnl-viewer/commands.js';
import {setBackground} from '../vendor/rnl-viewer/background.js';
import {sha256} from '../core.js';
import {reference,referenceWindow} from './reference.js';
import {mountLibraryManager} from '../library/panel.js';
import {createLibraryClient} from '../library/model.js';
import {createLibraryBridge} from '../remote/library-bridge.js';
import {createOnboardingBridge,snapshotOnboardingSource} from '../remote/onboarding-bridge.js';
import {createOnboardingSync} from '../remote/onboarding-sync.js';
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

function download(name,text,type='text/plain') {
  const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function section(root,html){root.replaceChildren();const e=document.createElement('div');e.className='demo-section';e.innerHTML=html;root.append(e);return e;}
function dialog(title,content) {
  const d=document.createElement('dialog');d.className='demo-dialog';d.setAttribute('aria-label',title);const h=document.createElement('h2');h.textContent=title;
  const close=document.createElement('button');close.textContent='关闭';close.onclick=()=>{d.close();d.remove();};
  d.append(h,content,close);document.body.append(d);d.addEventListener('cancel',()=>d.remove(),{once:true});d.showModal();return d;
}

/** Static RC demo. A separate AI node connection starts only after explicit user authorization. */
export async function mountStudio({ui:providedUI}={}) {
  const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url);document.head.append(css);
  const ui=providedUI||await createLayout();document.body.classList.add('circuitgit-demo');document.title='CircuitGit · Interactive demo';
  // Dockview can temporarily detach inactive tab containers. Resolve owned controls
  // within their panel roots, including while restoring a saved layout.
  const $=id=>document.getElementById(id)||Object.values(ui.slots).map(slot=>slot.element?.querySelector('#'+id)).find(Boolean);
  const brand=document.querySelector('.studio-brand');
  brand.replaceChildren();const image=document.createElement('img');image.src=new URL('../branding/circuitgit.svg',import.meta.url);image.alt='';brand.append(image,document.createTextNode('CircuitGit'));
  $('studio-project').replaceChildren(new Option('RC · 公开示例','rc-demo'));$('studio-project').disabled=true;
  $('studio-entry').replaceChildren(new Option('手工固定布局 · RNL','rc'));$('studio-entry').disabled=true;
  $('studio-run').replaceChildren(new Option('解析参考 · 非 Spectre','reference'));$('studio-run').disabled=true;
  $('studio-identity').textContent='Public demo';$('studio-identity').className='demo-badge';
  const repository=document.createElement('a');repository.href=REPO;repository.textContent='GitHub ↗';repository.target='_blank';repository.rel='noopener';repository.className='demo-link';$('studio-toolbar').append(repository);
  const fav=document.createElement('link');fav.rel='icon';fav.type='image/svg+xml';fav.href=new URL('../branding/circuitgit-small.svg',import.meta.url);document.head.append(fav);
  const baseText=await fetch(new URL('./rc.scs',import.meta.url)).then(r=>{if(!r.ok)throw Error('RC example unavailable');return r.text();});
  let source=baseText,hash=await sha256(source),points=null,plotController=null,mode='none';
  let activeLibrary=null,versionSelection=null,libraryVersions=null,switching=false,waveformMount=null,referenceObserver=null,onboardingWaves=false,onboardingWaveEpoch=0;
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
  const host={version:1,slots:ui.slots,context:contextAdapter,notify:ui.notify,registerCommand:register,
    getRuns:()=>referenceActive()?jobs:[],refresh:async()=>{},selectRun:async id=>{requireReference(id);context.run={runId:id};emit();},
    plot:{attach(controller){plotController=controller;controller.setPlotMode(mode);return()=>controller.destroy();}}};
  host.libraryBridge=createLibraryBridge();
  host.onboarding=createOnboardingBridge({win:window});
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
  const simulationHeading=document.createElement('h2');simulationHeading.textContent='仿真';
  const simulationNav=document.createElement('nav');simulationNav.className='ic-sim-nav';simulationNav.style.gridTemplateColumns='repeat(2,minmax(0,1fr))';simulationNav.setAttribute('aria-label','仿真工作流');
  const environmentTab=document.createElement('button'),referenceTab=document.createElement('button');environmentTab.type=referenceTab.type='button';
  environmentTab.textContent='连接与 PDK';environmentTab.dataset.field='page-environment';referenceTab.textContent='RC 解析参考';referenceTab.dataset.field='page-reference';simulationNav.append(environmentTab,referenceTab);
  const environmentPage=document.createElement('div'),referencePage=document.createElement('div');environmentPage.className=referencePage.className='ic-sim-page';environmentPage.dataset.page='environment';referencePage.dataset.page='reference';
  const environmentTitle=document.createElement('h3');environmentTitle.textContent='连接服务器 & 自动匹配 PDK';
  const libraryInfo=document.createElement('div'),environmentRoot=document.createElement('section');environmentPage.append(environmentTitle,environmentRoot,libraryInfo);
  simulationShell.append(simulationHeading,simulationNav,environmentPage,referencePage);ui.slots.simulation.element.replaceChildren(simulationShell);
  const simulationStyle=document.createElement('link');simulationStyle.rel='stylesheet';simulationStyle.href=new URL('../../../modules/simulation/style.css',import.meta.url);document.head.append(simulationStyle);
  let simulationPage='environment',environmentMount=null,unregisterEnvironment=null;
  function renderSimulationPage(){
    environmentPage.hidden=simulationPage!=='environment';referencePage.hidden=simulationPage!=='reference';referenceTab.disabled=!referenceActive();
    for(const [tab,id] of [[environmentTab,'environment'],[referenceTab,'reference']]){tab.classList.toggle('is-active',simulationPage===id);tab.setAttribute('aria-pressed',String(simulationPage===id));}
  }
  const environmentLoader=whenVisible(ui.slots.simulation,async()=>{
    environmentRoot.textContent='正在打开环境配置…';
    try{const {mountEnvironmentWizard}=await import('../../../modules/simulation/environment/panel.js');
      environmentMount=mountEnvironmentWizard(environmentRoot,{adapter:host.onboarding,pendingStore:host.onboarding.pendingStore,getSource:host.getOnboardingSource,openWaveforms:host.openOnboardingWaveforms,notify:ui.notify,onRun:job=>ui.notify('仿真请求已登记：'+(job.job_id||job.run_id||'')+'；请在环境页查看原任务进度。')});
      unregisterEnvironment=host.onboardingSync.register(environmentMount.controller);return environmentMount;
    }catch(error){environmentRoot.textContent='环境配置加载失败：'+error.message;throw error;}
  },{onError:error=>ui.notify(error.message,{kind:'error'})});
  async function showEnvironment(){
    simulationPage='environment';renderSimulationPage();ui.slots.simulation.setVisible(true);return environmentLoader.ensure();
  }
  function showReferenceConfiguration(){if(!referenceActive())return;simulationPage='reference';renderSimulationPage();ui.slots.simulation.setVisible(true);}
  environmentTab.onclick=()=>void showEnvironment().catch(error=>ui.notify(error.message,{kind:'error'}));referenceTab.onclick=showReferenceConfiguration;renderSimulationPage();
  window.addEventListener('pagehide',()=>{environmentLoader.dispose();unregisterEnvironment?.();environmentMount?.destroy();host.onboardingSync.destroy();host.onboarding.disconnect();},{once:true});
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

  function setMode(value){if(value!=='none'&&(!referenceActive()||onboardingWaves))throw Error('当前波形未建立电路节点映射，请从信号列表添加曲线。');mode=value;plotController?.setPlotMode(value);$('studio-plot-state').hidden=value==='none';$('studio-plot-state').textContent=value==='voltage'?'电压探针 · Esc退出':value==='current'?'电流探针 · R0 端口1 · Esc退出':'';}
  for(const [value,label] of [['voltage','电压探针：点击 in / out'],['current','电流探针：点击 R0']])register({id:'plot.'+value,menu:'plot',label,enabled:()=>referenceActive()&&!onboardingWaves,run:async()=>{if(!referenceActive()||onboardingWaves)throw Error('当前波形未建立电路节点映射。');ui.slots.waveforms.setVisible(true);await mountReferenceWaves();if(!referenceActive()||!plotController)return;plotController.openWindow();setMode(value);ui.notify(label);},checked:()=>mode===value});
  register({id:'plot.exit',menu:'plot',label:'退出探针 (Esc)',run:()=>setMode('none')});
  register({id:'window.reset',menu:'window',label:'恢复默认布局',run:()=>ui.resetLayout()});
  register({id:'git.history',menu:'git',label:'电路版本管理',run:async()=>{ui.slots.versions.setVisible(true);const versions=await versionLoader.ensure();await versions.activate();}});
  register({id:'project.source',menu:'project',label:'查看 / 下载示例网表',run:()=>showSource()});
  register({id:'simulation.export',menu:'simulation',label:'导出仿真配置 JSON',enabled:()=>referenceActive(),run:()=>exportConfiguration()});
  register({id:'simulation.local',menu:'simulation',label:'如何连接本地仿真',run:()=>showGuide()});
  register({id:'simulation.environment',menu:'simulation',label:'连接服务器与匹配 PDK',run:showEnvironment});
  register({id:'simulation.reference',menu:'simulation',label:'RC 解析参考配置',enabled:referenceActive,run:showReferenceConfiguration});
  register({id:'window.help.demo',menu:'help',label:'CircuitGit 演示与本地使用',run:()=>showGuide()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&mode!=='none'){setMode('none');ui.notify('已退出探针。');}});
  window.addEventListener('viewer-selection',()=>{
    if(mode==='none')return;
    if(doc?.path!==PATH||dirtyPaths().length||unappliedPaths().length){ui.notify('示例源已修改或已切换文档；请重置示例后使用参考探针。',{kind:'warning'});return;}
    const object=doc?.objects[selected];if(!object)return;
    const kind=mode==='voltage'?'net':'instance';if(object.kind!==kind)return;
    if(mode==='voltage'&&!['in','out'].includes(object.name)||mode==='current'&&object.name!=='R0'){ui.notify('此公开示例提供 V(in)、V(out) 与 I(R0:1)。');return;}
    context.selection={kind:mode==='current'?'terminal':'net',name:object.name,terminalName:mode==='current'?'1':null,
      scope:'(top)',viewerSourcePath:PATH,nativeEntryId:'rc-demo',occurrencePath:[]};emit();plotController.onSelection(contextAdapter.getContext());
  });
  section(referencePage,`<small>RC LOW-PASS · TRANSIENT</small><h2>仿真配置</h2>
    <p>修改参数可更新解析参考曲线，或导出配置交给本地 Spectre 工作流。</p>
    <div class="demo-fields"><label>电阻 R (Ω)<input id="demo-r" type="number" min="1" max="1000000" value="1000"></label><label>电容 C (pF)<input id="demo-c" type="number" min="0.01" max="1000" step="0.1" value="1"></label><label>终止时间 (ns)<input id="demo-stop" type="number" min="2" max="50" value="12"></label></div>
    <div class="demo-actions"><button id="demo-update" class="primary">更新参考曲线</button><button id="demo-export">导出配置</button></div>
    <h3>保存与查看的信号</h3><span class="demo-signal">V(in) · V(out)</span><span class="demo-signal">I(R0:1) · 流入 R0 端口 1</span>
    <h3>当前数据</h3><p id="demo-basis">R = 1 kΩ · C = 1 pF · τ = 1 ns</p><p>波形由 RC 方程在浏览器计算，未提交仿真任务。</p><button id="demo-guide">连接仿真环境 →</button>`);
  function readParameters(){const r=Number($('demo-r').value),c=Number($('demo-c').value),stop=Number($('demo-stop').value);
    if(!Number.isFinite(r)||r<1||r>1e6||!Number.isFinite(c)||c<.01||c>1000||!Number.isFinite(stop)||stop<2||stop>50)throw Error('参数范围：R 1–1000000 Ω，C 0.01–1000 pF，时间 2–50 ns。');
    return {resistance:r,capacitance:c*1e-12,stop:stop*1e-9};}
  function configuration(p){return {description:'CircuitGit RC transient configuration',parameters:{},analysis:{stop:p.stop,maxstep:50e-12},save:{mode:'replace',signals:['in','out','R0:1']},postprocess:{start_s:0,end_s:p.stop,step_s:5e-12,max_display_points:4000,signals:[{name:'in',unit:'V'},{name:'out',unit:'V'},{name:'R0:1',unit:'A'}]}};}
  function textFor(p){return baseText.replace('r=1k','r='+p.resistance).replace('c=1p','c='+p.capacitance).replace('stop=12n','stop='+p.stop).replace('"1 kOhm"',JSON.stringify(p.resistance+' Ohm')).replace('"1 pF"',JSON.stringify(Number((p.capacitance*1e12).toPrecision(6))+' pF'));}
  function exportConfiguration(){if(!referenceActive())throw Error('请从 Library Manager 查看该单元的 simulation 文件；RC 配置不适用于此视图。');const p=readParameters();download('TRAN.json',JSON.stringify(configuration(p),null,2)+'\n','application/json');download('circuit.scs',textFor(p));ui.notify('已导出 TRAN.json 与 circuit.scs；未启动仿真。');}
  async function rebuild(){if(!referenceActive())return;const p=readParameters();$('demo-update').disabled=true;
    try{parameters=p;source=textFor(p);hash=await sha256(source);points=null;signals.forEach(s=>s.domain=[0,p.stop]);
      context={...context,run:null,selection:null,file:{path:PATH,currentTextSha256:hash,dirty:false},geometry:{...context.geometry,manifestSha256:hash}};emit();
      await openSource({name:'circuitgit-demo.scs',path:PATH,text:source},false);fit();context.run={runId:RUN};emit();
      $('demo-basis').textContent=`R = ${p.resistance} Ω · C = ${Number((p.capacitance*1e12).toPrecision(6))} pF · τ = ${Number((p.resistance*p.capacitance*1e9).toPrecision(5))} ns`;
      ui.notify('参考曲线已更新；在波形列表中重新选择要查看的信号。');
    }finally{$('demo-update').disabled=false;}}
  $('demo-update').onclick=()=>rebuild().catch(e=>ui.notify(e.message,{kind:'error'}));$('demo-export').onclick=()=>{try{exportConfiguration();}catch(e){ui.notify(e.message,{kind:'error'});}};$('demo-guide').onclick=()=>void showEnvironment().catch(panelError);
  function showSource(){const area=document.createElement('textarea');area.readOnly=true;area.value=activeLibrary?activeLibrary.bundle.text:source;dialog(activeLibrary?activeLibrary.cell.name+' · '+activeLibrary.view.label:'RC 示例网表 · 含固定 RNL 布局',area);}
  function showGuide(){const e=document.createElement('div');e.className='demo-section';e.innerHTML=`<p>本页直接运行 RNL Viewer、Dockview 和共享波形组件，可拖动、关闭、浮动及放回面板。</p><p>Plot → 电压探针，点击 in 或 out；电流探针可查看 R0 端口 1。波形支持滚轮、拖动、F 适配，M 查看测量。</p><p>AI 面板点击“连接本机 Codex”，在本机助手弹窗中确认授权后即可检查登录；未登录时可继续打开官方登录页。首次需要启动项目包中的连接助手。自己的服务器可在“高级”设置中连接。原理图与波形仍是公开 RC 示例；AI 工程以助手返回的身份为准。</p><p><a href="${REPO}/blob/main/docs/remote-node.md" target="_blank" rel="noopener">首次配置 Codex 运行节点 ↗</a></p><p>需要完整本地工程界面时，可启动自己的网关并配置授权 Cadence 环境：</p><pre>git clone ${REPO}.git
cd CircuitGit
python3 -B tools/workbench/launch.py</pre><p><a href="${REPO}/blob/main/docs/getting-started.md" target="_blank" rel="noopener">安装与连接说明 ↗</a></p>`;dialog('CircuitGit 使用说明',e);}
  $('studio-source-button').onclick=showSource;
  const libraryManager=mountLibraryManager({toolbar:$('studio-toolbar'),libraryPane:$('pane-files'),onOpen:openLibrary,onReference:openReference,onSelection:value=>{versionSelection=value;emit();},notify:ui.notify});
  register({id:'project.library',menu:'project',label:'Library Manager…',run:()=>libraryManager.show()});
  register({id:'project.reference',menu:'project',label:'返回 RC 解析参考',run:openReference});
  function stopReference(){
    onboardingWaves=false;
    setMode('none');referenceObserver?.disconnect();referenceObserver=null;waveformMount?.destroy();waveformMount=null;plotController=null;
    const root=ui.slots.waveforms.element;root.replaceChildren();root.classList.remove('wf-panel','wf-minimal');root.removeAttribute('title');root.setAttribute('aria-label','库视图的数据状态');
    const empty=document.createElement('section');empty.className='cg-library-empty-wave';
    const heading=document.createElement('strong'),note=document.createElement('p');heading.textContent='此视图尚未关联仿真波形';note.textContent='已清除 RC 解析参考。公开原理图与运行结果分别管理，加载电路不会启动仿真。';empty.append(heading,note);root.append(empty);
  }
  function libraryInformation(value){
    const box=document.createElement('details');box.className='ic-sim-detail';const summary=document.createElement('summary');summary.textContent='当前电路';box.append(summary);
    const title=document.createElement('h2');title.textContent=value.cell.name;const name=document.createElement('p');name.textContent=value.library.name+' / '+value.view.label;
    const evidence=document.createElement('p');evidence.textContent=(value.origin==='working'?'本机原理图快照':'公开原理图预览')+' · '+value.bundle.paths.length+' 个已列出的文件。未关联运行，也未执行仿真。';
    const dependency=document.createElement('p');dependency.textContent=value.cell.requires_external_models?'重放可能需要外部模型。请查看单元说明和已有配置。':'重放要求以单元说明和已有配置为准。';
    const ai=document.createElement('p');ai.textContent='AI 使用连接节点返回的工程身份；此公开库选择不会切换 AI 工程。';
    const browse=document.createElement('button');browse.type='button';browse.textContent='查看库视图与说明';browse.onclick=()=>libraryManager.show();
    const environment=document.createElement('button');environment.type='button';environment.textContent='连接仿真环境';environment.onclick=()=>void showEnvironment().catch(panelError);
    const back=document.createElement('button');back.type='button';back.textContent='回到 RC 参考';back.onclick=()=>void openReference().catch(e=>ui.notify(e.message,{kind:'error'}));
    box.append(title,name,evidence,dependency,ai,environment,document.createTextNode(' '),browse,document.createTextNode(' '),back);libraryInfo.replaceChildren(box);simulationPage='environment';renderSimulationPage();
  }
  async function openLibrary(value){
    if(switching)return false;
    if(!await confirmLeave('打开公开库视图'))return false;
    hotController?.abort();loadedWatch?.();loadedWatch=null;
    ++onboardingWaveEpoch;switching=true;activeLibrary=value;versionSelection=value;stopReference();libraryInformation(value);
    $('studio-project').replaceChildren(new Option(value.library.name,value.library.id));$('studio-entry').replaceChildren(new Option(value.cell.name+' / '+value.view.label,value.view.entry));$('studio-run').replaceChildren(new Option('未关联仿真运行',''));
    context={project:{id:(value.origin==='working'?'local-library:':'public-library:')+value.library.id+':'+value.cell.id,sourceCommit:value.origin==='working'?value.base_commit:null,libraryId:value.library.id,cellId:value.cell.id},run:null,selection:null,loading:true,loadState:'loading',file:{path:value.bundle.source.path,currentTextSha256:null,dirty:false},geometry:{bundleCommit:null,manifestSha256:null,sourceMatch:null,state:'snapshot'}};emit();
    ui.setNativeState({loading:true,hidden:false});$('studio-native-note').textContent='读取公开库视图…';
    try{
      const opened=await openSource(value.bundle.source,false,undefined,false,null,null,true);
      if(!opened||!doc||doc.path!==value.bundle.source.path||doc.failed)throw Error('库视图未能完成加载；请查看 RNL 诊断。');
      if(value.view.level!==undefined){const level=value.view.level==='@top'?0:doc.levels.findIndex(l=>l.title===value.view.level);if(level<0)throw Error('清单指定的原生层级不存在：'+value.view.level);await enterRoot(level,{here:true,newWindow:false});}
      const errors=doc.diagnostics.filter(d=>d.severity==='error');
      context={...context,loading:false,loadState:errors.length?'error':'ready',file:{...context.file,currentTextSha256:await sha256(value.bundle.text)}};emit();
      fit();ui.slots.schematic?.setVisible(true);$('studio-native-note').textContent=[value.library.name,value.cell.name,value.view.label].join(' / ')+(value.origin==='working'?' · 本机快照 · ':' · 公开文件 · ')+(errors.length?errors.length+' 项 RNL 诊断':'未关联仿真');
      if(errors.length)ui.notify('原理图已打开，存在 '+errors.length+' 项 RNL 诊断；请查看 Problems。',{kind:'warning'});
      watchLoadedLibrary();
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
      const opened=await openSource({name:'circuitgit-demo.scs',path:PATH,text:source},false,undefined,false,null,null,true);
      if(!opened||!doc||doc.failed||doc.diagnostics.some(d=>d.severity==='error'))throw Error('RC schematic failed to compile');
      activeLibrary=null;context={project:{id:'rc-demo',sourceCommit:null},run:{runId:RUN},selection:null,loading:false,loadState:'ready',file:{path:PATH,currentTextSha256:hash,dirty:false},geometry:{bundleCommit:null,manifestSha256:hash,sourceMatch:true,state:'ready'}};
      $('studio-project').replaceChildren(new Option('RC · 公开示例','rc-demo'));$('studio-entry').replaceChildren(new Option('手工固定布局 · RNL','rc'));$('studio-run').replaceChildren(new Option('解析参考 · 非 Spectre','reference'));
      libraryInfo.replaceChildren();$('studio-native-note').textContent='公开 RC 示例 · 固定 RNL 布局 · 波形为解析参考';switching=false;simulationPage='reference';renderSimulationPage();emit();if(ui.slots.waveforms.isVisible())await mountReferenceWaves();showReferenceTraces();fit();ui.slots.schematic?.setVisible(true);return true;
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
    if(dirtyPaths().length||unappliedPaths().length||previewing()){hotDeferred=true;sourceSyncNote('画布有未保存修改或布局预览，自动同步已暂缓。');return false;}
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
        libraryInformation(activeLibrary);emit();hotNotice='';$('studio-native-note').textContent=value.library.name+' / '+value.cell.name+' · 已同步本机原理图 · 未关联仿真';
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
    const openedDoc=doc,snapshot=host.getOnboardingSource();hotController?.abort();loadedWatch?.();loadedWatch=null;activeLibrary=null;
    ++onboardingWaveEpoch;stopReference();libraryInfo.replaceChildren();
    context={project:{id:'imported-netlist',sourceCommit:null},run:null,selection:null,loading:false,loadState:'ready',
      file:{path:openedDoc.path,currentTextSha256:null,dirty:false},geometry:{bundleCommit:null,manifestSha256:null,sourceMatch:null,state:'snapshot'}};
    $('studio-project').replaceChildren(new Option('已导入网表','imported-netlist'));$('studio-entry').replaceChildren(new Option(openedDoc.name||openedDoc.path,openedDoc.path));$('studio-run').replaceChildren(new Option('未关联仿真运行',''));
    $('studio-native-note').textContent='已导入网表 · 在 Simulation 配置服务器与 PDK';emit();void showEnvironment().catch(panelError);
    if(snapshot)void sha256(snapshot.text).then(hash=>{if(doc===openedDoc&&context.file?.path===openedDoc.path){context={...context,file:{...context.file,currentTextSha256:hash}};emit();}});
  });
  whenVisible(ui.slots.ai,()=>import('../remote/panel.js').then(module=>module.mountRemoteNode(host)),{onError:panelError});
  const versionLoader=whenVisible(ui.slots.versions,async()=>{const {mountLibraryVersions}=await import('../library/versions.js');libraryVersions=mountLibraryVersions({element:ui.slots.versions.element,getSelection:libraryVersionSelection,subscribeSelection:fn=>contextAdapter.subscribe(fn),bridge:host.libraryBridge,notify:ui.notify,onBrowse:()=>libraryManager.show(),onOpenWorking:openWorkingLibrary,deferLoad:true,onActivate:ensureVersionSelection});return libraryVersions;},{onError:panelError});
  setSidebarWidth(230);setPane('netlist');setBackground('light',{persist:false});
  await openSource({name:'circuitgit-demo.scs',path:PATH,text:source},false);
  if(!doc||doc.failed||doc.diagnostics.some(d=>d.severity==='error'))throw Error('RC schematic failed to compile');
  fit();ui.setNativeState({loading:false,hidden:false});$('studio-native-note').textContent='公开 RC 示例 · 固定 RNL 布局 · 波形为解析参考';
  document.body.dataset.studioState='ready';
  ui.notify('欢迎使用 CircuitGit。拖动标签排列窗口；Plot 菜单可选择电压或电流探针。');
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
