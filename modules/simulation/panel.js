import {createController,parseConfiguration} from './model.js';
import {safeReceiptLink,fullCollection} from './receipts.js';
import {mountSupervision} from './supervision.js';
import {mountRuntime} from './runtime.js';

const ANALYSIS_FIELDS=[['stop','结束时间','s（n / p）'],['maxstep','最大步长','s（n / p）'],['errpreset','精度预设',''],['method','积分方法',''],['maxiters','迭代上限','次']];
const RUN_LABELS={queued:'排队中',preflight:'预检中',submitted:'已提交',running:'运行中',running_observed:'运行中（已观察）',collecting:'收集中',archiving:'归档中',archived:'已归档',collected:'已收集',simulator_complete_pending_measurements:'仿真结束 · 待测量',simulator_failed:'仿真失败',input_hash_failure:'输入校验失败',job_setup_failed:'任务准备失败',preflight_failed:'预检失败',unknown:'状态未知',reconcile_required:'待核对'};
const projectRuns=s=>s.runs.filter(run=>(run.associated_project_id||run.project_id)===s.projectId);
const has=(object,key)=>Object.prototype.hasOwnProperty.call(object||{},key);
const display=value=>value===undefined||value===null?'—':String(value);
function timeValue(seconds,fallback){
  if(typeof seconds!=='number'||!Number.isFinite(seconds))return display(fallback);
  const [scale,unit]=Math.abs(seconds)>=1?[1,'s']:Math.abs(seconds)>=1e-3?[1e3,'ms']:Math.abs(seconds)>=1e-6?[1e6,'µs']:Math.abs(seconds)>=1e-9?[1e9,'ns']:[1e12,'ps'];
  return `${Number((seconds*scale).toPrecision(5))} ${unit}`;
}
function observedTime(value){
  if(!value)return '未记录时间';
  const date=new Date(value);
  return Number.isNaN(date.getTime())?String(value):new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
}

