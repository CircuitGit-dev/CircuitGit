import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSupervisionController, normalizeSupervisionSnapshot, supervisionDimensions} from '../../modules/simulation/supervision.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), HASH = '1'.repeat(64);
const OBSERVED = '2026-11-18T03:00:00Z', READ = '2026-11-20T05:00:00Z';
function record(project = 'p') {
  return {
    run_id: 'run_1', project_id: project, original_project_id: 'legacy-project',
    association_basis: 'recorded_plan_design_id', source_commit: A, configuration: 'transient',
    compiled_inputs_sha256: HASH, state: 'collected',
    execution: {state: 'succeeded', raw_state: 'simulator_complete_pending_measurements', exit_code: 0, observed_at: OBSERVED},
    observation: {state: 'recorded', observed_at: OBSERVED},
    data: {state: 'collected', raw_retained: true},
    specification: {state: 'reported', metrics: [{name: 'gain', value: 2.4, unit: 'V/V', passed: false, scope: 'settled'}]},
    latest_observed_at: OBSERVED, record_updated_at: OBSERVED, issues: [], waveform_run_id: 'run_1', artifacts: [],
  };
}
function snapshot(project = 'p', runs = [record(project)]) {
  return {schema: 'ic.supervision.snapshot.v1', project_id: project, read_at: READ,
    source: 'stored_observations', runs, scanned_records: runs.length, unavailable_records: 0, truncated: false, single_site: true};
}
function fixture(request) {
  const listeners = new Set(), calls = [];
  let current = {loadState: 'ready', loading: false, project: {id: 'p', sourceCommit: B},
    file: {dirty: false}, run: {runId: 'run_1', projectId: 'p', sourceCommit: A, historical: true}};
  const host = {
    context: {getContext: () => current, subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}},
    gateway: {async request(path, options) {
      calls.push({path, options});
      return request ? request(path, options) : snapshot(new URLSearchParams(path.split('?')[1]).get('project_id'));
    }},
    plot: {openWindow() {calls.push({action: 'openWaveforms'}); return {opened: true};}},
    selectRun() {throw Error('Supervision must not change selection');},
    refresh() {throw Error('Supervision must not refresh host state');},
  };
  return {host, calls, listeners,
    setContext(values, publish = true) {current = {...current, ...values}; if (publish) for (const fn of listeners) fn(current);},
  };
}
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};

test('only one stored GET is read automatically; selection/source changes do not poll or mutate', async () => {
  const f = fixture(), controller = createSupervisionController(f.host); await controller.ready();
  assert.deepEqual(f.calls, [{path: '/supervision?project_id=p', options: {method: 'GET'}}]);
  f.setContext({run: null}); f.setContext({project: {id: 'p', sourceCommit: A}, file: {dirty: true}});
  await Promise.resolve(); assert.equal(f.calls.length, 1); assert.equal(controller.selectedRun(), null);
  await controller.refresh(); assert.equal(f.calls.length, 2); controller.destroy();
});

test('four independent dimensions preserve failed metric and original observation time', () => {
  const result = normalizeSupervisionSnapshot(snapshot(), 'p'), run = result.runs[0];
  assert.deepEqual(supervisionDimensions(run), [
    {key: 'execution', label: '仿真执行', value: '记录为成功'},
    {key: 'observation', label: '观察记录', value: '已有保存记录'},
    {key: 'data', label: '数据收集', value: '已收集'},
    {key: 'specification', label: '指标报告', value: '已有指标报告'},
  ]);
  assert.equal(run.specification.metrics[0].passed, false);
  assert.equal(run.observation.observed_at, OBSERVED); assert.equal(run.latest_observed_at, OBSERVED);
  assert.equal(result.read_at, READ); assert.notEqual(run.latest_observed_at, result.read_at);
  assert.equal(run.original_project_id, 'legacy-project'); assert.equal(run.source_commit, A);
  assert.ok(Object.isFrozen(run.specification.metrics[0]));
});

test('HTTP 404 is unavailable without generated substitute records', async () => {
  const f = fixture(async () => {throw Object.assign(Error('Not found'), {status: 404});});
  const c = createSupervisionController(f.host); await c.ready();
  assert.equal(c.state.status, 'unavailable'); assert.equal(c.state.snapshot, null); assert.equal(c.selectedRun(), null);
  assert.equal(c.waveformPolicy().allowed, false); assert.equal(f.calls.length, 1); c.destroy();
});

