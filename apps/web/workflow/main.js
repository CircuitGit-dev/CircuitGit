import {readOverview,selectionFor,countsFor,statusLabels,localEvidenceHref} from './model.js';

const app=document.querySelector('#app');
const words={userActions:['01','用户操作'],agentActions:['02','Agent 调用'],engineChecks:['03','确定性引擎检查'],contracts:['04','数据契约'],sources:['05','源码与文件'],evidence:['06','公开证据'],boundaries:['07','能力边界'],recovery:['08','错误与恢复']};
let overview,current,index=0,visualTab='overview',architectureMode='standalone';
let caseButtons,caseStrip,navigation,stageRoot,announcement,referenceRoot;
function node(tag,className,text){const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined&&text!==null)element.textContent=String(text);return element;}
function text(value){return typeof value==='string'?value:value?.description||value?.summary||value?.label||'';}
function label(value){return typeof value==='string'?value:value?.label||value?.title||value?.name||value?.path||'';}
function pill(status){const element=node('span','status-pill',statusLabels[status]);element.dataset.status=status;return element;}
function addList(parent,values,fallback='本步未附带此类公开资料。'){
  if(!Array.isArray(values)||!values.length){parent.append(node('p','',fallback));return;}
  const list=node('ul');for(const value of values)list.append(node('li','',text(value)));parent.append(list);
}
function evidenceLink(value){
  const name=label(value),path=value?.href||value?.path,href=localEvidenceHref(path);
  if(!href)return node('code','',name||path||'未提供公开文件');
  const anchor=node('a','',name||path);anchor.href=href;anchor.target='_blank';anchor.rel='noopener noreferrer';return anchor;
}
function renderSummary(items){
  const grid=node('div','snapshot-grid');
  for(const item of (items||[]).slice(0,3)){const stat=node('div','snapshot-stat');stat.append(node('span','',item.label),node('strong','',item.value));if(item.detail)stat.title=item.detail;grid.append(stat);}
  return grid;
}
function updateUrl(){const url=new URL(location.href);url.searchParams.set('case',current.id);url.searchParams.set('stage',current.stages[index].id);history.replaceState(null,'',url);}
function chooseCase(id){current=overview.cases.find(item=>item.id===id)||overview.cases[0];index=0;visualTab='overview';renderCase();renderStage();updateUrl();}
function chooseStage(next,{focus=false}={}){
  index=Math.max(0,Math.min(current.stages.length-1,next));visualTab='overview';renderNav();renderStage();updateUrl();
  if(focus)stageRoot.focus({preventScroll:true});
}
function renderCase(){
  caseButtons.replaceChildren();
  for(const item of overview.cases){const button=node('button','case-button',item.title);button.type='button';button.setAttribute('aria-pressed',String(item.id===current.id));button.onclick=()=>chooseCase(item.id);caseButtons.append(button);}
  caseStrip.replaceChildren(node('strong','',current.title));
  const provenance=current.provenance||{};
  if(provenance.label)caseStrip.append(node('span','provenance-tag',provenance.label));
  if(provenance.revision!==undefined&&provenance.revision!==null)caseStrip.append(node('span','provenance-tag','REV '+provenance.revision));
  if(provenance.sourceCommit)caseStrip.append(node('span','provenance-tag',String(provenance.sourceCommit).slice(0,12)));
  caseStrip.append(node('span','case-summary',current.summary||current.subtitle));
  const counts=countsFor(current),stats=node('div','progress-counts');
  for(const key of ['verified','review','planned','illustrative'])if(counts[key]){const item=node('span');item.append(node('b','',counts[key]),document.createTextNode(statusLabels[key]));stats.append(item);}caseStrip.append(stats);renderNav();
}
function renderNav(){
  navigation.replaceChildren();
  current.stages.forEach((stage,position)=>{const button=node('button','stage-link');button.type='button';button.setAttribute('aria-label',`第 ${position+1} 步：${stage.title}，${statusLabels[stage.status]}`);if(position===index)button.setAttribute('aria-current','step');const dot=node('span','state-dot');dot.dataset.status=stage.status;dot.setAttribute('aria-hidden','true');button.append(node('span','stage-number',String(position+1).padStart(2,'0')),node('span','stage-name',stage.title),dot);button.onclick=()=>chooseStage(position);button.onkeydown=event=>{let next;if(event.key==='ArrowDown'||event.key==='ArrowRight')next=position+1;if(event.key==='ArrowUp'||event.key==='ArrowLeft')next=position-1;if(event.key==='Home')next=0;if(event.key==='End')next=9;if(next!==undefined){event.preventDefault();chooseStage(next);navigation.children[index]?.focus();}};navigation.append(button);});
}
function flowVisual(stage){
  const wrapper=node('div');wrapper.append(node('div','flow-label','Snapshot → explicit action → evidence'));
  const flow=node('div','flow-graphic'),groups=[['SOURCE','电路与布局','source.scs / RNL'],['ENVIRONMENT','模型与测试平台','scope / testbench'],['EXECUTION','冻结输入与人工检查','plan / gate'],['EVIDENCE','结果与版本记录','artifacts / Git']];
  const focus=index<2?0:index<6?1:index<8?2:3;
  groups.forEach(([caption,title,detail],i)=>{if(i)flow.append(node('span','flow-arrow','→'));const box=node('div','flow-node'+(i===focus?' is-current':''));box.append(node('span','',caption),node('strong','',title),node('small','',detail));flow.append(box);});
  wrapper.append(flow,node('p','illustration-note','流程结构示意（illustrative）。连线表示数据依赖，不表示任务已经执行。每一步的完成程度以公开证据标签为准。'));
  const activity=node('div','activity-grid');
  for(const [caption,values]of [['工程师 / 当前交互',stage.userActions],['Agent / 协助动作',stage.agentActions]]){const item=node('div','activity-card');item.append(node('span','',caption),node('p','',text(values?.[0])||'本步未记录额外动作。'));activity.append(item);}wrapper.append(activity);
  wrapper.append(renderSummary(current.evidenceSummary||overview.evidenceSummary||[]));
  if(stage.status==='review')wrapper.append(node('div','gate-note','停在人工检查点。这里展示已准备的输入与审阅状态；本页不会批准、提交或继续运行。'));
  if(stage.status==='planned')wrapper.append(node('div','gate-note','本步尚未执行。展示的是输入要求、操作方式与验收边界，没有将方法示意作为真实结果。'));
  if(stage.status==='illustrative')wrapper.append(node('div','gate-note','本步用于解释方法（analytical / illustrative），不代表真实电路测量或求解结果。'));
  return wrapper;
}
function renderCode(stage){
  const wrapper=node('div'),code=stage.code;
  if(!code?.text){wrapper.append(node('p','section-intro','本步没有附带可发布的源码片段。请展开下方“源码与文件”查看已公开的脱敏资料。'));return wrapper;}
  const caption=node('div','source-caption');caption.append(node('span','',code.title||'已公开的源码片段'));
  const copy=node('button','copy-code','复制片段');copy.type='button';copy.onclick=async()=>{try{await navigator.clipboard.writeText(code.text);copy.textContent='已复制';}catch{copy.textContent='请选择代码后复制';}};caption.append(copy);
  const pre=node('pre','code-block'),body=node('code','',code.text);pre.tabIndex=0;pre.setAttribute('aria-label','可滚动的公开源码片段');body.dataset.language=code.language||'text';pre.append(body);wrapper.append(caption,pre,node('p','illustration-note','此处只展示公开脱敏片段。复制不会执行命令，也不会包含私有 PDK 或连接凭据。'));return wrapper;
}
function renderEvidence(stage){
  const wrapper=node('div','evidence-list');
  if(!stage.evidence?.length){wrapper.append(node('p','section-intro','本步尚无公开执行证据。状态标签不会因浏览或切换步骤而改变。'));return wrapper;}
  for(const item of stage.evidence){const card=node('article','evidence-card');card.append(node('strong','',label(item)));if(item.kind)card.append(node('span','provenance-tag',item.kind));if(typeof item==='object'&&item.description)card.append(node('p','',item.description));if(item.path||item.href)card.append(evidenceLink({...item,label:item.path||item.href}));wrapper.append(card);}
  const src=localEvidenceHref(stage.image?.src);if(src){const figure=node('figure'),image=node('img','published-image');image.src=src;image.alt=stage.image.alt||'公开的流程证据';figure.append(image,node('figcaption','illustration-note',stage.image.caption));wrapper.append(figure);}return wrapper;
}
function renderDetails(stage){
  const grid=node('div','detail-grid');
  for(const [key,[number,title]]of Object.entries(words)){
    const detail=node('details','detail'),summary=node('summary');summary.append(node('span','',number),document.createTextNode(title));detail.append(summary);const body=node('div','detail-body');
    if(key==='contracts'){
      const list=node('div','contract-list');for(const item of stage[key]||[]){const row=node('div','contract-row');row.append(node('strong','',label(item)));if(item.description)row.append(node('p','',item.description));if(item.path)row.append(node('code','',item.path));if(item.sha256)row.append(node('p','',`SHA-256 · ${item.sha256}`));list.append(row);}if(!list.children.length)list.append(node('p','','本步未附带额外数据契约。'));body.append(list);
    }else if(key==='sources'||key==='evidence'){
      if(!stage[key]?.length)body.append(node('p','','本步没有新增可公开文件。'));
      for(const item of stage[key]||[]){const row=node('div','contract-row');row.append(evidenceLink(item));if(typeof item==='object'&&item.description)row.append(node('p','',item.description));body.append(row);}
    }else addList(body,stage[key]);detail.append(body);grid.append(detail);
  }
  return grid;
}
function renderStage(){
  const stage=current.stages[index];stageRoot.replaceChildren();
  const heading=node('div','stage-heading'),title=node('div');title.append(node('div','eyebrow',`STEP ${String(index+1).padStart(2,'0')} / 10`),node('h2','',stage.title),node('p','',stage.summary));heading.append(title,pill(stage.status));stageRoot.append(heading);
  const card=node('section','workspace-card'),bar=node('div','workspace-title');bar.append(node('strong','','实验记录 / '+current.title),node('span','','READ-ONLY EXPLORER'));card.append(bar);
  const tabs=node('div','visual-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','当前步骤展示');const panel=node('div','visual-panel');panel.id='step-visual';panel.setAttribute('role','tabpanel');
  for(const [id,title]of [['overview','交互与流程'],['source','源文件片段'],['evidence','证据记录']]){
    const button=node('button','visual-tab',title);button.id='visual-'+id;button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-controls',panel.id);button.setAttribute('aria-selected',String(visualTab===id));button.tabIndex=visualTab===id?0:-1;button.onclick=()=>{visualTab=id;renderStage();document.querySelector('#visual-'+id)?.focus({preventScroll:true});};button.onkeydown=event=>{const keys=['overview','source','evidence'];let next;if(event.key==='ArrowRight')next=(keys.indexOf(id)+1)%3;if(event.key==='ArrowLeft')next=(keys.indexOf(id)+2)%3;if(event.key==='Home')next=0;if(event.key==='End')next=2;if(next!==undefined){event.preventDefault();visualTab=keys[next];renderStage();document.querySelector('#visual-'+visualTab)?.focus({preventScroll:true});}};tabs.append(button);
  }
  panel.setAttribute('aria-labelledby','visual-'+visualTab);panel.append(visualTab==='source'?renderCode(stage):visualTab==='evidence'?renderEvidence(stage):flowVisual(stage));card.append(tabs,panel);stageRoot.append(card,renderDetails(stage));
  const footer=node('div','step-footer'),previous=node('button','','← 上一步'),next=node('button','',index===9?'已到最后一步':'下一步 →');previous.type=next.type='button';previous.disabled=index===0;next.disabled=index===9;previous.onclick=()=>chooseStage(index-1,{focus:true});next.onclick=()=>chooseStage(index+1,{focus:true});footer.append(previous,node('span','',String(index+1).padStart(2,'0')+' / 10 · 可按左右方向键'),next);stageRoot.append(footer);announcement.textContent=current.title+'，第 '+(index+1)+' 步，'+stage.title+'，'+statusLabels[stage.status];
}
function section(id,eyebrow,title,summary){const section=node('section','reference-section');section.id=id;section.append(node('div','eyebrow',eyebrow),node('h2','',title));if(summary)section.append(node('p','section-intro',summary));return section;}
function renderArchitecture(){
  const data=overview.architecture||{},area=section('architecture','ONE AGENT · TWO HOSTS',data.title||'同一个 Agent，不同的窗口宿主',data.summary),controls=node('div','architecture-switch');controls.setAttribute('aria-label','架构展示模式');const layers=node('div','architecture-layers'),modeNote=node('p','arch-mode-note');
  function update(){controls.replaceChildren();for(const [id,title]of [['standalone','Standalone / 独立'],['embedded','Embedded / 嵌入']]){const button=node('button','',title);button.type='button';button.setAttribute('aria-pressed',String(id===architectureMode));button.onclick=()=>{architectureMode=id;update();controls.children[id==='standalone'?0:1].focus({preventScroll:true});};controls.append(button);}const mode=data.modes?.[architectureMode];modeNote.textContent=mode?.description||data.summary||'展示模式切换只改变说明，不创建 Agent、会话或连接。';}
  update();area.append(controls,layers,modeNote);
  for(const item of data.layers||[]){const layer=node('article','layer');layer.append(node('h3','',item.title),node('p','',item.description));addList(layer,item.items,'');layers.append(layer);}return area;
}
function renderReferences(){
  referenceRoot.replaceChildren(renderArchitecture());
  for(const [matrix,id,caption,title,summary] of [
    [overview.responsibilityMatrix,'responsibilities','RESPONSIBILITY & CONTROL','谁决定，谁执行，谁检查','将工程判断、Agent 协助与确定性执行分开，逐项保留可复核的输入与结果。'],
    [overview.matrix,'case-comparison','EVIDENCE BY CASE','两个案例，各自走到了哪里','阶段相同，证据独立。一个案例的准备或运行记录不会替另一个案例完成验收。']
  ]){
    if(!matrix?.columns?.length||!matrix.rows?.length)continue;
    const area=section(id,caption,title,summary),scroll=node('div','table-scroll'),table=node('table'),head=node('thead'),header=node('tr'),body=node('tbody');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label',title+'，可横向滚动');table.setAttribute('aria-label',title);for(const name of matrix.columns){const cell=node('th','',name);cell.scope='col';header.append(cell);}head.append(header);for(const row of matrix.rows){const tr=node('tr');for(const value of row)tr.append(node('td','',value));body.append(tr);}table.append(head,body);scroll.append(table);area.append(scroll);referenceRoot.append(area);
  }
  const analysis=section('analysis','ANALYSIS IS NOT INTERCHANGEABLE','分析方法的适用边界','波形、频谱和小信号响应回答不同的问题。是否适用由电路、激励与采样条件决定。'),list=node('div','analysis-list');for(const [i,item]of (overview.analysisBoundaries||[]).entries()){const card=node('article','analysis-item');card.append(node('strong','',typeof item==='string'?String(i+1).padStart(2,'0'):item.name||item.title||item.label),node('p','',text(item)));list.append(card);}analysis.append(list);referenceRoot.append(analysis);
  const notes=overview.notes||overview.boundaries;if(Array.isArray(notes)){const area=node('div','global-note');addList(area,notes);referenceRoot.append(area);}
}
function mount(data){
  overview=readOverview(data);({item:current,index}=selectionFor(overview,location.href));
  app.replaceChildren();const hero=node('section','hero'),intro=node('div');intro.append(node('div','eyebrow','Circuit design, one reproducible step at a time'),node('h1','',overview.title||'从电路源文件，到可复核的实验'),node('p','',overview.subtitle||'沿着十个步骤，查看真实输入、协作方式和每一次状态转换的证据。'));caseButtons=node('div','case-picker');caseButtons.setAttribute('aria-label','选择实战案例');hero.append(intro,caseButtons);caseStrip=node('div','case-strip');
  const layout=node('div','workflow-layout'),rail=node('aside','rail');rail.append(node('div','rail-label','THE EXPERIMENT / 10 STEPS'));navigation=node('nav','stage-nav');navigation.setAttribute('aria-label','十步实验导航');rail.append(navigation);const railLinks=node('div','rail-links');for(const [id,title]of [['architecture','窗口与 Agent 架构 ↘'],['responsibilities','职责与禁止事项 ↘'],['analysis','分析方法边界 ↘']]){const anchor=node('a','',title);anchor.href='#'+id;railLinks.append(anchor);}rail.append(node('p','rail-note','使用方向键切换步骤。状态只来自公开记录，不因页面交互而变更。'),railLinks);const body=node('div');stageRoot=node('article','stage-content');stageRoot.id='stage-content';stageRoot.tabIndex=-1;referenceRoot=node('div');body.append(stageRoot,referenceRoot);layout.append(rail,body);announcement=node('p','sr-only');announcement.setAttribute('role','status');announcement.setAttribute('aria-live','polite');app.append(hero,caseStrip,layout,announcement);app.setAttribute('aria-busy','false');renderCase();renderStage();renderReferences();
}
async function load(){
  try{const response=await fetch(new URL('./data/overview.json',import.meta.url),{credentials:'omit'});if(!response.ok)throw Error('公开资料暂时无法读取（'+response.status+'）。');mount(await response.json());}
  catch(error){app.setAttribute('aria-busy','false');const card=node('section','error-card');card.append(node('h1','','流程资料尚未就绪'),node('p','',error.message));const retry=node('button','','重新读取');retry.type='button';retry.onclick=load;card.append(retry);app.replaceChildren(card);}
}
document.addEventListener('keydown',event=>{if(!overview||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)||event.target.closest('details,[role=tablist],.stage-nav,.table-scroll,.code-block'))return;if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();chooseStage(index+(event.key==='ArrowRight'?1:-1),{focus:true});}});
window.addEventListener('popstate',()=>{if(!overview)return;({item:current,index}=selectionFor(overview,location.href));visualTab='overview';renderCase();renderStage();});
load();
