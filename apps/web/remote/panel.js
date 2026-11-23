import {createNodeClient} from './client.js';
import {pairLocal} from './pair.js';
import {mount as mountAI} from '../studio/ai/index.js';

const REPO='https://github.com/joshuazeng713/CircuitGit';
const DOCS=REPO+'/blob/main/docs/remote-node.md';

/** Remote chat owns its context; the public preview never supplies an engineering identity. */
export function mountRemoteNode(host) {
  const parent=host.slots.ai,doc=parent.element.ownerDocument,win=doc.defaultView;
  const css=doc.createElement('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url);doc.head.append(css);
  const root=doc.createElement('section');root.className='cg-remote';root.setAttribute('aria-label','连接 Codex');
  root.innerHTML=`<div class="cg-node-welcome">
    <strong>使用你的 Codex</strong><p>在本机确认授权后，自动检查 Codex 登录状态。无需填写地址或访问码。</p>
    <button class="cg-primary" type="button" data-action="local">连接本机 Codex</button>
    <details class="cg-node-setup"><summary>首次使用？启动连接助手</summary>
      <p>网页需要一个本机连接助手，才能与已安装的 Codex 通信。首次下载后双击 <b>Start CircuitGit.command</b>；保持助手运行，然后回来点击连接。</p>
      <a href="${REPO}/archive/refs/heads/main.zip" target="_blank" rel="noopener noreferrer">下载项目包（含 macOS 双击启动器） ↗</a>
      <small>启动器需要 Python 3.10+ 和 Git；不会自动安装软件或更改 Codex 设置。仅打开 Codex 应用不会启动连接助手。</small>
      <a href="${DOCS}" target="_blank" rel="noopener noreferrer">其他系统与安装说明 ↗</a>
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
    <div class="cg-node-project"><select aria-label="运行节点项目"><option value="">选择工程</option></select><button type="button" data-action="open-project">打开对话</button></div>
    <p class="cg-context-label">画布是公开电路预览，AI 使用此处选定的节点工程。</p>
  </div>
  <p class="cg-node-status" role="status" aria-live="polite"></p><div class="cg-node-chat"></div>`;
  parent.element.replaceChildren(root);
  const $=s=>root.querySelector(s),welcome=$('.cg-node-welcome'),form=$('form'),connected=$('.cg-node-connected'),status=$('.cg-node-status'),chat=$('.cg-node-chat'),projects=$('select');
  const localButton=$('[data-action=local]'),openButton=$('[data-action=open-project]'),loginButton=$('[data-action=login]');
  const initialSettings=doc.createElement('div'),initialToggle=doc.createElement('button'),initialHint=doc.createElement('span'),settingsHome=doc.createElement('div'),connectionSettings=doc.createElement('details'),connectionSummary=doc.createElement('summary');
  initialSettings.className='cg-node-initial-settings';initialToggle.type='button';initialToggle.textContent='⚙';initialToggle.setAttribute('aria-label','AI连接设置');initialToggle.setAttribute('aria-expanded','false');initialHint.textContent='在设置中连接你的 Codex';initialSettings.append(initialToggle,initialHint);
  settingsHome.className='cg-node-settings-home';settingsHome.hidden=true;connectionSettings.className='cg-node-connection-settings';connectionSummary.textContent='连接与工程';connectionSettings.append(connectionSummary,welcome,connected,status);settingsHome.append(connectionSettings);root.insertBefore(initialSettings,chat);root.insertBefore(settingsHome,chat);
  function showConnectionSettings(){settingsHome.hidden=false;connectionSettings.open=true;initialToggle.setAttribute('aria-expanded','true');}
  initialToggle.onclick=()=>{settingsHome.hidden=!settingsHome.hidden;initialToggle.setAttribute('aria-expanded',String(!settingsHome.hidden));if(!settingsHome.hidden)connectionSettings.open=true;};
  let client=null,ai=null,epoch=0,context=null,busy=false,destroyed=false,pairing=null,loginTimer=null,accountReady=true,ownerWindow=null,ownerTimer=null,ownerResolve=null;
  const listeners=new Set();
  const contextAdapter={getContext:()=>context&&structuredClone(context),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async readSelection(){throw Error('示例画布未绑定到本机工程，请让 AI 读取当前工程源码。');}};
  function message(text,error=false){status.textContent=text;status.dataset.error=String(error);}
  function setBusy(value){busy=value;localButton.disabled=value;form.querySelector('button').disabled=value;openButton.disabled=value||!!context||!accountReady;}
  function drop(){++epoch;pairing?.cancel();pairing=null;clearTimeout(loginTimer);clearInterval(ownerTimer);ownerTimer=null;ownerWindow?.close();ownerWindow=null;ownerResolve?.();ownerResolve=null;client?.close();client=null;ai?.destroy();ai=null;settingsHome.append(connectionSettings);initialSettings.hidden=false;context=null;listeners.clear();chat.replaceChildren();parent.setBadge(null);}
  function disconnect(){
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
    accountReady=!signedOut;openButton.disabled=busy||!!context||!accountReady;
    loginButton.hidden=!result.can_login;loginButton.disabled=result.login_state==='pending';
    const label=account.account_type==='chatgpt'||account.account_type==='chatgptAuthTokens'
      ? 'Codex 已登录 · '+(account.plan_type==='unknown'?'订阅类型未报告':account.plan_type)
      : signedOut?'Codex 尚未登录'
      : account.requires_openai_auth===false?'使用本机已配置的模型服务 · 订阅信息未报告'
      : account.login_status==='signed_in'?'使用本机已有登录':'登录状态未报告，可在 Codex 应用中核对';
    $('.cg-node-account span').textContent=label;
    return result;
  }

  async function connect(url,code,generation,local=false){
    client=createNodeClient({url,accessCode:code,onUnauthorized:()=>{
      if(generation!==epoch||destroyed)return;disconnect();message('连接授权已失效，请重新授权。未自动重发操作。',true);
    }});
    const info=await client.request('/node/info');if(generation!==epoch||destroyed)return;
    if(info?.schema!=='circuitgit.remote-node.v1'||info.single_owner!==true||info.auth!=='bearer'||!info.capabilities?.chat)throw Error('未找到兼容的 CircuitGit 连接服务。');
    const catalog=await client.request('/ai/catalog');if(generation!==epoch||destroyed)return;
    if(!Array.isArray(catalog.projects)||!catalog.projects.length)throw Error('助手尚未配置可用工程。');
    const seen=new Set();projects.replaceChildren(new Option('选择工程',''));
    for(const p of catalog.projects){if(typeof p.id!=='string'||!p.id||seen.has(p.id))throw Error('返回的工程列表无效。');seen.add(p.id);projects.add(new Option(p.name||p.id,p.id));}
    if(catalog.projects.length===1)projects.value=catalog.projects[0].id;
    $('.cg-node-identity strong').textContent=local?'本机 Codex':info.name||'CircuitGit server';
    form.elements.accessCode.value='';welcome.hidden=true;connected.hidden=false;accountReady=true;
    if(local&&info.capabilities.local_login){
      $('.cg-node-account').hidden=false;message('已授权，正在检查本机 Codex 登录状态…');
      try{await refreshAccount(generation);}catch(error){if(generation===epoch&&!destroyed){accountReady=false;openButton.disabled=true;message(error.message,true);return;}}
      if(generation!==epoch||destroyed)return;
    }
    message(accountReady?'已连接。选择工程后打开对话。':'请在官方页面完成登录，然后继续。');
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

  openButton.onclick=async()=>{
    if(!client||!projects.value||busy||context||!accountReady)return;
    const generation=epoch,id=projects.value;setBusy(true);openButton.disabled=true;message('正在读取工程源码版本…');
    try{
      const next=await client.request('/ai/context?project_id='+encodeURIComponent(id));if(generation!==epoch||destroyed)return;
      if(next?.version!==1||next.project?.id!==id||!next.file?.path||!next.project.sourceCommit||!/^[a-f0-9]{64}$/.test(next.file.persistedSha256||'')||next.file.currentTextSha256!==next.file.persistedSha256||next.file.dirty)throw Error('未返回有效的已保存工程身份。');
      context={...next,revision:(context?.revision||0)+1,mode:'live'};
      for(const listener of listeners)listener(structuredClone(context));
      const slot={...parent,element:chat,setVisible:value=>parent.setVisible(value),isVisible:()=>parent.isVisible(),setBadge:value=>parent.setBadge(value),toggle:()=>parent.toggle()};
      ai=mountAI({...host,context:contextAdapter,aiSettings:{element:connectionSettings,configureDevelopment},slots:{...host.slots,ai:slot},gateway:{request:(path,options)=>client?client.request(path,options):Promise.reject(Error('连接已断开。'))}});
      $('.cg-context-label').textContent=`AI 工程：${id} · ${next.project.sourceCommit.slice(0,8)}。画布是公开电路预览，与此节点工程独立。`;
      projects.disabled=true;openButton.textContent='工程已绑定';projects.title='更换工程或刷新源码版本，请先断开再连接。';
      $('.cg-node-project').hidden=true;initialSettings.hidden=true;settingsHome.hidden=true;connectionSettings.open=false;message('');
    }catch(error){if(generation===epoch&&!destroyed){context=null;message(error.message,true);}}
    finally{if(generation===epoch&&!destroyed){setBusy(false);openButton.disabled=!!context||!accountReady;}}
  };
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
  const off=host.registerCommand({id:'ai.remote.connect',menu:'window',label:'连接 Codex',run:()=>{parent.setVisible(true);if(!context){showConnectionSettings();(connected.hidden?localButton:openButton).focus();}else ai?.show();}});
  return {destroy(){if(destroyed)return;destroyed=true;drop();off?.();css.remove();root.remove();}};
}