export function mount(host) {
  const slot=host.slots.simulation,root=document.createElement('section');
  root.className='ic-sim-panel';root.setAttribute('aria-label','仿真配置与任务');slot.element.replaceChildren(root);
  const sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href=new URL('./style.css',import.meta.url).href;document.head.append(sheet);
  const supervisionRoot=document.createElement('section');
  const supervision=mountSupervision(supervisionRoot,{host});
  let controller=null,disposed=false,page='config',parameterQuery='',identity=null,targetKind='voltage',targetPath='',targetTerminal='';
  const runtimeRoot=document.createElement('section');
  const runtime=mountRuntime(runtimeRoot,{host,actions:{submit:()=>controller.runDirect(),collect:run=>controller.collectDirect(run.run_id)},
    actionPolicy:run=>({submit:typeof controller?.runDirect==='function'&&!!controller.state.descriptor&&!controller.state.busy&&!controller.receipts.busy&&!controller.state.contextBlocked&&!controller.state.suspended&&!controller.draftDirty()&&!controller.directSubmissionBlocked(),
      collect:typeof controller?.collectDirect==='function'&&!controller.state.busy&&!controller.receipts.busy&&!controller.state.contextBlocked&&!controller.state.suspended&&!!run&&controller.state.runs.some(row=>(row.run_id||row.job_id)===run.run_id&&row.source_commit===run.source_commit&&(row.associated_project_id||row.project_id)===controller.state.projectId)})});
  const opened=new Set(['analysis','parameters']);
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
  const call=fn=>()=>{Promise.resolve().then(fn).catch(error=>host.notify(error.message||String(error),{kind:'error'}));};
  const button=(text,fn,disabled=false,cls='')=>{const b=el('button',text,cls);b.type='button';b.disabled=disabled;b.addEventListener('click',call(fn));return b;};
  function note(parent,text,cls='ic-sim-note'){parent.append(el('p',text,cls));}
  function badge(text,kind=''){return el('span',text,'ic-sim-status'+(kind?' '+kind:''));}
  function field(parent,label,key,value,placeholder,onChange,{type='text',disabled=false,hint=''}={}) {
    const row=el('label',undefined,'ic-sim-field'),caption=el('span',label);row.append(caption);
    const input=el('input');input.type=type;input.value=value??'';input.placeholder=placeholder??'';input.dataset.field=key;input.disabled=disabled;
    if(type==='number')input.step='any';
    input.addEventListener('change',call(()=>onChange(input.value)));row.append(input);if(hint)row.append(el('small',hint));parent.append(row);return input;
  }
  function detail(parent,key,title,meta){
    const box=el('details',undefined,'ic-sim-detail');box.dataset.detail=key;box.open=opened.has(key);
    const summary=el('summary');summary.append(el('span',title));if(meta)summary.append(badge(meta));box.append(summary);
    box.addEventListener('toggle',()=>{if(box.isConnected)box.open?opened.add(key):opened.delete(key);});parent.append(box);return box;
  }
  function code(parent,text){const pre=el('pre',text??'未提供','ic-sim-code');parent.append(pre);return pre;}
  function select(parent,label,key,values,current,onChange,disabled=false) {
    const row=el('label',undefined,'ic-sim-field');row.append(el('span',label));const input=el('select');input.dataset.field=key;input.disabled=disabled;
    for(const [value,name] of values){const option=el('option',name);option.value=value;input.append(option);}input.value=current;
    input.addEventListener('change',call(()=>onChange(input.value)));row.append(input);parent.append(row);return input;
  }
  function section(parent,title,meta){const box=el('section',undefined,'ic-sim-card'),head=el('div',undefined,'ic-sim-section-head');head.append(el('h3',title));if(meta)head.append(badge(meta));box.append(head);parent.append(box);return box;}
  const signalText=s=>typeof s==='string'?s:s.kind==='current'?s.instance+':'+s.terminal:s.path||s.name||s.spectre||'未命名';
  function signalList(parent,signals,key){
    const list=el('ul',undefined,'ic-sim-signals');
    for(const signal of signals.slice(0,5))list.append(el('li',signalText(signal),'ic-sim-signal'));
    parent.append(list);
    if(signals.length>5){const more=detail(parent,key,'全部信号',String(signals.length));const all=el('ul',undefined,'ic-sim-signals');for(const signal of signals)all.append(el('li',signalText(signal),'ic-sim-signal'));more.append(all);}
    if(!signals.length)note(parent,'没有显式信号项。');
  }
  function readDraft(text){
    const conf=parseConfiguration(text);
    for(const key of ['parameters','analysis','simulator','save','postprocess'])if(conf[key]!==undefined&&!(key==='postprocess'&&conf[key]===null)&&(!conf[key]||Array.isArray(conf[key])||typeof conf[key]!=='object'))throw Error(key+' 必须是对象；请在完整 JSON 中修正。');
    if(conf.postprocess?.signals!==undefined&&!Array.isArray(conf.postprocess.signals))throw Error('postprocess.signals 必须是数组。');
    if(conf.postprocess?.signals?.some(x=>typeof x!=='string'&&(!x||Array.isArray(x)||typeof x!=='object')))throw Error('postprocess 信号必须是名称或对象。');
    if(conf.save?.signals!==undefined&&(!Array.isArray(conf.save.signals)||conf.save.signals.some(x=>!x||Array.isArray(x)||typeof x!=='object')))throw Error('save 信号必须是结构化对象数组。');
    return conf;
  }
  function showPage(next){page=next;render();}
  function render() {
    if(disposed||!controller)return;
    const s=controller.state,active=root.contains(document.activeElement)?document.activeElement:null;
    const focus=active?.dataset.field,selection=active&&['INPUT','TEXTAREA'].includes(active.tagName)?[active.selectionStart,active.selectionEnd]:null;
    // Native toggle events are queued; capture disclosure state before replacing DOM.
    for(const box of root.querySelectorAll('[data-detail]'))box.open?opened.add(box.dataset.detail):opened.delete(box.dataset.detail);
    const key=JSON.stringify([s.projectId,s.configurationId,s.sourceCommit]);
    if(identity!==key){identity=key;parameterQuery='';targetPath='';targetTerminal='';}
    root.replaceChildren();
    const dirty=controller.draftDirty(),blocked=!!s.busy||controller.receipts.busy||s.contextBlocked||s.suspended;
    const head=el('header',undefined,'ic-sim-heading');
    head.append(el('h2','仿真'),badge(s.busy||(s.suspended?'操作已暂停':s.contextBlocked?'等待配置身份':dirty?'未保存草稿':'已保存配置'),s.busy?'active':dirty?'draft':''));root.append(head);
    const selector=el('div',undefined,'ic-sim-config-selector');
    select(selector,'配置','configuration',s.configurations.map(c=>[c.id,c.name||c.id]),s.configurationId||'',id=>controller.chooseConfiguration(id),!!s.busy||controller.receipts.busy);
    const reload=button('重新读取',()=>controller.reload(),!!s.busy||controller.receipts.busy,'ic-sim-quiet');selector.append(reload);root.append(selector);
    note(root,s.projectId||'未选择项目','ic-sim-project');
    if(s.saveAttempt?.status==='unknown')note(root,'上次保存或推送结果未知，可能已产生提交。请核对回执；当前禁止重复保存。','ic-sim-error');
    if(s.error)note(root,s.error+' 后续写操作已停止；请核对后重新读取。','ic-sim-error');
    if(s.directStorageError)note(root,'直接提交已暂停：'+s.directStorageError,'ic-sim-warning');
    if(s.directPending){
      const pending=section(root,'原提交结果待核对');pending.dataset.role='direct-pending';
      note(pending,'此版本已有未确认提交，原键已保留。查询只读取保存的映射；未找到记录也不会重新提交。');
      pending.append(button('只读核对原提交',()=>controller.lookupDirect(),!!s.busy||controller.receipts.busy||s.contextBlocked||!s.descriptor));
      if(s.directLookup?.found===false)note(pending,'暂未找到原提交映射；请保留原键，继续核对网关记录。','ic-sim-warning');
    }else if(s.directLookup?.found)note(root,'已找到原任务 '+s.directLookup.run_id+'，可以查看状态和收集结果。');
    if(s.contextBlocked)note(root,'项目正在加载、版本未对齐或源文件有未保存修改。配置操作已暂停。','ic-sim-note');
    if(s.saveReceipt)note(root,`${s.saveReceipt.configurationId} · `+(s.saveReceipt.pushStatus==='confirmed'?'配置提交与推送已确认。':s.saveReceipt.pushStatus==='not_requested'?'配置提交已确认，未请求推送。':'保存回执已返回，请在提交页核对。'),'ic-sim-note');
    const nav=el('nav',undefined,'ic-sim-nav');nav.setAttribute('aria-label','仿真工作流');
    for(const [id,label] of [['config','配置'],['workflow','提交'],['jobs','运行 · '+projectRuns(s).length],['runtime','资源与监控']]){
      const tab=button(label,()=>showPage(id),false,page===id?'is-active':'');tab.dataset.field='page-'+id;tab.setAttribute('aria-pressed',String(page===id));nav.append(tab);
    }root.append(nav);
    const configPage=el('div',undefined,'ic-sim-page'),workflowPage=el('div',undefined,'ic-sim-page'),jobsPage=el('div',undefined,'ic-sim-page'),runtimePage=el('div',undefined,'ic-sim-page');
    for(const [node,id] of [[configPage,'config'],[workflowPage,'workflow'],[jobsPage,'jobs'],[runtimePage,'runtime']]){node.dataset.page=id;node.hidden=page!==id;root.append(node);}
    runtimePage.append(runtimeRoot);runtime.setActive(page==='runtime');
    if(s.descriptor){
      let conf=null;try{conf=readDraft(s.draftText);}catch(error){note(configPage,'JSON：'+error.message,'ic-sim-error');}
      const effective=s.preview?.effective||s.descriptor.effective;
      renderConfiguration(configPage,s,conf,effective,blocked);
      renderWorkflow(workflowPage,s,conf,blocked);
    }else{
      note(configPage,s.busy?'正在读取实际编译配置…':'配置描述尚不可用，请核对项目和配置身份。');
      note(workflowPage,'读取有效配置后，可预览、保存并生成计划。');
    }
    renderJobs(jobsPage,s);
    jobsPage.prepend(supervisionRoot);
    renderDrafts(root,s);
    if(focus){const next=[...root.querySelectorAll('[data-field]')].find(e=>e.dataset.field===focus);if(next&&!next.closest('[hidden]')){next.focus({preventScroll:true});if(selection&&typeof next.setSelectionRange==='function'&&selection[0]!=null){try{next.setSelectionRange(...selection);}catch{}}}}
  }
  function renderConfiguration(parent,s,conf,effective,blocked){
    const descriptor=s.descriptor,edit=(path,value)=>controller.edit(path,value),basis=s.preview?'预览编译值':'已保存生效值';
    const values=effective.tran?.values||{},si=effective.tran?.values_si||{};
    const analysis=detail(parent,'analysis','瞬态分析','transient');
    const diagram=el('figure',undefined,'ic-sim-timeline');diagram.setAttribute('aria-label','瞬态分析时间范围示意，不是仿真波形');
    const range=el('div',undefined,'ic-sim-time-range');range.append(el('span','0 s'),el('strong',timeValue(si.stop,values.stop)));diagram.append(range,el('div',undefined,'ic-sim-time-axis'));
    diagram.append(el('figcaption',`最大步长 ≤ ${timeValue(si.maxstep,values.maxstep)} · ${basis}`));analysis.append(diagram);
    if(conf){
      const inputs=el('div',undefined,'ic-sim-analysis-fields');analysis.append(inputs);
      let solver=null;
      for(const [key,label,unit] of ANALYSIS_FIELDS){
        if(!has(values,key)||descriptor.editable_analysis_fields&&!descriptor.editable_analysis_fields.includes(key))continue;
        const advanced=!['stop','maxstep'].includes(key);
        if(advanced&&!solver)solver=detail(analysis,'solver','求解器设置');
        field(advanced?solver:inputs,advanced?label:label+' (s)','analysis-'+key,conf.analysis?.[key]??'',advanced?'继承':'继承 · '+display(values[key]),value=>edit(['analysis',key],value===''?undefined:value),{disabled:blocked,hint:advanced?`${unit?unit+' · ':''}生效 ${display(values[key])}`:''});
      }
    }
    note(analysis,'留空继承 · 支持 n/p 后缀 · 预览后更新生效值');
    renderParameters(parent,s,conf,effective,blocked);
    const rawSignals=effective.raw_save?.effective?.signals||[],exportSignals=effective.postprocess?.signals||[];
    const raw=section(parent,'Raw 保存',`${rawSignals.length} 个显式目标`);raw.dataset.role='raw-save';
    note(raw,`${basis} · 写入 Spectre raw 的电压与电流。`);signalList(raw,rawSignals,'raw-list');
    const rawEdit=detail(raw,'raw-edit','编辑保存目标',conf?.save?.mode||'inherit');
    if(conf)renderSaveEditor(rawEdit,s,conf,blocked);else note(rawEdit,'请先修正配置 JSON。');
    const pp=section(parent,'数据导出',`${exportSignals.length} 个信号`);pp.dataset.role='export-signals';
    note(pp,`${basis} · OCEAN 从已有 raw 中提取 CSV / 绘图数据。导出选择不会增加 raw 保存项。`);
    signalList(pp,exportSignals,'export-list');
    if(effective.postprocess){const window=el('div',undefined,'ic-sim-export-window');window.append(el('span',`${timeValue(effective.postprocess.start_s)} → ${timeValue(effective.postprocess.end_s)}`),el('span','采样步长 '+timeValue(effective.postprocess.step_s)));pp.append(window);}
    else note(pp,'已保存 / 已预览配置未启用 OCEAN 后处理。');
    const exportEdit=detail(pp,'postprocess-edit','编辑导出窗口与信号');
    if(conf?.postprocess&&typeof conf.postprocess==='object'){
      for(const [key,label,unit] of [['start_s','起点','s'],['end_s','终点','s'],['step_s','导出步长','s'],['max_display_points','显示点数上限','点']])field(exportEdit,label,'postprocess-'+key,conf.postprocess[key]??'',String(effective.postprocess?.[key]??''),value=>{if(value!==''&&!Number.isFinite(Number(value)))throw Error('请输入有限数值。');return edit(['postprocess',key],value===''?undefined:Number(value));},{type:'number',disabled:blocked,hint:unit});
      const label=el('label','每行：信号名 单位（V / A）','ic-sim-block-label'),signals=el('textarea');signals.rows=4;signals.dataset.field='postprocess-signals';signals.disabled=blocked;
      signals.value=(conf.postprocess.signals||[]).map(x=>typeof x==='string'?x+' V':x.name+' '+x.unit).join('\n');
      signals.addEventListener('change',call(()=>edit(['postprocess','signals'],signals.value.split('\n').filter(x=>x.trim()).map((line,index)=>{const p=line.trim().split(/\s+/);if(p.length!==2||!['V','A'].includes(p[1]))throw Error('导出信号格式：VINP V 或 VDD0:p A');const original=conf.postprocess.signals?.[index];return {...(original&&typeof original==='object'?original:{}),name:p[0],unit:p[1]};}))));label.append(signals);exportEdit.append(label);
    }else note(exportEdit,conf?.postprocess===null?'草稿已关闭 OCEAN 后处理。':'继承模板 postprocess；可在高级详情的完整 JSON 中设置。');
    if(effective.postprocess_unconfirmed_in_explicit_save?.length)note(pp,'未在显式 raw 保存项中确认：'+effective.postprocess_unconfirmed_in_explicit_save.map(s=>s.name).join(', ')+'。是否可导出仍取决于 raw 中的实际数据。','ic-sim-warning');
    const advanced=detail(parent,'advanced','高级详情','JSON / 来源');
    const json=detail(advanced,'json','完整配置 JSON');note(json,'保留未知字段，编译时校验。');
    const editor=el('textarea');editor.rows=12;editor.dataset.field='json';editor.setAttribute('aria-label','完整配置 JSON');editor.spellcheck=false;editor.value=s.draftText;editor.disabled=!!s.busy;
    editor.addEventListener('input',()=>{try{controller.setDraftText(editor.value);}catch(error){editor.value=controller.state.draftText;host.notify(error.message,{kind:'error'});}});json.append(editor);
    const sources=detail(advanced,'sources','分析指令、参数与编译身份');
    code(sources,JSON.stringify({project_id:s.projectId,configuration:s.configurationId,source_commit:s.sourceCommit,configuration_path:descriptor.configuration_path,configuration_sha256:descriptor.configuration_sha256,template_path:descriptor.template_path,template_reference:descriptor.template_reference,compiled_inputs_sha256:effective.compiled_inputs_sha256,tran:effective.tran?.statements,parameters:effective.parameter_statements,simulator:effective.simulator},null,2));
    const saves=detail(advanced,'actual-saves','Raw 保存策略、继承指令与来源');code(saves,JSON.stringify(effective.raw_save,null,2));
    const postprocess=detail(advanced,'postprocess','已编译导出设置');code(postprocess,JSON.stringify(effective.postprocess,null,2));
    const next=el('div',undefined,'ic-sim-footer');next.append(button('继续：预览与提交 →',()=>showPage('workflow'),false,'ic-sim-primary'));parent.append(next);
  }
  function renderParameters(parent,s,conf,effective,blocked){
    const values=effective.parameters||{},saved=parseConfiguration(s.descriptor.configuration_text).parameters||{},draft=conf?.parameters||{};
    const keys=[...new Set([...Object.keys(values),...Object.keys(saved),...Object.keys(draft)])];
    const box=detail(parent,'parameters','参数',`${keys.length} 项`);
    const search=el('input');search.type='search';search.value=parameterQuery;search.placeholder='搜索参数名或值';search.dataset.field='parameter-search';search.setAttribute('aria-label','搜索参数');
    search.addEventListener('input',()=>{parameterQuery=search.value;render();});box.append(search);
    const matches=keys.filter(key=>`${key} ${display(draft[key])} ${display(values[key])}`.toLowerCase().includes(parameterQuery.toLowerCase()));
    note(box,`${matches.length} / ${keys.length} 项 · 留空继承；输入值覆盖。`);
    const wrap=el('div',undefined,'ic-sim-table-wrap'),table=el('table',undefined,'ic-sim-parameter-table'),thead=el('thead'),heading=el('tr');
    for(const title of ['参数 / 来源','覆盖值',s.preview?'预览编译值':'已保存生效值']){const th=el('th',title);th.setAttribute('scope','col');heading.append(th);}thead.append(heading);table.append(thead);
    const body=el('tbody');
    for(const key of matches){
      const changed=has(saved,key)!==has(draft,key)||JSON.stringify(saved[key])!==JSON.stringify(draft[key]);
      const row=el('tr');row.dataset.parameter=key;
      const name=el('th'),inputCell=el('td'),valueCell=el('td');name.setAttribute('scope','row');name.append(el('code',key),badge(!conf?'待修正 JSON':changed?(has(draft,key)?'草稿覆盖':'草稿继承'):has(draft,key)?'已存覆盖':'继承',changed?'draft':''));
      const input=el('input');input.value=draft[key]??'';input.placeholder='继承';input.dataset.field='parameter-'+key;input.setAttribute('aria-label',key+' 覆盖值');input.disabled=blocked||!conf;
      input.addEventListener('change',call(()=>controller.edit(['parameters',key],input.value===''?undefined:input.value)));inputCell.append(input);
      if(changed)inputCell.append(el('small','已存：'+(has(saved,key)?display(saved[key]):'继承')));
      valueCell.append(el('code',display(values[key])));row.append(name,inputCell,valueCell);body.append(row);
    }
    table.append(body);wrap.append(table);box.append(wrap);
    if(!matches.length)note(box,'没有匹配的参数。');
    note(box,'生效值包含已保存的覆盖项；模板原值未单独提供。未预览草稿不会改变右列。');
  }
  function renderSaveEditor(parent,s,conf,blocked){
    const descriptor=s.descriptor,edit=(path,value)=>controller.edit(path,value),currentMode=conf.save?.mode||'inherit';
    select(parent,'保存方式','save-mode',[['inherit','继承模板'],['append','追加目标'],['replace','替换显式清单']],currentMode,mode=>{
      if(mode==='inherit')return edit(['save'],undefined);
      const inherited=(descriptor.effective.raw_save?.inherited?.signals||[]).map(x=>x.kind==='voltage'?{kind:'voltage',path:x.path}:{kind:'current',instance:x.instance,terminal:x.terminal});
      const signals=Array.isArray(conf.save?.signals)?conf.save.signals:mode==='replace'?inherited:[];
      return edit(['save'],{...(conf.save||{}),mode,signals});
    },blocked);
    if(currentMode==='replace'&&!descriptor.save_limits?.replace_supported)note(parent,'模板包含不支持替换的指令。编译器会拒绝 replace。','ic-sim-error');
    if(currentMode==='inherit')return;
    const selected=conf.save?.signals||[];note(parent,`草稿显式目标 · ${selected.length} 项`);
    const list=el('div',undefined,'ic-sim-selections');
    selected.forEach((signal,index)=>{const row=el('div');const remove=button('移除',()=>edit(['save','signals'],selected.filter((_,i)=>i!==index)),blocked,'ic-sim-quiet');remove.setAttribute('aria-label','移除 '+signalText(signal));row.append(el('code',signalText(signal)),remove);list.append(row);});parent.append(list);
    if(!selected.length)note(parent,'至少添加一个目标；replace 还需至少一个电压目标。');
    select(parent,'信号类型','target-kind',[['voltage','电压 · net'],['current','电流 · instance terminal']],targetKind,value=>{targetKind=value;targetPath='';targetTerminal='';render();},blocked);
    const choices=(targetKind==='voltage'?descriptor.catalog?.nets:descriptor.catalog?.instances)||[];
    const input=field(parent,targetKind==='voltage'?'网络':'实例','target-path',targetPath,'搜索完整名称',value=>{targetPath=value;targetTerminal='';render();},{disabled:blocked});
    const data=el('datalist');data.id='ic-sim-targets-'+crypto.randomUUID();input.setAttribute('list',data.id);
    for(const candidate of choices.filter(c=>!targetPath||c.path.toLowerCase().includes(targetPath.toLowerCase())).slice(0,100)){const option=el('option');option.value=candidate.path;data.append(option);}parent.append(data);
    const target=choices.find(x=>x.path===targetPath);
    if(targetKind==='current'&&target)select(parent,'明确终端','target-terminal',[['','选择终端'],...(target.terminals||[]).map(t=>[t.id,`${t.id} · ${t.label} → ${t.net}`])],targetTerminal,value=>{targetTerminal=value;render();},blocked);
    if(target?.source){const origin=detail(parent,'target-source','目标来源');code(origin,`${target.source.path}:${target.source.line_start}`);}
    parent.append(button('添加保存目标',()=>{const signal=targetKind==='voltage'?{kind:'voltage',path:targetPath}:{kind:'current',instance:targetPath,terminal:targetTerminal};return edit(['save','signals'],[...selected,signal]);},blocked||!target||(targetKind==='current'&&!targetTerminal)||selected.length>=(descriptor.save_limits?.max_signals??0)));
  }
  function renderWorkflow(parent,s,conf,blocked){
    const dirty=controller.draftDirty(),unknown=s.saveAttempt?.status==='unknown'||(s.submitAttempt&&!s.lastReceipt&&s.suspended);
    const currentAttempt=s.submitAttempt?.configuration===s.configurationId&&s.submitAttempt?.source_commit===s.sourceCommit;
    const received=currentAttempt&&s.lastReceipt;
    const stage=currentAttempt?4:s.preflight?4:s.plan?3:!dirty?2:s.preview?1:0;
    const steps=el('ol',undefined,'ic-sim-steps');steps.setAttribute('aria-label','提交步骤');
    ['预览','保存','计划','预检','确认提交'].forEach((label,index)=>{const li=el('li',undefined,index===stage?'is-current':index<stage?'is-complete':'');li.append(el('span',String(index+1)),el('span',label));if(index===stage)li.setAttribute('aria-current','step');steps.append(li);});parent.append(steps);
    note(parent,unknown?'上次操作结果待核对，后续提交已暂停。':received?'已收到提交回执，运行状态以任务记录为准。':s.preflight?'预检回执已返回。请明确确认后提交新任务。':s.plan?'计划已生成。下一步为手动远端预检。':dirty?'草稿尚未保存。先预览编译，再保存配置。':'当前配置已保存，可以生成本地计划。','ic-sim-workflow-state');
    const prepare=section(parent,'配置与计划');
    const toolbar=el('div',undefined,'ic-sim-toolbar');
    const incompleteSave=conf?.save&&(!Array.isArray(conf.save.signals)||!conf.save.signals.length);
    toolbar.append(button('预览差异',()=>controller.preview(),blocked||!conf||!dirty||incompleteSave),button(s.pushAfterSave?'提交并推送配置':'保存配置',()=>controller.commit(),blocked||!s.preview||!controller.commitMessageValid()),button('生成计划',()=>controller.plan(),blocked||dirty));prepare.append(toolbar);
    if(s.preview&&s.commitMessage){
      const message=s.commitMessage,box=section(prepare,'提交说明');
      const title=field(box,'标题','commit-title',message.title,'AI 生成或手动填写',value=>controller.setCommitTitle(value),{disabled:blocked});title.maxLength=80;
      const label=el('label','更新内容','ic-sim-block-label'),body=el('textarea');body.rows=3;body.maxLength=300;body.dataset.field='commit-body';body.setAttribute('aria-label','配置更新说明');body.disabled=blocked;body.value=message.body;
      body.addEventListener('input',()=>controller.setCommitBody(body.value));label.append(body);box.append(label);
      title.addEventListener('input',()=>controller.setCommitTitle(title.value));
      note(box,message.status==='running'?'AI（本地默认模型）正在拟写配置说明…':message.error?'自动摘要失败：'+message.error+' 可手动填写。':message.status==='complete'?'AI 草稿已生成，请检查；手写内容会保留。':'标题和说明合计不超过300字。',message.error?'ic-sim-warning':'ic-sim-note');
    }
    const pushDetails=detail(prepare,'push','保存选项',s.pushAfterSave?'提交并推送':'仅提交');
    const pushChoice=el('label',undefined,'ic-sim-consent'),push=el('input');push.type='checkbox';push.dataset.field='push-config';push.checked=s.pushAfterSave;push.disabled=blocked;
    push.addEventListener('change',call(()=>controller.setPushAfterSave(push.checked)));pushChoice.append(push,document.createTextNode('提交后推送到已配置的私有 GitHub 仓库'));pushDetails.append(pushChoice);
    note(pushDetails,'目标 '+(host.getProject()?.repo||'由已配置网关确定')+'；仓库与推送结果由后端核验。');
    if(s.preview){const preview=detail(prepare,'preview-diff','查看已编译差异');code(preview,s.preview.result.diff);}
    if(s.plan)note(prepare,'当前版本计划已生成，编译输入已匹配。','ic-sim-effective');
    const submit=section(parent,'远端执行');
    submit.append(button('远端预检（不启动仿真）',()=>controller.preflight(),blocked||!s.plan||dirty));
    note(submit,'预检会访问远端；点击后才执行。');
    const consent=el('label',undefined,'ic-sim-consent'),check=el('input');check.type='checkbox';check.dataset.field='confirm-submit';check.disabled=blocked||!s.preflight||!!s.submitAttempt;
    consent.append(check,document.createTextNode('我确认按此版本启动一个新的仿真任务'));submit.append(consent);
    const launch=button('提交新仿真',()=>controller.submit(check.checked),true,'ic-sim-primary');
    check.addEventListener('change',()=>{launch.disabled=blocked||!s.preflight||!!s.submitAttempt||!check.checked;});submit.append(launch);
    if(s.lastReceipt)submit.append(button('查看运行 →',()=>showPage('jobs'),false,'ic-sim-quiet'));
    const receipts=detail(parent,'workflow-receipts','高级详情','身份 / 回执');
    code(receipts,JSON.stringify({project_id:s.projectId,configuration:s.configurationId,source_commit:s.sourceCommit,preview_compiled_inputs_sha256:s.preview?.effective?.compiled_inputs_sha256,save_receipt:s.saveReceipt,save_attempt:s.saveAttempt,plan:s.plan,preflight:s.preflight,submit_attempt:s.submitAttempt,submission_receipt:s.lastReceipt},null,2));
  }
  function renderDrafts(parent,s){
    const drafts=controller.getDrafts();if(!drafts.length)return;
    const savedDrafts=detail(parent,'drafts','保留的未保存草稿',String(drafts.length));
    note(savedDrafts,'按项目、配置和版本保留。切回相同身份可继续编辑。');
    for(const draft of drafts){
      const item=detail(savedDrafts,'draft-'+draft.key,`${draft.projectId} / ${draft.configurationId}`,draft.active?'当前草稿':draft.sourceCommit.slice(0,10));
      const text=el('textarea');text.readOnly=true;text.rows=6;text.value=draft.text;text.setAttribute('aria-label','保留的配置草稿');item.append(text);
      item.append(button('明确丢弃此草稿',()=>{if(window.confirm('丢弃此组件中尚未保存的配置草稿？此操作不会修改任何配置文件。'))controller.discardDraft(draft.key,true);},!!s.busy));
    }
  }
  function renderJobs(parent,s){
    const heading=el('div',undefined,'ic-sim-section-head');heading.append(el('h3','运行记录'),button('刷新任务列表',()=>controller.refreshRuns(),!!s.busy||controller.receipts.busy,'ic-sim-quiet'));parent.append(heading);
    note(parent,'当前工程的已保存记录；刷新列表不会查询远端。');
    for(const run of projectRuns(s)){
      const id=run.run_id||run.job_id,receipt=controller.receipts.get(id),policy=controller.receipts.policy(id),result=receipt?.result;
      const publication=result?.publication||run.publication,collection=result?.collection||run.collection,busy=!!s.busy||controller.receipts.busy;
      const card=el('article',undefined,'ic-sim-job');card.dataset.runId=id;
      const head=el('div',undefined,'ic-sim-section-head'),configuration=run.configuration||run.configuration_id;
      head.append(el('h3',s.configurations.find(c=>c.id===configuration)?.name||configuration||run.project_id||'任务'),badge(RUN_LABELS[run.state]||run.state||'状态未知',/failed|failure|unknown|reconcile/.test(run.state||'')?'warning':''));card.append(head);
      const time=el('time',observedTime(run.updated_at));if(run.updated_at)time.setAttribute('datetime',run.updated_at);card.append(time);
      const known=el('div',undefined,'ic-sim-known-data');
      known.append(badge(fullCollection(collection)?'完整 raw 已收集':collection?'收集记录待核验':'无已确认收集数据'));
      if(result?.artifacts?.length)known.append(badge(result.artifacts.length+' 个结果文件'));
      if(result?.metrics?.length)known.append(badge(result.metrics.length+' 项指标'));
      if(policy.verified)known.append(badge('发布已核验'));card.append(known);
      if(Array.isArray(result?.metrics)&&result.metrics.length){
        const wrap=el('div',undefined,'ic-sim-table-wrap'),table=el('table',undefined,'ic-sim-metrics'),heading=el('tr'),thead=el('thead'),body=el('tbody');
        table.setAttribute('aria-label','已保存的结果指标');
        for(const title of ['指标','值','单位']){const th=el('th',title);th.setAttribute('scope','col');heading.append(th);}thead.append(heading);table.append(thead);
        for(const metric of result.metrics){
          if(!metric||typeof metric!=='object')continue;
          const row=el('tr'),name=el('th'),value=el('td'),unit=el('td');name.setAttribute('scope','row');name.append(el('code',display(metric.name)));
          if(metric.scope)name.append(badge(metric.scope==='execution'?'执行状态':String(metric.scope)));
          const scalar=['string','boolean'].includes(typeof metric.value)||typeof metric.value==='number'&&Number.isFinite(metric.value);
          value.textContent=scalar?String(metric.value):metric.value==null?'未提供':'见高级回执';unit.textContent=display(metric.unit);
          row.append(name,value,unit);body.append(row);
        }
        table.append(body);wrap.append(table);card.append(wrap);
        if(result.metrics.some(m=>m?.scope==='execution'))note(card,'执行状态用于核对任务过程，不代表科学指标已达标。');
      }else if(result)note(card,'回执未提供结果指标。');
      if(result?.artifacts?.length){const names=el('div',undefined,'ic-sim-result-files');names.append(el('span','结果文件'),el('span',result.artifacts.map(a=>a.name).join(' · ')));card.append(names);}
      const buttons=el('div',undefined,'ic-sim-toolbar');buttons.append(button(result?'刷新结果':'查看结果',async()=>{await controller.selectRun(id);await controller.receipts.inspect(id);},busy));card.append(buttons);
      if(receipt?.attempt){const a=receipt.attempt;note(card,`${a.kind==='collect'?'收集':'归档'}：${a.status==='completed'?'最终回执已确认':a.status==='accepted'?'请求已接受，尚未确认最终完成':a.status==='requesting'?'等待返回':'失败或结果未知，停止依赖动作'}`);}
      if(receipt?.error)note(card,receipt.error,'ic-sim-error');
      const actions=detail(card,'run-actions-'+id,'更多操作');note(actions,policy.reason);
      if(!['archived','collected'].includes(run.state)&&!['published','complete'].includes(run.publication?.status))actions.append(button('显式更新远端状态',()=>controller.observeRun(id),busy));
      if(!policy.archived){const writes=el('div',undefined,'ic-sim-toolbar');writes.append(button('收集完整结果',()=>controller.receipts.collect(id),!policy.collect),button('归档至私有 GitHub',()=>controller.receipts.archive(id),!policy.archive));actions.append(writes);}
      const box=detail(card,'receipt-'+id,'高级回执与结果链接');
      code(box,JSON.stringify({run_id:id,state:run.state,source_commit:run.source_commit,updated_at:run.updated_at,collection:collection||null,publication:publication||null,metrics:result?.metrics||[],summary:result?.summary||null,attempt:receipt?.attempt||null},null,2));
      const repo=host.getProject()?.repo;
      const links=[{url:publication?.release_url,name:'私有 GitHub Release',kind:'github'},...(publication?.assets||[]).map(a=>({url:a.url,name:`Release asset · ${a.name} · SHA ${a.sha256||'未提供'}`,kind:'github'})),...(result?.artifacts||[]).map(a=>({url:a.url,name:`本地结果 · ${a.name} · ${a.bytes} bytes`,kind:'artifact'}))];
      if(publication?.archive_commit&&repo)links.push({url:'https://github.com/'+repo+'/commit/'+publication.archive_commit,name:'GitHub 归档提交 '+publication.archive_commit,kind:'github'});
      for(const item of links){const safe=safeReceiptLink(item.url,{repo,run:id,origin:location.origin,kind:item.kind});if(safe){const a=el('a',item.name);a.href=safe;a.target='_blank';a.rel='noopener noreferrer';const line=el('p');line.append(a);box.append(line);}}
      parent.append(card);
    }
    if(!projectRuns(s).length)note(parent,'暂无运行记录。生成计划并明确提交后，任务会出现在这里。');
  }
  controller=createController(host,render);render();
  const protectDrafts=event=>{if(controller.getDrafts().length){event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',protectDrafts);
  const selectedReceipt=()=>{const id=controller.receipts.selectedId();if(!id)throw Error('请先选择一个任务。');return id;};
  const selectedPolicy=()=>controller.receipts.policy(controller.receipts.selectedId());
  const commands=[
    {id:'simulation.configure',menu:'simulation',label:'仿真配置…',run:()=>{slot.setVisible(true);showPage('config');}},
    {id:'simulation.plan',menu:'simulation',label:'生成配置计划',run:call(()=>controller.plan()),enabled:()=>!!controller.state.descriptor&&!controller.state.busy&&!controller.draftDirty()&&!controller.state.contextBlocked&&!controller.state.suspended},
    {id:'simulation.preflight',menu:'simulation',label:'远端预检…',run:call(()=>controller.preflight()),enabled:()=>!!controller.state.plan&&!controller.state.busy&&!controller.state.suspended},
    {id:'simulation.submit',menu:'simulation',label:'手动提交…',run:()=>{slot.setVisible(true);showPage('workflow');root.querySelector('[data-field="confirm-submit"]')?.focus();},enabled:()=>!!controller.state.preflight&&!controller.state.suspended},
    {id:'simulation.collect',menu:'simulation',label:'收集选中任务的完整结果',run:call(()=>controller.receipts.collect(selectedReceipt())),enabled:()=>selectedPolicy().collect===true},
    {id:'git.archive-run',menu:'git',label:'归档选中任务至私有 GitHub',run:call(()=>controller.receipts.archive(selectedReceipt())),enabled:()=>selectedPolicy().archive===true},
    {id:'simulation.receipt',menu:'simulation',label:'查看选中任务的本地回执',run:call(()=>{slot.setVisible(true);const id=selectedReceipt();page='jobs';opened.add('receipt-'+id);const box=[...root.querySelectorAll('[data-detail]')].find(e=>e.dataset.detail==='receipt-'+id);if(box)box.open=true;return controller.receipts.inspect(id);}),enabled:()=>!!controller.receipts.selectedId()&&!controller.receipts.busy}
  ].map(c=>host.registerCommand(c));
  return {destroy(){disposed=true;window.removeEventListener('beforeunload',protectDrafts);controller.destroy();supervision.destroy();runtime.destroy();commands.forEach(remove=>remove());sheet.remove();root.remove();}};
}
