import {parseConfiguration,updateConfiguration,validateDescriptor,validateRequest,HASH,COMMIT,MUTATIONS,PENDING_STATES,receiptPolicy,fullCollection,safeResult,runId} from './domain.js';

// One controller belongs to one immutable view. All engineering access uses views.
export function createSimulationController(host,views,changed=()=>{}){
  let disposed=false,epoch=0,serial=0,unsubscribe=()=>{},ready=Promise.resolve();
  const drafts=new Map(),attempts=new Map();
  const state={view:null,descriptor:null,text:'',storedText:null,draftVersion:0,draftStoredVersion:null,busy:null,error:null,suspended:false,review:null,plan:null,jobs:[],results:new Map(),selectedRun:null,requests:[],notice:null,newView:null,configurationUnavailable:false,loaded:false};
  const emit=()=>{if(!disposed)changed(state);};
  const identity=()=>state.view?.identity||{};
  const key=()=>JSON.stringify([state.view?.workspace_id,state.view?.view_id,identity().project_id,identity().configuration,identity().source_commit]);
  const dirty=()=>!!state.descriptor&&state.text!==state.descriptor.configuration_text;
  const invalidate=()=>{state.review=null;state.plan=null;};
  const remember=()=>{
    if(!state.descriptor)return;
    if(!dirty()&&state.text===state.storedText){drafts.delete(key());return;}
    drafts.set(key(),{key:key(),identity:{...identity()},text:state.text,version:state.draftVersion,configuration_sha256:state.descriptor.configuration_sha256});
  };
  const setRequests=()=>{state.requests=[...attempts.values()];};
  const unresolved=()=>state.requests.some(a=>a.unresolved||!a.receipt||PENDING_STATES.has(a.receipt.state));
  const acceptedApply=()=>state.requests.some(a=>a.operation==='apply'&&a.receipt?.state==='accepted');
  function guard({committed=false,review=false,plan=false,runOnly=false}={}){
    if(disposed||state.busy||state.suspended||!state.view||(!runOnly&&!state.descriptor)||(runOnly&&!state.loaded))throw Error('窗口尚未就绪或身份待核对；请重新读取。');
    if(unresolved())throw Error('已有待审批或未知请求；先刷新该请求，不能重新生成或自动批准。');
    if(!runOnly&&acceptedApply())throw Error('配置提交已被网关接受；请核对回执并打开新 commit 的独立窗口。');
    if(committed&&dirty())throw Error('计划只接受已提交版本；请先预览并生成人工审批请求。');
    if(review&&(!state.review||state.review.text!==state.text||state.review.key!==key()||state.view.review_id!==state.review.response.review_id))throw Error('需要当前版本草稿的有效 diff。');
    if(plan&&(!state.plan||state.plan.key!==key()||!state.view.plan_ready))throw Error('请先生成并核对本版本的计划。');
  }
  async function work(label,fn){
    if(disposed||state.busy)throw Error('窗口已关闭或操作进行中。');
    const ticket=++serial,currentEpoch=epoch;state.busy=label;state.error=null;emit();
    const current=()=>!disposed&&epoch===currentEpoch&&serial===ticket;
    try{return await fn(current);}
    catch(error){if(current()){state.error=error.message||String(error);state.suspended=true;invalidate();}throw error;}
    finally{if(current()){state.busy=null;emit();}}
  }
  async function modelContext(value){
    if(disposed)return;
    try{await host.updateModelContext?.({kind:'simulation',workspace_id:state.view.workspace_id,view_id:state.view.view_id,revision:state.view.revision,...identity(),...value});}
    catch{if(!disposed){state.notice='模型上下文更新不可用；窗口数据与审批状态仍独立保留。';emit();}}
  }
  function checkJobs(jobs,view){
    const seen=new Set();
    for(const row of jobs){
      const id=runId(row),prior=state.jobs.find(r=>runId(r)===id);
      if(!id||seen.has(id)||!COMMIT.test(row.source_commit||'')||(row.associated_project_id||row.project_id)!==view.identity.project_id)throw Error('本地任务列表存在重复或不匹配的项目/run/source 身份。');
      if(prior&&prior.source_commit!==row.source_commit)throw Error('相同 run 的 source commit 改变。');
      seen.add(id);
    }
    if(view.identity.run_id&&!jobs.some(r=>runId(r)===view.identity.run_id&&r.source_commit===view.identity.source_commit&&r.configuration===view.identity.configuration))throw Error('绑定运行的项目、配置或 source commit 与列表不一致。');
    return jobs;
  }
  function argumentsFor(operation,args,view){
    const i=view.identity,k=args?.idempotency_key;
    if(typeof k!=='string'||k.length<8||k.length>160)throw Error('请求缺少原始幂等键。');
    if(operation==='apply'){
      if(!HASH.test(args.review_id||'')||typeof args.message!=='string'||!args.message)throw Error('配置请求缺少冻结 review 或提交说明。');
      return {review_id:args.review_id,message:args.message,idempotency_key:k};
    }
    if(operation==='sim_submit')return {project_id:i.project_id,configuration:i.configuration,source_commit:i.source_commit,idempotency_key:k};
    if(['sim_collect','sim_archive'].includes(operation)&&i.run_id)return {run_id:i.run_id,idempotency_key:k};
    throw Error('请求操作不属于此视图的明确身份。');
  }
  function restoreReceipt(receipt,summary,view){
    if(receipt?.request_id!==summary.request_id||receipt.fingerprint!==summary.fingerprint||receipt.operation!==summary.operation)throw Error('窗口请求摘要与完整回执不一致。');
    const args=argumentsFor(receipt.operation,receipt.arguments,view),prior=attempts.get(args.idempotency_key);
    validateRequest(receipt,receipt.operation,prior?.arguments||args,prior?.receipt);
    const attempt=prior||{operation:receipt.operation,arguments:args,view_id:view.view_id,workspace_id:view.workspace_id,project_id:view.identity.project_id,source_commit:view.identity.source_commit};
    attempt.receipt=receipt;attempt.unresolved=receipt.state==='uncertain';attempt.error=null;attempts.set(args.idempotency_key,attempt);setRequests();
    return attempt;
  }
  async function load(view){
    view=structuredClone(views.validate(view));if(disposed)return false;
    if(state.view){
      if(view.view_id!==state.view.view_id||view.workspace_id!==state.view.workspace_id||view.revision<state.view.revision)return false;
      await views.transition(state.view,view);
      if(disposed||view.revision<state.view.revision)return false;
    }
    remember();++epoch;++serial;state.view=view;state.busy=null;state.suspended=true;state.error=null;invalidate();emit();
    return work('读取版本化配置与本地回执',async current=>{
      // Read owned requests first: approvals remain inspectable even after source drift.
      for(const summary of view.requests||[]){
        const receipt=await views.requestStatus(view,summary.request_id);if(!current())return false;
        restoreReceipt(receipt,summary,view);
      }
      const historical=!!view.identity.run_id&&view.identity.path===null&&view.identity.source_sha256===null;
      const reads=await Promise.allSettled(historical?[views.jobs(view)]:[views.configuration(view),views.draft(view),views.jobs(view)]);
      if(!current())return false;
      const failure=reads.find(r=>r.status==='rejected');if(failure)throw failure.reason;
      const values=reads.map(r=>r.value),jobs=checkJobs(historical?values[0]:values[2],view);
      if(historical){
        state.descriptor=null;state.text='';state.storedText='';state.configurationUnavailable=true;
        state.notice='历史运行保持原 source commit；此窗口不读取或修改当前配置。可查看结果并按回执申请收集/归档。';
      }else{
        const [raw,draft]=values,descriptor=validateDescriptor(raw,view.identity);
        parseConfiguration(descriptor.configuration_text);
        if(typeof draft?.text!=='string'||draft.base_sha256!==descriptor.configuration_sha256||draft.dirty!==(draft.text!==descriptor.configuration_text))throw Error('已保存草稿的内容或 base SHA 不符。');
        parseConfiguration(draft.text);const cached=drafts.get(key());
        if(cached&&cached.configuration_sha256!==descriptor.configuration_sha256)throw Error('相同 commit 的配置哈希改变；旧草稿保留。');
        state.descriptor=descriptor;state.configurationUnavailable=false;
        state.text=cached?.text??draft.text;state.draftVersion=cached?.version??0;state.storedText=draft.text;state.draftStoredVersion=state.text===draft.text?state.draftVersion:null;
      }
      state.jobs=jobs;state.selectedRun=state.selectedRun&&jobs.some(r=>runId(r)===state.selectedRun)?state.selectedRun:view.identity.run_id||null;
      state.loaded=true;state.suspended=state.requests.some(a=>a.unresolved);remember();
      if(view.readiness?.state!=='loaded'){
        const next=await views.loaded(view);if(!current())return false;state.view=next;
      }
      await modelContext({readiness:'data_loaded',compiled_inputs_sha256:state.descriptor?.effective.compiled_inputs_sha256||null});return true;
    });
  }
  async function persist(current){
    if(state.text===state.storedText)return true;
    const text=state.text,version=state.draftVersion,next=await views.storeDraft(state.view,{text});
    if(!current())return false;
    state.view=next;state.storedText=text;state.draftStoredVersion=version;invalidate();remember();return true;
  }
  async function prepare(operation,args){
    if(!MUTATIONS.has(operation))throw Error('不支持的受控操作。');
    if(state.requests.some(a=>a.operation===operation&&(!a.receipt||PENDING_STATES.has(a.receipt.state)||a.receipt.state==='accepted'||a.unresolved)))throw Error('同一输入已有请求，请刷新已有回执；禁止改用新 key 重试。');
    const view=state.view,arguments_={...args,idempotency_key:crypto.randomUUID()};
    const attempt={operation,arguments:arguments_,view_id:view.view_id,workspace_id:view.workspace_id,project_id:view.identity.project_id,source_commit:view.identity.source_commit,receipt:null,unresolved:true};
    attempts.set(arguments_.idempotency_key,attempt);setRequests();
    return work('创建待审批请求',async current=>{
      try{
        const reply=await views.request(view,operation,arguments_.idempotency_key,arguments_.message);
        const receipt=validateRequest(reply.request,operation,arguments_);
        if(!['human-cli','host-elicitation'].includes(reply.human_confirmation?.mode)||reply.human_confirmation.automatic_approval!==false)throw Error('人工审批协议不符。');
        // Retain an issued request even when a newer notification superseded the render.
        attempt.receipt=receipt;attempt.unresolved=receipt.state==='uncertain';attempt.error=null;setRequests();
        if(current()){
          state.view=reply.view;invalidate();state.notice='请求已登记，尚未批准。请点击「在Codex中审核」，核对冻结请求并由本人决定。';
          await modelContext({request_id:receipt.request_id,state:receipt.state,operation});
        }
        return receipt;
      }catch(error){attempt.error=error.message;attempt.unresolved=true;setRequests();throw error;}
    });
  }
  const controller={state,dirty,blocked:()=>!!state.busy||state.suspended||unresolved()||acceptedApply(),ready:()=>ready,
    drafts:()=>[...drafts.values()].map(d=>({...d,active:d.key===key()})),
    async reload(){
      let next;await work('读取窗口身份',async current=>{const value=await views.refresh(state.view||host.initial);if(current())next=value;});
      return next?load(next):false;
    },
    async acceptResult(value){
      const next=views.fromResult(value);if(!next||disposed)return false;
      if(state.view&&(next.view_id!==state.view.view_id||next.workspace_id!==state.view.workspace_id||next.revision<state.view.revision))return false;
      try{if(state.view){await views.transition(state.view,next);if(next.revision===state.view.revision&&JSON.stringify(next.requests)===JSON.stringify(state.view.requests))return false;}return await load(next);}
      catch(error){++epoch;++serial;state.busy=null;state.suspended=true;state.error=error.message;invalidate();emit();throw error;}
    },
    edit(path,value){return this.setText(updateConfiguration(state.text,path,value));},
    setText(text){guard();if(typeof text!=='string'||new TextEncoder().encode(text).length>1024*1024)throw Error('草稿超过 1 MiB；旧草稿保留。');state.text=text;++state.draftVersion;state.draftStoredVersion=null;remember();invalidate();emit();},
    async discard(key_,confirmed){
      if(confirmed!==true)throw Error('需要明确确认丢弃草稿。');guard();if(key_!==key())throw Error('不能丢弃其他窗口草稿。');
      state.text=state.descriptor.configuration_text;++state.draftVersion;invalidate();remember();
      await this.storeDraft();drafts.delete(key_);emit();
    },
    async storeDraft(){guard();parseConfiguration(state.text);return work('保存窗口草稿',async current=>{
      if(!await persist(current))return;state.notice='草稿已保存到窗口状态；尚未修改配置文件或提交 Git。';return state.view;
    });},
    async preview(){guard();parseConfiguration(state.text);if(!dirty())throw Error('配置没有修改。');return work('编译并预览差异',async current=>{
      if(!await persist(current))return;
      const reply=await views.preview(state.view);if(!current())return;
      state.view=reply.view;const response=reply.result;
      const effective=response?.configuration_previews?.find(x=>x.project_id===identity().project_id&&x.configuration===identity().configuration)?.effective;
      if(response?.base_commit!==identity().source_commit||!HASH.test(response.review_id||'')||response.review_id!==reply.view.review_id||typeof response.diff!=='string'||!HASH.test(effective?.compiled_inputs_sha256||''))throw Error('diff 缺少当前配置的可核对编译结果。');
      validateDescriptor({...state.descriptor,effective},identity());
      state.review={response,effective,text:state.text,key:key()};state.plan=null;return response;
    });},
    async requestApply(){guard({review:true});return prepare('apply',{review_id:state.review.response.review_id,message:'Update '+identity().configuration+' from versioned MCP configuration draft'});},
    async plan(){guard({committed:true});return work('生成本地计划',async current=>{
      if(!await persist(current))return;
      const reply=await views.plan(state.view);if(!current())return;state.view=reply.view;const response=reply.result;
      if(response?.source_commit!==identity().source_commit||response.project_id!==identity().project_id||response.configuration!==identity().configuration||response.settings?.effective?.compiled_inputs_sha256!==state.descriptor.effective.compiled_inputs_sha256||!state.view.plan_ready)throw Error('计划身份或编译输入与当前配置不同。');
      if(response.blockers?.length)throw Error('计划阻塞：'+response.blockers.join(', '));
      state.plan={response,key:key()};return response;
    });},
    async requestSubmit(){guard({committed:true,plan:true});return prepare('sim_submit',{project_id:identity().project_id,configuration:identity().configuration,source_commit:identity().source_commit});},
    async requestReview(requestId){
      const attempt=state.requests.find(a=>a.receipt?.request_id===requestId);
      if(!attempt||attempt.receipt.state!=='pending_approval'||state.suspended)throw Error('请先核对本窗口的待审核请求。');
      return work('等待 Codex 人工审核',async current=>{
        const view=await views.refresh(state.view);if(!current())return;
        const summary=view.requests.find(r=>r.request_id===requestId);if(!summary)throw Error('窗口不再持有该请求。');
        const receipt=await views.requestStatus(view,requestId);if(!current())return;
        restoreReceipt(receipt,summary,view);state.view=view;
        if(receipt.state!=='pending_approval'){state.notice='请求状态已改变；已读取回执，未重新发起审核。';return receipt;}
        const reply=await views.requestReview(view,receipt);
        // Notifications/teardown may supersede this render while the human decides.
        if(!current())return reply.request;
        const next=await views.refresh(state.view);if(!current())return reply.request;
        const saved=await views.requestStatus(next,requestId);if(!current())return reply.request;
        const latest=next.requests.find(r=>r.request_id===requestId);if(!latest)throw Error('窗口不再持有该请求。');
        restoreReceipt(saved,latest,next);state.view=next;invalidate();
        const notices={approved:'人工审核已提交；以下以保存的回执为准。',denied:'已保存人工拒绝。',cancelled:'审核已取消，请求仍待审核。',not_approved:'未勾选批准，请求仍待审核。',timeout:'审核等待超时，请求仍待审核；不会自动重试。',unsupported:'当前宿主未声明表单审核能力，请求仍待审核。',host_rejected:'宿主拒绝审核，请求仍待审核。',invalid_response:'宿主审核回应无效，请求仍待审核。',already_resolved:'请求已处理；已读取保存回执。',disconnected:'审核连接已关闭；请核对保存回执。',invalid_transport:'审核协议中断；请核对保存回执。'};
        state.notice=notices[reply.review_status];
        if(['host_rejected','invalid_response','disconnected','invalid_transport'].includes(reply.review_status))state.suspended=true;
        await modelContext({request_id:requestId,state:saved.state,operation:saved.operation,review_status:reply.review_status});return saved;
      });
    },
    async requestStatus(requestId){
      const attempt=state.requests.find(a=>a.receipt?.request_id===requestId);if(!attempt)throw Error('本窗口未记录此请求身份。');
      return work('读取本地审批回执',async current=>{
        const view=await views.refresh(state.view);if(!current())return;
        state.view=view;invalidate();const summary=view.requests.find(r=>r.request_id===requestId);if(!summary)throw Error('窗口不再持有该请求。');
        const receipt=await views.requestStatus(view,requestId);if(!current())return;
        restoreReceipt(receipt,summary,view);state.notice='已读取保存的请求状态；accepted 仅表示网关响应，不代表求解或发布完成。';
        await modelContext({request_id:receipt.request_id,state:receipt.state,operation:receipt.operation});return receipt;
      });
    },
    newViewArguments({configuration=identity().configuration,sourceCommit=identity().source_commit,run=null}={}){
      if(!COMMIT.test(sourceCommit||'')||typeof configuration!=='string'||!configuration)throw Error('新窗口需要明确配置与 source commit。');
      return views.newViewArguments(state.view,sourceCommit,configuration,run);
    },
    readAcceptedCommit(requestId){
      const a=state.requests.find(a=>a.receipt?.request_id===requestId),commit=a?.receipt?.result?.source_commit;
      if(a?.operation!=='apply'||a.receipt.state!=='accepted'||!COMMIT.test(commit||''))throw Error('没有可核对的新提交回执。');
      state.newView={tool:'ic_simulation_open',arguments:this.newViewArguments({sourceCommit:commit})};emit();return state.newView;
    },
    showRunWindow(id){
      const row=state.jobs.find(r=>runId(r)===id);if(!row)throw Error('未知 run。');
      state.newView={tool:'ic_simulation_open',arguments:this.newViewArguments({configuration:row.configuration,sourceCommit:row.source_commit,run:id})};emit();return state.newView;
    },
    async bindAcceptedRun(requestId){
      if(disposed||state.busy||state.suspended)throw Error('窗口身份待核对。');
      const attempt=this.inspectRequest(requestId);
      if(attempt?.operation!=='sim_submit'||attempt.receipt.state!=='accepted')throw Error('只能绑定本窗口已接受的提交回执。');
      return work('绑定本窗口提交回执中的运行',async current=>{
        const next=await views.bindRun(state.view,attempt.receipt);if(!current())return;
        state.view=next;state.selectedRun=next.identity.run_id;invalidate();
        const jobs=checkJobs(await views.jobs(next),next);if(!current())return;
        state.jobs=jobs;await modelContext({bound_request_id:requestId});return next;
      });
    },
    async refreshJobs(){return work('读取本地任务列表',async current=>{
      const view=await views.refresh(state.view);if(!current())return;
      state.view=view;invalidate();const jobs=checkJobs(await views.jobs(view),view);if(current())state.jobs=jobs;return jobs;
    });},
    async chooseRun(id){if(disposed||state.busy||!state.jobs.some(r=>runId(r)===id))throw Error('未知 run 或窗口正在读取。');state.selectedRun=id;emit();await modelContext({inspected_run_id:id,inspection:'local-list-only'});},
    async results(id=state.selectedRun){const row=state.jobs.find(r=>runId(r)===id);if(!row)throw Error('先选择已有任务。');return work('读取已保存结果',async current=>{
      const result=safeResult(await views.results(state.view,id),row);if(current())state.results.set(id,result);return result;
    });},
    runPolicy(id=state.selectedRun){
      const row=state.jobs.find(r=>runId(r)===id),result=state.results.get(id),attempt=state.requests.find(a=>{
        if(a.arguments.run_id!==id)return false;
        const completedCollection=a.operation==='sim_collect'&&a.receipt?.state==='accepted'&&fullCollection(result?.collection||row?.collection)&&!['collecting','archiving'].includes(row?.state);
        return !completedCollection&&(!a.receipt||PENDING_STATES.has(a.receipt.state)||a.receipt.state==='accepted'||a.unresolved);
      });
      const policy=receiptPolicy(row,result,attempt?{status:attempt.receipt?.state==='accepted'?'accepted':'unknown'}:null);
      if(!identity().run_id||identity().run_id!==id)return {...policy,collect:false,archive:false,reason:policy.reason+' 此窗口未绑定该 run；列表选择不会改变工程身份。'};
      if(this.blocked())return {...policy,collect:false,archive:false};return policy;
    },
    async requestCollect(){guard({runOnly:true});const policy=this.runPolicy();if(!policy.collect)throw Error(policy.reason);return prepare('sim_collect',{run_id:identity().run_id});},
    async requestArchive(){guard({runOnly:true});const policy=this.runPolicy();if(!policy.archive)throw Error(policy.reason);return prepare('sim_archive',{run_id:identity().run_id});},
    inspectRequest:id=>state.requests.find(a=>a.receipt?.request_id===id)||null,
    dispose(){if(disposed)return;remember();disposed=true;++epoch;++serial;unsubscribe();}
  };
  unsubscribe=host.onResult?.(value=>{ready=controller.acceptResult(value).catch(error=>{if(!disposed){state.error=error.message;state.suspended=true;emit();}});})||(()=>{});
  ready=load(views.fromResult(host.initial)||host.initial).catch(error=>{if(!disposed){state.error=error.message;state.suspended=true;emit();}});
  return controller;
}
