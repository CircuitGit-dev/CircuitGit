// Agent-written commit drafts; final Git writes remain in the host's reviewed workflow.
export function createCommitMessage({gateway,onChange=()=>{}}){
  let epoch=0,timer=null,disposed=false;
  let state={title:'',body:'',status:'idle',error:'',identity:null,summaryId:null,model:null,titleEdited:false,bodyEdited:false};
  const emit=()=>{if(!disposed)onChange({...state});};
  const current=version=>!disposed&&version===epoch;
  function cancel(){++epoch;clearTimeout(timer);timer=null;}
  function errorText(error){return typeof error==='string'?error:error?.message||'自动摘要未完成，请手动填写。';}
  function accept(result,version){
    if(!current(version))return false;
    const id=state.identity;
    if(result?.project_id!==id.project_id||result.base_commit!==id.base_commit||result.review_id!==id.review_id||typeof result.summary_id!=='string'||!result.summary_id||state.summaryId&&state.summaryId!==result.summary_id)throw Error('摘要回执与当前差异不匹配。');
    state.summaryId=result.summary_id;
    if(result.state==='complete'){
      if(typeof result.title!=='string'||typeof result.body!=='string'||!result.title.trim()||result.title.length>80||/[\r\n]/.test(result.title)||(result.title+'\n\n'+result.body).length>300)throw Error('摘要内容不符合提交标题和说明的长度要求。');
      state={...state,status:'complete',error:'',model:result.model||null,
        title:state.titleEdited?state.title:result.title.trim(),body:state.bodyEdited?state.body:result.body.trim()};emit();return false;
    }
    if(['failed','unknown'].includes(result.state)){state={...state,status:result.state,error:errorText(result.error)};emit();return false;}
    if(result.state!=='running')throw Error('摘要状态未知，请核对后手动填写。');
    state={...state,status:'running'};emit();return true;
  }
  async function poll(version){
    if(!current(version))return;
    try{
      const result=await gateway.request('/changes/summary?'+new URLSearchParams({summary_id:state.summaryId}));
      if(accept(result,version))timer=setTimeout(()=>poll(version),1200);
    }catch(error){if(current(version)){state={...state,status:'unknown',error:errorText(error)};emit();}}
  }
  return {
    getState:()=>({...state}),
    setTitle(title){state={...state,title:String(title),titleEdited:true};emit();},
    setBody(body){state={...state,body:String(body),bodyEdited:true};emit();},
    reset(){cancel();state={title:'',body:'',status:'idle',error:'',identity:null,summaryId:null,model:null,titleEdited:false,bodyEdited:false};emit();},
    invalidate(){cancel();state={...state,title:state.titleEdited?state.title:'',body:state.bodyEdited?state.body:'',identity:null,summaryId:null,model:null,status:'idle',error:''};emit();},
    async prepare(identity){
      const serialized=JSON.stringify(identity);
      if(state.identity&&JSON.stringify(state.identity)===serialized){
        if(state.status!=='unknown')return;
        if(state.summaryId){cancel();state={...state,status:'running',error:''};emit();void poll(epoch);return;}
      }
      cancel();const version=epoch;
      state={...state,title:state.titleEdited?state.title:'',body:state.bodyEdited?state.body:'',identity:{...identity},summaryId:null,status:'running',error:'',model:null};emit();
      try{
        const result=await gateway.request('/changes/summary',{method:'POST',body:{...identity}});
        if(accept(result,version))timer=setTimeout(()=>poll(version),1200);
      }catch(error){if(current(version)){state={...state,status:'failed',error:errorText(error)};emit();}}
    },
    message(){
      const title=state.title.trim(),body=state.body.trim(),message=title+(body?'\n\n'+body:'');
      if(!title||title.length>80||/[\r\n]/.test(title))throw Error('请填写1–80字的单行提交标题。');
      if(message.length>300)throw Error('提交标题和更新说明合计不能超过300字。');
      return message;
    },
    freeze(){cancel();if(state.status==='running'){state={...state,status:'unknown',error:'摘要读取已暂停，可重新预览读取原摘要，或手动填写。'};emit();}},
    destroy(){cancel();disposed=true;}
  };
}
