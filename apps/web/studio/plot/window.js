import {mountWaveformPanel} from '../../waveforms/panel.js';
import {waveformAPI} from '../../waveforms/api.js';
import {CHANNEL,token,validEnvelope,validState,bindingOf,same,probeReason} from './protocol.js';

const $=id=>document.getElementById(id),origin=location.origin,peer=window.opener;
const params=new URLSearchParams(location.hash.slice(1)),sender=params.get('sender'),session=params.get('session'),child=crypto.randomUUID();
let context=null,mode='none',latestSeq=0,latestStateSeq=0,seq=0,connected=false,lastHeard=0,welcomed=false,exitPending=false;
let panel=null,panelBinding=null,setup=Promise.resolve(),generation=0;
const listeners=new Set();
const adapter=Object.freeze({getContext:()=>context,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}});
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
function connection(state,text){$('connection').dataset.state=state;$('connection').textContent=text;}
function feedback(text,error=false){$('probe-feedback').textContent=text;$('probe-feedback').dataset.error=String(error);}
function send(kind,fields={}){
  if(!peer||peer.closed)return false;
  peer.postMessage({channel:CHANNEL,sender,session,child,seq:++seq,kind,...fields},origin);return true;
}
function reply(kind,fields={}){return send(kind,{revision:context?.revision??null,binding:bindingOf(context),...fields});}
function disconnect(text){
  connected=false;generation++;connection('disconnected',text);$('waveform-mount').inert=true;
  // Invalidate pending mapping/terminal actions without manufacturing another host snapshot.
  listeners.forEach(fn=>fn(context));feedback('连接断开，已有曲线仅作为标明来源的历史视图。',true);
}
function showIdentity(){
  const b=bindingOf(context),run=context?.run;
  $('window-provenance').textContent=b.runId?
    `工程 ${b.projectId} · run ${b.runId} · run源 ${run?.sourceCommit||'未知'} · 当前源 ${b.sourceHash||'待核验'} · 几何 ${b.geometryHash||'未知'}`:
    `工程 ${b.projectId||'未选择'} · 在主窗口选择已保存运行。`;
  $('plot-mode').textContent=({none:'普通选择 · 不自动绘图',voltage:'电压探针 · 点击网络',current:'电流探针 · 点击器件后明确端口'})[mode];
  document.body.dataset.stale=String(!!context?.file?.dirty||context?.geometry?.sourceMatch!==true);
  document.title=`RNL Waveforms · ${b.projectId||'未选择'} · ${b.runId||'未选择运行'}`;
}
function controlledAPI(binding){
  const api=waveformAPI();
  const check=run=>{if(!connected||!same(binding,bindingOf(context))||run!==binding.runId)throw Error('波形运行或源身份已变化，请重新选择。');};
  const guard=async(method,run,...args)=>{check(run);const value=await api[method](run,...args);check(run);return value;};
  return {jobs:async opts=>{
    check(binding.runId);const value=await api.jobs(opts);check(binding.runId);
    return {...value,jobs:(value.jobs||[]).filter(j=>(j.run_id||j.job_id)===binding.runId&&(!j.associated_project_id||j.associated_project_id===binding.projectId))};
  },catalog:(r,...a)=>guard('catalog',r,...a),mapping:(r,...a)=>guard('mapping',r,...a),waveform:(r,...a)=>guard('waveform',r,...a)};
}
async function applyState(m){
  const thisSeq=m.seq;context=freeze(m.context);mode=m.mode;exitPending=false;
  const binding=bindingOf(context),changed=!same(panelBinding,binding);
  connected=true;$('waveform-mount').inert=false;connection('ready','已连接主窗口 · 窗口与每条曲线绑定同一工程 / run / 源。');showIdentity();
  if(changed){
    generation++;panel?.destroy();panel=null;panelBinding=binding;$('waveform-mount').replaceChildren();
    feedback(binding.runId?'来源已更新，旧曲线已清空。':'请先在主窗口选择已保存运行。');
    if(binding.projectId&&binding.runId&&binding.sourceHash){
      const section=document.createElement('section');section.id='ic-waveform-panel';$('waveform-mount').append(section);
      panel=mountWaveformPanel(section,{contextAdapter:adapter,api:controlledAPI(binding),followSelection:false,manualSignals:true,managedRun:true,
        probeAllowed:ctx=>connected&&!exitPending&&!probeReason(ctx,mode)&&ctx.revision===context.revision&&same(bindingOf(ctx),bindingOf(context))});
      setup=panel.setRun(binding.runId);
    }else setup=Promise.resolve();
  }else listeners.forEach(fn=>fn(context));
  if(m.intent!=='probe'){
    if(mode==='none')feedback('点击左侧已导出信号，或绘制全部；从主窗口 Plot 菜单开启电路探针。');
    reply('ack');return;
  }
  const problem=probeReason(context,mode);
  if(problem){feedback(problem,true);reply('notice',{message:problem,error:true});reply('ack');return;}
  const gen=generation;await setup;
  if(gen!==generation||thisSeq!==latestStateSeq||!connected||exitPending)return;
  const active=panel;if(!active){feedback('运行或源身份未准备好。',true);return;}
  await active.probe(context);
  if(gen!==generation||thisSeq!==latestStateSeq||panel!==active||!connected)return;
  const text=document.querySelector('.wf-status')?.textContent||'探针选择已处理。';feedback('');reply('notice',{message:text});reply('ack');
}
function receive(event){
  if(!validEnvelope(event,{origin,peer,sender,session,child})||event.data.seq<=latestSeq)return;
  const m=event.data;
  if(m.kind==='state'&&!validState(m))return;
  if(m.kind==='state'&&context&&m.context.revision<context.revision)return;
  latestSeq=m.seq;if(m.kind==='state')latestStateSeq=m.seq;lastHeard=Date.now();
  if(m.kind==='welcome'){welcomed=true;return;}
  if(m.kind==='ping'){if(connected)reply('pong');else send('ready');return;}
  if(m.kind==='detach'){disconnect('主窗口已卸载，波形窗口已断开。');return;}
  if(m.kind==='state'&&welcomed)void applyState(m).catch(error=>{feedback(error.message,true);reply('notice',{message:error.message,error:true});});
}
function exit(){if(!connected||!context)return;exitPending=true;listeners.forEach(fn=>fn(context));reply('exit');feedback('已请求退出探针。');}
$('exit-probe').addEventListener('click',exit);
window.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();exit();}});
if(!peer||!token(sender)||!token(session)){
  connection('blocked','此窗口必须由 RNL 主窗口的 Plot 菜单打开。');$('exit-probe').disabled=true;
}else{
  window.addEventListener('message',receive);
  send('ready');
  const timer=setInterval(()=>{
    if(peer.closed){disconnect('主窗口已关闭。已有曲线保留来源标记。');clearInterval(timer);return;}
    if(!welcomed)send('ready');
    else if(Date.now()-lastHeard>16000&&connected)disconnect('主窗口连接超时，请在主窗口重新打开波形窗口。');
  },1000);
  window.addEventListener('pagehide',()=>{reply('closing');clearInterval(timer);panel?.destroy();});
}
