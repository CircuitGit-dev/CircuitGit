import {loadRemoteSimPrefs,saveRemoteSimPrefs} from '../../../modules/simulation/environment/preferences.js';

export const CIRCUIT_EXTENSIONS=Object.freeze([
  '.scs','.sp','.spi','.spice','.cir','.ckt','.net',
  '.inc','.va','.vams','.v','.rnl','.txt','.cdl','.mdl',
]);

const CIRCUIT_EXT_SET=new Set(CIRCUIT_EXTENSIONS);
const MAX_LOCAL_FILES=64;
const MAX_SINGLE_FILE_BYTES=1024*1024;
const MAX_BUNDLE_BYTES=1400*1024;
const SENSITIVE_NAME=/^(?:\.|id_rsa|id_dsa|id_ecdsa|id_ed25519|authorized_keys$|known_hosts$|shadow$|passwd$)|(?:\.(?:key|pem|p12|pfx|jks|lic|ppk)$)|(?:secret|password|passwd|token|credential|license)/i;

export function isCircuitFileName(name){
  if(typeof name!=='string'||!name)return false;
  const base=name.split('/').pop()||'';
  if(!base||SENSITIVE_NAME.test(base))return false;
  const dot=base.lastIndexOf('.');
  if(dot<0)return false;
  return CIRCUIT_EXT_SET.has(base.slice(dot).toLowerCase());
}

