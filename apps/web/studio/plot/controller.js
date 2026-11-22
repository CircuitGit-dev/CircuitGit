import {CHANNEL,MODES,token,validContext,copyContext,bindingOf,same,probeReason,validEnvelope} from './protocol.js';

export function createPlotController({contextAdapter,notify=()=>{},exitMode=()=>{},hostWindow=window,clock=()=>Date.now(),randomID=()=>hostWindow.crypto.randomUUID()}={}){
  if(!contextAdapter?.getContext||!contextAdapter?.subscribe)throw Error('Shared context adapter required');
  const origin=hostWindow.location.origin,sender=randomID(),retired=new Set();
  let session=null,child=null,popup=null,mode='none',windowState='closed',pending=null,disposed=false;
  let seq=0,childSeq=0,lastHeard=0,openedAt=0;
  let context=copyContext(contextAdapter.getContext());
  const current=()=>copyContext(contextAdapter.getContext());
  const report=(message,kind='info')=>notify(message,{kind});
  const live=()=>{try{return !!popup&&!popup.closed;}catch{return false;}};
  function pendingValid(){return !!pending&&pending.mode===mode&&same(pending.context,current())&&!probeReason(pending.context,mode);}
  function send(kind,fields={}){
    if(!live()||!child)return false;
    try{popup.postMessage({channel:CHANNEL,sender,session,child,seq:++seq,kind,...fields},origin);return true;}
    catch{windowState='disconnected';report('波形窗口连接已断开，请从 Plot 菜单重新打开。','warning');return false;}
  }
  function sendState(intent='context',ctx=context){
    if(!validContext(ctx))return false;
    return send('state',{intent,context:ctx,revision:ctx.revision,binding:bindingOf(ctx),mode});
  }
  function flush(){
    if(!pendingValid()){pending=null;return;}
    if(windowState==='ready'&&sendState('probe',pending.context))pending=null;
  }
  function updateContext(next){
    if(disposed)return;
    const nextContext=copyContext(next||contextAdapter.getContext());
    if(!validContext(nextContext))return;
    if(validContext(context)&&nextContext.revision<context.revision)return;
    context=nextContext;if(!pendingValid())pending=null;
    if(windowState==='ready')sendState();
  }
  const unsubscribe=contextAdapter.subscribe(updateContext);updateContext(contextAdapter.getContext());
  function receive(event){
    if(disposed||!live()||!validEnvelope(event,{origin,peer:popup,sender,session}))return;
    const m=event.data;
    if(m.kind==='ready'){
      if(retired.has(m.child))return;
      if(child!==m.child){if(child)retired.add(child);child=m.child;childSeq=0;windowState='opening';}
      if(m.seq<=childSeq)return;childSeq=m.seq;lastHeard=clock();
      send('welcome');sendState();return;
    }
    if(m.child!==child||m.seq<=childSeq)return;childSeq=m.seq;lastHeard=clock();
    if(m.kind==='ack'||m.kind==='pong'){
      if(m.kind==='ack'&&(m.revision!==context.revision||!same(m.binding,bindingOf(context))))return;
      const first=windowState!=='ready';windowState='ready';if(first)report('独立波形窗口已连接。');flush();return;
    }
    if(m.kind==='exit'&&m.revision===context.revision&&same(m.binding,bindingOf(context))){exitMode();return;}
    if(m.kind==='closing'){windowState='closed';return;}
    if(m.kind==='notice'&&m.revision===context.revision&&same(m.binding,bindingOf(context))&&typeof m.message==='string'&&m.message.length<2048)report(m.message,m.error?'warning':'info');
  }
  hostWindow.addEventListener('message',receive);
  const timer=hostWindow.setInterval(()=>{
    if(disposed||!popup)return;
    if(!live()){
      if(windowState!=='closed')report('波形窗口已关闭；再次绘图请从 Plot 菜单打开。');
      windowState='closed';popup=null;child=null;return;
    }
    if((windowState==='opening'&&clock()-openedAt>12000)||(windowState==='ready'&&clock()-lastHeard>15000)){
      windowState='disconnected';report('波形窗口未响应；请从 Plot 菜单重新打开连接。','warning');
    }
    if(child)send('ping');
  },2000);
  function openWindow(){
    if(disposed)return {opened:false,reason:'波形控制器已关闭。'};
    if(live()&&['ready','opening'].includes(windowState)){
      try{popup.focus();}catch{}
      return {opened:true};
    }
    // Remains entirely synchronous inside the native menu gesture.
    session=randomID();child=null;seq=0;childSeq=0;retired.clear();openedAt=clock();lastHeard=openedAt;
    const url=new URL('/studio/plot/window.html',hostWindow.location.href);if(url.origin!==origin)throw Error('Plot popup must be same-origin');
    url.hash=new URLSearchParams({sender,session}).toString();
    try{popup=hostWindow.open(url.href,'ic-rnl-plot-'+sender,'popup,width=1280,height=850,resizable=yes,scrollbars=yes');}
    catch{popup=null;}
    if(!live()){
      windowState='blocked';const reason='浏览器阻止了波形弹窗。请允许本站弹窗，再点 Plot → 打开波形窗口；有效待选信号会保留。';report(reason,'warning');return {opened:false,reason};
    }
    windowState='opening';try{popup.focus();}catch{}return {opened:true};
  }
  function setPlotMode(next){
    if(!MODES.includes(next))throw Error('Unknown plot mode');
    if(mode!==next)pending=null;mode=next;context=current();
    if(windowState==='ready')sendState('mode');
  }
  function onSelection(snapshot){
    if(disposed||mode==='none')return;
    const ctx=copyContext(snapshot),actual=current();
    if(!same(ctx,actual)){report('忽略已过期的电路选择。','warning');return;}
    context=ctx;const reason=probeReason(ctx,mode);
    if(reason){pending=null;if(windowState==='ready')sendState('probe');report(reason,'warning');return;}
    pending={context:ctx,mode};
    if(windowState==='ready'&&live())flush();
    else report('尚未连接波形窗口；待选信号已保留，请从 Plot 菜单打开窗口。','warning');
  }
  function destroy(){
    if(disposed)return;disposed=true;pending=null;unsubscribe?.();hostWindow.clearInterval(timer);hostWindow.removeEventListener('message',receive);
    send('detach');popup=null;child=null;windowState='disconnected';
  }
  return {openWindow,setPlotMode,onSelection,getState:()=>Object.freeze({mode,windowState,pending:pendingValid()}),destroy};
}
