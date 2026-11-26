import {createEnvironmentController,onboardingWaveformsAvailable} from './model.js';
import {appendSimulationReport} from '../report.js';
import {appendAgentTestbench,appendVerilogaHeaders} from './testbench-panel.js';
import {createAnalysisPanel} from './analysis-panel.js';
import {appendPdkLut} from './lut.js';
import {checkPdkScopeSelection} from './agent-testbench.js';
import {recoveryMessage} from './recovery.js';
import {environmentAgentAssistance} from '../agent-assistance.js';
import {loadRemoteSimPrefs,saveRemoteSimPrefs,clearRemoteSimPrefs} from './preferences.js';

const labels={idle:'待设置',loading:'处理中',complete:'已读取',error:'未完成',unknown:'待核对'};
const intentRows=[['supply_v','供电 / V'],['frequency_hz','输入频率 / Hz'],['temperature_c','运行温度 / °C'],['nominal_temperature_c','模型标称温度 / °C'],['input_port','输入端口'],['output_port','输出端口'],['vdd_port','供电端口'],['vss_port','参考地端口'],['cycles','仿真周期数'],['load_f','输出负载 / F'],['rise_s','输入上升时间 / s'],['fall_s','输入下降时间 / s'],['points_per_period','每周期采样点数']];
const format=value=>value===null||value===undefined?'未知':typeof value==='object'?JSON.stringify(value):String(value);

