// This surrounding session/catalog is a synthetic UI seam. The analysis value
// is copied unchanged from the actual OnboardingAnalysis serializer fixture;
// that fixture explicitly does not claim numerical algorithm verification.
export function analysisSession(base,value){
  const sourceId=Object.keys(value.input.source_hashes)[0],compiled=value.input.source_hashes[sourceId];
  const waveforms={schema:'ic.onboarding.waveform-descriptor.v1',available:true,source_binding_verified:true,read_only:true,
    intake_id:value.intake_id,job_id:value.job_id,run_id:value.run_id,source_commit:value.source_commit,
    original_source_sha256:value.original_source_sha256,compiled_source_sha256:compiled,compiled_source_path:sourceId,
    transformation:'none',probe:{enabled:false,current_geometry_context_verified:false},
    available_signal_ids:Object.values(value.input.selection).filter(row=>row.id).map(row=>row.id),
    ...Object.fromEntries(['archive_sha256','csv_sha256','raw_signature','effective_config_sha256','source_hashes'].map(key=>[key,structuredClone(value.input[key])]))};
  const plan={schema:'ic.experiment.plan.v1',state:'prepared',project_id:'synthetic-project',recipe_id:'agent-testbench',source_commit:value.source_commit,plan_id:'c'.repeat(64),submission_key:'experiment-'+'c'.repeat(64),missing:[]};
  const session={...base,revision:7,intake_id:value.intake_id,source_sha256:value.original_source_sha256,source_commit:value.source_commit,state:'complete',
    source:{...base.source,source_sha256:value.original_source_sha256},prepared:plan,source_mapping:{source_id:sourceId,source_commit:value.source_commit,original_source_sha256:value.original_source_sha256,compiled_source_sha256:compiled,transformation:'none'},
    execution_scope:{selected_ssh_targets:['synthetic-host'],candidate_host_ids:['synthetic-host-id'],selection_mode:'automatic_within_selected_hosts',resource_check_at_run:true},
    job:{schema:'ic.experiment.job.v1',project_id:plan.project_id,configuration:plan.recipe_id,plan_id:plan.plan_id,job_id:value.job_id,run_id:value.run_id,source_commit:value.source_commit,state:'completed',execution_target:'synthetic-host-id',automatic_retry:false,waveforms}};
  delete session.agent_tb;delete session.agent_tb_review;
  return session;
}
export function analysisCatalog(value){return {schema:'ic.waveforms.v1',run_id:value.run_id,source_commit:value.source_commit,
  ...Object.fromEntries(['archive_sha256','csv_sha256','raw_signature','effective_config_sha256','source_hashes'].map(key=>[key,structuredClone(value.input[key])])),
  signals:Object.values(value.input.selection).filter(row=>row.id).map(row=>structuredClone(row))};}
