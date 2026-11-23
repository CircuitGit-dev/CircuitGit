// Pure verification of the backend's typed, original-plan pre-dispatch receipt.
// A missing mapping or error message is never proof that launch was not attempted.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=240&&!/[\u0000-\u001f]/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=()=>{throw Error('提交前拒绝回执与原 intake、计划或源码身份不一致；继续保留原请求。');};

export function validatePreDispatchRejection(submission,{intake,plan,pending=null,connectionId=null}={}){
  if(!object(intake)||intake.schema!=='ic.onboarding.session.v1'||!id(intake.connection_id)||!id(intake.intake_id)||!hash(intake.source_sha256)||!Number.isSafeInteger(intake.revision)||intake.revision<1)fail();
  if(!object(plan)||plan.schema!=='ic.experiment.plan.v1'||plan.state!=='prepared'||!hash(plan.plan_id)||!id(plan.project_id)||!id(plan.recipe_id)||!commit(plan.source_commit)||plan.submission_key!=='experiment-'+plan.plan_id)fail();
  if(intake.source_commit!==plan.source_commit||!object(intake.prepared)||['plan_id','project_id','recipe_id','source_commit','submission_key'].some(key=>intake.prepared[key]!==plan[key]))fail();
  if(pending!==null&&(!object(pending)||pending.schema!=='ic.onboarding.pending.v1'||pending.phase!=='run'||!id(connectionId)||pending.connectionId!==connectionId||pending.intake_id!==intake.intake_id||pending.plan_id!==plan.plan_id||pending.submission_key!==plan.submission_key||!Number.isSafeInteger(pending.revision)||pending.revision<1||pending.revision>intake.revision))fail();
  if(!exact(submission,['intake_id','plan_id','found','run_id','submission_key','dispatch_outcome','replay_permitted','job','rejection'])||submission.intake_id!==intake.intake_id||submission.plan_id!==plan.plan_id||submission.submission_key!==plan.submission_key||submission.found!==false||submission.run_id!==null||submission.job!==null||submission.dispatch_outcome!=='pre_dispatch_rejected'||submission.replay_permitted!==false)fail();
  const rejection=submission.rejection;
  if(!exact(rejection,['schema','plan_id','project_id','source_commit','submission_key','phase','code','launch_attempted','recorded_at'])||rejection.schema!=='ic.experiment.pre-dispatch-rejection.v1'||rejection.plan_id!==plan.plan_id||rejection.project_id!==plan.project_id||rejection.source_commit!==plan.source_commit||rejection.submission_key!==plan.submission_key||rejection.phase!=='before_runner_reserve'||rejection.code!=='resource_or_dependency_preflight_rejected'||rejection.launch_attempted!==false||typeof rejection.recorded_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(rejection.recorded_at)||!Number.isFinite(Date.parse(rejection.recorded_at)))fail();
  return structuredClone(submission);
}
