import {mountAI} from './ai-panel.js';
const select = document.querySelector('#project');
let context = null, generation=0, revision=0;
const listeners = new Set();
async function get(path) {const r=await fetch(path);const j=await r.json();if(!j.ok)throw Error(j.error.message);return j.data;}
async function change() {const current=++generation;const next=await get('/api/ai/context?project_id='+encodeURIComponent(select.value));if(current!==generation)return;context={...next,revision:++revision};for(const fn of listeners)fn(structuredClone(context));}
const panel=mountAI(document.querySelector('#ai-panel'),{contextAdapter:{getContext:()=>structuredClone(context),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}}});
select.disabled=true;select.addEventListener('change',()=>change().catch(panel.showError));
try {const projects=await get('/api/ai/catalog');for(const p of projects.projects){const o=document.createElement('option');o.value=p.id;o.textContent=p.name;select.append(o);}await change();select.disabled=false;}
catch(e){panel.showError(e);}
