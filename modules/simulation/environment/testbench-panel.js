import {agentReviewIdentity,checkTestbenchHelpers,decodeTestbenchHelper,editTestbenchHelper,preserveHelperLineEndings,checkTestbenchHeaderSelection,testbenchSelectionProbe} from './agent-testbench.js';
import {parseEnvironmentJson} from './json.js';

const localForms=new WeakMap();
function formFor(controller){
  const session=controller.state.session,binding=JSON.stringify([session?.connection_id,session?.intake_id,session?.source_sha256]);
  let value=localForms.get(controller);if(!value||value.binding!==binding){value={binding,helperPath:'',probeId:'',roots:''};localForms.set(controller,value);}return value;
}
const helperSupportNames=controller=>Object.keys(controller.state.session?.agent_tb?.support_sha256||controller.state.session?.support_files||{});

function appendHelpers(parent,{controller,opened,onError,section,el,button}){
  const editor=controller.agentEditor,draft=controller.state.session.agent_tb,form=formFor(controller),doc=parent.ownerDocument;
  const box=section('agent-helpers','测试平台辅助文件 · Verilog-A / include');box.dataset.agentHelpers='';
  box.append(el('p','以相对路径保存完整 UTF-8 原文。导入保留原始换行；未改动的文本不会重写。','ic-sim-note'));
  let helpers;try{const metadata=parseEnvironmentJson(editor.manifest);helpers=checkTestbenchHelpers(Object.hasOwn(metadata,'helper_files')?metadata.helper_files:{},helperSupportNames(controller));}
  catch(error){box.append(el('p',error.message,'ic-sim-warning'));return;}
  const pathLabel=el('label',undefined,'ic-env-code-field'),path=el('input');path.type='text';path.value=form.helperPath;path.placeholder='留空使用文件名；可填 behavior/source.va';path.dataset.environmentField='agent-helper-path';path.setAttribute('aria-label','辅助文件相对路径');path.disabled=controller.locked||editor.conflict;path.addEventListener('input',()=>{form.helperPath=path.value;});pathLabel.append(el('span','导入路径'),path);box.append(pathLabel);
  const picker=el('input');picker.type='file';picker.accept='.va,.vams,.scs,.sp,.spice,.cir,.txt';picker.disabled=controller.locked||editor.conflict;picker.setAttribute('aria-label','导入测试平台辅助文件');picker.dataset.agentHelperImport='';
  picker.addEventListener('change',async()=>{try{
    const file=picker.files?.[0];if(!file)return;if(file.size>512*1024)throw Error('辅助文件超过 512 KiB 导入上限。');
    const snapshot=JSON.stringify(controller.agentEditor),session=controller.state.session,binding=JSON.stringify([session.connection_id,session.intake_id,session.revision,session.source_sha256]),name=form.helperPath||file.name;
    const body=decodeTestbenchHelper(await file.arrayBuffer()),current=controller.state.session;
    if(controller.locked||snapshot!==JSON.stringify(controller.agentEditor)||binding!==JSON.stringify([current?.connection_id,current?.intake_id,current?.revision,current?.source_sha256]))throw Error('读取文件时草稿或连接已变化；未覆盖当前修改，请重新导入。');
    const metadata=parseEnvironmentJson(controller.agentEditor.manifest);
    if(Object.keys(metadata.helper_files||{}).some(existing=>existing.toLowerCase()===name.toLowerCase()))throw Error('该辅助文件已存在；请在下方编辑，或使用不同相对路径。');
    const updated=editTestbenchHelper(controller.agentEditor.manifest,name,body,{supportNames:helperSupportNames(controller)});form.helperPath='';opened.add('agent-helper:'+name);controller.editAgentTestbench('manifest',updated);
  }catch(error){onError(error);}});box.append(picker);
  for(const [name,body]of Object.entries(helpers)){
    const details=el('details',undefined,'ic-sim-detail'),key='agent-helper:'+name;details.dataset.environmentDetail=key;details.dataset.agentHelper=name;details.open=opened.has(key);details.append(el('summary',name));details.addEventListener('toggle',()=>{if(details.isConnected)details.open?opened.add(key):opened.delete(key);});
    const bytes=new TextEncoder().encode(body),hash=el('p',bytes.length+' bytes · 当前 SHA-256 计算中…','ic-sim-code');hash.dataset.helperHash=name;details.append(hash);
    doc.defaultView.crypto.subtle.digest('SHA-256',bytes).then(result=>{const value=Array.from(new Uint8Array(result),byte=>byte.toString(16).padStart(2,'0')).join('');hash.textContent=bytes.length+' bytes\n当前 SHA-256 '+value+'\n已保存 SHA-256 '+(draft.helper_sha256?.[name]||'尚无保存回执');hash.dataset.sha256=value;}).catch(()=>{hash.textContent=bytes.length+' bytes · 当前 SHA-256 暂不可读取';});
    const label=el('label',undefined,'ic-env-code-field'),area=el('textarea');area.value=body;area.rows=10;area.spellcheck=false;area.disabled=controller.locked||editor.conflict;area.dataset.environmentField='agent-helper:'+name;area.setAttribute('aria-label','辅助文件 '+name);label.append(el('span','完整源文本'),area);
    area.addEventListener('input',()=>{try{controller.editAgentTestbench('manifest',editTestbenchHelper(controller.agentEditor.manifest,name,preserveHelperLineEndings(body,area.value),{supportNames:helperSupportNames(controller)}));}catch(error){onError(error);}});
    details.append(label,button('移除 '+name,()=>controller.editAgentTestbench('manifest',editTestbenchHelper(controller.agentEditor.manifest,name,null,{remove:true,supportNames:helperSupportNames(controller)})),controller.locked||editor.conflict));box.append(details);
  }
  if(!Object.keys(helpers).length)box.append(el('p','尚无测试平台辅助文件。DUT 原有支持文件由后台保留并合并。','ic-sim-note'));
}

