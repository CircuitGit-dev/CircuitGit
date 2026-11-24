import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_ASSISTANCE_CONTEXT_LIMIT,environmentAgentAssistance,runtimeAgentAssistance} from '../../modules/simulation/agent-assistance.js';
import {createEnvironmentController} from '../../modules/simulation/environment/model.js';
import {environmentFixture,source} from './environment.fixture.mjs';
import {runtimeSnapshot} from './runtime.fixture.mjs';

test('unbound input never borrows a selected intake or includes connection credentials',()=>{
  const state={connection:{connectionId:'store',selectedIntakeId:'another-intake',token:'secret-token',url:'https://example.invalid/?token=secret'},source:{name:'input.scs',models:['nmos'],ports:[{scope:'dut',names:['IN','OUT']}],text:'password=secret-source'},targets:['user:secret-password@host'],pending:[]};
  const result=environmentAgentAssistance('environment',state),text=JSON.stringify(result);
  assert.equal(result.context.binding.status,'unbound');assert.equal(result.context.binding.intake_id,null);
  assert.match(result.prompt,/尚未绑定 intake/);assert.equal(result.context.source.file_name,'input.scs');assert.equal(result.context.environment.selected_host_count,1);
  assert.doesNotMatch(text,/secret|another-intake|example\.invalid/);
});

test('current controller identity and dirty draft are copied without reading or mutating the adapter',async()=>{
  const fixture=environmentFixture(),controller=createEnvironmentController({adapter:fixture.adapter});await controller.ready;
  try{
    await controller.importSource(source);const before=structuredClone(fixture.calls),original=controller.state;
    const result=environmentAgentAssistance('testbench',controller.state,{dirty:true,conflict:true,code:'private-source-text',manifest:'private-script'});
    assert.deepEqual(fixture.calls,before);assert.deepEqual(controller.state,original);
    assert.deepEqual(result.context.binding,{status:'bound',connection_id:original.session.connection_id,intake_id:original.session.intake_id,revision:original.session.revision,source_sha256:original.session.source_sha256,source_commit:null,adapter_connection_id:original.boundConnectionId,connected:true});
    assert.equal(result.context.testbench.local_changes,true);assert.equal(result.context.testbench.conflict,true);assert.equal(result.context.testbench.local_text_included,false);
    assert.doesNotMatch(JSON.stringify(result),/private-source-text|private-script/);
    const changed={...original,connection:{...original.connection,connectionId:'other'}};
    assert.equal(environmentAgentAssistance('environment',changed).context.binding.status,'connection_mismatch');
    assert.equal(environmentAgentAssistance('environment',changed).context.binding.intake_id,original.session.intake_id);
  }finally{controller.destroy();}
});

test('environment diagnosis requires this intake exact saved run, configuration, plan and source',()=>{
  const fixture=environmentFixture(),run=fixture.job(),session={connection_id:'store',intake_id:'intake',revision:4,source_sha256:'a'.repeat(64),source_commit:run.source_commit,job:run};
  const state={session,connection:{connectionId:'store',connected:true},run:{result:structuredClone(run)}};
  const result=environmentAgentAssistance('diagnosis',state);assert.equal(result.context.run.run_id,run.run_id);
  for(const field of ['run_id','job_id','source_commit','configuration','project_id','plan_id']){
    const changed=structuredClone(state);changed.run.result[field]='foreign';assert.throws(()=>environmentAgentAssistance('diagnosis',changed),/原任务/);
  }
  assert.throws(()=>environmentAgentAssistance('diagnosis',{...state,session:{...session,job:null}}),/原任务/);
  assert.throws(()=>environmentAgentAssistance('diagnosis',{run:{result:run}}),/原任务/);
});

test('runtime handoff binds the clicked run and refuses changed identities instead of selecting another run',()=>{
  const snapshot=runtimeSnapshot('project'),second={...structuredClone(snapshot.runs[0]),run_id:'second-run',source_commit:'d'.repeat(40)};snapshot.runs.push(second);
  const identity={project_id:'project',run_id:second.run_id,source_commit:second.source_commit,configuration:second.configuration},state={projectId:'project',status:'ready',snapshot};
  const result=runtimeAgentAssistance(state,identity);assert.equal(result.context.run.run_id,'second-run');assert.equal(result.context.run.source_commit,'d'.repeat(40));assert.equal(result.context.snapshot.cached_observation,true);
  for(const field of ['run_id','source_commit','configuration'])assert.throws(()=>runtimeAgentAssistance(state,{...identity,[field]:'foreign'}),/身份已变化/);
  assert.throws(()=>runtimeAgentAssistance({...state,projectId:'other'},identity),/项目已变化/);
  snapshot.runs.pop();assert.throws(()=>runtimeAgentAssistance(state,identity),/身份已变化/);
});

test('diagnosis shares codes and source lines without log, connection, script or approval content',()=>{
  const snapshot=runtimeSnapshot(),run=snapshot.runs[0];run.token='secret-token';run.approval={secret:'secret-approval'};run.diagnostics.diagnostics[0].redacted_excerpt='secret-log';run.diagnostics.diagnostics[0].suggested_actions=['secret-command'];
  const result=runtimeAgentAssistance({projectId:'p',status:'error',snapshot},{project_id:'p',run_id:run.run_id,source_commit:run.source_commit,configuration:run.configuration});
  assert.equal(result.context.snapshot.status,'error');assert.equal(result.context.run.diagnostics[0].code,'spectre_suspected_oom');assert.deepEqual(result.context.run.diagnostics[0].line_numbers,[2]);assert.doesNotMatch(JSON.stringify(result),/secret-/);
});

test('oversized inventories are projected to finite metadata and detached from their source',()=>{
  const state={connection:{},source:{name:'synthetic.scs',models:Array.from({length:10000},(_,i)=>'model-'+i),ports:Array.from({length:1000},(_,i)=>({scope:'subckt-'+i,names:Array(1000).fill('port')}))}};
  const result=environmentAgentAssistance('testbench',state);assert.ok(new TextEncoder().encode(JSON.stringify(result.context)).length<=AGENT_ASSISTANCE_CONTEXT_LIMIT);
  assert.equal(result.context.source.model_count,10000);assert.equal(result.context.source.models.length,24);assert.equal(result.context.source.interfaces.length,4);
  result.context.source.models[0]='changed';assert.equal(state.source.models[0],'model-0');
  assert.throws(()=>environmentAgentAssistance('submit',state),/未知/);
});
