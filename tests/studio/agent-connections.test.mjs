import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConfigs} from '../../apps/web/studio/agent-connections/config.js';
import {mount} from '../../apps/web/studio/agent-connections/index.js';
import {createDiscoveryController, discoveryLabel, metadataView} from '../../apps/web/studio/agent-connections/discovery.js';

const connection = (overrides = {}) => ({
  schema: 'ic.agent.connection.v1',
  chat: {transport: 'codex-app-server', tools: 'dynamic-tools', status: 'preview', inferenceVerified: false},
  mcp: {transport: 'stdio', status: 'prepared', verified: false,
    command: '/explicit/runtime/python', args: ['/explicit/server.py', '--config', '/explicit/client.json'], ...overrides},
  notes: []
});

test('explicit stdio argv is preserved in both client formats without credential fields', () => {
  const input = connection({env: {TOKEN: 'must-not-serialize'}, token: 'must-not-serialize', url: 'https://unused.invalid', connected: true});
  const output = buildConfigs(input);
  assert.equal(output.complete, true);
  assert.deepEqual(output.issues, []);
  assert.deepEqual(JSON.parse(output.json), {mcpServers: {'ic-workbench': {type: 'stdio', command: input.mcp.command, args: input.mcp.args}}});
  assert.equal(output.toml, '[mcp_servers."ic-workbench"]\ncommand = "/explicit/runtime/python"\nargs = ["/explicit/server.py", "--config", "/explicit/client.json"]\n');
  assert.doesNotMatch(output.json + output.toml, /must-not-serialize|unused|connected|approval/);
  assert.deepEqual(input.mcp.args, ['/explicit/server.py', '--config', '/explicit/client.json']);
});

test('spaces, quotes, slashes, Unicode and TOML control characters round trip', () => {
  const input = connection({command: 'C:\\Program Files\\运行时\\python.exe', args: ['C:\\目录\\a "quoted".py', 'line\n\t\r\b\f\u0001\u007f', '😀', '', '$(literal)', '`literal`']});
  const result = buildConfigs(input);
  assert.equal(result.complete, true);
  assert.deepEqual(JSON.parse(result.json).mcpServers['ic-workbench'].args, input.mcp.args);
  const [, command, args] = result.toml.trim().split('\n');
  assert.equal(JSON.parse(command.slice('command = '.length)), input.mcp.command);
  assert.deepEqual(JSON.parse(args.slice('args = '.length)), input.mcp.args);
  assert.doesNotMatch(result.toml, /\u007f/);
  assert.match(result.toml, /\\u007f/);
});

