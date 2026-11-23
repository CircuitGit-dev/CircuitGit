import {test} from 'node:test';
import assert from 'node:assert/strict';
import {simulationReportView} from '../../modules/simulation/report.js';
import {normalizeRuntimeSnapshot} from '../../modules/simulation/runtime.js';
import {runtimeSnapshot} from './runtime.fixture.mjs';
import {simulationReport} from './simulation-report.fixture.mjs';

test('no report means five unknown verdicts even when legacy execution and metrics pass',()=>{
  const snapshot=runtimeSnapshot(),run=snapshot.runs[0];
  run.execution={state:'completed',exit_code:0};
  run.acceptance={execution:'completed',data_validity:'valid',specification:'pass'};
  run.diagnostics.scientific_acceptance={...run.acceptance};
  const value=normalizeRuntimeSnapshot(snapshot,'p'),view=simulationReportView(value.runs[0].report,'run-1');
  assert.equal(view.available,false);assert.equal(view.dimensions.length,5);
  assert.ok(view.dimensions.every(row=>row.status==='unknown'));
});

test('function pass SOA violation and incomplete dependencies stay independent',()=>{
  const report=simulationReport(),view=simulationReportView(report,'run-1');
  assert.deepEqual(view.dimensions.map(row=>row.status),['completed','valid','pass','violations_detected','incomplete']);
  assert.equal(view.dimensions[3].scope,report.operating_qualification.scope);
  assert.equal(view.dimensions[4].evidence,report.dependency_provenance.evidence);
  assert.equal(Object.hasOwn(view,'overall_pass'),false);
});

test('unknown backend verdicts remain unknown despite reassuring diagnostic evidence',()=>{
  const report=simulationReport();
  report.operating_qualification.status='unknown';report.operating_qualification.evidence=[{code:'synthetic_all_tests_passed',source:'acceptance',line_numbers:[]}];
  report.dependency_provenance.status='unknown';
  const view=simulationReportView(report,'run-1');
  assert.equal(view.dimensions[3].status,'unknown');assert.equal(view.dimensions[4].status,'unknown');
});

test('malformed or cross-run reports are rejected by the runtime boundary',()=>{
  for(const mutate of [r=>{r.schema='other';},r=>{r.run_id='other';},r=>{r.advisory_only=false;},r=>{r.overall_pass=true;},r=>{r.operating_qualification.status='pass';},r=>{r.dependency_provenance.evidence={};},r=>{r.measurement_validity.scope=null;},r=>{r.operating_qualification.scope.checks=['unsupported'];},r=>{r.dependency_provenance.evidence[0].sha256='HEAD';}]){
    const snapshot=runtimeSnapshot();snapshot.runs[0].report=simulationReport();mutate(snapshot.runs[0].report);
    assert.throws(()=>normalizeRuntimeSnapshot(snapshot,'p'),/验收报告/);
  }
});

// Compatibility cases are synthetic and follow the reviewed SpiceOwl report/runtime drafts.
test('legal maximum string lengths count non-BMP Unicode as one character',()=>{
  const snapshot=runtimeSnapshot(),run=snapshot.runs[0];run.report=simulationReport();
  snapshot.pool.hosts[0].label='😀'.repeat(160);snapshot.pool.hosts[0].error_code='😀'.repeat(180);
  run.configuration='😀'.repeat(180);run.execution.state='😀'.repeat(180);run.monitor.state='😀'.repeat(180);
  for(const diagnostic of [run.diagnostics,run.report.diagnostics]){
    const finding=diagnostic.diagnostics[0];
    finding.category='😀'.repeat(180);finding.code='😀'.repeat(180);finding.redacted_excerpt='😀'.repeat(1024);
    finding.evidence_line_numbers=Array(32).fill(2048);finding.suggested_actions=Array(8).fill('😀'.repeat(500));
    diagnostic.diagnostics=Array.from({length:32},()=>structuredClone(finding));
  }
  run.report.operating_qualification.scope.kind='😀'.repeat(100);
  const value=normalizeRuntimeSnapshot(snapshot,'p');
  assert.equal(value.pool.hosts[0].label,snapshot.pool.hosts[0].label);
  assert.equal(value.runs[0].report.diagnostics.diagnostics.length,32);
});

