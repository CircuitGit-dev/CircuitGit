// Clean-slate onboarding state. The host owns transport and durable pending state.
// No URL construction, historical configuration, SSH or model call lives here.
import {indexSpectre} from '../../schematic/netlist.js';
import {literalDimensions} from '../../schematic/instance-properties.js';
import {validatePreDispatchRejection} from './submission.js';
import {createAgentDraftEditor,checkAgentTestbench,agentReviewIdentity} from './agent-testbench.js';
import {checkAnalysisResult,ANALYSIS_OPERATIONS} from './analysis.js';
import {onboardingRecovery,recoveryMessage} from './recovery.js';

const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=500)=>typeof value==='string'&&value.length<=max;
const id=value=>text(value,240)&&value.length>0;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const commit=value=>value===null||typeof value==='string'&&/^[a-f0-9]{40,64}$/.test(value);
const step=()=>({status:'idle',result:null,error:null});
const message=error=>String(error?.message||error||'操作未完成。').slice(0,600);
const ports=['input_port','output_port','vdd_port','vss_port'];
const numerics=['supply_v','frequency_hz','temperature_c','nominal_temperature_c','cycles','load_f','rise_s','fall_s','points_per_period'];
export const intentFields=[...ports,...numerics];
const emptyIntent=()=>Object.fromEntries(intentFields.map(key=>[key,'']));
const endpoint=value=>text(value,240)&&value.length>0&&value.trim()===value&&!/[\s\0]/.test(value)&&!value.startsWith('-');
const rejectionTagged=value=>value?.dispatch_outcome==='pre_dispatch_rejected'||object(value)&&Object.hasOwn(value,'rejection');
// Backend public_discovery merges up to 8 selected probes. SpiceOwl permits
// 256 candidates per discovery; the transport's separate 2 MiB cap still applies.
const maxDiscoveryCandidates=8*256;
const selectionFields=['discovery_id','candidate_id','sections','tmi_candidate_id','model_contracts','intent'];
const canonical=value=>JSON.stringify(value,(_key,item)=>object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const sameSelection=(value,expected)=>object(value)&&selectionFields.every(key=>canonical(value[key])===canonical(expected[key]));
const configurationSnapshot=value=>canonical(Object.fromEntries(Object.entries(value).filter(([key])=>!['job','state','updated_at','plans','submission','next_actions'].includes(key))));
function recommended(value){
  const result=value.recommended_selection,nested=value.discovery?.recommended_selection;
  if(result==null&&nested==null)return null;
  if(!object(result)||result.schema!=='ic.onboarding.recommended-selection.v1'||!sha(result.recommendation_id)||!Number.isSafeInteger(result.recommendation_revision)||result.recommendation_revision<0||result.recommendation_revision>value.revision||result.source_sha256!==value.source_sha256||result.discovery_id!==value.discovery?.discovery_id||canonical(result)!==canonical(nested)||typeof result.ready_for_prepare!=='boolean'||!Array.isArray(result.missing)||result.requires_acceptance!==true||result.fresh_dependency_audit_required!==true||result.ready_to_run!==false||!object(result.provenance))throw Error('推荐缺少当前网表、发现记录或版本依据。');
  if(result.ready_for_prepare){
    const choice=value.discovery?.candidates?.find(item=>item.candidate_id===result.candidate_id);
    if(result.missing.length||!choice||!Array.isArray(result.sections)||result.sections.some(section=>!choice.available_sections.includes(section))||result.tmi_candidate_id!==null&&!choice.tmi_candidates.some(item=>(item.tmi_candidate_id||item.candidate_id)===result.tmi_candidate_id)||!object(result.model_contracts)||value.source.requirements.required_masters.some(master=>{const c=result.model_contracts[master];return !['n','p'].includes(c?.polarity)||!Array.isArray(c.terminals)||c.terminals.length!==4||new Set(c.terminals).size!==4||c.terminals.some(role=>!['d','g','s','b'].includes(role));})||!object(result.intent)||ports.some(key=>!id(result.intent[key]))||numerics.some(key=>typeof result.intent[key]!=='number'||!Number.isFinite(result.intent[key])))throw Error('可准备的推荐缺少完整选择或实验条件。');
  }
  return result;
}

export function onboardingWaveformsAvailable({intake,job:receipt}={}){
  const value=receipt?.waveforms;
  if(!object(intake)||!object(receipt)||value?.schema!=='ic.onboarding.waveform-descriptor.v1'||value.available!==true||value.source_binding_verified!==true||value.read_only!==true)return false;
  if(value.intake_id!==intake.intake_id||value.job_id!==receipt.job_id||value.run_id!==receipt.run_id||receipt.job_id!==receipt.run_id||value.source_commit!==receipt.source_commit||value.source_commit!==intake.source_commit||value.original_source_sha256!==intake.source_sha256)return false;
  if(!['archive_sha256','original_source_sha256','compiled_source_sha256','raw_signature','effective_config_sha256'].every(key=>sha(value[key]))||!Array.isArray(value.available_signal_ids)||!(value.available_signal_ids.length&&sha(value.csv_sha256)||value.datasets?.some(row=>row.available===true&&sha(row.data_sha256)&&/^ds_[a-f0-9]{32}$/.test(row.dataset_id)&&(row.available_signal_ids?.length||row.available_device_ids?.length)))||!value.available_signal_ids.every(signal=>id(signal)&&signal.startsWith('s_')))return false;
  if(!['none','added_explicit_subcircuit_wrapper'].includes(value.transformation)||value.transformation==='none'&&value.original_source_sha256!==value.compiled_source_sha256)return false;
  return id(value.compiled_source_path)&&object(value.source_hashes)&&value.source_hashes[value.compiled_source_path]===value.compiled_source_sha256;
}

export function inspectLiteralNetlist(source){
  const name=source?.file_name??source?.name;
  if(!text(name,240)||!name||typeof source?.text!=='string'||!source.text.trim())throw Error('请导入一份独立 Spectre 网表。');
  const bytes=new TextEncoder().encode(source.text).byteLength;
  if(bytes>1024*1024)throw Error('独立网表超过 1 MiB 导入上限。');
  const scopes=indexSpectre(source.text),devices=scopes.flatMap(scope=>scope.instances.map(instance=>({name:instance.name,scope:scope.name,model:instance.model,nodes:instance.nodes,dimensions:literalDimensions(instance.parameters)})));
  return {name,bytes,devices,models:[...new Set(devices.map(device=>device.model))],ports:scopes.filter(scope=>scope.name!=='(top)').map(scope=>({scope:scope.name,names:scope.ports})),literalOnly:true};
}

function session(value,previous=null,{initial=false,mutating=false}={}){
  if(!object(value)||value.schema!=='ic.onboarding.session.v1'||!id(value.connection_id)||!id(value.intake_id)||!Number.isSafeInteger(value.revision)||value.revision<0||!sha(value.source_sha256)||!commit(value.source_commit)||!id(value.state))throw Error('环境响应缺少完整 intake 身份或整数 revision。');
  if(initial&&(value.source_commit!==null||value.state!=='source_inspected'))throw Error('独立网表必须从新的 intake 开始。');
  if(previous&&(value.connection_id!==previous.connection_id||value.intake_id!==previous.intake_id||value.source_sha256!==previous.source_sha256||value.revision<previous.revision||(mutating&&value.revision<=previous.revision)))throw Error('环境响应过期或属于另一份网表。');
  const requirements=value.source?.requirements;
  if(!object(requirements)||!Array.isArray(requirements.instances)||!Array.isArray(requirements.interfaces)||!Array.isArray(requirements.required_masters)||requirements.required_masters.some(name=>!id(name))||!Array.isArray(requirements.issues))throw Error('网表响应缺少字面器件、端口和模型需求。');
  recommended(value);checkAgentTestbench(value);if(value.agent_tb_review)agentReviewIdentity(value);return clone(value);
}
function aliases(value){
  if(!object(value)||!Array.isArray(value.hosts)||value.hosts.length>256||value.network_operations!==0||value.hosts.some(host=>!endpoint(host?.alias)||!Number.isSafeInteger(host.source_count)))throw Error('本机 SSH 别名响应格式不符。');
  return clone(value);
}
function probes(value,targets){
  if(!Array.isArray(value.probes)||!value.probes.length||value.probes.some(probe=>!(id(probe.probe_id)||probe.probe_id===null)||!targets.includes(probe.ssh_target)||!text(probe.observed_at)||!object(probe.environment)))throw Error('探测响应缺少所选主机的观察证据。');
  return value;
}
function discovery(value){
  const result=value.discovery;
  if(!object(result)||!id(result.discovery_id)||!Array.isArray(result.candidates)||result.candidates.length>maxDiscoveryCandidates||Object.hasOwn(value,'discovery_id')||Object.hasOwn(value,'candidates'))throw Error('PDK 响应缺少唯一的嵌套 discovery 身份。');
  const ids=new Set(),probeIds=new Set(value.probes?.map(probe=>probe.probe_id)||[]);
  for(const item of result.candidates){
    if(!id(item?.candidate_id)||ids.has(item.candidate_id)||!probeIds.has(item.probe_id)||!text(item.label)||!Array.isArray(item.available_sections)||item.available_sections.some(section=>section!==null&&!id(section))||!Array.isArray(item.model_contracts)||!Array.isArray(item.tmi_candidates))throw Error('PDK 候选与当前探测身份不一致。');
    ids.add(item.candidate_id);
  }
  if(result.search_directories!==undefined){
    const directories=result.search_directories,seen=new Set();
    if(!Array.isArray(directories)||directories.length>2048)throw Error('观察目录列表超出范围。');
    for(const directory of directories){if(!id(directory?.directory_id)||seen.has(directory.directory_id)||!probeIds.has(directory.probe_id)||!text(directory.label,1000)||!Array.isArray(directory.basis)||directory.basis.some(value=>!text(value))||typeof directory.scanned!=='boolean'||directory.qualified!==false)throw Error('搜索目录不属于本次主机观察。');seen.add(directory.directory_id);}
  }
  return value;
}
function verifiedContracts(candidate,discovery,sections){
  if(!candidate||!Array.isArray(sections)||!Array.isArray(candidate.section_candidates)||sections.length!==candidate.section_candidates.length||!sections.every(section=>candidate.section_candidates.includes(section))||candidate.evidence?.coverage_complete!==true||candidate.missing?.length)return {};
  const coverage=discovery?.coverage?.find(item=>item.probe_id===candidate.probe_id);
  if(coverage?.search_complete!==true||coverage.unknown_count>0)return {};
  const result={};for(const item of candidate.model_contracts){
    const matches=candidate.model_contracts.filter(row=>row.name===item.name);
    if(matches.length!==1||item.confidence!=='verified'||item.needs_confirmation!==false||!['n','p'].includes(item.polarity)||!Array.isArray(item.ordered_terminal_roles)||item.ordered_terminal_roles.length!==4||new Set(item.ordered_terminal_roles).size!==4||!item.ordered_terminal_roles.every(role=>['d','g','s','b'].includes(role)))continue;
    result[item.name]={polarity:item.polarity,terminals:clone(item.ordered_terminal_roles)};
  }
  return result;
}
function prepared(value,allowedTargets=null){
  const plan=value.prepared;
  if(!object(plan)||plan.schema!=='ic.experiment.plan.v1'||!['prepared','blocked'].includes(plan.state))throw Error('实验准备结果缺少正式计划。');
  if(plan.state==='prepared'&&(!id(plan.plan_id)||!id(plan.project_id)||!id(plan.recipe_id)||plan.submission_key!=='experiment-'+plan.plan_id||!commit(plan.source_commit)||!plan.source_commit||plan.source_commit!==value.source_commit||!Array.isArray(value.execution_scope?.selected_ssh_targets)||!value.execution_scope.selected_ssh_targets.length||value.execution_scope.selection_mode!=='automatic_within_selected_hosts'||!Array.isArray(value.execution_scope.candidate_host_ids)||value.execution_scope.resource_check_at_run!==true))throw Error('实验计划缺少固定提交身份或所选主机范围。');
  if(plan.state==='prepared'&&allowedTargets&&value.execution_scope.selected_ssh_targets.some(target=>!allowedTargets.includes(target)))throw Error('实验计划扩大了明确选择的主机范围。');
  if(plan.state==='blocked'&&(plan.plan_id!==null||!Array.isArray(plan.missing)))throw Error('受阻计划缺少明确原因。');
  return value;
}
function job(value,plan,previous=null,scope=null){
  if(!object(value)||value.schema!=='ic.experiment.job.v1'||!id(value.job_id)||value.job_id!==value.run_id||!id(value.state)||!id(value.project_id)||!id(value.configuration)||!id(value.plan_id)||!value.source_commit||!commit(value.source_commit))throw Error('仿真响应缺少完整原 job 身份。');
  if(!plan||value.plan_id!==plan.plan_id||value.project_id!==plan.project_id||value.configuration!==plan.recipe_id||value.source_commit!==plan.source_commit)throw Error('仿真响应与原计划、源码或配置身份不一致。');
  if(previous&&['job_id','run_id','plan_id','project_id','source_commit','configuration'].some(key=>value[key]!==previous[key]))throw Error('观察响应不属于原任务。');
  if(scope&&value.execution_target!==null&&!scope.candidate_host_ids.includes(value.execution_target))throw Error('任务执行主机不在原计划范围内。');
  return clone(value);
}
function pendingRecord(value,connectionId){
  if(!object(value)||value.schema!=='ic.onboarding.pending.v1'||value.connectionId!==connectionId||!id(value.intake_id)||!Number.isSafeInteger(value.revision)||!['prepare','run'].includes(value.phase)||(value.phase==='run'&&(!id(value.plan_id)||value.submission_key!=='experiment-'+value.plan_id)))throw Error('原请求存储身份不完整，已暂停后续写操作。');
  return clone(value);
}

export function createEnvironmentController({adapter=null,pendingStore=null,changed=()=>{},onRun=()=>{}}={}){
  let disposed=false,epoch=0,source=null,unsubscribe=null,restoring=null;
  const state={source:null,session:null,connection:{connected:false,connectionId:null},boundConnectionId:null,intake:step(),refresh:step(),aliases:step(),targets:[],setupSourceIds:{},setupDirty:false,probe:step(),hints:{search_paths:'',cds_lib_hint:''},searchDirectoryIds:[],searchScopeDirty:false,discovery:step(),candidateId:'',sections:[],tmiCandidateId:null,modelContracts:{},intent:emptyIntent(),intentConfirmed:false,recommendationMode:true,preparation:step(),run:step(),agentSave:step(),agentReview:step(),analysis:step(),analysisCatalog:step(),headerScan:step(),rejectedSubmissionKeys:[],pending:[],storageError:null,storageReady:false,busy:null};
  const emit=()=>{if(!disposed)changed();};
  const agentEditor=createAgentDraftEditor({changed:emit});
  const has=name=>typeof adapter?.[name]==='function';
  const connected=()=>state.connection.connected&&id(state.connection.connectionId);
  const sameConnection=()=>connected()&&(!state.boundConnectionId||state.boundConnectionId===state.connection.connectionId);
  const store=()=>pendingStore||adapter?.pendingStore;
  const requireAdapter=name=>{if(!has(name)||!sameConnection())throw Error('请连接原环境服务；当前连接不能使用这份 intake。');};
  const notifyRun=async receipt=>{try{await onRun(receipt);}catch(error){state.run.notificationError=message(error);}};
  const rememberRejection=receipt=>{if(!state.rejectedSubmissionKeys.includes(receipt.submission_key))state.rejectedSubmissionKeys.push(receipt.submission_key);};
  const requestLocked=()=>!!state.busy||!!state.pending.length||!!state.storageError||(connected()&&!state.storageReady)||state.preparation.status==='unknown'||state.run.status==='unknown';
  const locked=()=>requestLocked()||!!onboardingRecovery(state.session);
  const editable=()=>{if(onboardingRecovery(state.session))throw Error(recoveryMessage(state.session));if(disposed||locked())throw Error('请先核对原请求；当前输入与重复提交已暂停。');};
  const clearPrepared=()=>{state.intentConfirmed=false;state.preparation=step();state.run=step();};
  const clearCandidate=()=>{state.candidateId='';state.sections=[];state.tmiCandidateId=null;state.modelContracts={};clearPrepared();};
  const clearDiscovery=()=>{state.discovery=step();state.searchDirectoryIds=[];state.searchScopeDirty=false;clearCandidate();};
  const candidate=()=>state.discovery.result?.discovery.candidates.find(item=>item.candidate_id===state.candidateId)||null;
  const recommendation=()=>state.session&&state.discovery.result?.discovery&&!state.setupDirty&&!state.searchScopeDirty&&state.discovery.result.discovery.discovery_id===state.session.discovery?.discovery_id?recommended(state.session):null;
  const formSnapshot=()=>canonical([state.targets,state.setupSourceIds,state.hints,state.searchDirectoryIds,state.candidateId,state.sections,state.tmiCandidateId,state.modelContracts,state.intent,state.intentConfirmed,state.recommendationMode,agentEditor.state]);
  const identity=()=>{if(!state.session)throw Error('请先核对独立网表。');return {intake_id:state.session.intake_id,revision:state.session.revision};};
  const analysisScope=value=>canonical([value?.connection_id,value?.intake_id,value?.source_sha256,value?.job?.job_id,value?.job?.source_commit,value?.job?.waveforms]);
  const invalidateAnalysis=next=>{if(analysisScope(next)!==analysisScope(state.session)){state.analysis=step();state.analysisCatalog=step();}};
  const acceptSession=(value,options={})=>{const next=session(value,state.session,options);invalidateAnalysis(next);state.session=next;agentEditor.observe(next);state.intake={status:'complete',result:next,error:null};return next;};
  function hydrate(current){
    const selection=current.selection||{},choice=current.discovery?.candidates.find(item=>item.candidate_id===selection.candidate_id);
    state.targets=clone(current.execution_scope?.selected_ssh_targets||current.probes?.map(probe=>probe.ssh_target)||[]);
    state.probe=current.probes?.length?{status:'complete',result:current,error:null}:step();
    state.discovery=current.discovery?{status:'complete',result:discovery(current),error:null}:step();
    state.searchDirectoryIds=[];state.searchScopeDirty=false;
    state.candidateId=choice?.candidate_id||'';state.sections=choice&&Array.isArray(selection.sections)?selection.sections.filter(value=>choice.available_sections.includes(value)):[];
    state.tmiCandidateId=selection.tmi_candidate_id??null;state.modelContracts={...verifiedContracts(choice,current.discovery,state.sections),...clone(selection.model_contracts||{})};
    state.intent=emptyIntent();for(const key of intentFields)if(['string','number'].includes(typeof selection.intent?.[key]))state.intent[key]=String(selection.intent[key]);
    state.intentConfirmed=false;
  }
  function adoptSaved(current,{preserveDraft=false}={}){
    if(current.prepared)prepared(current);if(current.job)job(current.job,current.prepared,null,current.execution_scope);
    let rejection=null;if(current.state==='pre_dispatch_rejected'||rejectionTagged(current.submission)){
      if(current.state!=='pre_dispatch_rejected'||current.job!==null)throw Error('保存的提交前拒绝状态不完整。');
      rejection=validatePreDispatchRejection(current.submission,{intake:current,plan:current.prepared});
    }
    invalidateAnalysis(current);state.session=current;state.boundConnectionId=state.connection.connectionId;agentEditor.observe(current);if(state.agentSave.status==='unknown')state.agentSave=step();
    if(!preserveDraft){hydrate(current);state.recommendationMode=!(current.prepared&&current.selection);state.preparation=current.prepared?{status:'complete',result:current,error:null}:step();}
    else if(state.preparation.status==='complete')state.preparation.result=current;
    state.intake={status:'complete',result:current,error:null};state.run=rejection?{status:'rejected',result:null,error:null,rejection}:current.job?{status:'complete',result:clone(current.job),error:null}:step();if(rejection)rememberRejection(rejection);
  }
  const intentValue=()=>{
    const result={};for(const key of ports){if(!state.intent[key].trim())return null;result[key]=state.intent[key].trim();}
    for(const key of numerics){const literal=state.intent[key].trim(),number=Number(literal);if(!literal||!Number.isFinite(number))return null;if(!['temperature_c','nominal_temperature_c'].includes(key)&&(number<0||(['supply_v','frequency_hz','cycles','points_per_period'].includes(key)&&number===0)))return null;result[key]=number;}
    if(!Number.isInteger(result.cycles)||!Number.isInteger(result.points_per_period))return null;
    return result;
  };
  const contractsReady=()=>state.session?.source.requirements.required_masters.every(master=>{const contract=state.modelContracts[master];return ['n','p'].includes(contract?.polarity)&&Array.isArray(contract.terminals)&&contract.terminals.length===4&&new Set(contract.terminals).size===4&&contract.terminals.every(role=>['d','g','s','b'].includes(role));});
  async function action(name,target,fn,{uncertain=false}={}){
    if(disposed||state.busy)throw Error('已有步骤正在处理。');
    const ticket=epoch,connectionId=state.connection.connectionId;state.busy=name;target.status='loading';target.error=null;emit();
    try{const value=await fn();if(disposed||ticket!==epoch||connectionId!==state.connection.connectionId)throw Error('连接已变化，响应不能用于当前向导。');if(target===state.run&&value?.dispatch_outcome==='pre_dispatch_rejected'){target.result=null;target.rejection=value;target.status='rejected';}else{target.result=value;target.status='complete';}return value;}
    catch(error){if(!disposed&&ticket===epoch){target.status=(typeof uncertain==='function'?uncertain():uncertain)?'unknown':'error';target.error=message(error);}throw error;}
    finally{if(!disposed&&ticket===epoch){state.busy=null;emit();}}
  }
  const guarded=async fn=>{const connectionId=state.connection.connectionId,ticket=epoch,value=await fn();if(disposed||ticket!==epoch||connectionId!==state.connection.connectionId)throw Error('连接已变化，已拒绝过期响应。');return value;};
  async function loadPending(){
    if(!connected())return;
    const connectionId=state.connection.connectionId;
    if(restoring?.connectionId===connectionId)return restoring.promise;
    state.storageReady=false;
    const promise=(async()=>{
      try{if(typeof store()?.load!=='function')throw Error('缺少持久化请求存储；提交暂不可用。');const records=await store().load({connectionId});if(disposed||state.connection.connectionId!==connectionId)return;if(!Array.isArray(records))throw Error('请求存储格式不符。');const checked=records.map(record=>pendingRecord(record,connectionId));state.pending=checked;state.storageReady=true;state.storageError=null;}
      catch(error){if(!disposed&&state.connection.connectionId===connectionId)state.storageError=message(error);}
      finally{if(restoring?.connectionId===connectionId)restoring=null;emit();}
    })();restoring={connectionId,promise};return promise;
  }
  function connectAdapter(value){
    unsubscribe?.();adapter=value;state.connection=clone(adapter?.getState?.()||{connected:false,connectionId:null});
    unsubscribe=adapter?.subscribe?.(()=>{if(disposed)return;const next=clone(adapter.getState());const changed=next.connectionId!==state.connection.connectionId;state.connection=next;if(changed){state.storageReady=false;if(!state.pending.length)void loadPending();}emit();})||null;
    if(connected())void loadPending();
  }
  async function persist(phase){
    if(!state.storageReady||state.storageError||typeof store()?.put!=='function')throw Error('原请求无法持久化，未提交任何任务。');
    const plan=state.preparation.result?.prepared,record={schema:'ic.onboarding.pending.v1',connectionId:state.connection.connectionId,...identity(),phase,plan_id:phase==='run'?plan.plan_id:null,submission_key:phase==='run'?plan.submission_key:null,createdAt:new Date().toISOString()};
    pendingRecord(record,record.connectionId);await guarded(()=>store().put(record));state.pending.push(record);emit();return record;
  }
  async function resolved(record){
    if(typeof store()?.remove!=='function')throw Error('回执已读取，但原请求记录无法清理。');
    await guarded(()=>store().remove(record));state.pending=state.pending.filter(item=>!(item.intake_id===record.intake_id&&item.phase===record.phase&&item.revision===record.revision&&item.plan_id===record.plan_id));
  }
  async function inspectSource(){
    editable();requireAdapter('inspectNetlist');if(!source)throw Error('请先导入独立网表。');
    return action('intake',state.intake,async()=>{const value=session(await guarded(()=>adapter.inspectNetlist({file_name:source.name,text:source.text,...(source.mode?{mode:source.mode}:{}),...(source.support_files?{support_files:source.support_files}:{})})),null,{initial:true});state.session=value;agentEditor.observe(value);state.boundConnectionId=state.connection.connectionId;return value;});
  }
  async function restore(record){
    requireAdapter(record.phase==='run'?'readSubmission':'getSession');pendingRecord(record,state.connection.connectionId);
    if(!state.pending.some(item=>JSON.stringify(item)===JSON.stringify(record)))throw Error('仅能恢复此连接保存的原请求。');
    if(state.session&&state.session.intake_id!==record.intake_id)throw Error('请使用原 intake 对应的向导，不能替换当前网表。');
    const target=record.phase==='run'?state.run:state.preparation,cachedIntake=state.session,cachedPlan=state.preparation.result?.prepared||cachedIntake?.prepared;
    return action('reconcile',target,async()=>{
      const current=session(await guarded(()=>adapter.getSession({intake_id:record.intake_id})),state.session);
      if(current.intake_id!==record.intake_id||current.revision<record.revision)throw Error('保存的会话与原请求身份不一致。');
      state.session=current;state.boundConnectionId=record.connectionId;state.intake={status:'complete',result:current,error:null};
      if(record.phase==='prepare'){
        if(onboardingRecovery(current))throw Error(recoveryMessage(current));
        prepared(current,state.targets.length?state.targets:null);if(current.revision<=record.revision)throw Error('尚未确认原准备请求，继续保留并等待核对。');
        hydrate(current);await resolved(record);return current;
      }
      const lookup=await guarded(()=>adapter.readSubmission({intake_id:record.intake_id,plan_id:record.plan_id}));
      if(lookup?.submission_key!==record.submission_key||lookup.replay_permitted!==false)throw Error('原提交映射身份不一致。');
      if(rejectionTagged(lookup)){
        if(current.state!=='pre_dispatch_rejected'||current.job!==null)throw Error('原请求的提交前拒绝回执与保存状态不一致。');
        prepared(current);const plan=cachedPlan||current.prepared;
        const receipt=validatePreDispatchRejection(lookup,{intake:cachedIntake||current,plan,pending:record,connectionId:state.connection.connectionId});
        validatePreDispatchRejection(receipt,{intake:current,plan,pending:record,connectionId:state.connection.connectionId});
        state.preparation={status:'complete',result:current,error:null};hydrate(current);await resolved(record);rememberRejection(receipt);return receipt;
      }
      if(!lookup.found)throw Error('尚未找到原提交映射；保留原键，禁止重新提交。');
      prepared(current);if(current.prepared.plan_id!==record.plan_id||current.prepared.submission_key!==record.submission_key)throw Error('保存计划不是原提交计划。');
      const receipt=job(lookup.job,current.prepared,null,current.execution_scope);
      if(lookup.run_id!==receipt.run_id)throw Error('提交映射的 run 身份不一致。');
      state.preparation={status:'complete',result:current,error:null};
      await resolved(record);await notifyRun(receipt);return receipt;
    },{uncertain:true});
  }
  const api={
    get state(){return clone(state);},has,get candidate(){return clone(candidate());},get recommendation(){return clone(recommendation());},get intentReady(){return !!intentValue()&&!!contractsReady();},get locked(){return locked();},
    get currentBinding(){return state.session?{connectionId:state.connection.connectionId,intakeId:state.session.intake_id,sourceSha256:state.session.source_sha256,revision:state.session.revision}:null;},
    get agentEditor(){return agentEditor.state;},get recoveryRequired(){return onboardingRecovery(state.session);},
    get connected(){return !!sameConnection();},get ready(){return restoring?.promise||Promise.resolve();},
    connect(options){if(!has('connect'))throw Error('本机连接入口尚未接入。');return adapter.connect(options);},
    disconnect(){if(state.busy)throw Error('请等待当前步骤完成。');return adapter?.disconnect?.();},
    setAdapter(value){editable();if(state.session)throw Error('已有 intake，不能替换其连接适配器。');connectAdapter(value);emit();},
    async importSource(value){editable();const inventory=inspectLiteralNetlist(value);if(value.mode!==undefined&&value.mode!=='agent-tb')throw Error('未知测试平台导入模式。');if(value.support_files!==undefined&&(!object(value.support_files)||Object.keys(value.support_files).length>64||Object.entries(value.support_files).some(([path,body])=>!path||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||path.includes('\\')||typeof body!=='string'||new TextEncoder().encode(body).length>1024*1024)))throw Error('支持文件必须是相对路径与字面文本。');epoch++;source={name:inventory.name,text:value.text,...(value.mode?{mode:value.mode}:{}),...(value.support_files?{support_files:clone(value.support_files)}:{})};state.source={...inventory,...(value.mode?{mode:value.mode}:{})};state.session=null;agentEditor.reset();state.agentSave=step();state.agentReview=step();state.analysis=step();state.analysisCatalog=step();state.boundConnectionId=null;state.intake=step();state.refresh=step();state.recommendationMode=true;state.targets=[];state.setupSourceIds={};state.setupDirty=false;state.probe=step();state.hints={search_paths:'',cds_lib_hint:''};state.intent=emptyIntent();clearDiscovery();emit();if(sameConnection()&&has('inspectNetlist'))await inspectSource();return inventory;},
    editAgentTestbench(field,value){editable();agentEditor.edit(field,value);state.agentReview=step();},
    resetAgentTestbench(){editable();agentEditor.reset(state.session);state.agentSave=step();state.agentReview=step();},
    async saveAgentTestbench(){
      editable();requireAdapter('saveAgentTestbench');if(state.agentSave.status==='unknown')throw Error('上次草稿保存结果未知，请先刷新原实验核对。');
      const input=agentEditor.read(state.session);let unknown=false;
      return action('agent-save',state.agentSave,async()=>{
        try{const next=session(await guarded(()=>adapter.saveAgentTestbench(input)),state.session,{mutating:true}),draft=checkAgentTestbench(next);
          if(!draft||canonical(draft.testbench)!==canonical(input.testbench)||canonical(draft.selection)!==canonical(input.selection)||next.agent_tb_review&&next.agent_tb_review.state!=='stale')throw Error('保存结果没有保留完整草稿或仍持有旧审阅。');
          acceptSession(next);agentEditor.accept(next);state.agentReview=step();state.preparation=step();state.run=step();return next;
        }catch(error){unknown=error?.data?.code==='transport_unknown';throw error;}
      },{uncertain:()=>unknown});
    },
    async prepareAgentTestbench(){
      editable();requireAdapter('prepareAgentTestbench');const draft=checkAgentTestbench(state.session),editor=agentEditor.state;
      if(!draft||editor.dirty||editor.conflict||editor.error||state.agentSave.status==='unknown')throw Error('请先保存并核对当前测试平台草稿。');
      const input={...identity(),draft_id:draft.draft_id};
      return action('agent-prepare',state.preparation,async()=>{const record=await persist('prepare'),next=prepared(session(await guarded(()=>adapter.prepareAgentTestbench(input)),state.session,{mutating:true}));
        if(next.agent_tb?.draft_id!==draft.draft_id||next.prepared.recipe_id!=='agent-testbench'||next.prepared.state==='prepared'&&!agentReviewIdentity(next))throw Error('审阅计划不属于当前测试平台草稿。');
        acceptSession(next);hydrate(next);await resolved(record);state.run=step();state.agentReview=step();return next;
      },{uncertain:()=>state.pending.some(record=>record.phase==='prepare')});
    },
    openAgentTestbenchReview(event){
      editable();requireAdapter('openAgentTestbenchReview');const editor=agentEditor.state,review=agentReviewIdentity(state.session);
      if(editor.dirty||editor.conflict||editor.error||!review||review.state!=='pending'||review.revision!==state.session.revision)throw Error('请先保存草稿并生成当前版本的人工审阅计划。');
      const result=adapter.openAgentTestbenchReview({intake_id:state.session.intake_id,revision:state.session.revision,review_id:review.review_id,review_digest:review.review_digest,plan_id:review.plan_id},{event});
      state.agentReview={status:'opened',result,error:null};emit();return result;
    },
    async probeVerilogaHeaders(args){
      editable();requireAdapter('probeVerilogaHeaders');const current=identity(),editor=agentEditor.state;
      if(editor.dirty||editor.conflict||editor.error||state.headerScan.status==='unknown')throw Error('请先保存并核对测试平台草稿与原头文件请求。');
      if(!object(args)||Object.keys(args).sort().join(',')!=='intake_id,probe_id,revision,roots'||args.intake_id!==current.intake_id||args.revision!==current.revision||!state.session.probes?.some(row=>row.probe_id===args.probe_id)||!Array.isArray(args.roots)||!args.roots.length||args.roots.length>8||args.roots.some(root=>!text(root,4096)||!root))throw Error('请选择当前 intake 中的主机观察和明确的头文件目录。');
      let unknown=false;return action('veriloga-headers',state.headerScan,async()=>{try{return acceptSession(session(await guarded(()=>adapter.probeVerilogaHeaders(clone(args))),state.session,{mutating:true}));}catch(error){unknown=error?.data?.code==='transport_unknown';throw error;}},{uncertain:()=>unknown});
    },
    async readAnalysisCatalog({dataset_id}={}){
      editable();requireAdapter('waveformApi');const current=state.session,receipt=current?.job;
      if(!receipt)throw Error('请选择已保存的原仿真任务。');const provider=adapter.waveformApi({intake_id:current.intake_id,job:receipt});
      return action('analysis-catalog',state.analysisCatalog,async()=>{const result=await guarded(()=>provider.catalog(receipt.run_id,dataset_id?{dataset_id}:undefined));
        if(analysisScope(state.session)!==analysisScope(current))throw Error('分析任务已切换，未采用旧信号目录。');
        if(result?.schema!=='ic.waveforms.v1'||result.run_id!==receipt.run_id||result.source_commit!==receipt.source_commit||!Array.isArray(result.signals)||
          ['archive_sha256','raw_signature','effective_config_sha256'].some(key=>result[key]!==receipt.waveforms[key]))throw Error('分析信号目录与原任务数据不一致。');
        const selected=dataset_id?receipt.waveforms.datasets?.find(row=>row.dataset_id===dataset_id):null;
        if(dataset_id?(!selected||result.dataset_id!==dataset_id||result.data_sha256!==selected.data_sha256):result.csv_sha256!==receipt.waveforms.csv_sha256)throw Error('分析数据集与原任务身份不一致。');return result;});
    },
    async analyze({operation,inputs,parameters,criteria,dataset_id}={}){
      editable();requireAdapter('analyzeExperiment');if(!ANALYSIS_OPERATIONS.includes(operation)||!object(inputs)||!object(parameters))throw Error('请选择明确的分析算法、同任务信号和参数。');
      const current=state.session,receipt=current?.job;if(!receipt)throw Error('尚无可分析的原任务数据。');
      const input={intake_id:current.intake_id,job_id:receipt.job_id,operation,inputs,parameters,...(dataset_id?{dataset_id}:{}),...(criteria===undefined?{}:{criteria})};
      return action('analysis',state.analysis,async()=>{const result=checkAnalysisResult(await guarded(()=>adapter.analyzeExperiment(input)),current);
        if(analysisScope(state.session)!==analysisScope(current))throw Error('分析任务已切换，旧结果未显示。');
        if(result.request.dataset_id!==dataset_id||canonical(result.request.inputs)!==canonical(inputs)||canonical(result.request.parameters)!==canonical(parameters)||criteria!==undefined&&canonical(result.request.criteria)!==canonical(criteria))throw Error('分析结果的信号、参数或判据与提交内容不一致。');return result;});
    },
    receiveAnalysis(value){
      if(disposed||!sameConnection())return {status:'ignored'};const result=checkAnalysisResult(value,state.session);
      state.analysis={status:'complete',result,error:null};emit();return {status:'updated',analysisId:result.analysis_id};
    },
    inspectSource,
    loadAliases(){requireAdapter('listSshAliases');return action('aliases',state.aliases,async()=>aliases(await guarded(()=>adapter.listSshAliases())));},
    setTargets(values){editable();if(!Array.isArray(values)||values.length>8||values.some(value=>!endpoint(value)))throw Error('请填写至多 8 个 SSH alias 或 user@host。');state.targets=[...new Set(values)];state.setupSourceIds={};state.setupDirty=false;state.probe=step();clearDiscovery();emit();},
    selectSetupSource(target,value){editable();const probe=state.probe.result?.probes.find(item=>item.ssh_target===target);if(!probe||value!==null&&!probe.environment.setup_candidates?.some(item=>item.source_id===value&&item.activation_supported===true))throw Error('只能选择本次该主机返回且支持激活的环境候选。');if(value===null)delete state.setupSourceIds[target];else state.setupSourceIds[target]=value;state.setupDirty=true;clearDiscovery();emit();},
    probeHost(){editable();requireAdapter('probeHost');if(!state.targets.length)throw Error('请明确选择允许探测与运行的主机范围。');const args={...identity(),ssh_targets:clone(state.targets)};if(Object.keys(state.setupSourceIds).length)args.overrides={setup_source_ids:clone(state.setupSourceIds)};clearDiscovery();return action('probe',state.probe,async()=>{const result=probes(session(await guarded(()=>adapter.probeHost(args)),state.session,{mutating:true}),args.ssh_targets);state.setupDirty=false;return acceptSession(result);});},
    async probeAndMatch(){if(state.targets.length>2)throw Error('每批 PDK 匹配仅支持 1–2 个主机；请先单独探测，再明确选择本批主机。');await api.probeHost();return api.matchPdk();},
    setHint(key,value){editable();if(!Object.hasOwn(state.hints,key)||!text(value,4000))throw Error('搜索提示格式不符。');state.hints[key]=value;clearDiscovery();emit();},
    selectSearchDirectories(values){editable();const directories=state.discovery.result?.discovery.search_directories||[],probeIds=state.probe.result?.probes.map(probe=>probe.probe_id)||[];if(!Array.isArray(values)||values.length>8||new Set(values).size!==values.length||values.some(value=>!directories.some(directory=>directory.directory_id===value&&probeIds.includes(directory.probe_id))))throw Error('只能选择至多 8 个当前 discovery 中属于所选主机的观察目录。');state.searchDirectoryIds=clone(values);state.searchScopeDirty=true;clearCandidate();emit();},
    matchPdk({refresh=false,library_selection,probe_ids}={}){
      editable();requireAdapter('discoverPdk');if(state.probe.status!=='complete'||state.setupDirty)throw Error('请先完成当前所选主机与环境配置的探测。');
      const observations=state.probe.result.probes,observedIds=observations.map(probe=>probe.probe_id).filter(id),currentIds=new Set(state.session?.probes?.map(probe=>probe.probe_id).filter(id)||[]);
      if(probe_ids!==undefined&&(!Array.isArray(probe_ids)||probe_ids.length<1||probe_ids.length>2||new Set(probe_ids).size!==probe_ids.length||probe_ids.some(probeId=>!id(probeId)||!observedIds.includes(probeId)||!currentIds.has(probeId))))throw Error('请明确选择本次观察中的 1–2 个不同主机；不使用其他批次的 probe。');
      if(library_selection!==undefined){
        const rows=state.session?.discovery?.lut||[],row=rows.find(row=>row.probe_id===library_selection?.probe_id),scope=row?.projection||row;
        if(refresh||probe_ids!==undefined&&(probe_ids.length!==1||probe_ids[0]!==library_selection?.probe_id)||!object(library_selection)||Object.keys(library_selection).sort().join(',')!=='library_candidate_id,library_id,probe_id'||!sha(library_selection.library_id)||!sha(library_selection.library_candidate_id)||!state.probe.result.probes.some(row=>row.probe_id===library_selection.probe_id)||scope?.library_id!==library_selection.library_id||!scope.entry_choices?.some(choice=>choice.library_candidate_id===library_selection.library_candidate_id))throw Error('请选择当前主机观察所返回的完整模型库条目。');
        const args={...identity(),probe_ids:[library_selection.probe_id],library_selection:clone(library_selection)};clearDiscovery();
        return action('pdk',state.discovery,async()=>{const value=acceptSession(discovery(session(await guarded(()=>adapter.discoverPdk(args)),state.session,{mutating:true})));state.recommendationMode=true;return value;});
      }
      if(probe_ids===undefined&&observations.length>2)throw Error('已观察多个主机，请明确选择本批 PDK 匹配的 1–2 个主机；不会自动截断。');
      const selectedProbes=probe_ids===undefined?observedIds:clone(probe_ids);
      if(selectedProbes.some(probeId=>!currentIds.has(probeId)))throw Error('主机观察已变化，请重新选择当前 probe。');
      const args={...identity(),probe_ids:selectedProbes},selected=clone(state.searchDirectoryIds);
      if(refresh===true)args.refresh=true;
      if(!args.probe_ids.length)throw Error('没有可用主机探测结果；请检查失败原因。');
      if(selected.length){const directories=state.discovery.result?.discovery.search_directories||[],rows=selected.map(value=>directories.find(directory=>directory.directory_id===value));if(rows.some(row=>!row||!args.probe_ids.includes(row.probe_id))||args.probe_ids.some(probeId=>!rows.some(row=>row.probe_id===probeId)))throw Error('请为每个选中主机选择本次观察到的目录。');args.search_directory_ids=selected;}
      else{const paths=state.hints.search_paths.split('\n').map(path=>path.trim()).filter(Boolean);if(paths.length)args.search_paths=paths;}
      if(state.hints.cds_lib_hint.trim())args.cds_lib_hint=state.hints.cds_lib_hint.trim();clearDiscovery();
      return action('pdk',state.discovery,async()=>{const value=acceptSession(discovery(session(await guarded(()=>adapter.discoverPdk(args)),state.session,{mutating:true})));state.recommendationMode=true;state.searchDirectoryIds=selected.filter(directoryId=>value.discovery.search_directories?.some(directory=>directory.directory_id===directoryId&&args.probe_ids.includes(directory.probe_id)));return value;});
    },
    selectCandidate(value){editable();if(state.searchScopeDirty)throw Error('搜索范围已改变，请先重新匹配 PDK。');const choice=state.discovery.result?.discovery.candidates.find(item=>item.candidate_id===value);if(!choice)throw Error('请选择当前返回的 PDK 候选。');state.recommendationMode=false;state.candidateId=value;state.sections=[];state.tmiCandidateId=null;state.modelContracts={};clearPrepared();emit();},
    selectSections(values){editable();if(!Array.isArray(values)||!candidate()||values.some(value=>!candidate().available_sections.includes(value)))throw Error('请选择当前 PDK 的 section。');state.recommendationMode=false;state.sections=[...new Set(values)];state.modelContracts=verifiedContracts(candidate(),state.discovery.result.discovery,state.sections);clearPrepared();emit();},
    selectTmi(value){editable();if(value!==null&&!candidate()?.tmi_candidates.some(item=>item.tmi_candidate_id===value||item.candidate_id===value))throw Error('请选择返回的 TMI 候选。');state.recommendationMode=false;state.tmiCandidateId=value;clearPrepared();emit();},
    setModelContract(master,value){editable();if(!state.session?.source.requirements.required_masters.includes(master)||!object(value))throw Error('模型必须来自本次独立网表。');state.recommendationMode=false;state.modelContracts[master]=clone(value);clearPrepared();emit();},
    setIntent(key,value){editable();if(!intentFields.includes(key)||!text(value,240))throw Error('实验条件格式不符。');state.recommendationMode=false;state.intent[key]=value;clearPrepared();emit();},
    confirmIntent(value){editable();if(value&&!api.intentReady)throw Error('请完整填写实验条件和模型端口契约。');state.intentConfirmed=value===true;emit();},
    useRecommendation(){editable();if(!recommendation())throw Error('当前没有可用推荐。');state.recommendationMode=true;clearPrepared();emit();},
    editRecommendation(){editable();const value=recommendation();if(!value?.ready_for_prepare)throw Error('推荐尚不完整，请在高级设置中补充。');state.candidateId=value.candidate_id;state.sections=clone(value.sections);state.tmiCandidateId=value.tmi_candidate_id;state.modelContracts=clone(value.model_contracts);state.intent=Object.fromEntries(intentFields.map(key=>[key,String(value.intent[key])]));state.recommendationMode=false;clearPrepared();emit();},
    async prepare({acceptRecommendation=false}={}){
      editable();requireAdapter('prepareExperiment');let args,expected;
      if(acceptRecommendation){const value=recommendation();if(!value?.ready_for_prepare)throw Error('推荐尚不完整，请核对缺失项。');expected=Object.fromEntries(selectionFields.map(key=>[key,clone(value[key])]));args={...identity(),accept_recommendation:true,recommendation_id:value.recommendation_id,recommendation_revision:value.recommendation_revision};}
      else{if(!candidate()||!state.intentConfirmed||!api.intentReady||(candidate().available_sections.length&&!state.sections.length))throw Error('请明确选择 PDK、section 并确认完整实验条件。');expected={discovery_id:state.discovery.result.discovery.discovery_id,candidate_id:state.candidateId,sections:clone(state.sections),tmi_candidate_id:state.tmiCandidateId,model_contracts:clone(state.modelContracts),intent:intentValue()};args={...identity(),accept_recommendation:false,...expected};}
      return action('prepare',state.preparation,async()=>{const record=await persist('prepare');const result=prepared(session(await guarded(()=>adapter.prepareExperiment(args)),state.session,{mutating:true}),state.targets);if(result.prepared.state==='prepared'&&!sameSelection(result.selection,expected))throw Error('准备结果改变了已确认的选择；保留原请求，不提交仿真。');acceptSession(result);await resolved(record);hydrate(result);state.intentConfirmed=result.prepared.state==='prepared';state.run=step();return result;},{uncertain:()=>state.pending.some(record=>record.phase==='prepare')});
    },
    async confirmAndRun(){if(!state.recommendationMode)api.confirmIntent(true);const result=await api.prepare({acceptRecommendation:state.recommendationMode});if(result.prepared.state!=='prepared')return result;return api.runPrepared();},
    async runPrepared(){
      editable();requireAdapter('runPrepared');const plan=state.preparation.result?.prepared;if(state.run.status!=='idle'||state.preparation.status!=='complete'||plan?.state!=='prepared'||!state.intentConfirmed||state.rejectedSubmissionKeys.includes(plan.submission_key))throw Error('请先准备实验；已有请求或已拒绝计划不会重复提交。');
      const args={...identity(),plan_id:plan.plan_id},cachedIntake=clone(state.session);return action('run',state.run,async()=>{
        const record=await persist('run'),response=session(await guarded(()=>adapter.runPrepared(args)),state.session,{mutating:true});
        if(response.state==='pre_dispatch_rejected'||rejectionTagged(response.submission)){
          if(response.state!=='pre_dispatch_rejected'||response.job!==null)throw Error('提交前拒绝响应与完整 session 状态不一致。');
          const receipt=validatePreDispatchRejection(response.submission,{intake:cachedIntake,plan,pending:record,connectionId:state.connection.connectionId});
          validatePreDispatchRejection(receipt,{intake:response,plan,pending:record,connectionId:state.connection.connectionId});
          acceptSession(response);await resolved(record);rememberRejection(receipt);return receipt;
        }
        const receipt=job(response.job,plan,null,state.preparation.result.execution_scope);acceptSession(response);await resolved(record);await notifyRun(receipt);return receipt;
      },{uncertain:()=>state.pending.some(record=>record.phase==='run')});
    },
    restore,loadPending,
    restoreSelected(){
      editable();requireAdapter('getSession');const selected=state.connection.selectedIntakeId;
      if(!id(selected)||state.session&&state.session.intake_id!==selected)throw Error('没有当前连接选中的 intake 可恢复。');
      return action('restore',state.intake,async()=>{
        const current=session(await guarded(()=>adapter.getSession({intake_id:selected})),state.session);if(current.intake_id!==selected)throw Error('返回的会话不是当前连接选中的 intake。');
        adoptSaved(current);return current;
      });
    },
    async refreshCurrent(binding){
      const current=state.session,ticket=epoch;
      const matches=()=>{
        const selected=adapter?.getState?.().selectedIntakeId,sameIntake=state.session?.intake_id===binding?.intakeId;
        return !disposed&&ticket===epoch&&sameConnection()&&binding?.connectionId===state.connection.connectionId&&id(binding?.intakeId)&&sha(binding?.sourceSha256)&&(!selected||selected===binding.intakeId)&&(sameIntake?binding.sourceSha256===state.session.source_sha256:selected===binding.intakeId);
      };
      const replacing=current?.intake_id!==binding?.intakeId;
      if(!matches()||!Number.isSafeInteger(binding.revision)||binding.revision<0||!replacing&&binding.revision<current.revision)return {status:'ignored',reason:'binding_or_revision_changed'};
      if(requestLocked()||state.refresh.status==='loading')return {status:'deferred',reason:'request_pending'};
      requireAdapter('getSession');const inputs=formSnapshot();state.refresh={status:'loading',result:null,error:null};emit();
      try{
        const raw=await adapter.getSession({intake_id:binding.intakeId});
        if(!matches()||formSnapshot()!==inputs)return {status:'ignored',reason:'source_or_draft_changed'};
        if(requestLocked())return {status:'deferred',reason:'request_pending'};
        if(current&&raw?.connection_id!==current.connection_id||raw?.intake_id!==binding.intakeId||raw?.source_sha256!==binding.sourceSha256||raw?.revision<Math.max(binding.revision,replacing?0:state.session.revision))return {status:'ignored',reason:'response_binding_changed'};
        const next=session(raw,replacing?null:state.session);
        if(!replacing&&canonical(next)===canonical(state.session))return {status:'unchanged',session:clone(state.session)};
        // Passive inspect may update job/report/waveforms and derived actions at
        // the same revision. Preserve local inputs while adopting that evidence.
        const preserveDraft=!replacing&&next.revision===state.session.revision&&configurationSnapshot(next)===configurationSnapshot(state.session);
        if(preserveDraft&&next.job&&state.session.job)job(next.job,next.prepared,state.session.job,next.execution_scope);
        if(replacing){source=null;state.source=null;state.setupSourceIds={};state.hints={search_paths:'',cds_lib_hint:''};state.recommendationMode=true;}
        adoptSaved(next,{preserveDraft});state.refresh={status:'complete',result:{revision:next.revision},error:null};return {status:'updated',session:clone(next)};
      }catch(error){if(matches())state.refresh={status:'error',result:null,error:message(error)};throw error;}
      finally{if(!disposed&&ticket===epoch){if(state.refresh.status==='loading')state.refresh=step();emit();}}
    },
    inspect(){requireAdapter('inspectExperiment');if(onboardingRecovery(state.session))throw Error(recoveryMessage(state.session));if(!state.run.result?.job_id||state.pending.length)throw Error('请先核对原提交回执。');const previous=state.run.result,plan=state.preparation.result?.prepared||state.session?.prepared,scope=state.preparation.result?.execution_scope||state.session?.execution_scope;return action('inspect',state.run,async()=>{const response=session(await guarded(()=>adapter.inspectExperiment({intake_id:state.session.intake_id,job_id:previous.job_id})),state.session),receipt=job(response.job,plan,previous,scope);acceptSession(response);await notifyRun(receipt);return receipt;});},
    destroy(){if(disposed)return;disposed=true;epoch++;unsubscribe?.();}
  };
  connectAdapter(adapter);return api;
}