test('same-project refresh failure retains explicitly old evidence and never changes observation or run state', async () => {
  let attempt = 0;
  const f = fixture(async () => {if (++attempt === 3) throw Error('read failed'); return {...snapshot(), read_at: attempt === 1 ? READ : '2026-11-21T05:00:00Z'};});
  const c = createSupervisionController(f.host); await c.ready(); await c.refresh();
  assert.equal(c.state.snapshot.read_at, '2026-11-21T05:00:00Z'); assert.equal(c.selectedRun().latest_observed_at, OBSERVED);
  const lastRead = c.state.snapshot;
  await c.refresh(); assert.equal(c.state.status, 'error'); assert.equal(c.state.error, 'read failed');
  assert.equal(c.state.snapshot, lastRead); assert.equal(c.selectedRun().execution.state, 'succeeded');
  assert.equal(c.selectedRun().latest_observed_at, OBSERVED); assert.equal(c.waveformPolicy().allowed, false);
  assert.throws(() => c.openWaveforms());
  await c.refresh(); assert.equal(c.state.status, 'ready'); assert.equal(c.waveformPolicy().allowed, true);
  c.destroy();
});

test('in-flight refresh and subsequent 404 retain old same-project records but cannot open waveforms', async () => {
  const wait = deferred(); let count = 0;
  const f = fixture(() => ++count === 1 ? snapshot() : wait.promise), c = createSupervisionController(f.host); await c.ready();
  const lastRead = c.state.snapshot, refreshing = c.refresh();
  assert.equal(c.state.status, 'loading'); assert.equal(c.state.snapshot, lastRead); assert.equal(c.waveformPolicy().allowed, false);
  wait.reject(Object.assign(Error('missing'), {status: 404})); await refreshing;
  assert.equal(c.state.status, 'unavailable'); assert.equal(c.state.snapshot, lastRead); assert.equal(c.waveformPolicy().allowed, false);
  assert.equal(c.state.snapshot.read_at, READ); assert.equal(c.selectedRun().latest_observed_at, OBSERVED); c.destroy();
});

test('cross-project refresh failure clears previous evidence including a delayed old refresh', async () => {
  const old = deferred(); let count = 0;
  const f = fixture(() => ++count === 1 ? snapshot() : count === 2 ? old.promise : Promise.reject(Error('new project read failed')));
  const c = createSupervisionController(f.host); await c.ready();
  const refreshing = c.refresh(); await Promise.resolve();
  f.setContext({project: {id: 'q', sourceCommit: B}, run: {runId: 'run_1', projectId: 'q', sourceCommit: A}});
  assert.equal(c.state.snapshot, null); await c.ready();
  old.resolve(snapshot()); await refreshing;
  assert.equal(c.state.status, 'error'); assert.equal(c.state.projectId, 'q'); assert.equal(c.state.snapshot, null);
  assert.equal(c.selectedRun(), null); c.destroy();
});

test('responses from previous projects are discarded', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const f = fixture(() => ++count === 1 ? first.promise : second.promise), c = createSupervisionController(f.host);
  const oldPending = c.ready(); await Promise.resolve();
  f.setContext({project: {id: 'q', sourceCommit: B}, run: {runId: 'run_1', projectId: 'q', sourceCommit: A}});
  assert.equal(c.state.snapshot, null); second.resolve(snapshot('q')); await c.ready();
  first.resolve(snapshot('p')); await oldPending;
  assert.equal(c.state.projectId, 'q'); assert.equal(c.state.snapshot.project_id, 'q');
  assert.equal(c.selectedRun().project_id, 'q'); c.destroy();
});

test('loading/error context clears evidence and prevents stale requests from restoring it', async () => {
  const wait = deferred(), f = fixture(() => wait.promise), c = createSupervisionController(f.host);
  const pending = c.ready(); await Promise.resolve();
  f.setContext({loadState: 'loading', loading: true});
  assert.equal(c.state.projectId, null); assert.equal(c.state.selectedRunId, null); assert.equal(c.state.snapshot, null);
  wait.resolve(snapshot()); await pending; assert.equal(c.state.snapshot, null);
  f.setContext({loadState: 'error', loading: false}); await c.refresh(); assert.equal(f.calls.length, 1); c.destroy();
});

test('destroy unsubscribes and ignores late evidence without cancelling jobs', async () => {
  const wait = deferred(), f = fixture(() => wait.promise); let changed = 0;
  const c = createSupervisionController(f.host, () => {changed++;}); await Promise.resolve();
  assert.equal(f.listeners.size, 1); c.destroy(); c.destroy(); const before = changed;
  wait.resolve(snapshot()); await c.ready();
  assert.equal(changed, before); assert.equal(f.listeners.size, 0); assert.equal(c.state.snapshot, null);
  await c.refresh(); assert.equal(f.calls.length, 1); assert.throws(() => c.openWaveforms());
});

