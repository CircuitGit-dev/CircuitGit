/** Explicit click -> one fixed local helper -> local human confirmation. No port scanning. */
export const LOCAL_CONNECTOR='http://127.0.0.1:8767';
export const PROTOCOL_URI='circuitgit://start';
export const SESSION_GRANT_KEY='circuitgit.local-connector.session.v1';
const TOKEN_RE=/^[A-Za-z0-9_-]{43,128}$/;

export async function probeLocalConnector({base=LOCAL_CONNECTOR,timeout=1200,fetcher=globalThis.fetch}={}){
  if(typeof fetcher!=='function')return false;
  const controller=typeof AbortController==='function'?new AbortController():null;
  const timer=controller?setTimeout(()=>controller.abort(),timeout):null;
  try{
    const res=await fetcher(base+'/health',{method:'GET',mode:'cors',cache:'no-store',credentials:'omit',signal:controller?.signal});
    if(!res?.ok)return false;
    const payload=await res.json().catch(()=>null);
    return Boolean(payload?.ok===true&&payload?.data?.ready===true);
  }catch{return false;}
  finally{if(timer!==null)clearTimeout(timer);}
}

export function triggerConnectorProtocol({win=window,uri=PROTOCOL_URI}={}){
  if(!win?.document||typeof uri!=='string'||!uri.startsWith('circuitgit://'))return false;
  try{
    const frame=win.document.createElement('iframe');
    frame.style.display='none';
    frame.setAttribute('aria-hidden','true');
    frame.src=uri;
    win.document.body?.append(frame);
    win.setTimeout?.(()=>frame.remove(),1500);
    return true;
  }catch{
    try{win.location.assign(uri);return true;}catch{return false;}
  }
}

export async function wakeLocalConnector({win=window,base=LOCAL_CONNECTOR,uri=PROTOCOL_URI,timeout=4500,interval=350,fetcher=globalThis.fetch,onStage=()=>{}}={}){
  if(await probeLocalConnector({base,timeout:1000,fetcher})){
    return {status:'ready',alreadyRunning:true};
  }
  onStage('waking');
  triggerConnectorProtocol({win,uri});
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,interval));
    if(await probeLocalConnector({base,timeout:800,fetcher})){
      return {status:'ready',alreadyRunning:false};
    }
  }
  return {status:'missing',alreadyRunning:false};
}

export function saveSessionGrant({url=LOCAL_CONNECTOR,accessCode}={},storage=globalThis.sessionStorage){
  if(!storage||typeof storage.setItem!=='function'||url!==LOCAL_CONNECTOR||!TOKEN_RE.test(accessCode||''))return false;
  try{
    storage.setItem(SESSION_GRANT_KEY,JSON.stringify({schema:'circuitgit.session-grant.v1',url,accessCode}));
    return true;
  }catch{return false;}
}

export function loadSessionGrant(storage=globalThis.sessionStorage){
  if(!storage||typeof storage.getItem!=='function')return null;
  try{
    const raw=storage.getItem(SESSION_GRANT_KEY);
    if(!raw||raw.length>2048)return null;
    const data=JSON.parse(raw);
    if(data?.schema!=='circuitgit.session-grant.v1'||data.url!==LOCAL_CONNECTOR||!TOKEN_RE.test(data.accessCode||''))return null;
    return {url:data.url,accessCode:data.accessCode};
  }catch{return null;}
}

export function clearSessionGrant(storage=globalThis.sessionStorage){
  if(!storage||typeof storage.removeItem!=='function')return;
  try{storage.removeItem(SESSION_GRANT_KEY);}catch{}
}

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
