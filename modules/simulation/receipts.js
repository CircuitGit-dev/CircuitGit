// Only existing list/results GETs and explicitly invoked collect/publish POSTs.
const TERMINAL=new Set(['simulator_complete_pending_measurements','simulator_failed','input_hash_failure','job_setup_failed']);
const BUSY=new Set(['queued','preflight','submitted','running','running_observed','collecting','archiving']);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const runId=run=>run?.run_id||run?.job_id;
export const isPublished=publication=>['complete','published'].includes(publication?.status);
export function fullCollection(collection){return collection?.contains_full_raw===true&&hash(collection.sha256)&&Number.isSafeInteger(collection.bytes)&&collection.bytes>0;}

export function publicationVerified(run,publication,collection){
  return isPublished(publication)&&fullCollection(collection)&&publication.source_commit===run.source_commit&&publication.full_archive_sha256===collection.sha256&&/^[a-f0-9]{40}$/.test(publication.archive_commit||'')&&Number.isSafeInteger(publication.release_id)&&typeof publication.verified_at==='string'&&publication.assets?.length>0&&publication.assets.every(a=>a.verified===true&&hash(a.sha256));
}
export function receiptPolicy(run,result=null,attempt=null){
  if(!run||!/^[a-f0-9]{40}$/.test(run.source_commit||''))return {collect:false,archive:false,reason:'任务或源版本身份未知。'};
  const publication=result?.publication||run.publication,collection=result?.collection||run.collection;
  const archived=run.state==='archived'||isPublished(publication);
  const verified=publicationVerified(run,publication,collection);
  if(archived)return {collect:false,archive:false,archived:true,verified,publication,collection,reason:verified?'已核验发布；仅查看保存的回执和链接。':'已归档；仅查看回执，不能重复收集/发布。'};
  if(run.operation_error||run.status_error||run.error||attempt?.status==='failed'||attempt?.status==='unknown')return {collect:false,archive:false,publication,collection,reason:'操作失败或结果未知；仅刷新本地回执核对，不自动重试。'};
  if(BUSY.has(run.state)||attempt?.status==='requesting'||attempt?.status==='accepted')return {collect:false,archive:false,publication,collection,reason:'请求已接受或任务尚在进行；等待本地回执确认最终状态。'};
  if(publication)return {collect:false,archive:false,publication,collection,reason:'已有未完成发布记录；需核对，不能重复启动发布。'};
  if(fullCollection(collection))return {collect:false,archive:true,publication,collection,reason:'完整 raw 已收集，可手动归档。'};
  if(collection)return {collect:false,archive:false,publication,collection,reason:'已有收集记录但完整性未确认；需核对。'};
  return {collect:TERMINAL.has(run.state),archive:false,publication,collection,reason:TERMINAL.has(run.state)?'终态回执，可手动收集完整结果。':'尚无可收集的终态回执。'};
}

export function safeReceiptLink(value,{repo,run,origin,kind='github'}={}){
  if(typeof value!=='string'||!value||!run)return null;
  try{
    const base=new URL(origin),url=new URL(value,base);
    if(url.username||url.password)return null;
    if(kind==='artifact')return url.origin===base.origin&&url.pathname.startsWith('/api/jobs/'+encodeURIComponent(run)+'/artifacts/')&&!url.search&&!url.hash?url.href:null;
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo||''))return null;
    const release='/'+repo+'/releases/',commit='/'+repo+'/commit/';
    return url.protocol==='https:'&&url.hostname==='github.com'&&!url.port&&!url.search&&!url.hash&&(url.pathname.startsWith(release)||url.pathname.startsWith(commit))?url.href:null;
  }catch{return null;}
}