export function appendVerilogaHeaders(parent,{controller,opened,onError=()=>{},onChange=()=>{}}){
  const doc=parent.ownerDocument,state=controller.state,session=state.session,editor=controller.agentEditor,form=formFor(controller);
  const el=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const box=el('details',undefined,'ic-sim-detail'),key='veriloga-headers';box.dataset.environmentDetail=key;box.dataset.verilogaHeaders='';box.open=opened.has(key);box.append(el('summary','Verilog-A 标准头文件'));box.addEventListener('toggle',()=>{if(box.isConnected)box.open?opened.add(key):opened.delete(key);});parent.append(box);
  box.append(el('p','选择已探测的主机，并填写明确的安装头文件目录。只记录名称与哈希，运行前重新核对依赖。','ic-sim-note'));
  const probes=session?.probes||[],locked=controller.locked||editor.dirty||editor.conflict||state.headerScan?.status==='unknown';
  const probe=el('select');probe.dataset.environmentField='veriloga-probe';probe.setAttribute('aria-label','标准头文件主机观察');probe.disabled=locked;const blank=el('option','选择本次观察的主机');blank.value='';probe.append(blank);
  for(const row of probes){const option=el('option',row.ssh_target+' · '+row.probe_id);option.value=row.probe_id;probe.append(option);}probe.value=form.probeId;probe.addEventListener('change',()=>{form.probeId=probe.value;onChange();});
  const roots=el('textarea');roots.rows=3;roots.value=form.roots;roots.placeholder='每行一个明确的绝对目录';roots.dataset.environmentField='veriloga-roots';roots.setAttribute('aria-label','标准头文件绝对目录');roots.disabled=locked;roots.addEventListener('change',()=>{form.roots=roots.value;onChange();});
  const rootLabel=el('label',undefined,'ic-env-code-field');rootLabel.append(el('span','明确的头文件目录'),roots);box.append(probe,rootLabel);
  const action=el('button',state.busy==='veriloga-headers'?'探测中…':'探测所选标准头文件');action.type='button';action.disabled=locked||!controller.connected||!controller.has('probeVerilogaHeaders')||!probes.some(row=>row.probe_id===form.probeId)||!form.roots.trim();
  action.addEventListener('click',async()=>{try{const selected=form.roots.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);if(!selected.length||selected.length>8||new Set(selected).size!==selected.length||selected.some(value=>!value.startsWith('/')||value==='/'||value.length>4096||/[\u0000-\u001f\u007f]/.test(value)||value.split('/').some(part=>part==='.'||part==='..')))throw Error('请填写 1–8 个不同的明确绝对目录，不可使用文件系统根目录或父级跳转。');const current=controller.state.session;await controller.probeVerilogaHeaders({intake_id:current.intake_id,revision:current.revision,probe_id:form.probeId,roots:selected});}catch(error){onError(error);}});box.append(action);
  if(editor.dirty||editor.conflict)box.append(el('p','请先保存或核对测试平台草稿，再更新标准头文件依赖。','ic-sim-note'));
  if(state.headerScan?.error)box.append(el('p',state.headerScan.error,'ic-sim-warning'));
  if(state.headerScan?.status==='unknown')box.append(el('p','探测结果尚未核对；请刷新原实验，勿重复请求。','ic-sim-warning'));
  for(const row of session?.veriloga_headers||[]){const report=el('div');report.dataset.verilogaObservation=row.id;report.append(el('p',row.probe_id+' · '+row.status,'ic-sim-note'));const list=el('dl',undefined,'ic-env-observations');for(const header of row.headers||[])list.append(el('dt',header.name),el('dd',header.alias+' · SHA-256 '+header.sha256));report.append(list,el('p','覆盖：'+JSON.stringify(row.coverage)+'\n缺失：'+JSON.stringify(row.missing)+'\n观察：'+row.id,'ic-sim-code'));box.append(report);}
  if(!session?.agent_tb)return;
  let selection,probeId;try{selection=parseEnvironmentJson(editor.selection);probeId=testbenchSelectionProbe(selection,session);}catch{box.append(el('p','先修复 PDK 与主机选择 JSON，才能选择标准头绑定。','ic-sim-warning'));return;}
  const select=el('select');select.dataset.environmentField='agent-veriloga-header';select.setAttribute('aria-label','测试平台标准头文件绑定');select.disabled=controller.locked||editor.conflict||!probeId;
  const none=el('option','不选择额外标准头绑定');none.value='';select.append(none);
  for(const header of session.veriloga_headers||[]){if(header.probe_id!==probeId)continue;const option=el('option',header.id+' · '+header.status);option.value=header.id;option.disabled=header.status!=='observed'||header.coverage?.complete!==true||!Array.isArray(header.missing)||header.missing.length>0;select.append(option);}
  if(selection.veriloga_header_id&&![...select.options].some(option=>option.value===selection.veriloga_header_id)){const stale=el('option','已失效或与 PDK 主机不一致：'+selection.veriloga_header_id);stale.value=selection.veriloga_header_id;stale.disabled=true;select.append(stale);}select.value=selection.veriloga_header_id||'';
  select.addEventListener('change',()=>{try{const next=parseEnvironmentJson(controller.agentEditor.selection);if(select.value)next.veriloga_header_id=select.value;else delete next.veriloga_header_id;checkTestbenchHeaderSelection(next,controller.state.session);controller.editAgentTestbench('selection',JSON.stringify(next,null,2)+'\n');}catch(error){onError(error);}});box.append(select);
  if(!probeId)box.append(el('p','先在测试平台中选择本次已观察的 PDK 候选或已保存作用域；标准头绑定必须使用同一主机观察。','ic-sim-note'));
}

