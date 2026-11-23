/** Explicit single-owner node transport. Credentials stay in memory and never enter a URL. */
import {readSimulationJson} from '../../../modules/simulation/http.js';
export function endpoint(value) {
  const u=new URL(value);
  if(u.username||u.password||u.search||u.hash||!['https:','http:'].includes(u.protocol))throw Error('节点地址不能包含账号、密码、查询参数或片段。');
  if(u.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('远程节点必须使用 HTTPS；HTTP 仅用于本机回环地址。');
  if(!/^\/[A-Za-z0-9_/-]*$/.test(u.pathname))throw Error('节点路径只能使用字母、数字、下划线和斜线。');
  return u.origin+u.pathname.replace(/\/+$/,'');
}

export function createNodeClient({url,accessCode,fetchImpl=fetch,timeout=45000,onUnauthorized=()=>{}}) {
  const base=endpoint(url);
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(accessCode))throw Error('请输入节点生成的完整访问码；这里不需要 OpenAI API Key。');
  let secret=accessCode,closed=false;const pending=new Set();
  async function request(path,{method='GET',body}={}) {
    if(closed)throw Error('节点已断开。');
    const library=['/library/read','/library/prepare','/library/review-request','/library/execute'].includes(path);
    const simulation=path==='/simulation/execute';
    if(!['GET','POST'].includes(method)||(!path.startsWith('/ai/')&&path!=='/node/info'&&!library&&!simulation))throw Error('请求不属于运行节点接口。');
    const target=new URL(base+(path==='/node/info'?path:'/api'+path));
    const expected=new URL(base);
    if(target.origin!==expected.origin||!target.pathname.startsWith(expected.pathname.replace(/\/$/,'')+'/'))throw Error('节点接口越界。');
    const controller=new AbortController();pending.add(controller);const timer=setTimeout(()=>controller.abort(),timeout);
    try {
      const response=await fetchImpl(target.href,{method,headers:{Accept:'application/json',Authorization:'Bearer '+secret,...(body===undefined?{}:{'Content-Type':'application/json'})},
        body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});
      const value=simulation?await readSimulationJson(response):await response.json();
      if(closed)throw Error('节点已断开；旧响应已丢弃。');
      if(!response.ok||value.ok!==true){
        const error=Error(String(value.error?.message||'节点拒绝请求').slice(0,600));error.status=response.status;error.data=value.error||{};
        if(response.status===401||response.status===403&&value.error?.code==='forbidden')onUnauthorized(error);
        throw error;
      }
      return value.data;
    } catch(error) {
      if(error.status||error.code==='response_size_limit')throw error;
      const write=method==='POST'&&path!=='/library/read';
      const message=closed?'节点已断开；没有重发操作。':write?(library?'操作结果尚未确认；请检查原请求记录，不要重新提交。':'发送结果尚不确定；请重新连接并核对原会话，不要重复发送。'):'无法读取节点。请检查地址、HTTPS、访问码及浏览器的本地网络权限。';
      const e=Error(message);e.data={code:write?'transport_unknown':'node_unreachable'};throw e;
    } finally {clearTimeout(timer);pending.delete(controller);}
  }
  return Object.freeze({base,request,close(){closed=true;secret='';for(const controller of pending)controller.abort();pending.clear();}});
}
