import {ANALYSIS_OPERATIONS,appendAnalysisResult} from './analysis.js';
import {parseEnvironmentJson} from './json.js';

const definitions={
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
  let binding=null,operation='spec_analyze',backend='',inputs={},parameters='{}',criteria='';
  return function append(parent,controller){
    const state=controller.state,session=state.session,job=session?.job;if(!job)return;
    const next=JSON.stringify([session.connection_id,session.intake_id,session.source_sha256,job.job_id,job.source_commit,job.waveforms]);
    if(next!==binding){binding=next;inputs={};parameters='{}';criteria='';}
    const doc=parent.ownerDocument,el=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
    const button=(label,action,disabled=false)=>{const node=el('button',label);node.type='button';node.disabled=disabled;node.addEventListener('click',()=>{try{Promise.resolve(action()).catch(onError);}catch(error){onError(error);}});return node;};
    const note=(target,text,warning=false)=>target.append(el('p',text,warning?'ic-sim-warning':'ic-sim-note'));
    const box=el('section',undefined,'ic-env-analysis');box.dataset.analysisPanel='';box.append(el('h3','原始数据分析'));
    note(box,'选择已保存信号与算法；测量读取完整原始数据，绘图可缩减显示点。');
    const available=job.waveforms?.available===true&&job.waveforms.source_binding_verified===true;
    box.append(button(state.analysisCatalog.status==='loading'?'读取中…':'读取此任务信号',()=>controller.readAnalysisCatalog(),controller.locked||!available||!controller.has('waveformApi')));
    if(!available)note(box,'此任务尚无经过来源核对的波形数据。');
    if(state.analysisCatalog.error)note(box,state.analysisCatalog.error,true);
    const signals=(state.analysisCatalog.result?.signals||[]).filter(row=>row.status==='available');
    if(signals.length){
      const field=(label,key,options,value,changed)=>{const row=el('label',undefined,'ic-sim-field');row.append(el('span',label));const select=el('select');select.dataset.environmentField='analysis-'+key;select.disabled=controller.locked;for(const option of options){const node=el('option',option.label);node.value=option.value;select.append(node);}select.value=value||'';select.addEventListener('change',()=>{changed(select.value);render();});row.append(select);box.append(row);return select;};
      field('分析算法','operation',ANALYSIS_OPERATIONS.map(value=>({value,label:definitions[value].label+' · '+value})),operation,value=>{operation=value;inputs={};parameters='{}';criteria='';});
      field('算法后端','backend',[{value:'',label:'选择算法后端'},{value:'spiceowl',label:'SpiceOwl'},{value:'adctoolbox',label:'ADC Toolbox'}],backend,value=>backend=value);
      const options=[{value:'',label:'选择此任务中的信号'},...signals.map(row=>({value:row.id,label:(row.label||row.id)+' · '+(row.unit||'未知单位')}))];
      for(const [name,label,kind]of definitions[operation].inputs){
        if(kind==='multiple'){
          const selected=inputs[name]||[],group=el('fieldset',undefined,'ic-env-analysis-signals');group.append(el('legend',label));
          note(group,'点击顺序就是算法列顺序；取消再选择可调整位序。');
          for(const signal of signals){const row=el('label',undefined,'ic-env-choice'),input=el('input');input.type='checkbox';input.checked=selected.includes(signal.id);input.disabled=controller.locked;input.dataset.analysisInput=name;input.dataset.signalId=signal.id;input.addEventListener('change',()=>{inputs[name]=input.checked?[...selected,signal.id]:selected.filter(id=>id!==signal.id);render();});row.append(input,doc.createTextNode((signal.label||signal.id)+' · '+(signal.unit||'未知单位')+(selected.includes(signal.id)?' · 第 '+(selected.indexOf(signal.id)+1)+' 列':'')));group.append(row);}box.append(group);
        }else field(label,'input-'+name,options,inputs[name],value=>{if(value)inputs[name]=value;else delete inputs[name];});
      }
      const detail=el('details',undefined,'ic-sim-detail');detail.dataset.environmentDetail='analysis-options';detail.open=opened.has('analysis-options');detail.append(el('summary','算法参数与测量判据'));detail.addEventListener('toggle',()=>{if(detail.isConnected)detail.open?opened.add('analysis-options'):opened.delete('analysis-options');});
      const json=(label,key,value,changed)=>{const row=el('label',undefined,'ic-env-code-field'),area=el('textarea');row.append(el('span',label));area.rows=5;area.value=value;area.spellcheck=false;area.disabled=controller.locked;area.dataset.environmentField='analysis-'+key;area.addEventListener('input',()=>changed(area.value));row.append(area);detail.append(row);};
      json('算法参数 JSON','parameters',parameters,value=>parameters=value);note(detail,'例如采样率、目标频率或 settling band。信号通过上方选择；后端由单独选项指定。');
      json('判据 JSON（可选数组）','criteria',criteria,value=>criteria=value);note(detail,'留空使用该任务冻结的判据；探索性分析可填写 metric、op、threshold 与 unit。');box.append(detail);
      box.append(button(state.analysis.status==='loading'?'分析中…':'分析原始数据',()=>{
        const selected=Object.fromEntries(Object.entries(inputs).filter(([,value])=>!Array.isArray(value)||value.length));
        const options=parseEnvironmentJson(parameters,{maxBytes:65536});if(Object.hasOwn(options,'backend'))throw Error('请通过算法后端选项选择 backend。');options.backend=backend;
        if(['spec_analyze','coherent_fft'].includes(operation)&&!Object.hasOwn(options,'return_spectrum'))options.return_spectrum=true;
        const value=criteria.trim()?parseEnvironmentJson(criteria,{objectOnly:false,maxBytes:65536}):undefined;if(value!==undefined&&!Array.isArray(value))throw Error('测量判据必须为 JSON 数组。');
        return controller.analyze({operation,inputs:selected,parameters:options,...(value===undefined?{}:{criteria:value})});
      },controller.locked||!backend||!Object.keys(inputs).some(key=>Array.isArray(inputs[key])?inputs[key].length:inputs[key])||!controller.has('analyzeExperiment')));
    }
    if(state.analysis.error)note(box,state.analysis.error,true);
    if(state.analysis.result)try{appendAnalysisResult(box,state.analysis.result,session);}catch(error){note(box,error.message,true);}
    parent.append(box);
  };
}