test('matching selected historical run can open waveforms while current source is dirty/newer', async () => {
  const f = fixture(), c = createSupervisionController(f.host); await c.ready();
  f.setContext({file: {dirty: true}}); assert.equal(c.waveformPolicy().allowed, true);
  assert.deepEqual(c.openWaveforms(), {opened: true}); assert.equal(f.calls.at(-1).action, 'openWaveforms'); c.destroy();
});

test('waveform action checks live selection again at click time', async () => {
  const f = fixture(), c = createSupervisionController(f.host); await c.ready(); assert.equal(c.waveformPolicy().allowed, true);
  f.setContext({run: {runId: 'other', projectId: 'p', sourceCommit: A}}, false);
  assert.equal(c.waveformPolicy().allowed, false); assert.throws(() => c.openWaveforms(), /不一致/);
  assert.equal(f.calls.length, 1); c.destroy();
});

test('null/mismatched source, project, run, and waveform identities block waveform opening', async () => {
  const cases = [
    {changeRecord: r => {r.source_commit = null;}},
    {changeRecord: r => {r.waveform_run_id = null;}},
    {changeRecord: r => {r.waveform_run_id = 'different';}},
    {context: {run: {runId: 'run_1', projectId: 'p', sourceCommit: B}}},
    {context: {run: {runId: 'run_1', projectId: 'p', sourceCommit: null}}},
    {context: {run: {runId: 'run_1', projectId: 'q', sourceCommit: A}}},
    {context: {run: {runId: 'missing', projectId: 'p', sourceCommit: A}}},
  ];
  for (const scenario of cases) {
    const item = record(); scenario.changeRecord?.(item);
    const f = fixture(async () => snapshot('p', [item])), c = createSupervisionController(f.host); await c.ready();
    if (scenario.context) f.setContext(scenario.context);
    assert.equal(c.waveformPolicy().allowed, false); assert.throws(() => c.openWaveforms());
    assert.equal(f.calls.length, 1); c.destroy();
  }
});

test('missing selected record never falls back to a newest run', async () => {
  const f = fixture(), c = createSupervisionController(f.host); await c.ready();
  f.setContext({run: {runId: 'absent', projectId: 'p', sourceCommit: A}});
  assert.equal(c.state.selectedRunId, 'absent'); assert.equal(c.selectedRun(), null); assert.equal(f.calls.length, 1); c.destroy();
});

test('truncation, unavailable counts and stored artifact digests are retained honestly', () => {
  const value = snapshot(); value.truncated = true; value.scanned_records = 200; value.unavailable_records = 3;
  value.runs[0].artifacts = [{name: 'raw', bytes: 12, sha256: HASH, url: '/api/jobs/run_1/artifacts/raw', digest_source: 'stored_record'}];
  const result = normalizeSupervisionSnapshot(value, 'p');
  assert.equal(result.truncated, true); assert.equal(result.scanned_records, 200); assert.equal(result.unavailable_records, 3);
  assert.equal(result.runs[0].artifacts[0].digest_source, 'stored_record');
  value.runs[0].artifacts[0].sha256 = null; assert.equal(result.runs[0].artifacts[0].sha256, HASH);
});

test('malformed, duplicate, over-limit or mismatched-project evidence fails closed', () => {
  const mutations = [
    value => {value.project_id = 'q';}, value => {value.runs[0].project_id = 'q';},
    value => {value.runs.push(structuredClone(value.runs[0]));},
    value => {value.runs[0].execution.state = 'healthy';}, value => {value.source = 'live';},
    value => {value.single_site = 'false';}, value => {value.scanned_records = 201;},
    value => {value.runs[0].source_commit = 'HEAD';}, value => {value.runs[0].run_id = '../run';},
    value => {delete value.runs[0].observation.observed_at;},
    value => {value.runs[0].specification.metrics[0].value = NaN;},
    value => {value.runs[0].data.raw_retained = 'yes';},
  ];
  for (const mutate of mutations) {const value = snapshot(); mutate(value); assert.throws(() => normalizeSupervisionSnapshot(value, 'p'));}
});

test('stored resource-pool targets preserve multiple hosts and library identity without implying reservation', () => {
  const first = record(), second = {...record(), run_id: 'run_2', waveform_run_id: 'run_2'};
  first.library_id = '_Example.Library'; first.cell_id = '0Cell-A';
  first.execution_target = {mode: 'resource_pool', host_id: 'node-a', plan_id: HASH,
    resource_observed_at: OBSERVED, resource_reservation: false};
  second.execution_target = {...first.execution_target, host_id: 'node-b', plan_id: '2'.repeat(64)};
  const value = snapshot('p', [first, second]); value.single_site = false;
  const result = normalizeSupervisionSnapshot(value, 'p');
  assert.equal(result.single_site, false);
  assert.deepEqual(result.runs.map(run => run.execution_target.host_id), ['node-a', 'node-b']);
  assert.equal(result.runs[0].library_id, '_Example.Library');
  assert.equal(result.runs[0].cell_id, '0Cell-A');
  assert.equal(result.runs[0].execution_target.resource_reservation, false);
  assert.equal(result.runs[0].execution_target.resource_observed_at, OBSERVED);
  assert.equal(result.read_at, READ);
});

