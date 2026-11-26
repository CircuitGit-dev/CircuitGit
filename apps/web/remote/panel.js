import {createAssistanceQueue} from '../ai/assistance.js';
import {createNodeClient} from './client.js';
import {pairLocal,saveSessionGrant,loadSessionGrant,clearSessionGrant} from './pair.js';
import {mount as mountAI} from '../studio/ai/index.js';

const REPO='https://github.com/CircuitGit-dev/CircuitGit';
const DOCS=REPO+'/blob/main/docs/remote-node.md';

/** Deduplicate runtime project entries already represented by a Git-backed library cell. */
export function visibleCatalogProjects(list) {
  if (!Array.isArray(list)) throw Error('助手返回的工程目录无效。');
  const seen = new Set(), shadowedRuntime = new Set();
  for (const p of list) {
    if (typeof p?.id !== 'string' || !p.id || seen.has(p.id)) throw Error('返回的工程列表无效。');
    seen.add(p.id);
    if (p.id.startsWith('library:') && typeof p.runtime_project_id === 'string' && p.runtime_project_id) {
      shadowedRuntime.add(p.runtime_project_id);
    }
  }
  return list.filter(p => p.id.startsWith('library:') || !shadowedRuntime.has(p.id));
}

function libraryEntryScore(item) {
  const cell = String(item.cell_id || item.id.split('/')[1] || '');
  let score = 0;
  if (item.runtime_project_id) score += 100;
  if (item.can_simulate) score += 40;
  if (/^TB_PIPE/i.test(cell)) score += 35;
  else if (/^TB_/i.test(cell)) score += 20;
  if (/CA4_RS9|RS9_N06/i.test(cell)) score += 15;
  if (/_TOP_|^L3_/i.test(cell)) score += 12;
  return score;
}

/** Present multi-cell hierarchical circuit libraries as unified Projects rather than flat sub-modules. */
export function projectCatalogEntries(list) {
  const deduped = visibleCatalogProjects(list);
  const libraryGroups = new Map();
  const order = [];
  for (const item of deduped) {
    if (item.id.startsWith('library:')) {
      const [libId, cellId] = item.id.slice(8).split('/');
      const key = item.library_id || libId;
      if (!libraryGroups.has(key)) {
        libraryGroups.set(key, []);
        order.push({ kind: 'library-group', key });
      }
      libraryGroups.get(key).push({ ...item, library_id: key, cell_id: item.cell_id || cellId });
    } else {
      order.push({ kind: 'standalone', item });
    }
  }
  const result = [];
  for (const slot of order) {
    if (slot.kind === 'standalone') {
      result.push(slot.item);
      continue;
    }
    const items = libraryGroups.get(slot.key);
    if (items.length <= 2 || slot.key === 'basics') {
      for (const item of items) result.push(item);
      continue;
    }
    const sorted = [...items].sort((a, b) => libraryEntryScore(b) - libraryEntryScore(a) || a.id.localeCompare(b.id));
    const rep = sorted[0];
    const libName = String(rep.name || '').includes(' / ') ? String(rep.name).split(' / ')[0] : slot.key;
    result.push({
      ...rep,
      name: `${libName}（整项目 · ${items.length} 模块 · 顶层 ${rep.cell_id}）`,
      project_group: true,
      module_count: items.length,
    });
  }
  return result;
}

