import {assertWaveformResponse} from './summary.js';
const clone=value=>structuredClone(value);
// Persisted JSON may reorder object keys without changing the view state.
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const same=(a,b)=>stable(a)===stable(b);
const problem=(message,code='conflict')=>Object.assign(new Error(message),{code});
const aborted=()=>Object.assign(new Error('读取已取消。'),{name:'AbortError'});
export function validateView(view){
  if(view?.schema!=='ic.view.v1'||view.kind!=='waveforms'||!/^v_[a-f0-9]{32}$/.test(view.view_id)||!/^w_[a-f0-9]{32}$/.test(view.workspace_id)||
    !Number.isSafeInteger(view.revision)||view.revision<1||typeof view.identity?.project_id!=='string'||!view.identity.project_id||
    typeof view.identity?.run_id!=='string'||!view.identity.run_id||! /^[a-f0-9]{40}$/.test(view.identity?.source_commit||''))throw problem('缺少有效的独立波形视图与运行身份。','invalid_view');
  return clone(view);
}
export const identityKey=view=>stable([view.workspace_id,view.view_id,view.kind,view.identity]);
export function panelContext(view){
  // A saved-run descriptor is not evidence that the current schematic is fresh.
  return Object.freeze({version:1,revision:view.revision,mode:'mcp',loadState:'ready',loading:false,
    project:{id:view.identity.project_id,sourceCommit:view.identity.source_commit},
    file:view.identity.path?{path:view.identity.path,currentTextSha256:view.identity.source_sha256,persistedSha256:view.identity.source_sha256,dirty:false,editable:false}:null,
    geometry:null,selection:null,run:{runId:view.identity.run_id,sourceCommit:view.identity.source_commit,projectId:view.identity.project_id,configurationId:view.identity.configuration,historical:true}});
}
export function createViewAdapter(host,{onView=()=>{},onCatalog=()=>{},onMapping=()=>{},onWaveform=()=>{},onError=()=>{}}={}){
  let view=validateView(host.initial),disposed=false,tail=Promise.resolve(),catalog=null,mapping=null,workspaceRevision=0;
  const boundKey=identityKey(view),readings=new Map();
  function accept(value,reason='result'){
    const next=validateView(value);
    if(identityKey(next)!==boundKey)throw problem('其他视图或源身份不能替换此窗口；请打开新的固定视图。');
    if(next.revision<view.revision)throw problem('已忽略过期视图结果。');
    const own=v=>{const {workspace_revision,...fields}=v;return fields;};
    if(Number.isSafeInteger(next.workspace_revision)&&Number.isSafeInteger(view.workspace_revision)&&next.workspace_revision<view.workspace_revision)throw problem('工作区修订已过期。');
    if(next.revision===view.revision&&!same(own(next),own(view)))throw problem('同一修订返回了不同视图状态。');
    view=next;onView(clone(view),reason);return clone(view);
  }
  function queue(fn){
    const job=tail.then(()=>{if(disposed)throw aborted();return fn();});tail=job.catch(()=>{});return job;
  }
  function ids(){return {workspace_id:view.workspace_id,view_id:view.view_id};}
  async function read(query,{signal}={}){
    return queue(async()=>{
      if(signal?.aborted)throw aborted();const at=clone(view);
      const response=await host.call('ic_view_data',{...ids(),revision:at.revision,query});
      if(disposed||signal?.aborted)throw aborted();
      if(view.revision!==at.revision)throw problem('读取期间视图修订已变化；请刷新本视图。');
      if(response?.kind!==query.kind||response?.view?.revision!==at.revision)throw problem('数据响应与请求修订不一致。');
      accept(response.view,'data');return response.payload;
    });
  }
  function runOnly(run){if(run!==view.identity.run_id)throw problem('此窗口只读取已固定的运行。');}
  const api={
    async jobs(options){const result=await read({kind:'runs'},options);if(!Array.isArray(result?.jobs))throw problem('运行列表响应无效。','invalid_data');
      const jobs=result.jobs.filter(j=>(j.run_id||j.job_id)===view.identity.run_id);
      if(jobs.length!==1)throw problem('固定运行不在此工程的已登记列表中。');
      const job=jobs[0];if(job.source_commit!==view.identity.source_commit||((job.associated_project_id||job.project_id)!==view.identity.project_id))throw problem('运行的工程或源版本与视图不一致。');
      return {jobs};
    },
    async catalog(run,options){runOnly(run);const data=await read({kind:'signals'},options);
      if(data?.run_id!==run||data.source_commit!==view.identity.source_commit||!Array.isArray(data.signals)||data.signals.length>100000)throw problem('信号目录与固定运行身份不一致。');
      if(view.identity.source_sha256&&mapping?.source?.sha256&&view.identity.source_sha256!==mapping.source.sha256)throw problem('运行源校验值与视图不一致。');
      catalog=data;onCatalog(data);return data;
    },
    async mapping(run,options){runOnly(run);let data;
      try{data=await read({kind:'mapping'},options);}catch(error){
        if(error.name==='AbortError'||!['not_found','unmapped','mapping_unavailable','source_mismatch'].includes(error.code))throw error;
        onMapping(null,error);return {status:'unmapped',run_id:run,source_commit:view.identity.source_commit,reason:error.message};
      }
      if(data?.run_id&&data.run_id!==run)throw problem('原理图映射来自另一运行。');
      if(data?.source_commit&&data.source_commit!==view.identity.source_commit)throw problem('原理图映射源版本与运行不一致。');
      if(view.identity.source_sha256&&data?.source?.sha256&&view.identity.source_sha256!==data.source.sha256)throw problem('映射运行源校验值与视图不一致。');
      mapping=data;onMapping(data);return data;
    },
    async waveform(run,id,params={},options){runOnly(run);const signal=catalog?.signals.find(s=>s.id===id&&s.status==='available');
      if(!signal)throw problem('信号未在当前运行的可读目录登记。');
      const query={kind:'waveform',signal_id:id,analysis:'tran'};
      for(const key of ['start','end','limit','cursor_a','cursor_b'])if(params[key]!==undefined){if(!Number.isFinite(params[key]))throw problem('时间窗和游标必须为有限数字。','invalid_input');query[key]=params[key];}
      if(query.limit!==undefined&&(!Number.isInteger(query.limit)||query.limit<16||query.limit>4000))throw problem('绘图采样上限无效。','invalid_input');
      const data=assertWaveformResponse(await read(query,options),{runId:run,signal,catalog});readings.set(id,data);onWaveform(data);return data;
    }
  };
  async function select(signalIds){
    const selected=[...new Set(signalIds)];if(selected.length>16||selected.some(id=>!catalog?.signals.some(s=>s.id===id&&s.status==='available')))throw problem('选择超出当前已保存信号目录。','invalid_input');
    return queue(async()=>{
      const args={...ids(),expected_revision:view.revision,selection:selected.length?{kind:'signals',signal_ids:selected}:{kind:'none'}};
      const next=await host.call('ic_view_select',args);if(disposed)throw aborted();return accept(next,'select');
    });
  }
  async function reportLoaded(){return queue(async()=>{const next=await host.call('ic_view_state',{...ids(),expected_revision:view.revision,client_state:'loaded',message:'Saved signal catalog loaded in this client; native host mounting unverified.'});if(disposed)throw aborted();return accept(next,'state');});}
  async function refresh(){return queue(async()=>{const next=await host.call('ic_view_get',ids());if(disposed)throw aborted();return accept(next);});}
  async function workspace(){return queue(async()=>{
    const value=await host.call('ic_workspace_get',{workspace_id:view.workspace_id});if(disposed)throw aborted();
    if(value?.schema!=='ic.workspace.v1'||value.workspace_id!==view.workspace_id||!Number.isSafeInteger(value.revision)||value.revision<workspaceRevision)throw problem('工作区响应过期或身份不匹配。');
    workspaceRevision=value.revision;return value;
  });}
  const unsubscribe=host.onResult?.(value=>{
    if(disposed||value?.schema!=='ic.view.v1'||value.view_id!==view.view_id||value.workspace_id!==view.workspace_id)return;
    if(value.revision<view.revision)return;
    try{accept(value);}catch(error){onError(error);}
  });
  return {api,get view(){return clone(view);},get catalog(){return catalog;},get mapping(){return mapping;},clearData(){catalog=null;mapping=null;readings.clear();},readings,accept,select,reportLoaded,refresh,workspace,
    dispose(){disposed=true;unsubscribe?.();readings.clear();}};
}
