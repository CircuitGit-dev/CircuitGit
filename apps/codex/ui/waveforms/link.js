import {resolveSelection} from '../../../../modules/waveforms/mapping.js';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const blocked=message=>({status:'blocked',message});
export function workspaceSelection(workspace,waveView){
  if(workspace?.schema!=='ic.workspace.v1'||workspace.workspace_id!==waveView.workspace_id||!Number.isSafeInteger(workspace.revision)||!Array.isArray(workspace.views))return blocked('工作区响应身份无效。');
  const ref=workspace.selection;if(!ref?.selection)return {status:'empty',message:'工作区尚无已发布原理图选择。'};
  if(ref.view_id===waveView.view_id)return {status:'self',message:'最新工作区选择来自本波形视图。'};
  const source=workspace.views.find(v=>v.view_id===ref.view_id);
  if(!source||source.kind!=='schematic'||source.workspace_id!==waveView.workspace_id)return blocked('最新选择不是此工作区的原理图视图。');
  if(source.revision!==ref.view_revision||!same(source.selection,ref.selection))return blocked('原理图选择已过期，请重新发布对象选择。');
  if(source.identity?.project_id!==waveView.identity.project_id)return blocked('原理图与此历史运行属于不同工程。');
  return {status:'selected',source,selection:ref.selection,key:JSON.stringify([source.view_id,source.revision,ref.selection])};
}
export function resolveLinkedSelection({source,selection,waveView,mapping,catalog},terminal=null){
  const i=source?.identity,s=selection;
  if(source?.kind!=='schematic'||source.workspace_id!==waveView.workspace_id||i?.project_id!==waveView.identity.project_id)return blocked('原理图工作区或工程身份不匹配。');
  if(source.draft_dirty||!i?.source_sha256||s?.source_commit!==i.source_commit)return blocked('原理图源身份未核验或有未保存修改。');
  // A schematic view need not have a run; only the receiving waveform view pins it.
  if(mapping?.run_id!==waveView.identity.run_id||mapping.source_commit!==waveView.identity.source_commit||catalog?.run_id!==waveView.identity.run_id)return blocked('当前映射／目录不属于波形窗口的固定运行。');
  if(!['instance','net','terminal'].includes(s?.kind)||s.source_path!==i.path||s.source_path!==(mapping.source?.canonical_path||mapping.source?.path))return blocked('独立库或非 canonical 源对象不能用作此运行探针。');
  if(!Array.isArray(s.occurrence_path)||typeof s.scope!=='string')return blocked('选择没有确定的 occurrence 与作用域。');
  const g=s.geometry;
  if(!g||typeof g.viewer_source_path!=='string'||typeof g.native_entry_id!=='string')return blocked('原理图选择缺少入口／文件／几何绑定元数据；请使用已协同升级的原理图窗口。');
  if(g.snapshot_only||g.canonical_mapping_enabled!==true||g.source_match!==true)return blocked('独立库、未验证或过期原图禁止联动。');
  if(g.bundle_commit!==mapping.geometry?.bundle_commit||g.manifest_sha256!==mapping.geometry?.manifest_sha256)return blocked('原图几何版本与此运行映射不一致。');
  const context={version:1,revision:source.revision,project:{id:i.project_id,sourceCommit:i.source_commit},file:{path:i.path,currentTextSha256:i.source_sha256,dirty:false},
    geometry:{sourceMatch:g.source_match,state:'partial',bundleCommit:g.bundle_commit,manifestSha256:g.manifest_sha256},
    selection:{kind:terminal===null?s.kind:'terminal',name:s.name,scope:s.scope,viewerSourcePath:g.viewer_source_path,nativeEntryId:g.native_entry_id,
      occurrencePath:s.occurrence_path,terminalName:terminal??s.terminal??null,busBit:s.bus_bit??null}};
  const result=resolveSelection(mapping,context,catalog);
  if(result.status==='resolved'&&(result.mapping.scale??1)!==1)return blocked('此联动只支持保留原始符号的映射；需要反号的支路请使用独立明确分析。');
  if(result.status==='resolved')return {...result,source:{view_id:source.view_id,revision:source.revision,source_commit:i.source_commit,source_sha256:i.source_sha256,selection:s}};
  return result;
}
