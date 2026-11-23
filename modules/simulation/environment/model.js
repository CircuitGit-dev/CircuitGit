// Clean-slate onboarding state. The host owns transport and durable pending state.
// No URL construction, historical configuration, SSH or model call lives here.
import {indexSpectre} from '../../schematic/netlist.js';
import {literalDimensions} from '../../schematic/instance-properties.js';
import {validatePreDispatchRejection} from './submission.js';

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

export function onboardingWaveformsAvailable({intake,job:receipt}={}){
  const value=receipt?.waveforms;
  if(!object(intake)||!object(receipt)||value?.schema!=='ic.onboarding.waveform-descriptor.v1'||value.available!==true||value.source_binding_verified!==true||value.read_only!==true)return false;
  if(value.intake_id!==intake.intake_id||value.job_id!==receipt.job_id||value.run_id!==receipt.run_id||receipt.job_id!==receipt.run_id||value.source_commit!==receipt.source_commit||value.source_commit!==intake.source_commit||value.original_source_sha256!==intake.source_sha256)return false;
  if(!['archive_sha256','original_source_sha256','compiled_source_sha256','raw_signature','effective_config_sha256','csv_sha256'].every(key=>sha(value[key]))||!Array.isArray(value.available_signal_ids)||!value.available_signal_ids.length||!value.available_signal_ids.every(signal=>id(signal)&&signal.startsWith('s_')))return false;
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
  return clone(value);
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
  const state={source:null,session:null,connection:{connected:false,connectionId:null},boundConnectionId:null,intake:step(),aliases:step(),targets:[],setupSourceIds:{},setupDirty:false,probe:step(),hints:{search_paths:'',cds_lib_hint:''},searchDirectoryIds:[],searchScopeDirty:false,discovery:step(),candidateId:'',sections:[],tmiCandidateId:null,modelContracts:{},intent:emptyIntent(),intentConfirmed:false,preparation:step(),run:step(),rejectedSubmissionKeys:[],pending:[],storageError:null,storageReady:false,busy:null};
  const emit=()=>{if(!disposed)changed();};
  const has=name=>typeof adapter?.[name]==='function';
  const connected=()=>state.connection.connected&&id(state.connection.connectionId);
  const sameConnection=()=>connected()&&(!state.boundConnectionId||state.boundConnectionId===state.connection.connectionId);
  const store=()=>pendingStore||adapter?.pendingStore;
  const requireAdapter=name=>{if(!has(name)||!sameConnection())throw Error('请连接原环境服务；当前连接不能使用这份 intake。');};
  const notifyRun=async receipt=>{try{await onRun(receipt);}catch(error){state.run.notificationError=message(error);}};
  const rememberRejection=receipt=>{if(!state.rejectedSubmissionKeys.includes(receipt.submission_key))state.rejectedSubmissionKeys.push(receipt.submission_key);};
  const locked=()=>!!state.busy||!!state.pending.length||!!state.storageError||(connected()&&!state.storageReady)||state.preparation.status==='unknown'||state.run.status==='unknown';
  const editable=()=>{if(disposed||locked())throw Error('请先核对原请求；当前输入与重复提交已暂停。');};
  const clearPrepared=()=>{state.intentConfirmed=false;state.preparation=step();state.run=step();};
  const clearCandidate=()=>{state.candidateId='';state.sections=[];state.tmiCandidateId=null;state.modelContracts={};clearPrepared();};
  const clearDiscovery=()=>{state.discovery=step();state.searchDirectoryIds=[];state.searchScopeDirty=false;clearCandidate();};
  const candidate=()=>state.discovery.result?.discovery.candidates.find(item=>item.candidate_id===state.candidateId)||null;
  const identity=()=>{if(!state.session)throw Error('请先核对独立网表。');return {intake_id:state.session.intake_id,revision:state.session.revision};};
  const acceptSession=(value,options={})=>{const next=session(value,state.session,options);state.session=next;state.intake={status:'complete',result:next,error:null};return next;};
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
    return action('intake',state.intake,async()=>{const value=session(await guarded(()=>adapter.inspectNetlist({file_name:source.name,text:source.text})),null,{initial:true});state.session=value;state.boundConnectionId=state.connection.connectionId;return value;});
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
    get state(){return clone(state);},has,get candidate(){return clone(candidate());},get intentReady(){return !!intentValue()&&!!contractsReady();},get locked(){return locked();},
    get connected(){return !!sameConnection();},get ready(){return restoring?.promise||Promise.resolve();},
    connect(options){if(!has('connect'))throw Error('本机连接入口尚未接入。');return adapter.connect(options);},
    disconnect(){if(state.busy)throw Error('请等待当前步骤完成。');return adapter?.disconnect?.();},
    setAdapter(value){editable();if(state.session)throw Error('已有 intake，不能替换其连接适配器。');connectAdapter(value);emit();},
    async importSource(value){editable();const inventory=inspectLiteralNetlist(value);epoch++;source={name:inventory.name,text:value.text};state.source=inventory;state.session=null;state.boundConnectionId=null;state.intake=step();state.targets=[];state.setupSourceIds={};state.setupDirty=false;state.probe=step();state.hints={search_paths:'',cds_lib_hint:''};state.intent=emptyIntent();clearDiscovery();emit();if(sameConnection()&&has('inspectNetlist'))await inspectSource();return inventory;},
    inspectSource,
    loadAliases(){requireAdapter('listSshAliases');return action('aliases',state.aliases,async()=>aliases(await guarded(()=>adapter.listSshAliases())));},
    setTargets(values){editable();if(!Array.isArray(values)||values.length>8||values.some(value=>!endpoint(value)))throw Error('请填写至多 8 个 SSH alias 或 user@host。');state.targets=[...new Set(values)];state.setupSourceIds={};state.setupDirty=false;state.probe=step();clearDiscovery();emit();},
    selectSetupSource(target,value){editable();const probe=state.probe.result?.probes.find(item=>item.ssh_target===target);if(!probe||value!==null&&!probe.environment.setup_candidates?.some(item=>item.source_id===value&&item.activation_supported===true))throw Error('只能选择本次该主机返回且支持激活的环境候选。');if(value===null)delete state.setupSourceIds[target];else state.setupSourceIds[target]=value;state.setupDirty=true;clearDiscovery();emit();},
    probeHost(){editable();requireAdapter('probeHost');if(!state.targets.length)throw Error('请明确选择允许探测与运行的主机范围。');const args={...identity(),ssh_targets:clone(state.targets)};if(Object.keys(state.setupSourceIds).length)args.overrides={setup_source_ids:clone(state.setupSourceIds)};clearDiscovery();return action('probe',state.probe,async()=>{const result=probes(session(await guarded(()=>adapter.probeHost(args)),state.session,{mutating:true}),args.ssh_targets);state.setupDirty=false;return acceptSession(result);});},
    setHint(key,value){editable();if(!Object.hasOwn(state.hints,key)||!text(value,4000))throw Error('搜索提示格式不符。');state.hints[key]=value;clearDiscovery();emit();},
    selectSearchDirectories(values){editable();const directories=state.discovery.result?.discovery.search_directories||[],probeIds=state.probe.result?.probes.map(probe=>probe.probe_id)||[];if(!Array.isArray(values)||values.length>8||new Set(values).size!==values.length||values.some(value=>!directories.some(directory=>directory.directory_id===value&&probeIds.includes(directory.probe_id))))throw Error('只能选择至多 8 个当前 discovery 中属于所选主机的观察目录。');state.searchDirectoryIds=clone(values);state.searchScopeDirty=true;clearCandidate();emit();},
    matchPdk(){
      editable();requireAdapter('discoverPdk');if(state.probe.status!=='complete'||state.setupDirty)throw Error('请先完成当前所选主机与环境配置的探测。');
      const args={...identity(),probe_ids:state.probe.result.probes.map(probe=>probe.probe_id).filter(id)},selected=clone(state.searchDirectoryIds);
      if(!args.probe_ids.length)throw Error('没有可用主机探测结果；请检查失败原因。');
      if(selected.length){const directories=state.discovery.result?.discovery.search_directories||[],rows=selected.map(value=>directories.find(directory=>directory.directory_id===value));if(rows.some(row=>!row||!args.probe_ids.includes(row.probe_id))||args.probe_ids.some(probeId=>!rows.some(row=>row.probe_id===probeId)))throw Error('请为每个选中主机选择本次观察到的目录。');args.search_directory_ids=selected;}
      else{const paths=state.hints.search_paths.split('\n').map(path=>path.trim()).filter(Boolean);if(paths.length)args.search_paths=paths;}
      if(state.hints.cds_lib_hint.trim())args.cds_lib_hint=state.hints.cds_lib_hint.trim();clearDiscovery();
      return action('pdk',state.discovery,async()=>{const value=acceptSession(discovery(session(await guarded(()=>adapter.discoverPdk(args)),state.session,{mutating:true})));state.searchDirectoryIds=selected.filter(directoryId=>value.discovery.search_directories?.some(directory=>directory.directory_id===directoryId&&args.probe_ids.includes(directory.probe_id)));return value;});
    },
    selectCandidate(value){editable();if(state.searchScopeDirty)throw Error('搜索范围已改变，请先重新匹配 PDK。');const choice=state.discovery.result?.discovery.candidates.find(item=>item.candidate_id===value);if(!choice)throw Error('请选择当前返回的 PDK 候选。');state.candidateId=value;state.sections=[];state.tmiCandidateId=null;state.modelContracts={};clearPrepared();emit();},
    selectSections(values){editable();if(!Array.isArray(values)||!candidate()||values.some(value=>!candidate().available_sections.includes(value)))throw Error('请选择当前 PDK 的 section。');state.sections=[...new Set(values)];state.modelContracts=verifiedContracts(candidate(),state.discovery.result.discovery,state.sections);clearPrepared();emit();},
    selectTmi(value){editable();if(value!==null&&!candidate()?.tmi_candidates.some(item=>item.tmi_candidate_id===value||item.candidate_id===value))throw Error('请选择返回的 TMI 候选。');state.tmiCandidateId=value;clearPrepared();emit();},
    setModelContract(master,value){editable();if(!state.session?.source.requirements.required_masters.includes(master)||!object(value))throw Error('模型必须来自本次独立网表。');state.modelContracts[master]=clone(value);clearPrepared();emit();},
    setIntent(key,value){editable();if(!intentFields.includes(key)||!text(value,240))throw Error('实验条件格式不符。');state.intent[key]=value;clearPrepared();emit();},
    confirmIntent(value){editable();if(value&&!api.intentReady)throw Error('请完整填写实验条件和模型端口契约。');state.intentConfirmed=value===true;emit();},
    async prepare(){
      editable();requireAdapter('prepareExperiment');if(!candidate()||!state.intentConfirmed||!api.intentReady||(candidate().available_sections.length&&!state.sections.length))throw Error('请明确选择 PDK、section 并确认完整实验条件。');
      const args={...identity(),discovery_id:state.discovery.result.discovery.discovery_id,candidate_id:state.candidateId,sections:clone(state.sections),tmi_candidate_id:state.tmiCandidateId,model_contracts:clone(state.modelContracts),intent:intentValue()};
      return action('prepare',state.preparation,async()=>{const record=await persist('prepare');const result=prepared(session(await guarded(()=>adapter.prepareExperiment(args)),state.session,{mutating:true}),state.targets);acceptSession(result);await resolved(record);state.run=step();return result;},{uncertain:()=>state.pending.some(record=>record.phase==='prepare')});
    },
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
        if(current.prepared)prepared(current);if(current.job)job(current.job,current.prepared,null,current.execution_scope);
        let rejection=null;if(current.state==='pre_dispatch_rejected'||rejectionTagged(current.submission)){
          if(current.state!=='pre_dispatch_rejected'||current.job!==null)throw Error('保存的提交前拒绝状态不完整。');
          rejection=validatePreDispatchRejection(current.submission,{intake:current,plan:current.prepared});
        }
        state.session=current;state.boundConnectionId=state.connection.connectionId;hydrate(current);
        state.preparation=current.prepared?{status:'complete',result:current,error:null}:step();state.run=rejection?{status:'rejected',result:null,error:null,rejection}:current.job?{status:'complete',result:clone(current.job),error:null}:step();if(rejection)rememberRejection(rejection);
        return current;
      });
    },
    inspect(){requireAdapter('inspectExperiment');if(!state.run.result?.job_id||state.pending.length)throw Error('请先核对原提交回执。');const previous=state.run.result;return action('inspect',state.run,async()=>{const response=session(await guarded(()=>adapter.inspectExperiment({intake_id:state.session.intake_id,job_id:previous.job_id})),state.session),receipt=job(response.job,state.preparation.result?.prepared,previous,state.preparation.result?.execution_scope);acceptSession(response);await notifyRun(receipt);return receipt;});},
    destroy(){if(disposed)return;disposed=true;epoch++;unsubscribe?.();}
  };
  connectAdapter(adapter);return api;
}
