/** MCP Apps 2026-01-26 bridge. No gateway tokens, model calls, or global active view. */
export const MCP_UI_PROTOCOL='2026-01-26';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const freeze=value=>{if(object(value)||Array.isArray(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const snapshot=value=>freeze(structuredClone(value));
const stable=value=>JSON.stringify(value,(_,item)=>object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const receiptNext={pending_approval:['dispatching','accepted','rejected','uncertain','denied'],dispatching:['accepted','rejected','uncertain']};
function casState(view){
  const {workspace_revision,requests,ui,...state}=view;
  return {...state,ui:ui?Object.fromEntries(Object.entries(ui).filter(([key])=>key!=='available')):ui,
    requests:(requests||[]).map(({request_id,operation,fingerprint})=>({request_id,operation,fingerprint})).sort((a,b)=>a.request_id.localeCompare(b.request_id))};
}
function checkLiveFields(previous,next){
  if(!Number.isInteger(next.workspace_revision)||next.workspace_revision<0)throw Error('Invalid workspace revision');
  if(previous&&next.workspace_revision<previous.workspace_revision)throw Error('Stale workspace revision rejected');
  if(!Array.isArray(next.requests))throw Error('Invalid request summaries');
  const incoming=new Map();
  for(const receipt of next.requests){
    if(!object(receipt)||typeof receipt.request_id!=='string'||!receipt.request_id||typeof receipt.operation!=='string'||typeof receipt.fingerprint!=='string'||typeof receipt.state!=='string'||!receipt.state||incoming.has(receipt.request_id))throw Error('Invalid request summary identity');
    incoming.set(receipt.request_id,receipt);
  }
  for(const before of previous?.requests||[]){
    const after=incoming.get(before.request_id);
    if(!after||before.operation!==after.operation||before.fingerprint!==after.fingerprint)throw Error('Request receipt identity changed or disappeared');
    if(before.state!==after.state&&!receiptNext[before.state]?.includes(after.state))throw Error('Stale or incompatible request receipt state rejected');
  }
}

export function validateViewTransition(current,view,kind,bindRunFrom=null){
    if(view.kind!==kind||typeof view.view_id!=='string'||!view.view_id||typeof view.workspace_id!=='string'||!view.workspace_id||!Number.isInteger(view.revision)||view.revision<1)throw Error('Invalid view descriptor');
    if(current)for(const key of ['workspace_id','view_id'])if(view[key]!==current[key])throw Error('Cross-view '+key+' rejected');
    if(current&&view.revision<current.revision)throw Error('Stale view revision rejected');
    if(current&&stable(view.identity)!==stable(current.identity)){
      const sameExceptRun=stable({...view.identity,run_id:null})===stable({...current.identity,run_id:null});
      const sameBinding=bindRunFrom?.revision===current.revision&&stable(bindRunFrom.identity)===stable(current.identity);
      const permitted=sameBinding&&current.kind==='simulation'&&current.identity?.run_id===null&&typeof view.identity?.run_id==='string'&&view.identity.run_id.length>0&&view.revision>current.revision&&sameExceptRun;
      if(!permitted)throw Error('Pinned source/run identity changed; open a new view');
    }
    checkLiveFields(current,view);
    // Only server-owned live fields may advance without changing this view's CAS revision.
    if(current&&view.revision===current.revision&&stable(casState(view))!==stable(casState(current)))throw Error('CAS-controlled view fields changed without a revision');
}

export function unwrapToolResult(result){
  const envelope=result?.structuredContent;
  if(result?.isError||envelope?.ok===false){const error=new Error(envelope?.error?.message||result?.content?.find(c=>c.type==='text')?.text||'MCP tool failed');error.code=envelope?.error?.code;error.details=envelope?.error?.details;throw error;}
  if(!object(envelope)||envelope.ok!==true||!('data' in envelope))throw Error('Tool result lacks the IC success envelope');
  return result?._meta?.icWorkbench&&Object.hasOwn(result._meta.icWorkbench,'data')?result._meta.icWorkbench.data:envelope.data;
}

export function parentOrigin(win,explicit){
  if(explicit==='null')return null;
  if(!explicit&&win.location?.ancestorOrigins?.[0]==='null')return null;
  const candidates=explicit?[explicit]:[win.location?.ancestorOrigins?.[0],win.document?.referrer];
  for(const candidate of candidates){if(!candidate)continue;try{const url=new URL(candidate);if(url.origin!=='null'&&['https:','http:'].includes(url.protocol))return url.origin;}catch{}}
  if(explicit)throw Error('Invalid explicit MCP Apps parent origin');
  return null;
}

export function createMCPHost({kind,window:win=window,origin,requestTimeout=30000,initializeTimeout=4000,onStatus=()=>{}}={}){
  if(!['schematic','waveforms','simulation','workbench'].includes(kind))throw Error('Unknown UI kind');
  if(!win.parent||win.parent===win)throw Error('Open this resource in a compatible MCP Apps host');
  const peer=win.parent,pending=new Map(),results=new Set(),inputs=new Set(),contexts=new Set(),children=new Map();
  let pinnedOrigin=parentOrigin(win,origin),targetOrigin=pinnedOrigin||'*',originLearned=!!pinnedOrigin;
  const prefix='ic-ui-'+win.crypto.randomUUID()+'-';let counter=0,closed=false,initialized=false,first=null,current=null,input=null,capabilities={},hostContext={},disposeUI=()=>{},resizeObserver=null;
  let resolveInitial,rejectInitial;
  const initialReady=new Promise((resolve,reject)=>{resolveInitial=resolve;rejectInitial=reject;});initialReady.catch(()=>{});
  const status=(message,kind='error')=>{try{onStatus(message,{kind});}catch{}};
  function send(message){if(closed)throw Error('MCP UI bridge disposed');peer.postMessage({jsonrpc:'2.0',...message},targetOrigin);}
  function request(method,params,timeout=requestTimeout){
    if(closed)return Promise.reject(Error('MCP UI bridge disposed'));
    const id=prefix+(++counter);
    return new Promise((resolve,reject)=>{const timer=win.setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out; not retried'));},timeout);pending.set(id,{resolve,reject,timer});try{send({id,method,params});}catch(error){win.clearTimeout(timer);pending.delete(id);reject(error);}});
  }
  function checkIdentity(value){
    if(!current||!object(value))return;
    for(const key of ['workspace_id','view_id'])if(value[key]!==undefined&&value[key]!==current[key])throw Error('Cross-view '+key+' rejected');
  }
  function descriptor(data){return data?.schema==='ic.view.v1'?data:data?.view?.schema==='ic.view.v1'?data.view:null;}
  function accept(data,{required=false,notify=true,bindRunFrom=null}={}){
    const view=descriptor(data);
    if(!view){if(required)throw Error('Initial result lacks an ic.view.v1 descriptor');return data;}
    validateViewTransition(current,view,kind,bindRunFrom);
    const changed=!current||stable(view)!==stable(current);
    current=snapshot(view);
    if(!first){first=current;resolveInitial(first);}
    if(notify&&changed)for(const callback of [...results]){try{callback(current);}catch(error){status(error.message);}}
    return data;
  }
  function applyContext(next){
    if(!object(next))return;hostContext=snapshot({...hostContext,...next,styles:next.styles?{...hostContext.styles,...next.styles}:hostContext.styles});
    const doc=win.document;
    if(doc?.documentElement){
      if(['light','dark'].includes(hostContext.theme))doc.documentElement.dataset.theme=hostContext.theme;
      for(const [key,value] of Object.entries(hostContext.styles?.variables||{}))if(/^--[a-z0-9-]+$/i.test(key)&&typeof value==='string')doc.documentElement.style.setProperty(key,value);
      const dimensions=hostContext.containerDimensions||{};doc.documentElement.dataset.fixedHeight=String(Number.isFinite(dimensions.height));
    }
    for(const callback of [...contexts]){try{callback(hostContext);}catch(error){status(error.message);}}
  }
  async function dispose(){
    if(closed)return;closed=true;resizeObserver?.disconnect();win.removeEventListener('message',receive);win.removeEventListener('pagehide',dispose);
    for(const item of pending.values()){win.clearTimeout(item.timer);item.reject(Error('MCP UI bridge disposed'));}pending.clear();rejectInitial(Error('MCP UI bridge disposed'));
    results.clear();inputs.clear();contexts.clear();await disposeUI();
  }
  async function receive(event){
    if(closed||event.source!==peer||(originLearned&&event.origin!==pinnedOrigin)||!object(event.data)||event.data.jsonrpc!=='2.0')return;
    const message=event.data;
    if(Object.hasOwn(message,'id')&&!message.method){const item=pending.get(message.id);if(!item)return;
      // Official PostMessageTransport scopes opaque sandbox traffic by WindowProxy.
      // Learn only from a correlated response from our direct parent, never another frame.
      if(!originLearned){pinnedOrigin=event.origin;targetOrigin=event.origin==='null'?'*':event.origin;originLearned=true;}
      pending.delete(message.id);win.clearTimeout(item.timer);if(object(message.error)){const error=new Error(message.error.message||'Host request failed');error.code=message.error.code;item.reject(error);}else if(Object.hasOwn(message,'result'))item.resolve(message.result);else item.reject(Error('Malformed JSON-RPC response'));return;}
    if(!initialized)return;
    if(Object.hasOwn(message,'id')){
      if(message.method==='ping'){send({id:message.id,result:{}});return;}
      if(message.method==='ui/resource-teardown'){
        try{await dispose();peer.postMessage({jsonrpc:'2.0',id:message.id,result:{}},targetOrigin);}catch(error){peer.postMessage({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:error.message}},targetOrigin);}return;
      }
      send({id:message.id,error:{code:-32601,message:'App method not supported'}});return;
    }
    try{
      if(message.method==='ui/notifications/tool-input'){input=snapshot(message.params?.arguments||{});for(const callback of [...inputs])callback(input);}
      else if(message.method==='ui/notifications/tool-result'){if(input===null)throw Error('tool-input required before tool-result');accept(unwrapToolResult(message.params),{required:!first});}
      else if(message.method==='ui/notifications/host-context-changed')applyContext(message.params);
      else if(message.method==='ui/notifications/tool-cancelled'){status(message.params?.reason||'Tool cancelled; no operation retried');if(!first)rejectInitial(Error('Initial tool cancelled'));}
    }catch(error){status(error.message);}
  }
  win.addEventListener('message',receive);win.addEventListener('pagehide',dispose);
  const ready=request('ui/initialize',{appInfo:{name:'ic-workbench-'+kind,version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline','fullscreen']},protocolVersion:MCP_UI_PROTOCOL},initializeTimeout).then(result=>{
    if(!object(result)||result.protocolVersion!==MCP_UI_PROTOCOL||!object(result.hostCapabilities))throw Error('Unsupported MCP Apps initialize response');
    capabilities=snapshot(result.hostCapabilities);initialized=true;
    // Complete handshake before theme/layout/resource/module work (host timeout is ~5s).
    send({method:'ui/notifications/initialized',params:{}});
    applyContext(result.hostContext||{});
    if(win.ResizeObserver&&win.document?.body){let last='';resizeObserver=new win.ResizeObserver(()=>{if(closed)return;const width=Math.ceil(win.document.body.scrollWidth),height=Math.ceil(win.document.body.scrollHeight),key=width+':'+height;if(key!==last){last=key;send({method:'ui/notifications/size-changed',params:{width,height}});}});resizeObserver.observe(win.document.body);}
    return result;
  }).catch(error=>{status(error.message);rejectInitial(error);throw error;});ready.catch(()=>{});
  function availableModes(){return (hostContext.availableDisplayModes||[]).filter(mode=>['inline','fullscreen'].includes(mode));}
  async function rawCall(name,args){
    await ready;await initialReady;
    if(!capabilities.serverTools)throw Error('Host does not support server tool calls');
    if(!/^ic_[a-z0-9_]+$/.test(name)||!object(args))throw Error('Invalid finite tool request');
    return unwrapToolResult(await request('tools/call',{name,arguments:args},name==='ic_request_review'?135000:requestTimeout));
  }
  function registerChild(value){
    const view=descriptor(value);
    if(kind!=='workbench'||!view||!['schematic','waveforms','simulation'].includes(view.kind)||view.workspace_id!==current.workspace_id||view.identity?.project_id!==current.identity.project_id)throw Error('Panel does not belong to this workbench project');
    const existing=children.get(view.view_id);
    if(existing){existing.accept(view);return existing;}
    validateViewTransition(null,view,view.kind);
    const initial=snapshot(view),subscribers=new Set();let latest=initial,released=false;
    function acceptChild(data,bindRunFrom=null,notify=false){
      const next=descriptor(data);if(!next)return data;
      validateViewTransition(latest,next,initial.kind,bindRunFrom);latest=snapshot(next);
      if(notify)for(const callback of subscribers)callback(latest);
      return data;
    }
    function checkScope(args){
      if(released||closed)throw Error('Panel connection disposed');
      for(const key of ['workspace_id','view_id'])if(args[key]!==undefined&&args[key]!==initial[key])throw Error('Cross-view '+key+' rejected');
      if(args.project_id!==undefined&&args.project_id!==initial.identity.project_id)throw Error('Cross-project call rejected');
    }
    const scoped={
      get initial(){return initial;},get view(){return latest;},get capabilities(){return capabilities;},get hostContext(){return hostContext;},
      embedded:true,ready,initialReady:Promise.resolve(initial),
      async call(name,args={}){
        checkScope(args);
        if(name.endsWith('_open')||name.startsWith('ic_workbench_'))throw Error('Open panels through the workbench');
        const before=latest,bind=name==='ic_view_bind_run'&&args.expected_revision===before.revision&&args.view_id===before.view_id&&args.workspace_id===before.workspace_id&&typeof args.request_id==='string'&&!Object.hasOwn(args,'run_id')?before:null;
        const result=await rawCall(name,args);if(!released)acceptChild(result,bind);return result;
      },
      onResult(callback){subscribers.add(callback);return()=>subscribers.delete(callback);},
      onHostContext(callback){contexts.add(callback);return()=>contexts.delete(callback);},
      async updateModelContext(value){
        checkScope(value);
        if(!capabilities.updateModelContext?.structuredContent)throw Error('Host cannot accept structured model context');
        const bound={...value,workspace_id:initial.workspace_id,view_id:initial.view_id,view_revision:latest.revision,workbench_id:current.view_id};
        if(new TextEncoder().encode(JSON.stringify(bound)).length>32768)throw Error('Model context exceeds 32 KiB');
        return request('ui/update-model-context',{structuredContent:bound});
      },
      async loadLocalState(){
        const result=await scoped.call('ic_view_data',{workspace_id:latest.workspace_id,view_id:latest.view_id,revision:latest.revision,query:{kind:'snapshot'}});
        return result.payload?.text?JSON.parse(result.payload.text):null;
      },
      async saveLocalState(value){
        if(!object(value))throw Error('Panel snapshot must be an object');
        return scoped.call('ic_view_snapshot',{workspace_id:latest.workspace_id,view_id:latest.view_id,expected_revision:latest.revision,text:JSON.stringify(value)});
      },
      requestDisplayMode:mode=>host.requestDisplayMode(mode),availableDisplayModes:availableModes,
      notify:(text,options)=>status(text,options?.kind||'info'),
      dispose(){released=true;subscribers.clear();children.delete(initial.view_id);},
    };
    const entry={accept:acceptChild,host:Object.freeze(scoped)};children.set(view.view_id,entry);return entry;
  }
  const host={
    get initial(){return first;},get view(){return current;},get toolInput(){return input;},get capabilities(){return capabilities;},get hostContext(){return hostContext;},
    ready,initialReady,
    async call(name,args={}){await ready;await initialReady;if(!capabilities.serverTools)throw Error('Host does not support server tool calls');if(!/^ic_[a-z0-9_]+$/.test(name)||!object(args))throw Error('Invalid finite tool request');checkIdentity(args);
      const before=current,bindRunFrom=name==='ic_view_bind_run'&&args.expected_revision===before.revision&&args.view_id===before.view_id&&args.workspace_id===before.workspace_id&&typeof args.request_id==='string'&&args.request_id&&!Object.hasOwn(args,'run_id')?before:null;
      const result=unwrapToolResult(await request('tools/call',{name,arguments:args},name==='ic_request_review'?135000:requestTimeout));accept(result,{notify:false,bindRunFrom});return result;},
    onResult(callback){results.add(callback);return()=>results.delete(callback);},onInput(callback){inputs.add(callback);return()=>inputs.delete(callback);},onHostContext(callback){contexts.add(callback);return()=>contexts.delete(callback);},
    async updateModelContext(value){await ready;await initialReady;if(!capabilities.updateModelContext?.structuredContent)throw Error('Host cannot accept structured model context');if(!object(value))throw Error('Model context must be an object');checkIdentity(value);const bound={...value,workspace_id:current.workspace_id,view_id:current.view_id,view_revision:current.revision};if(new TextEncoder().encode(JSON.stringify(bound)).length>32768)throw Error('Model context exceeds 32 KiB');return request('ui/update-model-context',{structuredContent:bound});},
    async requestDisplayMode(mode){await ready;if(!availableModes().includes(mode))return {mode:hostContext.displayMode||'inline',supported:false};const result=await request('ui/request-display-mode',{mode});if(!['inline','fullscreen','pip'].includes(result?.mode))throw Error('Invalid display mode response');applyContext({displayMode:result.mode});return {...result,supported:true};},
    async readResource(uri){await ready;await initialReady;if(!capabilities.serverResources)throw Error('Host does not support resource reads');if(typeof uri!=='string'||!/^ui:\/\/ic-workbench\//.test(uri))throw Error('Resource URI outside IC Workbench');const result=await request('resources/read',{uri});if(!Array.isArray(result?.contents)||result.contents.some(c=>c.uri!==uri))throw Error('Resource identity mismatch');return result;},
    availableDisplayModes:availableModes,notify:(text,options)=>status(text,options?.kind||'info'),
    async openPanel(panelKind,args={}){
      await initialReady;
      if(kind!=='workbench'||!['schematic','waveforms','simulation'].includes(panelKind)||!object(args)||Object.keys(args).some(k=>!['configuration','run_id','source_commit','path'].includes(k)))throw Error('Invalid workbench panel request');
      const value=await rawCall('ic_'+panelKind+'_open',{...args,project_id:current.identity.project_id,workspace_id:current.workspace_id});
      const entry=registerChild(value);return entry.host.view;
    },
    async getPanel(id){
      await initialReady;if(kind!=='workbench'||typeof id!=='string'||!/^v_[a-f0-9]{32}$/.test(id))throw Error('Invalid panel identity');
      const value=await rawCall('ic_view_get',{workspace_id:current.workspace_id,view_id:id});return registerChild(value).host.view;
    },
    componentHost(view){return registerChild(view).host;},
    setDisposer(callback){disposeUI=callback;},dispose,
  };
  return Object.freeze(host);
}
