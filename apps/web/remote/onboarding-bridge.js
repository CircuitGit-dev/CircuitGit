// Onboarding owns a transport and receipt scope independently of any AI session.
import {createNodeClient,ONBOARDING_OPERATIONS,onboardingRequestTimeout} from './client.js';
import {pairLocal,LOCAL_CONNECTOR} from './pair.js';
import {validatePreDispatchRejection} from '../../../modules/simulation/environment/submission.js';

const PREFIX='/simulation/onboarding',PENDING_KEY='circuitgit.onboarding.pending.v1';
const clone=value=>structuredClone(value);
const failure=(message,code)=>Object.assign(Error(message),{data:{code}});
const hash=(value,length=64)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const signalId=value=>typeof value==='string'&&/^s_[a-f0-9]{32}$/.test(value);
const requireValue=(condition,message,code='waveform_identity_mismatch')=>{if(!condition)throw failure(message,code);};
const opaque=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f\x7f]/.test(value);
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
  });
}

/** Read just the currently displayed entry from memory, including its editor text. */
export function snapshotOnboardingSource(doc,{hasBuffer=()=>false,fileText=()=>''}={}){
  if(!doc||typeof doc.path!=='string')return null;
  const file=doc.files?.find(file=>file.path===doc.path),text=hasBuffer(doc.path)?fileText(doc.path):file?.text;
  if(typeof text!=='string'||!text.trim())return null;
  return {file_name:doc.path.split('/').pop()||'circuit.scs',text};
}

