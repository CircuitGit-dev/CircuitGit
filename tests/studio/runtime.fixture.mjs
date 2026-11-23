export function runtimeSnapshot(project='p'){
  const now=new Date().toISOString(),old='2026-01-01T00:00:00Z';
  const acceptance={execution:'failed',data_validity:'unknown',specification:'unknown'};
  return {schema:'ic.simulation.runtime.v1',project_id:project,read_at:now,
    pool:{configured:true,checked_at:now,scan_in_progress:false,hosts:[
      {host_id:'node-a',label:'计算节点 A',reachable:true,cpu_busy_percent:32.5,load_1m:2,cpu_count:32,memory_available_bytes:48*2**30,memory_total_bytes:64*2**30,observed_at:now,error_code:null},
      {host_id:'node-b',label:'计算节点 B',reachable:null,cpu_busy_percent:null,load_1m:null,cpu_count:null,memory_available_bytes:null,memory_total_bytes:null,observed_at:old,error_code:'resource_unavailable'},
    ]},runs:[{run_id:'run-1',source_commit:'a'.repeat(40),configuration:'瞬态测试',
      execution_target:{mode:'resource_pool',host_id:'node-a',plan_id:'b'.repeat(64),resource_observed_at:now,resource_reservation:false},
      execution:{state:'failed',exit_code:137},collectable:true,monitor:{state:'backoff',last_attempt_at:now,last_success_at:old,next_check_at:null,failures:2},
      diagnostics:{schema:'spiceowl.spectre-diagnostics.v1',observed_context:{execution_state:'failed',exit_code:137,log_line_count:2,log_bytes:123,acceptance_source:'not_supplied',oom_evidence:null},
        diagnostics:[{category:'suspected_oom',severity:'warning',code:'spectre_suspected_oom',evidence_line_numbers:[2],redacted_excerpt:'Process exited with code 137',suggested_actions:['Inspect run-bound kernel or cgroup OOM evidence before assigning a cause.']}],
        scientific_acceptance:{...acceptance},agent_proposal:null,advisory_only:true},acceptance}],
    capabilities:{scan:true,monitor:true,direct_submit:false,direct_collect:false}};
}

export function runtimeFixture(){
  let context={loadState:'ready',loading:false,project:{id:'p',sourceCommit:'a'.repeat(40)}};
  const listeners=new Set(),calls=[];
  const fixture={snapshot:runtimeSnapshot(),error:null,scanError:null,policy:{submit:true,collect:true},calls,listeners,
    switchProject(id){context={...context,project:{id,sourceCommit:'a'.repeat(40)}};fixture.snapshot=runtimeSnapshot(id);listeners.forEach(fn=>fn());},
    setContext(next){context={...context,...next};listeners.forEach(fn=>fn());}};
  fixture.host={context:{getContext:()=>context,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}},
    notify(message){calls.push({kind:'notify',message});},gateway:{async request(path,options){
      calls.push({path,options:structuredClone(options)});
      if(path==='/simulation/resources/scan'){
        if(fixture.scanError)throw fixture.scanError;
        fixture.snapshot.pool.scan_in_progress=true;return {accepted:true};
      }
      if(fixture.error)throw fixture.error;
      return structuredClone(fixture.snapshot);
    }}};
  fixture.actions={submit:async()=>{calls.push({kind:'submit-callback'});},collect:async run=>{calls.push({kind:'collect-callback',run_id:run.run_id});}};
  return fixture;
}
