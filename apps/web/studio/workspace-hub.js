/** Unified top-bar connection hub for Codex AI, SpiceOwl remote simulation, and local Git/library services. */
export function mountWorkspaceHub({
  toolbar,
  mode = 'demo',
  getStatus = () => ({}),
  subscribe = () => () => {},
  onConnect = null,
  onDisconnect = null,
  onOpenAI = null,
  onOpenSimulation = null,
  onOpenConnections = null,
} = {}) {
  if (!toolbar) return { update() {}, open() {}, destroy() {} };
  const doc = toolbar.ownerDocument;
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let destroyed = false, dialog = null;

  const pill = el('button', 'cg-hub-pill');
  pill.type = 'button';
  pill.id = 'studio-connection-hub';
  pill.setAttribute('aria-haspopup', 'dialog');
  const dot = el('span', 'cg-hub-dot');
  const pillText = el('span', 'cg-hub-label');
  pill.append(dot, pillText);

  const viewMenu = toolbar.querySelector('.studio-view-menu');
  if (viewMenu) toolbar.insertBefore(pill, viewMenu);
  else toolbar.append(pill);

  function renderPill() {
    if (destroyed) return;
    const s = getStatus() || {};
    const anyConnected = Boolean(s.ai || s.simulation || s.library);
    pill.dataset.state = mode === 'live' ? 'live' : anyConnected ? 'connected' : s.connecting ? 'connecting' : 'disconnected';
    if (mode === 'live') {
      pillText.textContent = s.ai ? '本机工作台 · AI 就绪' : '本机工作台 · 仿真就绪';
      pill.title = '查看本机工作台、AI / MCP 与远端仿真连接状态';
    } else if (s.connecting) {
      pillText.textContent = '正在连接助手…';
      pill.title = '正在与本机工作台助手配对';
    } else if (anyConnected) {
      const active = [s.ai && 'Codex', s.simulation && 'SpiceOwl', s.library && 'Git'].filter(Boolean);
      pillText.textContent = '已连接 · ' + (active.join(' / ') || '本机助手');
      pill.title = '已连接统一本机助手；点击查看状态或断开';
    } else {
      pillText.textContent = '连接本机助手';
      pill.title = '一次授权，同时启用 Codex AI、远端仿真（SpiceOwl）与本地电路库';
    }
  }

  function renderDialog() {
    if (!dialog || destroyed) return;
    const s = getStatus() || {};
    const anyConnected = Boolean(s.ai || s.simulation || s.library);
    dialog.replaceChildren();
    const head = el('header', 'cg-hub-head');
    head.append(el('strong', '', '工作台统一连接'));
    const close = el('button', 'cg-hub-close', '关闭');
    close.type = 'button';
    close.onclick = () => dialog.close();
    head.append(close);
    dialog.append(head);

    dialog.append(el('p', 'cg-hub-desc',
      mode === 'live'
        ? '当前运行在本机工作台模式：远端仿真、Git 与原理图网关已同源连接。AI 可通过内置 Codex 桥接或外部 MCP 客户端接入。'
        : '一次授权连接本机助手，同时打通 AI Agent（Codex）、远端服务器仿真（SpiceOwl / SSH）与本地电路库（Git / PR），无需在多个面板重复连接。'));

    const list = el('div', 'cg-hub-services');
    const rows = mode === 'live'
      ? [
          ['远端仿真与 PDK（SpiceOwl / SSH）', s.simulation !== false ? '已接入本机网关' : '未启用', s.simulation !== false ? 'ok' : 'muted'],
          ['AI Agent 调度（Codex / MCP）', s.ai ? '内置桥接已启用' : '使用外部 MCP 或配置 Codex 桥接', s.ai ? 'ok' : 'muted'],
          ['工程源码与 Git 版本', s.library !== false ? '本机工作区就绪' : '只读模式', s.library !== false ? 'ok' : 'muted'],
        ]
      : [
          ['AI Agent（Codex）', s.ai ? '已连接 · 统一调度' : '未连接', s.ai ? 'ok' : 'muted'],
          ['远端仿真与 PDK（SpiceOwl / SSH）', s.simulation ? '已连接 · 共用同一助手' : '未连接', s.simulation ? 'ok' : 'muted'],
          ['本地电路库与 Git / PR', s.library ? '已连接 · 可读写与提 PR' : '公开只读预览', s.library ? 'ok' : 'muted'],
        ];
    for (const [name, stateLabel, kind] of rows) {
      const row = el('div', 'cg-hub-service');
      row.append(el('span', 'cg-hub-service-name', name), el('span', 'cg-hub-badge is-' + kind, stateLabel));
      list.append(row);
    }
    dialog.append(list);

    if (s.detail) dialog.append(el('p', 'cg-hub-meta', s.detail));

    const actions = el('div', 'cg-hub-actions');
    if (mode === 'demo') {
      if (!anyConnected && typeof onConnect === 'function') {
        const primary = el('button', 'cg-hub-primary', s.connecting ? '正在连接…' : '一键连接本机助手');
        primary.type = 'button';
        primary.disabled = Boolean(s.connecting);
        primary.onclick = () => {
          dialog.close();
          void onConnect();
        };
        actions.append(primary);
      }
      if (anyConnected && typeof onDisconnect === 'function') {
        const disc = el('button', 'cg-hub-danger', '断开全部连接');
        disc.type = 'button';
        disc.onclick = () => {
          void onDisconnect();
          renderPill();
          renderDialog();
        };
        actions.append(disc);
      }
    } else if (typeof onOpenConnections === 'function') {
      const mcp = el('button', 'cg-hub-primary', '配置 AI / MCP 连接…');
      mcp.type = 'button';
      mcp.onclick = () => {
        dialog.close();
        void onOpenConnections();
      };
      actions.append(mcp);
    }
    if (typeof onOpenSimulation === 'function') {
      const sim = el('button', '', '打开远端仿真面板');
      sim.type = 'button';
      sim.onclick = () => {
        dialog.close();
        void onOpenSimulation();
      };
      actions.append(sim);
    }
    if (typeof onOpenAI === 'function') {
      const aiBtn = el('button', '', '打开 AI 面板');
      aiBtn.type = 'button';
      aiBtn.onclick = () => {
        dialog.close();
        void onOpenAI();
      };
      actions.append(aiBtn);
    }
    dialog.append(actions);
  }

  function open() {
    if (destroyed) return;
    if (!dialog) {
      dialog = el('dialog', 'cg-hub-dialog');
      dialog.setAttribute('aria-label', '工作台统一连接');
      dialog.addEventListener('keydown', e => e.stopPropagation());
      doc.body.append(dialog);
    }
    renderDialog();
    if (!dialog.open) dialog.showModal();
  }

  pill.onclick = open;
  const update = () => {
    renderPill();
    if (dialog?.open) renderDialog();
  };
  const off = subscribe(update);
  renderPill();

  return {
    update,
    open,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      off?.();
      dialog?.close();
      dialog?.remove();
      pill.remove();
    },
  };
}
