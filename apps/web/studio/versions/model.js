// Read-only version data. Mutations stay in the host's existing reviewed workflows.
export function createVersionModel({gateway,onChange=()=>{}}){
  let epoch=0,detailEpoch=0,destroyed=false;
  let state={project:null,draft:null,summary:null,detail:null,selected:null,tab:'history',loading:false,detailLoading:false,error:'',detailError:'',includeCosmetic:false};
  const emit=()=>{if(!destroyed)onChange(state);};
  const query=extra=>new URLSearchParams({project_id:state.project.id,...extra});
  async function refresh(){
    if(!state.project?.id||destroyed)return;
    const revision=++epoch,project=state.project;
    ++detailEpoch;state={...state,loading:true,error:'',detail:null,selected:null,detailLoading:false};emit();
    try{
      const result=await gateway.request('/version-control?'+query({limit:'20',scope:'design',...(state.includeCosmetic?{include_cosmetic:'1'}:{})}));
      if(revision!==epoch||destroyed)return;
      if(result.project_id!==project.id)throw Error('版本记录与当前项目不一致。');
      if(result.source_commit!==project.sourceCommit)throw Error('工程版本已变化，请先刷新项目，再查看历史。');
      state={...state,summary:result};
    }catch(error){if(revision!==epoch||destroyed)return;state={...state,summary:null,error:error.message};}
    state={...state,loading:false};emit();
  }
  async function select(sha){
    if(!state.summary?.commits?.some(c=>c.sha===sha))return;
    const revision=++detailEpoch,project=state.project;
    state={...state,selected:sha,detail:null,detailLoading:true,detailError:''};emit();
    try{
      const result=await gateway.request('/version-control/commit?'+query({commit:sha,scope:'design'}));
      if(revision!==detailEpoch||destroyed)return;
      if(result.project_id!==project.id||result.source_commit!==project.sourceCommit||result.commit?.sha!==sha)throw Error('提交详情已过期，请刷新后重新选择。');
      state={...state,detail:result};
    }catch(error){if(revision!==detailEpoch||destroyed)return;state={...state,detailError:error.message};}
    state={...state,detailLoading:false};emit();
  }
  return {getState:()=>state,refresh,select,
    includeCosmetic(value){state={...state,includeCosmetic:value===true};return refresh();},
    async restorePreview(sha){
      if(state.draft||state.summary?.dirty)throw Error('请先处理当前工程草稿或工作区修改。');
      if(!state.summary?.commits?.some(c=>c.sha===sha))throw Error('请选择当前工程历史中的版本。');
      const project=state.project,revision=epoch;
      const result=await gateway.request('/version-control/restore-preview',{method:'POST',body:{project_id:project.id,commit:sha,base_commit:project.sourceCommit}});
      if(destroyed||revision!==epoch||state.project?.id!==project.id||state.project?.sourceCommit!==project.sourceCommit)throw Error('项目已变化；回档预览已丢弃。');
      if(result?.schema!=='ic.version-control.restore-preview.v1'||result.project_id!==project.id||result.base_commit!==project.sourceCommit||result.target_commit!==sha||result.automatic_commit!==false||result.preview?.base_commit!==project.sourceCommit||!/^[a-f0-9]{64}$/.test(result.preview?.review_id||'')||!Array.isArray(result.changes)||!result.changes.length||result.changes.some(c=>!state.summary.scope?.paths?.includes(c.path)))throw Error('回档预览身份或范围不一致。');
      return result;
    },
    context(context){
      const project=context?.project||null,draft=context?.file?.dirty?context.file:null;
      const changed=project?.id!==state.project?.id||project?.sourceCommit!==state.project?.sourceCommit;
      const draftChanged=draft?.path!==state.draft?.path;
      state={...state,project,draft};
      if(changed){++epoch;++detailEpoch;state={...state,summary:null,detail:null,selected:null,loading:false,detailLoading:false,error:'',detailError:''};emit();if(project?.id)void refresh();}
      else if(draftChanged)emit();
    },
    tab(tab){if(!['changes','history'].includes(tab))return;state={...state,tab};emit();},
    back(){++detailEpoch;state={...state,selected:null,detail:null,detailLoading:false,detailError:''};emit();},
    destroy(){destroyed=true;++epoch;++detailEpoch;}
  };
}
