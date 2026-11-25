// One explicitly selected intake/run in the existing waveform viewer. The
// transport owns finite routes; this module never reads the current demo data.
import {
  buildOnboardingProbeManifest,
  normalizeOnboardingProbeContext,
  verifyOnboardingSchematicMatch,
} from '../../../modules/waveforms/onboarding-probe.js';

const active=new WeakMap();
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}$/.test(value);
const hash=(value,length=64)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const copy=value=>structuredClone(value);
const need=(condition,message)=>{if(!condition)throw Error(message);};

export function onboardingWaveformScope(intake,job){
  const plan=intake?.prepared;
  need(intake?.schema==='ic.onboarding.session.v1'&&id(intake.intake_id)&&hash(intake.source_sha256), '缺少网表会话身份。');
  need(plan?.schema==='ic.experiment.plan.v1'&&plan.state==='prepared'&&hash(plan.plan_id)&&hash(plan.source_commit,40), '缺少已准备实验的固定版本。');
  need(job?.schema==='ic.experiment.job.v1'&&id(job.run_id)&&job.job_id===job.run_id&&
    job.plan_id===plan.plan_id&&job.project_id===plan.project_id&&job.configuration===plan.recipe_id&&
    job.source_commit===plan.source_commit&&intake.source_commit===plan.source_commit, '波形任务与已准备实验不一致。');
  return Object.freeze({intake_id:intake.intake_id,run_id:job.run_id,plan_id:plan.plan_id,
    project_id:job.project_id,configuration:job.configuration,source_commit:job.source_commit,source_sha256:intake.source_sha256});
}

export function scopedOnboardingWaveformAPI(scope,provider,{isCurrent=()=>true,getSchematicContext=null,intake=null}={}){
  need(provider&&['catalog','mapping','waveform'].every(name=>typeof provider[name]==='function'), '连接尚未提供真实波形读取接口。');
  let pinned=null;
  const catalogs=new Map();
  const checkRun=run=>{need(isCurrent(),'波形连接已变化；请在原连接重新打开此运行。');need(run===scope.run_id,'只能读取选中的原始波形任务。');};
  const binding=data=>{
    need(data?.run_id===scope.run_id&&data.source_commit===scope.source_commit,'波形响应属于其它运行或源码版本。');
    const fields=['archive_sha256','raw_signature','effective_config_sha256'];
    need(fields.every(name=>hash(data[name])),'波形缺少原始归档或配置身份。');
    const current=JSON.stringify(fields.map(name=>data[name]));
    if(pinned===null)pinned=current;
    need(pinned===current,'同一任务的波形归档身份发生变化；未混用结果。');
    return data;
  };
  const read=async(name,run,args)=>{checkRun(run);const result=await provider[name](run,...args);checkRun(run);return binding(result);};
  return Object.freeze({
    jobs:async()=>{checkRun(scope.run_id);return {jobs:[{...scope}]};},
    async catalog(run,options){
      const data=await read('catalog',run,[options]);
      need(Array.isArray(data.signals)&&data.signals.length<=4096&&(hash(data.csv_sha256)||hash(data.data_sha256)&&data.dataset_id===options?.dataset_id||Array.isArray(data.datasets)),'波形信号目录不完整。');
      need(data.signals.every(signal=>typeof signal.id==='string'&&signal.id&&typeof signal.label==='string'),'波形信号身份无效。');
      catalogs.set(options?.dataset_id||'',copy(data));
      return data;
    },
    async mapping(run,options){
      const data=await read('mapping',run,[options]);
      if(typeof getSchematicContext==='function'){
        const hostContext=getSchematicContext();
        const catalog=catalogs.get(options?.dataset_id||'')||catalogs.get('')||null;
        const verified=buildOnboardingProbeManifest({scope,catalog,hostContext,intake});
        if(verified.status==='verified_binding'){
          return {...data,...verified};
        }
        return {...data,schema:'ic.waveform-map.v1',status:'unmapped',objects:[],
          reason:verified.reason||'此独立实验尚未绑定当前画布；请从本次运行的已导出信号中选择。'};
      }
      // Without a verified schematic context, keep saved signals viewable without a probe map.
      return {...data,schema:'ic.waveform-map.v1',status:'unmapped',objects:[],
        reason:'此独立实验尚未绑定当前画布；请从本次运行的已导出信号中选择。'};
    },
    async waveform(run,signalId,params={},options){
      const data=await read('waveform',run,[signalId,params,options]);
      const native=!!params.dataset_id,points=data.complex_points||data.points,width=data.representation==='complex_real_imag'?3:2;
      need(data.signal?.id===signalId&&(!native||data.dataset_id===params.dataset_id&&hash(data.data_sha256)),'返回的波形数据集或信号不匹配。');
      need(native&&data.axis===null&&data.operating_value||Array.isArray(points)&&points.length<=10000&&points.every(point=>Array.isArray(point)&&point.length===width&&Number.isFinite(point[0])&&point.slice(1).every(v=>Number.isFinite(v)||native&&(v===null||data.representation==='string'&&typeof v==='string'))),'波形窗口含无效样本。');
      return data;
    }
  });
}

