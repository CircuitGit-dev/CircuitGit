// Explicit composer handoffs contain a bounded, allowlisted observation only.
// No connection configuration, raw logs, source text or approval data is copied.
export const AGENT_ASSISTANCE_CONTEXT_LIMIT=20*1024;
const scalar=(value,limit=180)=>typeof value==='string'&&value.length<=limit&&!/[\u0000-\u001f\u007f]/.test(value)?value:null;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const list=value=>Array.isArray(value)?value:[];
const strings=(value,max=16)=>list(value).slice(0,max).map(item=>scalar(item,128)).filter(item=>item!==null);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)?value:null;
const codes=value=>list(value).slice(0,8).map(item=>scalar(item?.code,128)).filter(Boolean);
const stages=['intake','probe','discovery','preparation','run','agentSave','agentReview','scopeSave','headerScan'];
const dimensions=['execution_status','measurement_validity','functional_performance','operating_qualification','dependency_provenance'];
const identityKeys=['project_id','run_id','source_commit','configuration'];

function request(kind,prompt,context){
  if(new TextEncoder().encode(JSON.stringify(context)).length>AGENT_ASSISTANCE_CONTEXT_LIMIT)throw Error('当前上下文超过 Agent 草稿上限，请缩小到一个实验或运行。');
  return {kind,prompt,context};
}
function runSummary(run){
  const diagnostics=run.report?.diagnostics?.diagnostics||run.diagnostics?.diagnostics||[];
  return {
    run_id:scalar(run.run_id),job_id:scalar(run.job_id),project_id:scalar(run.project_id),
    source_commit:commit(run.source_commit),configuration:scalar(run.configuration),plan_id:scalar(run.plan_id),
    state:scalar(run.execution?.state||run.state),exit_code:Number.isSafeInteger(run.execution?.exit_code)?run.execution.exit_code:null,
    report_status:Object.fromEntries(dimensions.map(key=>[key,scalar(run.report?.[key]?.status)])),
    diagnostic_count:list(diagnostics).length,
    diagnostics:list(diagnostics).slice(0,8).map(item=>({code:scalar(item.code,128),category:scalar(item.category,128),severity:scalar(item.severity),line_numbers:list(item.evidence_line_numbers).filter(value=>Number.isSafeInteger(value)&&value>0).slice(0,16)})),
    waveform_available:run.waveforms?.available===true,
  };
}

