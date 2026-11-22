import {mountAI} from '../../ai/ai-panel.js';
import {mountSessions} from './sessions.js';

const mounted = new WeakMap();
const styles = new WeakMap();

function useStyle(document) {
  let record = styles.get(document);
  if (!record) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./style.css', import.meta.url).href;
    document.head.append(link);
    const sessionsLink = document.createElement('link');sessionsLink.rel='stylesheet';sessionsLink.href=new URL('./sessions.css',import.meta.url).href;document.head.append(sessionsLink);
    record = {link, sessionsLink, count: 0};
    styles.set(document, record);
  }
  record.count++;
  return () => {
    if (--record.count === 0) {
      record.link.remove();record.sessionsLink.remove();
      styles.delete(document);
    }
  };
}

/** UI host owns layout, visibility, context and menus. This adapter only mounts AI. */
export function mount(host) {
  const slot = host?.slots?.ai;
  if (host?.version !== 1 || !slot?.element ||
      !['getContext', 'subscribe', 'readSelection'].every(k => typeof host.context?.[k] === 'function') ||
      !['setVisible', 'toggle', 'isVisible', 'setBadge'].every(k => typeof slot[k] === 'function') ||
      typeof host.registerCommand !== 'function' || typeof host.gateway?.request !== 'function') {
    throw new TypeError('AI dock requires RNL Studio host v1, shared context, gateway and AI slot');
  }
  const existing = mounted.get(slot.element);
  if (existing) {
    if (existing.host !== host) throw new Error('AI slot already belongs to another host');
    return existing.controller;
  }
  const releaseStyle=useStyle(slot.element.ownerDocument),unregister=[];
  let wrapper,destroyed=false;
  function createPanel(container,{sessionId,onStateChange=()=>{}}){
    const root=container.ownerDocument.createElement('div');root.className='ic-ai-studio';root.setAttribute('aria-label','电路 AI 对话');container.append(root);
    const panel=mountAI(root,{presentation:'clean',sessionId,contextAdapter:host.context,
      getRequest:suffix=>host.gateway.request('/ai'+suffix),
      postRequest:(suffix,body)=>host.gateway.request('/ai'+suffix,{method:'POST',body}),onStateChange});
    const composer=root.querySelector('.ic-ai-form'),details=root.ownerDocument.createElement('div');
    details.className='ic-ai-dock-details';details.setAttribute('aria-label','AI 对话记录');details.tabIndex=0;
    for(const child of [...root.children])if(child!==composer)details.append(child);
    root.insertBefore(details,composer);
    let follow=true;
    details.addEventListener('scroll',()=>{follow=details.scrollTop+details.clientHeight>=details.scrollHeight-8;});
    const observer=new MutationObserver(()=>{if(follow)details.scrollTop=details.scrollHeight;});
    observer.observe(details,{subtree:true,childList:true,characterData:true});
    return Object.freeze({getState:panel.getState,focusInput:panel.focusInput,openDetails:panel.openDetails,setVisible:panel.setVisible,
      destroy(){observer.disconnect();panel.destroy();root.remove();}});
  }
  function destroy(){if(destroyed)return;destroyed=true;for(const remove of unregister.reverse())remove();wrapper?.destroy();releaseStyle();mounted.delete(slot.element);}
  try{
    wrapper=mountSessions(host,{createPanel});
    unregister.push(host.registerCommand({id:'ai.toggle',menu:'window',label:'AI：显示 / 隐藏对话',run:()=>wrapper.toggle(),checked:()=>slot.isVisible()}));
    unregister.push(host.registerCommand({id:'ai.show',menu:'window',label:'AI：聚焦对话输入',run:()=>wrapper.show()}));
    unregister.push(host.registerCommand({id:'ai.inspect',menu:'window',label:'AI执行详情',run:()=>wrapper.openDetails()}));
    unregister.push(host.registerCommand({id:'ai.manage',menu:'window',label:'AI：对话管理器…',run:()=>wrapper.openManager()}));
  }catch(error){destroy();throw error;}
  const controller=Object.freeze({show:()=>wrapper.show(),hide:()=>wrapper.hide(),toggle:()=>wrapper.toggle(),getState:()=>wrapper.getState(),destroy});
  mounted.set(slot.element,{host,controller});
  return controller;
}
