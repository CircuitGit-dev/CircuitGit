// The paired transport owns its credential. This bridge accepts only finite library operations.
const reads=new Set(['capability','catalog','describe','read_file','current','history','commit_detail','checkpoints','get_ci','receipt','pr_status','get_testbenches','get_testbench_result','review_testbench','review_status','branches']);
const writes=new Set(['save','save_files','commit','restore','pr','ci','create_library','create_cell','clone_cell','create_view','create_branch','switch_branch']);
const complete=result=>['complete','completed','succeeded'].includes(result?.state||result?.status);
export const cellFingerprint=value=>value?.fingerprint||JSON.stringify([value?.base_commit,value?.branch,(value?.changes||[]).map(item=>[item.path,item.status,item.sha256]).sort((a,b)=>a[0].localeCompare(b[0]))]);
export function createLibraryBridge({pollInterval=2500}={}){
  let client=null,epoch=0,available=false;const listeners=new Set(),mutations=new Set(),watches=new Map(),sentKeys=new Map();
  const getState=()=>({connected:!!client&&available,revision:epoch});
  const publish=()=>listeners.forEach(fn=>fn(getState()));
  const cellKey=args=>JSON.stringify([args.library_id,args.cell_id]);
  function emitMutation(record,result){
    for(const fn of mutations){try{fn({...record,result});}catch{}}
    if(record.args?.library_id&&record.args?.cell_id){
      const watch=watches.get(cellKey(record.args));if(watch)void poll(watch,true);
    }else{
      for(const watch of watches.values())void poll(watch,true);
    }
  }
  async function request(operation,args={}){
    if(!client||!available)throw Error('请先连接支持电路版本管理的工作台或本机助手。');
    const generation=epoch,transport=client;
    if(operation==='execute'){
      if(!args||!writes.has(args.operation)||!args.args||typeof args.args!=='object'||Array.isArray(args.args)||typeof args.idempotency_key!=='string'||args.idempotency_key.length<8||Object.keys(args).some(key=>!['operation','args','idempotency_key'].includes(key)))throw Error('电路写操作参数无效。');
      if(sentKeys.has(args.idempotency_key))throw Error('此请求已经发送，请检查原回执；不会重复执行。');
      const record={operation:args.operation,args:{library_id:args.args.library_id||null,cell_id:args.args.cell_id||null},idempotency_key:args.idempotency_key};sentKeys.set(args.idempotency_key,record);
      const result=await transport.request('/library/execute',{method:'POST',body:args});
      if(generation!==epoch)throw Object.assign(Error('连接已变化，请使用原请求键核对结果。'),{data:{code:'transport_unknown'}});
      if(complete(result)){record.notified=true;emitMutation(record,result);}return result;
    }
    if(!reads.has(operation))throw Error('不支持的电路版本操作。');
    const result=await transport.request('/library/read',{method:'POST',body:{operation,args}});if(generation!==epoch)throw Error('连接已变化，旧响应已丢弃。');
    if(operation==='receipt'&&complete(result)){const record=sentKeys.get(args.idempotency_key);if(record&&!record.notified){record.notified=true;emitMutation(record,result);}}
    return result;
  }
  function visible(watch){return (typeof document==='undefined'||document.visibilityState!=='hidden')&&[...watch.subscribers].some(item=>item.isVisible());}
  function schedule(watch,delay=pollInterval){clearTimeout(watch.timer);if(watches.get(watch.key)===watch)watch.timer=setTimeout(()=>void poll(watch),delay);}
  async function poll(watch,immediate=false){
    if(watches.get(watch.key)!==watch)return;if(watch.running){if(immediate)watch.queued=true;return;}
    if(!getState().connected)return;if(!visible(watch)){schedule(watch);return;}
    watch.running=true;const revision=epoch;clearTimeout(watch.timer);
    try{const value=await request('current',watch.scope);if(revision!==epoch||watches.get(watch.key)!==watch)return;const fingerprint=cellFingerprint(value),initial=watch.fingerprint===null,changed=!initial&&watch.fingerprint!==fingerprint;watch.fingerprint=fingerprint;
      for(const item of watch.subscribers)if(item.isVisible()){try{item.onCurrent(value,{initial,changed,fingerprint});}catch{}}
    }catch(error){if(revision===epoch&&watches.get(watch.key)===watch)for(const item of watch.subscribers)if(item.isVisible()){try{item.onError(error);}catch{}}}
    finally{watch.running=false;const queued=watch.queued;watch.queued=false;if(getState().connected)schedule(watch,queued?0:pollInterval);}
  }
  return Object.freeze({getState,request,
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    subscribeMutation(fn){mutations.add(fn);return()=>mutations.delete(fn);},
    bind(transport,{supported=true}={}){client=transport;available=supported;epoch++;for(const watch of watches.values()){watch.fingerprint=null;schedule(watch,0);}publish();},
    unbind(){client=null;available=false;epoch++;for(const watch of watches.values()){clearTimeout(watch.timer);watch.fingerprint=null;}publish();},
    watchCell(scope,{isVisible=()=>true,onCurrent=()=>{},onError=()=>{}}={}){
      if(!scope||typeof scope.library_id!=='string'||typeof scope.cell_id!=='string')throw Error('需要明确的库和单元。');
      const key=cellKey(scope);let watch=watches.get(key);if(!watch){watch={key,scope:{library_id:scope.library_id,cell_id:scope.cell_id},subscribers:new Set(),fingerprint:null,running:false,queued:false,timer:null};watches.set(key,watch);}
      const subscriber={isVisible,onCurrent,onError};watch.subscribers.add(subscriber);schedule(watch,0);
      return()=>{watch.subscribers.delete(subscriber);if(!watch.subscribers.size){clearTimeout(watch.timer);watches.delete(key);}};
    }
  });
}
