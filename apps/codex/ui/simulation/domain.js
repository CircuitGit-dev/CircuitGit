// Reuse the shared configuration parser and receipt rules; no browser controller is instantiated.
export {parseConfiguration,updateConfiguration,ACTIVE_RUN_STATES} from '../../../../modules/simulation/model.js';
export {receiptPolicy,fullCollection,publicationVerified,runId} from '../../../../modules/simulation/receipts.js';

export const HASH=/^[a-f0-9]{64}$/;
export const COMMIT=/^[a-f0-9]{40}$/;
export const REQUEST_STATES=new Set(['pending_approval','dispatching','uncertain','accepted','denied','rejected']);
export const PENDING_STATES=new Set(['pending_approval','dispatching','uncertain']);
export const MUTATIONS=new Set(['apply','sim_submit','sim_collect','sim_archive']);

const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function editableConfiguration(value){
  for(const key of ['analysis','parameters','save','postprocess'])if(Object.hasOwn(value,key)&&!object(value[key]))throw Error(key+' 必须是对象；请在 JSON 编辑器修正。');
  if(value.save&&(!['inherit','append','replace'].includes(value.save.mode)||!Array.isArray(value.save.signals)||value.save.signals.some(x=>!object(x))))throw Error('save 需要合法 mode 和对象数组 signals；请在 JSON 编辑器修正。');
  return value;
}

export function validateDescriptor(value,identity){
  if(value?.schema!=='ic.sim.configuration-description.v1'||value.project_id!==identity.project_id||value.configuration!==identity.configuration||value.source_commit!==identity.source_commit)throw Error('配置描述与当前窗口的项目、配置或提交不一致。');
  if(!HASH.test(value.configuration_sha256||'')||typeof value.configuration_text!=='string'||typeof value.configuration_path!=='string'||!HASH.test(value.effective?.compiled_inputs_sha256||''))throw Error('配置描述缺少可核对的内容哈希或编译身份。');
  const e=value.effective;
  if(!object(e.tran?.values)||!object(e.parameters)||!Array.isArray(e.raw_save?.effective?.signals)||!Array.isArray(e.raw_save?.inherited?.signals))throw Error('配置描述缺少实际参数、tran 或 raw-save 清单。');
  if(value.catalog&&(!Array.isArray(value.catalog.nets)||!Array.isArray(value.catalog.instances)))throw Error('保存目标目录格式不符。');
  return value;
}

export function validateRequest(receipt,operation,arguments_,prior=null){
  if(receipt?.schema!=='ic.workbench.request.v1'||!HASH.test(receipt.request_id||'')||!HASH.test(receipt.fingerprint||'')||receipt.operation!==operation||!REQUEST_STATES.has(receipt.state))throw Error('待审批回执格式、操作或状态不符；已停止后续操作。');
  if(prior&&(receipt.request_id!==prior.request_id||receipt.fingerprint!==prior.fingerprint))throw Error('请求 ID 或指纹改变；不能把其他请求视作本次批准。');
  if(!receipt.arguments||Object.keys(receipt.arguments).length!==Object.keys(arguments_).length||Object.keys(arguments_).some(k=>receipt.arguments[k]!==arguments_[k]))throw Error('回执参数与冻结请求不一致。');
  if(!object(receipt.review))throw Error('回执缺少可供人工核对的冻结 review。');
  if(receipt.automatic_retry!==false)throw Error('回执未明确禁用自动重试。');
  return receipt;
}

export function approvalInstructions(request){
  if(!HASH.test(request?.request_id||'')||!HASH.test(request?.fingerprint||''))return null;
  const suffix=`--request-id ${request.request_id} --fingerprint ${request.fingerprint}`;
  return {
    notice:'CLI 兼容入口：请本人在使用同一 client 配置的本地 CLI 中核对 review、request ID 和 fingerprint 后决定；不要让模型执行批准命令。',
    approve:`python3 -B apps/codex/ic_workbench.py --config <本机client.json> approve ${suffix}`,
    deny:`python3 -B apps/codex/ic_workbench.py --config <本机client.json> deny ${suffix}`,
  };
}

export function requestLabel(receipt){
  const labels={pending_approval:'等待人工审批 · 尚未执行',dispatching:'已获人工批准，正在派发 · 不可重试',uncertain:'执行结果未知 · 停止重试并核对',denied:'人工拒绝 · 未自动重试',rejected:'派发被拒绝 · 核对错误后再处理'};
  if(receipt?.state==='accepted')return receipt.operation==='apply'?'网关返回提交结果 · 需读取新版本核对':'网关已接受请求 · 不代表任务或发布已完成';
  return labels[receipt?.state]||'请求状态未知';
}

export function safeResult(result,row){
  const id=row?.run_id||row?.job_id;
  if(!id||result?.job_id!==id)throw Error('结果回执的 run 身份不符。');
  if(result.summary?.source_commit&&result.summary.source_commit!==row.source_commit)throw Error('结果 source commit 与任务不符。');
  if(result.publication?.source_commit&&result.publication.source_commit!==row.source_commit)throw Error('发布 source commit 与任务不符。');
  if(row.collection?.sha256&&result.collection?.sha256&&row.collection.sha256!==result.collection.sha256)throw Error('任务与结果 archive hash 不符。');
  if(result.publication?.full_archive_sha256&&result.collection?.sha256!==result.publication.full_archive_sha256)throw Error('发布与收集的 archive hash 不符。');
  return result;
}