export function mountEnvironmentWizard(root,{adapter=null,pendingStore=null,getSource=null,onRun=null,openWaveforms=null,canOpenWaveforms=()=>true,requestAgentAssistance=null,onRequireConnector=null,notify=()=>{}}={}){
  const doc=root.ownerDocument,sheet=doc.createElement('link');sheet.rel='stylesheet';sheet.href=new URL('./style.css',import.meta.url).href;doc.head.append(sheet);
  let controller=null,disposed=false,pasted='',sourceName='',port='',error=null,importMode='agent-tb',supportFiles={},pdkBatch={binding:'',ids:[]};const opened=new Set(),collapsedSteps=new Set(),libraryChoiceIds=new Map(),radioGroup='environment-pdk-'+crypto.randomUUID();
  const el=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const note=(parent,text,warning=false)=>parent.append(el('p',text,warning?'ic-sim-warning':'ic-sim-note'));
  const call=fn=>async()=>{try{error=null;await fn();}catch(reason){error=String(reason?.message||reason);notify(error,{kind:'error'});render();}};
  const button=(label,action,disabled=false)=>{const node=el('button',label);node.type='button';node.disabled=disabled;node.addEventListener('click',call(action));return node;};
  function assistance(parent,kind,label){
    const node=button(label,()=>requestAgentAssistance(environmentAgentAssistance(kind,controller.state,controller.agentEditor)),typeof requestAgentAssistance!=='function');
    node.dataset.agentAssistance=kind;node.title=typeof requestAgentAssistance==='function'?'将当前上下文填入 Agent 草稿，确认后发送':'此宿主尚未连接统一 Agent 对话入口';parent.append(node);
  }
  function detail(parent,key,title){const node=el('details',undefined,'ic-sim-detail');node.dataset.environmentDetail=key;node.open=opened.has(key);node.append(el('summary',title));node.addEventListener('toggle',()=>{if(node.isConnected)node.open?opened.add(key):opened.delete(key);});parent.append(node);return node;}
  function field(parent,label,key,value,onChange,{placeholder='',disabled=false,multiline=false,list=null}={}){
    const row=el('label',undefined,'ic-sim-field'+(multiline?' is-multiline':''));row.append(el('span',label));const input=el(multiline?'textarea':'input');input.value=value??'';input.placeholder=placeholder;input.disabled=disabled;input.dataset.environmentField=key;if(multiline)input.rows=3;else input.type='text';
    if(list?.length){const datalist=el('datalist');datalist.id=radioGroup+'-'+key;for(const suggestion of list){const option=el('option');option.value=suggestion;datalist.append(option);}input.setAttribute('list',datalist.id);row.append(datalist);}
    input.addEventListener('change',call(()=>onChange(input.value)));row.append(input);parent.append(row);return input;
  }
  function select(parent,label,key,options,value,onChange,disabled){const row=el('label',undefined,'ic-sim-field');row.append(el('span',label));const input=el('select');input.dataset.environmentField=key;input.disabled=disabled;for(const option of options){const node=el('option',option.label);node.value=option.value;input.append(node);}input.value=value;input.addEventListener('change',call(()=>onChange(input.value)));row.append(input);parent.append(row);return input;}
  function card(parent,number,title,caption,{done=false,active=false,summaryText=''}={}){
    const node=el('section',undefined,'ic-sim-card ic-env-card'+(done?' is-done':'')+(active?' is-active':''));node.dataset.environmentStep=number;
    const head=el('div',undefined,'ic-sim-section-head'),name=el('h3');
    name.append(el('span',done?'✓':String(number),'ic-env-number'),doc.createTextNode(title));
    const right=el('span',undefined,'ic-env-card-meta');right.append(el('span',caption,'ic-env-step-type'));
    const collapsed=collapsedSteps.has(number);
    const toggle=el('button',collapsed?'展开':'收起','ic-sim-quiet ic-env-step-toggle');toggle.type='button';toggle.setAttribute('aria-expanded',String(!collapsed));
    toggle.addEventListener('click',()=>{if(collapsedSteps.has(number))collapsedSteps.delete(number);else collapsedSteps.add(number);render();});
    right.append(toggle);head.append(name,right);node.append(head);
    const body=el('div',undefined,'ic-env-card-body');body.hidden=collapsed;
    if(collapsed&&summaryText)node.append(el('p',summaryText,'ic-sim-note ic-env-collapsed-summary'));
    node.append(body);parent.append(node);return body;
  }
  const resultError=(parent,step)=>{if(step.error)note(parent,step.error,true);};
  const appendAnalysis=createAnalysisPanel({render,opened,onError:reason=>{error=reason.message;notify(error,{kind:'error'});render();}});
  function evidence(parent,value){const list=el('dl',undefined,'ic-env-observations'),rows=Array.isArray(value)?value.map((item,index)=>[String(index+1),item]):Object.entries(value||{});for(const [key,item]of rows.slice(0,32))list.append(el('dt',key),el('dd',format(item)));parent.append(list);}
  function appendScopePicker(parent,s,locked,connected){
    const libraries=(s.session?.discovery?.lut||[]).filter(row=>/^[a-f0-9]{64}$/.test((row.projection||row).library_id)&&s.session.probes?.some(probe=>probe.probe_id===row.probe_id));
    if(!libraries.length)return;
    const box=detail(parent,'pdk-scope-picker','已有索引：选择入口与有序 section');box.dataset.pdkScopePicker='';
    const choice=s.scopeChoice,entries=s.scopeEntries.result?.catalog,sections=s.scopeSections.result?.catalog,unknown=s.scopeSave.status==='unknown',disabled=locked||!connected||s.setupDirty||unknown;let saved=null;try{saved=checkPdkScopeSelection(s.session);}catch(reason){note(box,reason.message,true);}
    note(box,'读取已保存的索引，明确选择同一入口中的 section，并按列出的顺序包含。保存后仍需新的依赖审计。');
    const libraryKey=row=>JSON.stringify([row.probe_id,(row.projection||row).library_id]);
    select(box,'已保存模型库','scope-library',[{value:'',label:'明确选择一个模型库'},...libraries.map(row=>({value:libraryKey(row),label:(s.session.probes.find(probe=>probe.probe_id===row.probe_id)?.ssh_target||row.probe_id)+' · '+(row.projection||row).library_id.slice(0,12)}))],choice.libraryId?JSON.stringify([choice.probeId,choice.libraryId]):'',value=>{const row=libraries.find(row=>libraryKey(row)===value);if(row)controller.selectScopeLibrary({probe_id:row.probe_id,library_id:(row.projection||row).library_id});else controller.selectScopeLibrary();},disabled);
    const readEntries=button(entries?'重新读取入口目录':'读取入口目录',()=>controller.readPdkScopes({kind:'entries'}),disabled||!choice.libraryId||!controller.has('getPdkScopes'));readEntries.dataset.pdkScopeReadEntries='';box.append(readEntries);resultError(box,s.scopeEntries);
    if(entries){
      note(box,'入口 '+entries.items.length+' / '+entries.total+' · '+entries.status);
      select(box,'模型入口','scope-entry',[{value:'',label:'明确选择一个入口'},...entries.items.map(row=>({value:row.entry_id,label:row.label+' · '+row.section_count+' 个 section'}))],choice.entryId,value=>controller.selectScopeEntry(value),disabled);
      if(entries.next_offset!==null){const more=button('读取更多入口',()=>controller.readPdkScopes({kind:'entries',more:true}),disabled);more.dataset.pdkScopeMoreEntries='';box.append(more);}
    }
    if(choice.entryId){const read=button(sections?'重新读取 section':'读取所选入口的 section',()=>controller.readPdkScopes({kind:'sections'}),disabled||!controller.has('getPdkScopes'));read.dataset.pdkScopeReadSections='';box.append(read);}
    resultError(box,s.scopeSections);
    if(sections){
      const fields=el('fieldset',undefined,'ic-env-sections');fields.dataset.pdkScopeSections='';fields.append(el('legend','Section · 勾选顺序即包含顺序（最多 64）'));
      for(const row of sections.items){const label=el('label'),check=el('input');check.type='checkbox';check.dataset.pdkScopeSection=row.section_id;check.dataset.environmentField='scope-section-'+row.section_id;check.checked=choice.sectionIds.includes(row.section_id);check.disabled=disabled||!check.checked&&choice.sectionIds.length>=64;check.addEventListener('change',call(()=>controller.selectScopeSections(check.checked?[...choice.sectionIds,row.section_id]:choice.sectionIds.filter(id=>id!==row.section_id))));label.append(check,doc.createTextNode((row.section===null?'全局作用域':row.section)+' · '+row.observed_model_count+' 个已观察型号'+(row.unknown_codes.length?' · 有待核对项':'')));fields.append(label);}box.append(fields);
      note(box,'Section '+sections.items.length+' / '+sections.total+' · '+sections.status);
      if(sections.next_offset!==null){const more=button('读取更多 section',()=>controller.readPdkScopes({kind:'sections',more:true}),disabled);more.dataset.pdkScopeMoreSections='';box.append(more);}
      if(choice.sectionIds.length){const order=el('ol');order.dataset.pdkScopeOrder='';for(const [index,sectionId]of choice.sectionIds.entries()){const row=sections.items.find(item=>item.section_id===sectionId),item=el('li');item.dataset.pdkScopeOrdered=sectionId;item.append(el('span',row?.section===null?'全局作用域':row?.section||'待核对的 section'));const move=delta=>{const next=[...choice.sectionIds];[next[index],next[index+delta]]=[next[index+delta],next[index]];controller.selectScopeSections(next);};item.append(button('上移',()=>move(-1),disabled||index===0),button('下移',()=>move(1),disabled||index===choice.sectionIds.length-1));order.append(item);}box.append(order);}
    }
    const matching=saved&&saved.probe_id===choice.probeId&&saved.library_id===choice.libraryId&&saved.entry_id===choice.entryId&&JSON.stringify(saved.section_ids)===JSON.stringify(choice.sectionIds);
    if(matching&&saved.tmi_options?.length)select(box,'TMI 选项','scope-tmi',[{value:'',label:'明确选择观察到的 TMI 选项'},...saved.tmi_options.map(row=>({value:row.tmi_option_id,label:row.label}))],choice.tmiOptionId||'',value=>controller.selectScopeTmi(value||null),disabled);
    const save=button(s.busy==='pdk-scope-save'?'保存中…':'保存作用域 · 待依赖审计',()=>controller.savePdkScope(),disabled||!choice.sectionIds.length||controller.agentEditor.dirty||controller.agentEditor.conflict||!controller.has('selectPdkScope'));save.dataset.pdkScopeSave='';box.append(save);resultError(box,s.scopeSave);
    if(controller.agentEditor.dirty||controller.agentEditor.conflict)note(box,'当前测试平台草稿仍保留；先保存或核对草稿，再保存作用域。');
    if(unknown)note(box,'保存结果未知。请刷新原实验读取回执，不要重复保存。',true);
    if(saved){const report=el('div');report.dataset.pdkScopeSaved='';note(report,saved.status==='requires_audit'?'作用域已保存 · 仍需新依赖审计':'作用域已保存 · 有阻断项',saved.status!=='requires_audit');evidence(report,{'包含顺序':saved.sections,'覆盖型号':saved.covered_model_names,'缺失型号':saved.missing_model_names});for(const gap of saved.missing||[])note(report,gap.message||gap.code||'待核对项');note(report,'尚未获得运行就绪回执。采用后需重新保存测试平台，并按原流程生成审阅计划。');
      if(s.session.agent_tb){const adopt=button('采用此作用域到测试平台',()=>controller.adoptPdkScope(),disabled||controller.agentEditor.conflict||saved.status!=='requires_audit');adopt.dataset.pdkScopeAdopt='';report.append(adopt);note(report,'保留测试平台原文、说明和已填写的允许主机，仅替换 PDK 绑定。');}box.append(report);}
  }
  function environmentSummary(parent,value){
    const rows={},tools=Array.isArray(value.tools)?value.tools:[];
    for(const [kind,label]of [['spectre','Spectre'],['python','Python']]){const tool=tools.find(item=>item.kind===kind);rows[label]=!tool?'未知':(tool.configured?'已找到配置':'未找到配置')+(tool.version?' · '+tool.version:'')+(tool.usable==='probe_executed'?' · 已执行探测':'');}
    const licenses=Array.isArray(value.licenses)?value.licenses:[];rows['许可证配置']=!licenses.length?'未知':licenses.some(item=>item.configured)?'已发现配置 · 未验证可用性':licenses.some(item=>item.declared_in_scripts)?'仅发现脚本声明 · 尚未生效':'未发现';
    const resources=value.resources||{};rows['CPU 核数']=resources.cpu_count??'未知';rows['1 分钟负载']=resources.load_1m??'未知';rows['可用内存']=Number.isFinite(resources.memory_available_bytes)?(resources.memory_available_bytes/2**30).toFixed(1)+' GiB':'未知';
    rows['环境激活']=value.coverage?.scripts_evaluated===true?'已激活所选脚本':'未激活脚本';evidence(parent,rows);
    if(value.state==='unavailable')note(parent,'环境探测不可用：'+format(value.error_code),true);
    if(value.warnings?.length)note(parent,`观察存在 ${value.warnings.length} 个覆盖缺口，详见依据。`,true);
    evidence(detail(parent,'environment-evidence-'+value.alias,'环境观察依据'),value);
  }
  function render(){
    if(disposed||!controller)return;
    for(const node of root.querySelectorAll('[data-environment-detail]'))node.open?opened.add(node.dataset.environmentDetail):opened.delete(node.dataset.environmentDetail);
    const active=root.contains(doc.activeElement)?doc.activeElement:null,focused=active?.dataset.environmentField,selection=active&&['INPUT','TEXTAREA'].includes(active.tagName)?[active.selectionStart,active.selectionEnd]:null,s=controller.state,locked=controller.locked,connected=controller.connected,generic=s.source?.mode==='agent-tb'||s.session?.mode==='agent-tb'||!!s.session?.agent_tb;
    const pdkProbes=(s.probe.result?.probes||[]).filter(row=>typeof row.probe_id==='string'&&row.probe_id),pdkBatchBinding=JSON.stringify([s.session?.connection_id,s.session?.intake_id,s.session?.source_sha256,pdkProbes.map(row=>row.probe_id)]);
    if(pdkBatch.binding!==pdkBatchBinding)pdkBatch={binding:pdkBatchBinding,ids:[]};
    root.replaceChildren();root.classList.add('ic-env');root.setAttribute('aria-label','环境与 PDK 向导');
    const step1Done=s.intake.status==='complete',step2Done=s.probe.status==='complete',step3Done=s.discovery.status==='complete',step4Done=generic?Boolean(s.session?.agent_tb&&s.session?.prepared):s.preparation.status==='complete',stepRunDone=s.run.status==='complete';
    const currentStep=!step1Done?1:!step2Done?2:!step3Done?3:generic&&!step4Done?4:generic?5:4;
    const stepper=el('ol',undefined,'ic-sim-steps ic-env-stepper');stepper.setAttribute('aria-label','远端仿真进度');
    const stepDefs=generic?[[1,'网表',step1Done],[2,'服务器',step2Done],[3,'PDK',step3Done],[4,'测试台',step4Done],[5,'运行',stepRunDone]]:[[1,'网表',step1Done],[2,'服务器',step2Done],[3,'PDK',step3Done],[4,'运行',stepRunDone]];
    for(const [num,label,done] of stepDefs){const li=el('li',undefined,done?'is-complete':num===currentStep?'is-current':'');li.append(el('span',done?'✓':String(num)),el('span',label));if(num===currentStep)li.setAttribute('aria-current','step');stepper.append(li);}
    root.append(stepper);
    const connection=el('div',undefined,'ic-env-connection'+(connected?' is-connected':''));
    const connBar=el('div',undefined,'ic-env-connection-bar');
    connBar.append(el('span',connected?'✓ 本机已连接（SSH 远端仿真 · AI · Git 共用）':'尚未连接本机（需要连接器以访问你的 SSH 与 PDK）','ic-env-conn-badge'));
    if(!connected&&controller.has('connect')){
      const portRow=el('div',undefined,'ic-env-conn-controls');
      if(typeof onRequireConnector==='function'){
        // Invoke controller.connect() synchronously inside the click gesture so the
        // local authorization popup opens in one click just like Codex.
        const connectDirect=async()=>{
          try{
            return await controller.connect();
          }catch(reason){
            const msg=String(reason?.message||reason||'');
            if(/未检测到本机连接助手/.test(msg))onRequireConnector('远端 SSH 服务器仿真与 PDK 匹配');
            throw reason;
          }
        };
        const directBtn=button(s.connection.connecting?'连接中…':'授权连接本机（SSH / AI）',connectDirect,!!s.busy||s.connection.connecting);
        directBtn.classList.add('ic-sim-primary');
        const setupBtn=button('未启动？唤起或安装连接器',()=>onRequireConnector('远端 SSH 服务器仿真与 PDK 匹配'),!!s.busy||s.connection.connecting);
        setupBtn.classList.add('ic-sim-quiet');
        portRow.append(directBtn,setupBtn);
        const manualDetails=detail(connection,'manual-port','自定义本机端口');
        field(manualDetails,'本机端口（可选）','connection-port',port,value=>{port=value;},{placeholder:'8767',disabled:!!s.busy});
        manualDetails.append(button(s.connection.connecting?'连接中…':'连接本机环境服务',()=>{const number=port.trim()?Number(port):undefined;if(number!==undefined&&(!Number.isInteger(number)||number<1||number>65535))throw Error('端口应为 1–65535 的整数。');return controller.connect(number===undefined?{}:{port:number});},!!s.busy||s.connection.connecting));
        connection.append(connBar,portRow,manualDetails);
      }else{
        field(portRow,'本机端口（可选）','connection-port',port,value=>{port=value;},{placeholder:'8767',disabled:!!s.busy});
        // connect is invoked synchronously so pairing preserves the click's popup gesture.
        const connectBtn=button(s.connection.connecting?'连接中…':'连接本机环境服务',()=>{const number=port.trim()?Number(port):undefined;if(number!==undefined&&(!Number.isInteger(number)||number<1||number>65535))throw Error('端口应为 1–65535 的整数。');return controller.connect(number===undefined?{}:{port:number});},!!s.busy||s.connection.connecting);
        connectBtn.classList.add('ic-sim-primary');
        portRow.append(connectBtn);
        connection.append(connBar,portRow);
      }
      note(connection,'连接一次即可同时启用远端 SSH 仿真、Codex AI 与本地 Git，所有操作均在网页完成。');
    }else{
      connection.append(connBar);
    }
    if(s.boundConnectionId&&s.boundConnectionId!==s.connection.connectionId)note(connection,'当前电路会话属于另一台连接器；请重新连接原服务后核对。',true);if(s.connection.error)note(connection,s.connection.error,true);root.append(connection);
    if(connected&&s.connection.selectedIntakeId&&!s.session&&!s.pending.length)connBar.append(button('恢复上次网表与实验',()=>controller.restoreSelected(),locked));
    if(connected&&s.session)connBar.append(button(s.refresh.status==='loading'?'刷新中…':controller.recoveryRequired?'核对原会话':'刷新当前实验',()=>controller.refreshCurrent(controller.currentBinding),!!s.busy||!!s.pending.length||s.refresh.status==='loading'));resultError(connection,s.refresh);
    if(controller.recoveryRequired){const recovery=el('section',undefined,'ic-sim-card');recovery.dataset.environmentInterrupted='';recovery.append(el('h3','原操作需要人工恢复'));note(recovery,recoveryMessage(s.session),true);evidence(recovery,{操作:controller.recoveryRequired.operation,开始时间:controller.recoveryRequired.startedAt,原操作身份:controller.recoveryRequired.operationId});root.append(recovery);}
    if(error)note(root,error,true);if(s.storageError)note(root,s.storageError,true);
    if(s.pending.length){const recovery=el('section',undefined,'ic-sim-card');recovery.dataset.environmentRecovery='';recovery.append(el('h3','原请求待核对'));note(recovery,'保存的原 intake 与提交键仍在。核对只读取原回执；缺少映射也不会重新提交。',true);for(const record of s.pending){note(recovery,`${record.phase==='run'?'提交':'准备'} · ${record.intake_id}`);recovery.append(button('核对原请求',()=>controller.restore(record),!!s.busy||!connected));}root.append(recovery);}

    const source=card(root,1,'独立网表',step1Done?'已核对':s.source?'已读取':'待导入',{done:step1Done,active:currentStep===1,summaryText:s.source?`${s.source.name} · ${s.source.devices.length} 个器件`:s.session?.source?.file_name||''}),toolbar=el('div',undefined,'ic-sim-toolbar'),label=el('label',undefined,'ic-env-file');label.append(el('span','导入网表'));
    select(source,'测试流程','import-mode',[{value:'agent-tb',label:'Agent 测试台（人工审阅）'},{value:'legacy',label:'反相器 / RC 参考流程'}],importMode,value=>{importMode=value;render();},locked);
    const importSource=value=>{const {mode:_mode,...source}=value;return controller.importSource({...source,...(importMode==='agent-tb'?{mode:'agent-tb',...(Object.keys(supportFiles).length?{support_files:supportFiles}:{})}:{})});};
    const file=el('input');file.type='file';file.accept='.scs,.sp,.spice,.cir,.txt,.va,.vams';file.disabled=locked;file.setAttribute('aria-label','导入独立网表');file.addEventListener('change',call(async()=>{const selected=file.files?.[0];if(!selected)return;if(selected.size>1024*1024)throw Error('独立网表超过 1 MiB 导入上限。');await importSource({file_name:selected.name,text:await selected.text()});}));label.append(file);
    if(getSource){const currentBtn=button('导入当前网表',async()=>importSource(await getSource()),locked);if(!step1Done)currentBtn.classList.add('ic-sim-primary');toolbar.append(currentBtn);}
    toolbar.append(label);source.append(toolbar);
    if(importMode==='agent-tb'){const supports=detail(source,'support-files','附加 include 文件（可选）'),picker=el('input');picker.type='file';picker.multiple=true;picker.accept='.scs,.sp,.spice,.cir,.txt,.va,.vams';picker.disabled=locked;picker.setAttribute('aria-label','附加网表支持文件');picker.addEventListener('change',call(async()=>{const next={};for(const file of picker.files||[]){if(Object.keys(next).length>=64||file.size>1024*1024||Object.hasOwn(next,file.name))throw Error('支持文件重复、数量或大小超出范围。');next[file.name]=await file.text();}supportFiles=next;render();}));supports.append(picker);note(supports,Object.keys(supportFiles).length?Object.keys(supportFiles).join(' · '):'仅导入明确选中的文本；PDK 仍由服务器发现和核对。');}
    const paste=detail(source,'paste','粘贴网表');field(paste,'文件名','source-name',sourceName,value=>{sourceName=value;},{placeholder:'独立网表文件名',disabled:locked});field(paste,'网表文本','source-text',pasted,value=>{pasted=value;render();},{placeholder:'粘贴独立 Spectre 网表',disabled:locked,multiline:true});paste.append(button('读取粘贴网表',()=>importSource({file_name:sourceName||'imported.scs',text:pasted}),locked||!pasted.trim()));
    const requirements=s.session?.source.requirements;
    if(s.source){
      note(source,`${s.source.name} · ${s.source.devices.length} 个器件 · ${s.source.models.length} 个 master/model`);const masters=el('ul',undefined,'ic-sim-signals');for(const model of s.source.models.slice(0,32))masters.append(el('li',model,'ic-sim-signal'));source.append(masters);const portText=s.source.ports.map(port=>`${port.scope} (${port.names.join(', ')})`).join('；');note(source,portText?'声明端口：'+portText:'未声明子电路端口；需明确指定实验端口。');
      const more=detail(source,'devices','器件、尺寸与连接节点'),wrap=el('div',undefined,'ic-sim-table-wrap'),table=el('table',undefined,'ic-env-devices'),head=el('thead'),row=el('tr');for(const name of ['器件 / 型号','W / L','节点（源码顺序）'])row.append(el('th',name));head.append(row);table.append(head);const body=el('tbody');
      for(const device of s.source.devices.slice(0,100)){const tr=el('tr'),name=el('td');name.append(el('strong',device.name),el('code',device.model));const dimensions=new Map(device.dimensions.map(item=>[item.name,item.value]));tr.append(name,el('td',(dimensions.get('w')||'未声明')+' / '+(dimensions.get('l')||'未声明')),el('td',`(${device.nodes.length}) `+device.nodes.join(' · ')));body.append(tr);}table.append(body);wrap.append(table);more.append(wrap);note(more,'尺寸表达式与节点顺序按源码显示；不依据模型名猜测工艺或端口意义。');
      note(source,'网表检查状态：'+labels[s.intake.status]);resultError(source,s.intake);if(s.intake.status!=='complete')source.append(button('核对独立网表',()=>controller.inspectSource(),locked||!connected));
    }else if(s.session){note(source,'已恢复上次电路会话：'+s.session.source.file_name);const restored=detail(source,'restored-devices','器件、尺寸与连接节点');for(const instance of requirements.instances.slice(0,100)){restored.append(el('h4',instance.name+' · '+instance.master));note(restored,'节点（源码顺序）：'+instance.ordered_nets.join(' · '));evidence(restored,instance.dimensions);}note(restored,'以上数据来自此会话保存的字面检查记录。');}
    if(requirements?.issues?.length)evidence(detail(source,'source-issues','网表核对项'),requirements.issues);

    const host=card(root,2,'服务器',step2Done?`已探测 ${s.probe.result?.probes?.length||0} 台`:'探测后自动匹配',{done:step2Done,active:currentStep===2,summaryText:s.targets.length?'主机范围：'+s.targets.join('、'):''}),aliases=detail(host,'ssh-aliases','选择本机 SSH 配置');aliases.append(button('读取本机别名',()=>controller.loadAliases(),locked||!connected));
    assistance(host,'environment','请 Agent 检查环境与 PDK');
    const savedPrefs=loadRemoteSimPrefs();
    if(savedPrefs&&!s.targets.length){
      const prefBar=el('div',undefined,'ic-env-prefs-bar');
      const summary=[savedPrefs.targets.join(', '),savedPrefs.search_paths?'含 PDK 搜索路径':'',savedPrefs.cds_lib_hint?'含 cds.lib 提示':''].filter(Boolean).join(' · ');
      const applyPref=button('套用上次主机与 PDK 提示：'+summary,()=>{
        if(savedPrefs.targets.length)controller.setTargets(savedPrefs.targets);
        if(savedPrefs.search_paths)controller.setHint('search_paths',savedPrefs.search_paths);
        if(savedPrefs.cds_lib_hint)controller.setHint('cds_lib_hint',savedPrefs.cds_lib_hint);
        notify('已载入上次保存的主机范围与 PDK 提示，请核对后探测。',{kind:'info'});
      },locked);
      applyPref.dataset.environmentApplyPrefs='';
      const forgetPref=button('清除记忆',()=>{clearRemoteSimPrefs();render();},locked);
      forgetPref.classList.add('ic-sim-quiet');forgetPref.dataset.environmentClearPrefs='';
      prefBar.append(applyPref,forgetPref);host.append(prefBar);
    }
    for(const item of s.aliases.result?.hosts||[]){const row=el('label',undefined,'ic-env-choice'),check=el('input');check.type='checkbox';check.checked=s.targets.includes(item.alias);check.disabled=locked;check.addEventListener('change',call(()=>controller.setTargets(check.checked?[...s.targets,item.alias]:s.targets.filter(target=>target!==item.alias))));row.append(check,doc.createTextNode(item.alias));aliases.append(row);}
    field(host,'允许的主机范围','ssh-targets',s.targets.join('\n'),value=>controller.setTargets(value.split(/[\n,]/).map(item=>item.trim()).filter(Boolean)),{placeholder:'SSH alias 或 user@host，每行一个',disabled:locked,multiline:true});note(host,'读取别名和编辑范围不会连接主机。运行时仅在此范围内选择资源合适的主机。');
    const rememberCurrentPrefs=()=>{if(s.targets.length||s.hints.search_paths.trim()||s.hints.cds_lib_hint.trim())saveRemoteSimPrefs({targets:s.targets,search_paths:s.hints.search_paths,cds_lib_hint:s.hints.cds_lib_hint});};
    const ensureNetlistThen=async fn=>{
      rememberCurrentPrefs();
      const savedTargets=[...s.targets],savedHints={...s.hints};
      if(controller.state.intake.status!=='complete'&&typeof getSource==='function'){
        await importSource(await getSource());
        if(savedTargets.length)controller.setTargets(savedTargets);
        if(savedHints.search_paths)controller.setHint('search_paths',savedHints.search_paths);
        if(savedHints.cds_lib_hint)controller.setHint('cds_lib_hint',savedHints.cds_lib_hint);
      }
      return fn();
    };
    const canAutoImport=typeof getSource==='function';
    const probeActions=el('div',undefined,'ic-sim-toolbar');
    const primaryProbe=button(s.busy==='probe'?'探测中…':s.busy==='pdk'?'匹配 PDK 中…':s.setupDirty?'应用环境并重新匹配':'探测并匹配 PDK',()=>ensureNetlistThen(()=>controller.probeAndMatch()),locked||!connected||!s.targets.length||s.targets.length>2||(s.intake.status!=='complete'&&!canAutoImport));
    primaryProbe.classList.add('ic-sim-primary');
    probeActions.append(primaryProbe,button('只探测所选主机',()=>ensureNetlistThen(()=>controller.probeHost()),locked||!connected||!s.targets.length||(s.intake.status!=='complete'&&!canAutoImport)));
    if(s.targets.length){
      const saveBtn=button('记住主机与 PDK 提示',()=>{rememberCurrentPrefs();notify('已记住当前主机范围与 PDK 搜索提示（仅存本机非敏感标识）。',{kind:'info'});render();},locked);
      saveBtn.classList.add('ic-sim-quiet');saveBtn.dataset.environmentSavePrefs='';
      probeActions.append(saveBtn);
    }
    host.append(probeActions);note(host,'环境探测最多 8 台主机；完整 PDK 发现每批最多 2 台。多主机探测后，在 PDK 高级设置中明确选择本批主机。');resultError(host,s.aliases);resultError(host,s.probe);
    const hostEvidence=s.probe.result?.probes?.length?detail(host,'host-evidence','环境观察与高级配置'):null;
    for(const probe of s.probe.result?.probes||[]){const summary=el('div',undefined,'ic-env-probe');summary.append(el('h4',probe.ssh_target));note(summary,'观察时间：'+probe.observed_at);environmentSummary(summary,probe.environment);note(summary,'许可证项表示配置存在情况，未执行 license checkout。');
      if(probe.environment.setup_candidates?.length){select(summary,'可选环境配置','setup-'+probe.probe_id,[{value:'',label:'不激活环境脚本'},...probe.environment.setup_candidates.filter(item=>item.activation_supported===true).map(item=>({value:item.source_id,label:item.label||item.source_id}))],s.setupSourceIds[probe.ssh_target]||'',value=>controller.selectSetupSource(probe.ssh_target,value||null),locked);note(summary,'选择后需点击重新探测。后端核对脚本身份后激活；发现候选不代表已审计其副作用。');}
      hostEvidence.append(summary);}

    const lutRows=s.discovery.result?.discovery.lut||[],pendingLibraries=lutRows.filter(row=>{const current=row.projection||row;return /^[a-f0-9]{64}$/.test(current.library_id)&&current.status==='partial'&&current.scan_required===false;});
    const pdkCard=card(root,3,generic?'PDK 依据':'实验推荐',generic?'测试平台中明确选择':s.recommendationMode?'等待确认':'手动设置',{done:step3Done,active:currentStep===3,summaryText:s.discovery.result?.discovery.candidates?.length?`已发现 ${s.discovery.result.discovery.candidates.length} 个候选`:''}),recommendation=generic?null:controller.recommendation,shown=generic?s.session?.agent_tb?.selection:s.recommendationMode?recommendation:{candidate_id:s.candidateId,sections:s.sections,intent:s.intent},choice=s.discovery.result?.discovery.candidates.find(item=>item.candidate_id===shown?.candidate_id);
    const recommendationBox=el('div',undefined,'ic-env-recommendation');recommendationBox.dataset.environmentRecommendation='';
    if(generic){note(recommendationBox,'扫描结果是模型选择依据。实际 PDK、Corner 与运行主机随测试平台草稿保存和审阅。');let shownScope=null;try{shownScope=checkPdkScopeSelection(s.session);}catch{}if(shown)evidence(recommendationBox,{PDK:shown.scope_selection_id?shownScope?.selection_id===shown.scope_selection_id?'已保存作用域 '+shown.scope_selection_id.slice(0,12):'作用域绑定已失效，需重新保存':choice?.label||shown.candidate_id,Corner:shown.scope_selection_id?shownScope?.selection_id===shown.scope_selection_id?shownScope.sections:'待重新绑定':shown.sections,主机:shown.host_ids});}
    else if(shown&&choice){const values=shown.intent||{};evidence(recommendationBox,{'PDK':choice.label,'Corner':(shown.sections||[]).map(value=>value===null?'全局':value).join('、')||'未确定','端口':values.input_port&&values.output_port?values.input_port+' → '+values.output_port:'待确认','供电 / V':values.supply_v??'待确认','频率 / Hz':values.frequency_hz??'待确认','温度 / °C':values.temperature_c??'待确认','周期数':values.cycles??'待确认'});}
    if(recommendation){
      note(recommendationBox,recommendation.ready_for_prepare?'建议已齐备，确认后准备并提交；提交前仍会检查依赖和资源。':'建议尚不完整，请核对缺失项或打开高级设置。');
      for(const item of recommendation.missing||[])note(recommendationBox,item.message||item.field||item.code,true);
      const proof=detail(recommendationBox,'recommendation-evidence','完整条件与推荐依据');evidence(proof,{条件:recommendation.intent,依据:recommendation.provenance});note(proof,'推荐可包含静态证据和推断；不代表模型、许可证或仿真已通过验证。');
      recommendationBox.append(button(s.recommendationMode?'调整推荐参数':'恢复当前推荐',()=>{if(s.recommendationMode){for(const key of ['pdk-advanced','experiment-advanced']){const disclosure=root.querySelector(`[data-environment-detail="${key}"]`);if(disclosure)disclosure.open=true;opened.add(key);}controller.editRecommendation();}else controller.useRecommendation();},locked||!recommendation.ready_for_prepare));
    }else if(!generic)note(recommendationBox,pendingLibraries.length?'PDK 索引已保存；模型绑定仍待处理，当前尚无可准备的实验建议。':s.discovery.status==='complete'?'尚无完整推荐，可在高级设置中选择候选和补充参数。':'完成服务器探测后，在这里核对 PDK 与实验条件。');pdkCard.append(recommendationBox);resultError(pdkCard,s.discovery);
    appendPdkLut(pdkCard,lutRows.filter(row=>!pendingLibraries.includes(row)),{detail});
    for(const row of pendingLibraries){const current=row.projection||row,coverage=current.coverage||{},combination=current.combination,combined=combination?.requires_explicit_selection===true||current.missing?.some(gap=>gap.code==='multi_entry_selection_required'),status=el('section',undefined,'ic-env-lut');status.dataset.pdkLibraryPending=row.probe_id;status.append(el('h4','PDK 索引已保存 · '+(combined?'组合绑定待处理':'模型绑定待处理')));note(status,row.ssh_target||row.probe_id);evidence(status,{'已索引型号数':Number.isSafeInteger(coverage.indexed_model_count)?coverage.indexed_model_count:'未提供','当前覆盖':'partial · 仍有覆盖缺口',...(Number.isSafeInteger(combination?.entry_count)?{'待组合入口数':combination.entry_count}:{})});
      note(status,combined?'当前电路需要的模型跨多个入口；组合入口与 Corner 尚待明确确认，组合依赖尚未审计。':'已有索引尚未形成当前电路的完整模型绑定，请核对入口选择与待处理项。');note(status,'索引保存不代表工艺覆盖完整或依赖审计通过；当前尚未形成可运行组合。',true);
      const gaps=[...(current.missing||[]),...(combination?.missing||[])],names={multi_entry_selection_required:'模型组合尚待明确选择。',combined_dependency_audit_required:'组合依赖仍需审计。',binding_query_size:'当前绑定范围需进一步明确入口。'};for(const gap of gaps)note(status,names[gap.code]||gap.message||gap.code||'存在未说明的绑定缺口。');evidence(detail(status,'library-coverage-'+row.probe_id,'索引覆盖与绑定依据'),{coverage,combination:combination||null,missing:gaps,ready_to_run:current.ready_to_run,remote_freshness_verified:current.remote_freshness_verified});evidence(detail(status,'library-history-'+row.probe_id,'扫描与索引原始回执'),row);pdkCard.append(status);
    }
    const libraryRows=(s.session?.discovery?.lut||[]).filter(row=>Array.isArray((row.projection||row).entry_choices)&&(row.projection||row).entry_choices.length),libraryKeys=new Set();
    if(libraryRows.length){const choices=detail(pdkCard,'pdk-library-choices','选择已有 PDK 索引入口');choices.dataset.pdkLibraryChoices='';note(choices,'选择一个已观察的模型入口，沿用原搜索范围查询已保存索引。实际 PDK 与 Corner 仍需随测试平台确认。');
      for(const row of libraryRows){const scope=row.projection||row,probe=s.session.probes?.find(item=>item.probe_id===row.probe_id),items=scope.entry_choices;
        if(!probe||!/^[a-f0-9]{64}$/.test(scope.library_id)||items.some(item=>!item||!/^[a-f0-9]{64}$/.test(item.library_candidate_id)||typeof item.label!=='string'||!Array.isArray(item.section_candidates)||!Number.isSafeInteger(item.covered_model_count)||item.covered_model_count<0)){note(choices,'索引入口缺少本次主机观察或完整身份，请刷新当前实验核对。',true);continue;}
        const key=JSON.stringify([s.session.connection_id,s.session.intake_id,s.session.revision,row.probe_id,scope.library_id]);libraryKeys.add(key);const selected=libraryChoiceIds.get(key)||'',disabled=locked||!connected||s.setupDirty||s.searchScopeDirty||controller.agentEditor.dirty||controller.agentEditor.conflict;
        select(choices,probe.ssh_target+' · 已观察入口','pdk-library-'+row.probe_id,[{value:'',label:'明确选择一个入口'},...items.map(item=>({value:item.library_candidate_id,label:item.label+' · '+item.section_candidates.map(value=>value===null?'全局':value).join(' / ')+' · '+item.covered_model_count+' 个型号'}))],selected,value=>{libraryChoiceIds.set(key,value);render();},disabled);
        const query=button('按所选入口匹配模型',()=>controller.matchPdk({library_selection:{probe_id:row.probe_id,library_id:scope.library_id,library_candidate_id:libraryChoiceIds.get(key)}}),disabled||!items.some(item=>item.library_candidate_id===selected));query.dataset.pdkLibraryQuery=row.probe_id;choices.append(query);
      }
    }
    for(const key of libraryChoiceIds.keys())if(!libraryKeys.has(key))libraryChoiceIds.delete(key);
    if(generic)appendVerilogaHeaders(pdkCard,{controller,opened,onChange:render,onError:reason=>{error=reason.message;notify(error,{kind:'error'});render();}});
    const pdk=detail(pdkCard,'pdk-advanced','高级：候选、搜索范围与模型接口'),hints=detail(pdk,'pdk-hints','可选搜索提示');field(hints,'搜索路径','search-paths',s.hints.search_paths,value=>controller.setHint('search_paths',value),{disabled:locked,placeholder:'每行一个搜索范围',multiline:true});field(hints,'cds.lib 提示','cds-lib',s.hints.cds_lib_hint,value=>controller.setHint('cds_lib_hint',value),{disabled:locked});
    appendScopePicker(pdk,s,locked,connected);
    if(pdkProbes.length){const batch=el('fieldset',undefined,'ic-env-sections');batch.dataset.pdkProbeBatch='';batch.append(el('legend','本批 PDK 匹配主机（选择 1–2 台）'));for(const probe of pdkProbes){const row=el('label'),check=el('input');check.type='checkbox';check.checked=pdkBatch.ids.includes(probe.probe_id);check.dataset.environmentField='pdk-probe-'+probe.probe_id;check.disabled=locked||s.setupDirty||!check.checked&&pdkBatch.ids.length>=2;check.addEventListener('change',()=>{pdkBatch.ids=check.checked?[...pdkBatch.ids,probe.probe_id]:pdkBatch.ids.filter(id=>id!==probe.probe_id);render();});row.append(check,doc.createTextNode(probe.ssh_target));batch.append(row);}pdk.append(batch);note(pdk,'仅匹配本批明确勾选的主机。长扫描可能需要约 5 分钟；请求未确认时先核对原实验。');}
    const pdkBatchReady=pdkBatch.ids.length>=1&&pdkBatch.ids.length<=2&&pdkBatch.ids.every(id=>pdkProbes.some(probe=>probe.probe_id===id));
    pdk.append(button(s.busy==='pdk'?'正在匹配…':'按网表模型匹配 PDK',()=>controller.matchPdk({probe_ids:[...pdkBatch.ids]}),locked||!connected||s.probe.status!=='complete'||s.setupDirty||!pdkBatchReady));
    const directories=s.discovery.result?.discovery.search_directories||[];
    if(s.discovery.result?.discovery.lut)pdk.append(button('忽略索引并重新扫描',()=>controller.matchPdk({refresh:true,probe_ids:[...pdkBatch.ids]}),locked||!connected||s.probe.status!=='complete'||s.setupDirty||!pdkBatchReady));
    if(directories.length){const ranges=el('fieldset',undefined,'ic-env-directories');ranges.append(el('legend','本次观察到的目录（可选）'));for(const directory of directories){const row=el('label',undefined,'ic-env-directory'),input=el('input');input.type='checkbox';input.checked=s.searchDirectoryIds.includes(directory.directory_id);input.disabled=locked;input.dataset.environmentDirectory=directory.directory_id;input.addEventListener('change',call(()=>controller.selectSearchDirectories(input.checked?[...s.searchDirectoryIds,directory.directory_id]:s.searchDirectoryIds.filter(value=>value!==directory.directory_id))));const name=el('span'),probe=s.probe.result.probes.find(item=>item.probe_id===directory.probe_id);name.append(el('strong',directory.label),el('small',(probe?.ssh_target||directory.probe_id)+' · '+(directory.scanned?'已扫描':'尚未扫描')));row.append(input,name);ranges.append(row);}pdk.append(ranges);note(pdk,'选择仅缩小搜索范围，不代表目录内存在合格 PDK。默认不选择，修改后需重新匹配。');if(s.searchDirectoryIds.length)note(pdk,'下次按选中目录搜索，不使用手写搜索路径。');}
    if(s.discovery.status==='complete'){const result=s.discovery.result.discovery;if(!result.candidates.length)note(pdk,pendingLibraries.length?'已有 PDK 索引；当前尚无完成绑定的模型组合，请核对索引覆盖与绑定待处理项。':'本次未形成模型候选，请核对扫描覆盖与待处理项。');evidence(detail(pdk,'coverage','扫描覆盖与待处理项'),{coverage:result.coverage,missing:result.missing,ambiguities:result.ambiguities});}
    for(const item of s.discovery.result?.discovery.candidates||[]){const row=el(generic?'div':'label',undefined,'ic-env-candidate'),input=el('input');input.type='radio';input.name=radioGroup;input.checked=s.candidateId===item.candidate_id;input.disabled=locked||s.searchScopeDirty;input.addEventListener('change',call(()=>controller.selectCandidate(item.candidate_id)));const content=el('span');content.append(el('strong',item.label),el('small','入口类型：'+({definition_only:'模型定义',include_entry_candidate:'include 入口候选'}[item.entry_role]||format(item.entry_role))),el('small','覆盖型号：'+(Array.isArray(item.master_coverage)?item.master_coverage.join('、'):format(item.master_coverage))));if(generic)content.append(el('small','候选：'+item.candidate_id));else row.append(input);row.append(content);pdk.append(row);}
    const chosen=controller.candidate;
    if(chosen&&!generic){
      const corners=el('fieldset',undefined,'ic-env-sections');corners.append(el('legend','Corner / section'));for(const section of chosen.available_sections){const row=el('label'),check=el('input');check.type='checkbox';check.checked=s.sections.includes(section);check.disabled=locked;check.addEventListener('change',call(()=>controller.selectSections(check.checked?[...s.sections,section]:s.sections.filter(value=>value!==section))));row.append(check,doc.createTextNode(section===null?'全局作用域':section));corners.append(row);}pdk.append(corners);if(!chosen.available_sections.length)note(pdk,'此候选未声明 section；准备阶段将验证实际引用闭包。');
      if(chosen.tmi_candidates.length)select(pdk,'TMI 动态库','tmi',[{value:'',label:'由观测平台确认；有歧义时手动选'},...chosen.tmi_candidates.map(item=>({value:item.tmi_candidate_id||item.candidate_id,label:item.label||item.tmi_candidate_id||item.candidate_id}))],s.tmiCandidateId||'',value=>controller.selectTmi(value||null),locked);
      evidence(detail(pdk,'pdk-evidence','匹配依据与缺失项'),{evidence:chosen.evidence,missing:chosen.missing,section_candidates:chosen.section_candidates});
      const contracts=detail(pdk,'contracts','模型极性与有序端口');for(const master of requirements.required_masters){const current=s.modelContracts[master]||{};contracts.append(el('h4',master));select(contracts,'极性','polarity-'+master,[{value:'',label:'明确选择极性'},{value:'n',label:'n'},{value:'p',label:'p'}],current.polarity||'',value=>controller.setModelContract(master,{...current,polarity:value}),locked);field(contracts,'端口角色（与网表顺序一致）','terminals-'+master,(current.terminals||[]).join(' '),value=>controller.setModelContract(master,{...current,terminals:value.trim().split(/[\s,]+/)}),{disabled:locked,placeholder:'例如 d g s b'});}note(contracts,'仅复制扫描证明的模型契约；缺失时需明确填写，不能按型号猜测。');
    }else note(pdk,pendingLibraries.length&&!s.discovery.result?.discovery.candidates.length?'完成模型组合与依赖确认后，再将候选身份写入测试平台。':generic?'在测试平台的 PDK 与主机选择中填写本次候选身份。':'不预选 PDK 或 corner；有多个候选时核对证据后选择。');

    if(generic){const review=card(root,4,'测试平台审阅','冻结后人工确认',{done:step4Done,active:currentStep===4,summaryText:s.session?.agent_tb?.status||''});assistance(review,'testbench','请 Agent 编写 / 修改测试平台');appendAgentTestbench(review,{controller,opened,onError:reason=>{error=reason.message;notify(error,{kind:'error'});render();}});}
    const experimentCard=card(root,generic?5:4,'运行与结果','确认后执行',{done:stepRunDone,active:currentStep===(generic?5:4),summaryText:s.run.result?`${s.run.result.job_id} · ${s.run.result.state}`:''}),start=button(s.busy==='prepare'?'准备中…':s.busy==='run'?'提交中…':'确认并运行',()=>controller.confirmAndRun(),locked||!connected||!s.storageReady||s.run.status==='complete'&&s.preparation.status==='complete'||(s.recommendationMode?!recommendation?.ready_for_prepare:!chosen||!controller.intentReady));start.classList.add('ic-env-primary');start.dataset.environmentConfirmRun='';if(!generic){experimentCard.append(start);note(experimentCard,'按上方条件准备计划，核对最终参数后提交一次。');}
    const experiment=detail(experimentCard,'experiment-advanced','高级：参数、端口与分步操作'),portOptions=[...new Set(requirements?.interfaces?.flatMap(item=>item.ports)||[])];experiment.hidden=generic;for(const [key,name]of intentRows)field(experiment,name,'intent-'+key,s.intent[key],value=>controller.setIntent(key,value),{disabled:locked,placeholder:key.endsWith('_port')?'选择或填写端口':'填写明确数值',list:key.endsWith('_port')?portOptions:null});note(experiment,'全部条件均需明确填写；数值使用表中单位，可写科学计数法。');
    const confirm=el('label',undefined,'ic-sim-consent'),check=el('input');check.type='checkbox';check.dataset.environmentField='confirm-intent';check.checked=s.intentConfirmed;check.disabled=locked||!chosen||!controller.intentReady;check.addEventListener('change',call(()=>controller.confirmIntent(check.checked)));confirm.append(check,doc.createTextNode('确认以上端口、供电、激励、负载、采样与模型契约。'));experiment.append(confirm);experiment.append(button(s.busy==='prepare'?'准备中…':'准备实验',()=>controller.prepare(),locked||!connected||!s.storageReady||!s.intentConfirmed||!chosen||chosen.available_sections.length&&!s.sections.length));resultError(experiment,s.preparation);
    const plan=s.preparation.result?.prepared;if(plan){if(plan.state==='blocked'){note(experiment,'准备受阻，未产生可运行计划。',true);evidence(experiment,plan.missing);}else{note(experiment,'已生成独立源码提交：'+plan.source_commit.slice(0,12));note(experiment,'允许主机范围：'+s.preparation.result.execution_scope.selected_ssh_targets.join('、'));note(experiment,'提交时重新检查依赖与资源，然后在所选范围内选择主机。');experiment.append(button(s.busy==='run'?'提交中…':'提交仿真任务',()=>controller.runPrepared(),locked||!connected||!s.intentConfirmed||s.run.status!=='idle'||s.rejectedSubmissionKeys.includes(plan.submission_key)));}}
    if(s.run.status==='rejected'&&s.run.rejection){const rejection=el('div');rejection.dataset.environmentRejection='';note(rejection,'提交前预检未通过，尚未启动仿真。',true);note(rejection,'资源或依赖预检拒绝了此计划。该提交不会重发；检查环境后，可重新确认条件并准备新计划。');const proof=detail(rejection,'pre-dispatch-rejection','拒绝回执');evidence(proof,{时间:s.run.rejection.rejection.recorded_at,原计划:s.run.rejection.plan_id,原因:s.run.rejection.rejection.code});experimentCard.append(rejection);}
    resultError(experimentCard,s.preparation);resultError(experimentCard,s.run);if(s.run.result){const receipt=s.run.result;note(experimentCard,'任务：'+receipt.job_id+' · '+receipt.state);note(experimentCard,'实际主机：'+format(receipt.execution_target));experimentCard.append(button('更新进度与结果',()=>controller.inspect(),locked||!connected));
      assistance(experimentCard,'diagnosis','请 Agent 诊断此运行');
      const waveformContext={intake:s.session,job:receipt},waveformReady=!!openWaveforms&&onboardingWaveformsAvailable(waveformContext)&&canOpenWaveforms(waveformContext)===true;
      experimentCard.append(button('查看波形',()=>openWaveforms(waveformContext),!!s.busy||!waveformReady));if(!waveformReady)note(experimentCard,'尚无此运行已导出的可用波形。');
      try{appendSimulationReport(experimentCard,{report:receipt.report,runId:receipt.run_id||receipt.job_id,detail});}catch(reason){note(experimentCard,reason.message,true);}if(receipt.measurements)evidence(detail(experimentCard,'measurements','测量结果'),receipt.measurements);appendAnalysis(experimentCard,controller);}
    if(focused){const next=[...root.querySelectorAll('[data-environment-field]')].find(node=>node.dataset.environmentField===focused);next?.focus({preventScroll:true});if(selection&&next?.setSelectionRange)try{next.setSelectionRange(...selection);}catch{}}
  }
  controller=createEnvironmentController({adapter,pendingStore,changed:render,onRun:onRun||(()=>{})});render();
  return {controller,importSource:value=>controller.importSource(value),setAdapter:value=>controller.setAdapter(value),refreshCurrent:binding=>controller.refreshCurrent(binding),destroy(){if(disposed)return;disposed=true;controller.destroy();sheet.remove();root.replaceChildren();}};
}
