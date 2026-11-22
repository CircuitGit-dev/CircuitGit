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

/** Static, explicit demo host. No backend, model, SSH, credentials or simulation submission. */
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
  const api={jobs:async()=>({jobs}),catalog:async()=>({signals,source_commit:null,csv_sha256:null}),mapping:async()=>mapping(),
    waveform:async(run,id,params)=>{if(run!==RUN||!points[id])throw Error('Unknown reference signal');return referenceWindow(points[id],params);}};
  const register=item=>registerStudioCommand({...item,run:()=>Promise.resolve().then(item.run).catch(e=>ui.notify(e.message,{kind:'error'}))});
  const host={version:1,slots:ui.slots,context:contextAdapter,notify:ui.notify,registerCommand:register,
    getRuns:()=>jobs,refresh:async()=>{},selectRun:async id=>{if(id!==RUN)throw Error('Unknown reference');context.run={runId:id};emit();},
    plot:{attach(controller){plotController=controller;controller.setPlotMode(mode);return()=>controller.destroy();}}};
  mountWaveforms(host,{api,labels:{loaded:'已加载浏览器计算的 RC 解析参考；不是 Spectre 仿真结果。',
    catalog:'RC 解析参考信号（浏览器计算，非 PSF 导出）。',provenance:'Piecewise-linear RC analytical reference · no Spectre execution',
    measurement:'RC 解析参考 / 线性插值',dataNote:'RC 一阶方程的分段线性输入解析解；每 5 ps 取样。显示使用保峰抽样，游标使用完整参考向量。'}});

  function setMode(value){mode=value;plotController.setPlotMode(value);$('studio-plot-state').hidden=value==='none';$('studio-plot-state').textContent=value==='voltage'?'电压探针 · Esc退出':value==='current'?'电流探针 · R0 端口1 · Esc退出':'';}
  for(const [value,label] of [['voltage','电压探针：点击 in / out'],['current','电流探针：点击 R0']])register({id:'plot.'+value,menu:'plot',label,run:()=>{plotController.openWindow();setMode(value);ui.notify(label);},checked:()=>mode===value});
  register({id:'plot.exit',menu:'plot',label:'退出探针 (Esc)',run:()=>setMode('none')});
  register({id:'window.reset',menu:'window',label:'恢复默认布局',run:()=>ui.resetLayout()});
  register({id:'git.history',menu:'git',label:'项目发布记录',run:()=>ui.slots.versions.setVisible(true)});
  register({id:'project.source',menu:'project',label:'查看 / 下载示例网表',run:()=>showSource()});
  register({id:'simulation.export',menu:'simulation',label:'导出仿真配置 JSON',run:()=>exportConfiguration()});
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
  function exportConfiguration(){const p=readParameters();download('TRAN.json',JSON.stringify(configuration(p),null,2)+'\n','application/json');download('circuit.scs',textFor(p));ui.notify('已导出 TRAN.json 与 circuit.scs；未启动仿真。');}
  async function rebuild(){const p=readParameters();$('demo-update').disabled=true;
    try{parameters=p;source=textFor(p);hash=await sha256(source);points=reference(p);signals.forEach(s=>s.domain=[0,p.stop]);
      context={...context,run:null,selection:null,file:{path:PATH,currentTextSha256:hash,dirty:false},geometry:{...context.geometry,manifestSha256:hash}};emit();
      await openSource({name:'circuitgit-demo.scs',path:PATH,text:source},false);fit();context.run={runId:RUN};emit();
      $('demo-basis').textContent=`R = ${p.resistance} Ω · C = ${Number((p.capacitance*1e12).toPrecision(6))} pF · τ = ${Number((p.resistance*p.capacitance*1e9).toPrecision(5))} ns`;
      ui.notify('参考曲线已更新；在波形列表中重新选择要查看的信号。');
    }finally{$('demo-update').disabled=false;}}
  $('demo-update').onclick=()=>rebuild().catch(e=>ui.notify(e.message,{kind:'error'}));$('demo-export').onclick=()=>{try{exportConfiguration();}catch(e){ui.notify(e.message,{kind:'error'});}};$('demo-guide').onclick=showGuide;
  function showSource(){const area=document.createElement('textarea');area.readOnly=true;area.value=source;dialog('RC 示例网表 · 含固定 RNL 布局',area);}
  function showGuide(){const e=document.createElement('div');e.className='demo-section';e.innerHTML=`<p>本页直接运行 RNL Viewer、Dockview 和共享波形组件，可拖动、关闭、浮动及放回面板。</p><p>Plot → 电压探针，点击 in 或 out；电流探针可查看 R0 端口 1。波形支持滚轮、拖动、F 适配，M 查看测量。</p><p>GitHub Pages 演示没有 AI 或 Cadence 后端。完整功能请在自己的电脑启动网关，再配置自己的 AI agent 与授权 Cadence 服务器。</p><pre>git clone ${REPO}.git
cd CircuitGit
python3 -B tools/workbench/launch.py</pre><p><a href="${REPO}/blob/main/docs/getting-started.md" target="_blank" rel="noopener">安装与连接说明 ↗</a></p>`;dialog('CircuitGit 使用说明',e);}
  $('studio-source-button').onclick=showSource;
  const ai=section(ui.slots.ai.element,`<small>BRING YOUR OWN AGENT</small><h2>连接你的 AI</h2><p>本页不连接模型，也不读取本机订阅。启动本地版后，可通过网页对话或 MCP 使用自己的 agent。</p><textarea class="demo-prompt" aria-label="可复制的示例提示词">检查这个 RC 电路，将时间常数调整到 2 ns，预览网表和仿真配置的改动，等待我确认后再提交仿真。</textarea><div class="demo-actions"><button id="demo-copy-prompt">复制提示词</button><button id="demo-ai-guide">配置连接</button></div><p><a href="${REPO}/blob/main/docs/agent-connections.md" target="_blank" rel="noopener">MCP 与 AI 连接说明 ↗</a></p>`);
  $('demo-copy-prompt').onclick=async()=>{try{await navigator.clipboard.writeText(ai.querySelector('textarea').value);ui.notify('已复制提示词。');}catch{ai.querySelector('textarea').select();ui.notify('请按 Ctrl/Cmd+C 复制选中的提示词。');}};$('demo-ai-guide').onclick=showGuide;
  const versions=section(ui.slots.versions.element,`<small>PROJECT HISTORY</small><h2>公开版本</h2><p>这里显示本站部署时的仓库提交记录。本地版可按电路筛选、审阅差异和恢复版本。</p><div id="demo-history"></div><p><a href="${REPO}/commits/main/" target="_blank" rel="noopener">在 GitHub 查看最新提交 ↗</a></p>`);
  try{const r=await fetch(new URL('./release.json',import.meta.url));if(r.ok){const release=await r.json();for(const c of release.commits||[]){const row=document.createElement('div');row.className='demo-step';const link=document.createElement('a');link.href=REPO+'/commit/'+encodeURIComponent(c.sha);link.target='_blank';link.rel='noopener';link.textContent=c.sha.slice(0,7)+' · '+c.subject;row.append(link);$('demo-history').append(row);}}}catch{$('demo-history').textContent='本地预览；发布记录见 GitHub。';}
  setSidebarWidth(230);setPane('netlist');setBackground('light',{persist:false});
  await openSource({name:'circuitgit-demo.scs',path:PATH,text:source},false);
  if(!doc||doc.failed||doc.diagnostics.some(d=>d.severity==='error'))throw Error('RC schematic failed to compile');
  fit();ui.setNativeState({loading:false,hidden:false});$('studio-native-note').textContent='公开 RC 示例 · 固定 RNL 布局 · 波形为解析参考';
  document.body.dataset.studioState='ready';
  ui.notify('欢迎使用 CircuitGit。拖动标签排列窗口；Plot 菜单可选择电压或电流探针。');
  // Auto-show two voltage references after the shared catalog has loaded.
  const ready=()=>{const buttons=ui.slots.waveforms.element.querySelectorAll('[data-signal-id]');if(buttons.length){buttons[0].click();buttons[1].click();return true;}return false;};
  if(!ready()){const observer=new MutationObserver(()=>{if(ready())observer.disconnect();});observer.observe(ui.slots.waveforms.element,{subtree:true,childList:true});setTimeout(()=>observer.disconnect(),10000);}
  window.CircuitGitDemo=Object.freeze({getContext:contextAdapter.getContext,reference:true});
  return host;
}
