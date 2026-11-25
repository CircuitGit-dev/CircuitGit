// Stored supervision is read-only evidence. Refresh never observes a remote simulator.
const COMMIT = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,180}$/;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 240) => typeof value === 'string' && value.length <= limit;
const nullableText = (value, limit) => value === null || text(value, limit);
const nullableHash = (value, pattern) => value === null || typeof value === 'string' && pattern.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const oneOf = (value, choices) => choices.includes(value);
const nullableBoolean = value => value === null || typeof value === 'boolean';
const resourceTimestamp = value => {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 64 || !/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/.test(value)
      || /[\r\n]/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year > 0 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
};
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const requireValid = condition => { if (!condition) throw Error('监督记录的格式或项目身份不符。'); };
const executionState = ({exit_code: code, raw_state: raw}) => {
  if (code === 0 && raw === 'simulator_complete_pending_measurements') return 'succeeded';
  if (code !== null && code !== 0 || ['simulator_failed', 'input_hash_failure', 'job_setup_failed', 'preflight_failed'].includes(raw)) return 'failed';
  if (['running', 'running_observed'].includes(raw)) return 'running';
  if (['queued', 'preflight'].includes(raw)) return 'queued';
  return 'unknown';
};

/** Validate bounded untrusted gateway evidence before it reaches a view. */
export function normalizeSupervisionSnapshot(value, projectId) {
  requireValid(isObject(value) && value.schema === 'ic.supervision.snapshot.v1'
    && text(value.project_id, 180) && value.project_id === projectId
    && value.source === 'stored_observations' && typeof value.single_site === 'boolean'
    && text(value.read_at, 1024) && Array.isArray(value.runs) && value.runs.length <= 25
    && integer(value.scanned_records) && value.scanned_records <= 200
    && integer(value.unavailable_records) && typeof value.truncated === 'boolean');
  const ids = new Set();
  for (const run of value.runs) {
    requireValid(isObject(run) && typeof run.run_id === 'string' && RUN_ID.test(run.run_id)
      && !ids.has(run.run_id) && run.project_id === projectId
      && nullableText(run.original_project_id) && nullableText(run.configuration)
      && oneOf(run.association_basis, ['recorded_project_id', 'recorded_plan_design_id', 'unregistered'])
      && nullableHash(run.source_commit, COMMIT) && nullableHash(run.compiled_inputs_sha256, HASH)
      && nullableText(run.state) && nullableText(run.latest_observed_at)
      && nullableText(run.record_updated_at) && nullableText(run.waveform_run_id));
    ids.add(run.run_id);
    for (const key of ['library_id','cell_id']) if (key in run) {
      requireValid(run[key] === null || typeof run[key] === 'string'
        && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}$/.test(run[key]) && !/[^A-Za-z0-9_.-]/.test(run[key]));
    }
    if ('execution_target' in run) {
      const target=run.execution_target;
      requireValid(isObject(target) && Object.keys(target).sort().join(',') === 'host_id,mode,plan_id,resource_observed_at,resource_reservation'
        && target.resource_reservation === false && resourceTimestamp(target.resource_observed_at));
      requireValid(target.mode === 'fixed_site'
        ? target.host_id === null && target.plan_id === null && target.resource_observed_at === null
        : target.mode === 'resource_pool' && typeof target.host_id === 'string'
          && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(target.host_id) && !/[^A-Za-z0-9_-]/.test(target.host_id)
          && typeof target.plan_id === 'string' && target.plan_id.length === 64 && HASH.test(target.plan_id));
    }
    const {execution, observation, data, specification} = run;
    requireValid(isObject(execution) && oneOf(execution.state, ['queued', 'running', 'succeeded', 'failed', 'unknown'])
      && nullableText(execution.raw_state) && (execution.exit_code === null || Number.isSafeInteger(execution.exit_code))
      && nullableText(execution.observed_at));
    requireValid(isObject(observation) && oneOf(observation.state, ['recorded', 'missing'])
      && nullableText(observation.observed_at));
    requireValid(execution.state === executionState(execution)
      && execution.observed_at === observation.observed_at && observation.observed_at === run.latest_observed_at
      && observation.state === (observation.observed_at ? 'recorded' : 'missing')
      && (run.waveform_run_id === null || run.waveform_run_id === run.run_id && run.source_commit !== null));
    requireValid(isObject(data) && oneOf(data.state, ['not_collected', 'collecting', 'collected', 'failed', 'unknown'])
      && nullableBoolean(data.raw_retained));
    requireValid(isObject(specification) && oneOf(specification.state, ['reported', 'not_evaluated'])
      && Array.isArray(specification.metrics) && specification.metrics.length <= 16);
    for (const metric of specification.metrics) {
      requireValid(isObject(metric) && text(metric.name, 160)
        && (metric.value === null || typeof metric.value === 'number' && Number.isFinite(metric.value))
        && nullableText(metric.unit) && nullableText(metric.scope) && nullableBoolean(metric.passed));
    }
    requireValid(Array.isArray(run.issues) && run.issues.length <= 8
      && run.issues.every(issue => isObject(issue) && text(issue.code, 80) && text(issue.message)));
    requireValid(Array.isArray(run.artifacts) && run.artifacts.length <= 7
      && run.artifacts.every(artifact => isObject(artifact) && text(artifact.name, 80)
        && integer(artifact.bytes) && nullableHash(artifact.sha256, HASH) && text(artifact.url, 320)
        && oneOf(artifact.digest_source, ['stored_record', 'unavailable'])));
  }
  // Keep original timestamps/identities; do not infer freshness or repair legacy records.
  return freeze(structuredClone(value));
}

