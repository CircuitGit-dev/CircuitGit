import {createLayout} from '../studio/layout.js';
import {mount as mountWaveforms} from '../studio/dockview/waveforms.js';
import {openSource} from '../vendor/rnl-viewer/open.js';
import {doc,current,selected} from '../vendor/rnl-viewer/state.js';
import {dirtyPaths,unappliedPaths} from '../vendor/rnl-viewer/edits.js';
import {fit} from '../vendor/rnl-viewer/drawing.js';
import {setSidebarWidth,setPane} from '../vendor/rnl-viewer/panels.js';
import {registerStudioCommand} from '../vendor/rnl-viewer/commands.js';
import {setBackground} from '../vendor/rnl-viewer/background.js';
import {sha256} from '../core.js';
import {reference,referenceWindow} from './reference.js';
import {mountRemoteNode} from '../remote/panel.js';
import {mountLibraryManager} from '../library/panel.js';
import {confirmLeave} from '../vendor/rnl-viewer/editor.js';
import {enterRoot} from '../vendor/rnl-viewer/subcircuits.js';

const REPO='https://github.com/joshuazeng713/CircuitGit';
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
  const d=document.createElement('dialog');d.className='demo-dialog';const h=document.createElement('h2');h.textContent=title;
  const close=document.createElement('button');close.textContent='关闭';close.onclick=()=>{d.close();d.remove();};
  d.append(h,content,close);document.body.append(d);d.addEventListener('cancel',()=>d.remove(),{once:true});d.showModal();return d;
}

