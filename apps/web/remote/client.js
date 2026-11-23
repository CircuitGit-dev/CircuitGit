/** Explicit single-owner node transport. Credentials stay in memory and never enter a URL. */
import {readSimulationJson} from '../../../modules/simulation/http.js';
export const ONBOARDING_OPERATIONS=Object.freeze({
  inspectNetlist:{path:'/netlist',method:'POST'},listSshAliases:{path:'/ssh-hosts',method:'GET'},
  getSession:{path:'/session',method:'GET',query:['intake_id']},probeHost:{path:'/probe',method:'POST'},
  probeVerilogaHeaders:{path:'/veriloga-headers',method:'POST'},
  discoverPdk:{path:'/discover-pdk',method:'POST'},prepareExperiment:{path:'/prepare',method:'POST'},
  runPrepared:{path:'/run',method:'POST'},readSubmission:{path:'/submission',method:'GET',query:['intake_id','plan_id']},
  inspectExperiment:{path:'/inspect',method:'POST'},
  saveAgentTestbench:{path:'/agent-tb/draft',method:'POST'},getAgentTestbench:{path:'/agent-tb',method:'GET',query:['intake_id']},
  prepareAgentTestbench:{path:'/agent-tb/prepare',method:'POST'},analyzeExperiment:{path:'/analysis',method:'POST'},
});
const ONBOARDING_PREFIX='/simulation/onboarding';
// These budgets cover the finite synchronous backend work, never a solver run.
// Probe/discovery: at most eight explicit hosts, two workers; each remote hop
// is 35s (plus an optional 35s setup probe) or 60s. Prepare includes four local
// Git calls capped at 20s and a 60s audit. Run reserves after two host checks
// (30s doctor + 30s version/10s resources) and one 30s selected-host preflight.
const ONBOARDING_TIMEOUT_LIMITS=Object.freeze({inspectNetlist:20000,listSshAliases:20000,getSession:20000,
  probeVerilogaHeaders:70000,probeHost:290000,discoverPdk:250000,prepareExperiment:150000,runPrepared:320000,readSubmission:20000,inspectExperiment:45000,
  saveAgentTestbench:20000,getAgentTestbench:20000,prepareAgentTestbench:150000,analyzeExperiment:120000});
const boundedHostCount=rows=>Array.isArray(rows)&&rows.length>=1&&rows.length<=8?rows.length:8;
export function onboardingRequestTimeout(name,input={},session=null){
  if(!Object.hasOwn(ONBOARDING_TIMEOUT_LIMITS,name))throw Error('Unknown onboarding operation');
  if(name==='probeHost'){
    const activated=!!Object.keys(input.overrides?.setup_source_ids||{}).length;
    return Math.ceil(boundedHostCount(input.ssh_targets)/2)*(activated?70000:35000)+10000;
  }
  if(name==='discoverPdk')return Math.ceil(boundedHostCount(input.probe_ids)/2)*60000+10000;
  if(name==='runPrepared')return Math.ceil(boundedHostCount(session?.execution_scope?.candidate_host_ids)/2)*70000+40000;
  return ONBOARDING_TIMEOUT_LIMITS[name];
}
function onboardingTransportTimeout(path,method,body,requested){
  const operation=Object.entries(ONBOARDING_OPERATIONS).find(([,row])=>ONBOARDING_PREFIX+row.path===path.split('?')[0]&&row.method===method)?.[0];
  const maximum=operation?ONBOARDING_TIMEOUT_LIMITS[operation]:20000;
  const value=requested??(operation?onboardingRequestTimeout(operation,body):maximum);
  if(!Number.isInteger(value)||value<1||value>maximum)throw Error('Onboarding request timeout exceeds its finite route budget');
  return value;
}
export function isOnboardingRequest(path,method){
  if(typeof path!=='string'||!path.startsWith(ONBOARDING_PREFIX+'/'))return false;
  const parsed=new URL(path,'http://node.invalid');
  if(parsed.origin!=='http://node.invalid'||path!==parsed.pathname+parsed.search||parsed.hash)return false;
  const wave=parsed.pathname.slice((ONBOARDING_PREFIX+'/waveforms/').length);
  if(method==='GET'&&parsed.pathname.startsWith(ONBOARDING_PREFIX+'/waveforms/')&&['catalog','mapping','window'].includes(wave)){
    const required=['intake_id','job_id',...(wave==='window'?['signal_ids']:[])],allowed=[...required,'dataset_id',...(wave==='window'?['start','stop','max_points']:[])];
    if([...parsed.searchParams.keys()].some(key=>!allowed.includes(key)||parsed.searchParams.getAll(key).length!==1)||required.some(key=>!parsed.searchParams.get(key)))return false;
    if(['intake_id','job_id'].some(key=>parsed.searchParams.get(key).length>512))return false;
    if(parsed.searchParams.has('dataset_id')&&!/^ds_[a-f0-9]{32}$/.test(parsed.searchParams.get('dataset_id')))return false;
    if(wave==='window'){
      const ids=parsed.searchParams.get('signal_ids').split(',');if(ids.length>8||ids.some(id=>!id||id.length>512)||new Set(ids).size!==ids.length)return false;
      for(const key of ['start','stop'])if(parsed.searchParams.has(key)&&(parsed.searchParams.get(key).trim()===''||!Number.isFinite(Number(parsed.searchParams.get(key)))))return false;
      if(parsed.searchParams.has('max_points')){const limit=Number(parsed.searchParams.get('max_points'));if(!Number.isInteger(limit)||limit<4||limit>10000)return false;}
    }
    return true;
  }
  const operation=Object.values(ONBOARDING_OPERATIONS).find(row=>ONBOARDING_PREFIX+row.path===parsed.pathname&&row.method===method);
  if(!operation)return false;
  const fields=operation.query||[];
  return [...parsed.searchParams.keys()].length===fields.length&&fields.every(key=>parsed.searchParams.getAll(key).length===1&&parsed.searchParams.get(key)?.length>0&&parsed.searchParams.get(key).length<=512);
}
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
  async function request(path,{method='GET',body,timeout:requestTimeout}={}) {
    if(closed)throw Error('节点已断开。');
    const library=['/library/read','/library/prepare','/library/review-request','/library/execute'].includes(path);
    const onboarding=isOnboardingRequest(path,method),simulation=path==='/simulation/execute'||onboarding;
    if(!['GET','POST'].includes(method)||(!path.startsWith('/ai/')&&path!=='/node/info'&&!library&&!simulation))throw Error('请求不属于运行节点接口。');
    const target=new URL(base+(path==='/node/info'?path:'/api'+path));
    const expected=new URL(base);
    if(target.origin!==expected.origin||!target.pathname.startsWith(expected.pathname.replace(/\/$/,'')+'/'))throw Error('节点接口越界。');
    const budget=onboarding?onboardingTransportTimeout(path,method,body,requestTimeout):timeout;
    const controller=new AbortController();pending.add(controller);const timer=setTimeout(()=>controller.abort(),budget);
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
