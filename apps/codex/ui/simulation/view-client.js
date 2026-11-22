// Exact AI-owner VIEW-CONTRACT v1, unwrapped by the shared MCP Apps host.
import {validateRequest,runId} from './domain.js';
const VIEW=/^v_[a-f0-9]{32}$/,WORKSPACE=/^w_[a-f0-9]{32}$/,COMMIT=/^[a-f0-9]{40}$/;
const sameIdentity=(a,b)=>Object.keys({...a,...b}).every(k=>a[k]===b[k]);
export function createViewClient(host){
  const validate=view=>{
    if(view?.schema!=='ic.view.v1'||view.kind!=='simulation'||!VIEW.test(view.view_id||'')||!WORKSPACE.test(view.workspace_id||'')||!Number.isInteger(view.revision)||view.revision<1||typeof view.identity?.project_id!=='string'||!view.identity.project_id||typeof view.identity?.configuration!=='string'||!view.identity.configuration||!Array.isArray(view.requests)||!COMMIT.test(view.identity.source_commit||''))throw Error('需要独立 simulation view 的完整 workspace/view/revision/source 身份。');
    return view;
  };
  function fromResult(value){const view=value?.schema==='ic.view.v1'?value:value?.view?.schema==='ic.view.v1'?value.view:null;return view?.kind==='simulation'?view:null;}
  const ref=view=>({workspace_id:view.workspace_id,view_id:view.view_id});
  const cas=view=>({...ref(view),expected_revision:view.revision});
  function same(old,next,{read=false}={}){
    validate(next);
    if(next.view_id!==old.view_id||next.workspace_id!==old.workspace_id||!sameIdentity(next.identity,old.identity)||next.revision<old.revision||(read&&next.revision!==old.revision))throw Error('MCP 返回了其他窗口、过期 revision 或静默更换的工程身份。');
    return next;
  }
  async function data(view,query){
    validate(view);const reply=await host.call('ic_view_data',{...ref(view),revision:view.revision,query});
    same(view,reply?.view,{read:true});if(reply.kind!==query.kind||!Object.hasOwn(reply,'payload'))throw Error('MCP UI data 缺少工程 payload；需宿主解包 _meta.icWorkbench.data。');return reply.payload;
  }
  async function transition(old,next){
    if(old.identity.run_id===next?.identity?.run_id)return same(old,next);
    const expected={...old,identity:{...old.identity,run_id:next?.identity?.run_id}};
    same(expected,next);
    if(!next.identity.run_id)throw Error('不能清除已经绑定的 run。');
    // Only this view's accepted submit receipt can justify a changed run binding.
    for(const summary of next.requests||[]){
      if(summary.operation!=='sim_submit'||summary.state!=='accepted')continue;
      const receipt=await data(next,{kind:'request',request_id:summary.request_id});
      const args={project_id:old.identity.project_id,configuration:old.identity.configuration,source_commit:old.identity.source_commit,idempotency_key:receipt?.arguments?.idempotency_key};
      validateRequest(receipt,'sim_submit',args);
      if(receipt.request_id===summary.request_id&&receipt.fingerprint===summary.fingerprint&&receipt.state==='accepted'&&runId(receipt.result)===next.identity.run_id)return next;
    }
    throw Error('run 变更没有本窗口已接受的提交回执依据。');
  }
  async function revise(tool,view,args){const reply=await host.call(tool,{...cas(view),...args});const next=reply?.view||reply;same(view,next);if(next.revision<=view.revision)throw Error('CAS 状态操作未返回新 revision。');return reply;}
  return {
    validate,fromResult,same,transition,
    async refresh(view){validate(view);return transition(view,await host.call('ic_view_get',ref(view)));},
    configuration:view=>data(view,{kind:'configuration'}),
    project:view=>data(view,{kind:'project'}),
    draft:view=>data(view,{kind:'draft'}),
    async jobs(view){const payload=await data(view,{kind:'runs'});if(!Array.isArray(payload?.jobs))throw Error('本地任务列表协议不符。');return payload.jobs;},
    requestStatus:(view,requestId)=>data(view,{kind:'request',request_id:requestId}),
    async requestReview(view,receipt){
      validate(view);
      const summary=view.requests.find(r=>r.request_id===receipt?.request_id);
      if(!summary||summary.fingerprint!==receipt.fingerprint||summary.operation!==receipt.operation||receipt.state!=='pending_approval')throw Error('只能审核本窗口持有的待审核请求。');
      // This identifies the frozen request. The host alone collects the decision.
      const reply=await host.call('ic_request_review',{request_id:receipt.request_id,fingerprint:receipt.fingerprint});
      if(!['approved','denied','cancelled','not_approved','timeout','unsupported','host_rejected','invalid_response','already_resolved','disconnected','invalid_transport'].includes(reply?.review_status)||reply.automatic_retry!==false)throw Error('宿主审核返回了未知协议；请刷新原请求。');
      validateRequest(reply.request,receipt.operation,receipt.arguments,receipt);
      return reply;
    },
    async results(view,id){if(!view.identity.run_id||view.identity.run_id!==id)throw Error('当前 simulation 窗口未绑定该 run；仅能查看列表中已保存的回执摘要。');return data(view,{kind:'results'});},
    async storeDraft(view,draft){return revise('ic_view_draft',view,{text:draft.text});},
    async preview(view){return revise('ic_view_plan',view,{action:'preview_draft'});},
    async plan(view){return revise('ic_view_plan',view,{action:'plan'});},
    async request(view,operation,key,message){return revise('ic_view_request',view,{operation,idempotency_key:key,...(message?{message}:{})});},
    async bindRun(view,receipt){
      if(receipt?.operation!=='sim_submit'||receipt.state!=='accepted'||!runId(receipt.result))throw Error('绑定需要本窗口已接受的 submit 回执。');
      const reply=await host.call('ic_view_bind_run',{...cas(view),request_id:receipt.request_id});
      same({...view,identity:{...view.identity,run_id:runId(receipt.result)}},reply);
      if(reply.revision<view.revision||(view.identity.run_id!==reply.identity.run_id&&reply.revision===view.revision))throw Error('绑定未返回新 revision。');
      return reply;
    },
    async loaded(view){return revise('ic_view_state',view,{client_state:'loaded',message:'Simulation data validated by component; native host mounting unverified.'});},
    newViewArguments(view,sourceCommit,configuration=view.identity.configuration,runId=null){return {project_id:view.identity.project_id,configuration,source_commit:sourceCommit,workspace_id:view.workspace_id,...(runId?{run_id:runId}:{})};},
  };
}
