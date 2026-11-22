// MCP Apps JSON-RPC host harness. Actual UI host/renderer modules run in distinct resources.
const frames=[...document.querySelectorAll('iframe')];window.protocolEvents=[];window.modelUpdates=[];
async function request(path,data){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});return r.json();}
window.addEventListener('message',async event=>{
 const frame=frames.find(f=>f.contentWindow===event.source);if(!frame||event.origin!==location.origin||event.data?.jsonrpc!=='2.0')return;
 const m=event.data,kind=frame.dataset.kind;window.protocolEvents.push({kind,method:m.method,id:m.id});
 const send=value=>frame.contentWindow.postMessage({jsonrpc:'2.0',...value},location.origin);
 if(m.method==='ui/initialize')return send({id:m.id,result:{protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{},updateModelContext:{structuredContent:true}},hostContext:{displayMode:'inline',availableDisplayModes:['inline'],theme:'dark'}}});
 if(m.method==='ui/notifications/initialized'){
  const view=await request('/fixture-view',{kind});send({method:'ui/notifications/tool-input',params:{arguments:{project_id:view.identity.project_id,workspace_id:view.workspace_id,...(kind==='waveforms'?{run_id:view.identity.run_id}:{})}}});send({method:'ui/notifications/tool-result',params:{structuredContent:{ok:true,data:view},content:[]}});return;
 }
 if(m.method==='tools/call'){const result=await request('/fixture-tool',{kind,name:m.params.name,args:m.params.arguments});return send({id:m.id,result});}
 if(m.method==='ui/update-model-context'){window.modelUpdates.push({kind,value:m.params.structuredContent});return send({id:m.id,result:{}});}
 if(m.method==='ui/request-display-mode')return send({id:m.id,result:{mode:'inline'}});
});