export function appendAgentTestbench(parent,{controller,opened,onError=()=>{}}){
  const doc=parent.ownerDocument,state=controller.state,editor=controller.agentEditor,draft=state.session?.agent_tb;
  const el=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const note=(text,error=false)=>parent.append(el('p',text,error?'ic-sim-warning':'ic-sim-note'));
  const button=(label,action,disabled=false)=>{const node=el('button',label);node.type='button';node.disabled=disabled;node.addEventListener('click',event=>{try{const result=action(event);if(result?.catch)result.catch(onError);}catch(error){onError(error);}});return node;};
  parent.dataset.agentTestbench='';parent.append(el('h3','Agent 测试平台与人工审阅'));
  if(!draft){note('当前网表已作为独立电路导入。请让 Agent 编写完整 Spectre 测试平台与分析目标；草稿返回后可在这里审阅和微调。');note('尚未生成可运行计划。端口、激励与判据需来自当前电路和明确的测试目标。');return;}
  let review=null;try{review=agentReviewIdentity(state.session);}catch(error){note(error.message,true);}
  const status=editor.conflict?'后台草稿已更新，请核对':editor.dirty?'草稿已修改 · 尚未保存':review?.state==='pending'?'已冻结 · 等待人工审阅':review?.state==='approved'?'人工审阅已通过':draft.status==='prepared'?'已有准备计划':draft.status==='binding_stale'?'PDK 绑定已变化 · 需重新保存':'待准备审阅';
  parent.append(el('p',status,'ic-env-review-state'));
  if(editor.conflict)note('你的本地修改仍保留。请先复制需要保留的内容，再读取后台新草稿；当前版本不能覆盖保存或运行。',true);
  if(editor.error)note(editor.error,true);if(state.agentSave.error)note(state.agentSave.error,true);if(state.preparation.error)note(state.preparation.error,true);
  if(state.session.prepared?.state==='blocked')for(const item of state.session.prepared.missing||[])note(item.message||item.field||item.code,true);
  const input=(label,key,value,rows)=>{const box=el('label',undefined,'ic-env-code-field');box.append(el('span',label));const area=el('textarea');area.value=value;area.rows=rows;area.spellcheck=false;area.dataset.environmentField='agent-'+key;area.dataset.agentField=key;area.setAttribute('aria-label',label);area.disabled=controller.locked;area.addEventListener('input',()=>{try{controller.editAgentTestbench(key,area.value);}catch(error){onError(error);}});box.append(area);return box;};
  parent.append(input('完整 Spectre 测试平台','code',editor.code,14));
  const section=(key,title)=>{const details=el('details',undefined,'ic-sim-detail');details.dataset.environmentDetail=key;details.open=opened.has(key);details.append(el('summary',title));details.addEventListener('toggle',()=>{if(details.isConnected)details.open?opened.add(key):opened.delete(key);});parent.append(details);return details;};
  section('agent-manifest','端口映射、激励、目标、判据与分析脚本').append(input('实验与分析说明 JSON','manifest',editor.manifest,16));
  section('agent-selection','PDK、Corner 与允许主机').append(input('PDK 与主机选择 JSON','selection',editor.selection,8));
  appendHelpers(parent,{controller,opened,onError,section,el,button});
  const summary=el('dl',undefined,'ic-env-observations'),description=draft.testbench;
  for(const [name,value]of [['子电路',description.interface.subckt],['实例',description.interface.instance],['端口映射',description.interface.port_bindings],['分析',description.analyses],['激励',description.stimuli],['目标',description.objectives],['判据',description.criteria],['PDK / 主机',draft.selection]])summary.append(el('dt',name),el('dd',typeof value==='string'?value:JSON.stringify(value)));
  section('agent-saved-summary','已保存内容摘要与版本').append(summary,el('p','源码 '+draft.source_sha256+'\n草稿 '+draft.draft_id+'\n测试平台 '+draft.testbench_sha256+'\n说明 '+draft.manifest_sha256,'ic-sim-code'));
  const actions=el('div',undefined,'ic-sim-toolbar'),locked=controller.locked;
  actions.append(button('保存草稿并撤销旧审阅',()=>controller.saveAgentTestbench(),locked||!editor.dirty&&draft.status!=='binding_stale'||editor.conflict||!!editor.error||state.agentSave.status==='unknown'));
  actions.append(button(editor.conflict?'读取后台新草稿':'撤销本地修改',()=>controller.resetAgentTestbench(),locked||!editor.dirty&&!editor.conflict));
  actions.append(button(state.busy==='agent-prepare'?'准备中…':'生成审阅计划',()=>controller.prepareAgentTestbench(),locked||draft.status==='binding_stale'||editor.dirty||editor.conflict||!!editor.error||review?.state==='pending'||state.agentSave.status==='unknown'));parent.append(actions);
  const reviewButton=button('审阅通过并运行仿真',event=>controller.openAgentTestbenchReview(event),locked||editor.dirty||editor.conflict||!!editor.error||!review||review.state!=='pending'||review.revision!==state.session.revision);reviewButton.classList.add('ic-env-primary');reviewButton.dataset.agentReview='';parent.append(reviewButton);
  note('按钮打开本机独立审阅页。只有在那里确认这份冻结内容后才提交任务；修改输入需重新保存和审阅。');
  if(review)note('审阅指纹：'+review.review_digest);if(state.agentReview.status==='opened')note('已打开本机审阅页。完成确认后，可返回此处刷新原实验；此面板不会再次提交运行。');
}
