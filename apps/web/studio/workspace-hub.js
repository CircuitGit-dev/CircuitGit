import {probeLocalConnector,wakeLocalConnector} from '../remote/pair.js';

const REPO_URL = 'https://github.com/CircuitGit-dev/CircuitGit';
const RELEASES_URL = REPO_URL + '/archive/refs/heads/main.zip';
const SETUP_DOC_URL = REPO_URL + '/blob/main/docs/remote-node.md';

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
  if (!toolbar) return { update() {}, open() {}, requireConnector() {}, destroy() {} };
  const doc = toolbar.ownerDocument, win = doc.defaultView || window;
  const isWindows = /win/i.test(String(win.navigator?.userAgentData?.platform || win.navigator?.platform || win.navigator?.userAgent || ''));
  const launcherName = isWindows ? 'Start CircuitGit.bat' : 'Start CircuitGit.command';
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let destroyed = false, dialog = null;
  let connectorState = 'unknown'; // 'unknown' | 'ready' | 'waking' | 'missing'
  let requiredFeature = '';

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

  async function refreshConnectorHealth() {
    if (mode !== 'demo' || destroyed) return false;
    const alive = await probeLocalConnector({ timeout: 900 });
    if (destroyed) return false;
    connectorState = alive ? 'ready' : (connectorState === 'missing' ? 'missing' : 'unknown');
    if (dialog?.open) renderDialog();
    return alive;
  }

  async function attemptWakeup() {
    if (destroyed || connectorState === 'waking') return;
    connectorState = 'waking';
    renderDialog();
    const res = await wakeLocalConnector({ win, timeout: 4500, interval: 350 });
    if (destroyed) return;
    connectorState = res.status === 'ready' ? 'ready' : 'missing';
    renderDialog();
  }

  function renderPill() {
    if (destroyed) return;
    const s = getStatus() || {};
    const anyConnected = Boolean(s.ai || s.simulation || s.library);
    pill.dataset.state = mode === 'live' ? 'live' : anyConnected ? 'connected' : s.connecting ? 'connecting' : 'disconnected';
    if (mode === 'live') {
      pillText.textContent = s.ai ? '本机工作台 · AI 就绪' : '本机工作台 · 仿真就绪';
      pill.title = '查看本机工作台、AI / MCP 与远端仿真连接状态';
    } else if (s.connecting) {
      pillText.textContent = '正在连接本机…';
      pill.title = '正在与本机连接器配对';
    } else if (anyConnected) {
      const active = [s.ai && 'AI', s.simulation && 'SSH 仿真', s.library && 'Git'].filter(Boolean);
      pillText.textContent = '已连接 · ' + (active.join(' / ') || '本机');
      pill.title = '已连接本机连接器；点击查看状态或断开';
    } else {
      pillText.textContent = '连接本机 (SSH / AI)';
      pill.title = '连接本机以启用远端 SSH 服务器仿真、Codex AI 与本地 Git 分支';
    }
  }

  function renderDialog() {
    if (!dialog || destroyed) return;
    const s = getStatus() || {};
    const anyConnected = Boolean(s.ai || s.simulation || s.library);
    dialog.replaceChildren();
    const head = el('header', 'cg-hub-head');
    head.append(el('strong', '', '本机连接（SSH / AI / Git）'));
    const close = el('button', 'cg-hub-close', '关闭');
    close.type = 'button';
    close.onclick = () => { requiredFeature = ''; dialog.close(); };
    head.append(close);
    dialog.append(head);

    if (requiredFeature && !anyConnected && mode === 'demo') {
      const banner = el('p', 'cg-hub-feature-note', `继续「${requiredFeature}」需要连接本机环境（用于访问你的 SSH 配置、远端 EDA 服务器、Codex 或本地 Git）。`);
      dialog.append(banner);
    }

    dialog.append(el('p', 'cg-hub-desc',
      mode === 'live'
        ? '当前运行在本机工作台模式：远端仿真、Git 与原理图网关已同源连接。AI 可通过内置 Codex 桥接或外部 MCP 客户端接入。'
        : '所有界面交互均在此网页完成。连接一次本机连接器即可同时启用远端 SSH 仿真（SpiceOwl）、AI 助手（Codex）与本地电路库 Git 分支。'));

    const list = el('div', 'cg-hub-services');
    const rows = mode === 'live'
      ? [
          ['远端仿真与 PDK（SpiceOwl / SSH）', s.simulation !== false ? '已接入本机网关' : '未启用', s.simulation !== false ? 'ok' : 'muted'],
          ['AI Agent 调度（Codex / MCP）', s.ai ? '内置桥接已启用' : '使用外部 MCP 或配置 Codex 桥接', s.ai ? 'ok' : 'muted'],
          ['工程源码与 Git 版本', s.library !== false ? '本机工作区就绪' : '只读模式', s.library !== false ? 'ok' : 'muted'],
        ]
      : [
          ['远端仿真与 PDK（SSH / SpiceOwl）', s.simulation ? '已连接' : '需连接本机', s.simulation ? 'ok' : 'muted'],
          ['AI 助手（Codex）', s.ai ? '已连接' : '需连接本机', s.ai ? 'ok' : 'muted'],
          ['电路库与 Git / PR', s.library ? '已连接 · 可编辑提交' : '当前只读浏览', s.library ? 'ok' : 'muted'],
        ];
    for (const [name, stateLabel, kind] of rows) {
      const row = el('div', 'cg-hub-service');
      row.append(el('span', 'cg-hub-service-name', name), el('span', 'cg-hub-badge is-' + kind, stateLabel));
      list.append(row);
    }
    dialog.append(list);

    if (mode === 'demo' && !anyConnected) {
      if (connectorState === 'waking') {
        dialog.append(el('p', 'cg-hub-wake-status', '正在通过 circuitgit:// 唤起本机连接器… 若浏览器弹出确认框，请点击「允许」。'));
      } else if (connectorState === 'ready') {
        dialog.append(el('p', 'cg-hub-wake-status is-ready', '✓ 已检测到本机连接器正在运行，点击下方按钮立即完成授权。'));
      } else if (connectorState === 'missing') {
        const guide = el('div', 'cg-hub-install-guide');
        guide.append(
          el('strong', '', '尚未检测到本机连接器（仅需安装一次）'),
          el('p', '', `浏览器无法直接发起内网 SSH 或读取本机 Codex 登录态。下载项目后双击一次 ${launcherName} 即可自动注册网页一键唤醒，后续只需在网页点击连接，无需再手动启动本地程序。`),
        );
        const guideActions = el('div', 'cg-hub-install-actions');
        const dl = el('a', 'cg-hub-download', `${isWindows ? 'Windows' : 'macOS'} 下载 CircuitGit 连接器 ↗`);
        dl.href = RELEASES_URL;
        dl.target = '_blank';
        dl.rel = 'noopener noreferrer';
        const docLink = el('a', 'cg-hub-doc-link', '安装与后台自启说明 ↗');
        docLink.href = SETUP_DOC_URL;
        docLink.target = '_blank';
        docLink.rel = 'noopener noreferrer';
        guideActions.append(dl, docLink);
        guide.append(guideActions);
        dialog.append(guide);
      }
    }

    if (s.detail) dialog.append(el('p', 'cg-hub-meta', s.detail));

    const actions = el('div', 'cg-hub-actions');
    if (mode === 'demo') {
      if (!anyConnected && typeof onConnect === 'function') {
        if (connectorState === 'ready') {
          const primary = el('button', 'cg-hub-primary', s.connecting ? '正在授权…' : '立即授权并连接');
          primary.type = 'button';
          primary.disabled = Boolean(s.connecting);
          primary.onclick = () => {
            requiredFeature = '';
            dialog.close();
            void onConnect();
          };
          actions.append(primary);
        } else {
          const wakeBtn = el('button', 'cg-hub-primary',
            connectorState === 'waking' ? '正在唤起本机连接器…' : connectorState === 'missing' ? '我已启动，重新连接' : '一键唤起并连接本机');
          wakeBtn.type = 'button';
          wakeBtn.disabled = Boolean(s.connecting || connectorState === 'waking');
          wakeBtn.onclick = () => { void attemptWakeup(); };
          actions.append(wakeBtn);
        }
      }
      if (anyConnected && typeof onDisconnect === 'function') {
        const disc = el('button', 'cg-hub-danger', '断开连接');
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
      const sim = el('button', '', '打开仿真面板');
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

  function open({ feature = '' } = {}) {
    if (destroyed) return;
    requiredFeature = feature || '';
    if (!dialog) {
      dialog = el('dialog', 'cg-hub-dialog');
      dialog.setAttribute('aria-label', '本机连接');
      dialog.addEventListener('keydown', e => e.stopPropagation());
      doc.body.append(dialog);
    }
    renderDialog();
    if (!dialog.open) dialog.showModal();
    void refreshConnectorHealth();
  }

  function requireConnector(feature = '此功能') {
    const s = getStatus() || {};
    if (mode === 'live' || s.ai || s.simulation || s.library) return true;
    open({ feature });
    return false;
  }

  pill.onclick = () => open();
  const update = () => {
    renderPill();
    if (dialog?.open) renderDialog();
  };
  const off = subscribe(update);
  renderPill();

  return {
    update,
    open,
    requireConnector,
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