test('scope and evidence retain legal maximum counts and identifiers',()=>{
  const snapshot=runtimeSnapshot(),run=snapshot.runs[0];run.report=simulationReport();
  const dimension=run.report.operating_qualification;
  dimension.scope={kind:'k'.repeat(100),scope_id:'s'.repeat(180),manifest_sha256:'f'.repeat(64),checks:['soa_voltage','soa_current','model_parameter_range','model_bin','scale_override'],frozen_before_execution:true,log_complete:true,run_bound:true,inventory_complete:true};
  dimension.evidence=Array.from({length:258},()=>({code:'e'.repeat(180),source:'qualification_scope',line_numbers:Array(8).fill(2048),dependency_id:'d'.repeat(180),sha256:'f'.repeat(64),count:999999999999999}));
  assert.equal(normalizeRuntimeSnapshot(snapshot,'p').runs[0].report.operating_qualification.evidence.length,258);
});

test('above-limit text and evidence are still rejected',()=>{
  const mutations=[
    v=>{v.pool.hosts[0].label='😀'.repeat(161);},v=>{v.pool.hosts[0].error_code='e'.repeat(181);},
    v=>{v.runs[0].execution.state='e'.repeat(181);},v=>{v.runs[0].monitor.state='😀'.repeat(181);},
    v=>{v.runs[0].report.diagnostics.diagnostics[0].category='c'.repeat(181);},
    v=>{v.runs[0].report.diagnostics.diagnostics[0].code='😀'.repeat(181);},
    v=>{v.runs[0].report.diagnostics.diagnostics[0].redacted_excerpt='😀'.repeat(1025);},
    v=>{v.runs[0].report.diagnostics.diagnostics[0].suggested_actions=['😀'.repeat(501)];},
    v=>{v.runs[0].report.operating_qualification.scope.kind='😀'.repeat(101);},
    v=>{const d=v.runs[0].report.operating_qualification;d.evidence=Array(259).fill(d.evidence[0]);},
    v=>{v.runs[0].report.operating_qualification.evidence[0].line_numbers=Array(9).fill(1);},
    v=>{v.runs[0].report.operating_qualification.evidence[0].line_numbers=[2049];},
    v=>{v.runs[0].report.operating_qualification.evidence[0].count=1000000000000000;},
  ];
  for(const mutate of mutations){const snapshot=runtimeSnapshot();snapshot.runs[0].report=simulationReport();mutate(snapshot);assert.throws(()=>normalizeRuntimeSnapshot(snapshot,'p'));}
});

test('positive scoped verdicts require their declared schema prerequisites',()=>{
  const valid=()=>{const report=simulationReport();report.operating_qualification.status='passed_within_scope';report.dependency_provenance.status='verified_within_scope';return report;};
  assert.equal(simulationReportView(valid(),'run-1').dimensions[4].status,'verified_within_scope');
  for(const mutate of [
    r=>{delete r.operating_qualification.scope.scope_id;},r=>{r.operating_qualification.scope.manifest_sha256=null;},
    r=>{r.operating_qualification.scope.kind='caller_summary';},r=>{r.operating_qualification.scope.checks=[];},
    r=>{r.operating_qualification.scope.frozen_before_execution=false;},r=>{r.operating_qualification.scope.log_complete=false;},
    r=>{r.dependency_provenance.scope.kind='declared_dependency_inventory';},r=>{r.dependency_provenance.scope.run_bound=false;},
    r=>{delete r.dependency_provenance.scope.inventory_complete;},r=>{r.dependency_provenance.scope.scope_id=null;},
    r=>{delete r.dependency_provenance.scope.manifest_sha256;},r=>{r.run_id=null;},
    r=>{r.measurement_validity.status='unknown';},
  ]){const report=valid();mutate(report);assert.throws(()=>simulationReportView(report,'run-1'));}
});

test('optional experiment capabilities and maximum recipe catalog remain compatible without UI actions',()=>{
  const snapshot=runtimeSnapshot();snapshot.experiments={configured:true,prepare:true,run:true,inspect:true,recipes:Array.from({length:128},()=>({recipe_id:'😀'.repeat(180),template:'x'.repeat(180)}))};
  const value=normalizeRuntimeSnapshot(snapshot,'p');assert.deepEqual(value.experiments,snapshot.experiments);
  assert.ok(Object.isFrozen(value.experiments.recipes));
});
