import {agentReviewIdentity} from './agent-testbench.js';

export function appendAgentTestbench(parent,{controller,opened,onError=()=>{}}){
  const doc=parent.ownerDocument,state=controller.state,editor=controller.agentEditor,draft=state.session?.agent_tb;
  const el=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const note=(text,error=false)=>parent.append(el('p',text,error?'ic-sim-warning':'ic-sim-note'));
  const button=(label,action,disabled=false)=>{const node=el('button',label);node.type='button';node.disabled=disabled;node.addEventListener('click',event=>{try{const result=action(event);if(result?.catch)result.catch(onError);}catch(error){onError(error);}});return node;};
  parent.dataset.agentTestbench='';parent.append(el('h3','Agent 测试平台与人工审阅'));
  if(!draft){note('当前网表已作为独立电路导入。请让 Agent 编写完整 Spectre 测试平台与分析目标；草稿返回后可在这里审阅和微调。');note('尚未生成可运行计划。端口、激励与判据需来自当前电路和明确的测试目标。');return;}
  let review=null;try{review=agentReviewIdentity(state.session);}catch(error){note(error.message,true);}
  const status=editor.conflict?'后台草稿已更新，请核对':editor.dirty?'草稿已修改 · 尚未保存':review?.state==='pending'?'已冻结 · 等待人工审阅':review?.state==='approved'?'人工审阅已通过':draft.status==='prepared'?'已有准备计划':'待准备审阅';
  parent.append(el('p',status,'ic-env-review-state'));
  if(editor.conflict)note('你的本地修改仍保留。请先复制需要保留的内容，再读取后台新草稿；当前版本不能覆盖保存或运行。',true);
  if(editor.error)note(editor.error,true);if(state.agentSave.error)note(state.agentSave.error,true);if(state.preparation.error)note(state.preparation.error,true);
  if(state.session.prepared?.state==='blocked')for(const item of state.session.prepared.missing||[])note(item.message||item.field||item.code,true);
  const input=(label,key,value,rows)=>{const box=el('label',undefined,'ic-env-code-field');box.append(el('span',label));const area=el('textarea');area.value=value;area.rows=rows;area.spellcheck=false;area.dataset.environmentField='agent-'+key;area.dataset.agentField=key;area.setAttribute('aria-label',label);area.disabled=controller.locked;area.addEventListener('input',()=>{try{controller.editAgentTestbench(key,area.value);}catch(error){onError(error);}});box.append(area);return box;};
  parent.append(input('完整 Spectre 测试平台','code',editor.code,14));
  const section=(key,title)=>{const details=el('details',undefined,'ic-sim-detail');details.dataset.environmentDetail=key;details.open=opened.has(key);details.append(el('summary',title));details.addEventListener('toggle',()=>{if(details.isConnected)details.open?opened.add(key):opened.delete(key);});parent.append(details);return details;};
  section('agent-manifest','端口映射、激励、目标、判据与分析脚本').append(input('实验与分析说明 JSON','manifest',editor.manifest,16));
  section('agent-selection','PDK、Corner 与允许主机').append(input('PDK 与主机选择 JSON','selection',editor.selection,8));
  const summary=el('dl',undefined,'ic-env-observations'),description=draft.testbench;
  for(const [name,value]of [['子电路',description.interface.subckt],['实例',description.interface.instance],['端口映射',description.interface.port_bindings],['分析',description.analyses],['激励',description.stimuli],['目标',description.objectives],['判据',description.criteria],['PDK / 主机',draft.selection]])summary.append(el('dt',name),el('dd',typeof value==='string'?value:JSON.stringify(value)));
  section('agent-saved-summary','已保存内容摘要与版本').append(summary,el('p','源码 '+draft.source_sha256+'\n草稿 '+draft.draft_id+'\n测试平台 '+draft.testbench_sha256+'\n说明 '+draft.manifest_sha256,'ic-sim-code'));
  const actions=el('div',undefined,'ic-sim-toolbar'),locked=controller.locked;
  actions.append(button('保存草稿并撤销旧审阅',()=>controller.saveAgentTestbench(),locked||!editor.dirty||editor.conflict||!!editor.error||state.agentSave.status==='unknown'));
  actions.append(button(editor.conflict?'读取后台新草稿':'撤销本地修改',()=>controller.resetAgentTestbench(),locked||!editor.dirty&&!editor.conflict));
  actions.append(button(state.busy==='agent-prepare'?'准备中…':'生成审阅计划',()=>controller.prepareAgentTestbench(),locked||editor.dirty||editor.conflict||!!editor.error||review?.state==='pending'||state.agentSave.status==='unknown'));parent.append(actions);
  const reviewButton=button('审阅通过并运行仿真',event=>controller.openAgentTestbenchReview(event),locked||editor.dirty||editor.conflict||!!editor.error||!review||review.state!=='pending'||review.revision!==state.session.revision);reviewButton.classList.add('ic-env-primary');reviewButton.dataset.agentReview='';parent.append(reviewButton);
  note('按钮打开本机独立审阅页。只有在那里确认这份冻结内容后才提交任务；修改输入需重新保存和审阅。');
  if(review)note('审阅指纹：'+review.review_digest);if(state.agentReview.status==='opened')note('已打开本机审阅页。完成确认后，可返回此处刷新原实验；此面板不会再次提交运行。');
}
