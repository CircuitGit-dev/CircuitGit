import {buildConfigs} from './config.js';
import {mountLocalCodex} from './local-codex.js';

const mounted = new WeakMap();
const styles = new WeakMap();
let nextId = 0;

const formats = {
  json: {
    label: '通用 MCP JSON · Claude Code / Cursor',
    hint: 'Claude Code：项目根目录 .mcp.json；Cursor：项目内 .cursor/mcp.json。将服务器条目合并到已有的 mcpServers。'
  },
  toml: {
    label: 'Codex TOML',
    hint: 'Codex：将此服务器条目合并到 config.toml 的 mcp_servers 配置；同名条目只保留一份。'
  }
};

function useStyle(document) {
  let record = styles.get(document);
  if (!record) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./style.css', import.meta.url).href;
    document.head.append(link);
    record = {link, count: 0};
    styles.set(document, record);
  }
  record.count++;
  return () => {
    if (--record.count === 0) {
      record.link.remove();
      styles.delete(document);
    }
  };
}

/**
 * Browser connection UI. Uses only the injected gateway; never runs a model test.
 * @param {{registerCommand: Function}} host
 * @param {{connection?: import('./config.js').Connection}} options
 * @returns {{show: Function, hide: Function, updateConnection: Function, getState: Function, destroy: Function}}
 */
