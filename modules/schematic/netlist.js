// Small, deliberately bounded Spectre index. This does not netlist OA or generate simulation input.
export function indexSpectre(text) {
  const lines = text.split('\n');
  const scopes = [{name:'(top)', start:1, end:lines.length, instances:[], ports:[]}];
  let scope=scopes[0];
  for(let i=0;i<lines.length;i++){
    const start=i+1; let statement=lines[i];
    if (/^\s*(\/\/|\*|$)/.test(statement)) continue;
    while(/\\\s*$/.test(statement) && i+1<lines.length) statement=statement.replace(/\\\s*$/,' ') + lines[++i].trim();
    const end=i+1;
    const definition=statement.match(/^\s*subckt\s+(\S+)\s*(.*)$/i);
    if(definition){scope={name:definition[1],start,end:lines.length,ports:definition[2].trim().split(/\s+/).filter(Boolean),instances:[]}; scopes.push(scope);continue;}
    if(/^\s*ends\b/i.test(statement)){scope.end=end;scope=scopes[0];continue;}
    const instance=statement.match(/^\s*([^\s()]+)\s*\(([^)]*)\)\s+(\S+)\s*(.*)$/);
    if(instance)scope.instances.push({name:instance[1],nodes:instance[2].trim().split(/\s+/).filter(Boolean),model:instance[3],parameters:instance[4],start,end,scope:scope.name});
  }
  return scopes.filter(scope=>scope.instances.length);
}
export function lineRange(text,start,end=start){
  const lines=text.split('\n'); const a=Math.max(1,Math.min(lines.length,start)); const b=Math.max(a,Math.min(lines.length,end));
  const offset=lines.slice(0,a-1).reduce((n,line)=>n+line.length+1,0);
  return [offset,offset+lines.slice(a-1,b).join('\n').length];
}
export function references(scope,net){return scope.instances.filter(instance=>instance.nodes.includes(net));}
export function validateConfiguration(raw){
  let value;try{value=JSON.parse(raw);}catch{return {errors:['配置必须为有效的 JSON。']};}
  if(!value||typeof value!=='object'||Array.isArray(value))return {errors:['配置必须为 JSON 对象。']};
  const errors=[];
  if(value.parameters!==undefined&&(!value.parameters||typeof value.parameters!=='object'||Array.isArray(value.parameters))) errors.push('parameters 必须为对象。');
  if(value.parameters)for(const [name,v] of Object.entries(value.parameters)){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) errors.push(`参数名无效：${name}`);if(!['string','number'].includes(typeof v)||String(v).length===0)errors.push(`参数 ${name} 必须为数值或表达式字符串。`);}
  // Scientific expression evaluation belongs to Spectre and the gateway's supported parameter editor.
  return {value,errors};
}
export function safeLocalURL(value,base=location.href){
  if(typeof value!=='string')return null;
  try{const url=new URL(value,base);return url.origin===new URL(base).origin&&['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}
}
export function safeGithubURL(value){
  try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='github.com'?u.href:null;}catch{return null;}
}
export const stateLabels={running_observed:'运行中 · 已观测进程',preflight:'环境检查中',preflight_failed:'环境检查失败',input_hash_failure:'输入 hash 不匹配',reconcile_required:'状态待核对',staging_outcome_unknown:'上传状态待核对',launch_outcome_unknown:'启动回执待核对',simulator_failed:'求解失败',job_setup_failed:'作业初始化失败',queued:'排队',submitted:'已提交',running:'运行中',reconcile:'状态待核对',failed:'失败',error:'错误',cancelled:'已取消',collecting:'收集中',collected:'已收集',archiving:'归档中',archived:'已归档',simulator_complete_pending_measurements:'求解器完成 · 测量未验收',completed:'完成（以网关证据为准）'};
export function isTerminal(state){return ['input_hash_failure','preflight_failed','simulator_failed','job_setup_failed','failed','error','cancelled','collected','archived','completed','simulator_complete_pending_measurements'].includes(state);}
export function phaseOf(state){if(state==='archived')return 4;if(['collected','completed','simulator_complete_pending_measurements','collecting','archiving'].includes(state))return 3;if(['running','running_observed'].includes(state))return 2;if(['queued','submitted','preflight','reconcile','reconcile_required','staging_outcome_unknown','launch_outcome_unknown'].includes(state))return 1;return -1;}
export async function sha256(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
