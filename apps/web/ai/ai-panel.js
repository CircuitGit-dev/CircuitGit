import {mountImageComposer, createImageHistory} from './image-composer.js';
import {checkImageRequest, imageModelError} from './images.js';
import {appendAssistanceText} from './assistance.js';

/** Small Markdown subset. All text stays in DOM text nodes; raw HTML is never parsed. */
function renderAnswer(target, text) {
  const doc = target.ownerDocument, fragment = doc.createDocumentFragment();
  function inline(parent, value) {
    const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let offset = 0;
    for (const match of value.matchAll(tokens)) {
      parent.append(doc.createTextNode(value.slice(offset, match.index)));
      const token = match[0]; let element;
      if (token.startsWith('`')) { element = doc.createElement('code'); element.textContent = token.slice(1, -1); }
      else if (token.startsWith('**')) { element = doc.createElement('strong'); element.textContent = token.slice(2, -2); }
      else if (token.startsWith('*')) { element = doc.createElement('em'); element.textContent = token.slice(1, -1); }
      else {
        const link = /^\[([^\]]+)\]\((.+)\)$/.exec(token);
        let url;
        try { url = new URL(link[2]); } catch {}
        if (url && ['https:', 'http:'].includes(url.protocol)) {
          element = doc.createElement('a'); element.href = url.href;
          element.target = '_blank'; element.rel = 'noopener noreferrer'; element.textContent = link[1];
        } else { element = doc.createTextNode(token); }
      }
      parent.append(element); offset = match.index + token.length;
    }
    parent.append(doc.createTextNode(value.slice(offset)));
  }
  let paragraph = [], list = null, code = null;
  function flush() {
    if (paragraph.length) { const p = doc.createElement('p'); inline(p, paragraph.join('\n')); fragment.append(p); paragraph = []; }
  }
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      flush(); list = null;
      if (code) { code = null; } else { const pre = doc.createElement('pre'); code = doc.createElement('code'); pre.append(code); fragment.append(pre); }
    } else if (code) { code.append(doc.createTextNode((code.childNodes.length ? '\n' : '') + line)); }
    else if (!line.trim()) { flush(); list = null; }
    else {
      const item = /^\s*(?:([-*])|\d+\.)\s+(.+)$/.exec(line), heading = /^#{1,3}\s+(.+)$/.exec(line);
      if (item) {
        flush(); const tag = item[1] ? 'UL' : 'OL';
        if (!list || list.tagName !== tag) { list = doc.createElement(tag); fragment.append(list); }
        const li = doc.createElement('li'); inline(li, item[2]); list.append(li);
      } else if (heading) {
        flush(); list = null; const p = doc.createElement('p'), strong = doc.createElement('strong');
        inline(strong, heading[1]); p.append(strong); fragment.append(p);
      } else { list = null; paragraph.push(line); }
    }
  }
  flush(); target.replaceChildren(fragment);
}

