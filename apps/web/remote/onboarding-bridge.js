// Onboarding owns a transport and receipt scope independently of any AI session.
import {createNodeClient,ONBOARDING_OPERATIONS,onboardingRequestTimeout,pdkScopeQuery} from './client.js';
import {pairLocal,LOCAL_CONNECTOR,saveSessionGrant} from './pair.js';
import {validatePreDispatchRejection} from '../../../modules/simulation/environment/submission.js';
import {checkAnalysisResult} from '../../../modules/simulation/environment/analysis.js';
import {onboardingRecovery,recoveryMessage} from '../../../modules/simulation/environment/recovery.js';

const PREFIX='/simulation/onboarding',PENDING_KEY='circuitgit.onboarding.pending.v1';
const clone=value=>structuredClone(value);
const failure=(message,code)=>Object.assign(Error(message),{data:{code}});
const hash=(value,length=64)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const signalId=value=>typeof value==='string'&&/^s_[a-f0-9]{32}$/.test(value);
const requireValue=(condition,message,code='waveform_identity_mismatch')=>{if(!condition)throw failure(message,code);};
const opaque=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f\x7f]/.test(value);
function sessionCanAdvance(previous,next){
  if(!previous)return true;
  if(next.revision<previous.revision||previous.source_sha256&&next.source_sha256!==previous.source_sha256)return false;
  if(next.revision!==previous.revision)return true;
  const before=previous.operation,after=next.operation;
  if(before?.operation_id&&(after?.operation_id!==before.operation_id||
    ['completed','reconciled'].includes(before.status)&&after.status==='active'))return false;
  const previousTime=Date.parse(previous.updated_at),nextTime=Date.parse(next.updated_at);
  return !Number.isFinite(previousTime)||!Number.isFinite(nextTime)||nextTime>=previousTime;
}
const pendingKey=row=>JSON.stringify([row.connectionId,row.intake_id,row.phase,row.phase==='run'?row.plan_id:row.revision]);
const pendingFields=['schema','connectionId','intake_id','revision','phase','plan_id','submission_key','createdAt'];
function checkedPending(row){
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!pendingFields.includes(key))||row.schema!=='ic.onboarding.pending.v1'||
     !opaque(row.connectionId)||!opaque(row.intake_id)||!Number.isInteger(row.revision)||row.revision<0||!['prepare','run'].includes(row.phase)||
     typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))||
     (row.phase==='prepare'?(row.plan_id!==null||row.submission_key!==null):(!opaque(row.plan_id)||row.submission_key!=='experiment-'+row.plan_id)))
    throw failure('待核对请求身份不完整；未提交。','invalid_pending_identity');
  return clone(row);
}

/** Store only opaque request identities, never source, tool paths or credentials. */
export function createOnboardingPendingStore({storage,key=PENDING_KEY}={}){
  const backend=()=>storage===undefined?globalThis.localStorage:storage;
  function read(){
    try{const raw=backend()?.getItem(key);if(!raw)return[];if(raw.length>256*1024)throw Error('too large');const rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.length>128)throw Error('invalid');return rows.map(checkedPending);}
    catch{throw failure('无法读取待核对请求；请保留原请求身份，未发送新操作。','pending_store_unavailable');}
  }
  function write(rows){
    try{const value=JSON.stringify(rows);backend().setItem(key,value);if(backend().getItem(key)!==value)throw Error('not durable');}
    catch{throw failure('浏览器无法保存原请求身份；未提交，请检查站点存储权限。','pending_store_unavailable');}
  }
  return Object.freeze({
    async load({connectionId}){if(!opaque(connectionId))throw failure('缺少连接身份。','invalid_pending_identity');return read().filter(row=>row.connectionId===connectionId);},
    async put(record){const row=checkedPending(record),rows=read(),existing=rows.find(item=>pendingKey(item)===pendingKey(row));if(existing){if(existing.revision!==row.revision||existing.submission_key!==row.submission_key)throw failure('原请求身份不匹配；请核对现有记录。','pending_identity_conflict');return existing;}if(rows.length>=128)throw failure('待核对请求已满，请先核对原请求。','pending_store_full');write([...rows,row]);return row;},
    async remove(record){const rows=read(),key=pendingKey(record);write(rows.filter(row=>pendingKey(row)!==key));},
  });
}

/** Remember only which intake this exact helper/store connection selected. */
export function createOnboardingSelectionStore({storage,key='circuitgit.onboarding.selected.v1'}={}){
  const backend=()=>storage===undefined?globalThis.localStorage:storage;
  function read(){try{const raw=backend()?.getItem(key);if(!raw)return[];if(raw.length>128*1024)throw Error('too large');const rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.length>128||rows.some(row=>!row||Object.keys(row).sort().join(',')!=='connectionId,intake_id'||!opaque(row.connectionId)||!opaque(row.intake_id)))throw Error('invalid');return rows;}catch{throw failure('无法读取此连接的已选网表身份。','selection_store_unavailable');}}
  return Object.freeze({
    async load({connectionId}){return read().find(row=>row.connectionId===connectionId)?.intake_id||null;},
    async remember({connectionId,intake_id}){if(!opaque(connectionId)||!opaque(intake_id))throw failure('已选网表身份无效。','invalid_session_identity');const rows=read().filter(row=>row.connectionId!==connectionId);if(rows.length>=128)throw failure('已保存的连接身份过多。','selection_store_full');const raw=JSON.stringify([...rows,{connectionId,intake_id}]);try{backend().setItem(key,raw);if(backend().getItem(key)!==raw)throw Error('not durable');}catch{throw failure('无法保存已选网表身份；请保留当前会话。','selection_store_unavailable');}},
    async restore({connectionId,expectedIntakeId,intake_id}){
      const rows=read();if(rows.find(row=>row.connectionId===connectionId)?.intake_id!==expectedIntakeId)return false;
      const next=rows.filter(row=>row.connectionId!==connectionId);if(intake_id)next.push({connectionId,intake_id});
      try{const raw=JSON.stringify(next);backend().setItem(key,raw);if(backend().getItem(key)!==raw)throw Error('not durable');}
      catch{throw failure('无法恢复原网表选择，请保留当前会话。','selection_store_unavailable');}return true;
    },
  });
}