export function createOnboardingBridge({gateway=null,win=globalThis.window,pair=pairLocal,clientFactory=createNodeClient,pendingStore=createOnboardingPendingStore(),selectionStore=createOnboardingSelectionStore()}={}){
  let transport=null,pairing=null,epoch=0,connecting=false,connectionId=null,storeIdentity=null,endpoint=null,error=null,capabilities={},selectedIntakeId=null;
  const mode=gateway?'same-origin':'paired-local',listeners=new Set(),attempted=new Set(),intakes=new Set(),sessions=new Map();
  const getState=()=>({connected:!!transport,connecting,mode,revision:epoch,connectionId,endpoint,error,capabilities:clone(capabilities),selectedIntakeId});
  const publish=()=>{for(const listener of listeners)listener(getState());};
  function disconnect(){epoch++;pairing?.cancel();pairing=null;if(!gateway)transport?.close();transport=null;connecting=false;connectionId=null;storeIdentity=null;endpoint=null;error=null;capabilities={};selectedIntakeId=null;intakes.clear();sessions.clear();publish();}
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
      capabilities=clone(info.capabilities);transport=candidate;connecting=false;error=null;publish();return getState();
    }catch(problem){if(!gateway)candidate?.close();if(generation===epoch){transport=null;connecting=false;connectionId=null;storeIdentity=null;endpoint=null;error=problem.message;publish();}throw problem;}
  }
  async function request(name,args){
    const operation=ONBOARDING_OPERATIONS[name];
    if(!transport||!connectionId)throw failure('请先连接仿真环境。','onboarding_disconnected');
    const generation=epoch,scope=connectionId,client=transport,input=clone(args||{});
    const originalIntake=clone(sessions.get(input.intake_id));let originalPending=null;
    if(typeof input!=='object'||Array.isArray(input))throw failure('环境操作参数无效。','invalid_input');
    if(!['inspectNetlist','listSshAliases'].includes(name)&&!intakes.has(input.intake_id))throw failure('此网表不属于当前连接中已导入或恢复的会话。','intake_scope_mismatch');
    let path=PREFIX+operation.path,options={method:operation.method,timeout:onboardingRequestTimeout(name,input,sessions.get(input.intake_id))};
    if(operation.query){if(Object.keys(input).length!==operation.query.length||operation.query.some(key=>!opaque(input[key])))throw failure('请提供原始请求身份。','invalid_input');path+='?'+new URLSearchParams(input);}
    else if(operation.method==='GET'){if(Object.keys(input).length)throw failure('本地 SSH 列表不接受过滤或路径参数。','invalid_input');}
    else options.body=input;
    if(name==='probeHost'&&(!Array.isArray(input.ssh_targets)||!input.ssh_targets.length||!input.ssh_targets.every(opaque)))throw failure('请明确选择需要探测的 SSH 主机。','invalid_input');
    if(name==='runPrepared'&&originalIntake?.state==='pre_dispatch_rejected'&&originalIntake.prepared?.plan_id===input.plan_id)throw failure('此原计划已被拒绝；请明确准备新计划，不得重放原提交。','replay_forbidden');
    if(['prepareExperiment','runPrepared'].includes(name)){
      const phase=name==='runPrepared'?'run':'prepare',record=checkedPending({schema:'ic.onboarding.pending.v1',connectionId:scope,intake_id:input.intake_id,revision:input.revision,phase,plan_id:phase==='run'?input.plan_id:null,submission_key:phase==='run'?'experiment-'+input.plan_id:null,createdAt:new Date().toISOString()});
      const key=pendingKey(record);if(attempted.has(key))throw failure('此操作已有原请求；请读取原会话或提交回执，不能重新发送。','replay_forbidden');
      originalPending=await pendingStore.put(record);if(generation!==epoch||scope!==connectionId)throw failure('连接已变化；原请求保留，未发送。','connection_changed');attempted.add(key);
    }
    try{
      const result=await client.request(path,options);
      if(generation!==epoch||scope!==connectionId)throw failure(operation.method==='POST'?'连接已变化；请用原身份核对结果，未重发。':'连接已变化；旧响应已丢弃。',operation.method==='POST'?'transport_unknown':'connection_changed');
      if(name==='inspectNetlist'){
        if(result?.schema!=='ic.onboarding.session.v1'||result.connection_id!==storeIdentity||!opaque(result.intake_id)||!Number.isInteger(result.revision)||result.revision<0)throw failure('助手返回的网表会话身份无效。','invalid_session_identity');
        await selectionStore.remember({connectionId:scope,intake_id:result.intake_id});
        if(generation!==epoch||scope!==connectionId)throw failure('连接已变化；旧响应已丢弃。','connection_changed');
        intakes.add(result.intake_id);
        selectedIntakeId=result.intake_id;publish();
      }
      if(['getSession','probeHost','discoverPdk','prepareExperiment','runPrepared','inspectExperiment'].includes(name)){
        const advances=['probeHost','discoverPdk','prepareExperiment','runPrepared'].includes(name);
        if(result?.schema!=='ic.onboarding.session.v1'||result.connection_id!==storeIdentity||result.intake_id!==input.intake_id||!Number.isInteger(result.revision)||result.revision<0||advances&&result.revision!==input.revision+1)throw failure('助手返回了不同的会话或版本；请核对原会话。','invalid_session_identity');
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
      if(result?.schema==='ic.onboarding.session.v1')sessions.set(result.intake_id,clone(result));
      return result;
    }catch(problem){
      if(generation!==epoch||scope!==connectionId)throw failure(operation.method==='POST'?'连接已变化；请用原身份核对结果，未重发。':'连接已变化；旧响应已丢弃。',operation.method==='POST'?'transport_unknown':'connection_changed');
      if(operation.method==='POST'&&(!problem.status||problem.code==='response_size_limit'||problem.data?.code==='response_size_limit')&&!['replay_forbidden','connection_changed'].includes(problem.data?.code)){
        const unknown=failure('操作结果尚未确认；请在原连接中核对原会话或提交回执，不要重新发送。','transport_unknown');unknown.cause=problem;throw unknown;
      }
      throw problem;
    }
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
    const identity=['archive_sha256','raw_signature','effective_config_sha256','csv_sha256'];
    requireValue(identity.every(key=>hash(descriptor[key]))&&Array.isArray(descriptor.available_signal_ids)&&descriptor.available_signal_ids.length>0&&descriptor.available_signal_ids.length<=4096&&
      descriptor.available_signal_ids.every(signalId)&&new Set(descriptor.available_signal_ids).size===descriptor.available_signal_ids.length,
      '波形描述缺少归档、配置或信号身份。');
    const compiledMatches=data=>data?.source_hashes&&typeof data.source_hashes==='object'&&
      (descriptor.compiled_source_path?data.source_hashes[descriptor.compiled_source_path]===descriptor.compiled_source_sha256:Object.values(data.source_hashes).includes(descriptor.compiled_source_sha256));
    requireValue(compiledMatches(descriptor),'波形描述未包含编译后源码的准确身份。');
    let available=null;
    const current=()=>requireValue(generation===epoch&&scope===connectionId&&client===transport,'波形连接已变化；未读取其它连接。','connection_changed');
    const checkRun=run=>{current();requireValue(run===job.run_id,'只能读取选中的原始波形任务。');};
    const checkAbort=options=>{if(options?.signal?.aborted)throw new DOMException('Aborted','AbortError');};
    const nested=data=>{
      requireValue(data?.schema==='ic.waveforms.v1'&&data.run_id===job.run_id&&data.source_commit===job.source_commit&&
        identity.every(key=>data[key]===descriptor[key])&&compiledMatches(data),'波形内容的源码、归档或配置身份不同。');
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
      return response;
    }
    return Object.freeze({
      async catalog(run,options){
        const data=nested((await read('catalog',run,{},options)).catalog);
        requireValue(Array.isArray(data.signals)&&data.signals.length<=4096&&data.signals.every(row=>signalId(row.id))&&
          new Set(data.signals.map(row=>row.id)).size===data.signals.length,'波形目录的信号身份无效。');
        const ids=new Set(data.signals.filter(row=>row.status==='available').map(row=>row.id));
        requireValue(ids.size===descriptor.available_signal_ids.length&&descriptor.available_signal_ids.every(id=>ids.has(id)),'波形目录与已检查的可用信号不同。');
        available=ids;return data;
      },
      async mapping(run,options){return nested((await read('mapping',run,{},options)).mapping);},
      async waveform(run,id,params={},options){
        checkRun(run);requireValue(available?.has(id)&&signalId(id),'请先从此运行的真实目录中选择可用信号。');
        requireValue(params&&typeof params==='object'&&!Array.isArray(params)&&Object.keys(params).every(key=>['start','end','limit','cursor_a','cursor_b'].includes(key)),
          '波形窗口参数不受支持。','invalid_input');
        const query={signal_ids:id};
        for(const [input,output] of [['start','start'],['end','stop']])if(params[input]!==undefined){requireValue(typeof params[input]==='number'&&Number.isFinite(params[input]),'时间窗必须使用有限秒值。','invalid_input');query[output]=params[input];}
        if(query.start!==undefined&&query.stop!==undefined)requireValue(query.start<query.stop,'时间窗结束值必须晚于开始值。','invalid_input');
        if(params.limit!==undefined){requireValue(Number.isInteger(params.limit)&&params.limit>=4&&params.limit<=10000,'波形显示采样数超出限制。','invalid_input');query.max_points=params.limit;}
        // The onboarding endpoint does not yet support cursor queries. Keep the
        // real service measurement metadata; never measure decimated plot points.
        const response=await read('window',run,query,options);
        requireValue(Array.isArray(response.series)&&response.series.length===1,'波形窗口没有返回唯一的已选信号。');
        const data=nested(response.series[0]);
        requireValue(data.signal?.id===id&&Array.isArray(data.points)&&data.points.length<=10000&&
          data.points.every(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)),'波形窗口返回了其它信号或无效样本。');
        return data;
      },
    });
  }
  const methods=Object.fromEntries(Object.keys(ONBOARDING_OPERATIONS).map(name=>[name,args=>request(name,args)]));
  return Object.freeze({...methods,waveformApi,getState,connect,disconnect,pendingStore,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}});
}
