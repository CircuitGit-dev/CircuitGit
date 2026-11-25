import {ANALYSIS_OPERATIONS,appendAnalysisResult} from './analysis.js';
import {appendOperatingPoints} from './spectrum.js';
import {parseEnvironmentJson} from './json.js';

const definitions={
  ac_metrics:{label:'AC 幅相与增益',inputs:[['response','保存的复数响应'],['reference','同频率轴复数参考（可选）']]},
  dc_op_metrics:{label:'DC 工作点',inputs:[['devices','保存器件（选择即明确验收范围）','multiple']]},
  spec_analyze:{label:'频谱与动态指标',inputs:[['samples','输入信号']]},
  coherent_fft:{label:'相干 FFT',inputs:[['samples','输入信号']]},
  sine_fit3:{label:'三参数正弦拟合',inputs:[['samples','输入信号']]},
  sine_fit4:{label:'四参数正弦拟合',inputs:[['samples','输入信号']]},
  weight_calibrate:{label:'权重校准',inputs:[['decisions','判决信号（按位次序）','multiple'],['reference','参考信号'],['validation_decisions','验证判决信号（可选）','multiple'],['validation_reference','验证参考信号（可选）']]},
  reconstruct_codes:{label:'码字重建',inputs:[['decisions','判决信号（按位次序）','multiple']]},
  histogram_linearity:{label:'直方图线性度',inputs:[['codes','码字信号']]},
  tran_metrics:{label:'瞬态指标',inputs:[['values','输出信号'],['reference','参考信号（可选）'],['current','电流（可选）'],['voltage','电压（可选）']]},
};

