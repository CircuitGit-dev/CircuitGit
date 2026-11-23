// One explicitly selected intake/run in the existing waveform viewer. The
// transport owns finite routes; this module never reads the current demo data.
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

export function scopedOnboardingWaveformAPI(scope,provider,{isCurrent=()=>true}={}){
  need(provider&&['catalog','mapping','waveform'].every(name=>typeof provider[name]==='function'), '连接尚未提供真实波形读取接口。');
  let pinned=null;
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
      need(Array.isArray(data.signals)&&data.signals.length<=4096&&hash(data.csv_sha256),'波形信号目录不完整。');
      need(data.signals.every(signal=>typeof signal.id==='string'&&signal.id&&typeof signal.label==='string'),'波形信号身份无效。');
      return data;
    },
    async mapping(run,options){
      const data=await read('mapping',run,[options]);
      // This independent intake has no proven relationship to the currently
      // displayed schematic. Saved signals remain viewable without a probe map.
      return {...data,schema:'ic.waveform-map.v1',status:'unmapped',objects:[],
        reason:'此独立实验尚未绑定当前画布；请从本次运行的已导出信号中选择。'};
    },
    async waveform(run,signalId,params={},options){
      const data=await read('waveform',run,[signalId,params,options]);
      need(data.signal?.id===signalId&&Array.isArray(data.points)&&data.points.length<=10000,'返回的波形信号或采样窗口不匹配。');
      need(data.points.every(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)),'波形窗口含无效样本。');
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
  const provider=bridge.waveformApi({intake_id:scope.intake_id,job:copy(job)});
  const api=scopedOnboardingWaveformAPI(scope,provider,{isCurrent});
  // Read before replacing the old panel. Missing/unavailable data cannot clear a
  // working reference or historical waveform display.
  const [catalog,mapping]=await Promise.all([api.catalog(scope.run_id),api.mapping(scope.run_id)]);
  need(catalog.signals.some(signal=>signal.status==='available'&&signal.analysis==='tran'),'该运行尚未导出可显示的瞬态信号。');
  const module=await import('../studio/dockview/waveforms.js');
  need(isCurrent(),'连接已变化；未替换波形窗口。');
  await host.prepareOnboardingWaveformSlot({intake:copy(intake),job:copy(job)});
  need(isCurrent(),'连接已变化；请重新打开原运行。');
  active.get(host)?.destroy();
  let disposed=false,controller=null;
  const context={version:1,mode:'live',project:{id:scope.project_id,sourceCommit:scope.source_commit},
    run:{runId:scope.run_id},selection:null,geometry:null,file:null};
  const cached={...api,catalog:(run,options)=>options?.signal?.aborted?api.catalog(run,options):(run===scope.run_id&&isCurrent()?Promise.resolve(copy(catalog)):api.catalog(run,options)),
    mapping:(run,options)=>options?.signal?.aborted?api.mapping(run,options):(run===scope.run_id&&isCurrent()?Promise.resolve(copy(mapping)):api.mapping(run,options))};
  const scopedHost={...host,context:{getContext:()=>copy(context),subscribe:()=>()=>{}},
    getRuns:()=>[copy(job)],refresh:async()=>{need(isCurrent(),'波形连接已断开。');},
    selectRun:async run=>{need(run===scope.run_id&&isCurrent(),'请选择当前独立实验的原始任务。');},
    plot:{attach(value){controller=value;value.setPlotMode('none');return()=>{if(controller===value)controller=null;value.destroy();};}}};
  const mounted=module.mount(scopedHost,{api:cached});
  let disconnectedNotice=false;
  const unsubscribe=bridge.subscribe?.(()=>{if(!disposed&&!disconnectedNotice&&!isCurrent()){disconnectedNotice=true;host.notify('波形连接已断开或切换；保留已显示曲线，后续读取已停止。',{kind:'warning'});}});
  const handle={controller:mounted.controller,scope,destroy(){if(disposed)return;disposed=true;unsubscribe?.();mounted.destroy();if(active.get(host)===handle)active.delete(host);}};
  active.set(host,handle);host.slots.waveforms.setVisible(true);mounted.controller.openWindow();
  // The first view offers the real saved signal list; it never substitutes RC
  // reference traces or silently assumes a diagram-to-PSF node correspondence.
  host.slots.waveforms.element.querySelector('.wf-add-signals')?.click();
  return handle;
}
