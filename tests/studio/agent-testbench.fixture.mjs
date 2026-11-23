// Original synthetic multi-input circuit and tool responses. No actual PDK,
// simulation, scientific pass or human authorization is represented here.
import {environmentFixture} from './environment.fixture.mjs';
export const agentSource={file_name:'differential.scs',mode:'agent-tb',text:'simulator lang=spectre\nsubckt differential INP INN OUT VDD VSS\nR0 (INP OUT) resistor r=1k\nR1 (INN OUT) resistor r=2k\nends differential\n'};
export const testbench={schema:'ic.agent_testbench.v1',text:'simulator lang=spectre\ninclude "differential.scs"\nVDD (vdd 0) vsource dc=1\nVINP (inp 0) vsource type=sine ampl=1m freq=1M\nVINN (inn 0) vsource dc=0\nXDUT (inp inn out vdd 0) differential\ntran1 tran stop=10u\nsave out\n',
  interface:{subckt:'differential',instance:'XDUT',port_bindings:{INP:'inp',INN:'inn',OUT:'out',VDD:'vdd',VSS:'0'}},
  analyses:[{name:'tran1',kind:'tran',parameters:{stop:'10u'}}],stimuli:[{instance:'VINP',kind:'sine',amplitude_v:.001,frequency_hz:1e6}],
  objectives:[{description:'Measure the response to a differential stimulus'}],criteria:[{metric:'gain',minimum:0}],postprocess:{language:'python',text:'# synthetic analysis draft; never executed by this fixture\n'}};

export function agentTestbenchFixture(){
  const fixture=environmentFixture(),calls=fixture.calls,originalImport=fixture.adapter.inspectNetlist;
  const selection={discovery_id:'synthetic-discovery',candidate_id:'synthetic-candidate',sections:['synthetic-section'],tmi_candidate_id:null,model_contracts:{},host_ids:['synthetic-host']};
  fixture.adapter.inspectNetlist=async args=>{await originalImport(args);fixture.saved={...fixture.saved,mode:args.mode||'legacy',source:{...fixture.saved.source,file_name:args.file_name,requirements:{instances:[],interfaces:[{name:'differential',ports:['INP','INN','OUT','VDD','VSS']}],required_masters:[],issues:[],confirmation_required:[]}}};return fixture.saved;};
  fixture.adapter.saveAgentTestbench=async args=>{
    calls.push({method:'saveAgentTestbench',args:structuredClone(args)});if(args.intake_id!==fixture.saved.intake_id||args.revision!==fixture.saved.revision)throw Error('Synthetic stale draft');
    const revision=fixture.saved.revision+1;fixture.saved={...fixture.saved,revision,state:'agent_tb_draft',source_commit:null,prepared:null,job:null,agent_tb_review:null,
      agent_tb:{schema:'ic.onboarding.agent-tb.v1',draft_id:String(revision).padStart(64,'0'),revision,source_sha256:fixture.saved.source_sha256,testbench_sha256:'d'.repeat(64),manifest_sha256:'e'.repeat(64),status:'draft',requires_human_review:true,testbench:structuredClone(args.testbench),selection:structuredClone(args.selection)}};return fixture.saved;
  };
  fixture.adapter.prepareAgentTestbench=async args=>{
    calls.push({method:'prepareAgentTestbench',args:structuredClone(args)});if(args.intake_id!==fixture.saved.intake_id||args.revision!==fixture.saved.revision||args.draft_id!==fixture.saved.agent_tb.draft_id)throw Error('Synthetic stale prepare');
    const revision=fixture.saved.revision+1,plan={...fixture.plan(),recipe_id:'agent-testbench'};
    fixture.saved={...fixture.saved,revision,state:'prepared',source_commit:plan.source_commit,prepared:plan,selection:fixture.saved.agent_tb.selection,
      execution_scope:{selected_ssh_targets:['synthetic-host'],candidate_host_ids:['synthetic-host-id'],selection_mode:'automatic_within_selected_hosts',resource_check_at_run:true},
      agent_tb:{...fixture.saved.agent_tb,status:'prepared'},agent_tb_review:{schema:'ic.agent-tb.review.v1',connection_id:fixture.saved.connection_id,review_id:'f'.repeat(64),review_digest:'8'.repeat(64),intake_id:fixture.saved.intake_id,revision,draft_id:fixture.saved.agent_tb.draft_id,plan_id:plan.plan_id,state:'pending',requires_human:true,
        review_path:'/agent-tb/review?intake_id='+fixture.saved.intake_id+'&review_id='+'f'.repeat(64),review_url:'http://127.0.0.1:8766/agent-tb/review?intake_id='+fixture.saved.intake_id+'&review_id='+'f'.repeat(64)}};return fixture.saved;
  };
  fixture.adapter.openAgentTestbenchReview=(args,{event}={})=>{if(event?.isTrusted!==true)throw Error('A synthetic human gesture is required');calls.push({method:'openAgentTestbenchReview',args:structuredClone(args)});return {opened:true,...args};};
  return {...fixture,get saved(){return fixture.saved;},set saved(value){fixture.saved=value;},selection,
    async authorDraft(){return fixture.adapter.saveAgentTestbench({intake_id:fixture.saved.intake_id,revision:fixture.saved.revision,testbench,selection});}};
}
