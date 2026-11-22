import {createSimulationController} from './controller.js';
import {createViewClient} from './view-client.js';
import {parseConfiguration,editableConfiguration,approvalInstructions,requestLabel,runId,ACTIVE_RUN_STATES,publicationVerified} from './domain.js';


export function validateSimulationLocalState(saved,binding){
  if(saved?.schema!=='ic.simulation.local.v1'||JSON.stringify(saved.binding)!==JSON.stringify(binding))throw Error('仿真恢复状态与此视图/配置/source不一致。');
  if(typeof saved.text!=='string'||new TextEncoder().encode(saved.text).length>1024*1024)throw Error('恢复的原始编辑文本超限。');
  return saved;
}

export async function mount(root,host){
  if(!root||typeof host?.call!=='function')throw Error('Simulation window requires an MCP Apps host.');
  const style=document.createElement('style');
  style.textContent=await host.assetText('apps/codex/ui/simulation/style.css');root.append(style);
  const app=document.createElement('section');app.className='ic-mcp-simulation';app.classList.toggle('embedded',host.embedded===true);app.setAttribute('aria-label','仿真配置窗口');root.append(app);
  let visible=true,closing=false,pendingResult=null,renderPending=false,recoveredText=null,restoring=false,savedFields=null,loadingLocal=null;
  let controller,disposed=false,tab='configuration',targetKind='voltage',targetPath='',terminal='',localError=null;
  const detailsOpen=new Set();
  const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};
  const invoke=fn=>()=>{localError=null;Promise.resolve().then(fn).catch(error=>{localError=error.message;render();});};
  function button(label,fn,disabled=false,cls=''){const b=el('button',label,cls);b.type='button';b.disabled=disabled;b.addEventListener('click',invoke(fn));return b;}
  function code(parent,value,cls=''){const pre=el('pre',typeof value==='string'?value:JSON.stringify(value,null,2),cls);parent.append(pre);return pre;}
  function detail(parent,id,label){const box=el('details');box.open=detailsOpen.has(id);box.append(el('summary',label));box.addEventListener('toggle',()=>box.open?detailsOpen.add(id):detailsOpen.delete(id));parent.append(box);return box;}
  function input(parent,label,key,value,placeholder,onChange,{disabled=false,type='text'}={}){const wrap=el('label',null,'field');wrap.append(el('span',label));const field=el('input');field.type=type;field.value=value??'';field.placeholder=placeholder??'';field.disabled=disabled;field.dataset.field=key;field.addEventListener('change',invoke(()=>onChange(field.value)));wrap.append(field);parent.append(wrap);return field;}
  function select(parent,label,key,options,value,onChange,disabled=false){const wrap=el('label',null,'field');wrap.append(el('span',label));const field=el('select');field.dataset.field=key;field.disabled=disabled;for(const [v,name] of options){const option=el('option',name);option.value=v;field.append(option);}field.value=value??'';field.addEventListener('change',invoke(()=>onChange(field.value)));wrap.append(field);parent.append(wrap);return field;}
  function note(parent,text,kind='note'){parent.append(el('p',text,kind));}
  const section=(parent,title)=>{const block=el('section',null,'card');block.append(el('h2',title));parent.append(block);return block;};
  function toolbar(parent){const div=el('div',null,'actions');parent.append(div);return div;}
  function render(){
    if(!controller||disposed)return;if(!visible){renderPending=true;return;}
    if(recoveredText!==null&&!controller.blocked()&&controller.state.descriptor&&!restoring){const text=recoveredText;recoveredText=null;restoring=true;try{controller.setText(text);}catch(error){recoveredText=text;localError=error.message;}finally{restoring=false;}}
    const s=recoveredText===null?controller.state:{...controller.state,text:recoveredText},d=s.descriptor,e=s.review?.effective||d?.effective;
    const active=app.contains(document.activeElement)?document.activeElement:null,focus=active?.dataset.field,selection=active&&['TEXTAREA','INPUT'].includes(active.tagName)?[active.selectionStart,active.selectionEnd]:null;
    app.replaceChildren();const header=el('header',null,'window-heading');header.append(el('div','SIMULATION','eyebrow'),el('h1','仿真配置'),el('span',s.busy||'版本化输入 · 人工审批','mode'));app.append(header);
    if(s.view){const tags=el('div',null,'identity');for(const item of [['项目',s.view.identity.project_id],['配置',s.view.identity.configuration],['commit',s.view.identity.source_commit],['workspace',s.view.workspace_id],['run',s.view.identity.run_id||'未绑定'],['view',s.view.view_id],['revision',s.view.revision]])tags.append(el('span',item[0]+' '+item[1]));if(host.embedded){const identityDetails=detail(app,'identity','运行与视图身份');identityDetails.append(tags);}else app.append(tags);}
    const tabs=el('nav',null,'tabs');tabs.setAttribute('aria-label','仿真窗口内容');for(const [id,name] of [['configuration','配置与信号'],['review','Diff / 计划'],['requests','人工审批 '+s.requests.length],['jobs','本地任务 '+s.jobs.length]]){const b=button(name,()=>{tab=id;render();},false,tab===id?'selected':'');b.setAttribute('aria-current',tab===id?'page':'false');tabs.append(b);}app.append(tabs);
    if(recoveredText!==null)note(app,'关闭前的原始编辑文本已恢复；当前请求状态阻止编辑时仍保留，未提交配置。','warning');
    if(s.error||localError)note(app,s.error||localError,'error');
    if(s.suspended)note(app,'身份或协议需要核对。草稿和请求已保留；不会重试写操作。','warning');
    if(s.notice)note(app,s.notice);
    const actions=toolbar(app);actions.append(button('重新读取窗口',()=>controller.reload(),!!s.busy));
    const drafts=controller.drafts();if(drafts.length){const saved=detail(app,'drafts','已保留草稿 '+drafts.length+' · 各自绑定原 commit');for(const draft of drafts){note(saved,`${draft.identity.project_id} / ${draft.identity.configuration} @ ${draft.identity.source_commit}`);const text=el('textarea');text.readOnly=true;text.value=draft.text;text.rows=4;saved.append(text);saved.append(button('丢弃此草稿',()=>{if(window.confirm('丢弃此窗口草稿（含已保存的窗口状态）并恢复已提交配置？'))return controller.discard(draft.key,true);},!!s.busy));}}
    if(tab==='requests')renderRequests(app,s);
    else if(tab==='jobs')renderJobs(app,s);
    else if(s.configurationUnavailable)note(app,'历史运行窗口不提供当前配置编辑。请打开「本地任务」查看绑定运行的保存结果。');
    else if(!d)note(app,s.busy?'读取已提交配置和本地任务…':'没有可用配置描述。窗口不会伪造生效参数。');
    else if(tab==='review')renderReview(app,s,e);
    else renderConfiguration(app,s,d,e);
    if(savedFields){for(const [key,value] of Object.entries(savedFields)){const field=[...app.querySelectorAll('[data-field]')].find(x=>x.dataset.field===key);if(field&&key!=='json')field.value=value;}savedFields=null;}
    if(focus){const next=[...app.querySelectorAll('[data-field]')].find(x=>x.dataset.field===focus);if(next){next.focus({preventScroll:true});if(selection?.[0]!=null&&next.setSelectionRange){try{next.setSelectionRange(...selection);}catch{}}}}
  }
  function renderConfiguration(parent,s,d,e){
    const blocked=controller.blocked();
    let conf=null;try{conf=editableConfiguration(parseConfiguration(s.text));}catch(error){note(parent,error.message,'error');}
    const form=el('div',null,'configuration-grid');parent.append(form);
    const analysis=section(form,'Transient 分析');
    note(analysis,'配置和 source commit 固定于此窗口。更换版本需通过 ic_simulation_open 创建新窗口，并沿用 workspace_id。');
    note(analysis,'留空继承模板。表单只修改窗口草稿；生效值以已提交配置或当前 diff 编译结果为准。');
    if(conf)for(const name of d.editable_analysis_fields||['stop','maxstep','errpreset','method','maxiters'])if(Object.hasOwn(e.tran.values,name))input(analysis,name,'analysis-'+name,conf.analysis?.[name]??'',e.tran.values[name],value=>controller.edit(['analysis',name],value===''?undefined:value),{disabled:blocked});
    note(analysis,`已核对 stop: ${e.tran.values.stop||'未声明'}${e.tran.values_si?.stop!=null?' = '+Number((e.tran.values_si.stop*1e9).toPrecision(6))+' ns':''} · maxstep: ${e.tran.values.maxstep||'未声明'}`,'effective');
    const params=detail(analysis,'parameters','有效参数与 overrides · '+Object.keys(e.parameters).length);if(conf)for(const [name,value] of Object.entries(e.parameters))input(params,name,'param-'+name,conf.parameters?.[name]??'',value,v=>controller.edit(['parameters',name],v===''?undefined:v),{disabled:blocked});
    const defaults=detail(analysis,'tran-defaults','完整 tran / simulator / template defaults');code(defaults,{tran:e.tran.statements,simulator:e.simulator,template_reference:d.template_reference});
    const signals=section(form,'Spectre raw 保存');note(signals,'结构化选择写入派生仿真输入；原模板 save 和 OCEAN 导出各自显示。');
    const info=e.raw_save;
    if(conf){
      select(signals,'模式','save-mode',[['inherit','继承模板'],['append','追加显式信号'],['replace','替换受支持的清单']],conf.save?.mode||'inherit',mode=>{
        if(mode==='inherit')return controller.edit(['save'],undefined);
        const inherited=d.effective.raw_save.inherited.signals.map(x=>x.kind==='voltage'?{kind:'voltage',path:x.path}:{kind:'current',instance:x.instance,terminal:x.terminal});
        controller.edit(['save'],{...(conf.save||{}),mode,signals:conf.save?.signals||(mode==='replace'?inherited:[])});
      },blocked);
      if(conf.save){const selected=Array.isArray(conf.save.signals)?conf.save.signals:[];const list=el('div',null,'signal-list');signals.append(list);selected.forEach((item,i)=>{const row=el('div',null,'signal-row');row.append(el('code',item?.kind==='current'?item.instance+':'+item.terminal:item?.path||JSON.stringify(item)),button('移除',()=>controller.edit(['save','signals'],selected.filter((_,j)=>i!==j)),blocked));list.append(row);});
        select(signals,'类型','kind',[['voltage','电压 / net'],['current','电流 / instance-terminal']],targetKind,value=>{targetKind=value;targetPath='';terminal='';render();},blocked);
        const catalog=targetKind==='voltage'?d.catalog?.nets||[]:d.catalog?.instances||[];
        const field=input(signals,targetKind==='voltage'?'net':'instance','target',targetPath,'完整已验证路径',value=>{targetPath=value;terminal='';render();},{disabled:blocked});
        const options=el('datalist');options.id='targets-'+crypto.randomUUID();field.setAttribute('list',options.id);for(const item of catalog.filter(x=>!targetPath||x.path.toLowerCase().includes(targetPath.toLowerCase())).slice(0,80)){const option=el('option');option.value=item.path;options.append(option);}signals.append(options);
        const target=catalog.find(x=>x.path===targetPath);
        if(targetKind==='current'&&target)select(signals,'明确终端','terminal',[['','选择终端'],...(target.terminals||[]).map(t=>[t.id,`${t.id} · ${t.label} → ${t.net}`])],terminal,value=>{terminal=value;render();},blocked);
        if(target?.source)note(signals,`${target.source.path}:${target.source.line_start}`,'identity-note');
        const add=()=>controller.edit(['save','signals'],[...selected,targetKind==='voltage'?{kind:'voltage',path:targetPath}:{kind:'current',instance:targetPath,terminal}]);
        signals.append(button('加入 raw 保存',add,blocked||!target||(targetKind==='current'&&!terminal)||selected.length>=(d.save_limits?.max_signals||256)));
        if(!catalog.length)note(signals,'此描述未提供目标目录。已有选择仍保留；不能凭空生成 net 或 terminal。','warning');
      }
    }
    const effective=detail(signals,'save-effective','实际显式保存 '+info.effective.signals.length+' 个 · '+info.mode);code(effective,info.effective.signals.map(x=>`${x.spectre} [${(x.origins||[]).map(o=>o.path+':'+o.line_start).join(', ')}]`).join('\n'));
    const raw=detail(signals,'raw-defaults','继承指令、policy 与限制');code(raw,{inherited:info.inherited.directives,policy:info.effective.policy,unresolved:info.effective.unresolved_directives,limitations:info.effective.limitations});note(raw,info.effective.implicit_defaults||'未声明选项仍采用模拟器默认值。');
    const ocean=section(form,'OCEAN 导出');note(ocean,'仅从已保存 raw 中提取曲线，不决定所有原始保存量。');
    if(conf?.postprocess&&typeof conf.postprocess==='object')for(const name of ['start_s','end_s','step_s','max_display_points'])input(ocean,name,'pp-'+name,conf.postprocess[name],String(e.postprocess?.[name]??''),value=>controller.edit(['postprocess',name],value===''?undefined:Number(value)),{disabled:blocked,type:'number'});
    code(ocean,e.postprocess);note(ocean,'完整导出信号可在 JSON 中编辑；未知字段保留并由已有编译器明确校验。');
    const json=section(form,'版本化配置 JSON');json.classList.add('wide');const editor=el('textarea');editor.rows=10;editor.spellcheck=false;editor.value=s.text;editor.disabled=blocked;editor.dataset.field='json';editor.addEventListener('input',()=>{try{controller.setText(editor.value);recoveredText=null;}catch(error){localError=error.message;render();}});json.append(editor);
    note(json,`本地草稿 revision ${s.draftVersion} · ${s.draftStoredVersion===s.draftVersion?'已保存窗口状态':'尚未保存窗口状态'} · ${controller.dirty()?'尚未提交配置':'与已提交配置一致'}`);
    const actions=toolbar(json);actions.append(button('保存窗口草稿',()=>controller.storeDraft(),blocked||!conf),button('编译 / 预览 Diff',async()=>{await controller.preview();tab='review';render();},blocked||!conf||!controller.dirty(),'primary'));
  }
  function renderReview(parent,s,e){
    const blocked=controller.blocked();
    const diff=section(parent,'配置差异与编译产物');note(diff,'Diff 由已有受控编译器生成。申请提交只创建 pending_approval，不会在本窗口批准或写入生产。');
    if(s.review){code(diff,s.review.response.diff);code(diff,{review_id:s.review.response.review_id,source_commit:s.view.identity.source_commit,compiled_inputs_sha256:s.review.effective.compiled_inputs_sha256,raw_save_count:s.review.effective.raw_save.effective.signals.length,tran:s.review.effective.tran.values});}
    else note(diff,'当前没有与草稿匹配的有效 Diff。');
    toolbar(diff).append(button('重新预览',()=>controller.preview(),blocked||!controller.dirty()),button('申请配置提交 · 待人工审批',async()=>{await controller.requestApply();tab='requests';render();},blocked||!s.review,'primary'));
    const plan=section(parent,'已提交版本的仿真计划');note(plan,'计划只进行本地编译和物化。真实远端预检和求解不会自动执行；提交请求仍须人工审批。');
    if(s.plan)code(plan,{identity:s.plan.response.source_commit,simulator:s.plan.response.simulator,inputs:s.plan.response.inputs,settings:s.plan.response.settings,blockers:s.plan.response.blockers});
    toolbar(plan).append(button('生成本地计划',()=>controller.plan(),blocked||controller.dirty()),button('申请仿真提交 · 待人工审批',async()=>{await controller.requestSubmit();tab='requests';render();},blocked||!s.plan,'primary'));
    note(plan,'本窗口没有直接 push 或 approve 接口。MCP 的配置 apply 保持现有 push:false；私有 GitHub 发布通过受控请求处理。');
  }
  function renderRequests(parent,s){
    const box=section(parent,'人工审批请求');note(box,'点击「在Codex中审核」后，由 Codex 宿主收集您的决定。核对冻结请求后勾选批准并提交，或选择拒绝、取消。审核等待超过 120 秒会保留待审核状态。');
    if(!s.requests.length)note(box,'本窗口尚无请求。');
    for(const attempt of [...s.requests].reverse()){const card=section(box,attempt.operation);const receipt=attempt.receipt;
      if(!receipt){note(card,'请求响应未知；保留原幂等键。不可重新生成请求或自动重试。','error');code(card,{identity:attempt.source_commit,arguments:attempt.arguments,error:attempt.error});continue;}
      note(card,requestLabel(receipt),receipt.state==='pending_approval'?'warning':receipt.state==='uncertain'?'error':'effective');
      code(card,{request_id:receipt.request_id,fingerprint:receipt.fingerprint,operation:receipt.operation,state:receipt.state,source_commit:attempt.source_commit,arguments:receipt.arguments,result:receipt.result,error:receipt.error});
      const review=detail(card,'req-'+receipt.request_id,'冻结请求的 review');code(review,receipt.review);
      if(receipt.state==='pending_approval'){const manual=approvalInstructions(receipt),fallback=detail(card,'cli-'+receipt.request_id,'兼容 CLI 人工审核');note(fallback,manual.notice);code(fallback,manual.approve);code(fallback,manual.deny);}
      const actions=toolbar(card);actions.append(button('刷新保存的请求状态',()=>controller.requestStatus(receipt.request_id),!!s.busy));
      if(receipt.state==='pending_approval')actions.append(button('在Codex中审核',()=>controller.requestReview(receipt.request_id),!!s.busy||s.suspended,'primary'));
      if(attempt.operation==='sim_submit'&&receipt.state==='accepted'&&runId(receipt.result))actions.append(button('绑定此提交回执的运行',()=>controller.bindAcceptedRun(receipt.request_id),!!s.busy||s.view.identity.run_id===runId(receipt.result)));
      if(attempt.operation==='apply'&&receipt.state==='accepted')actions.append(button('显示新 commit 的开窗参数',()=>controller.readAcceptedCommit(receipt.request_id),!!s.busy));
    }
    if(s.newView){note(box,'用下列明确身份打开新窗口；当前窗口继续保留原版本和回执。');code(box,s.newView);}
  }
  function renderJobs(parent,s){
    const header=section(parent,'本地任务与已有结果');note(header,'只读取已保存的任务列表与结果；不调用单 run 远端状态检查，也不自动收集或发布。');
    if(s.newView){note(header,'用此明确身份打开独立窗口，沿用当前 workspace：');code(header,s.newView);}
    if(!s.view?.identity.run_id)note(header,'当前窗口未绑定 run。列表仍可查看保存的收集/发布摘要；详情、collect 和 archive 需要明确绑定运行的新窗口。','warning');
    toolbar(header).append(button('刷新本地列表',()=>controller.refreshJobs(),!!s.busy));
    for(const run of s.jobs){const id=runId(run),card=section(header,run.configuration||run.configuration_id||run.project_id||id);card.dataset.runId=id;
      note(card,id+' · '+(ACTIVE_RUN_STATES.has(run.state)?'活动回执：':'')+run.state,'identity-note');note(card,'source '+run.source_commit);
      const actions=toolbar(card);actions.append(button(s.selectedRun===id?'已选中':'选择任务',()=>controller.chooseRun(id),!!s.busy),button('读取本地结果',()=>controller.results(id),!!s.busy||s.view?.identity.run_id!==id));
      if(s.view?.identity.run_id!==id)actions.append(button('显示此 run 的开窗参数',()=>controller.showRunWindow(id),!!s.busy));
      const result=s.results.get(id),pub=result?.publication||run.publication,col=result?.collection||run.collection;
      note(card,publicationVerified(run,pub,col)?'保存的发布核验回执完整。':'状态以已有回执为准，不保证进程此刻仍存活。');
      const evidence=detail(card,'run-'+id,'保存的收集 / 发布回执');code(evidence,{source_commit:run.source_commit,collection:col,publication:pub,metrics:result?.metrics,summary:result?.summary,artifacts:result?.artifacts});
      if(s.selectedRun===id){const policy=controller.runPolicy(id);note(card,policy.reason);if(!policy.archived)actions.append(button('申请完整收集 · 待审批',async()=>{await controller.requestCollect();tab='requests';render();},!!s.busy||!policy.collect),button('申请私有 GitHub 归档 · 待审批',async()=>{await controller.requestArchive();tab='requests';render();},!!s.busy||!policy.archive));}
    }
  }
  const controllerHost={...host,get initial(){return host.view||host.initial;},
    onResult(listener){return host.onResult(value=>{if(!visible||closing){pendingResult=value;return;}listener(value);});},
    updateModelContext(value){return visible&&!closing?host.updateModelContext?.(value):Promise.resolve();}};
  controller=createSimulationController(controllerHost,createViewClient(controllerHost),render);render();
  const localBinding=()=>{const v=controller.state.view||host.initial;return {workspace_id:v.workspace_id,view_id:v.view_id,identity:v.identity};};
  async function restoreLocal(){
    loadingLocal=host.loadLocalState?await host.loadLocalState():null;await controller.ready();if(disposed||!loadingLocal)return;
    const saved=validateSimulationLocalState(loadingLocal,localBinding());
    tab=['configuration','review','requests','jobs'].includes(saved.tab)?saved.tab:'configuration';targetKind=['voltage','current'].includes(saved.targetKind)?saved.targetKind:'voltage';
    targetPath=typeof saved.targetPath==='string'?saved.targetPath:'';terminal=typeof saved.terminal==='string'?saved.terminal:'';
    for(const key of Array.isArray(saved.detailsOpen)?saved.detailsOpen:[])if(typeof key==='string')detailsOpen.add(key);
    savedFields=saved.fields&&typeof saved.fields==='object'?saved.fields:null;
    if(saved.text!==controller.state.text)recoveredText=saved.text;
    if(saved.selectedRun&&controller.state.jobs.some(j=>runId(j)===saved.selectedRun)&&!controller.state.busy)await controller.chooseRun(saved.selectedRun);
    render();
  }
  const ready=restoreLocal().catch(error=>{localError=error.message;render();});
  function localSnapshot(){
    const editor=app.querySelector('[data-field="json"]'),fields={};for(const field of app.querySelectorAll('[data-field]'))if(field.dataset.field!=='json')fields[field.dataset.field]=field.value;
    return {schema:'ic.simulation.local.v1',binding:localBinding(),text:editor?.value??recoveredText??controller.state.text,
      tab,targetKind,targetPath,terminal,detailsOpen:[...detailsOpen],fields,selectedRun:controller.state.selectedRun,
      pending_request_ids:controller.state.requests.map(a=>a.receipt?.request_id).filter(Boolean)};
  }
  async function beforeClose(){
    if(disposed)return;closing=true;
    try{await ready;if(typeof host.saveLocalState!=='function')throw Error('宿主尚未提供草稿快照保存；请保持面板打开。');
      // Save raw editor text, even invalid JSON or while a human review is pending. No controller.storeDraft/review/run action.
      await host.saveLocalState(localSnapshot());
    }catch(error){closing=false;localError=error.message;render();throw error;}
  }
  function setVisible(value){if(disposed)return;visible=value===true;app.inert=!visible;
    if(visible){if(pendingResult){const next=pendingResult;pendingResult=null;void controller.acceptResult(next).catch(error=>{localError=error.message;render();});}if(renderPending){renderPending=false;render();}}}
  function resize(){if(visible&&!disposed)app.style.setProperty('--component-width',app.clientWidth+'px');}

  const protect=event=>{if((recoveredText??controller.state.text)!==controller.state.storedText){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',protect);
  return {ready,beforeClose,setVisible,resize,dispose(){disposed=true;window.removeEventListener('beforeunload',protect);controller.dispose();app.remove();style.remove();}};
}
