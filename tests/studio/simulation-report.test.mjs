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
