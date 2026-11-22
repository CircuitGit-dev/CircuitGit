// In-memory lifecycle fixture only. No production gateway or simulator operations.
import {createFixture} from '../simulation/fixture.mjs';
import {mount as mountSimulation} from '../../../apps/codex/ui/simulation/index.js';
import {mount as mountSchematic} from '../../../apps/codex/ui/schematic/index.js';
import {mount as mountWaveforms} from '../../../apps/codex/ui/waveforms/index.js';
const clone=v=>structuredClone(v),ws='w_'+'1'.repeat(32),wv='v_'+'2'.repeat(32),commit='a'.repeat(40);
const root=document.querySelector('main'),sim=createFixture(),records=new Map(),calls=[],contexts=[],listeners=new Set();let handle=null,kind=null,saveFailure=false;
const signal={id:'saved-v',psf_name:'VINP',label:'VINP',analysis:'tran',unit:'V',quantity:'voltage',sample_count:3,status:'available',domain:[0,2e-8]};
let wave={schema:'ic.view.v1',kind:'waveforms',view_id:wv,workspace_id:ws,revision:1,workspace_revision:1,identity:{project_id:'fixture-project',source_commit:commit,path:null,source_sha256:null,run_id:'fixture-run',configuration:'TRAN'},selection:null,readiness:{state:'requested'},ui:{mounted:null}};
let waveCount=0;
const loadStyle=p=>fetch('/'+p).then(r=>r.text());
const localHost=(base,id)=>({...base,embedded:true,async loadLocalState(){return clone(records.get(id)||null);},async saveLocalState(state){calls.push({name:'saveLocalState',id,state:clone(state)});if(saveFailure)throw Error('FIXTURE snapshot persistence failed');records.set(id,clone(state));return base.initial;}});
function waveHost(){return localHost({initial:clone(wave),assetURL:p=>'/'+p,onResult:fn=>(listeners.add(fn),()=>listeners.delete(fn)),async updateModelContext(value){contexts.push(clone(value));},async call(name,args){
 calls.push({name,args:clone(args)});if(args.workspace_id!==ws)throw Error('foreign workspace');
 if(name==='ic_workspace_get')return {schema:'ic.workspace.v1',workspace_id:ws,revision:wave.workspace_revision,views:[clone(wave)],selection:null};
 if(args.view_id!==wv)throw Error('foreign view');if(name==='ic_view_get')return clone(wave);
 if((args.revision??args.expected_revision)!==wave.revision)throw Object.assign(Error('stale fixture revision'),{code:'conflict'});
 if(name==='ic_view_data'){let payload;switch(args.query.kind){
 case'runs':payload={jobs:[{run_id:'fixture-run',source_commit:commit,associated_project_id:'fixture-project'}]};break;
 case'signals':payload={run_id:'fixture-run',source_commit:commit,signals:[signal]};break;
 case'mapping':payload={status:'unmapped',run_id:'fixture-run',source_commit:commit};break;
 case'waveform':{waveCount++;const q=args.query,a=q.cursor_a??0,b=q.cursor_b??2e-8;payload={run_id:'fixture-run',source_commit:commit,signal,points:[[0,0],[1e-8,.5],[2e-8,1]],display:{returned_points:3,input_points:3},measurement:{basis:'PSFXL_native_samples',uses_display_samples:false,cursors:{a:{x:a,y:a/2e-8},b:{x:b,y:b/2e-8}},delta:{dt:b-a,dy:(b-a)/2e-8,x_unit:'s',y_unit:'V'}}};break;}
 default:throw Error('fixture read not supported');}return {view:clone(wave),kind:args.query.kind,payload};}
 if(name==='ic_view_select')wave.selection=args.selection.kind==='none'?null:{...args.selection,verification:'saved-signal-catalog',source_commit:commit,run_id:'fixture-run'};
 else if(name==='ic_view_state')wave.readiness={state:'loaded'};else throw Error('unexpected write '+name);
 wave.revision++;wave.workspace_revision++;return clone(wave);
 }},wv);}
let schematicView=null;
async function open(which){root.replaceChildren();kind=which;if(which==='schematic'){
 if(!schematicView)schematicView=await (await fetch('/fixture-schematic-view')).json();
 const host=localHost({initial:clone(schematicView),onResult:()=>()=>{},updateModelContext:async()=>{},assetText:loadStyle,assetBytes:p=>fetch('/'+p).then(r=>r.arrayBuffer()),async call(name,args){
  calls.push({name,args});if(name==='ic_view_get')return clone(schematicView);
  if(name==='ic_view_state'){schematicView.revision++;return clone(schematicView);}
  if(name==='ic_view_data'){const payload=await (await fetch('/fixture-schematic-data?q='+encodeURIComponent(JSON.stringify(args.query)))).json();return {view:clone(schematicView),kind:args.query.kind,payload};}
  throw Error('schematic fixture forbids mutations');
 }},schematicView.view_id);handle=await mountSchematic(root,host);
 }else if(which==='simulation'){const h=localHost({...sim.reopenHost(),assetText:loadStyle},sim.snapshot().view_id);handle=await mountSimulation(root,h);await handle.ready;}else{handle=mountWaveforms(root,waveHost());await handle.ready;}window.testState.ready=true;}
window.testState={calls,contexts,sim,records,open,handle:()=>handle,waveCount:()=>waveCount,failSave:value=>saveFailure=value,
 async close(){await handle.beforeClose();handle.dispose();handle=null;},hide(){handle.setVisible(false);},show(){handle.setVisible(true);},
 async pending(){await handle.ready;const state=sim.snapshot();const next=sim.updateView({requests:[]});sim.notify(next);},
 snapshot:()=>clone(records.get(kind==='simulation'?sim.snapshot().view_id:kind==='schematic'?schematicView.view_id:wv)),
 async reopen(){await open(kind);}};
await open(new URLSearchParams(location.search).get('kind')||'waveforms');