export function createReceiptActions(host,{changed=()=>{},blocked=()=>false}={}){
  const entries=new Map();let disposed=false,busy=false;
  const rows=()=>host.getRuns()||[];
  const row=id=>rows().find(r=>runId(r)===id);
  const notify=()=>{if(!disposed)changed();};
  function entry(id){const run=row(id);if(!run)return null;const key=id+'|'+run.source_commit;if(!entries.has(key))entries.set(key,{runId:id,sourceCommit:run.source_commit,result:null,attempt:null,error:null});return entries.get(key);}
  function validateResult(id,source,result){
    if(!result||result.job_id!==id||!['collected','not_collected'].includes(result.state))throw Error('结果回执身份或协议不符。');
    if(result.summary?.source_commit&&result.summary.source_commit!==source)throw Error('结果源版本不符。');
    if(result.publication?.source_commit&&result.publication.source_commit!==source)throw Error('发布源版本不符。');
    if(result.publication?.full_archive_sha256&&result.collection?.sha256!==result.publication.full_archive_sha256)throw Error('收集与发布 archive SHA 不一致。');
    if(isPublished(result.publication)&&!publicationVerified({source_commit:source},result.publication,result.collection))throw Error('发布终态缺少一致的核验回执。');
  }
  async function fetchLocal(id,record){
    // Both are local stored receipt reads; never Gateway.job / runner.status.
    await host.refresh({runs:true});
    const current=row(id);
    if(!current||current.source_commit!==record.sourceCommit)throw Error('任务列表中的源身份改变。');
    const result=await host.gateway.results(id);validateResult(id,record.sourceCommit,result);
    if(disposed)return result;
    const latest=row(id);if(!latest||latest.source_commit!==record.sourceCommit)throw Error('读取回执期间任务身份改变。');
    if(latest.collection?.sha256&&result.collection?.sha256&&latest.collection.sha256!==result.collection.sha256)throw Error('任务列表与结果回执的 archive SHA 不一致。');
    record.result=result;record.error=null;
    if(record.attempt){
      if(record.attempt.kind==='collect'&&fullCollection(result.collection)&&!['collecting','archiving'].includes(latest.state))record.attempt.status='completed';
      if(record.attempt.kind==='archive'&&publicationVerified(latest,result.publication,result.collection))record.attempt.status='completed';
      if(latest.operation_error){record.error=String(latest.operation_error);record.attempt.status='failed';}
    }
    return result;
  }
  async function inspect(id){
    if(disposed||busy)throw Error('回执操作进行中。');const record=entry(id);if(!record)throw Error('未知任务。');
    busy=true;record.error=null;notify();
    try{return await fetchLocal(id,record);}catch(error){record.error=error.message;if(record.attempt&&record.attempt.status!=='completed')record.attempt.status='unknown';throw error;}
    finally{busy=false;notify();}
  }
  async function operate(id,kind){
    const record=entry(id),run=row(id);
    if(disposed||busy||blocked()||!record)throw Error('当前状态禁止结果写操作。');
    if(host.getProject()?.capabilities?.[kind==='archive'?'publish':'runner']!==true)throw Error('网关未声明此操作能力。');
    if(record.error)throw Error('请先只读刷新回执核对上次错误。');
    const policy=receiptPolicy(run,record.result,record.attempt);
    if(!policy[kind])throw Error(policy.reason);
    if(run.collection?.sha256&&record.result?.collection?.sha256&&run.collection.sha256!==record.result.collection.sha256)throw Error('已缓存回执与任务列表的 archive SHA 不一致；请先核对。');
    const source=run.source_commit;
    record.attempt={kind,status:'requesting',sourceCommit:source};record.error=null;busy=true;notify();
    try{
      const response=await host.gateway[kind](id);
      if(runId(response)!==id||response.source_commit!==source)throw Error('操作响应任务身份不符；结果未知。');
      record.attempt.status='accepted';record.attempt.responseState=response.state;
      if(response.operation_error){record.attempt.status='failed';throw Error(String(response.operation_error));}
      // A returned/accepted request is never alone described as collected/published.
      await fetchLocal(id,record);
      return response;
    }catch(error){record.error=error.message;if(record.attempt.status!=='failed')record.attempt.status='unknown';throw error;}
    finally{busy=false;notify();}
  }
  return {
    get busy(){return busy;},
    selectedId:()=>host.context.getContext()?.run?.runId||null,
    get(id){return entry(id);},
    policy(id){const record=entry(id);const policy=receiptPolicy(row(id),record?.result,record?.attempt);if(busy||blocked()||record?.error)return {...policy,collect:false,archive:false};const capabilities=host.getProject()?.capabilities;return {...policy,collect:policy.collect===true&&capabilities?.runner===true,archive:policy.archive===true&&capabilities?.publish===true};},
    inspect,collect:id=>operate(id,'collect'),archive:id=>operate(id,'archive'),
    destroy(){disposed=true;}
  };
}
