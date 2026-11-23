import {createNodeClient} from './client.js';
import {mount as mountAI} from '../studio/ai/index.js';

const DOCS='https://github.com/joshuazeng713/CircuitGit/blob/main/docs/remote-node.md';

/** The remote chat owns remote context. The demo canvas is never promoted into an engineering identity. */
export function mountRemoteNode(host) {
  const parent=host.slots.ai,doc=parent.element.ownerDocument;
  const css=doc.createElement('link');css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url);doc.head.append(css);
  const root=doc.createElement('section');root.className='cg-remote';root.setAttribute('aria-label','连接 AI 运行节点');
  root.innerHTML=`<form class="cg-node-connect"><strong>连接你的 Codex 运行节点</strong><p>网页可连接本机或自托管服务器，使用节点上已登录的 Codex。</p>
    <label>节点地址<input name="endpoint" type="url" placeholder="https://your-node.example" required autocomplete="off"></label>
    <label>节点访问码<input name="accessCode" type="password" placeholder="由节点生成，不是 OpenAI API Key" required autocomplete="off" spellcheck="false"></label>
    <label class="cg-consent"><input name="consent" type="checkbox" required>允许此网页访问该节点的项目与 AI 会话</label>
    <button type="submit">授权并连接</button><a href="${DOCS}" target="_blank" rel="noopener noreferrer">首次配置节点 ↗</a>
    <small>面向所有访客的托管订阅登录尚未开放。</small></form>
    <div class="cg-node-connected" hidden><div class="cg-node-identity"><strong></strong><button type="button" data-action="disconnect">断开</button></div>
    <div class="cg-node-project"><select aria-label="运行节点项目"><option value="">选择节点上的项目</option></select><button type="button" data-action="open-project">打开对话</button></div>
    <p class="cg-context-label">选择实际项目后开始对话。当前画布仍是 RC 演示。</p></div>
    <p class="cg-node-status" role="status" aria-live="polite"></p><div class="cg-node-chat"></div>`;
  parent.element.replaceChildren(root);
  const $=s=>root.querySelector(s),form=$('form'),connected=$('.cg-node-connected'),status=$('.cg-node-status'),chat=$('.cg-node-chat'),projects=$('select');
  let client=null,ai=null,epoch=0,context=null,busy=false,destroyed=false;const listeners=new Set();
  const contextAdapter={getContext:()=>context&&structuredClone(context),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async readSelection(){throw Error('网页示例的原理图选择未绑定到远程工程。请让 AI 从当前节点读取工程源码。');}};
  function message(text,error=false){status.textContent=text;status.dataset.error=String(error);}
  function drop(){++epoch;client?.close();client=null;ai?.destroy();ai=null;context=null;listeners.clear();chat.replaceChildren();parent.setBadge(null);}
  function disconnect(){drop();busy=false;form.hidden=false;form.querySelector('button').disabled=false;connected.hidden=true;projects.disabled=false;projects.title='';$('[data-action=open-project]').disabled=false;$('[data-action=open-project]').textContent='打开对话';projects.replaceChildren(new Option('选择节点上的项目',''));form.elements.accessCode.value='';message('已断开。失去心跳的 AI 回合会由节点暂停；已提交的仿真不会因此取消。未自动重发或批准。');}
  $('[data-action=disconnect]').onclick=disconnect;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||destroyed||!form.reportValidity())return;
    drop();const generation=epoch;busy=true;form.querySelector('button').disabled=true;message('正在验证节点…');
    try {
      client=createNodeClient({url:form.elements.endpoint.value.trim(),accessCode:form.elements.accessCode.value.trim(),onUnauthorized:()=>{
        if(generation!==epoch||destroyed)return;
        disconnect();message('节点授权已失效，连接已暂停。请核对访问码和来源配置后重新连接；未自动重发操作。',true);
      }});
      const info=await client.request('/node/info');if(generation!==epoch||destroyed)return;
      if(info?.schema!=='circuitgit.remote-node.v1'||info.single_owner!==true||info.auth!=='bearer'||!info.capabilities?.chat)throw Error('该地址不是兼容的 CircuitGit 单用户运行节点。');
      const catalog=await client.request('/ai/catalog');if(generation!==epoch||destroyed)return;
      if(!Array.isArray(catalog.projects)||!catalog.projects.length)throw Error('该节点没有可访问的工程，请先配置工程网关。');
      const seen=new Set();projects.replaceChildren(new Option('选择节点上的项目',''));
      for(const p of catalog.projects){if(typeof p.id!=='string'||!p.id||seen.has(p.id))throw Error('节点返回的项目列表无效。');seen.add(p.id);projects.add(new Option(p.name||p.id,p.id));}
      $('.cg-node-identity strong').textContent=info.name||'CircuitGit node';$('.cg-node-identity strong').title=client.base;
      form.elements.accessCode.value='';form.hidden=true;connected.hidden=false;message('节点已授权连接。选择工程后可查看模型与登录状态；尚未调用模型。');
    }catch(error){if(generation===epoch&&!destroyed){disconnect();message(error.message,true);}}
    finally{if(!destroyed&&generation===epoch){busy=false;form.querySelector('button').disabled=false;}}
  });
  $('[data-action=open-project]').onclick=async()=>{
    if(!client||!projects.value||busy||context)return;
    const state=ai?.getState();if(state&&(['starting','running'].includes(state.phase)||state.pendingApprovalCount||state.suspendedApprovalCount)){message('当前对话仍在运行或等待审批；请先处理后再切换项目。',true);return;}
    const generation=epoch,id=projects.value;busy=true;$('[data-action=open-project]').disabled=true;message('正在读取工程版本和源码身份…');
    try {
      const next=await client.request('/ai/context?project_id='+encodeURIComponent(id));if(generation!==epoch||destroyed)return;
      if(next?.version!==1||next.project?.id!==id||!next.file?.path||!next.project.sourceCommit||!/^[a-f0-9]{64}$/.test(next.file.persistedSha256||'')||next.file.currentTextSha256!==next.file.persistedSha256||next.file.dirty)throw Error('节点未返回可用的已保存工程身份。');
      context={...next,revision:(context?.revision||0)+1,mode:'live'};
      for(const listener of listeners)listener(structuredClone(context));
      if(!ai){
        const slot={...parent,element:chat,setVisible:value=>parent.setVisible(value),isVisible:()=>parent.isVisible(),setBadge:value=>parent.setBadge(value),toggle:()=>parent.toggle()};
        ai=mountAI({...host,context:contextAdapter,slots:{...host.slots,ai:slot},gateway:{request:(path,options)=>client?client.request(path,options):Promise.reject(Error('节点已断开。'))}});
      }
      $('.cg-context-label').textContent=`AI 工程：${id} · ${next.project.sourceCommit.slice(0,8)}。当前原理图与波形仍是公开示例。`;
      projects.disabled=true;$('[data-action=open-project]').textContent='工程已绑定';
      projects.title='如需更换工程或刷新源码版本，请先断开再连接。';
      message('对话使用节点上的 Codex 登录与模型设置；修改和仿真保留人工审批。');
    }catch(error){if(generation===epoch&&!destroyed){context=null;for(const listener of listeners)listener(null);message(error.message,true);}}
    finally{if(generation===epoch&&!destroyed){busy=false;$('[data-action=open-project]').disabled=!!context;}}
  };
  const off=host.registerCommand({id:'ai.remote.connect',menu:'window',label:'连接 AI 运行节点',run:()=>{parent.setVisible(true);form.elements.endpoint.focus();}});
  return {destroy(){if(destroyed)return;destroyed=true;drop();off?.();css.remove();root.remove();}};
}
