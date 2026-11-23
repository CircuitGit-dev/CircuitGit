// Runtime reads are cached evidence. Only the explicit scan action asks for SSH resource checks.
import {simulationReportView,appendSimulationReport} from './report.js';
import {SIMULATION_RESPONSE_LIMIT} from './http.js';
const COMMIT=/^[a-f0-9]{40}$/, PLAN=/^[a-f0-9]{64}$/, ID=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}$/;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// JSON Schema maxLength counts Unicode code points, not UTF-16 code units.
const text=(value,size=240)=>{if(typeof value!=='string')return false;let length=0;for(const character of value)if(++length>size)return false;return true;};
const nullableText=(value,size)=>value===null||text(value,size);
const number=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const timestamp=value=>value===null||text(value,80)&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const requireValid=condition=>{if(!condition)throw Error('资源与监控记录的格式或项目身份不符。');};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const acceptanceStates={execution:['queued','running','completed','failed','cancelled','unknown'],data_validity:['valid','invalid','unknown'],specification:['pass','fail','unknown']};
function validateAcceptance(value){
  requireValid(object(value));
  for(const [key,values]of Object.entries(acceptanceStates))requireValid(values.includes(value[key]));
}
function validateDiagnostics(value){
  requireValid(object(value)&&value.schema==='spiceowl.spectre-diagnostics.v1'&&value.advisory_only===true
    &&value.agent_proposal===null&&object(value.observed_context)&&Array.isArray(value.diagnostics)&&value.diagnostics.length<=32);
  validateAcceptance(value.scientific_acceptance);
  for(const finding of value.diagnostics){
    requireValid(object(finding)&&text(finding.category,180)&&text(finding.code,180)
      &&['error','warning','info'].includes(finding.severity)&&text(finding.redacted_excerpt,1024)
      &&Array.isArray(finding.evidence_line_numbers)&&finding.evidence_line_numbers.length<=32
      &&finding.evidence_line_numbers.every(line=>Number.isSafeInteger(line)&&line>=1)
      &&Array.isArray(finding.suggested_actions)&&finding.suggested_actions.length<=8
      &&finding.suggested_actions.every(action=>text(action,500)));
  }
}

export function normalizeRuntimeSnapshot(value,projectId){
  requireValid(object(value)&&value.schema==='ic.simulation.runtime.v1'&&value.project_id===projectId
    &&typeof projectId==='string'&&ID.test(projectId)&&timestamp(value.read_at)&&value.read_at!==null);
  requireValid(object(value.pool)&&typeof value.pool.configured==='boolean'&&timestamp(value.pool.checked_at)
    &&typeof value.pool.scan_in_progress==='boolean'&&Array.isArray(value.pool.hosts)&&value.pool.hosts.length<=32);
  requireValid(object(value.capabilities)&&['scan','monitor','direct_submit','direct_collect'].every(key=>typeof value.capabilities[key]==='boolean'));
  const hosts=new Set();
  for(const host of value.pool.hosts){
    requireValid(object(host)&&typeof host.host_id==='string'&&ID.test(host.host_id)&&!hosts.has(host.host_id)
      &&text(host.label,160)&&[true,false,null].includes(host.reachable)&&number(host.cpu_busy_percent,0,100)
      &&number(host.load_1m)&&number(host.cpu_count,1)&&number(host.memory_available_bytes)&&number(host.memory_total_bytes)
      &&timestamp(host.observed_at)&&nullableText(host.error_code,180));
    requireValid(host.cpu_count===null||Number.isSafeInteger(host.cpu_count));
    requireValid(host.memory_available_bytes===null||host.memory_total_bytes===null||host.memory_available_bytes<=host.memory_total_bytes);
    hosts.add(host.host_id);
  }
  requireValid(Array.isArray(value.runs)&&value.runs.length<=100);
  const runs=new Set();
  for(const run of value.runs){
    requireValid(object(run)&&typeof run.run_id==='string'&&ID.test(run.run_id)&&!runs.has(run.run_id)
      &&(run.source_commit===null||typeof run.source_commit==='string'&&COMMIT.test(run.source_commit))
      &&nullableText(run.configuration,180)&&object(run.execution)&&text(run.execution.state,180)
      &&(run.execution.exit_code===null||Number.isSafeInteger(run.execution.exit_code)));
    requireValid(run.collectable===undefined||typeof run.collectable==='boolean');
    if(run.execution_target!==null){
      const target=run.execution_target;
      requireValid(object(target)&&['fixed_site','resource_pool'].includes(target.mode)&&target.resource_reservation===false
        &&timestamp(target.resource_observed_at));
      requireValid(target.mode==='fixed_site'?target.host_id===null&&target.plan_id===null:
        typeof target.host_id==='string'&&ID.test(target.host_id)&&typeof target.plan_id==='string'&&PLAN.test(target.plan_id));
    }
    requireValid(object(run.monitor)&&text(run.monitor.state,180)&&timestamp(run.monitor.last_attempt_at)
      &&timestamp(run.monitor.last_success_at)&&timestamp(run.monitor.next_check_at)
      &&Number.isSafeInteger(run.monitor.failures)&&run.monitor.failures>=0);
    validateDiagnostics(run.diagnostics);validateAcceptance(run.acceptance);
    simulationReportView(run.report,run.run_id);
    if(run.report)validateDiagnostics(run.report.diagnostics);
    for(const key of Object.keys(acceptanceStates))requireValid(run.acceptance[key]===run.diagnostics.scientific_acceptance[key]);
    runs.add(run.run_id);
  }
  // Secondary bound for already-decoded data (including synthetic/MCP hosts).
  // The HTTP adapter separately counts the original envelope's response bytes.
  requireValid(new TextEncoder().encode(JSON.stringify(value)).byteLength<=SIMULATION_RESPONSE_LIMIT);
  return freeze(structuredClone(value));
}

