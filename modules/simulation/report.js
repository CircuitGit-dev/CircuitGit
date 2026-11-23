// Display only backend verdicts. Exit codes, diagnostic strings and warning counts
// are evidence; none are a substitute for a scoped scientific verdict.
const dimensions = [
  {key:'execution_status',label:'执行完成',states:{queued:'排队',running:'执行中',completed:'执行完成',failed:'执行失败',cancelled:'已取消',unknown:'未知'}},
  {key:'measurement_validity',label:'波形与数据',states:{valid:'有效',invalid:'无效',unknown:'未知'}},
  {key:'functional_performance',label:'功能与性能',states:{pass:'通过',fail:'未通过',unknown:'未知'}},
  {key:'operating_qualification',label:'SOA 工作条件',states:{passed_within_scope:'所检范围内符合',violations_detected:'发现超限',unknown:'未知'}},
  {key:'dependency_provenance',label:'PDK 与动态库',states:{verified_within_scope:'所检范围内已核验',incomplete:'证据不完整',mismatch:'不一致',unknown:'未知'}},
];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=()=>{throw Error('仿真验收报告的格式或运行身份不符。');};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const only=(value,keys)=>Object.keys(value).every(key=>keys.includes(key));
const sources={execution_receipt:'执行回执',acceptance:'验收记录',spectre_log:'Spectre 日志',qualification_scope:'工作条件检查范围',dependency_audit:'依赖核查'};
const checks={soa_voltage:'电压 SOA',soa_current:'电流 SOA',model_parameter_range:'模型参数范围',model_bin:'模型分档',scale_override:'尺寸缩放覆盖'};
const kinds={caller_execution_receipt:'执行回执',caller_summary:'已提供的验收摘要',caller_measurements:'已提供的测量记录',declared_operating_checks:'声明的工作条件检查',declared_dependency_inventory:'声明的依赖清单'};
const evidenceLabels={unregistered_runtime_tmi_library:'TMI 未在运行前登记',pre_pinned_dependency_verified:'运行前已固定的依赖核验一致',dependency_hash_mismatch:'依赖哈希不一致',dependency_hash_unverified:'依赖哈希尚未核验',dependency_audit_missing:'尚无依赖核查记录',suppressed_warning_coverage_gap:'被抑制警告造成证据缺口',complete_log_not_declared:'未声明完整日志覆盖',frozen_qualification_scope_missing:'缺少运行前固定的检查范围'};
function validateScope(scope){
  if(!object(scope)||typeof scope.kind!=='string'||scope.kind.length>100||!only(scope,['kind','scope_id','manifest_sha256','frozen_before_execution','checks','log_complete','run_bound','inventory_complete']))fail();
  if(scope.scope_id!==undefined&&scope.scope_id!==null&&!id(scope.scope_id))fail();
  if(scope.manifest_sha256!==undefined&&scope.manifest_sha256!==null&&!sha(scope.manifest_sha256))fail();
  for(const key of ['frozen_before_execution','log_complete','run_bound','inventory_complete'])if(scope[key]!==undefined&&typeof scope[key]!=='boolean')fail();
  if(scope.checks!==undefined&&(!Array.isArray(scope.checks)||scope.checks.length>5||new Set(scope.checks).size!==scope.checks.length||!scope.checks.every(key=>Object.hasOwn(checks,key))))fail();
}
function validateEvidence(evidence){
  if(!object(evidence)||!only(evidence,['code','source','line_numbers','dependency_id','sha256','count'])||!id(evidence.code)||!Object.hasOwn(sources,evidence.source)||!Array.isArray(evidence.line_numbers)||evidence.line_numbers.length>8||!evidence.line_numbers.every(line=>Number.isSafeInteger(line)&&line>=1&&line<=2048))fail();
  if(evidence.dependency_id!==undefined&&!id(evidence.dependency_id))fail();
  if(evidence.sha256!==undefined&&!sha(evidence.sha256))fail();
  if(evidence.count!==undefined&&(!Number.isSafeInteger(evidence.count)||evidence.count<0||evidence.count>999999999999999))fail();
}
const positive=new Set(['completed','valid','pass','passed_within_scope','verified_within_scope']);
const negative=new Set(['failed','invalid','fail','violations_detected','mismatch']);

