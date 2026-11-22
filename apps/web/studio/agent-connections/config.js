/**
 * Explicit, non-secret launch data supplied by the integration owner.
 * @typedef {Object} Connection
 * @property {'ic.agent.connection.v1'} schema
 * @property {{transport:'codex-app-server', tools:'dynamic-tools', status:'configured'|'preview'|'unavailable', inferenceVerified:false}} chat
 * @property {{transport:'stdio', status:'unconfigured'|'prepared', command:string|null, args:string[], verified:false}} mcp
 * @property {string[]} notes Non-secret explanatory text supplied by the host.
 *
 * No environment/credential or approval settings are accepted or discovered.
 */

const placeholder = /<[^<>]*>|\$\{|__MISSING_/;
const control = /[\u0000-\u001f\u007f]/;

function scalarString(value) {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  // TOML requires Unicode scalar values; JSON alone also permits lone surrogates.
  return Array.from(value).every(char => {
    const point = char.codePointAt(0);
    return point < 0xd800 || point > 0xdfff;
  });
}

function absoluteExecutable(value) {
  return scalarString(value) && !control.test(value) && !placeholder.test(value) &&
    (/^\/(?!\/).+/.test(value) || /^[A-Za-z]:[\\/].+/.test(value) ||
      /^\\\\[^\\]+\\[^\\]+\\.+/.test(value));
}

function tomlString(value) {
  // JSON's escapes are valid TOML basic-string escapes, with DEL additionally escaped.
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}

/**
 * Generate config text without probing the host or declaring connection success.
 * Complete means structurally supplied, not installed, reachable or verified.
 * @param {Connection | undefined} connection
 */
export function buildConfigs(connection) {
  const issues = [];
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    issues.push('尚未提供连接数据。');
  }
  const data = connection && typeof connection === 'object' && !Array.isArray(connection) ? connection : {};
  if (data.schema !== 'ic.agent.connection.v1') issues.push('连接数据版本未知。');
  const value = data.mcp && typeof data.mcp === 'object' && !Array.isArray(data.mcp) ? data.mcp : {};
  if (value.status !== 'prepared') issues.push('尚未提供完整的 MCP 启动配置。');
  if (value.transport !== 'stdio') issues.push('需要显式设置 transport 为 stdio。');
  if (value.verified !== false) issues.push('MCP 连接验证状态未知。');
  if (!absoluteExecutable(value.command)) issues.push('需要明确的可执行文件绝对路径 command。');
  if (!Array.isArray(value.args) || !Array.from(value.args).every(arg => scalarString(arg) && !placeholder.test(arg))) {
    issues.push('需要完整的字符串参数数组 args，可为空；不能包含占位符或环境变量表达式。');
  }
  const complete = issues.length === 0;
  // An invalid input never yields a partially executable copy of the supplied data.
  const serverName = complete ? 'ic-workbench' : '__MISSING_SERVER_NAME__';
  const command = complete ? value.command : '__MISSING_ABSOLUTE_EXECUTABLE__';
  const args = complete ? [...value.args] : ['__MISSING_ARGUMENTS__'];
  const json = JSON.stringify({mcpServers: {[serverName]: {type: 'stdio', command, args}}}, null, 2);
  const toml = `${complete ? '' : '# 模板未完成，不能用于连接。\n'}[mcp_servers.${tomlString(serverName)}]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(', ')}]\n`;
  const chatStatus = data.schema === 'ic.agent.connection.v1' && data.chat?.transport === 'codex-app-server' &&
    data.chat?.tools === 'dynamic-tools' && data.chat?.inferenceVerified === false &&
    ['configured', 'preview', 'unavailable'].includes(data.chat?.status) ? data.chat.status : 'unknown';
  const mcpStatus = data.schema === 'ic.agent.connection.v1' && ['unconfigured', 'prepared'].includes(value.status) ? value.status : 'unknown';
  const notes = data.schema === 'ic.agent.connection.v1' && Array.isArray(data.notes) ? data.notes.filter(note => typeof note === 'string') : [];
  return Object.freeze({complete, issues: Object.freeze(issues), chatStatus, mcpStatus, notes: Object.freeze(notes), json, toml});
}