/** Static RC demo. A separate AI node connection starts only after explicit user authorization. */
export async function mountStudio() {
  const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url);document.head.append(css);
  const ui=await createLayout();document.body.classList.add('circuitgit-demo');document.title='CircuitGit · Interactive demo';
  const $=id=>document.getElementById(id),brand=document.querySelector('.studio-brand');
  brand.replaceChildren();const image=document.createElement('img');image.src=new URL('../branding/circuitgit.svg',import.meta.url);image.alt='';brand.append(image,document.createTextNode('CircuitGit'));
  $('studio-project').replaceChildren(new Option('RC · 公开示例','rc-demo'));$('studio-project').disabled=true;
  $('studio-entry').replaceChildren(new Option('手工固定布局 · RNL','rc'));$('studio-entry').disabled=true;
  $('studio-run').replaceChildren(new Option('解析参考 · 非 Spectre','reference'));$('studio-run').disabled=true;
  $('studio-identity').textContent='Public demo';$('studio-identity').className='demo-badge';
  const repository=document.createElement('a');repository.href=REPO;repository.textContent='GitHub ↗';repository.target='_blank';repository.rel='noopener';repository.className='demo-link';$('studio-toolbar').append(repository);
  const fav=document.createElement('link');fav.rel='icon';fav.type='image/svg+xml';fav.href=new URL('../branding/circuitgit-small.svg',import.meta.url);document.head.append(fav);
  const baseText=await fetch(new URL('./rc.scs',import.meta.url)).then(r=>{if(!r.ok)throw Error('RC example unavailable');return r.text();});
  let source=baseText,hash=await sha256(source),points=reference(),plotController=null,mode='none';
  let activeLibrary=null,switching=false,waveformMount=null,referenceObserver=null;
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
    waveform:async(run,id,params)=>{requireReference(run);if(!points[id])throw Error('Unknown reference signal');return referenceWindow(points[id],params);}};
  const register=item=>registerStudioCommand({...item,run:()=>Promise.resolve().then(item.run).catch(e=>ui.notify(e.message,{kind:'error'}))});
  const host={version:1,slots:ui.slots,context:contextAdapter,notify:ui.notify,registerCommand:register,
    getRuns:()=>referenceActive()?jobs:[],refresh:async()=>{},selectRun:async id=>{requireReference(id);context.run={runId:id};emit();},
    plot:{attach(controller){plotController=controller;controller.setPlotMode(mode);return()=>controller.destroy();}}};
  function mountReferenceWaves(){waveformMount=mountWaveforms(host,{api,labels:{loaded:'已加载浏览器计算的 RC 解析参考；不是 Spectre 仿真结果。',
    catalog:'RC 解析参考信号（浏览器计算，非 PSF 导出）。',provenance:'Piecewise-linear RC analytical reference · no Spectre execution',
    measurement:'RC 解析参考 / 线性插值',dataNote:'RC 一阶方程的分段线性输入解析解；每 5 ps 取样。显示使用保峰抽样，游标使用完整参考向量。'}});}
  mountReferenceWaves();

  function setMode(value){if(value!=='none'&&!referenceActive())throw Error('此库视图没有关联波形。');mode=value;plotController?.setPlotMode(value);$('studio-plot-state').hidden=value==='none';$('studio-plot-state').textContent=value==='voltage'?'电压探针 · Esc退出':value==='current'?'电流探针 · R0 端口1 · Esc退出':'';}
  for(const [value,label] of [['voltage','电压探针：点击 in / out'],['current','电流探针：点击 R0']])register({id:'plot.'+value,menu:'plot',label,enabled:()=>referenceActive(),run:()=>{if(!referenceActive())throw Error('此库视图没有关联波形。');plotController.openWindow();setMode(value);ui.notify(label);},checked:()=>mode===value});
  register({id:'plot.exit',menu:'plot',label:'退出探针 (Esc)',run:()=>setMode('none')});
  register({id:'window.reset',menu:'window',label:'恢复默认布局',run:()=>ui.resetLayout()});
  register({id:'git.history',menu:'git',label:'项目发布记录',run:()=>ui.slots.versions.setVisible(true)});
  register({id:'project.source',menu:'project',label:'查看 / 下载示例网表',run:()=>showSource()});
  register({id:'simulation.export',menu:'simulation',label:'导出仿真配置 JSON',enabled:()=>referenceActive(),run:()=>exportConfiguration()});
  register({id:'simulation.local',menu:'simulation',label:'如何连接本地仿真',run:()=>showGuide()});
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
  const simulation=section(ui.slots.simulation.element,`<small>RC LOW-PASS · TRANSIENT</small><h2>仿真配置</h2>
    <p>修改参数可更新解析参考曲线，或导出配置交给本地 Spectre 工作流。</p>
    <div class="demo-fields"><label>电阻 R (Ω)<input id="demo-r" type="number" min="1" max="1000000" value="1000"></label><label>电容 C (pF)<input id="demo-c" type="number" min="0.01" max="1000" step="0.1" value="1"></label><label>终止时间 (ns)<input id="demo-stop" type="number" min="2" max="50" value="12"></label></div>
    <div class="demo-actions"><button id="demo-update" class="primary">更新参考曲线</button><button id="demo-export">导出配置</button></div>
    <h3>保存与查看的信号</h3><span class="demo-signal">V(in) · V(out)</span><span class="demo-signal">I(R0:1) · 流入 R0 端口 1</span>
    <h3>当前数据</h3><p id="demo-basis">R = 1 kΩ · C = 1 pF · τ = 1 ns</p><p>波形由 RC 方程在浏览器计算，未提交仿真任务。</p><button id="demo-guide">连接本地 Spectre / AI →</button>`);
  function readParameters(){const r=Number($('demo-r').value),c=Number($('demo-c').value),stop=Number($('demo-stop').value);
    if(!Number.isFinite(r)||r<1||r>1e6||!Number.isFinite(c)||c<.01||c>1000||!Number.isFinite(stop)||stop<2||stop>50)throw Error('参数范围：R 1–1000000 Ω，C 0.01–1000 pF，时间 2–50 ns。');
    return {resistance:r,capacitance:c*1e-12,stop:stop*1e-9};}
  function configuration(p){return {description:'CircuitGit RC transient configuration',parameters:{},analysis:{stop:p.stop,maxstep:50e-12},save:{mode:'replace',signals:['in','out','R0:1']},postprocess:{start_s:0,end_s:p.stop,step_s:5e-12,max_display_points:4000,signals:[{name:'in',unit:'V'},{name:'out',unit:'V'},{name:'R0:1',unit:'A'}]}};}
  function textFor(p){return baseText.replace('r=1k','r='+p.resistance).replace('c=1p','c='+p.capacitance).replace('stop=12n','stop='+p.stop).replace('"1 kOhm"',JSON.stringify(p.resistance+' Ohm')).replace('"1 pF"',JSON.stringify(Number((p.capacitance*1e12).toPrecision(6))+' pF'));}
  function exportConfiguration(){if(!referenceActive())throw Error('请从 Library Manager 查看该单元的 simulation 文件；RC 配置不适用于此视图。');const p=readParameters();download('TRAN.json',JSON.stringify(configuration(p),null,2)+'\n','application/json');download('circuit.scs',textFor(p));ui.notify('已导出 TRAN.json 与 circuit.scs；未启动仿真。');}
  async function rebuild(){if(!referenceActive())return;const p=readParameters();$('demo-update').disabled=true;
    try{parameters=p;source=textFor(p);hash=await sha256(source);points=reference(p);signals.forEach(s=>s.domain=[0,p.stop]);
      context={...context,run:null,selection:null,file:{path:PATH,currentTextSha256:hash,dirty:false},geometry:{...context.geometry,manifestSha256:hash}};emit();
      await openSource({name:'circuitgit-demo.scs',path:PATH,text:source},false);fit();context.run={runId:RUN};emit();
      $('demo-basis').textContent=`R = ${p.resistance} Ω · C = ${Number((p.capacitance*1e12).toPrecision(6))} pF · τ = ${Number((p.resistance*p.capacitance*1e9).toPrecision(5))} ns`;
      ui.notify('参考曲线已更新；在波形列表中重新选择要查看的信号。');
    }finally{$('demo-update').disabled=false;}}
  $('demo-update').onclick=()=>rebuild().catch(e=>ui.notify(e.message,{kind:'error'}));$('demo-export').onclick=()=>{try{exportConfiguration();}catch(e){ui.notify(e.message,{kind:'error'});}};$('demo-guide').onclick=showGuide;
  function showSource(){const area=document.createElement('textarea');area.readOnly=true;area.value=activeLibrary?activeLibrary.bundle.text:source;dialog(activeLibrary?activeLibrary.cell.name+' · '+activeLibrary.view.label:'RC 示例网表 · 含固定 RNL 布局',area);}
  function showGuide(){const e=document.createElement('div');e.className='demo-section';e.innerHTML=`<p>本页直接运行 RNL Viewer、Dockview 和共享波形组件，可拖动、关闭、浮动及放回面板。</p><p>Plot → 电压探针，点击 in 或 out；电流探针可查看 R0 端口 1。波形支持滚轮、拖动、F 适配，M 查看测量。</p><p>AI 面板点击“连接本机 Codex”，在本机助手弹窗中确认授权后即可检查登录；未登录时可继续打开官方登录页。首次需要启动项目包中的连接助手。自己的服务器可在“高级”设置中连接。原理图与波形仍是公开 RC 示例；AI 工程以助手返回的身份为准。</p><p><a href="${REPO}/blob/main/docs/remote-node.md" target="_blank" rel="noopener">首次配置 Codex 运行节点 ↗</a></p><p>需要完整本地工程界面时，可启动自己的网关并配置授权 Cadence 环境：</p><pre>git clone ${REPO}.git
cd CircuitGit
python3 -B tools/workbench/launch.py</pre><p><a href="${REPO}/blob/main/docs/getting-started.md" target="_blank" rel="noopener">安装与连接说明 ↗</a></p>`;dialog('CircuitGit 使用说明',e);}
  $('studio-source-button').onclick=showSource;
  const libraryManager=mountLibraryManager({toolbar:$('studio-toolbar'),libraryPane:$('pane-files'),onOpen:openLibrary,onReference:openReference,notify:ui.notify});
  register({id:'project.library',menu:'project',label:'Library Manager…',run:()=>libraryManager.show()});
  register({id:'project.reference',menu:'project',label:'返回 RC 解析参考',run:openReference});
  function stopReference(){
    setMode('none');referenceObserver?.disconnect();referenceObserver=null;waveformMount?.destroy();waveformMount=null;plotController=null;
    const root=ui.slots.waveforms.element;root.replaceChildren();root.classList.remove('wf-panel','wf-minimal');root.removeAttribute('title');root.setAttribute('aria-label','库视图的数据状态');
    const empty=document.createElement('section');empty.className='cg-library-empty-wave';
    const heading=document.createElement('strong'),note=document.createElement('p');heading.textContent='此视图尚未关联仿真波形';note.textContent='已清除 RC 解析参考。公开原理图与运行结果分别管理，加载电路不会启动仿真。';empty.append(heading,note);root.append(empty);
  }
  function libraryInformation(value){
    simulation.remove();const box=document.createElement('section');box.className='cg-library-preview-info';
    const title=document.createElement('h2');title.textContent=value.cell.name;const name=document.createElement('p');name.textContent=value.library.name+' / '+value.view.label;
    const evidence=document.createElement('p');evidence.textContent='公开原理图预览 · '+value.bundle.paths.length+' 个已列出的文件。未关联运行，也未执行仿真。';
    const dependency=document.createElement('p');dependency.textContent=value.cell.requires_external_models?'重放可能需要外部模型。请查看单元说明和已有配置。':'重放要求以单元说明和已有配置为准。';
    const ai=document.createElement('p');ai.textContent='AI 使用连接节点返回的工程身份；此公开库选择不会切换 AI 工程。';
    const browse=document.createElement('button');browse.type='button';browse.textContent='查看库视图与说明';browse.onclick=()=>libraryManager.show();
    const back=document.createElement('button');back.type='button';back.textContent='回到 RC 参考';back.onclick=()=>void openReference().catch(e=>ui.notify(e.message,{kind:'error'}));
    box.append(title,name,evidence,dependency,ai,browse,document.createTextNode(' '),back);ui.slots.simulation.element.replaceChildren(box);
  }
  async function openLibrary(value){
    if(switching)return false;
    if(!await confirmLeave('打开公开库视图'))return false;
    switching=true;activeLibrary=value;stopReference();libraryInformation(value);
    $('studio-project').replaceChildren(new Option(value.library.name,value.library.id));$('studio-entry').replaceChildren(new Option(value.cell.name+' / '+value.view.label,value.view.entry));$('studio-run').replaceChildren(new Option('未关联仿真运行',''));
    context={project:{id:'public-library:'+value.library.id+':'+value.cell.id,sourceCommit:null,libraryId:value.library.id,cellId:value.cell.id},run:null,selection:null,loading:true,loadState:'loading',file:{path:value.bundle.source.path,currentTextSha256:null,dirty:false},geometry:{bundleCommit:null,manifestSha256:null,sourceMatch:null,state:'snapshot'}};emit();
    ui.setNativeState({loading:true,hidden:false});$('studio-native-note').textContent='读取公开库视图…';
    try{
      const opened=await openSource(value.bundle.source,false,undefined,false,null,null,true);
      if(!opened||!doc||doc.path!==value.bundle.source.path||doc.failed)throw Error('库视图未能完成加载；请查看 RNL 诊断。');
      if(value.view.level!==undefined){const level=value.view.level==='@top'?0:doc.levels.findIndex(l=>l.title===value.view.level);if(level<0)throw Error('清单指定的原生层级不存在：'+value.view.level);await enterRoot(level,{here:true,newWindow:false});}
      const errors=doc.diagnostics.filter(d=>d.severity==='error');
      context={...context,loading:false,loadState:errors.length?'error':'ready',file:{...context.file,currentTextSha256:await sha256(value.bundle.text)}};emit();
      fit();ui.slots.schematic?.setVisible(true);$('studio-native-note').textContent=[value.library.name,value.cell.name,value.view.label].join(' / ')+' · 公开文件 · '+(errors.length?errors.length+' 项 RNL 诊断':'未关联仿真');
      if(errors.length)ui.notify('原理图已打开，存在 '+errors.length+' 项 RNL 诊断；请查看 Problems。',{kind:'warning'});
      return true;
    }catch(error){context={...context,loading:false,loadState:'error'};emit();$('studio-native-note').textContent='库视图加载失败 · '+value.cell.name+' · 未关联仿真';throw error;}
    finally{switching=false;ui.setNativeState({loading:false,hidden:false});}
  }
  async function openReference(){
    if(switching)return false;
    if(!await confirmLeave('返回 RC 解析参考'))return false;
    switching=true;stopReference();context={...context,run:null,selection:null,loading:true};emit();ui.setNativeState({loading:true,hidden:false});
    try{
      const opened=await openSource({name:'circuitgit-demo.scs',path:PATH,text:source},false,undefined,false,null,null,true);
      if(!opened||!doc||doc.failed||doc.diagnostics.some(d=>d.severity==='error'))throw Error('RC schematic failed to compile');
      activeLibrary=null;context={project:{id:'rc-demo',sourceCommit:null},run:{runId:RUN},selection:null,loading:false,loadState:'ready',file:{path:PATH,currentTextSha256:hash,dirty:false},geometry:{bundleCommit:null,manifestSha256:hash,sourceMatch:true,state:'ready'}};
      $('studio-project').replaceChildren(new Option('RC · 公开示例','rc-demo'));$('studio-entry').replaceChildren(new Option('手工固定布局 · RNL','rc'));$('studio-run').replaceChildren(new Option('解析参考 · 非 Spectre','reference'));
      ui.slots.simulation.element.replaceChildren(simulation);$('studio-native-note').textContent='公开 RC 示例 · 固定 RNL 布局 · 波形为解析参考';switching=false;emit();mountReferenceWaves();showReferenceTraces();fit();ui.slots.schematic?.setVisible(true);return true;
    }catch(error){context={...context,run:null,selection:null,loading:false,loadState:'error'};emit();$('studio-native-note').textContent='RC 参考加载失败 · 无关联波形';throw error;}
    finally{switching=false;ui.setNativeState({loading:false,hidden:false});}
  }
  mountRemoteNode(host);
  const versions=section(ui.slots.versions.element,`<small>PROJECT HISTORY</small><h2>公开版本</h2><p>这里显示本站部署时的仓库提交记录。本地版可按电路筛选、审阅差异和恢复版本。</p><div id="demo-history"></div><p><a href="${REPO}/commits/main/" target="_blank" rel="noopener">在 GitHub 查看最新提交 ↗</a></p>`);
  try{const r=await fetch(new URL('./release.json',import.meta.url));if(r.ok){const release=await r.json();for(const c of release.commits||[]){const row=document.createElement('div');row.className='demo-step';const link=document.createElement('a');link.href=REPO+'/commit/'+encodeURIComponent(c.sha);link.target='_blank';link.rel='noopener';link.textContent=c.sha.slice(0,7)+' · '+c.subject;row.append(link);$('demo-history').append(row);}}}catch{$('demo-history').textContent='本地预览；发布记录见 GitHub。';}
  setSidebarWidth(230);setPane('netlist');setBackground('light',{persist:false});
  await openSource({name:'circuitgit-demo.scs',path:PATH,text:source},false);
  if(!doc||doc.failed||doc.diagnostics.some(d=>d.severity==='error'))throw Error('RC schematic failed to compile');
  fit();ui.setNativeState({loading:false,hidden:false});$('studio-native-note').textContent='公开 RC 示例 · 固定 RNL 布局 · 波形为解析参考';
  document.body.dataset.studioState='ready';
  ui.notify('欢迎使用 CircuitGit。拖动标签排列窗口；Plot 菜单可选择电压或电流探针。');
  // Auto-show two voltage references after the shared catalog has loaded.
  function showReferenceTraces(){
    referenceObserver?.disconnect();
    const ready=()=>{if(!referenceActive())return true;const buttons=ui.slots.waveforms.element.querySelectorAll('[data-signal-id]');if(buttons.length>=2){buttons[0].click();buttons[1].click();return true;}return false;};
    if(!ready()){const observer=new MutationObserver(()=>{if(ready())observer.disconnect();});referenceObserver=observer;observer.observe(ui.slots.waveforms.element,{subtree:true,childList:true});setTimeout(()=>observer.disconnect(),10000);}
  }
  showReferenceTraces();
  window.CircuitGitDemo=Object.freeze({getContext:contextAdapter.getContext,get reference(){return !activeLibrary;},getLibrarySelection:()=>activeLibrary?{library:activeLibrary.library.id,cell:activeLibrary.cell.id,view:activeLibrary.view.id,files:[...activeLibrary.bundle.paths]}:null});
  return host;
}
