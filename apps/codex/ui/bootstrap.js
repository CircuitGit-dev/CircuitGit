// Inlined as a classic script by tools/dev/mcp_ui.py; deliberately no module imports.
(()=>{
  const kind=__IC_KIND__,status=document.getElementById('ic-status'),button=document.getElementById('ic-display'),root=document.getElementById('ic-root');
  const notify=(text,{kind='info'}={})=>{status.textContent=text;status.dataset.kind=kind;};
  let bridge,component=null,disposed=false;const urls=new Map();
  try{bridge=createMCPHost({kind,onStatus:notify});}catch(error){notify(error.message,{kind:'error'});return;}
  bridge.setDisposer(async()=>{disposed=true;await component?.dispose?.();for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();delete globalThis.__ICWB_ASSETS__;root.replaceChildren();});
  const display=()=>{button.hidden=!bridge.availableDisplayModes().includes('fullscreen');button.textContent=bridge.hostContext.displayMode==='fullscreen'?'内嵌':'全屏';};
  bridge.onHostContext(display);button.onclick=()=>bridge.requestDisplayMode(bridge.hostContext.displayMode==='fullscreen'?'inline':'fullscreen').catch(error=>notify(error.message,{kind:'error'}));
  const decode=value=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
  Promise.all([bridge.ready,bridge.initialReady,new Promise(resolve=>{if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',resolve,{once:true});else resolve();})]).then(async()=>{
    if(disposed)return;notify('加载 '+kind+' 资源…');
    const payload=JSON.parse(new TextDecoder().decode(decode(document.getElementById('ic-bundle').textContent)));
    if(!payload.entry)throw Error(kind+' component is not installed in this build');
    const assetBytes=path=>{const asset=payload.assets[path];if(!asset)throw Error('Unregistered packaged asset: '+path);return decode(asset.data);};
    const assetText=path=>new TextDecoder().decode(assetBytes(path));
    const assetURL=path=>{if(!urls.has(path)){const asset=payload.assets[path];if(!asset)throw Error('Unregistered packaged asset: '+path);urls.set(path,URL.createObjectURL(new Blob([assetBytes(path)],{type:asset.mime})));}return urls.get(path);};
    globalThis.__ICWB_ASSETS__=Object.freeze({url:assetURL,text:assetText,bytes:assetBytes});
    const imports={};
    for(const [path,encoded] of Object.entries(payload.modules)){const url=URL.createObjectURL(new Blob([decode(encoded)],{type:'text/javascript'}));urls.set('module:'+path,url);imports['@icwb/'+path]=url;}
    const map=document.createElement('script');map.type='importmap';map.textContent=JSON.stringify({imports});document.head.append(map);
    let mountPanel;
    if(kind==='workbench')({mountPanel}=await import('@icwb/apps/codex/ui/workbench/components.js'));
    const host=Object.freeze({...bridge,get initial(){return bridge.initial;},get view(){return bridge.view;},get capabilities(){return bridge.capabilities;},get hostContext(){return bridge.hostContext;},assetURL,assetText,assetBytes,
      ...(mountPanel?{mountPanel:(container,descriptor)=>mountPanel(container,descriptor,host)}:{})});
    const module=await import('@icwb/'+payload.entry);if(disposed)return;
    if(typeof module.mount!=='function')throw Error('Component must export mount(root,host)');
    const mounted=await module.mount(root,host);
    if(!mounted||typeof mounted.dispose!=='function')throw Error('Component must return {dispose()}');
    component=mounted;if(disposed){await component.dispose();return;}notify('');document.body.dataset.appState='mounted';
  }).catch(error=>{if(!disposed)notify(error.message,{kind:'error'});});
})();