test('missing, placeholder and malformed inputs produce only unlaunchable templates', () => {
  const sparse = [];
  sparse.length = 1;
  for (const input of [undefined, null, false, [], {}, {...connection(), schema: 'unknown'},
    connection({status: 'unconfigured'}), connection({status: 'connected'}), connection({verified: true}),
    connection({transport: 'http'}), connection({command: 'python'}), connection({command: '/'}),
    connection({command: '/replace/<executable>'}), connection({command: '${RUNTIME}/python'}),
    connection({command: '/path/with\nnewline'}), connection({command: '/path/\ud800'}),
    connection({args: undefined}), connection({args: sparse}), connection({args: [42]}),
    connection({args: ['<config path>']}), connection({args: ['${env:CONFIG}']}),
    connection({args: ['\0']}), connection({args: ['\udfff']})]) {
    const output = buildConfigs(input);
    assert.equal(output.complete, false, JSON.stringify(input));
    assert.ok(output.issues.length);
    const server = JSON.parse(output.json).mcpServers.__MISSING_SERVER_NAME__;
    assert.equal(server.command, '__MISSING_ABSOLUTE_EXECUTABLE__');
    assert.deepEqual(server.args, ['__MISSING_ARGUMENTS__']);
    assert.match(output.toml, /^# 模板未完成/);
    assert.doesNotMatch(output.json + output.toml, /explicit\/runtime/);
  }
});

test('standalone executables and explicit UNC paths are accepted without inferred args', () => {
  assert.equal(buildConfigs(connection({args: []})).complete, true);
  assert.equal(buildConfigs(connection({command: '\\\\server\\share\\mcp.exe', args: []})).complete, true);
  assert.equal(buildConfigs(connection({command: 'C:relative.exe'})).complete, false);
});

test('mount is lazy and idempotent, exposes unverified configuration and unregisters exactly once', () => {
  let registrations = 0, removals = 0, command;
  const host = {registerCommand(spec) { registrations++; command = spec; return () => removals++; }};
  const controller = mount(host);
  assert.equal(command.menu, 'help');
  assert.equal(command.label, 'AI / MCP 连接');
  assert.equal(command.run, controller.show);
  assert.equal(mount(host), controller);
  assert.equal(registrations, 1);
  assert.equal(controller.getState().complete, false);
  controller.updateConnection(connection());
  assert.deepEqual(controller.getState(), {complete: true, issues: [], chatStatus: 'preview', mcpStatus: 'prepared', open: false, destroyed: false});
  controller.updateConnection(undefined);
  assert.equal(controller.getState().complete, false);
  controller.destroy();
  controller.destroy();
  controller.show();
  controller.updateConnection(connection());
  assert.equal(controller.getState().destroyed, true);
  assert.equal(controller.getState().complete, false);
  assert.equal(removals, 1);
  const remounted = mount(host, {connection: connection()});
  assert.notEqual(remounted, controller);
  remounted.destroy();
  assert.equal(removals, 2);
  assert.throws(() => mount({}), /registerCommand/);
});

test('chat integration state remains independent of supplied MCP configuration', () => {
  assert.equal(buildConfigs().chatStatus, 'unknown');
  assert.equal(buildConfigs().mcpStatus, 'unknown');
  for (const status of ['configured', 'preview', 'unavailable']) {
    const input = connection({status: 'unconfigured', command: null, args: []});
    input.chat.status = status;
    const output = buildConfigs(input);
    assert.equal(output.chatStatus, status);
    assert.equal(output.mcpStatus, 'unconfigured');
    assert.equal(output.complete, false);
  }
  const input = connection({args: ['--settings', '/explicit/settings.json']});
  input.chat.inferenceVerified = true;
  input.notes = ['<b>Supplied text</b>', null, {}];
  const output = buildConfigs(input);
  assert.equal(output.chatStatus, 'unknown');
  assert.equal(output.complete, true);
  assert.deepEqual(output.notes, ['<b>Supplied text</b>']);
  assert.deepEqual(JSON.parse(output.json).mcpServers['ic-workbench'].args, input.mcp.args);
});

const discoveryFixture = {schema: 'ic.ai.discovery.v1', codex: {executable_found: true, source: 'path', transport: 'app-server'},
  desktop: {installed: true, running: 'unknown'}, side_effects: {process_started: false, model_started: false, account_queried: false}};
const sessionFixture = {sessions: [{session_id: 'default', name: '默认会话', state: 'idle', pending_approval_count: 0, suspended_approval_count: 0}], max_sessions: 8};
const metadataFixture = {
  schema: 'ic.ai.connection.v1', session_id: 'default', status: 'connected',
  account: {status: 'known', account_type: 'chatgpt', login_status: 'signed_in', plan_type: 'pro'},
  usage: {status: 'available', buckets: [
    {limit_id: 'codex', primary: {used_percent: 25, window_duration_mins: 300, resets_at: 1794844800}, secondary: null},
    {limit_id: 'other', primary: null, secondary: {used_percent: 0, window_duration_mins: 10080, resets_at: null}}
  ]},
  catalog: {status: 'available', provider: 'openai', default_model: 'fixture-model', models: [], inference_verified: false},
  policy: {status: 'manual', approval_policy: 'on-request', approvals_reviewer: 'user'},
  chat: {status: 'unverified', manual_guard_required: true},
  inference: {checked: false, historical_completed_turns: 0}, automatic_retry: false
};
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
function fixtureRequest(calls, {discovery = discoveryFixture, sessions = sessionFixture, metadata = metadataFixture} = {}) {
  return async (path, options) => {
    calls.push({path, options});
    if (path === '/ai/discovery') return structuredClone(discovery);
    if (path === '/ai/sessions') return structuredClone(sessions);
    if (path === '/ai/connect') return structuredClone(metadata);
    assert.fail('Unexpected request: ' + path);
  };
}

test('discovery only reads fixed GET paths; connect requires an explicit separate action', async () => {
  const calls = [], controller = createDiscoveryController({request: fixtureRequest(calls)});
  assert.deepEqual(calls, []);
  await controller.connect();
  assert.deepEqual(calls, []);
  await controller.refresh();
  assert.deepEqual(calls, [{path: '/ai/discovery', options: undefined}, {path: '/ai/sessions', options: undefined}]);
  assert.equal(controller.getState().canConnect, true);
  assert.equal(controller.getState().metadata, null);
  await controller.connect();
  assert.deepEqual(calls[2], {path: '/ai/connect', options: {method: 'POST', body: {session_id: 'default'}, timeout: 120000}});
  assert.equal(controller.getState().metadata.chat, '真实聊天未验证');
  controller.destroy();
});

test('session selection uses returned IDs, never invents a default or changes sessions', async () => {
  const calls = [], sessions = {sessions: [{session_id: 'one', name: '一', state: 'idle'}, {session_id: 'two', name: '二', state: 'complete'}]};
  const controller = createDiscoveryController({request: fixtureRequest(calls, {sessions, metadata: {...metadataFixture, session_id: 'two'}})});
  await controller.refresh();
  assert.equal(controller.getState().selectedSessionId, '');
  assert.equal(controller.getState().canConnect, false);
  controller.selectSession('default');
  assert.equal(controller.getState().selectedSessionId, '');
  controller.selectSession('two');
  await controller.connect();
  assert.deepEqual(calls.at(-1).options.body, {session_id: 'two'});
  controller.selectSession('one');
  assert.equal(controller.getState().metadata, null);
  assert.deepEqual(sessions.sessions.map(s => s.state), ['idle', 'complete']);
  assert.equal(calls.filter(c => c.options?.method === 'POST').length, 1);
  controller.destroy();
});

test('running, starting, suspended, unknown and approval-bound sessions cannot check accounts', async () => {
  for (const patch of [{state: 'running'}, {state: 'starting'}, {state: 'suspended'}, {state: 'unknown'},
    {pending_approval_count: 1}, {suspended_approval_count: 1}]) {
    const calls = [], sessions = {sessions: [{...sessionFixture.sessions[0], ...patch}]};
    const controller = createDiscoveryController({request: fixtureRequest(calls, {sessions})});
    await controller.refresh();
    assert.equal(controller.getState().canConnect, false, JSON.stringify(patch));
    assert.ok(controller.getState().blockReason);
    await controller.connect();
    assert.equal(calls.length, 2);
    controller.destroy();
  }
});

test('unknown/failed discovery and malformed session lists do not enable a connection', async () => {
  for (const patch of [
    {discovery: {...discoveryFixture, codex: {...discoveryFixture.codex, executable_found: false}}},
    {discovery: {...discoveryFixture, schema: 'wrong'}},
    {sessions: {sessions: [{session_id: 'default', name: 'bad'}]}},
    {sessions: {sessions: [...sessionFixture.sessions, ...sessionFixture.sessions]}}
  ]) {
    const calls = [], controller = createDiscoveryController({request: fixtureRequest(calls, patch)});
    await controller.refresh(); await controller.connect();
    assert.equal(controller.getState().canConnect, false);
    assert.equal(calls.length, 2);
    controller.destroy();
  }
});

test('one pending metadata request blocks duplicate calls and session switching', async () => {
  const calls = [], pending = deferred(), read = fixtureRequest(calls);
  const controller = createDiscoveryController({request: (path, options) => {
    if (path === '/ai/connect') {calls.push({path, options}); return pending.promise;}
    return read(path, options);
  }});
  await controller.refresh();
  const first = controller.connect();
  await controller.connect(); await controller.refresh(); controller.selectSession('other');
  assert.equal(calls.length, 3);
  assert.equal(controller.getState().checkPhase, 'loading');
  pending.resolve(structuredClone(metadataFixture)); await first;
  assert.equal(controller.getState().checkPhase, 'ready');
  controller.destroy();
});

test('schema/session mismatch or transport error leaves unknown outcome without retry or raw diagnostics', async () => {
  for (const value of [{...metadataFixture, session_id: 'other'}, {...metadataFixture, schema: 'wrong'}, null]) {
    const calls = [], read = fixtureRequest(calls);
    const controller = createDiscoveryController({request: async (path, options) => {
      if (path === '/ai/connect') {calls.push({path, options}); if (!value) throw Error('SECRET_UPSTREAM_BODY'); return value;}
      return read(path, options);
    }});
    await controller.refresh(); await controller.connect();
    assert.equal(controller.getState().checkPhase, 'error');
    assert.equal(controller.getState().metadata, null);
    assert.doesNotMatch(JSON.stringify(controller.getState()), /SECRET_UPSTREAM_BODY/);
    assert.equal(calls.length, 3);
    controller.destroy();
  }
});

test('metadata status, manual policy and real inference remain separate; no private fields survive', () => {
  const view = metadataView({...metadataFixture, token: 'SECRET', email: 'SECRET', account_id: 'SECRET',
    account: {...metadataFixture.account, email: 'SECRET', token: 'SECRET'},
    policy: {status: 'blocked', reason: 'manual_approval_required'},
    chat: {status: 'blocked', reason: 'manual_approval_required'},
    inference: {checked: false, historical_completed_turns: 3}, errors: [{message: 'SECRET'}]});
  assert.equal(view.summary, '账号元数据已读取');
  assert.equal(view.login, '已登录');
  assert.equal(view.plan, 'pro');
  assert.equal(view.provider, 'openai');
  assert.equal(view.blocked, true);
  assert.match(view.blockMessage, /手动批准/);
  assert.match(view.inference, /历史完成回合/);
  assert.match(view.inference, /不代表本次连接已验证/);
  assert.doesNotMatch(JSON.stringify(view), /SECRET/);
});

test('signed-out and unsupported/unknown optional metadata stays explicit, never implies free plan or zero quota', () => {
  const view = metadataView({...metadataFixture, status: 'partial',
    account: {status: 'unknown', login_status: 'signed_out', plan_type: 'unknown'},
    usage: {status: 'unsupported'}, catalog: {status: 'unsupported'}, policy: {status: 'unknown'},
    chat: {status: 'blocked', reason: 'sign_in_required'}});
  assert.equal(view.summary, '账号元数据部分可用');
  assert.equal(view.login, '未登录');
  assert.equal(view.accountType, '未知');
  assert.equal(view.plan, '未知（官方未提供）');
  assert.deepEqual(view.usage, ['用量接口不支持']);
  assert.equal(view.signInRequired, true);
  assert.match(view.blockMessage, /官方 Codex 中完成登录/);
  const unknown = metadataView({...metadataFixture, account: {}, usage: {}, catalog: {}, chat: {status: 'unknown'}});
  assert.equal(unknown.login, '未知'); assert.equal(unknown.chat, '聊天状态未知');
  assert.deepEqual(unknown.usage, ['用量未知（未返回窗口数据）']);
});

test('quota windows preserve buckets, explicit zero, missing windows and reset units', () => {
  const view = metadataView(metadataFixture);
  assert.equal(view.usage.length, 2);
  assert.match(view.usage[0], /^codex · 主窗口：已用 25% \/ 300 分钟窗口/);
  assert.match(view.usage[0], /2026/);
  assert.match(view.usage[1], /^other · 次窗口：已用 0%/);
  assert.match(view.usage[1], /重置时间未知/);
  const empty = metadataView({...metadataFixture, usage: {status: 'available', buckets: [{limit_id: 'missing', primary: null, secondary: null}]}});
  assert.deepEqual(empty.usage, ['missing：窗口数据未知']);
});

test('refresh invalidates displayed metadata and destruction drops late network results', async () => {
  const calls = [], controller = createDiscoveryController({request: fixtureRequest(calls)});
  await controller.refresh(); await controller.connect();
  const refreshing = controller.refresh();
  assert.equal(controller.getState().metadata, null);
  await refreshing; controller.destroy();
  const pending = deferred(), published = [];
  const other = createDiscoveryController({request: () => pending.promise, onChange: state => published.push(state)});
  const loading = other.refresh(); other.destroy();
  const count = published.length;
  pending.resolve(discoveryFixture); await loading;
  assert.equal(published.length, count);
  assert.equal(other.getState().canConnect, false);
});

test('ordinary not-found is distinct from an invalid explicitly configured executable', () => {
  assert.equal(discoveryLabel({executable_found: false, source: 'none', reason: 'executable_not_found'}), '未发现可用的 Codex 可执行文件。');
  assert.match(discoveryLabel({executable_found: false, source: 'configured', reason: 'configured_executable_unavailable'}), /指定的 Codex 配置不可用/);
  assert.match(discoveryLabel({executable_found: false, source: 'configured', reason: 'invalid_executable_configuration'}), /未改选其他程序/);
  assert.doesNotMatch(discoveryLabel({executable_found: false, source: 'path', reason: 'executable_not_found'}), /指定/);
});

test('an unknown account/plan with no required OpenAI auth does not imply blocked chat', () => {
  for (const account of [null, {status: 'unknown', account_type: 'unknown', login_status: 'unknown', plan_type: 'unknown', requires_openai_auth: false}]) {
    const view = metadataView({...metadataFixture, account, catalog: {...metadataFixture.catalog, provider: 'fixture-provider'}, usage: {status: 'unknown'}});
    assert.equal(view.plan, '未知（官方未提供）');
    assert.equal(view.login, '未知');
    assert.equal(view.provider, 'fixture-provider');
    assert.equal(view.blocked, false);
    assert.equal(view.blockMessage, '');
    assert.equal(view.signInRequired, false);
    assert.equal(view.chat, '真实聊天未验证');
  }
});

// Minimal DOM fixture tests the actual mount/command wiring without launching a browser.
function documentFixture() {
  const windowListeners = new Map();
  const doc = {defaultView: {navigator: {clipboard: {writeText: async () => {}}},
    addEventListener(type, callback) {windowListeners.set(type, callback);},
    removeEventListener(type, callback) {if(windowListeners.get(type) === callback) windowListeners.delete(type);}}};
  doc.windowListeners = windowListeners;
  class Element {
    constructor(tag) {this.tagName = tag; this.ownerDocument = doc; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.open = false; this.hidden = false; this.disabled = false; this.value = ''; this._text = '';}
    set textContent(value) {this._text = String(value); this.replaceChildren();}
    get textContent() {return this._text + this.children.map(child => child.textContent).join('');}
    append(...nodes) {for (const node of nodes) {node.remove(); node.parentElement = this; this.children.push(node);}}
    replaceChildren(...nodes) {for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes);}
    remove() {if (this.parentElement) {this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null;}}
    setAttribute(key, value) {this.attributes[key] = value;}
    addEventListener(type, callback) {(this.listeners[type] ||= []).push(callback);}
    fire(type, event = {}) {if (type === 'click' && this.disabled) return; for (const callback of this.listeners[type] || []) callback(event);}
    showModal() {this.open = true;}
    close() {this.open = false; this.fire('close');}
    focus() {doc.activeElement = this;}
    select() {this.selectionStart = 0; this.selectionEnd = this.value.length;}
  }
  doc.createElement = tag => new Element(tag);
  doc.head = new Element('head'); doc.body = new Element('body');
  doc.all = node => [node, ...node.children.flatMap(child => doc.all(child))];
  return doc;
}

