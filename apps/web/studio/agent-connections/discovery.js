// UI-only adapter for connection-contract.md v1. Requests use the injected Studio gateway.
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, fallback = '未知') => typeof value === 'string' && value.trim() && value.length <= 256 ? value : fallback;
const count = value => Number.isInteger(value) && value > 0 ? value : 0;

export function discoveryLabel(codex) {
  const sources = {configured: '指定配置', path: 'PATH', official_app: '官方应用位置', none: '无', unknown: '未知来源'};
  if (codex.executable_found) return `已发现 Codex 可执行文件 · ${sources[codex.source] || '未知来源'}`;
  if (codex.source === 'configured' && ['configured_executable_unavailable', 'invalid_executable_configuration'].includes(codex.reason)) {
    return '指定的 Codex 配置不可用；未改选其他程序。';
  }
  return '未发现可用的 Codex 可执行文件。';
}

export function sessionBlock(session) {
  if (!session) return '请选择检查所用的网页会话。';
  if (count(session.pending_approval_count) || count(session.suspended_approval_count)) return '此会话有待批准或暂停的审批，请先在原会话中处理。';
  if (['starting', 'running'].includes(session.state)) return '此会话正在运行，请等待回合结束。';
  if (session.state === 'suspended') return '此会话已暂停；请在原会话查看原因，或选择新的空闲会话。';
  if (!['idle', 'complete'].includes(session.state)) return '此会话当前不可检查，请选择空闲会话。';
  return '';
}

export function createDiscoveryController({request, onChange = () => {}} = {}) {
  let state = {discoveryPhase: 'unknown', discovery: null, sessionsPhase: 'unknown', sessions: [],
    selectedSessionId: '', checkPhase: 'idle', metadata: null, notice: ''};
  let destroyed = false, generation = 0;
  const getState = () => {
    const session = state.sessions.find(item => item.session_id === state.selectedSessionId);
    const reason = state.checkPhase === 'loading' ? '正在读取账号元数据。' :
      state.discoveryPhase !== 'ready' ? '请先读取本机发现结果。' :
      !state.discovery?.codex.executable_found ? '未发现可用的 Codex 程序。' :
      state.sessionsPhase !== 'ready' ? '网页会话列表尚不可用。' : sessionBlock(session);
    return {...state, sessions: state.sessions.map(item => ({...item})), canConnect: !destroyed && !reason, blockReason: reason};
  };
  const publish = () => { if (!destroyed) onChange(getState()); };

  async function refresh() {
    if (destroyed || state.checkPhase === 'loading' || state.discoveryPhase === 'loading' || state.sessionsPhase === 'loading') return;
    const ticket = ++generation;
    state = {...state, discoveryPhase: 'loading', discovery: null, sessionsPhase: 'loading',
      checkPhase: 'idle', metadata: null, notice: ''};
    publish();
    if (typeof request !== 'function') {
      state = {...state, discoveryPhase: 'error', sessionsPhase: 'error', sessions: [], notice: '工作台网关不可用，无法检查本机 Codex。'};
      publish(); return;
    }
    await Promise.all([
      (async () => {
        try {
          const value = await request('/ai/discovery');
          if (destroyed || ticket !== generation) return;
          if (value?.schema !== 'ic.ai.discovery.v1' || !record(value.codex) || typeof value.codex.executable_found !== 'boolean') throw Error('Invalid discovery');
          // Keep only the display allowlist; never expose arbitrary response text or paths.
          state.discovery = {codex: {executable_found: value.codex.executable_found,
            source: ['configured', 'path', 'official_app', 'none'].includes(value.codex.source) ? value.codex.source : 'unknown',
            reason: ['configured_executable_unavailable', 'invalid_executable_configuration'].includes(value.codex.reason) ? value.codex.reason : null},
            desktop: {installed: value.desktop?.installed === true ? true : 'unknown', running: 'unknown'}};
          state.discoveryPhase = 'ready';
        } catch { if (!destroyed && ticket === generation) { state.discoveryPhase = 'error'; state.notice = '本机发现失败；安装状态未知。未自动重试。'; } }
        publish();
      })(),
      (async () => {
        try {
          const value = await request('/ai/sessions');
          if (destroyed || ticket !== generation) return;
          if (!Array.isArray(value?.sessions) || value.sessions.length > 8 || value.sessions.some(item =>
            typeof item?.session_id !== 'string' || !item.session_id || item.session_id.length > 256 || typeof item.name !== 'string') ||
            new Set(value.sessions.map(item => item.session_id)).size !== value.sessions.length) throw Error('Invalid sessions');
          state.sessions = value.sessions.map(item => ({session_id: item.session_id, name: text(item.name), state: item.state,
            pending_approval_count: count(item.pending_approval_count), suspended_approval_count: count(item.suspended_approval_count)}));
          if (!state.sessions.some(item => item.session_id === state.selectedSessionId)) {
            state.selectedSessionId = state.sessions.some(item => item.session_id === 'default') ? 'default' : state.sessions.length === 1 ? state.sessions[0].session_id : '';
          }
          state.sessionsPhase = 'ready';
        } catch { if (!destroyed && ticket === generation) { state.sessionsPhase = 'error'; state.sessions = []; state.selectedSessionId = ''; state.notice = '无法读取网页会话，请刷新后再选择。未自动重试。'; } }
        publish();
      })()
    ]);
  }

  function selectSession(id) {
    if (destroyed || state.checkPhase === 'loading' || state.discoveryPhase === 'loading' || state.sessionsPhase !== 'ready' || !state.sessions.some(item => item.session_id === id)) return;
    ++generation;
    state = {...state, selectedSessionId: id, metadata: null, checkPhase: 'idle', notice: ''};
    publish();
  }

  async function connect() {
    if (!getState().canConnect) return;
    const sessionId = state.selectedSessionId, ticket = ++generation;
    state = {...state, checkPhase: 'loading', metadata: null, notice: ''}; publish();
    try {
      const value = await request('/ai/connect', {method: 'POST', body: {session_id: sessionId}, timeout: 120000});
      if (destroyed || ticket !== generation) return;
      if (value?.schema !== 'ic.ai.connection.v1' || value.session_id !== sessionId || !['connected', 'partial', 'unavailable'].includes(value.status)) throw Error('Invalid connection');
      state = {...state, checkPhase: 'ready', metadata: metadataView(value)};
    } catch {
      if (destroyed || ticket !== generation) return;
      state = {...state, checkPhase: 'error', metadata: null, notice: '账号检查未完成，结果未知。请查看原会话状态；未自动重试。'};
    }
    publish();
  }
  return Object.freeze({getState, refresh, selectSession, connect, destroy() { destroyed = true; ++generation; }});
}

