// The transport retains the browser credential; this bridge exposes finite operations only.
const reads=new Set(['capability','describe','read_file','current','history','commit_detail','checkpoints','get_ci','receipt','pr_status']);
const previews=new Set(['preview_save','preview_commit','preview_restore','preview_pr','preview_ci']);
export function createLibraryBridge({win=globalThis.window,now=Date.now}={}){
  let client=null,epoch=0,available=false;const listeners=new Set(),windows=new Set(),tickets=new Map();
  const getState=()=>({connected:!!client&&available});
  const publish=()=>listeners.forEach(fn=>fn(getState()));
  async function confirm(args){
    if(!args||typeof args.review_id!=='string'||Object.keys(args).some(k=>k!=='review_id'))throw Error('需要明确的审阅记录。');
    const generation=epoch,transport=client,popup=win.open('about:blank','_blank');
    if(!popup)throw Error('请允许本机电路审阅窗口弹出。');popup.opener=null;windows.add(popup);
    try{
      const receipt=await transport.request('/library/review-request',{method:'POST',body:args}),url=new URL(receipt.url),base=new URL(transport.base);
      if(generation!==epoch)throw Error('连接已变化，未确认操作。');
      if(url.origin!==base.origin||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.hash||url.pathname!=='/library/review'||url.searchParams.getAll('ticket').length!==1||url.searchParams.size!==1||url.searchParams.get('ticket')!==receipt.ticket)throw Error('电路审阅窗口地址不匹配。');
      tickets.set(args.review_id,receipt.ticket);
      popup.location.replace(url.href);const deadline=now()+600000;
      await new Promise(resolve=>{const timer=setInterval(()=>{if(popup.closed||generation!==epoch||now()>deadline){clearInterval(timer);resolve();}},350);});
      if(generation!==epoch)return {status:'unknown',review_id:args.review_id,human_review_state:'disconnected'};
      const status=await transport.request('/library/read',{method:'POST',body:{operation:'review_status',args:{ticket:receipt.ticket}}});
      if(generation!==epoch)return {status:'unknown',review_id:args.review_id,human_review_state:'disconnected'};
      if(status.state==='completed')return {...status.result,human_review_state:'completed'};
      if(status.state==='failed')throw Object.assign(Error(status.error?.message||'操作未完成，请刷新原记录。'),{data:status.error});
      return {status:status.state==='denied'?'cancelled':['pending','expired'].includes(status.state)?status.state:'unknown',review_id:args.review_id,human_review_state:status.state};
    }catch(e){popup.close();throw e;}finally{windows.delete(popup);}
  }
  return Object.freeze({getState,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    bind(transport,{supported=true}={}){client=transport;available=supported;epoch++;publish();},
    unbind(){client=null;available=false;epoch++;tickets.clear();for(const popup of windows)popup.close();windows.clear();publish();},
    async request(operation,args={}){if(!client||!available)throw Error('请先在 AI 设置中连接支持电路版本管理的本机助手。');
      if(operation==='confirm')return confirm(args);
      if(operation==='receipt'&&tickets.has(args.review_id)){
        const generation=epoch;
        const r=await client.request('/library/read',{method:'POST',body:{operation:'review_status',args:{ticket:tickets.get(args.review_id)}}});
        if(generation!==epoch)throw Error('连接已变化，旧响应已丢弃。');
        if(r.state==='completed')return {...r.result,human_review_state:r.state};
        return {...r,status:r.state,human_review_state:r.state};
      }
      const generation=epoch;let path;
      if(reads.has(operation))path='/library/read';else if(previews.has(operation))path='/library/prepare';else throw Error('不支持的电路版本操作。');
      const result=await client.request(path,{method:'POST',body:{operation,args}});if(generation!==epoch)throw Error('连接已变化，旧响应已丢弃。');return result;
    }});
}
