import {buildInstallCommand,sanitizeInstallDir} from './workspace-hub.js';

export const WELCOME_DISMISSED_KEY='circuitgit.welcome.dismissed.v1';

export const FEATURED_PROJECTS=Object.freeze([
  {
    libraryId:'pipetisar-real',
    cellId:'TB_PIPE_RS9_N06',
    name:'1G 12-bit PIPE–TI–SAR ADC',
    badge:'1 GS/s · 12-bit · 22 模块',
    summary:'完整 1 GS/s 12-bit 流水线 + 时间交织 SAR ADC，打开顶层 TB_PIPE_RS9_N06 后可双击下钻全部 Virtuoso 原生原理图与 Verilog-A 模块。',
  },
  {
    libraryId:'basics',
    cellId:'rc-smoke',
    name:'RC 参考电路',
    badge:'免连接波形体验',
    summary:'浏览器内自带解析波形与探针游标，无需连接本机即可快速体验。',
  },
]);

export function readWelcomeDismissed(storage=globalThis.localStorage){
  try{return storage?.getItem?.(WELCOME_DISMISSED_KEY)==='1';}catch{return false;}
}

export function saveWelcomeDismissed(dismissed=true,storage=globalThis.localStorage){
  try{
    if(dismissed)storage?.setItem?.(WELCOME_DISMISSED_KEY,'1');
    else storage?.removeItem?.(WELCOME_DISMISSED_KEY);
    return true;
  }catch{return false;}
}

/**
 * Non-blocking 3-step onboarding guide (Connect Agent/SSH -> Pick Project -> Start)
 * plus an optional spacious full-focus wizard dialog reopenable anytime from the toolbar.
 * Never makes eager network calls to localhost or library files before explicit clicks.
 */
