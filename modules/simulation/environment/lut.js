const states={hit:'命中已有观察',miss:'未命中',stale:'观察已过期',refresh_required:'要求重新扫描',stored:'本次扫描已保存',not_stored:'本次扫描未缓存',not_required:'当前电路不需要 PDK 模型'};

export function appendPdkLut(parent,rows,{detail}={}){
  if(!Array.isArray(rows)||!rows.length)return;
  const doc=parent.ownerDocument,el=(tag,text)=>{const node=doc.createElement(tag);node.textContent=text;return node;};
  const box=doc.createElement('section');box.className='ic-env-lut';box.dataset.pdkLut='';box.append(el('h4','PDK 本地索引'));
  for(const row of rows){
    if(row?.schema!=='ic.onboarding.pdk-lut.v1'){box.append(el('p','索引回执格式不可识别。'));continue;}
    const status=el('p',(row.ssh_target||row.probe_id||'本次探测')+' · '+(states[row.status]||'未识别状态：'+String(row.status)));status.dataset.lutStatus=row.status;box.append(status);
    box.append(el('p','原始观察时间：'+(row.observed_at||row.storage?.observed_at||'未提供')));
    if(row.scan_performed===true)box.append(el('p','本次已执行扫描 · '+(states[row.storage?.status]||'未提供缓存保存状态')));
    if(row.rebound_source_sha256)box.append(el('p','本次匹配已绑定当前电路。'));
    if(row.fresh_dependency_audit_required===true)box.append(el('p','缓存保留此前的环境观察；运行前仍需重新核对依赖。'));
    for(const gap of Array.isArray(row.missing)?row.missing:[])box.append(el('p',gap.message||gap.code||gap.field||'存在未说明的覆盖缺口。'));
    if(detail){const proof=detail(box,'lut-'+(row.probe_id||row.cache_id||'observation'),'索引来源与覆盖范围'),pre=el('pre',JSON.stringify(row,null,2));pre.className='ic-sim-code';proof.append(pre);}
  }
  parent.append(box);
}