export function environmentAgentAssistance(kind,state,editor={}){
  if(!['environment','testbench','diagnosis'].includes(kind))throw Error('未知 Agent 协助类型。');
  const session=state.session,connection=state.connection||{},scope=session?.pdk_scope_selection,draft=session?.agent_tb;
  const valid=!!session&&!!scalar(session.intake_id)&&!!scalar(session.connection_id)&&!!hash(session.source_sha256)&&count(session.revision)!==null;
  // The adapter's pairing ID and the persisted intake store ID are distinct.
  const connectionMatches=valid&&!!state.boundConnectionId&&state.boundConnectionId===connection.connectionId&&(!connection.selectedIntakeId||connection.selectedIntakeId===session.intake_id);
  const binding={status:!valid?'unbound':connectionMatches?'bound':'connection_mismatch',
    connection_id:valid?session.connection_id:null,intake_id:valid?session.intake_id:null,
    revision:valid?session.revision:null,source_sha256:valid?session.source_sha256:null,
    source_commit:valid?commit(session.source_commit):null,adapter_connection_id:valid?scalar(state.boundConnectionId):null,connected:connection.connected===true};
  const requirements=session?.source?.requirements;
  const masters=requirements?.required_masters||state.source?.models;
  const interfaces=requirements?.interfaces||list(state.source?.ports).map(item=>({name:item.scope,ports:item.names}));
  const lut=list(session?.discovery?.lut);
  const context={schema:'ic.simulation.agent-assistance.v1',origin:'environment',binding,
    source:{file_name:scalar(session?.source?.file_name||state.source?.name,240),model_count:list(masters).length,models:strings(masters,24),
      interface_count:list(interfaces).length,interfaces:list(interfaces).slice(0,4).map(item=>({name:scalar(item.name,128),ports:strings(item.ports,16)}))},
    workflow:{busy:scalar(state.busy),pending_request_count:list(state.pending).length,
      stages:Object.fromEntries(stages.map(key=>[key,scalar(state[key]?.status)])),setup_dirty:state.setupDirty===true,search_scope_dirty:state.searchScopeDirty===true},
    environment:{selected_host_count:list(state.targets).length,probe_count:list(session?.probes).length,
      probe_ids:strings(list(session?.probes).map(row=>row.probe_id),8),discovery_id:scalar(session?.discovery?.discovery_id),
      candidate_count:list(session?.discovery?.candidates).length,library_count:lut.length,
      libraries:lut.slice(0,4).map(row=>{const value=row.projection||row;return {probe_id:scalar(row.probe_id),library_id:hash(value.library_id),status:scalar(value.status),scan_required:typeof value.scan_required==='boolean'?value.scan_required:null,missing_codes:codes(value.missing)};})},
    pdk_scope:scope?{selection_id:hash(scope.selection_id),library_id:hash(scope.library_id),entry_id:hash(scope.entry_id),probe_id:scalar(scope.probe_id),status:scalar(scope.status),section_count:list(scope.section_ids).length,section_ids:strings(scope.section_ids,16),missing_codes:codes(scope.missing),ready_to_run:scope.ready_to_run===true}:null,
    testbench:{present:!!draft,draft_id:hash(draft?.draft_id),status:scalar(draft?.status),source_sha256:hash(draft?.source_sha256),testbench_sha256:hash(draft?.testbench_sha256),manifest_sha256:hash(draft?.manifest_sha256),
      local_changes:editor.dirty===true,conflict:editor.conflict===true,local_text_included:false},
    run:null,
  };
  if(kind==='diagnosis'){
    const run=state.run?.result,saved=session?.job;
    if(!valid||!run||!saved||!scalar(run.run_id)||!commit(run.source_commit)||run.source_commit!==session.source_commit||
      [...identityKeys,'job_id','plan_id'].some(key=>run[key]!==saved[key]))throw Error('当前实验没有身份一致的运行回执，请先读取此实验的原任务。');
    context.run=runSummary(run);
  }
  const target=valid?`当前实验 ${binding.intake_id}（revision ${binding.revision}）`:'当前尚未绑定 intake 的输入';
  const task=kind==='environment'?'帮我检查环境与 PDK 的现有观察、绑定缺口，并提出下一步配置建议。':kind==='testbench'?'帮我编写或修改适合当前电路的 Spectre 测试平台、激励、分析目标与判据。':'帮我诊断下方精确运行的状态、结果和已记录问题，区分执行、数据与科学验收。';
  const guard=valid?'请先按下方身份读取当前实验；不要替换为其他实验或最新运行。':'目前没有 intake 身份，请先说明需要导入和绑定哪些输入，不要引用其他实验。';
  return request(kind,`${task}\n对象：${target}。${guard}\n如果存在未保存草稿或连接不匹配，请先说明并保留当前内容。先给出建议；提交、重跑和人工审阅继续遵守原流程。`,context);
}

export function runtimeAgentAssistance(state,identity){
  const snapshot=state.snapshot;
  if(!snapshot||snapshot.project_id!==state.projectId||identity.project_id!==state.projectId)throw Error('当前项目已变化，请重新选择要诊断的运行。');
  const run=snapshot.runs.find(row=>row.run_id===identity.run_id&&row.source_commit===identity.source_commit&&row.configuration===identity.configuration);
  if(!run)throw Error('此运行的身份已变化，请刷新后重新选择，不会替换为其他运行。');
  const context={schema:'ic.simulation.agent-assistance.v1',origin:'runtime',
    snapshot:{project_id:state.projectId,read_at:scalar(snapshot.read_at),status:scalar(state.status),cached_observation:true},
    run:runSummary({...run,project_id:state.projectId})};
  return request('diagnosis',`请帮我诊断当前选中的运行 ${run.run_id}，根据保存的运行与验收记录区分执行状态、数据有效性和科学验收。请严格使用下方项目、源码与配置身份；源码身份未记录时先核对，不要替换为其他运行。先给出建议，提交或重跑继续遵守原流程。`,context);
}
