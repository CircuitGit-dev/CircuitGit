import {createDiscoveryController, discoveryLabel} from './discovery.js';

export function mountLocalCodex(root, {request} = {}) {
  const document = root.ownerDocument;
  const make = (tag, value = '', className = '') => {
    const node = document.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  root.className = 'ic-local-codex';
  const header = make('div', '', 'ic-local-codex-header');
  const refresh = make('button', '刷新发现'); refresh.type = 'button';
  header.append(make('h3', '本机 Codex'), refresh);
  const discovery = make('p', '尚未检查'), location = make('p', '检测位置：工作台后端所在主机。发现程序不代表已登录或可推理。', 'ic-agent-connections-hint');
  const desktop = make('p', '', 'ic-agent-connections-hint');
  const toolbar = make('div', '', 'ic-local-codex-toolbar');
  const label = make('label', '检查所用会话 '), sessions = make('select'); sessions.setAttribute('aria-label', '检查所用网页会话');
  label.append(sessions);
  const connect = make('button', '连接并读取账号'); connect.type = 'button'; toolbar.append(label, connect);
  const actionHint = make('p', '将按所选网页会话检查账号；可能启动 app-server，不发送模型消息。无需保持 Codex 桌面应用打开。', 'ic-agent-connections-hint');
  const notice = make('p', '', 'ic-local-codex-notice'); notice.setAttribute('role', 'status');
  const result = make('div', '', 'ic-local-codex-result');
  const other = make('p', '其他 agent：本版未接入；安装、登录及订阅状态未知。', 'ic-agent-connections-hint');
  root.append(header, discovery, location, desktop, toolbar, actionHint, notice, result, other);
  const controller = createDiscoveryController({request, onChange: render});
  function render(state) {
    const busy = state.discoveryPhase === 'loading' || state.sessionsPhase === 'loading' || state.checkPhase === 'loading';
    refresh.disabled = busy;
    sessions.disabled = busy || state.sessionsPhase !== 'ready';
    connect.disabled = !state.canConnect;
    connect.textContent = state.checkPhase === 'loading' ? '正在读取账号…' : '连接并读取账号';
    if (state.discoveryPhase === 'ready') {
      const codex = state.discovery.codex;
      discovery.textContent = discoveryLabel(codex);
      desktop.textContent = `桌面应用：${state.discovery.desktop.installed === true ? '已发现安装位置' : '安装状态未知'}；运行状态未知。`;
    } else {
      discovery.textContent = {unknown: '尚未检查', loading: '正在发现本机 Codex…', error: '发现失败 · 安装状态未知'}[state.discoveryPhase];
      desktop.textContent = '';
    }
    sessions.replaceChildren();
    if (!state.selectedSessionId) {
      const option = make('option', state.sessionsPhase === 'loading' ? '正在读取会话…' : '请选择会话'); option.value = ''; sessions.append(option);
    }
    for (const item of state.sessions) {
      const option = make('option', item.name); option.value = item.session_id; sessions.append(option);
    }
    sessions.value = state.selectedSessionId;
    notice.textContent = state.notice || (state.checkPhase === 'loading' ? '正在读取元数据；未发起模型测试。' : state.blockReason);
    notice.hidden = !notice.textContent;
    result.replaceChildren();
    if (!state.metadata) {
      result.append(make('p', '账号、套餐和用量尚未读取；真实聊天未验证。', 'ic-agent-connections-hint'));
      return;
    }
    const data = state.metadata;
    result.append(make('p', `${data.summary} · ${data.chat}`, 'ic-local-codex-summary'));
    const fields = make('dl');
    for (const [name, value] of [['登录 / 类型', `${data.login} / ${data.accountType}`], ['套餐', data.plan],
      ['Provider', data.provider], ['默认模型', `${data.defaultModel} · ${data.catalogStatus}`], ['审批', data.policy]]) {
      fields.append(make('dt', name), make('dd', value));
    }
    result.append(fields);
    const usage = make('div', '', 'ic-local-codex-usage'); usage.append(make('strong', '用量 · 配额窗口占用'));
    for (const row of data.usage) usage.append(make('p', row));
    result.append(usage, make('p', data.inference, 'ic-agent-connections-hint'));
    if (data.blockMessage) result.append(make('p', data.blockMessage, 'ic-local-codex-blocked'));
    if (data.signInRequired && !data.blockMessage.includes('官方 Codex')) result.append(make('p', '请在官方 Codex 中完成登录，再重新检查连接。', 'ic-local-codex-blocked'));
    result.append(make('p', '网页聊天使用 Codex app-server；无需复制 MCP 配置。请回到原会话选择模型并正常发送消息。', 'ic-agent-connections-hint'));
  }
  refresh.addEventListener('click', () => void controller.refresh());
  sessions.addEventListener('change', () => controller.selectSession(sessions.value));
  connect.addEventListener('click', () => void controller.connect());
  render(controller.getState());
  return Object.freeze({refresh: controller.refresh, getState: controller.getState, destroy() {controller.destroy(); root.replaceChildren();}});
}