export function mountWelcomeGuide({
  toolbar,
  anchor,
  getStatus=()=>({}),
  subscribe=()=>()=>{},
  getCurrentProject=()=>null,
  onConnect=null,
  onOpenProject=null,
  onImportLocal=null,
  onImportSsh=null,
  onBrowseProjects=null,
  onOpenAI=null,
  onOpenSimulation=null,
  onOpenHub=null,
  storage=globalThis.localStorage,
}={}){
  if(!toolbar||!anchor)return {open(){},dismiss(){},update(){},destroy(){}};
  const doc=toolbar.ownerDocument,win=doc.defaultView||window;
  const isWindows=/win/i.test(String(win.navigator?.userAgentData?.platform||win.navigator?.platform||win.navigator?.userAgent||''));
  const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};

  let destroyed=false,step=1,dismissed=readWelcomeDismissed(storage),expandedDialog=null;
  let showInstaller=false,installDir=isWindows?'%USERPROFILE%\\CircuitGit':'~/CircuitGit',installAutostart=true;
  let openingProjectId='',copiedTimer=null,lastConnected=false;

  // Top-bar trigger so any user can reopen the guided setup anytime.
  const trigger=el('button','cg-welcome-trigger','新手引导');
  trigger.type='button';
  trigger.id='studio-welcome-button';
  trigger.title='打开分步配置引导（连接 Agent / SSH 与选择项目）';
  trigger.onclick=()=>openDialog();
  const viewMenu=toolbar.querySelector('.studio-view-menu');
  if(viewMenu)toolbar.insertBefore(trigger,viewMenu);
  else toolbar.append(trigger);

  // Non-blocking docked strip cleanly placed above Dockview (never covers #canvas or panels).
  const strip=el('section','cg-welcome-strip');
  strip.id='cg-welcome-guide';
  strip.setAttribute('aria-label','快速开始引导');

  function currentProjectLabel(){
    const p=getCurrentProject?.();
    if(!p)return 'RC · 入门电路';
    if(p.origin==='local'||p.origin==='ssh')return p.label||p.name||'已导入项目';
    const known=FEATURED_PROJECTS.find(item=>item.libraryId===p.libraryId&&(!item.cellId||item.cellId===p.cellId));
    if(known)return known.name;
    return p.label||p.libraryName||p.libraryId||'RC · 入门电路';
  }

  function isConnected(){
    const s=getStatus()||{};
    return Boolean(s.ai||s.simulation||s.library);
  }

  function syncBodyClass(){
    if(destroyed)return;
    const show=!dismissed;
    strip.hidden=!show;
    doc.body.classList.toggle('has-welcome-guide',show);
    win.dispatchEvent(new Event('resize'));
  }

  function dismiss({remember=true}={}){
    if(destroyed)return;
    dismissed=true;
    if(remember)saveWelcomeDismissed(true,storage);
    if(expandedDialog?.open)expandedDialog.close();
    syncBodyClass();
  }

  async function selectProject(item){
    if(destroyed||openingProjectId)return;
    openingProjectId=item.libraryId+'/'+item.cellId;
    renderAll();
    try{
      if(typeof onOpenProject==='function')await onOpenProject(item);
      if(!destroyed){step=3;}
    }finally{
      openingProjectId='';
      if(!destroyed)renderAll();
    }
  }

  function buildInstallerBox(){
    const box=el('div','cg-welcome-installer');
    box.append(el('p','cg-welcome-installer-note','首次在这台电脑使用需运行一次安装命令（Codex AI、远端 SSH 仿真与本地 Git 共用同一个本机连接器）：'));
    const row=el('div','cg-welcome-installer-row');
    const input=el('input');
    input.type='text';input.value=installDir;input.placeholder=isWindows?'%USERPROFILE%\\CircuitGit':'~/CircuitGit';
    input.setAttribute('aria-label','连接器安装路径');
    const autoLabel=el('label','cg-welcome-check');
    const auto=el('input');auto.type='checkbox';auto.checked=installAutostart;
    autoLabel.append(auto,doc.createTextNode('开机后台自启'));
    row.append(input,autoLabel);
    const cmd=el('pre','cg-welcome-cmd',buildInstallCommand({isWindows,dir:installDir,autostart:installAutostart}));
    const sync=()=>{
      installDir=input.value;installAutostart=auto.checked;
      cmd.textContent=buildInstallCommand({isWindows,dir:installDir,autostart:installAutostart});
    };
    input.addEventListener('input',sync);
    auto.addEventListener('change',sync);
    const copy=el('button','cg-welcome-btn','一键复制安装命令');
    copy.type='button';
    copy.onclick=async()=>{
      const text=buildInstallCommand({isWindows,dir:installDir,autostart:installAutostart});
      let ok=false;
      try{if(win.navigator?.clipboard?.writeText){await win.navigator.clipboard.writeText(text);ok=true;}}catch{}
      if(!ok){try{const ta=el('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';doc.body.append(ta);ta.select();ok=doc.execCommand('copy');ta.remove();}catch{}}
      copy.textContent=ok?('✓ 已复制，去'+(isWindows?' PowerShell ':' 终端 ')+'粘贴回车'):'请手动复制上方命令';
      clearTimeout(copiedTimer);
      copiedTimer=setTimeout(()=>{if(!destroyed)copy.textContent='一键复制安装命令';},4000);
    };
    box.append(row,cmd,copy);
    return box;
  }

  function renderWizardContent(container,{inDialog=false}={}){
    container.replaceChildren();
    const s=getStatus()||{};
    const connected=isConnected();
    const curProj=getCurrentProject?.();

    const top=el('div','cg-welcome-head');
    const stepsNav=el('div','cg-welcome-steps');
    stepsNav.setAttribute('role','tablist');
    stepsNav.setAttribute('aria-label','新手引导步骤');
    const isUserProject=Boolean(curProj?.origin==='local'||curProj?.origin==='ssh');
    const stepItems=[
      [1,'1. 连接 Agent 与 SSH',connected],
      [2,'2. 导入或选择项目',isUserProject||Boolean(curProj?.libraryId&&curProj.libraryId!=='basics')],
      [3,'3. 开始工作台',false],
    ];
    for(const [num,label,done] of stepItems){
      const tab=el('button','cg-welcome-step'+(step===num?' is-active':'')+(done?' is-done':''),(done?'✓ ':'')+label);
      tab.type='button';
      tab.setAttribute('role','tab');
      tab.setAttribute('aria-selected',String(step===num));
      tab.onclick=()=>{step=num;renderAll();};
      stepsNav.append(tab);
    }
    const rightControls=el('div','cg-welcome-head-actions');
    if(!inDialog){
      const expand=el('button','cg-welcome-link-btn','展开完整向导');
      expand.type='button';
      expand.onclick=()=>openDialog();
      rightControls.append(expand);
    }
    const skip=el('button','cg-welcome-skip',inDialog?'跳过引导，直接进入工作台':'跳过引导 ×');
    skip.type='button';
    skip.onclick=()=>dismiss({remember:true});
    rightControls.append(skip);
    top.append(stepsNav,rightControls);
    container.append(top);

    const body=el('div','cg-welcome-body');
    if(step===1){
      const copy=el('div','cg-welcome-copy');
      copy.append(
        el('strong','',connected?'本机连接器已就绪（Codex AI + 远端 SSH + 本地 Git）':'第 1 步：连接你的 Agent 与远端 SSH 仿真'),
        el('p','',connected?'已连通本机环境，现在去第 2 步选择要协作的电路项目即可开始。':'所有界面都在本网页完成。点击右侧按钮授权一次，即可同时启用 Codex AI、远端 SSH Spectre 仿真与本地 Git 版本管理；也可以先跳过，直接浏览公开电路。'),
      );
      const actions=el('div','cg-welcome-actions');
      if(!connected&&typeof onConnect==='function'){
        const connBtn=el('button','cg-welcome-primary',s.connecting?'正在弹出本机授权…':'一键授权连接本机（Agent + SSH）');
        connBtn.type='button';
        connBtn.disabled=Boolean(s.connecting);
        connBtn.onclick=()=>{
          if(inDialog&&expandedDialog?.open)expandedDialog.close();
          void onConnect();
        };
        actions.append(connBtn);
        const instBtn=el('button','cg-welcome-btn',showInstaller?'收起安装命令':'首次在这台电脑使用？安装连接器');
        instBtn.type='button';
        instBtn.onclick=()=>{showInstaller=!showInstaller;renderAll();};
        actions.append(instBtn);
      }
      const nextBtn=el('button',connected?'cg-welcome-primary':'cg-welcome-btn','下一步：选择项目 →');
      nextBtn.type='button';
      nextBtn.onclick=()=>{step=2;renderAll();};
      actions.append(nextBtn);
      body.append(copy,actions);
      if(!connected&&showInstaller)body.append(buildInstallerBox());
    }else if(step===2){
      const copy=el('div','cg-welcome-copy');
      copy.append(
        el('strong','','第 2 步：导入你自己的电路项目，或先用示例体验'),
        el('p','','支持直接导入本地网表 / 文件夹，或从已连接的 SSH 服务器浏览拉取网表；导入后画布自动渲染原理图，Agent 与远端仿真也会自动绑定到你的项目。'),
      );

      const userRow=el('div','cg-welcome-import-row');
      if(typeof onImportLocal==='function'){
        const localCard=el('button','cg-welcome-import-card'+(curProj?.origin==='local'?' is-selected':''));
        localCard.type='button';
        const h=el('span','cg-welcome-project-head');
        h.append(el('strong','','📂 导入本地网表 / 文件夹'),el('span','cg-welcome-import-badge','你的本地项目'));
        localCard.append(h,el('small','',curProj?.origin==='local'?`已加载：${curProj.label}（点击可重新导入）`:'选择电脑上的 .scs / .sp / .cir 文件或整个目录（自动保留 include 依赖）'));
        localCard.onclick=()=>{if(inDialog&&expandedDialog?.open)expandedDialog.close();onImportLocal();};
        userRow.append(localCard);
      }
      if(typeof onImportSsh==='function'){
        const sshCard=el('button','cg-welcome-import-card'+(curProj?.origin==='ssh'?' is-selected':''));
        sshCard.type='button';
        const h=el('span','cg-welcome-project-head');
        h.append(el('strong','','🖥 从 SSH 服务器导入网表'),el('span','cg-welcome-import-badge',connected?'已连本机 · 可浏览':'需连接本机'));
        sshCard.append(h,el('small','',curProj?.origin==='ssh'?`已加载：${curProj.label}（点击可切换其他远端网表）`:'浏览 ~/.ssh/config 中 EDA 服务器目录，一键拉取网表并预填仿真主机'));
        sshCard.onclick=()=>{if(inDialog&&expandedDialog?.open)expandedDialog.close();onImportSsh();};
        userRow.append(sshCard);
      }

      const demoLabel=el('div','cg-welcome-subhead','内置示例项目（快速体验）');
      const cards=el('div','cg-welcome-projects');
      for(const item of FEATURED_PROJECTS){
        const key=item.libraryId+'/'+item.cellId;
        const active=!isUserProject&&curProj?.libraryId===item.libraryId&&(!curProj.cellId||curProj.cellId===item.cellId);
        const card=el('button','cg-welcome-project'+(active?' is-selected':''));
        card.type='button';
        card.disabled=Boolean(openingProjectId);
        const head=el('span','cg-welcome-project-head');
        head.append(el('strong','',openingProjectId===key?'正在打开…':item.name),el('span','cg-welcome-project-badge',item.badge));
        card.append(head);
        if(inDialog)card.append(el('small','',item.summary));
        card.onclick=()=>void selectProject(item);
        cards.append(card);
      }
      const actions=el('div','cg-welcome-actions');
      const prev=el('button','cg-welcome-btn','← 上一步');
      prev.type='button';prev.onclick=()=>{step=1;renderAll();};
      const browse=el('button','cg-welcome-btn','浏览内置电路库…');
      browse.type='button';browse.onclick=()=>{if(inDialog&&expandedDialog?.open)expandedDialog.close();onBrowseProjects?.();};
      const next=el('button','cg-welcome-primary','下一步：进入工作台 →');
      next.type='button';next.onclick=()=>{step=3;renderAll();};
      actions.append(prev,browse,next);
      body.append(copy,userRow,demoLabel,cards,actions);
    }else{
      const copy=el('div','cg-welcome-copy');
      copy.append(
        el('strong','','第 3 步：准备就绪，开始协作'),
        el('p','',`本机连接：${connected?'✓ 已连接（Codex AI / SSH / Git）':'尚未连接（可随时点顶栏「连接本机」补连）'}  ·  当前项目：${currentProjectLabel()}`),
      );
      const actions=el('div','cg-welcome-actions');
      const start=el('button','cg-welcome-primary','进入工作台并打开 AI 对话');
      start.type='button';
      start.onclick=()=>{dismiss({remember:true});onOpenAI?.();};
      const sim=el('button','cg-welcome-btn','配置远端 SSH 仿真服务器');
      sim.type='button';
      sim.onclick=()=>{dismiss({remember:true});onOpenSimulation?.();};
      const switchProj=el('button','cg-welcome-btn','← 换一个项目');
      switchProj.type='button';
      switchProj.onclick=()=>{step=2;renderAll();};
      actions.append(start,sim,switchProj);
      if(!connected&&typeof onOpenHub==='function'){
        const conn=el('button','cg-welcome-btn','去连接本机');
        conn.type='button';conn.onclick=()=>{step=1;renderAll();};
        actions.append(conn);
      }
      body.append(copy,actions);
    }
    container.append(body);
  }

  function renderAll(){
    if(destroyed)return;
    const connected=isConnected();
    if(connected&&!lastConnected&&step===1)step=2;
    lastConnected=connected;
    if(!dismissed)renderWizardContent(strip,{inDialog:false});
    if(expandedDialog?.open){
      const inner=expandedDialog.querySelector('.cg-welcome-dialog-body');
      if(inner)renderWizardContent(inner,{inDialog:true});
    }
  }

  function openDialog(initialStep=null){
    if(destroyed)return;
    if(initialStep)step=initialStep;
    if(!expandedDialog){
      expandedDialog=el('dialog','cg-welcome-dialog');
      expandedDialog.setAttribute('aria-label','CircuitGit 快速开始向导');
      expandedDialog.addEventListener('keydown',e=>e.stopPropagation());
      const head=el('header','cg-welcome-dialog-head');
      head.append(el('strong','','欢迎使用 CircuitGit · 快速配置向导'));
      const close=el('button','cg-welcome-btn','关闭');
      close.type='button';close.onclick=()=>expandedDialog.close();
      head.append(close);
      const inner=el('div','cg-welcome-dialog-body');
      expandedDialog.append(head,inner);
      doc.body.append(expandedDialog);
    }
    if(!expandedDialog.open)expandedDialog.showModal();
    renderAll();
  }

  anchor.before(strip);
  const off=subscribe(()=>renderAll());
  syncBodyClass();
  renderAll();

  return {
    open(initialStep=1){openDialog(initialStep);},
    setStep(nextStep){if(destroyed)return;step=nextStep;renderAll();},
    showStrip(){if(destroyed)return;dismissed=false;syncBodyClass();renderAll();},
    dismiss,
    update:renderAll,
    destroy(){
      if(destroyed)return;
      destroyed=true;
      clearTimeout(copiedTimer);
      off?.();
      doc.body.classList.remove('has-welcome-guide');
      expandedDialog?.close();
      expandedDialog?.remove();
      strip.remove();
      trigger.remove();
    },
  };
}
