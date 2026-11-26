import {probeLocalConnector,wakeLocalConnector} from '../remote/pair.js';

const REPO_URL = 'https://github.com/CircuitGit-dev/CircuitGit';
const RELEASES_URL = REPO_URL + '/archive/refs/heads/main.zip';
const SETUP_DOC_URL = REPO_URL + '/blob/main/docs/remote-node.md';
const PAGES_BASE = 'https://circuitgit-dev.github.io/CircuitGit';

const UNSAFE_PATH_CHARS = /[\r\n\0`$|;&<>'"]/;

export function sanitizeInstallDir(value, isWindows = false) {
  const fallback = isWindows ? '%USERPROFILE%\\CircuitGit' : '~/CircuitGit';
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 260 || UNSAFE_PATH_CHARS.test(trimmed)) return fallback;
  return trimmed;
}

export function buildInstallCommand({ isWindows = false, dir = '', autostart = true } = {}) {
  const cleanDir = sanitizeInstallDir(dir, isWindows);
  const defaultDir = isWindows ? '%USERPROFILE%\\CircuitGit' : '~/CircuitGit';
  const customDir = cleanDir !== defaultDir;
  if (isWindows) {
    const parts = [];
    if (customDir) parts.push(`$env:CIRCUITGIT_DIR='${cleanDir}'`);
    if (autostart) parts.push(`$env:CIRCUITGIT_AUTOSTART='1'`);
    parts.push(`irm ${PAGES_BASE}/install.ps1 | iex`);
    return parts.join('; ');
  }
  const envs = [];
  if (customDir) envs.push(`CIRCUITGIT_DIR="${cleanDir}"`);
  if (autostart) envs.push('CIRCUITGIT_AUTOSTART=1');
  const envPrefix = envs.length ? envs.join(' ') + ' ' : '';
  return `curl -fsSL ${PAGES_BASE}/install.sh | ${envPrefix}bash`;
}

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
  let installDir = isWindows ? '%USERPROFILE%\\CircuitGit' : '~/CircuitGit';
  let installAutostart = true;
  let copiedTimer = null;

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
          el('strong', '', '首次使用：一键安装本机连接器（仅需一次）'),
          el('p', '', '浏览器无法直接发起内网 SSH 或读取本机 Codex，两者共用同一个本机连接器。如果本机已运行连接器（例如 Codex 已可连接），直接点下方「立即授权并连接」即可；若这台电脑尚未安装，选择安装路径并复制命令到' + (isWindows ? ' PowerShell ' : ' 终端 ') + '运行一次即可自动装好并在后台启动。'),
        );
        const dirRow = el('label', 'cg-hub-install-field');
        dirRow.append(el('span', '', '安装路径'));
        const dirInput = el('input');
        dirInput.type = 'text';
        dirInput.value = installDir;
        dirInput.placeholder = isWindows ? '%USERPROFILE%\\CircuitGit' : '~/CircuitGit';
        dirInput.setAttribute('aria-label', '本机连接器安装路径');
        dirRow.append(dirInput);

        const autoRow = el('label', 'cg-hub-install-check');
        const autoCheck = el('input');
        autoCheck.type = 'checkbox';
        autoCheck.checked = installAutostart;
        autoRow.append(autoCheck, doc.createTextNode('开机自动在后台静默运行（之后打开网页直接秒连）'));

        const cmdBox = el('pre', 'cg-hub-install-cmd', buildInstallCommand({ isWindows, dir: installDir, autostart: installAutostart }));
        const syncCmd = () => {
          installDir = dirInput.value;
          installAutostart = autoCheck.checked;
          cmdBox.textContent = buildInstallCommand({ isWindows, dir: installDir, autostart: installAutostart });
        };
        dirInput.addEventListener('input', syncCmd);
        autoCheck.addEventListener('change', syncCmd);

        const guideActions = el('div', 'cg-hub-install-actions');
        const copyBtn = el('button', 'cg-hub-download', '一键复制安装命令');
        copyBtn.type = 'button';
        copyBtn.onclick = async () => {
          const text = buildInstallCommand({ isWindows, dir: installDir, autostart: installAutostart });
          let copied = false;
          try {
            if (win.navigator?.clipboard?.writeText) {
              await win.navigator.clipboard.writeText(text);
              copied = true;
            }
          } catch {}
          if (!copied) {
            try {
              const ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
              doc.body.append(ta); ta.select(); copied = doc.execCommand('copy'); ta.remove();
            } catch {}
          }
          copyBtn.textContent = copied
            ? ('✓ 已复制！请打开' + (isWindows ? ' PowerShell ' : ' 终端 ') + '粘贴回车')
            : '请手动选中上方命令复制';
          clearTimeout(copiedTimer);
          copiedTimer = setTimeout(() => { if (!destroyed) copyBtn.textContent = '一键复制安装命令'; }, 4000);
        };
        const docLink = el('a', 'cg-hub-doc-link', '查看安装说明 ↗');
        docLink.href = SETUP_DOC_URL;
        docLink.target = '_blank';
        docLink.rel = 'noopener noreferrer';
        guideActions.append(copyBtn, docLink);

        const fallback = el('details', 'cg-hub-install-fallback');
        const fbSummary = el('summary', '', '备用：手动下载源码包');
        const fbBody = el('p', '', `也可下载源码包并运行 ${launcherName}；` + (isWindows ? '若 Windows SmartScreen 提示请点「更多信息 → 仍要运行」。' : '若 macOS 提示“无法验证开发者”，请在「系统设置 → 隐私与安全性」点击「仍要打开」。'));
        const dl = el('a', 'cg-hub-doc-link', '下载源码 ZIP ↗');
        dl.href = RELEASES_URL;
        dl.target = '_blank';
        dl.rel = 'noopener noreferrer';
        fallback.append(fbSummary, fbBody, dl);

        guide.append(dirRow, autoRow, cmdBox, guideActions, fallback);
        dialog.append(guide);
      }
    }

    if (s.detail) dialog.append(el('p', 'cg-hub-meta', s.detail));

    const actions = el('div', 'cg-hub-actions');
    if (mode === 'demo') {
      if (!anyConnected && typeof onConnect === 'function') {
        const directAuth = el('button', connectorState === 'missing' ? '' : 'cg-hub-primary', s.connecting ? '正在授权…' : '立即授权并连接');
        directAuth.type = 'button';
        directAuth.disabled = Boolean(s.connecting);
        directAuth.onclick = () => {
          requiredFeature = '';
          dialog.close();
          void onConnect();
        };
        if (connectorState === 'ready') {
          actions.append(directAuth);
        } else {
          const wakeBtn = el('button', connectorState === 'missing' ? 'cg-hub-primary' : '',
            connectorState === 'waking' ? '正在唤起本机连接器…' : connectorState === 'missing' ? '我已启动，重新检测' : '通过 circuitgit:// 唤起');
          wakeBtn.type = 'button';
          wakeBtn.disabled = Boolean(s.connecting || connectorState === 'waking');
          wakeBtn.onclick = () => { void attemptWakeup(); };
          actions.append(directAuth, wakeBtn);
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
      clearTimeout(copiedTimer);
      off?.();
      dialog?.close();
      dialog?.remove();
      pill.remove();
    },
  };
}
