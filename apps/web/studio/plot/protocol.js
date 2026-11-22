// Transport-only context consumer. The Studio host remains the sole context producer.
export const CHANNEL='ic.rnl.plot.v1';
export const MODES=['none','voltage','current'];
export const token=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{16,100}$/.test(value);
const string=value=>typeof value==='string'&&value.length<=4096;
export function validContext(ctx){
  if(!ctx||ctx.version!==1||!Number.isSafeInteger(ctx.revision)||ctx.revision<0)return false;
  if(ctx.project!==null&&(!ctx.project||!string(ctx.project.id)))return false;
  if(ctx.run!=null&&(!string(ctx.run.runId)||!/^[a-zA-Z0-9_-]+$/.test(ctx.run.runId)))return false;
  return JSON.stringify(ctx).length<=262144;
}
export function copyContext(ctx){
  const copy={};
  for(const key of ['version','revision','mode','loadState','loading','project','file','selection','geometry','run'])copy[key]=ctx?.[key]??null;
  return structuredClone(copy);
}
export function bindingOf(ctx){
  return {projectId:ctx?.project?.id??null,projectCommit:ctx?.project?.sourceCommit??null,
    runId:ctx?.run?.runId??null,runCommit:ctx?.run?.sourceCommit??null,
    sourcePath:ctx?.file?.path??null,sourceHash:ctx?.file?.currentTextSha256??null,
    geometryCommit:ctx?.geometry?.bundleCommit??null,geometryHash:ctx?.geometry?.manifestSha256??null,
    entry:ctx?.geometry?.nativeEntryId??null};
}
export const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function probeReason(ctx,mode){
  if(!MODES.includes(mode)||mode==='none')return '尚未开启探针。';
  if(!validContext(ctx)||ctx.loading||ctx.loadState!=='ready')return '工程上下文尚未就绪。';
  if(!ctx.run?.runId)return '请先在主窗口选择已保存运行。';
  if(ctx.file?.dirty||ctx.file?.hashPending||!ctx.file?.currentTextSha256||ctx.geometry?.sourceMatch!==true||ctx.geometry?.state==='stale')return '源或几何已过期，禁止添加波形。';
  if(ctx.geometry?.snapshotOnly||ctx.geometry?.canonicalMappingEnabled===false||!ctx.selection?.mappingVerified||ctx.selection?.targetKind!=='canonical')return '此对象没有已验证的当前源映射。';
  const kind=ctx.selection.kind;
  if(mode==='voltage'&&kind!=='net')return '电压探针需要点击网络。';
  if(mode==='current'&&!['instance','terminal','branch'].includes(kind))return '电流探针需要点击器件，再明确选择端口；网络不能代替支路。';
  return null;
}
export function validEnvelope(event,{origin,peer,sender,session,child}){
  const m=event?.data;
  return event?.origin===origin&&event?.source===peer&&m?.channel===CHANNEL&&m.sender===sender&&m.session===session&&
    token(m.sender)&&token(m.session)&&(!child||m.child===child)&&token(m.child)&&Number.isSafeInteger(m.seq)&&m.seq>0;
}
export function validState(m){
  return m?.kind==='state'&&['context','mode','probe'].includes(m.intent)&&MODES.includes(m.mode)&&validContext(m.context)&&
    m.revision===m.context.revision&&same(m.binding,bindingOf(m.context));
}