/** Independent mount. contextAdapter is the ONE explicit adapter shared with the waveform panel. */
export function mountAI(root, {contextAdapter, apiBase='/api/ai', healthPath='/api/health', onStateChange=()=>{}, postRequest=null, getRequest=null, presentation='diagnostic', sessionId='default', settingsContent=null, onNewSession=null, onConfigureDevelopment=null, prepareContext=null, onToolResult=null}) {
  if (!contextAdapter?.getContext || !contextAdapter?.subscribe) throw Error('Explicit context adapter required');
  const clean = presentation === 'clean', doc = root.ownerDocument;
  root.classList.add('ic-ai'); root.dataset.presentation = presentation;
  const make=(tag,cls,text)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
  const bar=make('div','ic-ai-bar'), status=make('span','ic-ai-status','尚未连接 Codex'), inspect=make('button','','检查连接'), stop=make('button','ic-ai-stop',clean?'停止':'中断 AI');stop.type=inspect.type='button';
  stop.setAttribute('aria-label','中断 AI');
  bar.append(status,inspect);
  if(!clean)bar.append(stop);
  const provenance=make('div','ic-ai-provenance'), log=make('div','ic-ai-log');log.setAttribute('aria-live','polite');
  const pending=make('div','ic-ai-pending'), form=make('form','ic-ai-form'), input=make('textarea');input.placeholder=clean?'向 AI 提问…':'例如：读取当前电路并解释 R0 的参数。修改前请先展示 diff。';input.rows=clean?1:3;input.setAttribute('aria-label','发送给电路助手的消息');
  const row=make('div','ic-ai-compose-row'),send=make('button','','发送');send.type='submit';row.append(input,send);form.append(row);
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !send.disabled) form.requestSubmit(send);
  });
  const note=make('p','ic-ai-note','副作用等待人工审批。中断 AI 不会取消已提交的 Spectre 作业。');
  const diagnosticLog=clean?make('div','ic-ai-diagnostics'):log;
  const dialogs=[];
  function dialog(title) {
    const element=make('dialog','ic-ai ic-ai-dialog'), head=make('div','ic-ai-dialog-head'), body=make('div','ic-ai-dialog-body'), close=make('button','','关闭');
    element.setAttribute('aria-label',title);close.type='button';close.autofocus=true;
    head.append(make('strong','',title),close);element.append(head,body);doc.body.append(element);dialogs.push(element);
    close.onclick=()=>element.close();
    // Keep Viewer shortcuts (including Escape/selection clearing) out of this modal.
    element.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();element.close();}});
    return {element,body,open(){if(!element.open)element.showModal();}};
  }
  let execution, approvals, approvalNote, pendingButton, failureButton;
  if(clean){
    execution=dialog('AI执行详情');execution.body.append(bar,provenance,diagnosticLog,note);
    approvals=dialog('审批请求');approvalNote=make('p','ic-ai-approval-note');approvalNote.hidden=true;approvals.body.append(approvalNote,pending);
    pendingButton=make('button','ic-ai-pending-button','待批准');failureButton=make('button','ic-ai-failure-button','操作失败 · 详情');
    pendingButton.type=failureButton.type='button';pendingButton.hidden=failureButton.hidden=stop.hidden=true;
    pendingButton.onclick=()=>approvals.open();failureButton.onclick=()=>{execution.open();diagnosticLog.lastElementChild?.scrollIntoView({block:'nearest'});};
    row.insertBefore(failureButton,send);row.insertBefore(pendingButton,send);row.insertBefore(stop,send);
    root.append(log,form);
  }else root.append(bar,provenance,log,pending,form,note);
  let token=null,cursor=0,events=null,activeMessage=null,activeText='',activeRevision=null,lastContext=null;
  const rendered=new Set(), approvalStates=new Map(), approvalAllowed=new Map(), invalidApprovals=new Set();
  let phase='idle',connected=false,destroyed=false,failureKind=null;
  function resizeInput(){
    if(!clean||destroyed||!doc.defaultView?.getComputedStyle||!input.getClientRects().length)return;
    const style=doc.defaultView.getComputedStyle(input),px=value=>parseFloat(value)||0;
    const line=px(style.lineHeight)||20,padding=px(style.paddingTop)+px(style.paddingBottom),border=px(style.borderTopWidth)+px(style.borderBottomWidth);
    input.style.height='auto';input.style.overflowY='hidden';
    const height=input.scrollHeight+border,maximum=line*4+padding+border;
    input.style.height=Math.max(line+padding+border,Math.min(height,maximum))+'px';
    input.style.overflowY=height>maximum?'auto':'hidden';
  }
  input.addEventListener('input',resizeInput);
  // Image+text paste uses setRangeText, which does not emit an input event.
  input.addEventListener('paste',()=>queueMicrotask(resizeInput));
  let inputWidth=null;
  const inputObserver=clean&&doc.defaultView?.ResizeObserver?new doc.defaultView.ResizeObserver(entries=>{
    const width=entries[0].contentRect.width;
    if(width!==inputWidth){inputWidth=width;resizeInput();}
  }):null;
  inputObserver?.observe(input);
  let imageComposer=null,posting=false,uncertain=null,reconciling=false,resuming=false,recoveryRevision=0;
  let recovery={can_resume:false,reason:'unknown',expected_turn_id:null};
  const reconcileButton=make('button','ic-ai-image-reconcile','核对发送结果');reconcileButton.type='button';reconcileButton.hidden=true;form.append(reconcileButton);
  const resumeButton=make('button','ic-ai-resume','恢复输入 / 更换模型');resumeButton.type='button';resumeButton.hidden=true;
  resumeButton.title='保留失败回合，只恢复输入；不会重发原请求或自动更换模型。';form.append(resumeButton);
  const appendImages=createImageHistory({document:doc,sessionId,read,alive:()=>!destroyed});
  let currentRun=null, modelSelect=null, nextModel='', modelChoices=new Map(), catalogReady=false, catalogGeneration=0, catalogAttempted=false, historyReady=!clean, panelVisible=false;
  let defaultModel='',nextEffort='',nextPermission='manual',permissionExplicit=false,effortSelect=null,permissionSelect=null,settingsButton=null,settingsBox=null,settingsNote=null;
  let development={available:false,workspace:null,reason:null,access:'manual',can_configure:false},developmentState='unread',developmentLoading=null,developerOption=null,developmentInfo=null,developmentNote=null,developmentDetails=null,developmentPath=null,configureDevelopment=null,configuringDevelopment=false,settingsStateNote=null,newSessionButton=null;
  const developmentAccessLabel=access=>access==='full'?'完全访问':'人工批准';
  const nativeApprovalMethods=new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval']);
  const effortLabels={none:'关闭',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极高'};
  const effortLabel=value=>value==='model_default'?'模型默认':value?effortLabels[value]||value:'沿用会话';
  function selectedModel(models=[...modelChoices.values()],fallback=defaultModel){return nextModel?models.find(m=>m.id===nextModel):models.find(m=>m.id===fallback||m.model===fallback);}
  function supportedEfforts(model){return new Map((Array.isArray(model?.supportedReasoningEfforts)?model.supportedReasoningEfforts:[]).flatMap(item=>{const value=typeof item==='string'?item:item?.reasoningEffort;return typeof value==='string'&&value&&value!=='model_default'?[[value,typeof item==='object'?item.description||'':'']]:[];}));}
  function settingsIssue(model=selectedModel()){
    if(!['manual','read_only','developer'].includes(nextPermission))return '请选择操作权限。';
    if(nextPermission==='developer'&&(developmentState!=='ready'||!development.available))return developmentState==='loading'?'正在读取开发环境，请稍候。':'开发者模式当前不可用；请选择其他模式，或重新读取开发环境。';
    if(!nextEffort)return '';
    const supported=supportedEfforts(model),value=nextEffort==='model_default'?model?.defaultReasoningEffort:nextEffort;
    return typeof value==='string'&&supported.has(value)?'':'所选模型不支持当前思考强度；原选择已保留，请重新选择。';
  }
  function settingsLocked(){const state=getState();return !historyReady||posting||Boolean(uncertain)||reconciling||resuming||configuringDevelopment||['starting','running','suspended'].includes(phase)||state.pendingApprovalCount>0||state.suspendedApprovalCount>0;}
  function refreshEfforts(){
    if(!effortSelect)return;
    const model=selectedModel(),supported=supportedEfforts(model),options=[new Option('沿用会话','')];options[0].title='保留本会话的思考设置';
    if(typeof model?.defaultReasoningEffort==='string'&&supported.has(model.defaultReasoningEffort)){const option=new Option('模型默认 · '+effortLabel(model.defaultReasoningEffort),'model_default');option.title=model.defaultReasoningEffort;options.push(option);}
    for(const [value,description] of supported){const option=new Option(effortLabel(value),value);option.title=value+(description?' · '+description:'');options.push(option);}
    if(nextEffort&&!options.some(o=>o.value===nextEffort)){const option=new Option('需重选 · '+effortLabel(nextEffort),nextEffort);option.title=nextEffort;options.push(option);}
    effortSelect.replaceChildren(...options);effortSelect.value=nextEffort;
  }
  function syncSettings(){
    if(!clean)return;
    const locked=settingsLocked(),issue=settingsIssue();effortSelect.disabled=locked||!catalogReady;permissionSelect.disabled=locked;
    permissionSelect.value=nextPermission;effortSelect.title=nextEffort||'保留本会话的思考设置';
    const permissionLabel=nextPermission==='developer'?'开发者 · '+developmentAccessLabel(development.access):nextPermission==='read_only'?'只读':'人工批准';
    let permissionNote=nextPermission==='developer'?(development.access==='full'?'可读写本机文件、执行命令及联网，无需逐项审批。':'可开发工作台源码；写入和扩展执行权限需人工批准。'):nextPermission==='read_only'?'只读：查看电路和已有结果。':'人工批准：允许准备修改和仿真，执行变更前批准。';
    if(nextPermission==='developer'&&currentRun?.permissionMode==='developer'&&['starting','running','suspended'].includes(phase)&&currentRun.developmentAccess!==development.access)permissionNote='本回合按'+developmentAccessLabel(currentRun.developmentAccess)+'配置；新消息将使用'+developmentAccessLabel(development.access)+'。';
    settingsButton.title='AI设置：'+(selectedModel()?.displayName||nextModel||defaultModel||'跟随默认')+' · '+effortLabel(nextEffort)+' · '+permissionLabel+'；'+(issue||permissionNote);
    settingsButton.classList.toggle('error',Boolean(issue));
    settingsNote.textContent=issue||permissionNote;settingsNote.classList.toggle('error',Boolean(issue));
    const state=getState();settingsStateNote.hidden=!locked;
    settingsStateNote.textContent=phase==='suspended'?(recovery.can_resume?'此回合已暂停；先恢复输入，再调整下一条消息的设置。':'此对话已暂停，原请求和历史保留。新建独立对话后可选择模型和权限。'):state.pendingApprovalCount||state.suspendedApprovalCount?'请先处理当前审批。':'当前回合正在处理，结束后可调整下一条消息的设置。';
    newSessionButton.hidden=typeof onNewSession!=='function'||phase!=='suspended'||recovery.can_resume||Boolean(uncertain)||state.pendingApprovalCount>0||state.suspendedApprovalCount>0;
    developerOption.disabled=!development.available||developmentState!=='ready';developerOption.textContent='开发者模式'+(development.available?(development.access==='full'?' · 完全访问':''):' · 暂不可用');
    developmentInfo.hidden=nextPermission!=='developer'&&development.available;
    developmentNote.textContent=developmentState==='unread'?'展开设置后读取开发环境。':developmentState==='loading'?'正在读取开发环境…':developmentState==='error'?'暂时无法读取开发环境；其他模式仍可使用。':development.available?'工作目录由本机配置固定。':'开发者模式尚未配置或当前目录不可用。';
    developmentDetails.hidden=!development.workspace&&!development.reason;developmentPath.textContent=development.workspace||development.reason||'';
    configureDevelopment.hidden=typeof onConfigureDevelopment!=='function'||!development.can_configure;configureDevelopment.disabled=settingsLocked()||configuringDevelopment;
  }
  async function loadDevelopment(){
    if(!clean)return development;if(developmentLoading)return developmentLoading;
    developmentState='loading';changed();
    developmentLoading=(async()=>{try{const d=await read('/development');if(destroyed)return development;
      const workspace=typeof d?.workspace==='string'&&d.workspace.trim()?d.workspace:null;
      development={available:d?.available===true&&Boolean(workspace),workspace,reason:typeof d?.reason==='string'?d.reason:null,access:d?.access==='full'?'full':'manual',can_configure:d?.can_configure===true};developmentState='ready';
    }catch{if(!destroyed){development={available:false,workspace:null,reason:null,access:'manual',can_configure:false};developmentState='error';}}
    finally{developmentLoading=null;if(!destroyed)changed();}return development;})();return developmentLoading;
  }
  function restoreSettings(turn){if(!turn)return;nextEffort=typeof turn.reasoning_effort==='string'?turn.reasoning_effort:'';nextPermission=['read_only','developer'].includes(turn.permission_mode)?turn.permission_mode:'manual';permissionExplicit=Object.hasOwn(turn,'permission_mode');refreshEfforts();if(nextPermission==='developer')loadDevelopment();}
  if(clean){
    modelSelect=make('select','ic-ai-model');modelSelect.setAttribute('aria-label','下一条消息的模型');
    modelSelect.append(new Option('跟随默认',''));modelSelect.disabled=true;
    modelSelect.onchange=()=>{if(settingsLocked()){modelSelect.value=nextModel;return;}nextModel=modelSelect.value;modelSelect.title=modelChoices.get(nextModel)?.description||'跟随本会话原默认模型';imageComposer?.message('');refreshEfforts();if(settingsIssue()){settingsBox.hidden=false;settingsButton.setAttribute('aria-expanded','true');}changed();};
    settingsButton=make('button','ic-ai-settings-button');settingsButton.type='button';settingsButton.setAttribute('aria-label','AI设置');settingsButton.setAttribute('aria-expanded','false');row.insertBefore(settingsButton,input);
    const settingsIcon=make('span','','⚙');settingsIcon.setAttribute('aria-hidden','true');settingsButton.append(settingsIcon);
    settingsBox=make('div','ic-ai-settings');settingsBox.hidden=true;settingsBox.id='ic-ai-settings-'+crypto.randomUUID();settingsBox.setAttribute('role','group');settingsBox.setAttribute('aria-label','AI设置选项');settingsButton.setAttribute('aria-controls',settingsBox.id);
    const modelField=make('label','ic-ai-setting'),effortField=make('label','ic-ai-setting'),permissionField=make('label','ic-ai-setting');
    effortSelect=make('select','ic-ai-effort');effortSelect.setAttribute('aria-label','思考强度');permissionSelect=make('select','ic-ai-permission');permissionSelect.setAttribute('aria-label','操作权限');
    developerOption=new Option('开发者模式 · 暂不可用','developer');developerOption.disabled=true;permissionSelect.append(new Option('人工批准','manual'),new Option('只读','read_only'),developerOption);settingsNote=make('p','ic-ai-settings-note');settingsNote.setAttribute('aria-live','polite');
    developmentInfo=make('div','ic-ai-development');developmentNote=make('p','ic-ai-development-note');developmentDetails=make('details','ic-ai-development-details');developmentPath=make('pre');developmentDetails.append(make('summary','','开发工作目录 / 详情'),developmentPath);developmentInfo.append(developmentNote,developmentDetails);
    configureDevelopment=make('button','ic-ai-configure-development','配置本机开发权限…');configureDevelopment.type='button';configureDevelopment.hidden=true;configureDevelopment.onclick=async()=>{if(configureDevelopment.disabled)return;configuringDevelopment=true;changed();try{await onConfigureDevelopment?.();if(!destroyed)await loadDevelopment();}catch(error){if(!destroyed)imageComposer?.message(error.message,true);}finally{configuringDevelopment=false;if(!destroyed)changed();}};developmentInfo.append(configureDevelopment);
    settingsStateNote=make('p','ic-ai-settings-state-note');settingsStateNote.setAttribute('role','status');newSessionButton=make('button','ic-ai-settings-new-session','新建对话并配置');newSessionButton.type='button';newSessionButton.hidden=true;newSessionButton.onclick=()=>onNewSession?.();
    modelField.append(make('span','','模型'),modelSelect);effortField.append(make('span','','思考强度'),effortSelect);permissionField.append(make('span','','操作权限'),permissionSelect);settingsBox.append(settingsStateNote,newSessionButton,modelField,effortField,permissionField,settingsNote,developmentInfo);form.append(settingsBox);
    settingsButton.onclick=()=>{settingsBox.hidden=!settingsBox.hidden;settingsButton.setAttribute('aria-expanded',String(!settingsBox.hidden));if(!settingsBox.hidden){loadDevelopment();if(!catalogReady)loadModels({preserveSelection:true});}};
    form.addEventListener('keydown',event=>{if(event.key==='Escape'&&!settingsBox.hidden){event.preventDefault();event.stopPropagation();settingsBox.hidden=true;settingsButton.setAttribute('aria-expanded','false');settingsButton.focus();}});
    effortSelect.onchange=()=>{if(settingsLocked()){effortSelect.value=nextEffort;return;}nextEffort=effortSelect.value;changed();};
    permissionSelect.onchange=()=>{if(settingsLocked()||permissionSelect.value==='developer'&&(!development.available||developmentState!=='ready')){permissionSelect.value=nextPermission;return;}nextPermission=permissionSelect.value;permissionExplicit=true;changed();};refreshEfforts();
    const refreshModels=make('button','','刷新模型目录');refreshModels.type='button';refreshModels.onclick=()=>loadModels();bar.append(refreshModels);
  }
  async function loadModels({preserveSelection=false}={}){
    if(!clean||['starting','running'].includes(phase))return;
    catalogAttempted=true;const generation=++catalogGeneration;
    try{
      const catalog=await read('/models');
      if(destroyed||generation!==catalogGeneration)return;
      if(!Array.isArray(catalog.models))throw Error('模型目录响应无效');
      modelChoices=new Map(catalog.models.map(m=>[m.id,m]));defaultModel=typeof catalog.default_model==='string'?catalog.default_model:'';
      const fallback=new Option('跟随默认'+(catalog.default_model?' · '+catalog.default_model:''),'');
      modelSelect.replaceChildren(fallback,...catalog.models.map(m=>{const o=new Option(m.displayName,m.id);o.title=m.description||'';return o;}));
      if(nextModel&&!modelChoices.has(nextModel)){
        if(preserveSelection||uncertain||imageComposer?.getState().items.length){modelSelect.append(new Option('此前模型已失效 · 保留原选择',nextModel));imageComposer?.message(uncertain?'此前模型不在当前目录中；原模型和草稿已保留。请先核对发送结果，再重新读取目录或明确选择模型。':'此前模型不在当前目录中；原选择与草稿已保留，请明确选择其他模型。',true);}
        else{nextModel='';add('模型目录','此前选择不在当前目录中；已恢复跟随默认，请重新选择。');}
      }
      modelSelect.value=nextModel;modelSelect.title='当前 provider 的模型目录；尚未验证本次推理访问。'+(modelChoices.get(nextModel)?.description||'');catalogReady=true;
    }catch(e){
      if(destroyed||generation!==catalogGeneration)return;
      catalogReady=false;modelChoices.clear();
      const keepSelection=Boolean(nextModel&&(preserveSelection||uncertain||imageComposer?.getState().items.length));
      if(keepSelection){
        modelSelect.replaceChildren(new Option('目录不可用 · 保留此前模型',nextModel));modelSelect.value=nextModel;
        imageComposer?.message(uncertain?'模型目录读取失败；原模型和草稿已保留。请先核对发送结果，再重新读取目录或明确选择模型。':'模型目录读取失败；原模型和图片已保留。请重新读取目录或明确选择模型。',true);
      }
      else{nextModel='';modelSelect.replaceChildren(new Option('跟随默认 · 目录不可用',''));}
      modelSelect.title=e.message;
      add(keepSelection?'模型目录不可用 · 保留原选择':'模型目录不可用 · 保留原默认',e.message,'error');
    }
    refreshEfforts();changed();
  }
  function progressStart(key,model){
    if(!clean)return;
    const details=make('details','ic-ai-progress'),summary=make('summary'),steps=make('ol','ic-ai-steps');details.append(summary,steps);log.append(details);
    const run={key,model,details,summary,steps,started:performance.now(),done:false,label:'等待响应',stepMap:new Map(),messages:new Map(),threadId:null,turnId:null};
    currentRun=run;
    const draw=()=>{const seconds=((run.durationMs??performance.now()-run.started)/1000).toFixed(1);summary.textContent=run.label+' · '+seconds+' 秒';};
    run.draw=draw;draw();run.timer=setInterval(draw,1000);
  }
  function recordDevelopmentAccess(receipt){
    if(!currentRun||receipt?.permission_mode!=='developer')return;
    currentRun.permissionMode='developer';currentRun.developmentAccess=receipt.development_access==='full'?'full':'manual';
    progressStep('development-access','本回合权限：开发者 · '+developmentAccessLabel(currentRun.developmentAccess),{access:currentRun.developmentAccess,workspace:receipt.development_workspace||null});
  }
  function progressStep(id,label,payload,completed=false){
    if(!clean||!currentRun)return;
    let step=currentRun.stepMap.get(id);
    if(!step){
      const li=make('li'),details=make('details'),summary=make('summary'),body=make('pre');details.append(summary,body);li.append(details);currentRun.steps.append(li);
      step={details,summary,body,payload};currentRun.stepMap.set(id,step);
      details.addEventListener('toggle',()=>{if(details.open)body.textContent=typeof step.payload==='string'?step.payload:JSON.stringify(step.payload,null,2);});
    }
    step.payload=payload&&typeof payload==='object'&&step.payload&&typeof step.payload==='object'?{...step.payload,...payload}:payload;step.summary.textContent=label+(completed?' · 已结束':'');
    if(step.details.open)step.body.textContent=typeof step.payload==='string'?step.payload:JSON.stringify(step.payload,null,2);
  }
  function progressLabel(label){if(currentRun&&!currentRun.done){currentRun.label=label;currentRun.draw();}}
  function progressFinish(label,durationMs){
    if(!currentRun||currentRun.done)return;
    currentRun.done=true;clearInterval(currentRun.timer);currentRun.label=label;
    currentRun.durationMs=Number.isFinite(durationMs)&&durationMs>=0?durationMs:performance.now()-currentRun.started;currentRun.draw();
  }
  function ownsEvent(e){
    if(!clean)return true;if(!currentRun)return false;
    if(e.request_key)return e.request_key===currentRun.key;
    const p=e.params||{},turnId=p.turnId||p.turn?.id||e.turn_id;
    return !!currentRun.turnId&&turnId===currentRun.turnId;
  }
  function messageDelta(p){
    if(!clean){if(!activeMessage){activeMessage=add('Codex','','','assistant');activeText='';}activeText+=p.delta||'';activeMessage.textContent=activeText;return;}
    const id=p.itemId||currentRun.activeItem||'message';let message=currentRun.messages.get(id);
    if(!message){message={text:'',phase:null,node:null};currentRun.messages.set(id,message);}
    message.text+=p.delta||'';progressLabel('正在回答');
    if(message.phase==='commentary'){progressStep('message:'+id,'AI 说明',message.text);return;}
    if(!message.node)message.node=add('AI','','','assistant');renderAnswer(message.node,message.text);
  }
  function getState(){return Object.freeze({phase,connected,contextStale:root.dataset.stale==='true',pendingApprovalCount:[...approvalStates.values()].filter(s=>['pending','resolving'].includes(s)).length,suspendedApprovalCount:[...approvalStates.values()].filter(s=>s==='suspended').length});}
  function syncApprovals(){
    for(const card of pending.children){
      const id=card.dataset.approvalId,s=approvalStates.get(id),blocked=s!=='pending'||invalidApprovals.has(id)||root.dataset.stale==='true';
      card.querySelector('[data-decision=approve]').disabled=blocked||approvalAllowed.get(id)!==true;
      card.querySelector('[data-decision=deny]').disabled=blocked;
    }
  }
  function changed(){
    if(destroyed)return;
    syncApprovals();
    if(clean){
      if(panelVisible&&!catalogAttempted&&!['starting','running','suspended'].includes(phase))loadModels();
      if(modelSelect)modelSelect.disabled=!catalogReady||settingsLocked();
      const state=getState(),count=state.pendingApprovalCount+state.suspendedApprovalCount;
      pendingButton.hidden=count===0;
      const invalid=[...approvalStates].some(([id,s])=>s!=='resolved'&&invalidApprovals.has(id));
      pendingButton.textContent=(state.contextStale||invalid?'审批已失效':state.pendingApprovalCount?'待批准':'审批已暂停')+(count>1?` (${count})`:'');
      stop.hidden=!['starting','running'].includes(phase);
      approvalNote.hidden=!(state.contextStale||invalid||state.suspendedApprovalCount);
      approvalNote.textContent=state.contextStale||invalid?'上下文已变化；此请求不能批准，请重新读取并审阅。':'操作已暂停，请查看执行详情。';
    }
    const composeLocked=posting||Boolean(uncertain)||reconciling||resuming;
    input.readOnly=composeLocked;imageComposer?.lock(composeLocked);
    reconcileButton.hidden=!uncertain;reconcileButton.disabled=posting||reconciling;
    const state=getState();
    resumeButton.hidden=!(recovery.can_resume&&phase==='suspended')&&!resuming;
    resumeButton.disabled=!recovery.can_resume||phase!=='suspended'||composeLocked||!historyReady||state.pendingApprovalCount>0||state.suspendedApprovalCount>0;
    resumeButton.textContent=resuming?'正在恢复输入…':'恢复输入 / 更换模型';
    syncSettings();
    send.disabled=!historyReady||composeLocked||configuringDevelopment||Boolean(imageComposer?.getState().busy)||['starting','running','suspended'].includes(phase)||state.pendingApprovalCount>0||state.suspendedApprovalCount>0||Boolean(settingsIssue());
    try{onStateChange(getState());}catch(e){console.error('AI dock state consumer failed',e);}
  }
  function suspendPending(){for(const [id,s] of approvalStates)if(s==='pending')approvalStates.set(id,'suspended');}
  async function read(path){const suffix=path+(path.includes('?')?'&':'?')+'session_id='+encodeURIComponent(sessionId);if(getRequest)return getRequest(suffix);const r=await fetch(apiBase+suffix),j=await r.json();if(!j.ok)throw Error(j.error.message);return j.data;}
  async function post(path,body={}) {body={...body,session_id:sessionId};if(postRequest)return postRequest(path,body);if(!token){const h=await (await fetch(healthPath)).json();if(!h.ok)throw Error(h.error.message);token=h.data.mutation_token;}
    const r=await fetch(apiBase+path,{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Token':token},body:JSON.stringify(body)});const j=await r.json();if(!j.ok){const error=Error(j.error.message);error.data=j.error;throw error;}return j.data;}
  function add(title,value,cls='',role=null) {
    const chat=clean&&role, box=make('article',chat?'ic-ai-entry ic-ai-message '+cls:'ic-ai-entry '+cls);
    if(chat)box.dataset.role=role;
    box.append(make('strong','ic-ai-role',title));
    const content=make(chat?'div':'pre',chat?'ic-ai-message-body':'',typeof value==='string'?value:JSON.stringify(value,null,2));
    box.append(content);const destination=clean&&!role?diagnosticLog:log;destination.append(box);destination.scrollTop=destination.scrollHeight;return content;
  }
  function markFailure(label,kind='operation'){if(clean){failureKind=kind;failureButton.textContent=label+' · 详情';failureButton.hidden=false;}}
  function clearFailure(){if(clean){failureKind=null;failureButton.hidden=true;}}
  function describeError(error){
    const message=String(error?.message||'AI 请求失败'),info=error?.codexErrorInfo;
    if(/No available channel for model/i.test(message))return {label:'模型通道不可用',kind:'model-channel',message:'当前所选模型没有可用服务通道。'+message};
    if(info==='internalServerError'||/high demand|internal server error/i.test(message))return {label:'模型服务暂时不可用',kind:'model-service',message};
    if(info==='usageLimitExceeded'||/usage limit|quota exceeded/i.test(message))return {label:'模型额度受限',kind:'model-quota',message};
    if(info==='unauthorized'||/unauthorized|authentication/i.test(message))return {label:'模型授权失败',kind:'model-auth',message};
    if(info?.httpConnectionFailed||info?.responseStreamDisconnected||/unexpected status 50[234]/i.test(message))return {label:'模型服务连接失败',kind:'model-service',message};
    return {label:'请求失败',kind:'operation',message};
  }
  function showError(error){const e=describeError(error);progressFinish('失败');phase='suspended';status.textContent=e.label+' · '+e.message;add(e.label+' / 未重发原请求',e.message,'error');markFailure(e.label,e.kind);changed();}
  function updateRecovery(value){
    const id=value?.expected_turn_id;
    recovery={can_resume:value?.can_resume===true&&typeof id==='string'&&id.length>0&&id.length<=240,reason:typeof value?.reason==='string'?value.reason:'unknown',expected_turn_id:typeof id==='string'?id:null};
  }
  function update(context){lastContext=context;const f=context?.file,p=context?.project;provenance.textContent=p?`${p.id} · ${f?.baseCommit?.slice(0,12)||'未知 commit'} · ${f?.persistedSha256?.slice(0,12)||'未知 hash'} · ${f?.dirty?'有未保存修改':'已保存'}`:'等待项目上下文';
    if(activeRevision!==null&&context?.revision!==activeRevision){root.dataset.stale='true';note.textContent='当前上下文已变化；已有 AI 答复绑定先前版本。新修改需要重新读取与审阅。';for(const [id,s] of approvalStates)if(s!=='resolved')invalidApprovals.add(id);}changed();}
  const unsubscribe=contextAdapter.subscribe(update);update(contextAdapter.getContext());
  imageComposer=mountImageComposer({form,row,input,onChange:()=>changed()});
  function approval(a){approvalAllowed.set(a.approval_id,a.kind==='workbench'||a.kind==='codex'&&a.can_approve===true&&nativeApprovalMethods.has(a.method));if(rendered.has(a.approval_id))return;rendered.add(a.approval_id);approvalStates.set(a.approval_id,a.status||'pending');const card=make('article','ic-ai-approval');card.dataset.approvalId=a.approval_id;card.dataset.kind=a.kind;
    if(root.dataset.stale==='true')invalidApprovals.add(a.approval_id);
    const native=a.kind==='codex'&&nativeApprovalMethods.has(a.method),params=a.params||{};
    card.append(make('strong','',a.kind==='workbench'?'待人工批准：'+a.request.operation:native?'待人工批准：'+(a.method.includes('commandExecution')?'运行命令':'修改应用文件'):'AI 审批请求：'+a.method));
    if(native){
      if(typeof a.development_workspace==='string')card.append(make('p','','开发工作目录：'+a.development_workspace));
      const commandItem=params.itemId?currentRun?.stepMap.get('command:'+params.itemId)?.payload:null,command=params.command??(commandItem&&commandItem.id===params.itemId?commandItem.command:null),cwd=params.cwd??(commandItem&&commandItem.id===params.itemId?commandItem.cwd:null);
      if(cwd)card.append(make('p','','执行目录：'+cwd));
      if(command)card.append(make('pre','',typeof command==='string'?command:JSON.stringify(command,null,2)));
      const fileItem=params.itemId?currentRun?.stepMap.get('file:'+params.itemId)?.payload:null,changes=params.changes??(fileItem&&fileItem.id===params.itemId?fileItem.changes:null);
      if(Array.isArray(changes))for(const change of changes){if(change&&typeof change==='object'&&typeof change.diff==='string'){if(change.path)card.append(make('p','','文件：'+change.path));card.append(make('pre','',change.diff));}else card.append(make('pre','',typeof change==='string'?change:JSON.stringify(change,null,2)));}
      else if(changes)card.append(make('pre','',typeof changes==='string'?changes:JSON.stringify(changes,null,2)));
      else if(a.method==='item/fileChange/requestApproval')card.append(make('p','','此请求未提供文件差异，请先核对完整请求和执行步骤。'));
      if(params.reason)card.append(make('p','','说明：'+params.reason));
      const details=make('details','ic-ai-native-request');details.append(make('summary','','完整请求'),make('pre','',JSON.stringify(params,null,2)));card.append(details);
    }else{const detail=a.request?.review?.diff || a.request?.review || a.params;card.append(make('pre','',typeof detail==='string'?detail:JSON.stringify(detail,null,2)));}
    if(a.request)card.append(make('small','',`请求 ${a.request.request_id} · ${a.request.fingerprint}`));
    const yes=make('button','','批准这次操作'),no=make('button','','拒绝');yes.type=no.type='button';yes.setAttribute('data-decision','approve');no.setAttribute('data-decision','deny');
    if(a.kind!=='workbench')card.append(make('p','',approvalAllowed.get(a.approval_id)?'请核对目录和操作内容；批准仅作用于这次请求。':'当前请求未获准通过此窗口执行，可拒绝或中断。'));
    async function decide(decision){
      if(approvalStates.get(a.approval_id)!=='pending'||invalidApprovals.has(a.approval_id)||root.dataset.stale==='true'||(decision==='approve'&&approvalAllowed.get(a.approval_id)!==true))return;
      yes.disabled=no.disabled=true;approvalStates.set(a.approval_id,'resolving');changed();
      try{await post('/approval',{approval_id:a.approval_id,decision});approvalStates.set(a.approval_id,'resolved');changed();card.dataset.resolved=decision;card.append(make('p','',decision==='approve'?'人工决定已发送；查看实际回执。':'已拒绝并中断依赖操作。'));}
      catch(e){approvalStates.set(a.approval_id,'suspended');showError(e);card.append(make('p','','审批投递失败，操作暂停。'));}}
    yes.onclick=()=>decide('approve');no.onclick=()=>decide('deny');card.append(yes,no);pending.append(card);changed();
  }
  function handle(e){if(!ownsEvent(e))return;const p=e.params;
    if(clean&&e.timings&&e.method==='turn/completed')add('本回合耗时',e.timings);
    if(e.method==='item/agentMessage/delta'){messageDelta(p);}
    else if(e.method==='item/commandExecution/outputDelta'){const id='command:'+p.itemId,prior=currentRun?.stepMap.get(id)?.payload?.output||'';progressStep(id,'命令输出',{output:(prior+(p.delta||'')).slice(-32000)});}
    else if(e.method==='turn/started'){if(currentRun){currentRun.turnId=p.turn?.id;currentRun.threadId=p.threadId||e.thread_id;}progressLabel('等待响应');}
    else if(['item/started','item/completed'].includes(e.method)){
      const item=p.item||{},ended=e.method==='item/completed';
      if(item.type==='dynamicToolCall'){progressLabel(ended?'等待响应':'正在调用工具');progressStep('tool:'+item.id,(item.success===false?'工具失败：':'调用 ')+item.tool,item,ended);}
      else if(item.type==='commandExecution'){progressLabel(ended?'等待响应':'正在运行命令');progressStep('command:'+item.id,'运行命令',item,ended);}
      else if(item.type==='fileChange'){progressLabel(ended?'等待响应':'正在处理修改');progressStep('file:'+item.id,'文件修改',item,ended);}
      else if(item.type==='agentMessage'){
        if(!clean){if(!ended)activeMessage=null;}
        else{
          currentRun.activeItem=item.id;let message=currentRun.messages.get(item.id);
          if(!message){message={text:'',phase:item.phase,node:null};currentRun.messages.set(item.id,message);}else if(item.phase)message.phase=item.phase;
          progressLabel('正在回答');
          if(ended&&item.text&&!message.text)messageDelta({itemId:item.id,delta:item.text});
          progressStep('message:'+item.id,item.phase==='commentary'?'AI 说明':'生成回答',message.text||{status:ended?'completed':'started'},ended);
        }
      }
    }
    else if(e.method==='tool/result'){add('实际工具结果 · '+p.tool,p.result);progressStep('tool:'+p.call_id,'工具返回 '+p.tool,p.result,true);if(onToolResult)void Promise.resolve().then(()=>onToolResult(p)).catch(error=>add('仿真界面同步',error.message,'error'));}
    else if(e.method==='approval/required'){approval(p);progressLabel('等待批准');progressStep('approval:'+p.approval_id,'等待人工批准',{kind:p.kind,operation:p.request?.operation});}
    else if(e.method==='approval/resolved'){approvalStates.set(p.approval_id,'resolved');add('审批回执',p);progressStep('approval:'+p.approval_id,p.decision==='approve'?'已批准':'已拒绝',p,true);progressLabel('等待响应');}
    else if(e.method==='session/ready'){phase='running';status.textContent=`Codex · ${p.model} · ${p.approvalsReviewer}`;add('会话连接',p);}
    else if(e.method==='session/error'){showError(p.error||{message:p.message||'AI 请求失败'});}
    else if(e.method==='error'){
      if(p.willRetry===true){phase='running';progressLabel('模型连接重试中');status.textContent='模型连接重试中 · '+(p.error?.message||'等待服务恢复');progressStep('model-retry','模型连接重试中',{message:p.error?.message,details:p.error?.additionalDetails});}
      else{const error=describeError(p.error);status.textContent=error.label+' · 等待最终回执';progressLabel('等待最终回执');add(error.label,p.error?.additionalDetails||error.message,'error');}
    }
    else if(e.method==='turn/completed'){progressFinish(p.turn.status==='completed'?'已完成':p.turn.status==='failed'?'失败':'已暂停',p.turn.durationMs);phase=p.turn.status==='completed'?'complete':'suspended';suspendPending();status.textContent='回合：'+p.turn.status;activeMessage=null;if(p.turn.status==='failed')showError(p.turn.error||{message:'AI 回合失败'});}
    else if(e.method==='session/interrupted'||e.method==='transport/disconnected'){progressFinish('已暂停');phase='suspended';suspendPending();status.textContent='已暂停 · 不重放';send.disabled=true;add('中断/断线',p);if(e.method==='transport/disconnected')markFailure('连接中断');}
    else if(e.method==='turn/diff/updated'){add('Codex diff',p.diff||p);progressStep('diff','修改差异',p.diff||p,true);}
    else if(e.method==='item/started'&&p.item?.type==='agentMessage')activeMessage=null;
    changed();
  }
  function consumeEvents(d){
    connected=true;if(failureKind==='event-connection')clearFailure();
    if(d.gap&&cursor>0)showError(Error('事件历史有缺口；只恢复事件，不重发操作'));
    for(const e of d.events){if(e.sequence>cursor){handle(e);cursor=e.sequence;}}
    if(['idle','starting','running','complete','suspended'].includes(d.state))phase=d.state;
    updateRecovery(d.recovery);
    for(const p of d.pending||[]){if(clean&&p.request_key!==currentRun?.key)continue;if(p.status==='pending')approval(p);else if(['suspended','resolving'].includes(p.status)&&approvalStates.get(p.approval_id)!=='resolved')approvalStates.set(p.approval_id,p.status);}changed();
  }
  function connectionError(){connected=false;updateRecovery(null);status.textContent='本地事件连接中断 · 仅重连事件，不重发';if(clean&&failureKind!=='event-connection'){add('本地事件连接中断','网页暂时无法读取网关事件；仅恢复事件连接，不重发操作。');markFailure('本地事件连接中断','event-connection');}changed();}
  function connect(){
    if(events)return;
    if(clean){
      let cancelled=false,timer=null;
      events={close(){cancelled=true;clearTimeout(timer);}};
      async function poll(){
        const revision=recoveryRevision;
        try{if(resuming)return;const batch=await read('/events?after='+cursor);if(!cancelled&&!destroyed&&revision===recoveryRevision)consumeEvents(batch);}
        catch(error){if(!cancelled&&!destroyed&&revision===recoveryRevision)connectionError();}
        finally{if(!cancelled&&!destroyed)timer=setTimeout(poll,1200);}
      }
      poll();
    }else{
      events=new EventSource(apiBase+'/events?after='+cursor+'&session_id='+encodeURIComponent(sessionId));
      events.onmessage=event=>consumeEvents(JSON.parse(event.data));events.onerror=connectionError;
    }
  }
  function openDetails(){if(clean){execution.open();}else inspectConnection();}
  async function inspectConnection(){try{const d=await post('/doctor');add('真实连接检查',d.codex);status.textContent='app-server 可读；尚未证明模型回合可用';}catch(e){showError(e);}};
  inspect.onclick=inspectConnection;
  stop.onclick=async()=>{try{await post('/interrupt');}catch(e){showError(e);}};
  resumeButton.onclick=async()=>{
    if(resumeButton.disabled||resuming||!recovery.can_resume)return;
    const expected=recovery.expected_turn_id;resuming=true;++recoveryRevision;changed();
    try{
      const result=await post('/resume',{expected_turn_id:expected});if(destroyed)return;
      if(result?.resumed!==true||result.state!=='complete'||result.automatic_retry!==false||result.history_retained!==true||result.session_id&&result.session_id!==sessionId)throw Error('恢复回执不完整，请核对会话状态。');
      const history=await read('/history');if(destroyed)return;
      if(history.session_id!==sessionId)throw Error('恢复后的会话身份不匹配。');
      phase=history.state;updateRecovery(history.recovery);
      if(phase!=='complete'||history.pending?.some(p=>p.status!=='resolved'))throw Error('会话仍在运行或有待处理审批，输入保持暂停。');
      clearFailure();status.textContent='输入已恢复 · 原请求未重发，请选择模型并输入新消息。';
      add('输入已恢复','历史与失败回合已保留；没有重发原请求或自动更换模型。');
      await loadModels({preserveSelection:true});
    }catch(error){if(!destroyed){updateRecovery(null);showError(error);}}
    finally{resuming=false;if(!destroyed)changed();}
  };
  function acceptSubmission(submission,receipt) {
    if(receipt?.key!==submission.key||typeof receipt.thread_id!=='string'||!receipt.thread_id||typeof receipt.turn_id!=='string'||!receipt.turn_id||!['running','complete'].includes(receipt.state))return false;
    if(submission.images.length&&(!Array.isArray(receipt.images)||receipt.images.length!==submission.images.length||receipt.images.some(image=>!/^[a-f0-9]{64}$/.test(image.image_id||''))))return false;
    if(currentRun?.key===submission.key){currentRun.threadId=receipt.thread_id;currentRun.turnId=receipt.turn_id;recordDevelopmentAccess(receipt);}
    submission.delivery.textContent='已提交';
    if(receipt.images?.length){submission.node.querySelector('.ic-ai-message-images')?.remove();appendImages(submission.node,receipt.images);}
    input.value='';resizeInput();imageComposer.clear();imageComposer.message('');uncertain=null;
    add('回合回执',receipt);return true;
  }
  reconcileButton.onclick=async()=>{
    if(!uncertain||posting||reconciling)return;
    const submission=uncertain;reconciling=true;changed();
    try{
      const history=await read('/history');if(destroyed||uncertain!==submission)return;
      if(history.session_id!==sessionId)throw Error('会话身份不匹配');
      updateRecovery(history.recovery);
      const receipt=history.turns?.find(turn=>turn.key===submission.key);
      if(receipt&&acceptSubmission(submission,receipt)){
        phase=history.state||receipt.state;status.textContent='已从同会话回执确认提交；未重发。';
        if(['complete','running'].includes(phase))clearFailure();
        if(currentRun?.key===submission.key){
          for(const message of (history.messages||[]).filter(m=>m.request_key===submission.key&&m.role==='assistant')){
            const id=message.item_id||message.id;
            let row=currentRun.messages.get(id);
            if(!row){row={text:'',phase:message.phase,node:null};currentRun.messages.set(id,row);}
            row.text=message.text||'';row.phase=message.phase;
            if(row.phase==='commentary')progressStep('message:'+id,'AI 说明',row.text,true);
            else{if(!row.node)row.node=add('AI','','','assistant');renderAnswer(row.node,row.text);}
          }
          clearInterval(currentRun.timer);currentRun.done=false;
          if(receipt.state==='complete')progressFinish('已完成',receipt.duration_ms??receipt.timings?.request_elapsed_ms);
          else if(phase==='running'){currentRun.durationMs=undefined;progressLabel('执行中');currentRun.timer=setInterval(currentRun.draw,1000);}
          else progressFinish('已暂停');
        }
      }else if(receipt?.state==='suspended'||(!receipt&&submission.definitiveRejection&&['idle','complete'].includes(history.state))){
        uncertain=null;phase=history.state;submission.delivery.textContent=receipt?'本回合已暂停':'请求已拒绝';
        imageComposer.message('请求未成功完成；文字和图片已保留。请查看执行详情，不会自动重发。',true);
      }else imageComposer.message('尚未找到明确回执，发送结果仍未知。草稿已保留，未重新发送。',true);
    }catch{if(!destroyed)imageComposer.message('无法核对发送结果。草稿已保留，未重新发送。',true);}
    finally{reconciling=false;if(!destroyed)changed();}
  };
  form.onsubmit=async e=>{
    e.preventDefault();const originalText=input.value,message=originalText.trim(),items=imageComposer.getState().items;
    if((!message&&!items.length)||send.disabled||!historyReady||posting||uncertain)return;
    const selected=nextModel;posting=true;changed();let submission=null;
    try{
      if(nextPermission==='developer'){const {workspace,access}=development;await loadDevelopment();if(destroyed)return;if(!development.available)throw Error('开发者模式当前不可用，草稿已保留。');if(workspace!==development.workspace||access!==development.access)throw Error(workspace!==development.workspace?'开发工作目录已变化，请核对设置后重新发送。':'开发访问权限已变化，请核对设置后重新发送。');}
      if(items.length||nextEffort){
        const fresh=await read('/models');if(destroyed)return;
        const models=Array.isArray(fresh.models)?fresh.models:[],issue=settingsIssue(selectedModel(models,fresh.default_model));if(issue)throw Error(issue);
        if(items.length){const capability=imageModelError(models,fresh.default_model,selected);if(capability)throw Error(capability);}
      }else if(selected&&!modelChoices.has(selected))throw Error('请从当前模型目录选择模型');
      const baseContext=contextAdapter.getContext(),context=prepareContext?await prepareContext(baseContext):baseContext;
      if(destroyed)return;
      if(!context||context.file?.dirty)throw Error('请先保存并审阅当前源码，再发起 AI 回合');
      const images=items.map(({name,mime_type,data_url})=>({name,mime_type,data_url})),key=crypto.randomUUID();
      const body={message,context,idempotency_key:key,...(selected?{model:selected}:{}),...(nextEffort?{reasoning_effort:nextEffort}:{}),...(permissionExplicit||nextPermission!=='manual'?{permission_mode:nextPermission}:{}),...(images.length?{images}:{}),session_id:sessionId};
      checkImageRequest(body);
      activeRevision=context.revision;root.dataset.stale='false';phase='starting';clearFailure();activeMessage=null;
      const node=add('你',message,'','user'),delivery=make('small','ic-ai-delivery','发送中');appendImages(node,images,true);node.append(delivery);
      submission={key,originalText,images,node,delivery,definitiveRejection:false};
      progressStart(key,selected);changed();status.textContent='正在连接/执行…';connect();
      const receipt=await post('/turn',body);if(destroyed)return;
      if(!acceptSubmission(submission,receipt))throw Error('未收到可确认的发送回执');
    }catch(error){
      if(destroyed)return;
      if(submission){
        submission.definitiveRejection=['invalid_image','unsupported_image','image_limit','image_preflight_rejected','model_image_unsupported','model_image_capability_unknown','invalid_input','invalid_model','invalid_reasoning_effort','invalid_permission_mode','development_unavailable','manual_approval_unavailable','forbidden'].includes(error.data?.code);
        uncertain=submission;submission.delivery.textContent='发送失败或结果未知';showError(error);
        imageComposer.message('发送未确认，文字和图片已保留。请点击“核对发送结果”；不会换 key 重试。',true);
      }else imageComposer.message(error.message||'暂时无法发送。',true);
    }finally{posting=false;if(!destroyed)changed();}
  };
  async function restoreHistory(){
    send.disabled=true;
    try{
      const h=await read('/history');if(destroyed)return;
      cursor=h.cursor;const messages=h.messages||[];
      for(const turn of h.turns||[]){
        for(const message of messages.filter(m=>m.request_key===turn.key&&m.role==='user')){const node=add('你',message.text||'','','user');appendImages(node,message.images);}
        progressStart(turn.key,turn.selected_model_id||'');
        recordDevelopmentAccess(turn);
        currentRun.turnId=turn.turn_id||null;currentRun.threadId=turn.thread_id||null;
        if(Number.isFinite(turn.started_at_ms))currentRun.started=performance.now()-Math.max(0,Date.now()-turn.started_at_ms);
        for(const message of messages.filter(m=>m.request_key===turn.key&&m.role==='assistant')){
          const itemId=message.item_id||message.id,row={text:message.text,phase:message.phase,node:null};currentRun.messages.set(itemId,row);
          if(message.phase==='commentary')progressStep('message:'+itemId,'AI 说明',message.text,true);
          else{row.node=add('AI','','','assistant');renderAnswer(row.node,message.text);}
        }
        if(turn.terminal_status==='failed'){
          const error=describeError(turn.terminal_error||{message:'AI 回合失败'});
          progressStep('terminal-error',error.label,error.message,true);
          progressFinish('失败',turn.duration_ms??turn.timings?.request_elapsed_ms);
        }
        else if(turn.state==='complete')progressFinish('已完成',turn.duration_ms??turn.timings?.request_elapsed_ms);
        else if(turn.key!==h.active_request_key||!['starting','running'].includes(h.state))progressFinish('已暂停',turn.duration_ms??turn.timings?.request_elapsed_ms);
      }
      phase=h.state||'idle';updateRecovery(h.recovery);activeRevision=h.context_revision??null;
      if(currentRun&&currentRun.key===h.active_request_key){currentRun.turnId=h.active_turn_id||currentRun.turnId;currentRun.threadId=h.thread_id||currentRun.threadId;nextModel=currentRun.model;}
      const latestTurn=(h.turns||[]).at(-1);
      if(phase==='complete'&&!h.active_request_key&&Number.isFinite(latestTurn?.input_resumed_at_ms))nextModel=latestTurn.selected_model_id||'';
      const activeTurn=(h.turns||[]).find(turn=>turn.key===h.active_request_key);
      restoreSettings(activeTurn||(phase==='complete'&&!h.active_request_key?latestTurn:null));
      if(phase==='suspended'&&activeTurn?.terminal_status==='failed')showError(activeTurn.terminal_error||{message:'AI 回合失败'});
      for(const pending of h.pending||[])approval(pending);
      if(modelSelect&&modelChoices.has(nextModel))modelSelect.value=nextModel;
      historyReady=true;send.disabled=['starting','running','suspended'].includes(phase);update(contextAdapter.getContext());connect();
    }catch(error){showError(error);send.disabled=true;}
  }
  if(clean)restoreHistory();
  function setVisible(visible){
    if(destroyed)return;
    panelVisible=visible;
    if(visible&&clean&&settingsContent&&settingsContent.parentElement!==settingsBox)settingsBox.append(settingsContent);
    if(visible)resizeInput();
    if(!visible){for(const element of dialogs)if(element.open)element.close();}
    else if(clean&&!catalogAttempted)loadModels();
  }
  const appliedDrafts=new Map();
  let draftHighlightTimer=null;
  function appendDraft(draft,{focus=true}={}){
    if(destroyed)throw Error('当前对话已关闭，仿真请求尚未加入。');
    if(appliedDrafts.has(draft?.request_id)){if(appliedDrafts.get(draft.request_id)!==draft.text)throw Error('请求身份与已加入的内容不一致，未重复追加。');return {status:'prepared',session_id:sessionId,message:'此请求已在当前对话草稿中处理，未重复追加。'};}
    if(posting||uncertain||reconciling||resuming)return {status:'queued',message:'当前发送结果正在核对；仿真请求已保留，未修改原草稿。'};
    input.value=appendAssistanceText(input.value,draft);appliedDrafts.set(draft.request_id,draft.text);resizeInput();changed();
    if(focus){input.scrollIntoView?.({block:'nearest'});input.focus({preventScroll:true});try{input.setSelectionRange?.(input.value.length,input.value.length);}catch{}}
    form.classList?.add('is-draft-received');clearTimeout(draftHighlightTimer);draftHighlightTimer=setTimeout(()=>form.classList?.remove('is-draft-received'),1600);
    return {status:'prepared',session_id:sessionId,message:'已追加到当前对话草稿；文字、图片和模型设置已保留，请检查后发送。'};
  }
  return {showError,getState,openDetails,setVisible,appendDraft,focusInput(){if(!destroyed){setVisible(true);input.focus({preventScroll:true});}},inspectConnection,destroy(){if(destroyed)return;destroyed=true;clearTimeout(draftHighlightTimer);inputObserver?.disconnect();imageComposer?.destroy();if(currentRun)clearInterval(currentRun.timer);events?.close();unsubscribe?.();for(const element of dialogs){if(element.open)element.close();element.remove();}root.replaceChildren();}};
}
