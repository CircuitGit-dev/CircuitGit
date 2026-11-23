// Consumer of the frozen StudioHost v1. Does not own app or context state.
import {createReceiptActions} from './receipts.js';
export const ACTIVE_RUN_STATES=new Set(['queued','preflight','submitted','running','running_observed','collecting','archiving']);
export function parseConfiguration(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 1024 * 1024) throw Error('配置超过 1 MiB。');
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('配置必须是 JSON 对象。');
  // JSON.parse accepts duplicate keys; reject them before a form edit can erase one.
  const stack=[];
  for(let i=0;i<text.length;i++) {
    const char=text[i];
    if(char==='"') {
      let end=i+1;
      for(;end<text.length;end++){if(text[end]==='\\'){end++;continue;}if(text[end]==='"')break;}
      const top=stack.at(-1);
      if(top?.keys && top.key){const key=JSON.parse(text.slice(i,end+1));if(top.keys.has(key))throw Error('重复 JSON 字段：'+key);top.keys.add(key);top.key=false;}
      i=end;
    } else if(char==='{')stack.push({keys:new Set(),key:true});
    else if(char==='[')stack.push({});
    else if(char==='}'||char===']')stack.pop();
    else if(char===','&&stack.at(-1)?.keys)stack.at(-1).key=true;
  }
  return value;
}

export function updateConfiguration(text, path, value) {
  const data=parseConfiguration(text);
  let target=data;
  for(const key of path.slice(0,-1)) {
    if(target[key]===undefined)target[key]={};
    if(!target[key]||Array.isArray(target[key])||typeof target[key]!=='object')throw Error('字段 '+key+' 不是对象，请在 JSON 中修正。');
    target=target[key];
  }
  if(value===undefined)delete target[path.at(-1)];else target[path.at(-1)]=value;
  return JSON.stringify(data,null,2)+'\n';
}

