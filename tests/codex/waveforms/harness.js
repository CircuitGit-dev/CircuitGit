// Explicit test fixture for host.call and local view writes. Not a native MCP host claim.
import {mount} from '/apps/codex/ui/waveforms/index.js';
const instance=new URLSearchParams(location.search).get('view')||'a';
const callFixture=async(path,value)=>{
  const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({instance,...value})});
  const b=await r.json();if(b.error)throw Object.assign(Error(b.error.message),{code:b.error.code});return b.value;
};
const initial=await callFixture('/fixture-open',{}),listeners=new Set();
const host={initial,call:(name,args)=>callFixture('/fixture-call',{name,args}),onResult:fn=>(listeners.add(fn),()=>listeners.delete(fn)),
  updateModelContext:async value=>{await callFixture('/fixture-context',{value});window.fixtureModelContext=value;},requestDisplayMode:()=>Promise.reject(Error('Test host does not advertise fullscreen.'))};
window.waveFixture={host,async notification(next){listeners.forEach(fn=>fn(next));},controller:mount(document.querySelector('main'),host)};
await window.waveFixture.controller.ready;