export function mount(host, {connection} = {}) {
  if (!host || typeof host.registerCommand !== 'function') {
    throw new TypeError('AI / MCP connections requires host.registerCommand');
  }
  if (mounted.has(host)) return mounted.get(host);

  let config = buildConfigs(connection);
  let dialog, localCodex, status, issues, format, code, hint, copy, feedback, notes, releaseStyle;
  let escapeWindow = null;
  let destroyed = false;
  let revision = 0;

  function releaseEscape() {
    escapeWindow?.removeEventListener('keydown', captureEscape, true);
    escapeWindow = null;
  }

  function captureEscape(event) {
    if (!dialog?.open || event.key !== 'Escape') return;
    const document = dialog.ownerDocument;
    const focusedDialog = document.activeElement?.closest('dialog[open]');
    if (focusedDialog && focusedDialog !== dialog) return;
    // With focus on BODY, only claim Escape when this is the sole native modal.
    if (!focusedDialog && [...document.querySelectorAll('dialog:modal')].some(node => node !== dialog)) return;
    // Disabling the metadata button can move focus to BODY. Intercept before RNL's
    // document capture/bubble shortcuts prevent the browser's native cancellation.
    event.preventDefault();
    event.stopImmediatePropagation();
    hide();
  }

  function render() {
    revision++;
    status.textContent = config.complete ? '配置已提供 · 连接未验证' : '模板未完成 · 不能用于连接';
    status.dataset.complete = String(config.complete);
    issues.textContent = config.mcpStatus === 'prepared' ? config.issues.join(' ') : '尚未提供完整启动路径和参数，以下仅为不可用模板。';
    issues.hidden = config.complete;
    code.value = config[format.value];
    hint.textContent = formats[format.value].hint;
    copy.disabled = !config.complete;
    copy.textContent = config.complete ? '复制配置' : '待补全配置';
    feedback.textContent = '';
    notes.textContent = config.notes.join(' ');
    notes.hidden = config.notes.length === 0;
  }

  async function copyConfig() {
    if (destroyed || !config.complete || copy.disabled) return;
    const attempt = revision;
    const text = code.value;
    copy.disabled = true;
    feedback.textContent = '正在复制…';
    try {
      const clipboard = dialog.ownerDocument.defaultView?.navigator?.clipboard;
      if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
      await clipboard.writeText(text);
      if (!destroyed && revision === attempt) feedback.textContent = '已复制；请在对应客户端中配置并验证连接。';
    } catch {
      if (!destroyed && revision === attempt && dialog.open) {
        code.focus();
        code.select();
        feedback.textContent = '浏览器未允许复制，已选中文本，请手动复制。';
      }
    } finally {
      if (!destroyed && revision === attempt) copy.disabled = !config.complete;
    }
  }

  function createDialog() {
    const document = globalThis.document;
    const id = `ic-agent-connections-${++nextId}`;
    const make = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    dialog = make('dialog', '', 'ic-agent-connections');
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    const header = make('header');
    const title = make('h2', 'AI / MCP 连接');
    title.id = `${id}-title`;
    const close = make('button', '关闭');
    close.type = 'button';
    close.autofocus = true;
    close.addEventListener('click', hide);
    header.append(title, close);

    const local = make('section');
    localCodex = mountLocalCodex(local, {request: typeof host.gateway?.request === 'function' ? (...args) => host.gateway.request(...args) : undefined});
    const mcp = make('details', '', 'ic-agent-connections-mcp');
    mcp.append(make('summary', 'IC工具（外部 agent MCP 配置）'),
      make('p', 'MCP 供外部 agent 调用电路工具；本页聊天使用 Codex app-server，无需复制这里的配置。', 'ic-agent-connections-hint'));

    status = make('p', '', 'ic-agent-connections-status');
    status.setAttribute('role', 'status');
    issues = make('p', '', 'ic-agent-connections-issues');
    const toolbar = make('div', '', 'ic-agent-connections-toolbar');
    const formatLabel = make('label', '配置格式');
    formatLabel.htmlFor = `${id}-format`;
    format = make('select');
    format.id = `${id}-format`;
    for (const [value, item] of Object.entries(formats)) {
      const option = make('option', item.label);
      option.value = value;
      format.append(option);
    }
    format.value = 'json';
    format.addEventListener('change', render);
    copy = make('button');
    copy.type = 'button';
    copy.addEventListener('click', copyConfig);
    toolbar.append(formatLabel, format, copy);

    code = make('textarea');
    code.readOnly = true;
    code.spellcheck = false;
    code.wrap = 'off';
    code.rows = 9;
    code.setAttribute('aria-label', 'MCP 连接配置文本');
    code.setAttribute('aria-describedby', `${id}-hint`);
    hint = make('p', '', 'ic-agent-connections-hint');
    hint.id = `${id}-hint`;
    feedback = make('p', '', 'ic-agent-connections-feedback');
    feedback.setAttribute('role', 'status');
    const note = make('p', '这里只生成配置文本；连接状态请在外部 agent 中验证。', 'ic-agent-connections-hint');
    notes = make('p', '', 'ic-agent-connections-hint');
    const docs = make('details', '', 'ic-agent-connections-docs');
    docs.append(make('summary', '官方配置文档'));
    for (const [name, url] of [
      ['Codex', 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli'],
      ['Claude Code', 'https://code.claude.com/docs/en/mcp'],
      ['Cursor', 'https://cursor.com/docs/mcp']
    ]) {
      const link = make('a', name);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      docs.append(link);
    }
    mcp.append(status, issues, toolbar, code, hint, feedback, note, notes, docs);
    dialog.append(header, local, mcp);
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); hide(); }
    });
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      event.stopPropagation();
      hide();
    });
    dialog.addEventListener('close', () => {
      // A queued close event must not remove the guard from a just-reopened dialog.
      if (dialog.open) return;
      releaseEscape(); revision++; copy.disabled = !config.complete;
    });
    releaseStyle = useStyle(document);
    document.body.append(dialog);
    render();
  }

  function show() {
    if (destroyed) return;
    if (!dialog) createDialog();
    if (!dialog.open) {
      render();
      dialog.showModal();
      escapeWindow = dialog.ownerDocument.defaultView;
      escapeWindow?.addEventListener('keydown', captureEscape, true);
      void localCodex.refresh();
    }
  }

  function hide() {
    releaseEscape();
    if (dialog?.open) {
      revision++;
      dialog.close();
    }
  }

  const unregister = host.registerCommand({id: 'help.agent-connections', menu: 'help', label: 'AI / MCP 连接', run: show});
  const controller = Object.freeze({
    show, hide,
    updateConnection(next) {
      if (destroyed) return;
      config = buildConfigs(next);
      if (dialog) render();
    },
    getState: () => ({complete: config.complete, issues: [...config.issues], chatStatus: config.chatStatus, mcpStatus: config.mcpStatus, open: Boolean(dialog?.open), destroyed}),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      hide();
      localCodex?.destroy();
      dialog?.remove();
      releaseStyle?.();
      unregister();
      mounted.delete(host);
    }
  });
  mounted.set(host, controller);
  return controller;
}
