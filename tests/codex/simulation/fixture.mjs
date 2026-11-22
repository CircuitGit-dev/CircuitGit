// Explicit synthetic MCP fixture. No gateway, SSH, solver, source commit or publication.
export const COMMIT='a'.repeat(40),NEXT='b'.repeat(40),HASH='1'.repeat(64),REVIEW='2'.repeat(64);
export const clone=value=>structuredClone(value);
export function createFixture({viewDigit='1',workspaceDigit='1',jobs=[],run=null,historical=false,source=COMMIT,project='fixture-project',configuration='TRAN'}={}){
  const calls=[],contexts=[],listeners=new Set(),receipts=new Map(),faults=new Map();
  const initialText=JSON.stringify({description:'Synthetic UI test configuration',analysis:{},parameters:{},postprocess:{signals:[{name:'out',unit:'V'}],start_s:0,end_s:12e-9,step_s:5e-12,max_display_points:1600},future:{keep:7}},null,2)+'\n';
  const effective={compiled_inputs_sha256:HASH,parameters:{RVAL:'1k',CVAL:'1p'},tran:{values:{stop:'12n',maxstep:'50p',errpreset:'moderate'},values_si:{stop:12e-9,maxstep:50e-12},statements:['tran tran stop=12n maxstep=50p']},raw_save:{mode:'inherit',inherited:{signals:[{kind:'voltage',path:'out',spectre:'out'}],directives:['save out']},effective:{signals:[{kind:'voltage',path:'out',spectre:'out',origins:[{path:'fixture/netlist.scs',line_start:9}]}],policy:{save:'selected'},limitations:[],unresolved_directives:[]}},simulator:{profile:'fixture'},postprocess:JSON.parse(initialText).postprocess};
  const descriptor={schema:'ic.sim.configuration-description.v1',project_id:project,configuration,source_commit:source,configuration_path:'fixture/config.json',configuration_sha256:HASH,configuration_text:initialText,effective,catalog:{nets:[{path:'out',source:{path:'fixture/netlist.scs',line_start:7}}],instances:[{path:'R1',source:{path:'fixture/netlist.scs',line_start:8},terminals:[{id:'p',label:'positive',net:'in'},{id:'n',label:'negative',net:'out'}]}]},editable_analysis_fields:['stop','maxstep','errpreset']};
  let view={schema:'ic.view.v1',workspace_id:'w_'+workspaceDigit.repeat(32),view_id:'v_'+viewDigit.repeat(32),kind:'simulation',revision:1,workspace_revision:1,identity:{project_id:project,configuration,source_commit:source,source_sha256:historical?null:HASH,path:historical?null:'fixture/netlist.scs',run_id:run},readiness:{state:'requested',basis:'server-request',message:null},ui:{resource_uri:'ui://ic-workbench/simulation.html',available:true,mounted:null},visible:true,display_mode:'inline',draft_dirty:false,review_id:null,plan_ready:false,requests:[]};
  let draft=initialText,rows=clone(jobs),resultOverride=null;
  const snapshot=()=>clone({...view,requests:[...receipts.values()].map(({request_id,operation,state,fingerprint})=>({request_id,operation,state,fingerprint}))});
  const bump=()=>{view.revision++;view.workspace_revision++;};
  function closed(args,allowed){for(const key of Object.keys(args))if(!allowed.includes(key))throw Error('Unexpected argument '+key);}
  async function dispatch(name,args){
    if(name==='ic_request_review'){
      closed(args,['request_id','fingerprint']);const receipt=receipts.get(args.request_id);
      if(!receipt||receipt.fingerprint!==args.fingerprint||receipt.state!=='pending_approval')throw Error('SYNTHETIC review binding mismatch');
      // A fake host always cancels by default. Test code may inject a host decision.
      return {request:clone(receipt),review_status:'cancelled',automatic_retry:false};
    }
    if(args.workspace_id!==view.workspace_id||args.view_id!==view.view_id)throw Error('foreign view');
    const base=['workspace_id','view_id'];
    if(name==='ic_view_get'){closed(args,base);return snapshot();}
    if(name==='ic_view_data'){
      closed(args,[...base,'revision','query']);if(args.revision!==view.revision)throw Error('stale revision');
      closed(args.query,['kind',...(args.query.kind==='request'?['request_id']:[])]);
      let payload;
      switch(args.query.kind){
        case 'configuration':if(historical)throw Error('historical config unavailable');payload=descriptor;break;
        case 'draft':if(historical)throw Error('historical draft unavailable');payload={text:draft,dirty:view.draft_dirty,base_sha256:HASH};break;
        case 'runs':payload={jobs:rows};break;
        case 'request':payload=receipts.get(args.query.request_id);if(!payload)throw Error('request not owned');break;
        case 'results':{
          const row=rows.find(r=>(r.run_id||r.job_id)===view.identity.run_id);if(!row)throw Error('run not bound');
          payload=resultOverride||{job_id:row.run_id||row.job_id,state:row.collection?'collected':'not_collected',collection:row.collection,publication:row.publication,summary:{source_commit:row.source_commit}};break;
        }
        default:throw Error('unexpected data query '+args.query.kind);
      }
      return {view:snapshot(),kind:args.query.kind,payload:clone(payload)};
    }
    if(args.expected_revision!==view.revision)throw Error('stale CAS revision');
    const cas=[...base,'expected_revision'];
    if(name==='ic_view_state'){
      closed(args,[...cas,'client_state','message']);view.readiness={state:args.client_state,basis:'client-report',message:args.message};bump();return snapshot();
    }
    if(name==='ic_view_draft'){
      closed(args,[...cas,'text']);JSON.parse(args.text);draft=args.text;view.draft_dirty=draft!==initialText;view.review_id=null;view.plan_ready=false;bump();return snapshot();
    }
    if(name==='ic_view_plan'){
      closed(args,[...cas,'action']);let result;
      if(args.action==='preview_draft'){
        const edited=JSON.parse(draft),preview=clone(effective);preview.compiled_inputs_sha256='3'.repeat(64);Object.assign(preview.tran.values,edited.analysis||{});
        view.review_id=REVIEW;view.plan_ready=false;
        result={review_id:REVIEW,base_commit:source,diff:'--- fixture/config.json\n+++ fixture/config.json\n-'+initialText+'+'+draft,configuration_previews:[{project_id:project,configuration,effective:preview}]};
      }else if(args.action==='plan'){
        if(view.draft_dirty)throw Error('dirty draft');view.plan_ready=true;
        result={project_id:project,configuration,source_commit:source,settings:{effective:clone(effective)},blockers:[],simulator:'fixture'};
      }else throw Error('unexpected plan');
      bump();return {view:snapshot(),result};
    }
    if(name==='ic_view_request'){
      closed(args,[...cas,'operation','idempotency_key','message']);let arguments_,review;
      if(args.operation==='apply'){
        if(!view.review_id||!args.message)throw Error('missing review');arguments_={review_id:view.review_id,message:args.message,idempotency_key:args.idempotency_key};review={base_commit:source,diff:'fixture diff',draft};
      }else if(args.operation==='sim_submit'){
        if(view.draft_dirty||!view.plan_ready)throw Error('missing plan');arguments_={project_id:project,configuration,source_commit:source,idempotency_key:args.idempotency_key};review={source_commit:source,project_id:project,configuration};
      }else if(['sim_collect','sim_archive'].includes(args.operation)){
        if(!view.identity.run_id)throw Error('missing bound run');arguments_={run_id:view.identity.run_id,idempotency_key:args.idempotency_key};review={job_id:view.identity.run_id};
      }else throw Error('unexpected mutation');
      const request_id=(receipts.size+4).toString(16).padStart(64,'0'),fingerprint=(receipts.size+20).toString(16).padStart(64,'0');
      const receipt={schema:'ic.workbench.request.v1',request_id,fingerprint,operation:args.operation,arguments:arguments_,state:'pending_approval',automatic_retry:false,review};
      receipts.set(request_id,receipt);bump();return {view:snapshot(),request:clone(receipt),human_confirmation:{mode:'human-cli',automatic_approval:false}};
    }
    if(name==='ic_view_bind_run'){
      closed(args,[...cas,'request_id']);const r=receipts.get(args.request_id),id=r?.result?.run_id||r?.result?.job_id;
      if(r?.operation!=='sim_submit'||r.state!=='accepted'||!id)throw Error('accepted owned submit required');
      const row=rows.find(r=>(r.run_id||r.job_id)===id);
      if(row?.source_commit!==source||row?.configuration!==configuration)throw Error('run mismatch');
      if(view.identity.run_id!==id){view.identity.run_id=id;bump();}return snapshot();
    }
    throw Error('UNAUTHORIZED TOOL '+name);
  }
  const host={initial:snapshot(),async call(name,args){
    calls.push({name,args:clone(args)});const fault=faults.get(name+':'+(args.query?.kind||''))||faults.get(name);
    return fault?fault(args,()=>dispatch(name,args)):dispatch(name,args);
  },onResult(fn){listeners.add(fn);return()=>listeners.delete(fn);},async updateModelContext(value){contexts.push(clone(value));}};
  return {host,calls,contexts,receipts,faults,descriptor,snapshot,get draft(){return draft;},get rows(){return rows;},get listeners(){return listeners.size;},
    updateRows(value){rows=clone(value);},setResult(value){resultOverride=clone(value);},
    notify(next){for(const listener of listeners)listener(clone(next));},
    updateView(change={}){Object.assign(view,change);bump();return snapshot();},
    // Test code alone models human approval; no UI method can invoke this.
    human(requestId,state,result){const r=receipts.get(requestId);if(!r)throw Error('unknown request');r.state=state;if(result)r.result=clone(result);},
    reopenHost(){return {...host,initial:snapshot()};}
  };
}
