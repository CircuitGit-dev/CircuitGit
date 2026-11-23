import {sha256} from '../core.js';
import {checkAnalysisResult} from '../../../modules/simulation/environment/analysis.js';
import {onboardingRecovery} from '../../../modules/simulation/environment/recovery.js';

const clone=value=>structuredClone(value);
const validSession=s=>s?.schema==='ic.onboarding.session.v1'&&typeof s.intake_id==='string'&&
  typeof s.connection_id==='string'&&/^[a-f0-9]{64}$/.test(s.source_sha256||'')&&Number.isInteger(s.revision)&&s.revision>=1;

/** The displayed source and explicitly selected intake are the only sync scope. */
export function createOnboardingSync({bridge,getSource,openWaveforms,hashText=sha256,
  setTimer=setTimeout,clearTimer=clearTimeout,interval=2500}={}){
  const controllers=new Set(),listeners=new Set();
  let disposed=false,timer=null,inflight=null,lastWaveform=null,lastIdentity=null,generation=0;
  const notify=()=>{for(const fn of listeners)fn();};
  async function matches(session){
    if(!validSession(session))return false;
    const state=bridge.getState(),source=await getSource?.();
    if(!state.connected||state.storeIdentity!==session.connection_id||state.selectedIntakeId!==session.intake_id||
       typeof source?.text!=='string')return false;
    const hash=await hashText(source.text),after=await getSource?.();
    const current=bridge.getState();
    return !disposed&&current.connectionId===state.connectionId&&current.storeIdentity===session.connection_id&&
      current.selectedIntakeId===session.intake_id&&after?.text===source.text&&
      after?.file_name===source.file_name&&hash===session.source_sha256;
  }
  function schedule(){
    if(onboardingRecovery(bridge.getSessionState())){if(timer!==null)clearTimer(timer);timer=null;return;}
    if(disposed||timer!==null||!controllers.size)return;
    timer=setTimer(()=>{timer=null;void refresh().catch(()=>{}).finally(schedule);},interval);
    timer?.unref?.();
  }
  async function refresh(){
    if(inflight)return inflight;
    const request=++generation;
    inflight=(async()=>{
      const state=bridge.getState();if(!state.connected||!state.selectedIntakeId)return {status:'ignored'};
      let session=bridge.getSessionState();
      if(!session)session=await bridge.getSession({intake_id:state.selectedIntakeId});
      if(!await matches(session)||disposed||request!==generation)return {status:'ignored'};
      const identity={connectionId:state.connectionId,intakeId:session.intake_id,sourceSha256:session.source_sha256,revision:session.revision};
      let deferred=false;
      for(const controller of controllers){
        const result=await controller.refreshCurrent(identity);
        if(result?.status==='deferred'||result?.status==='ignored')deferred=true;
      }
      if(!controllers.size)session=await bridge.getSession({intake_id:session.intake_id});
      else session=bridge.getSessionState();
      if(!await matches(session)||disposed||request!==generation)return {status:'ignored'};
      const signature=JSON.stringify([session.connection_id,session.intake_id,session.revision,session.source_sha256,
        session.state,session.updated_at,session.job?.state,session.job?.waveforms?.archive_sha256]);
      if(signature!==lastIdentity){lastIdentity=signature;notify();}
      const job=session.job,descriptor=job?.waveforms;
      const waveKey=JSON.stringify([session.connection_id,session.intake_id,job?.job_id,descriptor?.archive_sha256]);
      if(!onboardingRecovery(session)&&!deferred&&openWaveforms&&descriptor?.available===true&&descriptor.source_binding_verified===true&&
         job?.plan_id===session.prepared?.plan_id&&waveKey!==lastWaveform){
        await openWaveforms({intake:session,job});
        if(await matches(session)&&request===generation)lastWaveform=waveKey;
      }
      return {status:deferred?'deferred':'updated',session};
    })();
    try{return await inflight;}finally{inflight=null;}
  }
  async function contextFor({connectionId=null,fallback=null,required=false,refresh:refreshSession=false}={}){
    const state=bridge.getState();let session=bridge.getSessionState();
    if((!session||refreshSession)&&state.connected&&state.selectedIntakeId)session=await bridge.getSession({intake_id:state.selectedIntakeId});
    if(!validSession(session)||connectionId&&session.connection_id!==connectionId||!await matches(session)){
      if(required)throw Error('当前电路与 AI 的仿真会话不同，请重新选择当前网表。');
      return fallback;
    }
    return {version:1,revision:session.revision,mode:'live',loadState:'ready',
      project:{id:'onboarding:'+session.intake_id,sourceCommit:session.source_commit??null},
      file:{path:session.source.file_name,baseCommit:session.source_commit??null,persistedSha256:session.source_sha256,
        currentTextSha256:session.source_sha256,dirty:false,hashPending:false},
      selection:null,geometry:null,run:null,
      onboarding:{schema:'ic.onboarding.context.v1',connection_id:session.connection_id,intake_id:session.intake_id,
        revision:session.revision,source_sha256:session.source_sha256}};
  }
  async function handleToolResult({tool,result}={}){
    if(disposed||!/^ic_onboarding_/.test(tool||''))return {status:'ignored'};
    // Accept both the web Service result and the native MCP structured envelope.
    const session=result?.structuredContent?.data??(result?.ok===true?result.data:result);
    if(tool==='ic_onboarding_analysis'&&session?.schema==='ic.onboarding.analysis.v1'){
      const current=bridge.getSessionState();if(!await matches(current))return {status:'ignored'};
      let checked;try{checked=checkAnalysisResult(session,current);}catch{return {status:'ignored'};}
      for(const controller of controllers){if(!await matches(current))return {status:'ignored'};controller.receiveAnalysis?.(checked);}
      return {status:'updated',analysisId:checked.analysis_id};
    }
    if(!validSession(session))return {status:'ignored'};
    const state=bridge.getState();
    if(!state.connected||state.storeIdentity!==session.connection_id)return {status:'ignored'};
    if(session.intake_id!==state.selectedIntakeId){
      if(tool!=='ic_onboarding_netlist')return {status:'ignored'};
      const source=clone(await getSource?.());if(typeof source?.text!=='string'||await hashText(source.text)!==session.source_sha256)return {status:'ignored'};
      const selectionCurrent=()=>{const now=bridge.getState();return now.connected&&now.connectionId===state.connectionId&&
        now.storeIdentity===state.storeIdentity&&now.selectedIntakeId===state.selectedIntakeId;};
      if(!selectionCurrent())return {status:'ignored'};
      // A tool-created intake is adopted only from this explicit result, never a list's newest item.
      await bridge.adoptIntake(session,{isCurrent:async()=>{const now=await getSource?.();return !disposed&&selectionCurrent()&&now?.text===source.text&&now?.file_name===source.file_name;}});
    }else if(bridge.getSessionState()?.source_sha256!==session.source_sha256)return {status:'ignored'};
    return refresh();
  }
  const unsubscribe=bridge.subscribe(()=>{notify();schedule();});
  return Object.freeze({contextFor,refresh,handleToolResult,
    register(controller){
      if(typeof controller?.refreshCurrent!=='function')throw TypeError('Onboarding controller must support exact-session refresh');
      controllers.add(controller);void refresh().catch(()=>{});schedule();
      return ()=>{controllers.delete(controller);if(!controllers.size&&timer!==null){clearTimer(timer);timer=null;}};
    },
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    destroy(){disposed=true;generation++;if(timer!==null)clearTimer(timer);timer=null;unsubscribe();controllers.clear();listeners.clear();}
  });
}
