import {appendSpectrum,spectrumSeries,appendBode} from './spectrum.js';

export const ANALYSIS_OPERATIONS=Object.freeze(['spec_analyze','coherent_fft','sine_fit3','sine_fit4','weight_calibrate','reconstruct_codes','histogram_linearity','tran_metrics','ac_metrics','dc_op_metrics']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const reject=()=>{throw Error('分析结果的运行、原始数据或指标身份不完整；未显示为有效结果。');};

export function checkAnalysisResult(value,session){
  const job=session?.job,input=value?.input,result=value?.result;
  if(!job||!session||value?.schema!=='ic.onboarding.analysis.v1'||!sha(value.analysis_id)||value.intake_id!==session?.intake_id||
     value.job_id!==job?.job_id||value.run_id!==job.run_id||value.source_commit!==job.source_commit||
     value.original_source_sha256!==session.source_sha256||!sha(value.archive_sha256)||value.archive_sha256!==job.waveforms?.archive_sha256||
     job.waveforms.schema!=='ic.onboarding.waveform-descriptor.v1'||job.waveforms.available!==true||job.waveforms.source_binding_verified!==true||!Array.isArray(job.waveforms.available_signal_ids)||
     !object(input)||input.archive_sha256!==value.archive_sha256||!sha(input.raw_signature)||
     !sha(input.effective_config_sha256)||!object(input.source_hashes)||!Object.keys(input.source_hashes).length||
     Object.values(input.source_hashes).some(value=>!sha(value))||!Number.isSafeInteger(input.sample_count)||input.sample_count<1||
     input.full_resolution!==true||input.display_downsampling_used!==false||!text(input.data_basis)||
     !sha(value.request_sha256)||!ANALYSIS_OPERATIONS.includes(value.request?.operation)||
     result?.schema!=='spiceowl.adctools.result.v1'||result.operation!==value.request.operation||result.algorithm_version!=='1.0.0'||
     !text(result.backend)||!text(result.backend_version)||!['valid','invalid'].includes(result.status)||
     !object(result.metrics)||Object.keys(result.metrics).length>256||!Array.isArray(result.warnings)||result.warnings.some(w=>!text(w))||
     !['exploratory','reviewed'].includes(value.evaluation_scope)||!object(value.evaluation)||!Array.isArray(value.evaluation.criteria)||
     result.specification_result!=='not_evaluated'||!['pass','fail','not_evaluated'].includes(value.evaluation.specification_result)||
     value.changes_original_job_verdict!==false||value.network_operations!==0||value.solver_invocations!==0||
     !object(value.request.inputs)||!object(value.request.parameters)||!Array.isArray(value.request.criteria)||!object(input.selection))reject();
  const native=value.request.dataset_id!==undefined,dataset=native?job.waveforms.datasets?.find(row=>row.dataset_id===value.request.dataset_id):null;
  if(native){if(!dataset||input.dataset_id!==dataset.dataset_id||input.data_sha256!==dataset.data_sha256||input.data_format!=='native_psf_json'||input.analysis_id!==dataset.analysis?.name||input.analysis_kind!==dataset.analysis?.kind||input.native_member_sha256!==dataset.native_member?.sha256||!sha(input.data_sha256)||!['ac_metrics','dc_op_metrics'].includes(value.request.operation))reject();}
  else if(!sha(input.csv_sha256)||input.csv_sha256!==job.waveforms.csv_sha256||['ac_metrics','dc_op_metrics'].includes(value.request.operation))reject();
  for(const key of ['raw_signature','effective_config_sha256'])if(job.waveforms[key]&&input[key]!==job.waveforms[key])reject();
  if(job.waveforms.source_hashes&&canonical(input.source_hashes)!==canonical(job.waveforms.source_hashes))reject();
  const ids=new Set((native?dataset.available_signal_ids:job.waveforms.available_signal_ids)||[]),devices=new Set(dataset?.available_device_ids||[]);
  for(const [name,selector]of Object.entries(value.request.inputs)){
    const binding=input.selection[name];
    if(name==='time_s'){if(selector!=='@time'||binding?.axis!=='time'||binding.unit!=='s')reject();}
    else if(Array.isArray(selector)){const allowed=name==='devices'?devices:ids;if(!selector.length||new Set(selector).size!==selector.length||!Array.isArray(binding)||selector.length!==binding.length||selector.some((id,index)=>!allowed.has(id)||binding[index]?.id!==id||native&&binding[index]?.dataset_id!==dataset.dataset_id))reject();}
    else if(!ids.has(selector)||binding?.id!==selector||native&&binding?.dataset_id!==dataset.dataset_id)reject();
  }
  for(const [name,metric]of Object.entries(result.metrics))if(!text(name)||!object(metric)||!text(metric.unit)||
    !['valid','undefined'].includes(metric.status)||metric.status==='valid'&&!finite(metric.value)||metric.status==='undefined'&&metric.value!==null)reject();
  for(const row of value.evaluation.criteria)if(!object(row)||!text(row.metric)||!text(row.op)||!text(row.unit)||!finite(row.threshold)||
    row.value!==null&&!finite(row.value)||!['pass','fail','not_evaluated'].includes(row.verdict))reject();
  if(value.artifact&&(!sha(value.artifact.id)||value.artifact.id!==value.analysis_id||!sha(value.artifact.sha256)||
    value.artifact.format!=='application/json'||!Number.isSafeInteger(value.artifact.bytes)||value.artifact.bytes<1||value.artifact.full_result!==true))reject();
  if(result.spectrum){const spectrum=result.spectrum;if(spectrum.frequency_unit!=='Hz'||!text(spectrum.power_unit)||!Array.isArray(spectrum.power_db))reject();
    if(spectrum.display&&(!object(spectrum.display)||spectrum.display.decimated!==true||spectrum.display.measurement_uses_full_data!==true||
      !Number.isSafeInteger(spectrum.display.original_bins)||spectrum.display.original_bins<spectrum.frequency_hz?.length||spectrum.display.returned_bins!==spectrum.frequency_hz?.length||!text(spectrum.display.method)))reject();
    spectrumSeries({label:'FFT',frequencyUnit:'Hz',amplitudeUnit:spectrum.power_unit,frequency:spectrum.frequency_hz,amplitude:spectrum.power_db});}
  if(native&&result.operation==='ac_metrics'){if(input.selection.frequency_hz?.unit!=='Hz'||input.selection.frequency_hz.dataset_id!==dataset.dataset_id||input.selection.response?.value_kind!=='complex'||result.parameters?.response_kind!==value.request.parameters.response_kind||result.parameters?.response_unit!==input.selection.response.unit||result.parameters?.reference_unit!==(input.selection.reference?.unit??null))reject();}
  if(result.curves){const curves=result.curves;if(!native||value.request.operation!=='ac_metrics'||curves.frequency_unit!=='Hz'||curves.phase_unit!=='deg'||!text(curves.magnitude_unit)||!['transfer','loop_gain'].includes(result.parameters?.response_kind)||result.stability_verdict!=='not_evaluated')reject();for(const [key,unit]of [['magnitude_db',curves.magnitude_unit],['phase_deg','deg']])spectrumSeries({label:'AC',frequencyUnit:'Hz',amplitudeUnit:unit,frequency:curves.frequency_hz,amplitude:curves[key]});}
  return structuredClone(value);
}

export function appendAnalysisResult(parent,value,session){
  const analysis=checkAnalysisResult(value,session),doc=parent.ownerDocument;
  const el=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const box=el('section',undefined,'ic-env-analysis');box.dataset.analysisId=analysis.analysis_id;
  box.append(el('h3','分析结果 · '+analysis.result.operation));
  box.append(el('p',analysis.evaluation_scope==='reviewed'?'使用冻结审阅中的判据。':'探索性分析；独立展示，不修改原任务验收结论。','ic-sim-note'));
  box.append(el('p',`${analysis.input.sample_count} 个原始样本 · ${analysis.result.backend} ${analysis.result.backend_version} · 算法 ${analysis.result.algorithm_version}`,'ic-sim-note'));
  if(analysis.result.status==='invalid')box.append(el('p','后端报告此分析无效；请核对输入与分析条件。','ic-sim-warning'));
  const table=el('table',undefined,'ic-env-analysis-metrics'),head=el('tr');for(const name of ['指标','值','单位'])head.append(el('th',name));const body=el('tbody');
  for(const [name,metric]of Object.entries(analysis.result.metrics)){const row=el('tr');row.dataset.analysisMetric=name;row.append(el('th',name),el('td',metric.status==='valid'?String(metric.value):'未定义'),el('td',metric.unit));body.append(row);}const heading=el('thead');heading.append(head);table.append(heading,body);box.append(table);
  if(analysis.result.status==='valid'&&analysis.result.spectrum){appendSpectrum(box,{label:'FFT 功率谱',frequencyUnit:'Hz',amplitudeUnit:analysis.result.spectrum.power_unit,frequency:analysis.result.spectrum.frequency_hz,amplitude:analysis.result.spectrum.power_db,breakBeforeIndices:analysis.result.spectrum.display?.break_before_indices?.power_db||[]});
    if(analysis.result.spectrum.display)box.append(el('p',`后端从 ${analysis.result.spectrum.display.original_bins} 个频点中提取 ${analysis.result.spectrum.display.returned_bins} 个显示点；指标使用全部原始数据。`,'ic-sim-note'));}
  else if(['spec_analyze','coherent_fft'].includes(analysis.result.operation))box.append(el('p','未返回可绘制的频谱向量。','ic-sim-note'));
  if(analysis.result.curves)appendBode(box,{...analysis.result.curves,label:'AC 保存响应',response_kind:analysis.result.parameters.response_kind});
  if(analysis.result.operation==='ac_metrics'){box.append(el('p','DC gain 只使用实际保存的 0 Hz；低频增益按其原频率报告。环路裕度需要明确反馈约定；稳定性未评估。','ic-sim-note'));const crossings=el('details',undefined,'ic-sim-detail');crossings.append(el('summary','全部交越与反馈约定'),el('pre',JSON.stringify({unity_crossings:analysis.result.unity_crossings,phase_crossings:analysis.result.phase_crossings,feedback_convention:analysis.result.parameters?.feedback_convention,phase_reference_deg:analysis.result.parameters?.phase_reference_deg,stability_verdict:analysis.result.stability_verdict},null,2)));box.append(crossings);}
  if(analysis.result.operation==='dc_op_metrics'&&Array.isArray(analysis.result.devices)){const table=el('table'),head=el('tr');for(const title of ['器件','工作区编码','明确映射','饱和判定','依据'])head.append(el('th',title));table.append(head);for(const device of analysis.result.devices){const row=el('tr');for(const value of [device.name,device.region?.value??'unknown',device.region_label??'unknown',device.saturation_verdict,device.scope])row.append(el('td',String(value??'unknown')));table.append(row);}box.append(table,el('p','保存的器件数据与显式模型契约共同决定判定；未配置电源电压/电流来源时静态功率保持未定义。','ic-sim-note'));}
  const verdicts=el('div',undefined,'ic-env-analysis-criteria');verdicts.dataset.analysisCriteria='';
  const names={pass:'通过',fail:'未通过',not_evaluated:'未评估',unknown:'未知',inconclusive:'证据不足'};
  for(const row of analysis.evaluation.criteria)verdicts.append(el('p',`${row.metric} ${row.op} ${row.threshold} ${row.unit} · ${names[row.verdict]||'未识别状态：'+row.verdict}`));box.append(verdicts);
  if(analysis.result.warnings.length)box.append(el('p','分析提示：'+analysis.result.warnings.join(' · '),'ic-sim-warning'));
  const details=el('details',undefined,'ic-sim-detail');details.append(el('summary','原始数据与分析来源'),el('pre',JSON.stringify({analysis_id:analysis.analysis_id,job_id:analysis.job_id,source_commit:analysis.source_commit,original_source_sha256:analysis.original_source_sha256,archive_sha256:analysis.archive_sha256,input:analysis.input,request:analysis.request,request_sha256:analysis.request_sha256,artifact:analysis.artifact},null,2),'ic-sim-code'));box.append(details);parent.append(box);return box;
}