// Local form state survives rendering, but can never carry signal selections to
// another archived dataset. Analysis uses named backend operations, not scripts.
export function createAnalysisPanel({render,opened,onError}){
  let binding=null,operation='spec_analyze',backend='',inputs={},parameters='{}',criteria='',datasetId='',responseKind='',feedback='',phaseReference='';
  return function append(parent,controller){
    const state=controller.state,session=state.session,job=session?.job;if(!job)return;
    const next=JSON.stringify([session.connection_id,session.intake_id,session.source_sha256,job.job_id,job.source_commit,job.waveforms]);
    if(next!==binding){binding=next;inputs={};parameters='{}';criteria='';datasetId='';responseKind='';feedback='';phaseReference='';}
    const doc=parent.ownerDocument,el=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
    const button=(label,action,disabled=false)=>{const node=el('button',label);node.type='button';node.disabled=disabled;node.addEventListener('click',()=>{try{Promise.resolve(action()).catch(onError);}catch(error){onError(error);}});return node;};
    const note=(target,text,warning=false)=>target.append(el('p',text,warning?'ic-sim-warning':'ic-sim-note'));
    const box=el('section',undefined,'ic-env-analysis');box.dataset.analysisPanel='';box.append(el('h3','原始数据分析'));
    note(box,'选择已保存信号与算法；测量读取完整原始数据，绘图可缩减显示点。');
    const available=job.waveforms?.available===true&&job.waveforms.source_binding_verified===true;
    box.append(button(state.analysisCatalog.status==='loading'?'读取中…':'读取此任务信号',()=>controller.readAnalysisCatalog(datasetId?{dataset_id:datasetId}:{}),controller.locked||!available||!controller.has('waveformApi')));
    if(!available)note(box,'此任务尚无经过来源核对的波形数据。');
    if(state.analysisCatalog.error)note(box,state.analysisCatalog.error,true);
    const catalog=state.analysisCatalog.result,selectedCatalog=catalog&&(catalog.dataset_id||'')===datasetId?catalog:null;
    const signals=(selectedCatalog?.signals||[]).filter(row=>row.status==='available'),devices=selectedCatalog?.operating_points||[];
    const field=(label,key,options,value,changed)=>{const row=el('label',undefined,'ic-sim-field');row.append(el('span',label));const select=el('select');select.dataset.environmentField='analysis-'+key;select.disabled=controller.locked;for(const option of options){const node=el('option',option.label);node.value=option.value;select.append(node);}select.value=value||'';select.addEventListener('change',()=>{changed(select.value);render();});row.append(select);box.append(row);return select;};
    const datasets=job.waveforms?.datasets||[];
    if(datasets.length)field('保存数据集','dataset',[{value:'',label:job.waveforms.csv_sha256?'瞬态 · 原始 CSV':'选择保存的分析数据集'},...datasets.map(row=>({value:row.dataset_id,label:row.analysis.name+' · '+row.analysis.kind}))],datasetId,value=>{datasetId=value;inputs={};parameters='{}';criteria='';responseKind='';feedback='';phaseReference='';if(value||job.waveforms.csv_sha256)Promise.resolve(controller.readAnalysisCatalog(value?{dataset_id:value}:{})).catch(onError);});
    if(devices.length)try{appendOperatingPoints(box,devices);}catch(error){note(box,error.message,true);}
    const kind=selectedCatalog?.analysis_kind;
    const operations=kind==='ac'?['ac_metrics']:devices.length&&selectedCatalog?.axis===null?['dc_op_metrics']:datasetId?[]:ANALYSIS_OPERATIONS.filter(name=>!['ac_metrics','dc_op_metrics'].includes(name));
    if(datasetId&&selectedCatalog&&!operations.length)note(box,'此保存的 DC sweep 可在波形窗口查看；工作点指标需要独立的无扫描 DC 工作点数据集。');
    if(operations.length&&(signals.length||devices.length)){
      if(!operations.includes(operation)){operation=operations[0];inputs={};parameters='{}';}
      field('分析算法','operation',operations.map(value=>({value,label:definitions[value].label+' · '+value})),operation,value=>{operation=value;inputs={};parameters='{}';criteria='';});
      field('算法后端','backend',[{value:'',label:'选择算法后端'},{value:'spiceowl',label:'SpiceOwl'},...(!datasetId?[{value:'adctoolbox',label:'ADC Toolbox'}]:[])],backend,value=>backend=value);
      if(datasetId&&backend==='adctoolbox')backend='';
      if(operation==='ac_metrics'){field('响应语义','response-kind',[{value:'',label:'明确选择响应语义'},{value:'transfer',label:'传递响应（不推断稳定性）'},{value:'loop_gain',label:'已确认的环路增益'}],responseKind,value=>responseKind=value);if(responseKind==='loop_gain'){field('反馈分母约定','feedback',[{value:'',label:'明确选择反馈约定'},{value:'denominator_1_plus_L',label:'1 + L'},{value:'denominator_1_minus_T',label:'1 − T'}],feedback,value=>feedback=value);const row=el('label',undefined,'ic-sim-field'),input=el('input');input.type='number';input.step='any';input.value=phaseReference;input.disabled=controller.locked;input.dataset.environmentField='analysis-phase-reference';input.addEventListener('input',()=>phaseReference=input.value);row.append(el('span','低频相位参考 / deg（明确约定）'),input);box.append(row);}note(box,'频率使用原数据的 Hz 轴；输入单位来自保存记录。参考为空时保持响应本身的量纲，不假设激励为 1。');}
      const options=[{value:'',label:'选择此任务中的信号'},...signals.map(row=>({value:row.id,label:(row.label||row.id)+' · '+(row.unit||'未知单位')}))];
      for(const [name,label,kind]of definitions[operation].inputs){
        if(kind==='multiple'){
          const selected=inputs[name]||[],group=el('fieldset',undefined,'ic-env-analysis-signals');group.append(el('legend',label));
          note(group,name==='devices'?'仅所选保存器件进入判定范围；模型契约须引用这些器件 ID。':'点击顺序就是算法列顺序；取消再选择可调整位序。');
          for(const signal of (name==='devices'?devices:signals)){const row=el('label',undefined,'ic-env-choice'),input=el('input');input.type='checkbox';input.checked=selected.includes(signal.id);input.disabled=controller.locked;input.dataset.analysisInput=name;input.dataset.signalId=signal.id;input.addEventListener('change',()=>{inputs[name]=input.checked?[...selected,signal.id]:selected.filter(id=>id!==signal.id);render();});row.append(input,doc.createTextNode((signal.label||signal.name||signal.id)+' · '+(name==='devices'?signal.id:signal.unit||'未知单位')+(name!=='devices'&&selected.includes(signal.id)?' · 第 '+(selected.indexOf(signal.id)+1)+' 列':'')));group.append(row);}box.append(group);
        }else field(label,'input-'+name,options,inputs[name],value=>{if(value)inputs[name]=value;else delete inputs[name];});
      }
      const quickParams={spec_analyze:[['fs_hz','采样率 fs (Hz)','例如 1e9'],['f_in_hz','输入频率 fin (Hz)','可选']],coherent_fft:[['fs_hz','采样率 fs (Hz)','例如 1e9'],['n_fft','FFT 点数','可选']],sine_fit3:[['fs_hz','采样率 fs (Hz)','例如 1e9'],['f_in_hz','输入频率 fin (Hz)','例如 1e6']],sine_fit4:[['fs_hz','采样率 fs (Hz)','例如 1e9']],tran_metrics:[['settling_band_pct','建立误差带 (%)','例如 1']]}[operation]||[];
      if(quickParams.length){
        let parsedQuick={};try{parsedQuick=parseEnvironmentJson(parameters,{maxBytes:65536});}catch{parsedQuick={};}
        for(const [paramKey,paramLabel,placeholder] of quickParams){
          const row=el('label',undefined,'ic-sim-field'),input=el('input');input.type='number';input.step='any';input.placeholder=placeholder;input.disabled=controller.locked;
          input.value=parsedQuick[paramKey]??'';input.dataset.environmentField='analysis-quick-'+paramKey;
          input.addEventListener('change',()=>{try{const next=parseEnvironmentJson(parameters,{maxBytes:65536});const raw=input.value.trim();if(raw==='')delete next[paramKey];else{const num=Number(raw);if(!Number.isFinite(num))throw Error(paramLabel+' 需为有限数值。');next[paramKey]=num;}parameters=JSON.stringify(next,null,2);render();}catch(error){onError(error);}});
          row.append(el('span',paramLabel),input);box.append(row);
        }
      }
      const detail=el('details',undefined,'ic-sim-detail');detail.dataset.environmentDetail='analysis-options';detail.open=opened.has('analysis-options');detail.append(el('summary','算法参数与测量判据'));detail.addEventListener('toggle',()=>{if(detail.isConnected)detail.open?opened.add('analysis-options'):opened.delete('analysis-options');});
      const json=(label,key,value,changed)=>{const row=el('label',undefined,'ic-env-code-field'),area=el('textarea');row.append(el('span',label));area.rows=5;area.value=value;area.spellcheck=false;area.disabled=controller.locked;area.dataset.environmentField='analysis-'+key;area.addEventListener('input',()=>changed(area.value));row.append(area);detail.append(row);};
      json('算法参数 JSON','parameters',parameters,value=>parameters=value);note(detail,'例如采样率、目标频率或 settling band。信号通过上方选择；后端由单独选项指定。DC 的 device_contracts 以已选器件 ID 为键，须明确提供模型 region 映射或 Vdsat 电压约定；缺失时保持 unknown。');
      json('判据 JSON（可选数组）','criteria',criteria,value=>criteria=value);note(detail,'留空使用该任务冻结的判据；探索性分析可填写 metric、op、threshold 与 unit。');box.append(detail);
      box.append(button(state.analysis.status==='loading'?'分析中…':'分析原始数据',()=>{
        const selected=Object.fromEntries(Object.entries(inputs).filter(([,value])=>!Array.isArray(value)||value.length));
        const options=parseEnvironmentJson(parameters,{maxBytes:65536});if(Object.hasOwn(options,'backend'))throw Error('请通过算法后端选项选择 backend。');options.backend=backend;
        if(operation==='ac_metrics'){if(!responseKind)throw Error('请明确选择响应语义。');options.response_kind=responseKind;options.return_curves=true;if(responseKind==='loop_gain'){if(!feedback||phaseReference.trim()===''||!Number.isFinite(Number(phaseReference)))throw Error('环路增益需要明确反馈约定和相位参考。');options.feedback_convention=feedback;options.phase_reference_deg=Number(phaseReference);}}
        if(['spec_analyze','coherent_fft'].includes(operation)&&!Object.hasOwn(options,'return_spectrum'))options.return_spectrum=true;
        const value=criteria.trim()?parseEnvironmentJson(criteria,{objectOnly:false,maxBytes:65536}):undefined;if(value!==undefined&&!Array.isArray(value))throw Error('测量判据必须为 JSON 数组。');
        return controller.analyze({operation,inputs:selected,parameters:options,...(datasetId?{dataset_id:datasetId}:{}),...(value===undefined?{}:{criteria:value})});
      },controller.locked||!backend||!Object.keys(inputs).some(key=>Array.isArray(inputs[key])?inputs[key].length:inputs[key])||!controller.has('analyzeExperiment')));
    }
    if(state.analysis.error)note(box,state.analysis.error,true);
    if(state.analysis.result&&(state.analysis.result.request?.dataset_id||'')!==datasetId)note(box,'其他数据集的分析结果已保留；切回相应数据集后显示。');
    if(state.analysis.result&&(state.analysis.result.request?.dataset_id||'')===datasetId)try{appendAnalysisResult(box,state.analysis.result,session);}catch(error){note(box,error.message,true);}
    parent.append(box);
  };
}