const accountTypes = {chatgpt: 'ChatGPT', chatgptAuthTokens: 'ChatGPT（令牌认证）', apiKey: 'API Key',
  amazonBedrock: 'Amazon Bedrock', agentIdentity: 'Agent Identity', personalAccessToken: 'Personal Access Token'};
const reasons = {
  manual_approval_required: '需要手动批准模式。请在原有设置中确认人工审批，再重新检查；本面板不会更改审批策略。',
  sign_in_required: '请在官方 Codex 中完成登录，再重新检查连接。',
  session_unavailable: '此网页会话不可用；请查看原会话状态，或在原会话栏新建空闲会话。',
  runtime_unavailable: 'Codex 运行时不可用。', metadata_check_failed: '元数据检查未完成。',
  empty_model_catalog: '模型目录为空，尚不能确认聊天可用。'
};

function windowText(window) {
  if (!record(window)) return null;
  const used = Number.isFinite(window.used_percent) && window.used_percent >= 0 && window.used_percent <= 100 ? `已用 ${window.used_percent}%` : '占用比例未知';
  const duration = Number.isFinite(window.window_duration_mins) && window.window_duration_mins > 0 ? ` / ${window.window_duration_mins} 分钟窗口` : '';
  const date = Number.isFinite(window.resets_at) && window.resets_at > 0 ? new Date(window.resets_at * 1000) : null;
  const reset = date && Number.isFinite(date.getTime()) ? `；重置 ${date.toLocaleString('zh-CN', {hour12: false})}（本地时间）` : '；重置时间未知';
  return used + duration + reset;
}

/** Render only the frozen public allowlist. No email, account ID, credentials or raw errors. */
export function metadataView(value) {
  const account = value.account || {}, usage = value.usage || {}, catalog = value.catalog || {};
  const usageRows = [];
  if (usage.status === 'available' && Array.isArray(usage.buckets) && usage.buckets.length <= 32) {
    for (const bucket of usage.buckets) {
      const primary = windowText(bucket?.primary), secondary = windowText(bucket?.secondary);
      const name = text(bucket?.limit_id, '未命名额度');
      if (primary) usageRows.push(`${name} · 主窗口：${primary}`);
      if (secondary) usageRows.push(`${name} · 次窗口：${secondary}`);
      if (!primary && !secondary) usageRows.push(`${name}：窗口数据未知`);
    }
  }
  const blocked = value.policy?.status === 'blocked' || value.chat?.status === 'blocked';
  const reason = value.policy?.status === 'blocked' ? 'manual_approval_required' : value.chat?.reason;
  return Object.freeze({
    summary: {connected: '账号元数据已读取', partial: '账号元数据部分可用', unavailable: '账号元数据不可用'}[value.status] || '账号元数据状态未知',
    login: {signed_in: '已登录', signed_out: '未登录', unknown: '未知'}[account.login_status] || '未知',
    accountType: Object.hasOwn(accountTypes, account.account_type) ? accountTypes[account.account_type] : '未知',
    plan: account.plan_type && account.plan_type !== 'unknown' ? text(account.plan_type) : '未知（官方未提供）',
    provider: text(catalog.provider), defaultModel: text(catalog.default_model),
    catalogStatus: {available: '目录已读取，不代表推理权限', unknown: '目录状态未知', unsupported: '模型目录接口不支持'}[catalog.status] || '目录状态未知',
    usage: usageRows.length ? usageRows : [{unknown: '用量未知', unsupported: '用量接口不支持', not_applicable: '此账号类型不适用'}[usage.status] || '用量未知（未返回窗口数据）'],
    policy: {manual: '手动批准模式', blocked: '审批策略阻断', unknown: '审批策略未知'}[value.policy?.status] || '审批策略未知',
    blocked, blockMessage: reasons[reason] || (blocked ? '聊天当前被阻断，请查看原会话执行详情。' : ''),
    signInRequired: account.login_status === 'signed_out' || value.chat?.reason === 'sign_in_required',
    chat: blocked ? '聊天被阻断' : value.chat?.status === 'unverified' ? '真实聊天未验证' : '聊天状态未知',
    inference: count(value.inference?.historical_completed_turns) ? `未发起模型测试；有 ${count(value.inference.historical_completed_turns)} 个历史完成回合，不代表本次连接已验证。` : '未发起模型测试；元数据读取成功不代表真实聊天已验证。'
  });
}