/** Remote chat owns its context; the public preview never supplies an engineering identity. */
export function mountRemoteNode(host) {
  const parent=host.slots.ai,doc=parent.element.ownerDocument,win=doc.defaultView;
  const css=doc.createElement('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url);doc.head.append(css);
  const platformText=String(win.navigator?.userAgentData?.platform||win.navigator?.platform||win.navigator?.userAgent||'');
  const isWindows=/win/i.test(platformText);
  const oneLineInstall=isWindows
    ? "$env:CIRCUITGIT_AUTOSTART='1'; irm https://circuitgit-dev.github.io/CircuitGit/install.ps1 | iex"
    : "curl -fsSL https://circuitgit-dev.github.io/CircuitGit/install.sh | CIRCUITGIT_AUTOSTART=1 bash";
  const root=doc.createElement('section');root.className='cg-remote';root.setAttribute('aria-label','连接 Codex');
  root.innerHTML=`<div class="cg-node-welcome">
    <strong>使用你的 Codex</strong><p>在本机确认授权后，自动检查 Codex 登录状态。无需填写地址或访问码。</p>
    <button class="cg-primary" type="button" data-action="local">连接本机 Codex</button>
    <details class="cg-node-setup"><summary>首次使用？一键安装本机连接器（仅需一次）</summary>
      <p>打开${isWindows?' PowerShell ':' 终端 '}粘贴运行下方命令，脚本会让你选择安装路径、自动下载并注册 <code>circuitgit://</code> 网页一键唤醒（无压缩包安全拦截弹窗）：</p>
      <pre class="cg-node-install-cmd"><code>${oneLineInstall}</code></pre>
      <small>需要 Python 3.11+ 和 Git；不会更改全局 Python 或 Codex 设置。安装完成后回来点「连接本机 Codex」即可。</small>
      <a href="${DOCS}" target="_blank" rel="noopener noreferrer">安装与后台自启说明 ↗</a>
    </details>
    <details class="cg-node-advanced"><summary>高级：连接自己的服务器</summary>
      <form class="cg-node-connect">
        <label>节点地址<input name="endpoint" type="url" placeholder="https://your-node.example" required autocomplete="off"></label>
        <label>节点访问码<input name="accessCode" type="password" placeholder="服务器生成的访问码" required autocomplete="off" spellcheck="false"></label>
        <label class="cg-consent"><input name="consent" type="checkbox" required>允许此网页访问该服务器的项目与 AI 会话</label>
        <button type="submit">授权并连接</button>
      </form>
    </details>
    <small>本机未登录时可继续前往官方登录页。无需本机助手的纯云端订阅登录尚未接入。</small>
  </div>
  <div class="cg-node-connected" hidden>
    <div class="cg-node-identity"><strong></strong><button type="button" data-action="disconnect">断开</button></div>
    <div class="cg-node-account" hidden><span></span><button type="button" data-action="login" hidden>在官方页面登录 ChatGPT</button><button type="button" data-action="account-refresh">重新检查</button></div>
    <div class="cg-node-project"><select aria-label="选择协作项目"><option value="">选择项目</option></select><button type="button" data-action="open-project">打开对话</button><button type="button" data-action="use-canvas">同步当前项目</button></div>
    <p class="cg-context-label">选择项目后自动切换画布到项目顶层原理图，AI 可协作查看与编辑项目内所有层级模块。</p>
  </div>
  <div class="cg-ai-project-bar" hidden>
    <span class="cg-ai-project-label">当前项目</span>
    <select class="cg-ai-project-select" aria-label="切换当前协作项目"></select>
    <button type="button" data-action="browse-projects" title="打开项目与电路库浏览层级">全部项目…</button>
  </div>
  <p class="cg-node-status" role="status" aria-live="polite"></p><div class="cg-node-chat"></div>`;
  parent.element.replaceChildren(root);
  const $=s=>root.querySelector(s),welcome=$('.cg-node-welcome'),form=$('form'),connected=$('.cg-node-connected'),status=$('.cg-node-status'),chat=$('.cg-node-chat'),projects=$('.cg-node-project select');
  const projectBar=$('.cg-ai-project-bar'),projectBarSelect=$('.cg-ai-project-select'),browseProjectsButton=$('[data-action=browse-projects]');
  const localButton=$('[data-action=local]'),openButton=$('[data-action=open-project]'),canvasButton=$('[data-action=use-canvas]'),loginButton=$('[data-action=login]');
  const initialSettings=doc.createElement('div'),initialToggle=doc.createElement('button'),initialHint=doc.createElement('span'),settingsHome=doc.createElement('div'),connectionSettings=doc.createElement('details'),connectionSummary=doc.createElement('summary');
  initialSettings.className='cg-node-initial-settings';initialToggle.type='button';initialToggle.textContent='⚙';initialToggle.setAttribute('aria-label','AI连接设置');initialToggle.setAttribute('aria-expanded','false');initialHint.textContent='在设置中连接工作台助手（Codex + 远端仿真 + 本地库）';initialSettings.append(initialToggle,initialHint);
  settingsHome.className='cg-node-settings-home';settingsHome.hidden=true;connectionSettings.className='cg-node-connection-settings';connectionSummary.textContent='连接与工程';connectionSettings.append(connectionSummary,welcome,connected,status);settingsHome.append(connectionSettings);root.insertBefore(initialSettings,chat);root.insertBefore(settingsHome,chat);
  function showConnectionSettings(){settingsHome.hidden=false;connectionSettings.open=true;initialToggle.setAttribute('aria-expanded','true');}
  initialToggle.onclick=()=>{settingsHome.hidden=!settingsHome.hidden;initialToggle.setAttribute('aria-expanded',String(!settingsHome.hidden));if(!settingsHome.hidden)connectionSettings.open=true;};
  let client=null,ai=null,epoch=0,context=null,busy=false,destroyed=false,pairing=null,loginTimer=null,accountReady=true,ownerWindow=null,ownerTimer=null,ownerResolve=null,inflightTurns=0,ownsClient=true;
  let nodeConnectionId=null,onboardingChoice=null,choiceTask=null,projectByLibraryId=new Map();
  const connListeners=new Set();
  const emitConn=()=>{const state={connected:!!client,connecting:busy&&!client,connectionId:nodeConnectionId,hasChat:!!ai};for(const fn of connListeners)try{fn(state);}catch{}};
  const pendingDrafts=createAssistanceQueue({element:root,apply:draft=>ai?.queueDraft(draft)||{status:'queued',message:'请先连接并选择现有对话；请求已保留。'},getAvailability:()=>({available:!!ai,message:!client?'尚未连接；请手动连接 Codex，仿真请求已保留。':!ai?'请选择工程并打开对话；请求已保留，不会自动新建。':'请选择或新建目标对话；请求已保留，尚未发送。'})});root.insertBefore(pendingDrafts.element,chat);
  const queueDraft=draft=>{if(ai)return ai.queueDraft(draft);showConnectionSettings();return pendingDrafts.enqueue(draft);};
  const listeners=new Set();
  const contextAdapter={getContext:()=>context&&structuredClone(context),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async readSelection(){throw Error('示例画布未绑定到本机工程，请让 AI 读取当前工程源码。');}};
  function message(text,error=false){status.textContent=text;status.dataset.error=String(error);}
  function syncProjectBar(){
    if(!projectBar||!projectBarSelect)return;
    projectBarSelect.replaceChildren(...[...projects.options].map(o=>new Option(o.textContent,o.value)));
    projectBarSelect.value=projects.value;
    projectBarSelect.disabled=busy||!accountReady||!client;
    browseProjectsButton.hidden=typeof host.openLibraryManager!=='function';
    projectBar.hidden=!client||!ai;
  }
  function setBusy(value){busy=value;localButton.disabled=value;form.querySelector('button').disabled=value;openButton.disabled=value||!accountReady;canvasButton.disabled=value||!accountReady;projects.disabled=value;syncProjectBar();}
  function checkedContext(value,id,path){
    const reject=()=>{const error=Error('未返回有效的已保存电路身份；未发送 AI 请求，请刷新连接设置。');error.data={code:'invalid_input'};throw error;};
    const file=value?.file,project=value?.project;
    if(id?.startsWith('onboarding:')){
      const selected=value?.onboarding;
      if(value?.version!==1||selected?.schema!=='ic.onboarding.context.v1'||selected.connection_id!==nodeConnectionId||
        id!=='onboarding:'+selected.intake_id||project?.id!==id||!Number.isInteger(selected.revision)||selected.revision<1||
        !/^[a-f0-9]{64}$/.test(selected.source_sha256||'')||file?.persistedSha256!==selected.source_sha256||
        file.currentTextSha256!==selected.source_sha256||file.dirty!==false||!file.path||
        file.baseCommit!==project.sourceCommit||path&&file.path!==path)reject();
      return value;
    }
    if(value?.version!==1||project?.id!==id||typeof file?.path!=='string'||!file.path||
       !/^[a-f0-9]{40,64}$/.test(project?.sourceCommit||'')||!/^[a-f0-9]{64}$/.test(file.persistedSha256||'')||
       file.currentTextSha256!==file.persistedSha256||file.dirty!==false||path&&file.path!==path)reject();
    if(id.startsWith('library:')){
      const parts=id.slice(8).split('/');
      if(parts.length!==2||parts.some(part=>!part)||value.library?.library_id!==parts[0]||value.library?.cell_id!==parts[1]||
         file.baseCommit!==project.sourceCommit)reject();
    }else if(value.library)reject();
    return value;
  }
  function canvasProject(){
    if(onboardingChoice)return onboardingChoice.project.id;
    const p=host.context?.getContext?.()?.project;
    if(p?.libraryId&&p?.cellId){
      const exact='library:'+p.libraryId+'/'+p.cellId;
      if([...projects.options].some(o=>o.value===exact))return exact;
      if(projectByLibraryId.has(p.libraryId))return projectByLibraryId.get(p.libraryId);
      return exact;
    }
    return !p||p.id==='rc-demo'?'library:basics/rc-smoke':null;
  }
  function drop(){for(const draft of ai?.takePendingDrafts?.()||[])pendingDrafts.enqueue(draft);++epoch;const prev=client,owned=ownsClient;host.libraryBridge?.unbind();if(prev){if(!host.onboarding?.unbindClient(prev)&&!owned)host.onboarding?.disconnect?.();}nodeConnectionId=null;onboardingChoice=null;pairing?.cancel();pairing=null;clearTimeout(loginTimer);clearInterval(ownerTimer);ownerTimer=null;ownerWindow?.close();ownerWindow=null;ownerResolve?.();ownerResolve=null;if(owned)prev?.close();client=null;ownsClient=true;ai?.destroy();ai=null;projectBar.hidden=true;settingsHome.append(connectionSettings);initialSettings.hidden=false;context=null;listeners.clear();chat.replaceChildren();parent.setBadge(null);pendingDrafts.render();emitConn();}
  async function refreshOnboardingChoice(){
    if(choiceTask)return choiceTask;
    const generation=epoch;
    choiceTask=(async()=>{
      const selected=nodeConnectionId?await host.onboardingSync?.contextFor({connectionId:nodeConnectionId}):null;
      if(generation!==epoch||destroyed)return;
      onboardingChoice=selected||null;
      const previous=projects.value;
      for(const option of [...projects.options])if(option.value.startsWith('onboarding:'))option.remove();
      if(selected){
        projects.add(new Option('当前网表 · '+selected.file.path,selected.project.id));
        if(!previous||previous.startsWith('onboarding:'))projects.value=selected.project.id;
      }
    })();
    try{return await choiceTask;}finally{choiceTask=null;}
  }
  const offOnboarding=host.onboardingSync?.subscribe(()=>void refreshOnboardingChoice().catch(()=>{}));
  const offCanvas=host.context?.subscribe(()=>void refreshOnboardingChoice().catch(()=>{}));
  function disconnect(){
    clearSessionGrant(win.sessionStorage);
    drop();setBusy(false);welcome.hidden=false;connected.hidden=true;$('.cg-node-account').hidden=true;$('.cg-node-project').hidden=false;
    projects.disabled=false;projects.title='';openButton.disabled=false;openButton.textContent='打开对话';
    projects.replaceChildren(new Option('选择工程',''));form.elements.accessCode.value='';
    showConnectionSettings();
    message('已断开。失去心跳的 AI 回合会由助手暂停；已提交的仿真不会因此取消。未自动重发或批准。');
  }
  $('[data-action=disconnect]').onclick=disconnect;

  async function refreshAccount(generation=epoch) {
    const result=await client.request('/ai/auth/status');if(generation!==epoch||destroyed)return null;
    const account=result.account||{};const signedOut=account.login_status==='signed_out';
    accountReady=!signedOut;openButton.disabled=busy||!accountReady;canvasButton.disabled=busy||!accountReady;
    loginButton.hidden=!result.can_login;loginButton.disabled=result.login_state==='pending';
    const label=account.account_type==='chatgpt'||account.account_type==='chatgptAuthTokens'
      ? 'Codex 已登录 · '+(account.plan_type==='unknown'?'订阅类型未报告':account.plan_type)
      : signedOut?'Codex 尚未登录'
      : account.requires_openai_auth===false?'使用本机已配置的模型服务 · 订阅信息未报告'
      : account.login_status==='signed_in'?'使用本机已有登录':'登录状态未报告，可在 Codex 应用中核对';
    $('.cg-node-account span').textContent=label;
    return result;
  }

  async function finishConnect(candidate,info,generation,local=false,owned=true){
    client=candidate;ownsClient=owned;
    if(info?.schema!=='circuitgit.remote-node.v1'||info.single_owner!==true||info.auth!=='bearer'||!info.capabilities?.chat)throw Error('未找到兼容的 CircuitGit 连接服务。');
    nodeConnectionId=info.connection_id||null;
    if(info.capabilities.simulation_onboarding===true&&!host.onboarding?.getState().connected){
      await host.onboarding?.bindClient(client,info);
      if(generation!==epoch||destroyed)return;
    }
    host.libraryBridge?.bind(client,{supported:local&&info.capabilities.library_workflow===true});
    const catalog=await client.request('/ai/catalog');if(generation!==epoch||destroyed)return;
    const visibleProjects=projectCatalogEntries(catalog.projects);
    const seen=new Set(visibleProjects.map(p=>p.id));
    projectByLibraryId=new Map();
    projects.replaceChildren(new Option('选择项目',''));
    for(const p of visibleProjects){
      if(p.id.startsWith('library:')&&p.library_id&&!projectByLibraryId.has(p.library_id))projectByLibraryId.set(p.library_id,p.id);
      projects.add(new Option(p.name||p.id,p.id));
    }
    await refreshOnboardingChoice();if(generation!==epoch||destroyed)return;
    const preferred=canvasProject();
    if(onboardingChoice)projects.value=onboardingChoice.project.id;else if(seen.has(preferred))projects.value=preferred;else if(visibleProjects.length===1)projects.value=visibleProjects[0].id;
    $('.cg-node-identity strong').textContent=local?'本机 Codex · 统一助手':info.name||'CircuitGit server';
    form.elements.accessCode.value='';welcome.hidden=true;connected.hidden=false;accountReady=true;emitConn();
    if(local&&info.capabilities.local_login){
      $('.cg-node-account').hidden=false;message('已授权，正在检查本机 Codex 登录状态…');
      try{await refreshAccount(generation);}catch(error){if(generation===epoch&&!destroyed){accountReady=false;openButton.disabled=true;message(error.message,true);return;}}
      if(generation!==epoch||destroyed)return;
    }
    message(accountReady?'已连接（AI / 远端仿真 / 本地库共用）。选择工程后打开对话。':'请在官方页面完成登录，然后继续。');pendingDrafts.render();
    if(accountReady&&projects.value&&!ai&&!pendingDrafts.count){
      void Promise.resolve().then(()=>{if(generation===epoch&&!destroyed&&accountReady&&projects.value&&!ai&&!busy)return openButton.onclick();});
    }
  }
  async function connect(url,code,generation,local=false){
    const candidate=createNodeClient({url,accessCode:code,onUnauthorized:()=>{
      if(generation!==epoch||destroyed)return;disconnect();message('连接授权已失效，请重新授权。未自动重发操作。',true);
    }});
    client=candidate;ownsClient=true;
    const info=await client.request('/node/info');if(generation!==epoch||destroyed)return;
    if(local)saveSessionGrant({url,accessCode:code},win.sessionStorage);
    await finishConnect(candidate,info,generation,local,true);
  }
  async function tryResumeSession(){
    if(destroyed||busy||client)return false;
    const grant=loadSessionGrant(win.sessionStorage);
    if(!grant)return false;
    const generation=epoch;setBusy(true);emitConn();
    try{
      await connect(grant.url,grant.accessCode,generation,true);
      return true;
    }catch{
      clearSessionGrant(win.sessionStorage);
      if(generation===epoch&&!destroyed){drop();welcome.hidden=false;connected.hidden=true;message('');}
      return false;
    }finally{if(generation===epoch&&!destroyed){setBusy(false);emitConn();}}
  }
  async function adoptClient(candidate,info,{local=true}={}){
    if(destroyed||!candidate||!info?.capabilities?.chat)return false;
    if(client===candidate)return true;
    if(busy||client)return false;
    drop();const generation=epoch;setBusy(true);emitConn();
    try{await finishConnect(candidate,info,generation,local,false);return true;}
    catch(error){if(generation===epoch&&!destroyed){client=null;ownsClient=true;message(error.message,true);emitConn();}return false;}
    finally{if(generation===epoch&&!destroyed){setBusy(false);emitConn();}}
  }

  localButton.onclick=async()=>{
    if(busy||destroyed)return;drop();const generation=epoch;setBusy(true);message('正在连接本机助手…');
    try{
      pairing=pairLocal({win,onReady:()=>message('请在弹出的本机窗口点击“允许并连接”。')});
      const receipt=await pairing.result;pairing=null;if(generation!==epoch||destroyed)return;
      await connect(receipt.url,receipt.accessCode,generation,true);
    }catch(error){if(generation===epoch&&!destroyed){disconnect();$('.cg-node-setup').open=true;message(error.message,true);}}
    finally{if(generation===epoch&&!destroyed)setBusy(false);}
  };
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||destroyed||!form.reportValidity())return;
    drop();const generation=epoch;setBusy(true);message('正在连接服务器…');
    try{await connect(form.elements.endpoint.value.trim(),form.elements.accessCode.value.trim(),generation);}
    catch(error){if(generation===epoch&&!destroyed){disconnect();message(error.message,true);}}
    finally{if(generation===epoch&&!destroyed)setBusy(false);}
  });
  $('[data-action=account-refresh]').onclick=()=>refreshAccount().catch(e=>message(e.message,true));
  loginButton.onclick=async()=>{
    if(busy||destroyed||!client)return;
    const popup=win.open('about:blank','_blank');
    if(!popup){message('请允许弹出官方登录窗口后重试。',true);return;}
    popup.opener=null;const generation=epoch;loginButton.disabled=true;
    try{
      const result=await client.request('/ai/auth/login',{method:'POST',body:{}});if(generation!==epoch||destroyed){popup.close();return;}
      const url=new URL(result.auth_url);
      if(url.protocol!=='https:'||!['auth.openai.com','chatgpt.com'].includes(url.hostname)||url.username||url.password||url.port)throw Error('未返回可验证的官方登录地址。');
      popup.location.replace(url.href);message('请在官方页面完成登录；账号凭据保留在本机。');
      const deadline=Date.now()+180000;
      async function poll(){
        if(generation!==epoch||destroyed)return;
        try{
          const state=await refreshAccount(generation);if(!state)return;
          if(state.login_id!==result.login_id)throw Error('登录回执不匹配，请在 Codex 应用中核对。');
          if(state.login_state==='complete'){message('官方登录已完成，可以打开工程对话。');return;}
          if(state.login_state==='failed')throw Error('官方登录未完成，请检查原登录页面。');
          if(Date.now()>deadline)throw Error('仍未收到登录完成回执。可完成原登录页后点击“重新检查”，不会自动发起新登录。');
          loginTimer=setTimeout(poll,1500);
        }catch(error){if(generation===epoch&&!destroyed)message(error.message,true);}
      }
      loginTimer=setTimeout(poll,1500);
    }catch(error){popup.close();if(generation===epoch&&!destroyed)message(error.message,true);}
  };

  async function prepareAiContext(current){
    const selected=await host.onboardingSync?.contextFor({connectionId:nodeConnectionId,refresh:true});
    if(current?.onboarding&&!selected)throw Error('当前网表已变化，请重新选择后发送。');
    if(!selected||!current||current.file?.persistedSha256!==selected.file.persistedSha256)return current;
    if(busy||destroyed||!client)throw Error('连接或电路正在切换，未发送旧回合。');
    context=selected;for(const listener of listeners)listener(structuredClone(context));
    return selected;
  }

  openButton.onclick=async()=>{
    if(!client||!projects.value||busy||!accountReady)return;
    const generation=epoch,id=projects.value;setBusy(true);openButton.disabled=true;message('正在切换项目并读取顶层版本…');
    try{
      if(inflightTurns||['starting','running'].includes(ai?.getState()?.phase))throw Error('当前回合仍在执行，请完成或停止后切换项目。');
      const active=await client.request('/ai/sessions');if(generation!==epoch||destroyed)return;
      if(!Array.isArray(active?.sessions))throw Error('无法确认对话状态，请重新读取后切换项目。');
      if(context&&active.sessions.some(row=>['running','starting'].includes(row.state)))throw Error('当前回合仍在执行，请完成或停止后切换项目。');
      if(!ai&&active.sessions.length===0){
        await client.request('/ai/sessions',{method:'POST',body:{name:'新对话'}});
        if(generation!==epoch||destroyed)return;
      }
      const next=id.startsWith('onboarding:')?await host.onboardingSync.contextFor({connectionId:nodeConnectionId,required:true}):await client.request('/ai/context?project_id='+encodeURIComponent(id));if(generation!==epoch||destroyed)return;
      checkedContext(next,id);
      context={...next,revision:(context?.revision||0)+1,mode:'live'};
      for(const listener of listeners)listener(structuredClone(context));
      const slot={...parent,element:chat,setVisible:value=>parent.setVisible(value),isVisible:()=>parent.isVisible(),setBadge:value=>parent.setBadge(value),toggle:()=>parent.toggle()};
      const onSessionsChanged=({count,loading})=>{if(loading)return;initialSettings.hidden=count>0;if(!count){settingsHome.append(connectionSettings);initialHint.textContent='连接设置';settingsHome.hidden=true;initialToggle.setAttribute('aria-expanded','false');}else settingsHome.hidden=true;};
      if(!ai)ai=mountAI({...host,agentAssistance:null,context:contextAdapter,prepareAiContext,aiSettings:{element:connectionSettings,configureDevelopment,onSessionsChanged},slots:{...host.slots,ai:slot},gateway:{request:requestAI}});
      for(const draft of pendingDrafts.take())ai.queueDraft(draft);
      const selectedLabel=projects.selectedOptions?.[0]?.textContent||id;
      $('.cg-context-label').textContent=next.onboarding?'AI 与仿真面板共用网表：'+next.file.path:`当前协作项目：${selectedLabel} · ${next.project.sourceCommit.slice(0,8)}`+(next.library?' · 画布已同步到项目顶层原理图，AI 可读写项目内全部模块。':' · 使用已配置的节点工程。');
      projects.disabled=false;openButton.textContent='切换 / 刷新项目';projects.title='新回合使用这里选定的项目';
      $('.cg-node-project').hidden=false;settingsHome.hidden=true;connectionSettings.open=false;message('');syncProjectBar();
      if(next.library&&typeof host.openProjectCanvas==='function'){
        void Promise.resolve(host.openProjectCanvas({projectId:id,libraryId:next.library.library_id,cellId:next.library.cell_id})).catch(err=>host.notify?.('原理图切换提示：'+(err?.message||err),{kind:'warning'}));
      }
    }catch(error){if(generation===epoch&&!destroyed){if(context)projects.value=context.project.id;syncProjectBar();message(error.message,true);}}
    finally{if(generation===epoch&&!destroyed){setBusy(false);openButton.disabled=!accountReady;syncProjectBar();}}
  };
  projects.addEventListener('change',()=>{if(client&&accountReady&&!busy&&projects.value)void openButton.onclick();});
  projectBarSelect.addEventListener('change',()=>{if(client&&accountReady&&!busy&&projectBarSelect.value){projects.value=projectBarSelect.value;void openButton.onclick();}});
  browseProjectsButton.onclick=()=>{host.openLibraryManager?.();};
  canvasButton.onclick=async()=>{
    if(busy||destroyed||!client||!accountReady)return;
    const generation=epoch;let id=canvasProject();
    try{
      if(!id||![...projects.options].some(option=>option.value===id)){
        if(inflightTurns||['starting','running'].includes(ai?.getState()?.phase))throw Error('当前回合仍在执行，请完成或停止后切换电路。');
        setBusy(true);
        if(context){const active=await client.request('/ai/sessions');if(generation!==epoch||destroyed)return;if(!Array.isArray(active?.sessions)||active.sessions.some(row=>['starting','running'].includes(row.state)))throw Error('请先完成或停止当前回合，再导入另一份网表。');}
        const source=await host.getOnboardingSource?.(),state=host.onboarding?.getState();
        if(!source||!state?.connected||state.storeIdentity!==nodeConnectionId)throw Error('请先连接同一个仿真助手并打开当前网表。');
        setBusy(true);message('正在将当前网表导入独立仿真会话…');
        await host.onboarding.inspectNetlist(source);if(generation!==epoch||destroyed)return;
        await refreshOnboardingChoice();id=onboardingChoice?.project.id;
        if(!id)throw Error('网表已变化，请重新选择当前源。');
      }
      projects.value=id;setBusy(false);await openButton.onclick();
    }catch(error){if(generation===epoch&&!destroyed)message(error.message,true);}
    finally{if(generation===epoch&&!destroyed)setBusy(false);}
  };
  async function requestAI(path,options){
    if(!client)throw Error('连接已断开。');
    if(path!=='/ai/turn')return client.request(path,options);
    ++inflightTurns;
    try{
      const generation=epoch,old=options?.body?.context,id=context?.project?.id;
      checkedContext(old,id||'');
      if(old?.onboarding){
        if(busy||id!=='onboarding:'+old.onboarding.intake_id)throw Error('当前网表正在切换，请重新选择后发送。');
        const fresh=await host.onboardingSync.contextFor({connectionId:nodeConnectionId,required:true});
        checkedContext(fresh,id,old.file.path);
        if(generation!==epoch||destroyed||busy||context?.project?.id!==id||fresh.onboarding.source_sha256!==old.onboarding.source_sha256)throw Error('网表已变化，未发送旧回合。');
        context=fresh;for(const listener of listeners)listener(structuredClone(context));
        return await client.request(path,{...options,body:{...options.body,context:structuredClone(context)}});
      }
      if(!id||busy||old.revision!==context.revision){const error=Error('电路正在切换，请确认当前电路后重新发送。');error.data={code:'invalid_input'};throw error;}
      if(!id.startsWith('library:'))return await client.request(path,options);
      const fresh=await client.request('/ai/context?project_id='+encodeURIComponent(id)+'&path='+encodeURIComponent(old.file.path));
      if(generation!==epoch||destroyed||busy||context?.project.id!==id||context.revision!==old.revision){const error=Error('电路已切换，请在当前电路重新发送。');error.data={code:'invalid_input'};throw error;}
      checkedContext(fresh,id,old.file.path);
      // This refresh belongs to the turn whose panel already captured revision.
      // Incrementing it here would invalidate that same new turn's approvals.
      context={...fresh,revision:old.revision,mode:'live'};for(const listener of listeners)listener(structuredClone(context));
      options={...options,body:{...options.body,context:structuredClone(context)}};
      return await client.request(path,options);
    }finally{--inflightTurns;}
  }
  async function configureDevelopment(){
    if(!client||destroyed)throw Error('请先连接本机助手。');
    if(ownerWindow&&!ownerWindow.closed){ownerWindow.focus();return;}
    const popup=win.open('about:blank','_blank');if(!popup)throw Error('请允许弹出本机设置窗口。');popup.opener=null;
    const generation=epoch;ownerWindow=popup;
    try{const receipt=await client.request('/ai/development/settings-request',{method:'POST',body:{}}),url=new URL(receipt.url),base=new URL(client.base);
      if(generation!==epoch||destroyed){popup.close();return;}
      if(url.origin!==base.origin||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.hash||url.pathname!=='/development/settings'||url.searchParams.getAll('request').length!==1||!url.searchParams.get('request')||[...url.searchParams.keys()].some(key=>key!=='request'))throw Error('本机设置地址不匹配。');
      popup.location.replace(url.href);message('请在本机设置窗口选择工作目录和访问权限；关闭窗口后自动重新读取。');
      await new Promise(resolve=>{ownerResolve=resolve;const deadline=Date.now()+300000;ownerTimer=setInterval(()=>{if(popup.closed||generation!==epoch||Date.now()>deadline){clearInterval(ownerTimer);ownerTimer=null;ownerWindow=null;ownerResolve=null;resolve();}},400);});
    }catch(error){popup.close();ownerWindow=null;throw error;}
  }
  async function syncProjectFromCanvas(libraryId) {
    if (destroyed || !client || !accountReady || busy || !libraryId) return false;
    if (inflightTurns || ['starting', 'running'].includes(ai?.getState()?.phase)) return false;
    const targetId = projectByLibraryId.get(libraryId);
    if (!targetId || context?.project?.id === targetId) return false;
    projects.value = targetId;
    await openButton.onclick();
    return context?.project?.id === targetId;
  }
  const off=host.registerCommand({id:'ai.remote.connect',menu:'window',label:'连接 Codex',run:()=>{parent.setVisible(true);if(!context){showConnectionSettings();(connected.hidden?localButton:openButton).focus();}else ai?.show();}});
  const offAssistance=host.agentAssistance?.registerReceiver(queueDraft);
  return {queueDraft,takePendingDrafts:()=>[...pendingDrafts.take(),...(ai?.takePendingDrafts?.()||[])],adoptClient,tryResumeSession,syncProjectFromCanvas,connectLocal:()=>{parent.setVisible(true);showConnectionSettings();return localButton.onclick();},disconnect,getConnectionState:()=>({connected:!!client,connecting:busy&&!client,connectionId:nodeConnectionId,hasChat:!!ai}),subscribeConnection(fn){connListeners.add(fn);return()=>connListeners.delete(fn);},destroy(){if(destroyed)return;destroyed=true;connListeners.clear();offAssistance?.();offOnboarding?.();offCanvas?.();drop();pendingDrafts.destroy();off?.();css.remove();root.remove();}};
}