/** Read just the currently displayed entry from memory, including its editor text. */
export function snapshotOnboardingSource(doc,{hasBuffer=()=>false,fileText=()=>''}={}){
  if(!doc||typeof doc.path!=='string')return null;
  let file=doc.files?.find(file=>file.path===doc.path);
  // RNL's virtual root keeps /entry.scs on Document and entry.scs on File.
  // Resolve only that exact root alias, never the first file or a basename match.
  if(!file&&doc.path.startsWith('/')&&!doc.path.startsWith('//')){
    const aliases=doc.files?.filter(file=>file.path===doc.path.slice(1))||[];
    if(aliases.length===1)file=aliases[0];
  }
  const bufferPath=file&&hasBuffer(file.path)?file.path:doc.path;
  const text=hasBuffer(bufferPath)?fileText(bufferPath):file?.text;
  if(typeof text!=='string'||!text.trim())return null;
  return {file_name:doc.path.split('/').pop()||'circuit.scs',text};
}

export function createOnboardingBridge({gateway=null,win=globalThis.window,pair=pairLocal,clientFactory=createNodeClient,pendingStore=createOnboardingPendingStore(),selectionStore=createOnboardingSelectionStore(),onPaired=null,onDisconnected=null}={}){
  let transport=null,pairing=null,epoch=0,connecting=false,connectionId=null,storeIdentity=null,endpoint=null,error=null,capabilities={},selectedIntakeId=null,ownsTransport=false,bindingClient=null,selectionTicket=0;
  const mode=gateway?'same-origin':'paired-local',listeners=new Set(),attempted=new Set(),intakes=new Set(),sessions=new Map(),scopeWrites=new Map();
  let selectionQueue=Promise.resolve();
  function saveSelection({scope,intake_id,generation,client,ticket,previous,isCurrent=()=>true}){
    const work=selectionQueue.catch(()=>{}).then(async()=>{
      const current=()=>generation===epoch&&client===transport&&ticket===selectionTicket;
      requireValue(await isCurrent()&&current(),'选择已变化，未采用旧网表。','source_changed');
      await selectionStore.remember({connectionId:scope,intake_id});
      if(!await isCurrent()||!current()){
        if(typeof selectionStore.restore==='function')await selectionStore.restore({connectionId:scope,expectedIntakeId:intake_id,intake_id:previous});
        throw failure('画布或连接已变化，未采用旧 AI 结果。','source_changed');
      }
    });
    selectionQueue=work.catch(()=>{});return work;
  }
  const getState=()=>({connected:!!transport,connecting,mode,revision:epoch,connectionId,storeIdentity,endpoint,error,capabilities:clone(capabilities),selectedIntakeId});
  const publish=()=>{for(const listener of listeners)listener(getState());};
  function disconnect(){const prev=transport,owned=ownsTransport;epoch++;selectionTicket++;pairing?.cancel();pairing=null;if(owned)prev?.close();transport=null;ownsTransport=false;bindingClient=null;connecting=false;connectionId=null;storeIdentity=null;endpoint=null;error=null;capabilities={};selectedIntakeId=null;intakes.clear();sessions.clear();publish();if(prev&&owned)try{onDisconnected?.(prev);}catch{}}
  async function connect(options={}){
    if(connecting)throw failure('连接正在进行。','connection_busy');
    if(!options||typeof options!=='object'||Object.keys(options).some(key=>key!=='port')||options.port!==undefined&&(!Number.isInteger(options.port)||options.port<1||options.port>65535))throw failure('高级连接只接受明确的本机端口。','invalid_connection');
    disconnect();const generation=epoch;connecting=true;publish();let candidate;
    try{
      let info,resolvedEndpoint;
      if(gateway){
        if(options.port!==undefined)throw failure('同源环境不接受其它端口。','invalid_connection');
        info=await gateway.health();resolvedEndpoint=win.location.origin;candidate=gateway;
      }else{
        const base=options.port===undefined?LOCAL_CONNECTOR:'http://127.0.0.1:'+options.port;
        pairing=pair({win,base});const receipt=await pairing.result;pairing=null;
        if(generation!==epoch)throw failure('连接已变化；旧授权已丢弃。','connection_changed');
        if(receipt.url!==base)throw failure('授权回执与明确选择的本机端口不同。','invalid_connection');
        candidate=clientFactory({url:receipt.url,accessCode:receipt.accessCode,onUnauthorized:()=>{if(generation===epoch)disconnect();}});
        info=await candidate.request('/node/info');resolvedEndpoint=candidate.base;
        if(info?.schema!=='circuitgit.remote-node.v1'||info.single_owner!==true||info.auth!=='bearer')throw failure('未返回兼容的本机助手身份。','unsupported_onboarding');
        if(receipt.url===LOCAL_CONNECTOR)saveSessionGrant({url:receipt.url,accessCode:receipt.accessCode},win?.sessionStorage);
      }
      if(generation!==epoch)throw failure('连接已变化；旧响应已丢弃。','connection_changed');
      if(info?.capabilities?.simulation_onboarding!==true||info.capabilities.simulation_onboarding_api_version!=='1')throw failure('此助手尚未提供独立仿真环境配置接口。','unsupported_onboarding');
      const storeId=info.connection_id;
      if(!opaque(storeId))throw failure('助手未返回稳定的环境存储身份；未连接。','missing_connection_identity');
      const scope=mode+'|'+resolvedEndpoint+'|'+storeId;
      const pending=await pendingStore.load({connectionId:scope});
      const selected=await selectionStore.load({connectionId:scope});
      if(generation!==epoch)throw failure('连接已变化；旧响应已丢弃。','connection_changed');
      for(const record of pending){attempted.add(pendingKey(record));intakes.add(record.intake_id);}
      if(selected)intakes.add(selected);
      connectionId=scope;storeIdentity=storeId;endpoint=resolvedEndpoint;selectedIntakeId=selected;
      capabilities=clone(info.capabilities);transport=candidate;ownsTransport=!gateway;connecting=false;error=null;publish();
      if(!gateway&&typeof onPaired==='function')try{onPaired({client:candidate,info:clone(info),local:true});}catch{}
      return getState();
    }catch(problem){if(!gateway)candidate?.close();if(generation===epoch){transport=null;connecting=false;connectionId=null;storeIdentity=null;endpoint=null;error=problem.message;publish();}throw problem;}
  }
  /** Reuse an already authorized browser helper; its AI adapter owns the client. */
  async function bindClient(candidate,info){
    if(gateway)return getState();
    if(info?.schema!=='circuitgit.remote-node.v1'||info.auth!=='bearer'||info.single_owner!==true||
       info.capabilities?.simulation_onboarding!==true||info.capabilities.simulation_onboarding_api_version!=='1'||
       !opaque(info.connection_id)||typeof candidate?.request!=='function'||!candidate.base)
      throw failure('此助手没有兼容的仿真会话接口。','unsupported_onboarding');
    if(transport){
      if(storeIdentity!==info.connection_id||endpoint!==candidate.base)throw failure('仿真与 AI 连接了不同助手，请先明确选择同一个连接。','connection_mismatch');
      return getState();
    }
    if(connecting)throw failure('仿真连接正在进行。','connection_busy');
    const generation=++epoch,scope=mode+'|'+candidate.base+'|'+info.connection_id;
    connecting=true;bindingClient=candidate;publish();
    try{
      const pending=await pendingStore.load({connectionId:scope}),selected=await selectionStore.load({connectionId:scope});
      if(generation!==epoch||bindingClient!==candidate)throw failure('连接已变化。','connection_changed');
      for(const record of pending){attempted.add(pendingKey(record));intakes.add(record.intake_id);}
      if(selected)intakes.add(selected);
      transport=candidate;ownsTransport=false;connectionId=scope;storeIdentity=info.connection_id;endpoint=candidate.base;
      capabilities=clone(info.capabilities);selectedIntakeId=selected;connecting=false;bindingClient=null;publish();return getState();
    }catch(problem){if(generation===epoch){connecting=false;bindingClient=null;publish();}throw problem;}
  }
  function unbindClient(candidate){if(bindingClient===candidate||transport===candidate&&!ownsTransport){disconnect();return true;}return false;}
  /** Adopt only an explicit tool-result identity, after an authoritative readback. */
  async function adoptIntake({connection_id,intake_id,source_sha256},{isCurrent=()=>true}={}){
    requireValue(transport&&connection_id===storeIdentity&&opaque(intake_id)&&hash(source_sha256),'AI 网表身份与当前助手不匹配。','intake_scope_mismatch');
    const generation=epoch,client=transport,scope=connectionId,ticket=++selectionTicket,previous=selectedIntakeId;
    const result=await client.request(PREFIX+'/session?'+new URLSearchParams({intake_id}),{method:'GET',timeout:20000});
    requireValue(generation===epoch&&client===transport,'连接已变化，未采用旧 AI 结果。','connection_changed');
    requireValue(result?.schema==='ic.onboarding.session.v1'&&result.connection_id===connection_id&&result.intake_id===intake_id&&
      result.source_sha256===source_sha256&&Number.isInteger(result.revision)&&result.revision>=1,'AI 网表回读身份不匹配。','invalid_session_identity');
    const notOlder=()=>sessionCanAdvance(sessions.get(intake_id),result);
    requireValue(notOlder(),'此会话已有更新的版本；旧 AI 回读已丢弃。','stale_session_response');
    requireValue(await isCurrent(),'画布已变化，未切换到旧 AI 结果。','source_changed');
    requireValue(generation===epoch&&client===transport&&ticket===selectionTicket,'连接已变化。','connection_changed');
    await saveSelection({scope,intake_id,generation,client,ticket,previous,isCurrent:async()=>await isCurrent()&&notOlder()});
    requireValue(notOlder(),'此会话已有更新的版本；旧 AI 回读已丢弃。','stale_session_response');
    intakes.add(intake_id);selectedIntakeId=intake_id;sessions.set(intake_id,clone(result));publish();return clone(result);
  }
  async function request(name,args){
    const operation=ONBOARDING_OPERATIONS[name];
    if(!transport||!connectionId)throw failure('请先连接仿真环境。','onboarding_disconnected');
    const generation=epoch,scope=connectionId,client=transport,input=clone(args||{});
    const originalIntake=clone(sessions.get(input.intake_id));let originalPending=null;
    const scopeWriteKey=JSON.stringify([scope,input.intake_id]);let scopeWrite=null;
    const observedScopeWrite=scopeWrites.get(scopeWriteKey);
    const scopeWasUnknown=observedScopeWrite?.status==='unknown';
    if(typeof input!=='object'||Array.isArray(input))throw failure('环境操作参数无效。','invalid_input');
    if(!['inspectNetlist','listSshAliases'].includes(name)&&!intakes.has(input.intake_id))throw failure('此网表不属于当前连接中已导入或恢复的会话。','intake_scope_mismatch');
    if(onboardingRecovery(originalIntake)&&operation.method==='POST')throw failure(recoveryMessage(originalIntake),'recovery_required');
    if(observedScopeWrite&&operation.method==='POST')throw failure('PDK 保存正在进行或结果未知；请先读取原会话核对，未重复发送。','scope_reconciliation_required');
    let path=PREFIX+operation.path,options={method:operation.method,timeout:onboardingRequestTimeout(name,input,sessions.get(input.intake_id))};
    if(name==='getPdkScopes')path+='?'+pdkScopeQuery(input);
    else if(operation.query){if(Object.keys(input).length!==operation.query.length||operation.query.some(key=>!opaque(input[key])))throw failure('请提供原始请求身份。','invalid_input');path+='?'+new URLSearchParams(input);}
    else if(operation.method==='GET'){if(Object.keys(input).length)throw failure('本地 SSH 列表不接受过滤或路径参数。','invalid_input');}
    else options.body=input;
    if(name==='probeHost'&&(!Array.isArray(input.ssh_targets)||!input.ssh_targets.length||!input.ssh_targets.every(opaque)))throw failure('请明确选择需要探测的 SSH 主机。','invalid_input');
    if(name==='runPrepared'&&originalIntake?.state==='pre_dispatch_rejected'&&originalIntake.prepared?.plan_id===input.plan_id)throw failure('此原计划已被拒绝；请明确准备新计划，不得重放原提交。','replay_forbidden');
    if(name==='analyzeExperiment'){
      const job=originalIntake?.job,operations=['spec_analyze','coherent_fft','sine_fit3','sine_fit4','weight_calibrate','reconstruct_codes','histogram_linearity','tran_metrics','ac_metrics','dc_op_metrics'];
      requireValue(job?.job_id===input.job_id&&job.run_id===input.job_id&&job.source_commit===originalIntake.source_commit&&operations.includes(input.operation),
        '分析必须绑定当前已保存任务与明确算法。','analysis_scope_mismatch');
      const native=input.dataset_id!==undefined,dataset=native?job.waveforms?.datasets?.find(row=>row.dataset_id===input.dataset_id):null;
      requireValue(native?dataset&&['ac_metrics','dc_op_metrics'].includes(input.operation):!['ac_metrics','dc_op_metrics'].includes(input.operation),'AC/DC 必须显式选择当前任务的独立数据集。','analysis_scope_mismatch');
      const allowed=new Set((native?dataset.available_signal_ids:job.waveforms?.available_signal_ids)||[]),devices=new Set(dataset?.available_device_ids||[]);
      requireValue(input.inputs&&typeof input.inputs==='object'&&!Array.isArray(input.inputs)&&Object.entries(input.inputs).every(([key,value])=>
        value==='@time'?!native&&key==='time_s':Array.isArray(value)?value.length>0&&value.every(id=>(key==='devices'?devices:allowed).has(id)):allowed.has(value)),
        '分析输入必须来自此任务的原始信号目录。','analysis_scope_mismatch');
    }
    if(['prepareExperiment','prepareAgentTestbench','runPrepared'].includes(name)){
      const phase=name==='runPrepared'?'run':'prepare',record=checkedPending({schema:'ic.onboarding.pending.v1',connectionId:scope,intake_id:input.intake_id,revision:input.revision,phase,plan_id:phase==='run'?input.plan_id:null,submission_key:phase==='run'?'experiment-'+input.plan_id:null,createdAt:new Date().toISOString()});
      const key=pendingKey(record);if(attempted.has(key))throw failure('此操作已有原请求；请读取原会话或提交回执，不能重新发送。','replay_forbidden');
      originalPending=await pendingStore.put(record);if(generation!==epoch||scope!==connectionId)throw failure('连接已变化；原请求保留，未发送。','connection_changed');attempted.add(key);
    }
    try{
      if(name==='selectPdkScope'){
        scopeWrite={revision:input.revision,status:'sending'};scopeWrites.set(scopeWriteKey,scopeWrite);
      }
      const result=await client.request(path,options);
      if(generation!==epoch||scope!==connectionId)throw failure(operation.method==='POST'?'连接已变化；请用原身份核对结果，未重发。':'连接已变化；旧响应已丢弃。',operation.method==='POST'?'transport_unknown':'connection_changed');
      if(name==='inspectNetlist'){
        if(result?.schema!=='ic.onboarding.session.v1'||result.connection_id!==storeIdentity||!opaque(result.intake_id)||!Number.isInteger(result.revision)||result.revision<0)throw failure('助手返回的网表会话身份无效。','invalid_session_identity');
        await saveSelection({scope,intake_id:result.intake_id,generation,client,ticket:++selectionTicket,previous:selectedIntakeId});
        if(generation!==epoch||scope!==connectionId)throw failure('连接已变化；旧响应已丢弃。','connection_changed');
        intakes.add(result.intake_id);
        selectedIntakeId=result.intake_id;publish();
      }
      if(name==='getPdkScopes'){
        const catalog=result?.catalog,items=catalog?.items,offset=input.offset??0,limit=input.limit??64;
        const idKey=input.entry_id?'section_id':'entry_id';
        requireValue(result?.schema==='ic.onboarding.pdk-scopes.v1'&&result.connection_id===storeIdentity&&
          result.intake_id===input.intake_id&&result.probe_id===input.probe_id&&Number.isSafeInteger(result.revision)&&result.revision>=1&&
          (!originalIntake||result.revision===originalIntake.revision)&&
          (!sessions.has(input.intake_id)||result.revision===sessions.get(input.intake_id).revision)&&
          catalog?.schema==='spiceowl.pdk-scope-catalog.v1'&&catalog.library_id===input.library_id&&
          catalog.entry_id===(input.entry_id??null)&&catalog.kind===(input.entry_id?'sections':'entries')&&catalog.ready_to_run===false&&
          ['available','blocked'].includes(catalog.status)&&Array.isArray(catalog.missing)&&typeof catalog.library_complete_within_policy==='boolean'&&
          Array.isArray(items)&&items.length<=limit&&items.every(row=>row&&hash(row[idKey]))&&new Set(items.map(row=>row[idKey])).size===items.length&&
          items.every(row=>input.entry_id?('section' in row&&(row.section===null||opaque(row.section))&&typeof row.has_include_targets==='boolean'&&
            Number.isSafeInteger(row.observed_model_count)&&row.observed_model_count>=0&&Array.isArray(row.unknown_codes)):
            (opaque(row.label)&&hash(row.entry_sha256)&&Number.isSafeInteger(row.section_count)&&row.section_count>=0))&&
          Number.isSafeInteger(catalog.total)&&catalog.total>=0&&offset+items.length<=Math.max(offset,catalog.total)&&
          items.length===Math.min(limit,Math.max(catalog.total-offset,0))&&
          (offset+items.length>=catalog.total?catalog.next_offset===null:
            Number.isSafeInteger(catalog.next_offset)&&catalog.next_offset===offset+items.length&&catalog.next_offset>offset),
          'PDK 目录与原始库、主机或版本不一致；未采用旧目录。','pdk_scope_mismatch');
      }
      if(['getSession','getAgentTestbench','probeVerilogaHeaders','probeHost','discoverPdk','selectPdkScope','prepareExperiment','saveAgentTestbench','prepareAgentTestbench','runPrepared','inspectExperiment'].includes(name)){
        const advances=['probeVerilogaHeaders','probeHost','discoverPdk','selectPdkScope','prepareExperiment','saveAgentTestbench','prepareAgentTestbench','runPrepared'].includes(name);
        if(result?.schema!=='ic.onboarding.session.v1'||result.connection_id!==storeIdentity||result.intake_id!==input.intake_id||!Number.isInteger(result.revision)||result.revision<0||advances&&result.revision!==input.revision+1)throw failure('助手返回了不同的会话或版本；请核对原会话。','invalid_session_identity');
      }
      if(name==='selectPdkScope'){
        const selection=result.pdk_scope_selection;
        requireValue(selection&&hash(selection.selection_id)&&selection.probe_id===input.probe_id&&
          (!sessions.has(input.intake_id)||sessions.get(input.intake_id).revision<=result.revision)&&
          selection.library_id===input.library_id&&selection.entry_id===input.entry_id&&
          JSON.stringify(selection.section_ids)===JSON.stringify(input.section_ids)&&
          hash(selection.source_sha256)&&selection.source_sha256===result.source_sha256&&
          (!originalIntake?.source_sha256||selection.source_sha256===originalIntake.source_sha256)&&
          ['blocked','requires_audit'].includes(selection.status)&&selection.ready_to_run===false&&selection.fresh_audit_required===true&&
          hash(selection.requirements_sha256)&&selection.scientific_compatibility==='not_evaluated'&&selection.model_contracts_reused===false&&
          Array.isArray(selection.sections)&&selection.sections.length===input.section_ids.length&&
          ['required_model_names','covered_model_names','missing_model_names','tmi_options','missing'].every(key=>Array.isArray(selection[key]))&&
          selection.selected_tmi_option_id===(input.tmi_option_id??null),
          'PDK 选择回执与原始 section 或来源不符；请读取原会话核对。','pdk_scope_mismatch');
      }
      const rejectionClaim=name==='runPrepared'?(result?.state==='pre_dispatch_rejected'||result?.submission?.dispatch_outcome==='pre_dispatch_rejected'||!!result?.submission?.rejection):
        name==='readSubmission'&&(result?.dispatch_outcome==='pre_dispatch_rejected'||!!result?.rejection);
      if(rejectionClaim){
        try{
          if(name==='runPrepared'&&(result.state!=='pre_dispatch_rejected'||result.job!==null||result.source_sha256!==originalIntake?.source_sha256))throw Error('Unexpected run rejection envelope');
          if(name==='readSubmission'){
            const rows=await pendingStore.load({connectionId:scope});
            if(generation!==epoch||scope!==connectionId)throw failure('连接已变化；原请求继续保留。','connection_changed');
            originalPending=rows.find(row=>row.phase==='run'&&row.intake_id===input.intake_id&&row.plan_id===input.plan_id)||null;
          }
          const submission=name==='runPrepared'?result.submission:result;
          const verification={intake:originalIntake,plan:originalIntake?.prepared,pending:originalPending,connectionId:scope};
          validatePreDispatchRejection(submission,verification);
          if(name==='runPrepared')validatePreDispatchRejection(submission,{...verification,intake:result});
          if(originalPending)attempted.add(pendingKey(originalPending));
        }catch(problem){
          const unknown=failure('提交前拒绝回执尚未通过原计划核对；继续保留原请求，不得重新提交。','transport_unknown');unknown.cause=problem;throw unknown;
        }
      }
      if(['runPrepared','inspectExperiment'].includes(name)&&!rejectionClaim){
        const job=result.job;
        if(job?.schema!=='ic.experiment.job.v1'||!opaque(job.job_id)||job.job_id!==job.run_id||
           name==='runPrepared'&&job.plan_id!==input.plan_id||name==='inspectExperiment'&&job.job_id!==input.job_id)
          throw failure('返回的实验任务与原请求不一致。','invalid_job_identity');
      }
      if(name==='readSubmission'&&(result?.intake_id!==input.intake_id||result.plan_id!==input.plan_id||
          result.submission_key!=='experiment-'+input.plan_id||result.replay_permitted!==false||typeof result.found!=='boolean'||
          result.found&&(result.job?.schema!=='ic.experiment.job.v1'||result.job.job_id!==result.run_id||result.job.run_id!==result.run_id||result.job.plan_id!==input.plan_id)))
        throw failure('提交回执与原会话或计划不一致。','invalid_submission_identity');
      if(name==='analyzeExperiment')requireValue(result?.schema==='ic.onboarding.analysis.v1'&&result.intake_id===input.intake_id&&
        result.job_id===input.job_id&&result.run_id===input.job_id&&result.source_commit===originalIntake.job.source_commit&&result.original_source_sha256===originalIntake.source_sha256&&
        result.archive_sha256===originalIntake.job.waveforms?.archive_sha256&&hash(result.archive_sha256)&&hash(result.analysis_id)&&
        result.input?.archive_sha256===result.archive_sha256&&(input.dataset_id?result.input?.dataset_id===input.dataset_id&&hash(result.input?.data_sha256):hash(result.input?.csv_sha256))&&result.input.full_resolution===true&&result.input.display_downsampling_used===false&&
        result.request?.operation===input.operation&&result.result?.operation===input.operation,
        '分析结果的源码、任务或数据归档身份不一致。','analysis_scope_mismatch');
      if(name==='analyzeExperiment')try{checkAnalysisResult(result,originalIntake);}catch{throw failure('分析原始数据来源或指标回执不完整。','analysis_scope_mismatch');}
      if(result?.schema==='ic.onboarding.session.v1'){
        const latest=sessions.get(result.intake_id);
        requireValue(sessionCanAdvance(latest,result),
          '此会话已有更新的版本；旧回读已丢弃。','stale_session_response');
        sessions.set(result.intake_id,clone(result));
        if(scopeWrite)scopeWrites.delete(scopeWriteKey);
        // Only a read started after an unknown save may reconcile it. A read
        // overlapping a still-pending write cannot unlock another mutation.
        if(name==='getSession'&&scopeWasUnknown&&scopeWrites.get(scopeWriteKey)===observedScopeWrite&&
          !onboardingRecovery(result)&&result.operation?.status!=='active')scopeWrites.delete(scopeWriteKey);
        publish();
      }
      return result;
    }catch(problem){
      if(scopeWrite){
        if(problem.data?.commit_status==='not_committed')scopeWrites.delete(scopeWriteKey);
        else scopeWrite.status='unknown';
      }
      if(generation!==epoch||scope!==connectionId)throw failure(operation.method==='POST'?'连接已变化；请用原身份核对结果，未重发。':'连接已变化；旧响应已丢弃。',operation.method==='POST'?'transport_unknown':'connection_changed');
      if(name==='analyzeExperiment'&&problem.data?.code==='analysis_scope_mismatch')throw problem;
      if(operation.method==='POST'&&(!problem.status||problem.code==='response_size_limit'||problem.data?.code==='response_size_limit')&&!['replay_forbidden','connection_changed'].includes(problem.data?.code)){
        const unknown=failure('操作结果尚未确认；请在原连接中核对原会话或提交回执，不要重新发送。','transport_unknown');unknown.cause=problem;throw unknown;
      }
      throw problem;
    }
  }
  /** Human review is a separate local page; no approval decision is exposed as an agent operation. */
  function openAgentTestbenchReview({intake_id,revision,review_id,review_digest,plan_id},{event}={}){
    requireValue(event?.isTrusted===true,'请直接点击人工审阅按钮打开本机确认页面。','human_gesture_required');
    const session=sessions.get(intake_id),review=session?.agent_tb_review;
    requireValue(transport&&selectedIntakeId===intake_id&&session?.connection_id===storeIdentity&&session.revision===revision&&
      review?.state==='pending'&&review.requires_human===true&&review.revision===revision&&review.review_id===review_id&&
      review.review_digest===review_digest&&review.plan_id===plan_id&&session.prepared?.plan_id===plan_id,
      '人工审阅计划已变化，请刷新并重新准备。','review_binding_changed');
    const expected='/agent-tb/review?'+new URLSearchParams({intake_id,review_id});
    requireValue(review.review_path===expected,'人工审阅路径与冻结身份不一致。','invalid_review_url');
    requireValue(mode==='same-origin'||typeof review.review_url==='string','本机助手尚未提供审阅服务的完整地址。','invalid_review_url');
    let url;try{url=new URL(review.review_url||review.review_path,endpoint);}catch{throw failure('本机人工审阅地址无效。','invalid_review_url');}
    requireValue(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&!url.hash&&url.pathname+url.search===expected,
      '人工审阅仅能打开此计划的本机确认页面。','invalid_review_url');
    const popup=win.open('about:blank','_blank');requireValue(popup,'请允许弹窗后重新打开人工审阅页面。','popup_blocked');
    popup.opener=null;popup.location.replace(url.href);return {opened:true,intake_id,review_id,plan_id};
  }
  function waveformApi({intake_id,job}={}){
    requireValue(transport&&connectionId,'请先连接此实验原来的仿真环境。','onboarding_disconnected');
    job=clone(job);
    const session=sessions.get(intake_id),descriptor=clone(job?.waveforms),generation=epoch,scope=connectionId,client=transport;
    requireValue(intakes.has(intake_id)&&session?.connection_id===storeIdentity,'请先读取此连接中的原始网表会话。','intake_scope_mismatch');
    requireValue(job?.schema==='ic.experiment.job.v1'&&job.job_id===job.run_id&&opaque(job.job_id)&&hash(job.source_commit,40)&&
      session.prepared?.plan_id===job.plan_id&&session.prepared.source_commit===job.source_commit&&session.source_commit===job.source_commit&&
      job.project_id===session.prepared.project_id&&job.configuration===session.prepared.recipe_id,
      '波形任务与当前读取的实验计划不一致。');
    requireValue(descriptor?.schema==='ic.onboarding.waveform-descriptor.v1'&&descriptor.available===true&&descriptor.source_binding_verified===true&&
      descriptor.intake_id===intake_id&&descriptor.job_id===job.job_id&&descriptor.run_id===job.run_id&&descriptor.source_commit===job.source_commit&&
      descriptor.original_source_sha256===session.source_sha256&&hash(descriptor.original_source_sha256)&&hash(descriptor.compiled_source_sha256)&&
      ['none','added_explicit_subcircuit_wrapper'].includes(descriptor.transformation)&&
      (descriptor.transformation!=='none'||descriptor.original_source_sha256===descriptor.compiled_source_sha256)&&
      descriptor.read_only===true&&descriptor.probe?.enabled===false&&descriptor.probe.current_geometry_context_verified===false,
      '此运行没有经过来源校验的已导出波形。');
    const mapping=session.source_mapping;
    requireValue(mapping&&mapping.source_commit===job.source_commit&&mapping.original_source_sha256===descriptor.original_source_sha256&&
      mapping.compiled_source_sha256===descriptor.compiled_source_sha256&&mapping.source_id===descriptor.compiled_source_path&&
      mapping.transformation===descriptor.transformation,'波形编译记录与已准备实验的源码映射不同。');
    const identity=['archive_sha256','raw_signature','effective_config_sha256'];
    const datasets=descriptor.datasets||[],dataFor=did=>{const row=datasets.find(item=>item.dataset_id===did);requireValue(/^ds_[a-f0-9]{32}$/.test(did)&&row&&hash(row.data_sha256)&&row.data_format==='native_psf_json','请选择此原任务中的保存数据集。');return row;};
    requireValue(identity.every(key=>hash(descriptor[key]))&&Array.isArray(descriptor.available_signal_ids)&&(descriptor.available_signal_ids.length>0&&hash(descriptor.csv_sha256)||datasets.some(row=>row.available===true&&(row.available_signal_ids?.length||row.available_device_ids?.length)))&&descriptor.available_signal_ids.length<=4096&&
      descriptor.available_signal_ids.every(signalId)&&new Set(descriptor.available_signal_ids).size===descriptor.available_signal_ids.length,
      '波形描述缺少归档、配置或信号身份。');
    const compiledMatches=data=>data?.source_hashes&&typeof data.source_hashes==='object'&&
      (descriptor.compiled_source_path?data.source_hashes[descriptor.compiled_source_path]===descriptor.compiled_source_sha256:Object.values(data.source_hashes).includes(descriptor.compiled_source_sha256));
    requireValue(compiledMatches(descriptor),'波形描述未包含编译后源码的准确身份。');
    const available=new Map();
    const current=()=>requireValue(generation===epoch&&scope===connectionId&&client===transport,'波形连接已变化；未读取其它连接。','connection_changed');
    const checkRun=run=>{current();requireValue(run===job.run_id,'只能读取选中的原始波形任务。');};
    const checkAbort=options=>{if(options?.signal?.aborted)throw new DOMException('Aborted','AbortError');};
    const nested=(data,did)=>{
      requireValue(['ic.waveforms.v1','ic.waveform-map.v1'].includes(data?.schema)&&data.run_id===job.run_id&&data.source_commit===job.source_commit&&
        identity.every(key=>data[key]===descriptor[key])&&compiledMatches(data),'波形内容的源码、归档或配置身份不同。');
      if(did){const row=dataFor(did);requireValue(data.dataset_id===did&&data.data_sha256===row.data_sha256&&data.data_format===row.data_format&&data.analysis_id===row.analysis?.name&&data.analysis_kind===row.analysis?.kind&&data.native_member_sha256===row.native_member?.sha256,'数据集的内容或原始分析身份已改变。');}
      else requireValue(data.dataset_id===undefined&&data.csv_sha256===descriptor.csv_sha256,'默认目录数据身份改变。');
      return data;
    };
    async function read(operation,run,params={},options){
      checkRun(run);checkAbort(options);
      const query=new URLSearchParams({intake_id,job_id:job.job_id,...params});
      const response=await client.request(PREFIX+'/waveforms/'+operation+'?'+query,{method:'GET',timeout:20000});
      current();checkAbort(options);
      const fields=['intake_id','job_id','run_id','source_commit','archive_sha256','original_source_sha256','compiled_source_sha256','compiled_source_path','transformation'];
      requireValue(response?.schema==='ic.onboarding.waveforms.v1'&&response.operation===operation&&fields.every(key=>response[key]===descriptor[key])&&
        response.read_only===true&&response.probe?.enabled===false&&response.probe.current_geometry_context_verified===false,
        '波形响应与原始网表、任务或编译记录不一致。');
      requireValue(response.dataset_id===params.dataset_id,'返回了其它数据集。');
      return response;
    }
    return Object.freeze({
      async catalog(run,options){
        const did=options?.dataset_id,query=did?{dataset_id:did}:{};if(did)dataFor(did);
        const data=nested((await read('catalog',run,query,options)).catalog,did);
        requireValue(Array.isArray(data.signals)&&data.signals.length<=4096&&data.signals.every(row=>signalId(row.id))&&
          new Set(data.signals.map(row=>row.id)).size===data.signals.length,'波形目录的信号身份无效。');
        const ids=new Set(data.signals.filter(row=>row.status==='available').map(row=>row.id));
        const expected=did?dataFor(did).available_signal_ids:descriptor.available_signal_ids;
        requireValue(ids.size===expected.length&&expected.every(id=>ids.has(id)),'波形目录与已检查的可用信号不同。');
        if(!did)requireValue(JSON.stringify(data.datasets||[])===JSON.stringify(datasets),'保存数据集目录改变。');
        available.set(did||'',ids);return data;
      },
      async mapping(run,options){const did=options?.dataset_id;if(did)dataFor(did);return nested((await read('mapping',run,did?{dataset_id:did}:{},options)).mapping,did);},
      async waveform(run,id,params={},options){
        checkRun(run);const did=params.dataset_id;if(did)dataFor(did);requireValue(available.get(did||'')?.has(id)&&signalId(id),'请先从此运行的真实目录中选择可用信号。');
        requireValue(params&&typeof params==='object'&&!Array.isArray(params)&&Object.keys(params).every(key=>['start','end','limit','cursor_a','cursor_b','dataset_id'].includes(key)),
          '波形窗口参数不受支持。','invalid_input');
        const query={signal_ids:id,...(did?{dataset_id:did}:{})};
        for(const [input,output] of [['start','start'],['end','stop']])if(params[input]!==undefined){requireValue(typeof params[input]==='number'&&Number.isFinite(params[input]),'时间窗必须使用有限秒值。','invalid_input');query[output]=params[input];}
        if(query.start!==undefined&&query.stop!==undefined)requireValue(query.start<query.stop,'时间窗结束值必须晚于开始值。','invalid_input');
        if(params.limit!==undefined){requireValue(Number.isInteger(params.limit)&&params.limit>=4&&params.limit<=10000,'波形显示采样数超出限制。','invalid_input');query.max_points=params.limit;}
        // The onboarding endpoint does not yet support cursor queries. Keep the
        // real service measurement metadata; never measure decimated plot points.
        const response=await read('window',run,query,options);
        requireValue(Array.isArray(response.series)&&response.series.length===1,'波形窗口没有返回唯一的已选信号。');
        const data=nested(response.series[0],did);
        const points=data.complex_points||data.points,width=data.representation==='complex_real_imag'?3:2;
        requireValue(data.signal?.id===id&&(did&&data.axis===null&&data.operating_value||Array.isArray(points)&&points.length<=10000&&points.every(point=>Array.isArray(point)&&point.length===width&&Number.isFinite(point[0])&&point.slice(1).every(v=>Number.isFinite(v)||did&&(v===null||data.representation==='string'&&typeof v==='string')))),'波形窗口返回了其它信号或无效样本。');
        return data;
      },
    });
  }
  const methods=Object.fromEntries(Object.keys(ONBOARDING_OPERATIONS).map(name=>[name,args=>request(name,args)]));
  return Object.freeze({...methods,openAgentTestbenchReview,waveformApi,getState,connect,bindClient,unbindClient,adoptIntake,disconnect,pendingStore,
    getSessionState:()=>clone(sessions.get(selectedIntakeId)||null),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}});
}
