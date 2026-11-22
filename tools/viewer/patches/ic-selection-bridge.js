import {navigationMetadata,selectionMetadata} from './ic-context-metadata.js';
// Additive project adapter. Upstream drawing/selection modules remain unchanged.
import {doc,current,selected,path} from './state.js';
import {select} from './selection.js';
import {goTo} from './subcircuits.js';
const parentOrigin=new URLSearchParams(location.search).get('origin');
const rootEntry=new URLSearchParams(location.search).get('root-entry');
const allowed=parentOrigin===location.origin && window.parent!==window;
const send=data=>{if(allowed)window.parent.postMessage({ic:1,...data},parentOrigin);};
window.addEventListener('viewer-selection',()=>{
  if(!allowed||!doc)return;
  const o=doc.objects[selected];
  if(!o||!['instance','net','usage'].includes(o.kind)){send({type:'selection-clear'});return;}
  send({type:'selection',document_path:doc.path,context:selectionMetadata(doc,path,current,selected,rootEntry),kind:o.kind,name:o.name,scope:doc.levels.find(l=>l.host===o.level)?.kind==='file'?'(top)':o.level_title,viewer_object:selected,
        source_path:doc.files[o.lines?.[0]??doc.spans.find(s=>s.object===selected&&s.kind!=='ref')?.file]?.path??null,locations:doc.spans.filter(s=>s.object===selected&&s.kind!=='ref').map(s=>({...s,source_path:doc.files[s.file]?.path})),lines:o.lines});
});
window.addEventListener('viewer-navigate',()=>send({type:'selection-clear'}));
window.addEventListener('viewer-level',()=>queueMicrotask(()=>{if(allowed&&doc)send({type:'context',navigation:navigationMetadata(doc,path,current,rootEntry)});}));
window.addEventListener('message',async event=>{
  if(!allowed||event.source!==window.parent||event.origin!==parentOrigin||event.data?.ic!==1)return;
  const m=event.data;
  if(m.type!=='select'||!doc||!['instance','net'].includes(m.kind)||typeof m.name!=='string')return;
  const i=doc.objects.findIndex(o=>o.kind===m.kind&&o.name===m.name&&(o.level_title===m.scope||(m.scope==='(top)'&&doc.levels.find(l=>l.host===o.level)?.kind==='file')));
  if(i<0){send({type:'selection-error',message:'Object is absent from the current derived view'});return;}
  const level=doc.levels.findIndex(l=>l.host===doc.objects[i].level);
  if(level>=0&&level!==current)await goTo(level);
  select(i,'source');
});
