// Synthetic display fixture, not evidence from an actual simulation.
import {runtimeSnapshot} from './runtime.fixture.mjs';
export function simulationReport(runId='run-1'){
  const diagnostics=runtimeSnapshot().runs[0].diagnostics;
  diagnostics.scientific_acceptance={execution:'completed',data_validity:'valid',specification:'pass'};
  diagnostics.observed_context={execution_state:'completed',exit_code:0,warning_summary:{reported_warnings:54,suppressed_warnings:30703,count_conflict:false}};
  diagnostics.diagnostics=[{category:'soa_voltage',code:'spectre_soa_voltage',severity:'warning',evidence_line_numbers:[1],redacted_excerpt:'Synthetic example: 1 V bias exceeds the 0.99 V model limit.',suggested_actions:['Review the declared operating conditions.']}];
  const evidence=(code,source,extra={})=>({code,source,line_numbers:[],...extra});
  return {schema:'spiceowl.simulation-report.v1',run_id:runId,advisory_only:true,diagnostics,
    execution_status:{status:'completed',scope:{kind:'caller_execution_receipt'},evidence:[evidence('caller_execution_completed','execution_receipt')]},
    measurement_validity:{status:'valid',scope:{kind:'caller_summary'},evidence:[evidence('measurement_valid','acceptance')]},
    functional_performance:{status:'pass',scope:{kind:'caller_summary'},evidence:[evidence('functional_pass','acceptance')]},
    operating_qualification:{status:'violations_detected',scope:{kind:'declared_operating_checks',scope_id:'synthetic-operating-scope',manifest_sha256:'a'.repeat(64),frozen_before_execution:true,checks:['soa_voltage'],log_complete:true},evidence:[evidence('spectre_soa_voltage','spectre_log',{line_numbers:[1]})]},
    dependency_provenance:{status:'incomplete',scope:{kind:'observed_files_with_directory_references',scope_id:'synthetic-dependencies',manifest_sha256:'b'.repeat(64),run_bound:true,inventory_complete:true},evidence:[evidence('unregistered_runtime_tmi_library','dependency_audit',{dependency_id:'synthetic-tmi',sha256:'c'.repeat(64)})]}};
}