export function simulationReportView(report,runId){
  if(report===undefined||report===null)return {available:false,runId:null,dimensions:dimensions.map(d=>({...d,status:'unknown',value:'未知',tone:'unknown',scope:null,evidence:[]}))};
  if(!object(report)||report.schema!=='spiceowl.simulation-report.v1'||report.advisory_only!==true||!object(report.diagnostics)
    ||!only(report,['schema','run_id','advisory_only','diagnostics',...dimensions.map(d=>d.key)])
    ||!(report.run_id===null||id(report.run_id)&&report.run_id===runId))fail();
  const rows=dimensions.map(d=>{
    const value=report[d.key];
    if(!object(value)||!only(value,['status','scope','evidence'])||!Object.hasOwn(d.states,value.status)||!Array.isArray(value.evidence)||value.evidence.length<1||value.evidence.length>258)fail();
    validateScope(value.scope);value.evidence.forEach(validateEvidence);
    return {key:d.key,label:d.label,status:value.status,value:d.states[value.status],
      tone:positive.has(value.status)?'positive':negative.has(value.status)?'negative':value.status==='unknown'?'unknown':'pending',
      scope:value.scope,evidence:value.evidence};
  });
  return {available:true,runId:report.run_id,dimensions:rows};
}

// detail is supplied by the host renderer so disclosure state survives its polling.
export function appendSimulationReport(parent,{report,runId,detail}){
  const view=simulationReportView(report,runId),doc=parent.ownerDocument;
  function el(tag,text,className){const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
  const table=el('dl',undefined,'ic-runtime-acceptance ic-runtime-report');
  table.setAttribute('aria-label','五项独立验收结论');
  for(const row of view.dimensions){
    const label=el('dt',row.label),value=el('dd');
    value.dataset.reportDimension=row.key;value.dataset.reportStatus=row.status;
    value.append(el('span',row.value,'ic-report-status '+row.tone));table.append(label,value);
  }
  parent.append(table);
  if(!view.available){parent.append(el('p','尚无五维验收报告。','ic-sim-note'));return view;}
  const warnings=report.diagnostics.observed_context?.warning_summary;
  if(object(warnings)){
    const count=value=>Number.isSafeInteger(value)&&value>=0?value.toLocaleString('en-US'):'未知';
    const summary=el('p',`日志报告警告：${count(warnings.reported_warnings)} · 被抑制警告：${count(warnings.suppressed_warnings)}`,'ic-sim-note');
    summary.dataset.reportWarnings='';parent.append(summary);
    if(warnings.count_conflict===true)parent.append(el('p','警告计数存在冲突，详见日志证据。','ic-sim-warning'));
  }
  const evidence=detail(parent,'report-'+runId,'验收依据与适用范围');
  if(view.runId===null)evidence.append(el('p','报告未提供运行标识。','ic-sim-note'));
  for(const row of view.dimensions){
    const section=el('section',undefined,'ic-report-evidence');section.dataset.reportEvidence=row.key;
    section.append(el('h4',row.label+' · '+row.value));
    const scope=el('dl',undefined,'ic-report-scope');
    const add=(label,value)=>scope.append(el('dt',label),el('dd',value));
    add('范围',kinds[row.scope.kind]||row.scope.kind||'未记录');
    if(row.scope.scope_id!==undefined)add('范围标识',row.scope.scope_id||'未记录');
    if(row.scope.checks!==undefined)add('检查项',row.scope.checks.map(key=>checks[key]).join('、')||'未声明');
    for(const [key,label]of [['frozen_before_execution','运行前已固定'],['log_complete','日志覆盖完整'],['run_bound','已绑定运行'],['inventory_complete','依赖清单完整']])if(row.scope[key]!==undefined)add(label,row.scope[key]?'是':'否');
    if(row.scope.manifest_sha256!==undefined)add('范围 SHA-256',row.scope.manifest_sha256||'未记录');
    section.append(scope);
    const list=el('ul',undefined,'ic-report-evidence-list');
    for(const item of row.evidence){
      const line=el('li');line.append(el('code',evidenceLabels[item.code]||item.code));
      if(evidenceLabels[item.code])line.title=item.code;
      line.append(el('span',sources[item.source]+(item.line_numbers.length?' · 行 '+item.line_numbers.join(', '):'')));
      if(item.dependency_id!==undefined)line.append(el('span','依赖：'+item.dependency_id));
      if(item.sha256!==undefined)line.append(el('span','SHA-256：'+item.sha256));
      if(item.count!==undefined)line.append(el('span','记录计数：'+item.count.toLocaleString('en-US')));
      list.append(line);
    }
    section.append(list);
    evidence.append(section);
  }
  return view;
}