test('resource target metadata rejects unsupported modes paths token changes and reservation claims', () => {
  const valid = {mode: 'resource_pool', host_id: 'node-a', plan_id: HASH,
    resource_observed_at: OBSERVED, resource_reservation: false};
  for (const mutation of [target => {target.mode = 'automatic';}, target => {target.host_id = '/private/node';},
    target => {target.plan_id = 'HEAD';}, target => {target.resource_observed_at = 'yesterday';},
    target => {target.resource_reservation = true;}, target => {target.site = '/private/site.json';},
    target => {delete target.plan_id;}]) {
    const value = snapshot(); value.runs[0].execution_target = structuredClone(valid);
    mutation(value.runs[0].execution_target);
    assert.throws(() => normalizeSupervisionSnapshot(value, 'p'));
  }
  const value = snapshot();
  value.runs[0].execution_target = {mode: 'fixed_site', host_id: null, plan_id: null,
    resource_observed_at: null, resource_reservation: false};
  assert.equal(normalizeSupervisionSnapshot(value, 'p').runs[0].execution_target.mode, 'fixed_site');
});

test('malformed response is an error and never enables waveform viewing', async () => {
  const f = fixture(async () => snapshot('different')), c = createSupervisionController(f.host); await c.ready();
  assert.equal(c.state.status, 'error'); assert.equal(c.state.snapshot, null); assert.equal(c.waveformPolicy().allowed, false); c.destroy();
});

test('execution labels require exact supporting exit-code/raw-state semantics', () => {
  const valid = [
    ['succeeded', 'simulator_complete_pending_measurements', 0],
    ['failed', 'simulator_complete_pending_measurements', 1],
    ...['simulator_failed', 'input_hash_failure', 'job_setup_failed', 'preflight_failed'].map(raw => ['failed', raw, null]),
    ['running', 'running_observed', null], ['queued', 'preflight', null], ['unknown', 'collected', 0],
  ];
  for (const [state, raw, code] of valid) {
    const value = snapshot(); Object.assign(value.runs[0].execution, {state, raw_state: raw, exit_code: code});
    assert.equal(normalizeSupervisionSnapshot(value, 'p').runs[0].execution.state, state);
  }
  const invalid = [
    ['succeeded', 'collected', 0], ['succeeded', 'simulator_complete_pending_measurements', null],
    ['succeeded', 'simulator_complete_pending_measurements', 1], ['failed', 'unknown', null],
    ['failed', 'simulator_complete_pending_measurements', 0], ['running', 'running', 2],
  ];
  for (const [state, raw, code] of invalid) {
    const value = snapshot(); Object.assign(value.runs[0].execution, {state, raw_state: raw, exit_code: code});
    assert.throws(() => normalizeSupervisionSnapshot(value, 'p'));
  }
});

test('observation timestamps, presence state, and waveform identity must agree', () => {
  const missing = snapshot(), run = missing.runs[0];
  run.observation = {state: 'missing', observed_at: null}; run.execution.observed_at = null; run.latest_observed_at = null;
  assert.equal(normalizeSupervisionSnapshot(missing, 'p').runs[0].latest_observed_at, null);
  const invalid = [
    r => {r.execution.observed_at = READ;}, r => {r.latest_observed_at = READ;},
    r => {r.observation.observed_at = null;}, r => {r.observation.state = 'missing';},
    r => {r.waveform_run_id = 'other';}, r => {r.source_commit = null;},
  ];
  for (const mutate of invalid) {const value = snapshot(); mutate(value.runs[0]); assert.throws(() => normalizeSupervisionSnapshot(value, 'p'));}
  const value = snapshot(); value.runs[0].source_commit = null; value.runs[0].waveform_run_id = null;
  assert.equal(normalizeSupervisionSnapshot(value, 'p').runs[0].source_commit, null);
});

test('repeated refresh clicks share the in-flight read', async () => {
  const wait = deferred(), f = fixture(() => wait.promise), c = createSupervisionController(f.host);
  const first = c.ready(); assert.equal(c.refresh(), first); assert.equal(c.refresh(), first);
  await Promise.resolve(); assert.equal(f.calls.length, 1); wait.resolve(snapshot()); await first; c.destroy();
});
