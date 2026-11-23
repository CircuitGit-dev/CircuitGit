/** Explicit click -> one fixed local helper -> local human confirmation. No port scanning. */
export const LOCAL_CONNECTOR='http://127.0.0.1:8767';

export function pairLocal({win=window,onReady=()=>{},base=LOCAL_CONNECTOR,readyTimeout=6000,consentTimeout=180000}={}) {
  const url=new URL(base);
  if(url.origin!==base||url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('本机连接仅使用回环地址。');
  const state=win.crypto.randomUUID().replaceAll('-','');
  let popup,timer,closedTimer,settled=false,ready=false,resolve,reject;
  const result=new Promise((yes,no)=>{resolve=yes;reject=no;});
  function finish(error,value){if(settled)return;settled=true;win.clearTimeout(timer);win.clearInterval(closedTimer);win.removeEventListener('message',receive);popup?.close();error?reject(error):resolve(value);}
  function receive(event){
    const data=event.data;
    if(settled||event.origin!==base||event.source!==popup||!data||data.state!==state)return;
    if(data.type==='circuitgit.local.ready'&&!ready){ready=true;win.clearTimeout(timer);timer=win.setTimeout(()=>finish(Error('本机授权已超时，请重新连接。')),consentTimeout);onReady();}
    if(data.type==='circuitgit.local.result'&&ready){
      if(data.allowed!==true){finish(Error('已取消本机授权。'));return;}
      if(!/^[A-Za-z0-9_-]{43,128}$/.test(data.accessCode||'')){finish(Error('本机连接回执无效。'));return;}
      finish(null,{url:base,accessCode:data.accessCode});
    }
  }
  win.addEventListener('message',receive);
  // Called synchronously from the user's click, so normal popup permission applies.
  popup=win.open(base+'/connect?origin='+encodeURIComponent(win.location.origin)+'&state='+encodeURIComponent(state),'_blank','popup,width=560,height=650');
  if(!popup){finish(Error('浏览器阻止了授权窗口，请允许此网站弹出窗口后重试。'));}
  else {
    timer=win.setTimeout(()=>finish(Error('未检测到本机连接助手。首次使用请先启动助手，再点击连接；只打开 Codex 还不够。')),readyTimeout);
    closedTimer=win.setInterval(()=>{if(popup.closed)finish(Error('授权窗口已关闭，连接已取消。'));},400);
  }
  return {result,cancel(){finish(Error('连接已取消。'));}};
}
