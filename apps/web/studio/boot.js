import {createLayout,attachSchematicChrome} from './layout.js';

function mark(name){performance.mark('circuitgit:'+name);}
async function start(){
  // Keep pinned multi-file RNL closures intact when descending subcircuits (native=1)
  // or jumping roots from the hierarchy panel (studio=1), without modifying vendored RNL.
  try{
    const url=new URL(location.href);
    let changed=false;
    if(url.searchParams.get('native')!=='1'){url.searchParams.set('native','1');changed=true;}
    if(url.searchParams.get('studio')!=='1'){url.searchParams.set('studio','1');changed=true;}
    if(changed)history.replaceState(history.state,'',url.href);
  }catch{}
  const ui=await createLayout();
  mark('layout-ready');
  document.body.dataset.workbenchState='layout-ready';
  // The pinned upstream HTML is used only as inert component markup. No upstream startup script runs.
  const response=await fetch(new URL('../vendor/rnl-viewer/index.html',import.meta.url));
  if(!response.ok)throw Error('原理图组件读取失败 ('+response.status+')');
  const template=new DOMParser().parseFromString(await response.text(),'text/html');
  const source=template.getElementById('app'),app=document.getElementById('app');
  if(!source||!template.querySelector('.statusbar'))throw Error('原理图组件结构不兼容');
  app.replaceChildren(...source.childNodes);app.classList.add('workbench-component-loading');app.inert=true;
  document.querySelector('.statusbar').append(...template.querySelector('.statusbar').childNodes);
  for(const id of ['page-switch','hover-tip','pick-list']){const el=template.getElementById(id);if(el)document.body.append(el);}
  // Circuit progress stays inside its panel; menus and other windows remain usable.
  document.querySelector('main.drawing').append(template.getElementById('loading'));
  attachSchematicChrome();
  const controller=new URLSearchParams(location.search).get('demo')==='1'?import('../demo/main.js'):import('./main.js');
  const [,module]=await Promise.all([import('./schematic.js').then(adapter=>adapter.startSchematic()),controller]);
  app.classList.remove('workbench-component-loading');app.removeAttribute('aria-busy');app.inert=false;
  window.dispatchEvent(new Event('resize'));
  mark('renderer-ready');
  await module.mountStudio({ui});
  if(document.body.dataset.studioState==='error'){document.body.dataset.workbenchState='error';return;}
  if(window.viewer?.doc)mark('schematic-ready');
  document.body.dataset.workbenchState='ready';
}
start().catch(error=>{
  document.body.dataset.workbenchState='error';
  const app=document.getElementById('app');app?.classList.remove('workbench-component-loading');app?.removeAttribute('aria-busy');if(app)app.inert=false;
  const root=document.getElementById('empty')||app||document.body;
  const message=document.createElement('p');message.className='workbench-panel-error';message.setAttribute('role','alert');message.textContent='电路加载失败：'+error.message;
  const retry=document.createElement('button');retry.textContent='重新加载';retry.onclick=()=>location.reload();message.append(document.createElement('br'),retry);root.replaceChildren(message);
  console.error(error);
});
