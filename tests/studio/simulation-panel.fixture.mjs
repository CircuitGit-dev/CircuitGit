// Synthetic UI-only host. Every gateway operation records local data; no network or solver.
export function createPanelFixture(document){
  const A='a'.repeat(40),B='b'.repeat(40),HASH='1'.repeat(64),listeners=new Set(),calls=[],commands=new Map(),saved=new Map();
  let source=A,project='fixture-project',context={project:{id:project,sourceCommit:source},file:{dirty:false},loadState:'ready',loading:false};
  let rows=[
    {run_id:'foreign-run',project_id:'another-project',configuration:'foreign',state:'archived',source_commit:A},
    {project_id:'fixture-project',run_id:'archived-run',configuration:'tran',state:'archived',source_commit:A,updated_at:'2026-11-20T06:40:00Z',collection:{sha256:HASH,bytes:1024,contains_full_raw:true}},
    {project_id:'fixture-project',run_id:'pending-run',configuration:'tran',state:'simulator_complete_pending_measurements',source_commit:A,updated_at:'2026-11-20T06:30:00Z'},
    {project_id:'fixture-project',run_id:'unknown-run',configuration:'short',state:'unknown',source_commit:A,updated_at:'2026-11-20T06:20:00Z'}
  ];
  const defaults={description:'Synthetic transient fixture',parameters:{N:16},analysis:{},postprocess:{start_s:0,end_s:24e-9,step_s:2e-12,max_display_points:1000,signals:[{name:'out',unit:'V',keep:true},{name:'VDD0:p',unit:'A'}]},future:{keep:7}};
  const text=id=>saved.get(project+'/'+id)||JSON.stringify(defaults,null,2)+'\n';
  const rawSignals=[{kind:'voltage',path:'out',spectre:'out'},...Array.from({length:6},(_,i)=>({kind:'voltage',path:'node'+i,spectre:'node'+i})),{kind:'current',instance:'VDD0',terminal:'p',spectre:'VDD0:p'}].map(x=>({...x,origins:[{path:'fixture/testbench.scs',line_start:10}]}));
  const seconds=value=>{const m=/^(\d+(?:\.\d+)?)([np]?)$/.exec(value);return m?Number(m[1])*({n:1e-9,p:1e-12,'':1}[m[2]]):null;};
  function effective(configuration){
    const values={stop:'24n',maxstep:'2p',errpreset:'moderate',method:'gear2only',maxiters:'5',...configuration.analysis};
    const selected=configuration.save?.signals||[];
    const signals=(configuration.save?.mode==='replace'?selected:configuration.save?.mode==='append'?[...rawSignals,...selected]:rawSignals).map(x=>({...x,spectre:x.spectre||(x.kind==='current'?x.instance+':'+x.terminal:x.path),origins:x.origins||[]}));
    return {compiled_inputs_sha256:HASH,parameters:{N:'16',RVAL:'1k',CVAL:'1p',VERY_LONG_PARAMETER_NAME_FOR_NARROW_PANEL:'500m',...configuration.parameters},parameter_statements:[{path:'fixture/testbench.scs',line_start:3,statement:'parameters N=16 RVAL=1k CVAL=1p'}],tran:{values,values_si:{stop:seconds(values.stop),maxstep:seconds(values.maxstep)},statements:[{path:'fixture/testbench.scs',line_start:4,statement:'tran tran stop=24n maxstep=2p'}]},raw_save:{mode:configuration.save?.mode||'inherit',inherited:{signals:rawSignals,directives:[{path:'fixture/testbench.scs',line_start:10,statement:'save out VDD0:p'}]},effective:{signals,policy:{save:'selected'},unresolved_directives:[],implicit_defaults:'Fixture defaults only.'}},postprocess:configuration.postprocess===undefined?defaults.postprocess:configuration.postprocess,postprocess_unconfirmed_in_explicit_save:[],simulator:{profile:'synthetic'}};
  }
  const describe=query=>({schema:'ic.sim.configuration-description.v1',project_id:query.get('project_id'),configuration:query.get('configuration'),source_commit:query.get('source_commit'),configuration_path:'fixture/config.json',configuration_sha256:HASH,configuration_text:text(query.get('configuration')),effective:effective(JSON.parse(text(query.get('configuration')))),editable_analysis_fields:['stop','maxstep','errpreset','method','maxiters'],save_limits:{replace_supported:true,max_signals:128},catalog:{nets:[{path:'out',source:{path:'fixture/testbench.scs',line_start:7}},{path:'input',source:{path:'fixture/testbench.scs',line_start:7}}],instances:[{path:'VDD0',source:{path:'fixture/testbench.scs',line_start:8},terminals:[{id:'p',label:'positive',net:'VDD'},{id:'n',label:'negative',net:'0'}]}]}});
  const record=(name,fn)=>async(...args)=>{calls.push({name,args:structuredClone(args)});return fn(...args);};
  const emit=()=>{for(const fn of listeners)fn(context);};
  const element=document.getElementById('simulation');
  const host={version:1,slots:{simulation:{element,setBadge(){},setVisible(value){element.hidden=!value;}}},context:{getContext:()=>context,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}},
    getProject:()=>({activeProjectId:project,source_commit:source,repo:'fixture/private',capabilities:{runner:true,publish:true},projects:[{id:project,configurations:[{id:'tran',name:'瞬态基准'},{id:'short',name:'短窗口'}]}]}),getRuns:()=>rows,
    notify(message){calls.push({name:'notify',message});},registerCommand(command){commands.set(command.id,command);return()=>commands.delete(command.id);},
    refresh:record('refresh',async options=>{if(options.project){context={...context,project:{id:project,sourceCommit:source}};emit();}}),
    selectRun:record('selectRun',async id=>{context={...context,run:{runId:id}};emit();}),gateway:{
      request:record('request',async path=>{
        const query=new URLSearchParams(path.split('?')[1]);
        if(path.startsWith('/supervision?'))return {schema:'ic.supervision.snapshot.v1',project_id:query.get('project_id'),read_at:'2026-11-20T08:00:00Z',source:'stored_observations',runs:[],scanned_records:0,unavailable_records:0,truncated:false,single_site:true};
        return describe(query);
      }),
      preview:record('preview',async body=>({base_commit:body.base_commit,review_id:'synthetic-review',diff:'--- fixture/config.json\n+++ fixture/config.json\n+ synthetic draft',configuration_previews:[{project_id:project,configuration:document.querySelector('[data-field="configuration"]').value,effective:effective(JSON.parse(body.changes[0].content))}]})),
      save:record('save',async body=>{saved.set(project+'/'+document.querySelector('[data-field="configuration"]').value,body.changes[0].content);source=B;return {source_commit:B,push_status:body.push?'confirmed':'not_requested'};}),
      plan:record('plan',async body=>({...body,settings:{effective:effective(JSON.parse(text(body.configuration)))},blockers:[]})),
      preflight:record('preflight',async body=>({plan:{provenance:{source_commit:source},configuration:{effective:effective(JSON.parse(text(body.configuration)))}}})),
      submit:record('submit',async body=>{rows=[{project_id:project,run_id:'new-run',state:'queued',source_commit:source,configuration:body.configuration,updated_at:'2026-11-20T07:00:00Z'},...rows];return {project_id:project,run_id:'new-run',state:'queued'};}),
      job:record('job',async()=>({})),
      results:record('results',async id=>({job_id:id,state:rows.find(r=>r.run_id===id)?.collection?'collected':'not_collected',collection:rows.find(r=>r.run_id===id)?.collection,summary:{source_commit:A},metrics:[{name:'simulator_exit_code',value:0,unit:'code',scope:'execution'},{name:'fixture_peak',value:0.42,unit:'V',scope:'synthetic'}],artifacts:[{name:'waveforms.csv',bytes:100,url:'/api/jobs/'+id+'/artifacts/waveforms.csv'}]}))
    }};
  return {host,calls,commands,effective,describe,switchProject(id){project=id;context={...context,project:{id,sourceCommit:source}};emit();},setDirty(value){context={...context,file:{dirty:value}};emit();}};
}