export function resourceFreshness(host,now=Date.now()){
  if(host.observed_at===null)return {state:'unknown',label:'尚无资源观察'};
  const age=now-Date.parse(host.observed_at);
  if(!Number.isFinite(age)||age<0)return {state:'unknown',label:'观察时间异常'};
  if(age>120000)return {state:'stale',label:'资源观察已过期'};
  if(host.error_code||host.reachable!==true)return {state:'unknown',label:'资源检查未确认'};
  return {state:'recent',label:'近期资源观察'};
}

const readyProject=context=>context?.loadState==='ready'&&!context.loading&&typeof context.project?.id==='string'&&ID.test(context.project.id)?context.project.id:null;

export function createRuntimeController(host,{changed=()=>{},isVisible=()=>true,setIntervalFn=setInterval,clearIntervalFn=clearInterval}={}){
  let disposed=false,active=true,epoch=0,pending=Promise.resolve(null),scanPending=null,scanBaseline=null,scanObserved=false;
  const state={projectId:null,status:'idle',snapshot:null,error:null,scanState:'idle',scanError:null};
  const notify=()=>{if(!disposed)changed();};
  const visible=()=>active&&!disposed&&isVisible();
  const currentProject=()=>readyProject(host.context.getContext());
  function refresh({force=false}={}){
    if(disposed||!state.projectId||currentProject()!==state.projectId||!force&&!visible())return Promise.resolve(null);
    if(state.status==='loading')return pending;
    const projectId=state.projectId,ticket=epoch;
    state.status='loading';state.error=null;
    pending=Promise.resolve().then(async()=>{
      if(disposed||ticket!==epoch)return null;
      try{
        const value=await host.gateway.request('/simulation/runtime?'+new URLSearchParams({project_id:projectId}),{method:'GET'});
        if(disposed||ticket!==epoch||currentProject()!==projectId)return null;
        state.snapshot=normalizeRuntimeSnapshot(value,projectId);state.status='ready';
        if(state.scanState==='requested'){
          scanObserved ||= state.snapshot.pool.scan_in_progress;
          if(!state.snapshot.pool.scan_in_progress&&(scanObserved||state.snapshot.pool.checked_at!==scanBaseline))state.scanState='idle';
        }
        return state.snapshot;
      }catch(error){
        if(disposed||ticket!==epoch)return null;
        state.status=error?.status===404?'unavailable':'error';state.error=String(error?.message||'无法读取运行缓存。').slice(0,500);
        return null;
      }finally{if(!disposed&&ticket===epoch)notify();}
    });
    notify();return pending;
  }
  function synchronize(){
    if(disposed)return;
    const projectId=currentProject();
    if(projectId!==state.projectId){
      epoch++;state.projectId=projectId;state.status='idle';state.snapshot=null;state.error=null;state.scanState='idle';state.scanError=null;scanPending=null;scanBaseline=null;scanObserved=false;
      refresh();
    }
    notify();
  }
  function canScan(){return !disposed&&state.status==='ready'&&state.snapshot?.pool.configured===true
    &&state.snapshot.capabilities.scan===true&&!state.snapshot.pool.scan_in_progress&&!['requesting','requested'].includes(state.scanState)
    &&currentProject()===state.projectId;}
  async function scan(){
    if(!canScan())throw Error('当前项目未开放资源扫描，或已有扫描正在进行。');
    if(scanPending)return scanPending;
    const projectId=state.projectId,ticket=epoch;
    state.scanState='requesting';state.scanError=null;scanBaseline=state.snapshot.pool.checked_at;scanObserved=false;notify();
    scanPending=Promise.resolve().then(async()=>{
      try{
        await host.gateway.request('/simulation/resources/scan',{method:'POST',body:{project_id:projectId}});
        if(disposed||ticket!==epoch)return;
        state.scanState='requested';
      }catch(error){
        if(!disposed&&ticket===epoch){state.scanState='unknown';state.scanError=String(error?.message||'资源检查请求未确认。').slice(0,500);}
        throw error;
      }finally{
        if(!disposed&&ticket===epoch){scanPending=null;notify();await refresh({force:true});}
      }
    });
    return scanPending;
  }
  const unsubscribe=host.context.subscribe(synchronize);
  const timer=setIntervalFn(()=>{if(visible()){notify();if(state.status!=='unavailable')refresh();}},5000);
  synchronize();
  return {get state(){return {...state};},ready:()=>pending,refresh,scan,canScan,
    setActive(value){const before=active;active=value===true;if(active&&!before)refresh();},
    visibilityChanged(){if(visible())refresh();},
    destroy(){if(disposed)return;disposed=true;epoch++;clearIntervalFn(timer);unsubscribe();}};
}