export function createController(host, changed=()=>{}) {
  if(host?.version!==1||!host.gateway||!host.context)throw Error('需要 RNL Studio host v1。');
  const api=host.gateway;
  let epoch=0, disposed=false, currentKey=null, loadingPromise=Promise.resolve(), uncertainSubmission=false, uncertainSave=false;
  const drafts=new Map(),acknowledgedDrafts=new Map();
  const state={projectId:null,sourceCommit:null,configurationId:null,configurations:[],descriptor:null,draftText:'',preview:null,plan:null,preflight:null,busy:null,error:null,suspended:false,contextBlocked:true,runs:[],lastReceipt:null,submitAttempt:null,pushAfterSave:false,saveReceipt:null,saveAttempt:null,commitMessage:null};
  const emit=()=>{if(!disposed)changed(state);};
  const receipts=createReceiptActions(host,{changed:emit,blocked:()=>!!state.busy||state.suspended||state.contextBlocked});
  const messageDraft=host.createCommitMessage?.({onChange:s=>{state.commitMessage=s;emit();}})||null;
  const invalidate=()=>{state.preview=null;state.plan=null;state.preflight=null;messageDraft?.invalidate();};
  const draftDirty=()=>!!state.descriptor&&state.draftText!==state.descriptor.configuration_text;
  const draftKey=()=>JSON.stringify([state.projectId,state.configurationId,state.sourceCommit]);
  function rememberDraft(){
    if(!state.descriptor)return;
    const key=draftKey();
    if(!draftDirty()||acknowledgedDrafts.get(key)===state.draftText){drafts.delete(key);return;}
    if(!drafts.has(key)&&drafts.size>=32)throw Error('组件已保留 32 份未保存草稿；请先明确处理一份旧草稿。');
    drafts.set(key,{key,projectId:state.projectId,configurationId:state.configurationId,sourceCommit:state.sourceCommit,configurationSha256:state.descriptor.configuration_sha256,text:state.draftText});
  }
  const snapshotKey=()=>[state.projectId,state.configurationId,state.sourceCommit,epoch].join('|');
  function guard({committed=false,preview=false,plan=false,preflight=false}={}) {
    if(disposed||state.busy||receipts.busy||state.contextBlocked||state.suspended||!state.descriptor)throw Error('当前配置身份不可用于操作；请先核对版本并重新读取。');
    if(committed&&draftDirty())throw Error('请先预览并保存配置草稿。');
    if(preview&&(!state.preview||state.preview.text!==state.draftText))throw Error('需要当前草稿的有效差异预览。');
    if(plan&&!state.plan)throw Error('请先生成当前版本的计划。');
    if(preflight&&!state.preflight)throw Error('请先显式执行当前计划的远端预检。');
  }
  function inputs(){return {project_id:state.projectId,configuration:state.configurationId,source_commit:state.sourceCommit};}
  function configurationChange(){return {base_commit:state.sourceCommit,changes:[{path:state.descriptor.configuration_path,sha256:state.descriptor.configuration_sha256,content:state.draftText}]};}
  async function action(name, fn) {
    const key=snapshotKey();state.busy=name;state.error=null;emit();
    try {return await fn(()=>!disposed&&key===snapshotKey());}
    catch(error){if(key===snapshotKey()&&!disposed){state.error=error.message||String(error);state.suspended=true;invalidate();host.notify(state.error,{kind:'error'});}throw error;}
    finally {if(key===snapshotKey()&&!disposed){state.busy=null;emit();}}
  }
  function checkEffective(effective){if(!effective?.compiled_inputs_sha256||effective.compiled_inputs_sha256!==state.descriptor.effective.compiled_inputs_sha256)throw Error('计划的编译输入与已读配置不一致；操作已停止。');}
  async function load(id) {
    if(!state.projectId||!state.sourceCommit||state.contextBlocked)return;
    rememberDraft();
    const ticket=++epoch;
    messageDraft?.reset();
    state.configurationId=id;state.descriptor=null;state.draftText='';state.busy='读取配置';state.error=null;state.suspended=uncertainSubmission||uncertainSave;invalidate();emit();
    const query=new URLSearchParams(inputs());
    try {
      const descriptor=await api.request('/configuration?'+query);
      if(ticket!==epoch||disposed)return;
      if(descriptor?.schema!=='ic.sim.configuration-description.v1'||descriptor.project_id!==state.projectId||descriptor.configuration!==id||descriptor.source_commit!==state.sourceCommit||typeof descriptor.configuration_text!=='string'||!descriptor.effective?.compiled_inputs_sha256)throw Error('配置描述端点返回了不一致的身份或协议。');
      parseConfiguration(descriptor.configuration_text);
      state.descriptor=descriptor;
      const cached=drafts.get(draftKey());
      if(cached&&cached.configurationSha256!==descriptor.configuration_sha256)throw Error('同一提交的配置哈希发生变化；草稿已保留，操作停止。');
      state.draftText=cached?.text??descriptor.configuration_text;
    } catch(error){if(ticket===epoch&&!disposed){state.error=error.message||String(error);state.suspended=true;}}
    finally{if(ticket===epoch&&!disposed){state.busy=null;emit();}}
  }
  function synchronize() {
    if(disposed)return Promise.resolve();
    const registry=host.getProject(), context=host.context.getContext();
    const projectId=registry?.activeProjectId;
    const project=registry?.projects?.find(p=>p.id===projectId);
    const commit=registry?.source_commit;
    const blocked=!project||!commit||context?.loading===true||['loading','error'].includes(context?.loadState)||context?.file?.dirty===true||context?.project?.id!==projectId||context?.project?.sourceCommit!==commit;
    state.runs=[...(host.getRuns()||[])];
    host.slots?.simulation?.setBadge(state.runs.some(r=>ACTIVE_RUN_STATES.has(r.state))?'运行中':state.runs.some(r=>['reconcile_required','unknown'].includes(r.state))?'需核对':null);
    const key=JSON.stringify([projectId,commit,blocked]);
    if(key===currentKey){emit();return loadingPromise;}
    rememberDraft();
    const previousProject=state.projectId;currentKey=key;++epoch;
    state.projectId=projectId||null;state.sourceCommit=commit||null;state.configurations=project?.configurations||[];state.contextBlocked=blocked;
    state.descriptor=null;state.draftText='';state.busy=null;state.error=null;invalidate();
    if(previousProject!==projectId){state.configurationId=null;state.lastReceipt=null;state.submitAttempt=null;state.pushAfterSave=false;}
    state.configurationId=state.configurations.some(c=>c.id===state.configurationId)?state.configurationId:state.configurations[0]?.id||null;
    emit();
    if(!blocked&&state.configurationId)loadingPromise=load(state.configurationId);
    return loadingPromise;
  }
  const unsubscribe=host.context.subscribe(synchronize);
  const controller={state, draftDirty,receipts,
    setCommitTitle(value){if(state.busy)throw Error('操作进行中。');messageDraft?.setTitle(value);},
    setCommitBody(value){if(state.busy)throw Error('操作进行中。');messageDraft?.setBody(value);},
    commitMessageValid(){try{return !messageDraft||!!messageDraft.message();}catch{return false;}},
    setPushAfterSave(value){if(state.busy||state.suspended)throw Error('当前不能修改推送选择。');state.pushAfterSave=value===true;emit();},
    getDrafts:()=>[...drafts.values()].map(d=>({...d,active:d.key===draftKey()})),
    discardDraft(key,confirmed){if(confirmed!==true)throw Error('需要明确确认丢弃这份未保存草稿。');drafts.delete(key);if(key===draftKey()&&state.descriptor){state.draftText=state.descriptor.configuration_text;invalidate();}emit();},
    ready:()=>loadingPromise,
    synchronize,
    async reload(){await host.refresh({project:true,runs:true});await synchronize();if(!state.contextBlocked)await load(state.configurationId);},
    async chooseConfiguration(id){if(!state.configurations.some(c=>c.id===id))throw Error('未知配置。');return load(id);},
    setDraftText(text){if(state.busy)throw Error('操作进行中。');if(!drafts.has(draftKey())&&drafts.size>=32)throw Error('组件已保留 32 份未保存草稿；请先明确处理一份旧草稿。');if(new TextEncoder().encode(text).length>1024*1024)throw Error('配置草稿超过 1 MiB；原草稿保留。');state.draftText=text;rememberDraft();state.error=null;invalidate();emit();},
    edit(path,value){this.setDraftText(updateConfiguration(state.draftText,path,value));},
    async preview(){guard();parseConfiguration(state.draftText);const text=state.draftText,body=configurationChange();return action('预览差异',async current=>{const result=await api.preview(body);if(!current())return;if(result.base_commit!==state.sourceCommit||!result.review_id||!Array.isArray(result.configuration_previews))throw Error('差异预览缺少配置编译结果。');const effective=result.configuration_previews.find(x=>x.project_id===state.projectId&&x.configuration===state.configurationId)?.effective;if(!effective?.compiled_inputs_sha256)throw Error('未返回选中配置的编译结果。');state.preview={result,text,body,effective};void messageDraft?.prepare({project_id:state.projectId,base_commit:state.sourceCommit,review_id:result.review_id});return result;});},
    async commit(){
      guard({preview:true});if(uncertainSave)throw Error('上次保存/推送结果未确认；禁止重复提交。');
      const body={...state.preview.body,message:messageDraft?messageDraft.message():'Update '+state.configurationId+' simulation configuration',push:state.pushAfterSave===true};messageDraft?.freeze();
      const identity={projectId:state.projectId,configurationId:state.configurationId,baseCommit:state.sourceCommit,pushRequested:body.push};
      state.saveAttempt={...identity,status:'requesting'};
      return action(body.push?'提交并推送配置':'保存配置',async current=>{
        uncertainSave=true;
        try{
          const result=await api.save(body);
          state.saveReceipt={...identity,sourceCommit:result?.source_commit||null,pushStatus:result?.push_status??null};
          if(!/^[a-f0-9]{40}$/.test(result?.source_commit||'')||!['confirmed','not_requested'].includes(result?.push_status)||body.push&&result.push_status!=='confirmed'||!body.push&&result.push_status!=='not_requested')throw Error('保存/推送回执未确认或不符；保留实际 push_status，请人工核对本地提交与远端，勿重试。');
          uncertainSave=false;state.saveAttempt.status='confirmed';
          if(!current())return result;
          acknowledgedDrafts.set(draftKey(),state.draftText);drafts.delete(draftKey());state.pushAfterSave=false;state.preview=null;state.plan=null;state.preflight=null;
          await host.refresh({project:true});await synchronize();return result;
        }catch(error){if(uncertainSave)state.saveAttempt={...identity,status:'unknown',error:error.message};throw error;}
      });
    },
    async plan(){guard({committed:true});return action('生成计划',async current=>{const result=await api.plan(inputs());if(!current())return;if(result.source_commit!==state.sourceCommit||result.project_id!==state.projectId||result.configuration!==state.configurationId)throw Error('计划身份不一致。');checkEffective(result.settings?.effective);if(result.blockers?.length)throw Error('计划阻塞：'+result.blockers.join(', '));state.plan=result;state.preflight=null;if(!uncertainSubmission)state.submitAttempt=null;return result;});},
    async preflight(){guard({committed:true,plan:true});return action('远端预检',async current=>{const result=await api.preflight(inputs());if(!current())return;if(result.plan?.provenance?.source_commit!==state.sourceCommit)throw Error('预检版本与计划不一致。');checkEffective(result.plan?.configuration?.effective);state.preflight=result;return result;});},
    async submit(confirmed){guard({committed:true,plan:true,preflight:true});if(confirmed!==true)throw Error('请明确确认启动新的仿真任务。');if(state.submitAttempt||uncertainSubmission)throw Error('该提交已发出；请先核对任务列表，不能重复提交。');const body={...inputs(),idempotency_key:crypto.randomUUID()};if(state.plan.resource_selection_required===true){const planId=state.preflight.execution_plan_id;if(typeof planId!=='string'||planId.length!==64||!/^[a-f0-9]{64}$/.test(planId)||state.preflight.execution_target?.plan_id!==planId)throw Error('资源预检缺少已固定的执行计划；请重新预检。');body.execution_plan_id=planId;}state.submitAttempt=body;return action('提交新仿真',async current=>{uncertainSubmission=true;const receipt=await api.submit(body);if(!receipt?.run_id&&!receipt?.job_id)throw Error('提交结果不明确；保留幂等键，停止后续提交。');uncertainSubmission=false;if(!current())return;state.lastReceipt=receipt;state.preflight=null;await host.refresh({runs:true});await host.selectRun(receipt.run_id||receipt.job_id);state.runs=[...(host.getRuns()||[])];return receipt;});},
    async refreshRuns(){await host.refresh({runs:true});state.runs=[...(host.getRuns()||[])];emit();},
    async observeRun(id){const row=host.getRuns().find(r=>(r.run_id||r.job_id)===id);if(!row||['archived','collected'].includes(row.state)||['published','complete'].includes(row.publication?.status))throw Error('已归档任务不执行远端状态刷新。');return action('观察远端任务',async()=>{await api.job(id);await host.refresh({runs:true});state.runs=[...(host.getRuns()||[])];});},
    async selectRun(id){await host.selectRun(id);},
    destroy(){disposed=true;++epoch;unsubscribe();receipts.destroy();messageDraft?.destroy();host.slots?.simulation?.setBadge(null);}
  };
  loadingPromise=synchronize();
  return controller;
}
