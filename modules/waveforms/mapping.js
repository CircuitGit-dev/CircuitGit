// Exact mapping only. Names are opaque: no slash/dot, escape, bus or ground rewrites.
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function freshness(manifest,context){
  if(!manifest || manifest.status==='unmapped')return {ok:false,status:'unmapped',message:'尚无权威几何→PSF映射；可从已导出信号列表查看历史数据。'};
  const g=context?.geometry,f=context?.file;
  const display=manifest.display_source?.verified===true?manifest.display_source:null;
  if(manifest.display_source && (!display || display.run_source_sha256!==manifest.source?.sha256 ||
      display.view_source_sha256!==display.sha256 || !Number.isSafeInteger(display.suffix_bytes) || display.suffix_bytes<=0 ||
      !/^[0-9a-f]{64}$/.test(display.proof_sha256||'') || display.proof_sha256!==display.proof?.sha256))
    return {ok:false,status:'source_mismatch',message:'尾部注释绑定缺少服务器精确证明核验；已禁用同步。'};
  if(f?.dirty || !f?.currentTextSha256 || f.path!==(manifest.source?.canonical_path||manifest.source?.path) ||
     f.currentTextSha256!==(display?.sha256||manifest.source?.sha256) || g?.sourceMatch!==true || g?.state==='stale')
    return {ok:false,status:'source_mismatch',message:'历史运行 / 当前电气源不同或未验证；已禁用原理图同步。'};
  const isLocalSnapshot=manifest.geometry?.kind==='local_export_snapshot'&&manifest.geometry?.bundle_commit===null;
  if(isLocalSnapshot){
    if(g?.manifestSha256!==manifest.geometry?.manifest_sha256||(manifest.geometry?.bundle_sha256&&g?.bundleSha256!==manifest.geometry.bundle_sha256))
      return {ok:false,status:'geometry_mismatch',message:'实时 RNL 原理图身份不同；已禁用原理图同步。'};
  }else if(g?.bundleCommit!==manifest.geometry?.bundle_commit || g?.manifestSha256!==manifest.geometry?.manifest_sha256)
    return {ok:false,status:'geometry_mismatch',message:'几何 bundle 身份不同；已禁用原理图同步。'};
  if(display)return {ok:true,status:'historical_comment_append',message:`历史运行 · 仅证明中已核验的尾部注释不同（${display.suffix_bytes}字节），未重新仿真。run源 ${display.run_source_sha256.slice(0,12)} → 视图源 ${display.sha256.slice(0,12)}；后续修改禁用同步。`};
  if(context?.project?.sourceCommit!==manifest.source_commit)return {ok:true,status:'historical_same_source',message:'历史运行；当前源内容哈希相同，几何身份已绑定。点击查询此历史结果（不代表当前配置的新仿真）。'};
  return {ok:true,status:'current',message:'源与几何身份匹配 · 点击节点显示电压，器件需选择端口电流。'};
}
export function normalizeSelection(s={}){
  let occurrence=s.occurrencePath??s.occurrence_path??null;
  return {kind:s.kind,name:s.name,scope:s.scope,viewer_source_path:s.viewerSourcePath??s.viewer_source_path,
    occurrence_path:occurrence,terminal_name:s.terminalName??s.terminal_name??null,
    bus_bit:s.busBit??s.bus_bit??null,native_entry_id:s.nativeEntryId??s.native_entry_id??null};
}
export function resolveSelection(manifest,context,catalog){
  const current=freshness(manifest,context);if(!current.ok)return current;
  const s=normalizeSelection(context.selection);if(!s.name)return {status:'no_selection',message:'选择 RNL 节点或器件。'};
  const possible=(manifest.objects||[]).filter(o=>{
    const x=o.selector;
    return x.name===s.name && x.scope===s.scope && x.viewer_source_path===s.viewer_source_path &&
      (x.native_entry_id||manifest.geometry.entry_id)===s.native_entry_id &&
      (s.kind==='instance'?['terminal','branch'].includes(x.kind):s.kind===x.kind);
  });
  if(!possible.length)return {status:'unmapped',message:'该对象无精确映射；不会用同名节点代替。'};
  let candidates=possible;
  if(s.occurrence_path===null)return {status:'occurrence_required',message:'独立 cell 入口没有实例路径，请选择经过验证的 occurrence。',choices:candidates};
  candidates=candidates.filter(o=>equal(o.selector.occurrence_path,s.occurrence_path));
  if(!candidates.length)return {status:'unmapped',message:'该层级 occurrence 无信号映射。'};
  if(s.kind==='instance' || (s.kind!=='net' && s.terminal_name===null))return {status:'terminal_required',message:'电流属于器件端口/支路，请指定端口与方向。',choices:candidates};
  if(s.terminal_name!==null)candidates=candidates.filter(o=>o.selector.terminal_name===s.terminal_name);
  if(s.bus_bit!==null)candidates=candidates.filter(o=>o.selector.bus_bit===s.bus_bit);
  else if(candidates.some(o=>o.selector.bus_bit!==null&&o.selector.bus_bit!==undefined))return {status:'bit_required',message:'请选择总线 bit（保留精确原名）。',choices:candidates};
  if(candidates.length!==1)return {status:'ambiguous',message:'映射不唯一；禁止自动选择。',choices:candidates};
  const mapping=candidates[0];
  if(mapping.status && mapping.status!=='available')return {status:mapping.status,message:stateMessage(mapping.status),proposal:mapping.save_proposal,mapping};
  const signal=catalog?.signals.find(x=>x.id===mapping.signal_id&&x.psf_name===mapping.psf_name&&x.analysis===mapping.analysis&&x.unit===mapping.unit);
  if(!signal)return {status:'signal_absent',message:'映射目标不在此运行已导出目录中；原始保存状态待核对。'};
  return {status:'resolved',mapping,signal};
}
export function stateMessage(status){
  return ({saved_state_unknown:'CSV 未导出该电流；原始 PSF 保存状态未知，需排期只读 catalog。',saved_needs_extraction:'原始结果已保存该信号；需排期提取到独立派生缓存。',not_saved:'该分析未保存此信号；可审阅下次运行的精确信号保存建议。',extraction_failed:'独立提取失败；保留诊断，不自动重试或重新仿真。',analysis_unsupported:'该分析类型尚不支持。'})[status]||status;
}