test('Help dialog opens with GET-only discovery, explicit metadata click and independently collapsed MCP', async () => {
  const previous = globalThis.document, document = documentFixture(), calls = [];
  globalThis.document = document;
  let command, unregister = 0, controller;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const byText = text => document.all(document.body).find(node => node.tagName === 'button' && node.textContent === text);
  try {
    controller = mount({registerCommand(spec) {command = spec; return () => unregister++;}, gateway: {request: fixtureRequest(calls, {metadata: {
      ...metadataFixture, policy: {status: 'blocked', reason: 'manual_approval_required'}, chat: {status: 'blocked', reason: 'manual_approval_required'}
    }})}});
    assert.equal(calls.length, 0);
    command.run(); await settle();
    assert.deepEqual(calls.map(call => call.path), ['/ai/discovery', '/ai/sessions']);
    const dialog = document.body.children[0];
    assert.equal(dialog.open, true);
    const mcp = document.all(dialog).find(node => node.className === 'ic-agent-connections-mcp');
    assert.equal(mcp.open, false);
    assert.match(dialog.textContent, /无需保持 Codex 桌面应用打开/);
    assert.match(dialog.textContent, /其他 agent：本版未接入/);
    byText('连接并读取账号').fire('click'); await settle();
    assert.deepEqual(calls.at(-1).options, {method: 'POST', body: {session_id: 'default'}, timeout: 120000});
    assert.match(dialog.textContent, /账号元数据已读取 · 聊天被阻断/);
    assert.match(dialog.textContent, /需要手动批准模式/);
    assert.match(dialog.textContent, /元数据读取成功不代表真实聊天已验证/);
    assert.match(dialog.textContent, /无需复制 MCP 配置/);
    let stopped = false, prevented = false;
    dialog.fire('keydown', {key: 'Escape', stopPropagation() {stopped = true;}, preventDefault() {prevented = true;}});
    assert.equal(dialog.open, false); assert.equal(stopped && prevented, true);
    assert.equal(document.windowListeners.size, 0);
    command.run(); await settle();
    assert.equal(document.windowListeners.size, 1);
    let cancelPrevented = false;
    dialog.fire('cancel', {preventDefault() {cancelPrevented = true;}, stopPropagation() {}});
    assert.equal(dialog.open, false);
    assert.equal(cancelPrevented, true);
    assert.equal(document.windowListeners.size, 0);
    assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
    command.run(); await settle();
    controller.destroy(); controller.destroy();
    assert.equal(document.body.children.length, 0); assert.equal(document.head.children.length, 0);
    assert.equal(document.windowListeners.size, 0);
    assert.equal(unregister, 1);
  } finally {controller?.destroy(); globalThis.document = previous;}
});