export async function openOnboardingWaveforms(host,{intake,job}){
  const scope=onboardingWaveformScope(intake,job),bridge=host.onboarding;
  const connection=bridge?.getState?.();
  need(connection?.connected&&connection.connectionId,'请连接此实验原来的仿真环境。');
  need(typeof bridge.waveformApi==='function','连接尚未提供真实波形读取接口。');
  need(host.slots?.waveforms&&typeof host.prepareOnboardingWaveformSlot==='function','此窗口暂不支持打开独立实验波形。');
  const isCurrent=()=>{const now=bridge.getState();return now.connected&&now.connectionId===connection.connectionId&&now.revision===connection.revision;};
  const hasSchematicContext=typeof host.context?.getContext==='function';
  const getSchematicContext=hasSchematicContext?()=>host.context.getContext():null;
  const provider=bridge.waveformApi({intake_id:scope.intake_id,job:copy(job)});
  const api=scopedOnboardingWaveformAPI(scope,provider,{isCurrent,getSchematicContext,intake});
  // Read catalog first so verified client-side probe mapping can bind exact exported signals.
  const catalog=await api.catalog(scope.run_id);
  const mapping=await api.mapping(scope.run_id);
  need(catalog.signals.some(signal=>signal.status==='available')||catalog.datasets?.some(row=>row.available===true),'该运行尚无可显示的已保存数据集。');
  const module=await import('../studio/dockview/waveforms.js');
  need(isCurrent(),'连接已变化；未替换波形窗口。');
  await host.prepareOnboardingWaveformSlot({intake:copy(intake),job:copy(job)});
  need(isCurrent(),'连接已变化；请重新打开原运行。');
  active.get(host)?.destroy();
  let disposed=false,controller=null;
  const fallbackContext={version:1,mode:'live',project:{id:scope.project_id,sourceCommit:scope.source_commit},
    run:{runId:scope.run_id},selection:null,geometry:null,file:null};
  const currentContext=()=>hasSchematicContext?normalizeOnboardingProbeContext(scope,host.context.getContext()):copy(fallbackContext);
  const contextListeners=new Set();
  const offHostContext=hasSchematicContext&&typeof host.context?.subscribe==='function'
    ?host.context.subscribe(()=>{if(disposed)return;const next=currentContext();for(const fn of contextListeners)try{fn(copy(next));}catch{}})
    :null;
  const cached={...api,catalog:(run,options)=>options?.dataset_id||options?.signal?.aborted?api.catalog(run,options):(run===scope.run_id&&isCurrent()?Promise.resolve(copy(catalog)):api.catalog(run,options)),
    mapping:(run,options)=>options?.dataset_id||options?.signal?.aborted?api.mapping(run,options):(run===scope.run_id&&isCurrent()?Promise.resolve(copy(mapping)):api.mapping(run,options))};
  const scopedHost={...host,context:{getContext:()=>copy(currentContext()),subscribe(fn){contextListeners.add(fn);return()=>contextListeners.delete(fn);}},
    getRuns:()=>[copy(job)],refresh:async()=>{need(isCurrent(),'波形连接已断开。');},
    selectRun:async run=>{need(run===scope.run_id&&isCurrent(),'请选择当前独立实验的原始任务。');},
    plot:{attach(value){controller=value;value.setPlotMode('none');return()=>{if(controller===value)controller=null;value.destroy();};}}};
  const mounted=module.mount(scopedHost,{api:cached});
  const canProbe=()=>!disposed&&isCurrent()&&hasSchematicContext&&mapping.status==='verified_binding'&&mapping.objects?.length>0&&verifyOnboardingSchematicMatch(scope,host.context.getContext()).ok;
  const probeStatus=()=>{
    if(!hasSchematicContext)return {ok:false,reason:'当前窗口未提供原理图上下文。'};
    const match=verifyOnboardingSchematicMatch(scope,host.context.getContext());
    if(!match.ok)return match;
    if(mapping.status!=='verified_binding'||!mapping.objects?.length)return {ok:false,reason:mapping.reason||'该运行暂无可映射到原理图的导出信号。'};
    return {ok:true,entryId:match.entryId,mappedCount:mapping.objects.length};
  };
  let disconnectedNotice=false;
  const unsubscribe=bridge.subscribe?.(()=>{if(!disposed&&!disconnectedNotice&&!isCurrent()){disconnectedNotice=true;host.notify('波形连接已断开或切换；保留已显示曲线，后续读取已停止。',{kind:'warning'});}});
  const handle={controller:mounted.controller,scope,canProbe,probeStatus,probe(selection){if(!canProbe())return false;const ctx={...currentContext(),selection};mounted.controller.onSelection(ctx);return true;},destroy(){if(disposed)return;disposed=true;offHostContext?.();contextListeners.clear();unsubscribe?.();mounted.destroy();if(active.get(host)===handle)active.delete(host);}};
  active.set(host,handle);host.slots.waveforms.setVisible(true);mounted.controller.openWindow();
  // The first view offers the real saved signal list; when source hash matches,
  // schematic click-to-probe is also enabled without substituting RC reference data.
  host.slots.waveforms.element.querySelector('.wf-add-signals')?.click();
  if(canProbe())host.notify('远端仿真波形已打开，且当前原理图与仿真源哈希完全匹配：可开启电压/电流探针在原理图点选曲线。',{kind:'info'});
  return handle;
}
