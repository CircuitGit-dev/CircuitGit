import {createImageDraft, prepareImage, historyImageValid} from './images.js';

export function mountImageComposer({form, row, input, onChange = () => {}}) {
  const document = form.ownerDocument;
  const make = (tag, className, text = '') => {const node=document.createElement(tag);node.className=className;node.textContent=text;return node;};
  const area=make('div','ic-ai-attachments'), heading=make('strong','ic-ai-image-heading'), previews=make('div','ic-ai-image-previews'), note=make('p','ic-ai-image-note');
  area.setAttribute('role','group');area.setAttribute('aria-label','待发送图片');note.setAttribute('role','status');note.setAttribute('aria-live','polite');
  area.append(heading,previews,note);form.prepend(area);
  const file=document.createElement('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.multiple=true;file.hidden=true;
  const choose=make('button','ic-ai-add-image','选图');choose.type='button';choose.setAttribute('aria-label','添加图片');choose.title='PNG/JPEG/WebP，最多 4 张；上传合计 1 MiB';
  row.insertBefore(choose,input);row.append(file);
  let message='', feedback='', messageError=false, disposed=false;
  const draft=createImageDraft({prepare:(value,maxBytes)=>prepareImage(value,{document,maxBytes}),onChange:render});
  function render(state) {
    if(disposed)return;
    choose.disabled=state.locked||state.busy;file.disabled=choose.disabled;
    choose.textContent=state.items.length?`选图 (${state.items.length})`:'选图';
    heading.textContent=state.items.length?`待发送图片 · ${state.items.length}/4`:'正在添加图片';
    heading.hidden=!state.items.length&&!state.busy;
    previews.replaceChildren();
    state.items.forEach((item,index)=>{
      const figure=make('figure','ic-ai-image-preview'),img=document.createElement('img'),caption=make('figcaption','',item.name),remove=make('button','ic-ai-remove-image','×');
      img.src=item.data_url;img.alt=item.name;img.title=`${item.name} · ${item.width}×${item.height}`;
      caption.title=item.name;
      remove.type='button';remove.setAttribute('aria-label',`移除图片 ${index+1}：${item.name}`);remove.disabled=state.locked||state.busy;remove.onclick=()=>{feedback='';draft.remove(index);};
      figure.append(img,caption,remove);previews.append(figure);
    });
    note.textContent=state.error||message||(state.busy?'正在准备图片…':state.items.length?`${feedback||'图片已添加，可继续输入或发送'}${state.items.some(item=>item.converted)?' · 已缩放或转码':''}`:'');
    note.classList.toggle('error',Boolean(state.error)||messageError);area.hidden=!state.items.length&&!note.textContent;
    onChange(state);
  }
  async function addFiles(files,verb){
    message='';feedback='';messageError=false;const before=draft.getState().items.length;
    await draft.add(files);if(disposed)return;
    const state=draft.getState(),added=state.items.length-before;
    if(!state.error&&added>0)feedback=`${verb} ${added} 张`;
    render(state);
  }
  choose.onclick=()=>file.click();
  file.onchange=()=>{void addFiles(Array.from(file.files),'已添加');file.value='';};
  const paste=event=>{
    let files=Array.from(event.clipboardData?.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
    if(!files.length)files=Array.from(event.clipboardData?.files||[]).filter(file=>file.type.startsWith('image/'));
    if(!files.length)return;
    event.preventDefault();event.stopPropagation();
    const state=draft.getState();if(state.locked||state.busy)return;
    void addFiles(files,'已粘贴');
    const text=event.clipboardData.getData('text/plain');if(text)input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');
  };
  input.addEventListener('paste',paste);render(draft.getState());
  return Object.freeze({getState:draft.getState,lock:draft.lock,clear(){message='';feedback='';messageError=false;draft.clear();},
    message(text,error=false){message=text;messageError=error;render(draft.getState());},
    destroy(){disposed=true;draft.destroy();input.removeEventListener('paste',paste);area.remove();choose.remove();file.remove();}
  });
}

export function createImageHistory({document, sessionId, read, alive}) {
  const cache=new Map();
  return function appendImages(target, descriptors, drafts = false) {
    if(!Array.isArray(descriptors)||!descriptors.length)return;
    const strip=document.createElement('div');strip.className='ic-ai-message-images';target.append(strip);
    for(const descriptor of descriptors.slice(0,4)){
      const figure=document.createElement('figure'),img=document.createElement('img'),label=document.createElement('figcaption');
      img.alt=typeof descriptor?.name==='string'?descriptor.name:'图片';label.textContent=img.alt;figure.append(img,label);strip.append(figure);
      img.onload=()=>figure.classList.add('loaded');img.onerror=()=>{img.remove();label.textContent='图片不可用';};
      if(drafts){img.src=descriptor.data_url;continue;}
      const id=descriptor?.image_id;
      if(!/^[a-f0-9]{64}$/.test(id||'')){img.remove();label.textContent='图片不可用';continue;}
      label.textContent='正在读取图片…';
      if(!cache.has(id))cache.set(id,read('/image?image_id='+encodeURIComponent(id)));
      cache.get(id).then(value=>{
        if(!alive())return;
        if(!historyImageValid(descriptor,value,sessionId))throw Error('Invalid image response');
        img.src=value.data_url;label.textContent=img.alt;
      }).catch(()=>{if(alive()){img.remove();label.textContent='图片不可用';}});
    }
  };
}