export function normalizeRelativePath(raw){
  if(typeof raw!=='string')return null;
  const cleaned=raw.replace(/\\/g,'/').replace(/^\/+/,'').replace(/^\.\//,'');
  if(!cleaned||cleaned.length>512||/[\x00-\x1f\x7f]/.test(cleaned))return null;
  const parts=cleaned.split('/').filter(Boolean);
  if(!parts.length||parts.some(p=>p==='.'||p==='..'||SENSITIVE_NAME.test(p)))return null;
  return parts.join('/');
}

export function scoreEntryCandidate(relPath){
  const parts=String(relPath||'').split('/');
  const base=(parts.at(-1)||'').toLowerCase();
  const depth=parts.length-1;
  let score=Math.max(0,40-depth*12);
  if(base.endsWith('.scs'))score+=28;
  else if(base.endsWith('.sp')||base.endsWith('.spice')||base.endsWith('.cir'))score+=22;
  else if(base.endsWith('.rnl'))score+=18;
  else if(base.endsWith('.net')||base.endsWith('.ckt')||base.endsWith('.cdl'))score+=14;
  else if(base.endsWith('.va')||base.endsWith('.vams'))score+=6;
  if(/^tb[_-]|[_-]tb\./i.test(base))score+=18;
  if(/top|main|schematic/i.test(base))score+=12;
  if(/model|corner|param|lib|inc|header/i.test(base))score-=14;
  return score;
}

export function formatByteSize(bytes){
  if(!Number.isFinite(bytes)||bytes<0)return '';
  if(bytes<1024)return bytes+' B';
  if(bytes<1024*1024)return (bytes/1024).toFixed(1)+' KB';
  return (bytes/(1024*1024)).toFixed(2)+' MB';
}

/** Normalize picked local files or a directory upload into a clean entry + support bundle. */
export function prepareLocalImportFiles(entries){
  const list=Array.isArray(entries)?entries:[];
  const valid=[];
  const skipped=[];
  for(const item of list){
    const rel=normalizeRelativePath(item?.path||item?.name||'');
    if(!rel){skipped.push({path:String(item?.path||item?.name||''),reason:'invalid_or_sensitive_path'});continue;}
    if(!isCircuitFileName(rel)){skipped.push({path:rel,reason:'unsupported_extension'});continue;}
    if(typeof item?.text!=='string'){skipped.push({path:rel,reason:'not_text'});continue;}
    const size=new TextEncoder().encode(item.text).byteLength;
    if(size===0){skipped.push({path:rel,reason:'empty_file'});continue;}
    if(size>MAX_SINGLE_FILE_BYTES){skipped.push({path:rel,reason:'exceeds_1mib'});continue;}
    valid.push({path:rel,text:item.text,size});
  }
  if(!valid.length)throw Error('未找到可导入的网表文件（支持 .scs / .sp / .spice / .cir / .va / .rnl / .txt，单文件 ≤ 1 MiB）。');

  // If all files share a single top-level directory (from webkitdirectory), strip that prefix as projectName.
  const firstSegs=new Set(valid.map(f=>f.path.includes('/')?f.path.split('/')[0]:''));
  let projectName='';
  let stripped=valid;
  if(firstSegs.size===1){
    const only=[...firstSegs][0];
    if(only){
      projectName=only;
      stripped=valid.map(f=>({...f,path:f.path.slice(only.length+1)}));
    }
  }
  const limited=stripped.slice(0,MAX_LOCAL_FILES);
  if(stripped.length>MAX_LOCAL_FILES){
    for(const extra of stripped.slice(MAX_LOCAL_FILES))skipped.push({path:extra.path,reason:'file_count_limit'});
  }
  const candidates=[...limited].sort((a,b)=>scoreEntryCandidate(b.path)-scoreEntryCandidate(a.path)||a.path.localeCompare(b.path));
  const filesByPath=Object.create(null);
  for(const row of limited)filesByPath[row.path]=row.text;
  const defaultEntry=candidates[0].path;
  if(!projectName)projectName=defaultEntry.split('/').pop().replace(/\.[^.]+$/,'')||defaultEntry;
  return {projectName,candidates:candidates.map(c=>({path:c.path,size:c.size})),defaultEntry,filesByPath,skipped};
}

/** Split a local bundle into entry text + bounded relative support_files for onboarding/RNL. */
export function selectImportEntry({filesByPath,entryPath,projectName=''}){
  const cleanEntry=normalizeRelativePath(entryPath);
  if(!cleanEntry||!Object.hasOwn(filesByPath||{},cleanEntry))throw Error('请选择有效的顶层入口网表文件。');
  const text=filesByPath[cleanEntry];
  const fileName=cleanEntry.split('/').pop()||cleanEntry;
  const entryDir=cleanEntry.includes('/')?cleanEntry.slice(0,cleanEntry.lastIndexOf('/')):'';
  const supportFiles={};
  const rnlSnapshot=Object.create(null);
  rnlSnapshot['/'+cleanEntry]=text;
  let totalBytes=new TextEncoder().encode(text).byteLength;
  for(const [rel,content] of Object.entries(filesByPath)){
    if(rel===cleanEntry)continue;
    rnlSnapshot['/'+rel]=content;
    // Onboarding support_files are written relative to the entry's support root.
    let supportKey=rel;
    if(entryDir&&rel.startsWith(entryDir+'/'))supportKey=rel.slice(entryDir.length+1);
    const bytes=new TextEncoder().encode(content).byteLength;
    if(totalBytes+bytes<=MAX_BUNDLE_BYTES){
      supportFiles[supportKey]=content;
      totalBytes+=bytes;
    }
  }
  return {
    projectName:projectName||fileName.replace(/\.[^.]+$/,'')||fileName,
    entryPath:cleanEntry,
    fileName,
    text,
    supportFiles,
    rnlSnapshot,
  };
}

/** Build an RNL virtual source object compatible with openSource() and snapshotOnboardingSource(). */
export function buildImportedRnlSource({entryPath,fileName,text,supportFiles={},rnlSnapshot=null}){
  const cleanEntry=normalizeRelativePath(entryPath||fileName||'imported.scs')||'imported.scs';
  const path='/'+cleanEntry;
  const snapshot=Object.create(null);
  if(rnlSnapshot&&typeof rnlSnapshot==='object'){
    for(const [k,v] of Object.entries(rnlSnapshot)){
      const norm=k.startsWith('/')?k:'/'+k;
      snapshot[norm]=v;
    }
  }
  snapshot[path]=text;
  const baseDir=cleanEntry.includes('/')?cleanEntry.slice(0,cleanEntry.lastIndexOf('/')+1):'';
  for(const [rel,content] of Object.entries(supportFiles||{})){
    const cleanRel=normalizeRelativePath(rel);
    if(!cleanRel)continue;
    const full='/'+baseDir+cleanRel;
    if(!Object.hasOwn(snapshot,full))snapshot[full]=content;
    const rootKey='/'+cleanRel;
    if(!Object.hasOwn(snapshot,rootKey))snapshot[rootKey]=content;
  }
  return {
    name:cleanEntry,
    path,
    readonly:false,
    snapshot,
    files:new Map(Object.entries(snapshot).map(([p,t])=>[p,()=>new Blob([t],{type:'text/plain'})])),
    open:async()=>({path,text:snapshot[path]}),
    read:async requested=>{
      const norm=requested.startsWith('/')?requested:'/'+requested;
      if(Object.hasOwn(snapshot,norm))return snapshot[norm];
      const stripped=norm.replace(/^\/+/,'');
      if(Object.hasOwn(snapshot,'/'+stripped))return snapshot['/'+stripped];
      throw Error('依赖文件未包含在当前导入目录中：'+requested);
    },
  };
}

export function formatSshImportError(error){
  const raw=String(error?.message||error||'SSH 导入失败');
  if(
    /Unknown (?:node write route|preflight route|finite onboarding operation|bounded onboarding operation)/i.test(raw)||
    error?.status===404||
    error?.data?.code==='node_unreachable'||
    error?.data?.code==='transport_unknown'||
    /无法读取节点|发送结果尚不确定/.test(raw)
  ){
    return '当前本机后台运行的连接器版本较旧（尚不支持 ssh-browse 远端浏览接口），或请求被本地预检拦截。请更新并重启本机连接器后重新连接，或先使用左侧「本地网表 / 文件夹」导入。';
  }
  if(/Permission denied|publickey|BatchMode|Authentication failed/i.test(raw)){
    return 'SSH 免密登录未通过：'+raw+'。请确认本机已配置 SSH 密钥且能在终端执行 ssh <主机> 免密登录。';
  }
  if(/timed out|Could not resolve hostname|Connection refused/i.test(raw)){
    return '无法连接到 SSH 服务器：'+raw+'。请检查网络/VPN 与主机别名是否正确。';
  }
  return raw;
}

async function readBrowserFileList(fileList){
  const files=Array.from(fileList||[]);
  const out=[];
  for(const file of files){
    const rel=file.webkitRelativePath||file.name;
    if(!isCircuitFileName(rel))continue;
    if(file.size>MAX_SINGLE_FILE_BYTES)continue;
    const text=await file.text();
    out.push({path:rel,text});
  }
  return out;
}

/** Interactive unified dialog for importing Local Netlist/Folder OR browsing & importing from an SSH Server. */
export function createProjectImporter({
  doc=document,
  onboarding=null,
  getConnected=()=>false,
  subscribe=()=>()=>{},
  onConnect=null,
  onOpenHub=null,
  onImport=null,
  notify=()=>{},
}={}){
  const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  let destroyed=false,dialog=null,activeTab='local';
  // Local state
  let localBundle=null,localSelectedEntry='',localPasteName='my_circuit.scs',localPasteText='',localError='',localBusy=false;
  // SSH state
  let sshAliases=[],sshAliasesLoaded=false,sshAliasesLoading=false;
  let sshTarget=loadRemoteSimPrefs()?.targets?.[0]||'';
  let sshPath='~',sshCwd='',sshParent=null,sshEntries=[],sshTruncated=false,sshSelectedFile='';
  let sshIncludeDeps=true,sshBusy=false,sshError='',sshLegacyConnector=false;

  const offSub=subscribe(()=>{
    if(destroyed||!dialog?.open)return;
    if(activeTab==='ssh'&&getConnected()&&!sshAliasesLoaded&&!sshAliasesLoading){
      void loadAliases();
    }
    render();
  });

  async function loadAliases({autoBrowse=false}={}){
    if(!onboarding||!getConnected()||sshAliasesLoading)return;
    sshAliasesLoading=true;sshError='';sshLegacyConnector=false;
    render();
    try{
      const data=await onboarding.listSshAliases();
      sshAliases=(data?.hosts||[]).map(h=>h.alias).filter(Boolean);
      sshAliasesLoaded=true;
      if(!sshTarget&&sshAliases.length)sshTarget=sshAliases[0];
      if(autoBrowse&&sshTarget)void browseSsh(sshPath||'~');
    }catch(error){
      sshError=formatSshImportError(error);
    }finally{
      sshAliasesLoading=false;
      if(!destroyed&&dialog?.open)render();
    }
  }

  function hasSshImportCapability(){
    return onboarding?.getState?.()?.capabilities?.simulation_onboarding_ssh_import===true;
  }

  async function browseSsh(targetPath){
    if(!onboarding||!getConnected()||sshBusy)return;
    if(!hasSshImportCapability()){
      sshLegacyConnector=true;
      sshError='当前本机后台运行的连接器版本较旧，尚未包含「从 SSH 服务器浏览网表」接口。请更新并重启本机连接器后重新连接，或先使用左侧「本地网表 / 文件夹」导入。';
      render();
      return;
    }
    const host=sshTarget.trim();
    if(!host){sshError='请先选择或输入 SSH 主机别名（如 ~/.ssh/config 中的 Host）。';render();return;}
    sshBusy=true;sshError='';sshLegacyConnector=false;sshSelectedFile='';
    render();
    try{
      const nextPath=(targetPath??sshPath??'').trim();
      const res=await onboarding.browseRemoteNetlists({ssh_target:host,...(nextPath?{path:nextPath}:{})});
      sshCwd=res.cwd||'';
      sshPath=sshCwd||nextPath||'~';
      sshParent=res.parent||null;
      sshEntries=Array.isArray(res.entries)?res.entries:[];
      sshTruncated=Boolean(res.truncated);
      const prefs=loadRemoteSimPrefs();
      saveRemoteSimPrefs({
        targets:[host,...(prefs?.targets||[]).filter(t=>t!==host)],
        search_paths:prefs?.search_paths||'',
        cds_lib_hint:prefs?.cds_lib_hint||'',
      });
    }catch(error){
      const msg=formatSshImportError(error);
      sshError=msg;
      sshLegacyConnector=/版本较旧/.test(msg);
    }finally{
      sshBusy=false;
      if(!destroyed&&dialog?.open)render();
    }
  }

  async function importFromSsh(filePath){
    if(!onboarding||!getConnected()||sshBusy)return;
    const host=sshTarget.trim();
    const target=String(filePath||sshSelectedFile||'').trim();
    if(!host||!target){sshError='请先选择一个远端网表文件。';render();return;}
    sshBusy=true;sshError='';sshLegacyConnector=false;
    render();
    try{
      const res=await onboarding.importRemoteNetlist({
        ssh_target:host,
        path:target,
        include_dependencies:sshIncludeDeps,
      });
      const prefs=loadRemoteSimPrefs();
      saveRemoteSimPrefs({
        targets:[host,...(prefs?.targets||[]).filter(t=>t!==host)],
        search_paths:prefs?.search_paths||'',
        cds_lib_hint:prefs?.cds_lib_hint||'',
      });
      const dirName=(res.remote_dir||'').split('/').filter(Boolean).pop()||'';
      const projectName=dirName||res.file_name.replace(/\.[^.]+$/,'')||res.file_name;
      if(dialog?.open)dialog.close();
      await onImport?.({
        origin:'ssh',
        sshTarget:host,
        remotePath:res.remote_path||target,
        remoteDir:res.remote_dir||'',
        projectName,
        entryPath:res.file_name,
        fileName:res.file_name,
        text:res.text,
        supportFiles:res.support_files||{},
        skipped:res.skipped||[],
      });
    }catch(error){
      const msg=formatSshImportError(error);
      sshError=msg;
      sshLegacyConnector=/版本较旧/.test(msg);
      notify(msg,{kind:'error'});
    }finally{
      sshBusy=false;
      if(!destroyed&&dialog?.open)render();
    }
  }

  async function handlePickedLocalFiles(fileList){
    if(localBusy)return;
    localBusy=true;localError='';
    render();
    try{
      const entries=await readBrowserFileList(fileList);
      const bundle=prepareLocalImportFiles(entries);
      localBundle=bundle;
      localSelectedEntry=bundle.defaultEntry;
      if(bundle.candidates.length===1){
        await commitLocalBundle();
        return;
      }
    }catch(error){
      localError=String(error?.message||error);
    }finally{
      localBusy=false;
      if(!destroyed&&dialog?.open)render();
    }
  }

  async function commitLocalBundle(){
    if(!localBundle)return;
    localBusy=true;localError='';
    render();
    try{
      const chosen=selectImportEntry({
        filesByPath:localBundle.filesByPath,
        entryPath:localSelectedEntry||localBundle.defaultEntry,
        projectName:localBundle.projectName,
      });
      if(dialog?.open)dialog.close();
      await onImport?.({
        origin:'local',
        projectName:chosen.projectName,
        entryPath:chosen.entryPath,
        fileName:chosen.fileName,
        text:chosen.text,
        supportFiles:chosen.supportFiles,
        rnlSnapshot:chosen.rnlSnapshot,
        skipped:localBundle.skipped||[],
      });
      localBundle=null;localSelectedEntry='';
    }catch(error){
      localError=String(error?.message||error);
      notify(localError,{kind:'error'});
    }finally{
      localBusy=false;
      if(!destroyed&&dialog?.open)render();
    }
  }

  async function commitPastedNetlist(){
    const name=(localPasteName||'my_circuit.scs').trim();
    const text=localPasteText;
    if(!text.trim()){localError='请先粘贴网表内容。';render();return;}
    localBusy=true;localError='';render();
    try{
      const bundle=prepareLocalImportFiles([{path:name,text}]);
      const chosen=selectImportEntry({filesByPath:bundle.filesByPath,entryPath:bundle.defaultEntry,projectName:bundle.projectName});
      if(dialog?.open)dialog.close();
      await onImport?.({
        origin:'local',
        projectName:chosen.projectName,
        entryPath:chosen.entryPath,
        fileName:chosen.fileName,
        text:chosen.text,
        supportFiles:{},
        rnlSnapshot:chosen.rnlSnapshot,
      });
    }catch(error){
      localError=String(error?.message||error);
      notify(localError,{kind:'error'});
    }finally{
      localBusy=false;
      if(!destroyed&&dialog?.open)render();
    }
  }

  function renderLocalPane(body){
    const desc=el('p','cg-import-desc','导入你电脑上的 Spectre / SPICE / Verilog-A / RNL 网表。导入单个文件会立即渲染原理图；导入整个文件夹会自动保留子目录与 include 依赖，并同步给 Agent 协作与远端仿真。');
    body.append(desc);

    const fileInput=el('input');
    fileInput.type='file';fileInput.multiple=true;fileInput.hidden=true;
    fileInput.accept=CIRCUIT_EXTENSIONS.join(',');
    fileInput.addEventListener('change',()=>{if(fileInput.files?.length)void handlePickedLocalFiles(fileInput.files);fileInput.value='';});

    const folderInput=el('input');
    folderInput.type='file';folderInput.multiple=true;folderInput.hidden=true;
    folderInput.setAttribute('webkitdirectory','');
    folderInput.addEventListener('change',()=>{if(folderInput.files?.length)void handlePickedLocalFiles(folderInput.files);folderInput.value='';});

    const dropzone=el('div','cg-import-dropzone');
    dropzone.addEventListener('dragover',e=>{e.preventDefault();dropzone.classList.add('is-dragover');});
    dropzone.addEventListener('dragleave',()=>dropzone.classList.remove('is-dragover'));
    dropzone.addEventListener('drop',e=>{
      e.preventDefault();dropzone.classList.remove('is-dragover');
      if(e.dataTransfer?.files?.length)void handlePickedLocalFiles(e.dataTransfer.files);
    });
    const pickRow=el('div','cg-import-pick-row');
    const pickFileBtn=el('button','cg-welcome-primary',localBusy?'正在读取…':'选择本地网表文件 (.scs / .sp / .cir)');
    pickFileBtn.type='button';pickFileBtn.disabled=localBusy;
    pickFileBtn.onclick=()=>fileInput.click();
    const pickDirBtn=el('button','cg-welcome-btn','选择本地项目文件夹（含 include 依赖）');
    pickDirBtn.type='button';pickDirBtn.disabled=localBusy;
    pickDirBtn.onclick=()=>folderInput.click();
    pickRow.append(pickFileBtn,pickDirBtn);
    dropzone.append(pickRow,el('small','cg-import-hint','也可以直接把 .scs / .sp / .cir 文件拖拽到这里；文件仅在浏览器内存中渲染，连接本机后才同步到本地工作会话。'),fileInput,folderInput);
    body.append(dropzone);

    if(localBundle){
      const box=el('div','cg-import-bundle');
      box.append(el('strong','',`已读取「${localBundle.projectName}」· 共 ${localBundle.candidates.length} 个网表文件`));
      const label=el('label','cg-import-field');
      label.append(el('span','','选择顶层入口网表（其余文件将作为 include 依赖一同保留）'));
      const sel=el('select');
      for(const c of localBundle.candidates){
        sel.append(new Option(`${c.path}  (${formatByteSize(c.size)})`,c.path));
      }
      sel.value=localSelectedEntry||localBundle.defaultEntry;
      sel.onchange=()=>{localSelectedEntry=sel.value;};
      label.append(sel);
      const actions=el('div','cg-welcome-actions');
      const go=el('button','cg-welcome-primary',localBusy?'正在打开…':'导入项目并打开顶层原理图');
      go.type='button';go.disabled=localBusy;go.onclick=()=>void commitLocalBundle();
      const clear=el('button','cg-welcome-btn','重新选择');
      clear.type='button';clear.disabled=localBusy;clear.onclick=()=>{localBundle=null;localSelectedEntry='';render();};
      actions.append(go,clear);
      box.append(label,actions);
      body.append(box);
    }

    const pasteDetails=el('details','cg-import-paste');
    pasteDetails.append(el('summary','','或直接粘贴一段网表文本快速开始'));
    const nameField=el('label','cg-import-field');
    nameField.append(el('span','','文件名'));
    const nameInput=el('input');nameInput.type='text';nameInput.value=localPasteName;nameInput.placeholder='my_circuit.scs';
    nameInput.oninput=()=>{localPasteName=nameInput.value;};
    nameField.append(nameInput);
    const textArea=el('textarea');textArea.rows=6;textArea.placeholder='simulator lang=spectre\nsubckt INV in out vdd vss\n...\nends INV';
    textArea.value=localPasteText;
    textArea.oninput=()=>{localPasteText=textArea.value;};
    const pasteBtn=el('button','cg-welcome-btn','导入粘贴的网表');
    pasteBtn.type='button';pasteBtn.disabled=localBusy;pasteBtn.onclick=()=>void commitPastedNetlist();
    pasteDetails.append(nameField,textArea,pasteBtn);
    body.append(pasteDetails);

    if(localError)body.append(el('p','cg-import-error',localError));
  }

  function renderSshPane(body){
    const connected=Boolean(getConnected());
    if(!connected){
      const box=el('div','cg-import-connect-box');
      box.append(
        el('strong','','请先连接本机连接器以访问你的 SSH 服务器'),
        el('p','','浏览器无法直接发起 SSH 连接。一键授权本机连接器后，CircuitGit 会读取你本机 ~/.ssh/config 中的主机列表，安全只读地浏览服务器目录并导入网表（绝不读取私钥或敏感配置）。'),
      );
      const actions=el('div','cg-welcome-actions');
      if(typeof onConnect==='function'){
        const btn=el('button','cg-welcome-primary','一键授权连接本机（SSH / AI）');
        btn.type='button';
        btn.onclick=()=>{void onConnect();};
        actions.append(btn);
      }
      if(typeof onOpenHub==='function'){
        const setup=el('button','cg-welcome-btn','首次使用？安装或唤起连接器');
        setup.type='button';
        setup.onclick=()=>{dialog?.close();onOpenHub();};
        actions.append(setup);
      }
      box.append(actions);
      body.append(box);
      return;
    }

    const desc=el('p','cg-import-desc','选择你本机 ~/.ssh/config 中已免密配置的 EDA 服务器，浏览目录并选择要协作的网表文件（自动附带同目录下的相对 include 依赖，外部 PDK 模型库保持在远端仿真时再匹配）。');
    body.append(desc);

    const legacyNow=!hasSshImportCapability();
    if(legacyNow&&!sshError){
      const warnBox=el('div','cg-import-error-box');
      warnBox.append(el('p','cg-import-error','检测到你电脑后台运行的是旧版连接器，尚未包含「SSH 远端浏览网表」接口。请更新并重启本机连接器后再点击浏览，或先使用「本地网表 / 文件夹」导入。'));
      const row=el('div','cg-welcome-actions');
      if(typeof onOpenHub==='function'){
        const upd=el('button','cg-welcome-btn','查看更新 / 重启连接器说明');
        upd.type='button';upd.onclick=()=>{dialog?.close();onOpenHub();};
        row.append(upd);
      }
      const alt=el('button','cg-welcome-btn','先使用「本地网表 / 文件夹」导入 →');
      alt.type='button';alt.onclick=()=>{activeTab='local';render();};
      row.append(alt);
      warnBox.append(row);
      body.append(warnBox);
    }

    const hostRow=el('div','cg-import-ssh-row');
    if(sshAliases.length){
      const aliasSel=el('select','cg-import-alias-select');
      aliasSel.setAttribute('aria-label','从本机 SSH 配置选择主机');
      aliasSel.append(new Option('选择 ~/.ssh/config 主机…',''));
      for(const alias of sshAliases)aliasSel.append(new Option(alias,alias));
      aliasSel.value=sshAliases.includes(sshTarget)?sshTarget:'';
      aliasSel.onchange=()=>{if(aliasSel.value){sshTarget=aliasSel.value;sshPath='~';sshCwd='';sshEntries=[];void browseSsh('~');}};
      hostRow.append(aliasSel);
    }
    const hostInput=el('input','cg-import-host-input');
    hostInput.type='text';hostInput.value=sshTarget;hostInput.placeholder='SSH 主机别名或 user@host';
    hostInput.setAttribute('aria-label','SSH 主机名');
    hostInput.oninput=()=>{sshTarget=hostInput.value;};
    hostInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void browseSsh(sshPath||'~');}});
    const browseBtn=el('button','cg-welcome-primary',sshBusy?'浏览中…':'浏览目录');
    browseBtn.type='button';browseBtn.disabled=sshBusy;
    browseBtn.onclick=()=>void browseSsh(sshPath||'~');
    const refreshBtn=el('button','cg-welcome-btn',sshAliasesLoading?'读取中…':'刷新主机');
    refreshBtn.type='button';refreshBtn.disabled=sshAliasesLoading||sshBusy;
    refreshBtn.onclick=()=>void loadAliases();
    hostRow.append(hostInput,browseBtn,refreshBtn);
    body.append(hostRow);

    const pathRow=el('div','cg-import-path-row');
    const upBtn=el('button','cg-welcome-btn','↑ 上级');
    upBtn.type='button';upBtn.disabled=sshBusy||!sshParent;
    upBtn.onclick=()=>{if(sshParent)void browseSsh(sshParent);};
    const pathInput=el('input','cg-import-path-input');
    pathInput.type='text';pathInput.value=sshPath;pathInput.placeholder='~ 或 /home/user/project';
    pathInput.setAttribute('aria-label','远端目录路径');
    pathInput.oninput=()=>{sshPath=pathInput.value;};
    pathInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void browseSsh(sshPath);}});
    const goBtn=el('button','cg-welcome-btn','前往');
    goBtn.type='button';goBtn.disabled=sshBusy;
    goBtn.onclick=()=>void browseSsh(sshPath);
    pathRow.append(upBtn,pathInput,goBtn);
    body.append(pathRow);

    if(sshError){
      const errBox=el('div','cg-import-error-box');
      errBox.append(el('p','cg-import-error',sshError));
      if(sshLegacyConnector){
        const alt=el('button','cg-welcome-btn','先使用「本地网表 / 文件夹」导入 →');
        alt.type='button';
        alt.onclick=()=>{activeTab='local';render();};
        errBox.append(alt);
      }
      body.append(errBox);
    }

    const list=el('div','cg-import-file-list');
    list.setAttribute('role','listbox');
    list.setAttribute('aria-label','远端目录与网表文件');
    if(sshBusy&&!sshEntries.length){
      list.append(el('p','cg-import-empty','正在通过 SSH 读取远端目录…'));
    }else if(!sshCwd&&!sshEntries.length){
      list.append(el('p','cg-import-empty','选择上方 SSH 主机并点击「浏览目录」，即可浏览服务器上的文件夹与网表文件（.scs / .sp / .spice / .cir / .va / .rnl）。'));
    }else if(!sshEntries.length){
      list.append(el('p','cg-import-empty',`目录 ${sshCwd} 下没有子目录或支持的网表文件（.scs / .sp / .cir / .va / .rnl）。可点击「↑ 上级」或直接输入其他路径。`));
    }else{
      for(const entry of sshEntries){
        const row=el('div','cg-import-file-row'+(entry.kind==='dir'?' is-dir':' is-file')+(sshSelectedFile===entry.path?' is-selected':''));
        const mainBtn=el('button','cg-import-file-main');
        mainBtn.type='button';
        mainBtn.append(
          el('span','cg-import-file-icon',entry.kind==='dir'?'📁':'📄'),
          el('span','cg-import-file-name',entry.kind==='dir'?entry.name+'/':entry.name),
          el('span','cg-import-file-meta',entry.kind==='dir'?'目录':formatByteSize(entry.size)),
        );
        if(entry.kind==='dir'){
          mainBtn.onclick=()=>void browseSsh(entry.path);
        }else{
          mainBtn.onclick=()=>{sshSelectedFile=entry.path;render();};
          mainBtn.ondblclick=()=>void importFromSsh(entry.path);
        }
        row.append(mainBtn);
        if(entry.kind==='file'){
          const impBtn=el('button','cg-import-row-action','导入');
          impBtn.type='button';impBtn.disabled=sshBusy;
          impBtn.onclick=()=>void importFromSsh(entry.path);
          row.append(impBtn);
        }
        list.append(row);
      }
    }
    body.append(list);

    if(sshTruncated)body.append(el('small','cg-import-hint','当前目录条目超过 200 项，仅显示前 200 项；可直接输入更具体的子目录路径。'));

    const footer=el('div','cg-import-ssh-footer');
    const depsLabel=el('label','cg-welcome-check');
    const depsCheck=el('input');depsCheck.type='checkbox';depsCheck.checked=sshIncludeDeps;
    depsCheck.onchange=()=>{sshIncludeDeps=depsCheck.checked;};
    depsLabel.append(depsCheck,doc.createTextNode('同时拉取同目录相对 include 依赖（自动跳过外部 PDK 库）'));
    const commitBtn=el('button','cg-welcome-primary',sshBusy?'正在拉取…':'导入选中网表并同步 AI');
    commitBtn.type='button';commitBtn.disabled=sshBusy||!sshSelectedFile;
    commitBtn.onclick=()=>void importFromSsh(sshSelectedFile);
    footer.append(depsLabel,commitBtn);
    body.append(footer);
  }

  function render(){
    if(destroyed||!dialog)return;
    const body=dialog.querySelector('.cg-import-body');
    const tabs=dialog.querySelector('.cg-import-tabs');
    if(!body||!tabs)return;
    tabs.replaceChildren();
    for(const [id,label] of [['local','本地网表 / 文件夹'],['ssh','从 SSH 服务器导入']]){
      const btn=el('button','cg-import-tab'+(activeTab===id?' is-active':''),label);
      btn.type='button';
      btn.setAttribute('role','tab');
      btn.setAttribute('aria-selected',String(activeTab===id));
      btn.onclick=()=>{
        activeTab=id;
        if(id==='ssh'&&getConnected()&&!sshAliasesLoaded)void loadAliases({autoBrowse:false});
        render();
      };
      tabs.append(btn);
    }
    body.replaceChildren();
    if(activeTab==='local')renderLocalPane(body);
    else renderSshPane(body);
  }

  function open(initialTab='local'){
    if(destroyed)return;
    activeTab=initialTab==='ssh'?'ssh':'local';
    if(!dialog){
      dialog=el('dialog','cg-import-dialog');
      dialog.setAttribute('aria-label','导入你自己的电路项目');
      dialog.addEventListener('keydown',e=>e.stopPropagation());
      const head=el('header','cg-import-head');
      head.append(el('strong','','导入你自己的电路项目'));
      const close=el('button','cg-welcome-btn','关闭');
      close.type='button';close.onclick=()=>dialog.close();
      head.append(close);
      const tabs=el('div','cg-import-tabs');
      tabs.setAttribute('role','tablist');
      const body=el('div','cg-import-body');
      dialog.append(head,tabs,body);
      doc.body.append(dialog);
    }
    if(!dialog.open)dialog.showModal();
    if(activeTab==='ssh'&&getConnected()&&!sshAliasesLoaded){
      void loadAliases({autoBrowse:false});
    }
    render();
  }

  return {
    open,
    openLocal:()=>open('local'),
    openSsh:()=>open('ssh'),
    close:()=>dialog?.close(),
    destroy(){
      if(destroyed)return;
      destroyed=true;
      offSub?.();
      dialog?.close();
      dialog?.remove();
    },
  };
}