const time=value=>value||'未记录';
const metric=(value,suffix='',divisor=1)=>value===null?'未知':`${Number((value/divisor).toFixed(1))}${suffix}`;

export function mountRuntime(root,{host,actions={},actionPolicy=()=>({})}){
  const doc=root.ownerDocument;let controller=null,disposed=false,actionBusy=false;
  const opened=new Set();
  function el(tag,value,className){const node=doc.createElement(tag);if(value!==undefined)node.textContent=value;if(className)node.className=className;return node;}
  const note=(parent,value,kind='ic-sim-note')=>parent.append(el('p',value,kind));
  function button(label,fn,disabled,action){
    const node=el('button',label);node.type='button';node.disabled=!!disabled;if(action)node.dataset.runtimeAction=action;
    node.addEventListener('click',()=>Promise.resolve().then(fn).catch(error=>{if(!disposed)host.notify?.(String(error?.message||error),{kind:'error'});}));return node;
  }
  function detail(parent,key,label){
    const box=el('details',undefined,'ic-sim-detail');box.dataset.runtimeDetail=key;box.open=opened.has(key);
    box.append(el('summary',label));box.addEventListener('toggle',()=>{if(box.isConnected)box.open?opened.add(key):opened.delete(key);});parent.append(box);return box;
  }
  const visible=()=>root.isConnected&&!doc.hidden&&!root.closest('[hidden], [aria-hidden="true"]')&&root.getClientRects().length>0;
  function allowed(kind,run){
    const state=controller?.state,policy=actionPolicy(run)||{};
    return state?.status==='ready'&&!actionBusy&&state.snapshot?.capabilities[kind==='submit'?'direct_submit':'direct_collect']===true
      &&(kind!=='collect'||run?.collectable===true)
      &&typeof actions[kind]==='function'&&policy[kind]===true;
  }
  async function act(kind,run){
    if(!allowed(kind,run))throw Error('当前状态未开放此操作。');
    actionBusy=true;render();
    try{await actions[kind](run);}
    finally{actionBusy=false;if(!disposed){render();await controller.refresh({force:true});}}
  }
  function render(){
    if(disposed||!controller)return;
    for(const box of root.querySelectorAll('[data-runtime-detail]'))box.open?opened.add(box.dataset.runtimeDetail):opened.delete(box.dataset.runtimeDetail);
    const state=controller.state,snapshot=state.snapshot;
    root.replaceChildren();root.classList.add('ic-sim-runtime');root.setAttribute('aria-label','仿真资源与监控');
    const heading=el('div',undefined,'ic-sim-section-head');heading.append(el('h3','资源与监控'));
    heading.append(button('读取缓存',()=>controller.refresh({force:true}),!state.projectId||state.status==='loading','refresh'));root.append(heading);
    note(root,'此页可见时每 5 秒读取缓存；资源检查需明确点击。观察时间保留原值。');
    if(!state.projectId){note(root,'等待当前项目加载完成。');return;}
    if(state.status==='unavailable'){note(root,'当前网关未提供资源与监控接口。','ic-sim-warning');if(!snapshot)return;}
    if(state.status==='error'){note(root,'缓存读取失败：'+state.error,'ic-sim-warning');if(!snapshot)return;}
    if(!snapshot){note(root,'正在读取当前项目的缓存…');return;}
    if(state.status!=='ready')note(root,'以下为上次成功读取的记录，当前状态尚未更新。','ic-sim-warning');
    note(root,'缓存读取时间：'+snapshot.read_at);
    const toolbar=el('div',undefined,'ic-sim-toolbar');
    toolbar.append(button(snapshot.pool.scan_in_progress||state.scanState==='requesting'?'资源检查进行中…':'检查服务器资源',()=>controller.scan(),!controller.canScan(),'scan'));
    toolbar.append(button(actionBusy?'操作进行中…':'提交当前配置',()=>act('submit'),!allowed('submit'),'submit'));root.append(toolbar);
    if(!snapshot.pool.configured)note(root,'未配置服务器资源池；资源扫描不可用。');
    else note(root,'最近一次资源检查：'+time(snapshot.pool.checked_at)+' · 资源观察超过 2 分钟会标为过期。');
    if(state.scanState==='requested')note(root,'资源检查已请求，完成状态以之后读取的缓存为准。');
    if(state.scanError)note(root,'资源检查请求未确认：'+state.scanError+' 未自动重发；请先核对缓存。','ic-sim-warning');
    const hosts=el('div',undefined,'ic-runtime-hosts');root.append(hosts);
    for(const host of snapshot.pool.hosts){
      const card=el('article',undefined,'ic-sim-card ic-runtime-host');card.dataset.runtimeHost=host.host_id;
      const title=el('div',undefined,'ic-sim-section-head'),freshness=resourceFreshness(host);
      title.append(el('h3',host.label||host.host_id),el('span',freshness.label,'ic-sim-status '+(freshness.state==='recent'?'':'warning')));card.append(title);
      note(card,host.host_id+' · '+(host.reachable===true?'连接已确认':host.reachable===false?'连接失败':'连接未知'));
      const metrics=el('dl',undefined,'ic-runtime-metrics');
      for(const [label,value]of [['CPU 忙碌',metric(host.cpu_busy_percent,'%')],['CPU 数量',metric(host.cpu_count)],['1 分钟负载',metric(host.load_1m)],['可用内存',metric(host.memory_available_bytes,' GiB',2**30)],['总内存',metric(host.memory_total_bytes,' GiB',2**30)]])metrics.append(el('dt',label),el('dd',value));
      card.append(metrics);note(card,'原始资源观察：'+time(host.observed_at));if(host.error_code)note(card,host.error_code,'ic-sim-warning');hosts.append(card);
    }
    if(snapshot.pool.configured&&!snapshot.pool.hosts.length)note(root,'尚无服务器资源记录。');
    root.append(el('h3','运行监控与验收'));
    note(root,'各项结论来自保存的验收报告；执行结束不代表科学验收通过。');
    if(!snapshot.runs.length)note(root,'当前项目尚无运行记录。');
    for(const run of snapshot.runs){
      const card=el('article',undefined,'ic-sim-card ic-runtime-run');card.dataset.runtimeRun=run.run_id;
      const title=el('div',undefined,'ic-sim-section-head');title.append(el('h3',run.configuration||run.run_id),el('span',run.execution.state,'ic-sim-status'));card.append(title);
      note(card,run.run_id+' · 源码 '+(run.source_commit?run.source_commit.slice(0,12):'未记录'));
      if(run.execution_target?.host_id)note(card,'运行服务器：'+run.execution_target.host_id);
      appendSimulationReport(card,{report:run.report,runId:run.run_id,detail});
      note(card,'退出码：'+(run.execution.exit_code===null?'未记录':run.execution.exit_code));
      const monitor=detail(card,'monitor-'+run.run_id,'监控记录 · '+run.monitor.state);
      for(const [label,value]of [['最近尝试',time(run.monitor.last_attempt_at)],['最近成功观察',time(run.monitor.last_success_at)],['下次检查',time(run.monitor.next_check_at)],['连续失败',String(run.monitor.failures)]])note(monitor,label+'：'+value);
      const findings=run.report?.diagnostics.diagnostics||run.diagnostics.diagnostics;
      const diagnostics=detail(card,'diagnostics-'+run.run_id,'诊断建议 · '+findings.length+' 项');
      note(diagnostics,'以下为建议；显示这些内容不会执行操作。');
      for(const finding of findings){
        const row=el('div',undefined,'ic-runtime-finding');row.append(el('strong',finding.category+' · '+finding.code));note(row,'级别：'+finding.severity);
        const list=el('ul');finding.suggested_actions.forEach(action=>list.append(el('li',action)));row.append(list);
        if(finding.evidence_line_numbers.length)note(row,'日志行：'+finding.evidence_line_numbers.join(', '));
        if(finding.redacted_excerpt)row.append(el('pre',finding.redacted_excerpt,'ic-sim-code'));diagnostics.append(row);
      }
      card.append(button('收集此运行结果',()=>act('collect',run),!allowed('collect',run),'collect'));root.append(card);
    }
  }
  controller=createRuntimeController(host,{changed:render,isVisible:visible});render();
  const onVisibility=()=>controller.visibilityChanged();doc.addEventListener('visibilitychange',onVisibility);
  return {controller,setActive(value){controller.setActive(value);render();},update:render,
    destroy(){if(disposed)return;disposed=true;controller.destroy();doc.removeEventListener('visibilitychange',onVisibility);root.replaceChildren();}};
}