export function supervisionDimensions(run) {
  return [
    {key: 'execution', label: '仿真执行', value: {
      queued: '记录为排队', running: '记录为运行中', succeeded: '记录为成功', failed: '记录为失败', unknown: '未知'
    }[run.execution.state]},
    {key: 'observation', label: '观察记录', value: {recorded: '已有保存记录', missing: '缺少记录'}[run.observation.state]},
    {key: 'data', label: '数据收集', value: {
      not_collected: '未收集', collecting: '记录为收集中', collected: '已收集', failed: '收集失败', unknown: '未知'
    }[run.data.state]},
    {key: 'specification', label: '指标报告', value: {
      reported: '已有指标报告', not_evaluated: '未评估'
    }[run.specification.state]},
  ];
}

const readyProject = context => context?.loadState === 'ready' && !context.loading
  && text(context.project?.id, 180) && context.project.id ? context.project.id : null;

export function createSupervisionController(host, changed = () => {}) {
  let disposed = false, generation = 0, pending = Promise.resolve(null);
  const state = {projectId: null, selectedRunId: null, status: 'idle', snapshot: null, error: null};
  const notify = () => { if (!disposed) changed(); };
  const context = () => host.context.getContext();
  const selectedRun = () => state.snapshot?.runs.find(run => run.run_id === state.selectedRunId) || null;
  function refresh() {
    if (disposed || !state.projectId || readyProject(context()) !== state.projectId) return Promise.resolve(null);
    if (state.status === 'loading') return pending;
    const projectId = state.projectId, token = ++generation;
    state.status = 'loading'; state.error = null;
    // Defer the request so an observer can safely call ready() after this state update.
    pending = Promise.resolve().then(async () => {
      if (disposed || token !== generation) return null;
      try {
        const result = await host.gateway.request('/supervision?' + new URLSearchParams({project_id: projectId}), {method: 'GET'});
        if (disposed || token !== generation || readyProject(context()) !== projectId) return null;
        state.snapshot = normalizeSupervisionSnapshot(result, projectId); state.status = 'ready';
        return state.snapshot;
      } catch (error) {
        if (disposed || token !== generation) return null;
        // Preserve the last successful read for this project, clearly marked as old.
        // Project changes clear it synchronously in synchronize().
        state.status = error?.status === 404 ? 'unavailable' : 'error';
        state.error = state.status === 'unavailable' ? null : String(error?.message || '无法读取保存的监督记录。').slice(0, 240);
        return null;
      } finally {
        if (!disposed && token === generation) notify();
      }
    });
    notify();
    return pending;
  }
  function synchronize() {
    if (disposed) return;
    const current = context(), projectId = readyProject(current);
    state.selectedRunId = projectId && current.run?.projectId === projectId ? current.run.runId || null : null;
    if (projectId !== state.projectId) {
      ++generation; state.projectId = projectId; state.snapshot = null; state.error = null; state.status = 'idle';
      if (projectId) { refresh(); return; }
    }
    notify();
  }
  function waveformPolicy() {
    const current = context(), run = selectedRun();
    if (disposed || state.status !== 'ready' || !run) return {allowed: false, reason: '请先读取当前所选任务的保存记录。'};
    if (readyProject(current) !== state.projectId || current.run?.projectId !== state.projectId
      || current.run.runId !== run.run_id || run.project_id !== state.projectId
      || !COMMIT.test(run.source_commit || '') || current.run.sourceCommit !== run.source_commit) {
      return {allowed: false, reason: '当前所选任务与记录的项目、运行或源版本不一致。'};
    }
    if (run.waveform_run_id !== run.run_id) return {allowed: false, reason: '缺少绑定同一运行和源版本的保存波形。'};
    if (typeof host.plot?.openWindow !== 'function') return {allowed: false, reason: '当前宿主未提供波形窗口。'};
    return {allowed: true, reason: null};
  }
  const unsubscribe = host.context.subscribe(synchronize);
  synchronize();
  return {
    get state() { return {...state}; },
    ready: () => pending,
    refresh, selectedRun, waveformPolicy,
    openWaveforms() {
      // Recheck at click time; no selectRun(), context writes or list/status refresh.
      const policy = waveformPolicy();
      if (!policy.allowed) throw Error(policy.reason);
      return host.plot.openWindow();
    },
    destroy() { if (disposed) return; disposed = true; ++generation; unsubscribe(); },
  };
}

