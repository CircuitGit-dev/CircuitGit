import {deriveView,hashText} from './source-map.js';
export {deriveView,indexSpectre,hashText} from './source-map.js';
/** Mount the real upstream RNL canvas. Private data stays in same-origin iframe/Worker. */
export function mount(container,initial){
  const frame=document.createElement('iframe');frame.title='Rich Netlist circuit viewer';
  frame.style.cssText='width:100%;height:100%;min-height:280px;border:0;background:#fff';
  const url=new URL('../vendor/rnl-viewer/index.html',import.meta.url);url.searchParams.set('embed','1');url.searchParams.set('origin',location.origin);
  if(url.origin!==location.origin)throw Error('Viewer must be locally hosted on the same origin');
  frame.src=url.href;container.replaceChildren(frame);
  let ready=false,rendered=false,generation=0,options=initial,view=null,activeRequest=null,pending=null,sourceHash=null,destroyed=false;
  const status=data=>options.onStatus?.({viewer:'RNL Viewer 0.5.1 / core 0.5.3',...data});
  const send=data=>frame.contentWindow.postMessage({rnl:1,...data},location.origin);
  async function update(next){
    options={...options,...next};const revision=++generation;view=null;activeRequest=null;pending=null;rendered=false;status({state:'stale',stale:true,message:'Source changed; rebuilding supported view'});
    try{
      const hash=await hashText(options.sourceText);if(revision!==generation||destroyed)return;
      if(options.sourceHash&&options.sourceHash!==hash)throw Error('Supplied source hash does not match editor text');
      const derived=deriveView(options.sourceText,options.sourcePath,options.scope);sourceHash=hash;view=derived;
      pending={rnl:1,type:'open',text:derived.text,name:derived.name,requestId:'ic-'+revision};activeRequest=pending.requestId;
      status({state:'loading',stale:true,source_sha256:hash,coverage:derived.coverage,limitations:derived.limitations});
      if(ready)send(pending);
    }catch(error){status({state:'unsupported',stale:true,message:error.message});}
  }
  function receive(event){
    if(event.source!==frame.contentWindow||event.origin!==location.origin||destroyed)return;
    const m=event.data;
    if(m?.rnl===1){
      if(m.type==='ready'){ready=true;if(pending)send(pending);}
      else if(m.type==='loaded'&&m.requestId===activeRequest&&view){
        rendered=!m.errors;
        pending=null;
        send({type:'level',name:view.scope==='(top)'?view.name:view.scope});status({state:m.errors?'error':'ready',stale:!!m.errors,
          source_sha256:sourceHash,source_commit:options.sourceCommit??null,errors:m.errors,warnings:m.warnings,
          coverage:view.coverage,limitations:view.limitations});
      }else if(m.type==='error'&&(!m.requestId||m.requestId===activeRequest)){rendered=false;status({state:'error',stale:true,message:m.message});}
    }else if(m?.ic===1&&m.type==='selection'&&view&&rendered){
      const obj=view.mapping.objects.find(o=>o.kind===m.kind&&o.name===m.name&&o.scope===m.scope);
      if(obj)options.onSelect?.({...obj,source_sha256:sourceHash,source_commit:options.sourceCommit??null});
    }
  }
  window.addEventListener('message',receive);void update(initial);
  const destroy=()=>{destroyed=true;generation++;window.removeEventListener('message',receive);frame.remove();};
  return {update,select(target){
    if(!view||!ready||!rendered)return false;const obj=typeof target==='string'?view.mapping.objects.find(o=>o.id===target):target;
    if(!obj||!(view.coverage.available_scopes??[view.scope]).includes(obj.scope))return false;
    frame.contentWindow.postMessage({ic:1,type:'select',kind:obj.kind,name:obj.name,scope:obj.scope},location.origin);return true;
  },setScope(scope){if(!view||!ready||!rendered)return false;if(!(view.coverage.available_scopes??[view.scope]).includes(scope))return false;send({type:'level',name:scope==='(top)'?view.name:scope});return true;},destroy,dispose:destroy,frame};
}
