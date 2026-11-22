// Bounded model context only. Never forward points, full catalogs, source text or private settings.
const text=(value,max=512)=>typeof value==='string'?value.slice(0,max):null;
const finite=value=>Number.isFinite(value)?value:null;
export function signalSummary(signal){
  return {id:text(signal.id,160),name:text(signal.psf_name||signal.label,256),unit:text(signal.unit,32),
    quantity:text(signal.quantity,32),polarity:text(signal.polarity,64),sample_count:Number.isSafeInteger(signal.sample_count)?signal.sample_count:null,
    data_basis:text(signal.data_basis,100),csv_sha256:text(signal.csv_sha256,64)};
}
export function measurementSummary(measurement){
  if(!measurement)return null;
  const cursor=value=>value?{x:finite(value.x),y:finite(value.y),method:text(value.method,100)}:null;
  return {basis:text(measurement.basis,100),a:cursor(measurement.cursors?.a),b:cursor(measurement.cursors?.b),
    delta:measurement.delta?{dt:finite(measurement.delta.dt),dy:finite(measurement.delta.dy),x_unit:text(measurement.delta.x_unit,32),y_unit:text(measurement.delta.y_unit,32)}:null,
    uses_display_samples:measurement.uses_display_samples===true};
}
export function selectionContext(identity,snapshot,catalog,readings){
  const signals=(snapshot.signals||[]).slice(0,16).map(item=>{
    const found=catalog?.signals?.find(s=>s.id===item.id);
    if(!found)return null;
    const read=readings.get(found.id);
    return {...signalSummary(found),visible:item.visible===true,loaded:item.loaded===true,
      measurement:item.loaded?measurementSummary(read?.measurement):null};
  }).filter(Boolean);
  return {schema:'ic.waveform-selection.v1',view_id:identity.view_id,workspace_id:identity.workspace_id,revision:identity.revision,
    project_id:identity.project_id,run_id:identity.run_id,run_source_commit:identity.run_source_commit||null,source_sha256:identity.source_sha256||null,
    selection_origin:'saved-run-catalog',signals,window:(snapshot.window||[]).slice(0,2).map(finite),
    cursors:{a:finite(snapshot.cursors?.a),b:finite(snapshot.cursors?.b)},
    note:'Historical saved-run data; selection does not assert current schematic freshness or a new simulation.'};
}
export function assertWaveformResponse(data,{runId,signal,catalog}){
  if(data?.run_id!==runId||data.signal?.id!==signal.id||data.signal?.psf_name!==signal.psf_name||data.signal?.unit!==signal.unit)throw Error('波形身份不匹配，拒绝显示其他运行或信号。');
  if(catalog?.source_commit&&data.source_commit!==catalog.source_commit)throw Error('波形源版本与运行目录不一致。');
  if(signal.csv_sha256&&data.csv_sha256!==signal.csv_sha256)throw Error('波形数据校验值与目录不一致。');
  if(!Array.isArray(data.points)||data.points.length>4000||data.points.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)))throw Error('波形数据超限或包含无效样本。');
  if(data.measurement?.uses_display_samples!==false)throw Error('游标来源未核验；拒绝把绘图抽样当作测量。');
  return data;
}