/** Mount once and retain root when the containing simulation panel rerenders. */
export function mountSupervision(root, {host}) {
  const doc = root.ownerDocument;
  let controller = null, disposed = false, detailsOpen = false, detailIdentity = null;
  const element = (tag, value, className) => {
    const node = doc.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const note = (parent, value, kind = 'ic-sim-note') => parent.append(element('p', value, kind));
  const display = value => value === null || value === undefined || value === '' ? '未记录' : String(value);
  function button(label, action, disabled = false) {
    const node = element('button', label); node.type = 'button'; node.disabled = disabled;
    node.addEventListener('click', () => Promise.resolve().then(action).catch(error => {
      if (!disposed) host.notify?.(String(error?.message || error), {kind: 'error'});
    }));
    return node;
  }
  function table(parent, headings, rows) {
    const node = element('table', undefined, 'ic-sim-metrics'), head = element('thead'), tr = element('tr');
    for (const title of headings) { const cell = element('th', title); cell.scope = 'col'; tr.append(cell); }
    head.append(tr); node.append(head); const body = element('tbody');
    for (const row of rows) {
      const line = element('tr');
      row.forEach((value, index) => { const cell = element(index ? 'td' : 'th', value); if (!index) cell.scope = 'row'; line.append(cell); });
      body.append(line);
    }
    node.append(body); parent.append(node);
  }
  function render() {
    if (!controller || disposed) return;
    const state = controller.state, run = controller.selectedRun();
    const identity = JSON.stringify([state.projectId, run?.run_id, run?.source_commit]);
    if (identity !== detailIdentity) { detailsOpen = false; detailIdentity = identity; }
    else { const existing = root.querySelector('[data-supervision-inner]'); if (existing) detailsOpen = existing.open; }
    root.replaceChildren();
    const card = element('details', undefined, 'ic-sim-detail'); card.setAttribute('aria-label', 'SpiceOwl 保存的仿真监督记录');
    card.dataset.supervisionCard = '';
    card.open = Boolean(run || state.status === 'error' || detailsOpen);
    const head = element('summary');
    head.append(element('span', 'SpiceOwl · 仿真监督'), element('span', run ? '已选任务' : '保存的观察', 'ic-sim-status'));
    card.append(head); root.append(card);
    const toolbar = element('div', undefined, 'ic-sim-toolbar');
    toolbar.append(button(state.status === 'loading' ? '读取中…' : '刷新本地记录', () => controller.refresh(), !state.projectId || state.status === 'loading'));
    card.append(toolbar);
    if (!state.projectId) { note(card, '等待项目加载完成。'); return; }
    if (state.status === 'unavailable') {
      note(card, '未接入：当前网关未提供 SpiceOwl 监督记录。');
      if (!state.snapshot) return;
    }
    if (state.status === 'error') {
      note(card, '本地记录读取失败：' + state.error, 'ic-sim-warning');
      if (!state.snapshot) return;
    }
    if (!state.snapshot) { note(card, '正在读取保存的记录。'); return; }
    const snapshot = state.snapshot;
    if (['error', 'unavailable'].includes(state.status)) note(card, '当前读取失败，以下为上次记录。', 'ic-sim-warning');
    else if (state.status === 'loading') note(card, '正在刷新，以下为上次记录。');
    note(card, (state.status === 'ready' ? '本次读取：' : '上次成功读取：') + display(snapshot.read_at));
    note(card, '仅显示保存的观察；刷新不检查远端仿真器。');
    if (snapshot.truncated || snapshot.unavailable_records) {
      note(card, `记录范围不完整：扫描 ${snapshot.scanned_records} 条，返回 ${snapshot.runs.length} 条，无法读取 ${snapshot.unavailable_records} 条${snapshot.truncated ? '；已达到读取范围限制' : ''}。`, 'ic-sim-warning');
    }
    if (!state.selectedRunId) { note(card, '从运行记录选择任务后查看监督信息。'); return; }
    note(card, '运行：' + state.selectedRunId);
    if (!run) { note(card, '当前读取范围中没有该任务的保存监督记录。'); return; }
    table(card, ['维度', '保存状态'], supervisionDimensions(run).map(item => [item.label, item.value]));
    note(card, '最近观察：' + display(run.latest_observed_at));
    note(card, '数据已收集不代表指标合格；指标报告的判定见各项记录。');
    const policy = controller.waveformPolicy();
    const waveformButton = button('查看保存波形', () => controller.openWaveforms(), !policy.allowed);
    waveformButton.title = policy.reason || '打开当前所选运行的保存波形'; toolbar.append(waveformButton);
    if (!policy.allowed) note(card, policy.reason);
    const details = element('details', undefined, 'ic-sim-detail'); details.dataset.supervisionInner = ''; details.open = detailsOpen;
    details.append(element('summary', '身份、指标与原始记录'));
    details.addEventListener('toggle', () => { if (details.isConnected) detailsOpen = details.open; });
    card.append(details);
    details.append(element('pre', JSON.stringify({
      project_id: run.project_id, original_project_id: run.original_project_id,
      association_basis: run.association_basis, run_id: run.run_id, source_commit: run.source_commit,
      configuration: run.configuration, compiled_inputs_sha256: run.compiled_inputs_sha256,
      execution_observed_at: run.execution.observed_at, observation_observed_at: run.observation.observed_at,
      record_updated_at: run.record_updated_at, exit_code: run.execution.exit_code,
      raw_state: run.state, raw_retained: run.data.raw_retained,
    }, null, 2), 'ic-sim-code'));
    if (run.issues.length) {
      const list = element('ul');
      for (const issue of run.issues) list.append(element('li', `${issue.code}：${issue.message}`));
      details.append(list);
    }
    if (run.specification.metrics.length) {
      table(details, ['指标 / 范围', '数值', '记录判定'], run.specification.metrics.map(metric => [
        metric.name + (metric.scope ? '\n' + metric.scope : ''),
        metric.value === null ? '未记录' : String(metric.value) + (metric.unit ? ' ' + metric.unit : ''),
        metric.passed === true ? '通过' : metric.passed === false ? '未通过' : '未判定',
      ]));
    } else note(details, '没有保存的指标条目。');
    if (run.artifacts.length) {
      note(details, '文件摘要为保存的元数据，当前读取未重新核验文件。');
      // Do not turn untrusted record URLs into download links.
      for (const artifact of run.artifacts) {
        details.append(element('pre', `${artifact.name}\n${artifact.bytes} bytes\nSHA-256: ${display(artifact.sha256)}\n摘要来源: ${artifact.digest_source}`, 'ic-sim-code'));
      }
    }
  }
  controller = createSupervisionController(host, render); render();
  return {controller, destroy() { if (disposed) return; disposed = true; controller.destroy(); root.replaceChildren(); }};
}
