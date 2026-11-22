import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mountAI} from '../../apps/web/ai/ai-panel.js';
import {imageDocument, PNG, tick, until} from './fixtures/image-dom.mjs';

function fixture(t, {sessionId='s1', models, history: initialHistory, imageReply}={}) {
  const document=imageDocument(),previous=globalThis.Option;globalThis.Option=document.Option;t.after(()=>{globalThis.Option=previous;});
  const root=document.createElement('section');document.body.append(root);
  const context={version:1,revision:1,mode:'live',project:{id:'fixture'},file:{dirty:false,currentTextSha256:'hash',persistedSha256:'hash'}};
  const calls=[],catalog={default_model:'vision',models:models||[{id:'vision',model:'vision',displayName:'Vision fixture',inputModalities:['text','image']},{id:'text',displayName:'Text fixture',inputModalities:['text']},{id:'unknown',displayName:'Unknown fixture'}]};
  const state={mode:'success',history:initialHistory||{session_id:sessionId,messages:[],turns:[],state:'idle',cursor:0,pending:[]},images:new Map()};
  async function read(suffix) {
    calls.push({method:'GET',suffix});const url=new URL(suffix,'https://fixture.invalid');
    assert.deepEqual(url.searchParams.getAll('session_id'),[sessionId]);
    if(url.pathname==='/models'){if(state.modelFailure)throw Error('Fixture model directory unavailable');return catalog;}
    if(url.pathname==='/history')return structuredClone(state.history);
    if(url.pathname==='/events')return {events:[],cursor:0,pending:[]};
    if(url.pathname==='/image')return imageReply||{...state.images.get(url.searchParams.get('image_id')),session_id:sessionId};
    assert.fail('Unexpected read '+suffix);
  }
  async function post(path,body) {
    calls.push({method:'POST',path,body:structuredClone(body)});assert.equal(path,'/turn');assert.equal(body.session_id,sessionId);
    if(state.mode==='rejected'){const error=Error('Fixture rejected image');error.data={code:'invalid_image'};throw error;}
    if(state.mode==='preflight-rejected'){const error=Error('Fixture catalog failed before reserving the turn');error.data={code:'image_preflight_rejected'};throw error;}
    if(state.mode==='unknown-empty')throw Error('Fixture response lost before receipt');
    const images=(body.images||[]).map(image=>{const bytes=Buffer.from(image.data_url.split(',')[1],'base64');const descriptor={image_id:createHash('sha256').update(bytes).digest('hex'),name:image.name,mime_type:image.mime_type,bytes:bytes.length,width:1,height:1};state.images.set(descriptor.image_id,{...descriptor,data_url:image.data_url});return descriptor;});
    const receipt={key:body.idempotency_key,state:'complete',thread_id:'fixture-thread',turn_id:'fixture-turn',...(images.length?{images}:{})};
    state.history={...state.history,state:'complete',turns:[...state.history.turns,receipt],messages:[...state.history.messages,{role:'user',request_key:receipt.key,text:body.message,images}]};
    if(state.mode==='unknown-accepted')throw Error('Fixture response lost after receipt');
    return receipt;
  }
  const panel=mountAI(root,{presentation:'clean',sessionId,contextAdapter:{getContext:()=>context,subscribe:()=>()=>{}},getRequest:read,postRequest:post});
  t.after(()=>panel.destroy());panel.setVisible(true);
  const form=root.querySelector('.ic-ai-form'),input=root.querySelector('textarea'),file=root.querySelector('input'),model=root.querySelector('select');
  const previews=()=>root.querySelectorAll('.ic-ai-image-preview');
  const posts=()=>calls.filter(call=>call.method==='POST');
  const add=async(name='fixture.png',type='image/png',bytes=PNG)=>{file.files=[new File([bytes],name,{type})];file.fire('change');await until(()=>!root.textContent.includes('正在准备图片'));await tick();};
  const submit=()=>form.onsubmit({preventDefault(){}});
  const ready=()=>until(()=>!model.disabled);
  return {document,root,panel,form,input,file,model,context,calls,state,previews,posts,add,submit,ready};
}

test('actual panel supports file selection, paste/delete, image-only submission and same-session thumbnails',async t=>{
  const f=fixture(t);await f.ready();await f.add();assert.equal(f.previews().length,1);
  assert.equal(f.root.querySelector('.ic-ai-image-heading').textContent,'待发送图片 · 1/4');
  assert.equal(f.root.querySelector('.ic-ai-image-preview').querySelector('figcaption').textContent,'fixture.png');
  let prevented=false;const pasted=new File([PNG],'pasted.png',{type:'image/png'});
  f.input.fire('paste',{clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:()=>pasted}],getData:()=>''},preventDefault(){prevented=true;},stopPropagation(){}});
  await until(()=>f.previews().length===2);assert.equal(prevented,true);
  await until(()=>f.root.textContent.includes('已粘贴 1 张'));
  assert.equal(f.root.querySelector('.ic-ai-add-image').textContent,'选图 (2)');
  f.root.querySelectorAll('.ic-ai-remove-image')[1].click();assert.equal(f.previews().length,1);
  assert.equal(f.root.querySelector('.ic-ai-image-heading').textContent,'待发送图片 · 1/4');
  await f.submit();await tick();
  assert.equal(f.posts().length,1);const sent=f.posts()[0].body;
  assert.equal(sent.message,'');assert.equal(sent.images.length,1);assert.deepEqual(Object.keys(sent.images[0]).sort(),['data_url','mime_type','name']);
  assert.equal(f.previews().length,0);assert.equal(f.input.value,'');
  assert.ok(f.root.querySelector('.ic-ai-message-images').querySelector('img').src.startsWith('data:image/png;base64,'));
  assert.ok(f.calls.some(call=>call.suffix?.startsWith('/image?image_id=')));
  assert.doesNotMatch(f.root.textContent,/data:image|base64/);
});

test('text-only and unknown models preserve attachments/text and never silently switch or POST',async t=>{
  const f=fixture(t);await f.ready();await f.add();f.input.value='请解释';
  for(const id of ['text','unknown']){
    f.model.value=id;f.model.fire('change');await f.submit();
    assert.equal(f.posts().length,0);assert.equal(f.model.value,id);assert.equal(f.previews().length,1);assert.equal(f.input.value,'请解释');
  }
  assert.match(f.root.textContent,/无法确认所选模型的图片能力/);
});

test('Shift+Enter and IME do not send; Enter submits text plus image once',async t=>{
  const f=fixture(t);await f.ready();await f.add();f.input.value='文字加图';
  const key={key:'Enter',preventDefault(){},stopPropagation(){}};
  f.input.fire('keydown',{...key,shiftKey:true});f.input.fire('compositionstart');f.input.fire('keydown',key);f.input.fire('compositionend');
  f.input.fire('keydown',{...key,isComposing:true});f.input.fire('keydown',{...key,keyCode:229});await tick();assert.equal(f.posts().length,0);
  f.input.fire('keydown',key);await f.form.lastSubmission;assert.equal(f.posts().length,1);assert.equal(f.posts()[0].body.message,'文字加图');
});

test('failure keeps draft and does not generate another POST; reconciliation is read-only',async t=>{
  const f=fixture(t);await f.ready();await f.add();f.input.value='保留文字';f.state.mode='unknown-accepted';
  await f.submit();assert.equal(f.posts().length,1);assert.equal(f.previews().length,1);assert.equal(f.input.value,'保留文字');
  f.state.history.messages.push({id:'answer',item_id:'answer',role:'assistant',request_key:f.posts()[0].body.idempotency_key,text:'图片已收到'});
  assert.equal(f.input.readOnly,true);await f.submit();assert.equal(f.posts().length,1);
  await f.root.querySelector('.ic-ai-image-reconcile').click();await tick();
  assert.equal(f.posts().length,1);assert.equal(f.previews().length,0);assert.equal(f.input.value,'');assert.equal(f.input.readOnly,false);
  assert.equal(f.root.querySelector('.ic-ai-failure-button').hidden,true);
  assert.match(f.root.querySelector('.ic-ai-progress').textContent,/已完成/);
  assert.match(f.root.querySelector('.ic-ai-log').textContent,/图片已收到/);
});

test('explicit server image preflight rejection unlocks retained drafts only after same-session history check',async t=>{
  const f=fixture(t);await f.ready();await f.add();f.input.value='保留预检草稿';f.state.mode='preflight-rejected';await f.submit();
  assert.equal(f.input.readOnly,true);assert.equal(f.state.history.turns.length,0);
  await f.root.querySelector('.ic-ai-image-reconcile').click();
  assert.equal(f.input.readOnly,false);assert.equal(f.input.value,'保留预检草稿');assert.equal(f.previews().length,1);assert.equal(f.posts().length,1);
  assert.match(f.root.textContent,/请求已拒绝/);
});

test('known rejection unlocks only after a history check; unconfirmed outcomes stay preserved and locked',async t=>{
  const f=fixture(t);await f.ready();await f.add();f.input.value='重查但不重发';f.state.mode='rejected';await f.submit();
  await f.root.querySelector('.ic-ai-image-reconcile').click();assert.equal(f.input.readOnly,false);assert.equal(f.previews().length,1);assert.equal(f.input.value,'重查但不重发');assert.equal(f.posts().length,1);
  f.state.mode='unknown-empty';await f.submit();await f.root.querySelector('.ic-ai-image-reconcile').click();
  assert.equal(f.input.readOnly,true);assert.equal(f.previews().length,1);assert.equal(f.posts().length,2);assert.match(f.root.textContent,/发送结果仍未知/);
});

test('separate mounted sessions and hide/show retain their own unsent image/text drafts',async t=>{
  const a=fixture(t,{sessionId:'a'}),b=fixture(t,{sessionId:'b'});await a.ready();await b.ready();
  await a.add('a.png');a.input.value='A';await b.add('b.png');b.input.value='B';
  a.panel.setVisible(false);b.panel.setVisible(false);a.panel.setVisible(true);
  assert.equal(a.input.value,'A');assert.equal(b.input.value,'B');assert.equal(a.previews().length,1);assert.equal(b.previews().length,1);
  a.root.querySelector('.ic-ai-remove-image').click();assert.equal(a.previews().length,0);assert.equal(b.previews().length,1);assert.equal(a.posts().length+b.posts().length,0);
});

test('unsupported local image and missing browser encoding support fail without losing text or sending',async t=>{
  const f=fixture(t);await f.ready();f.input.value='草稿';await f.add('bad.svg','image/svg+xml',Buffer.from('<svg/>'));
  assert.equal(f.previews().length,0);assert.match(f.root.textContent,/不支持 SVG/);
  f.document.defaultView.FileReader=null;await f.add();assert.match(f.root.textContent,/浏览器缺少/);assert.equal(f.input.value,'草稿');assert.equal(f.posts().length,0);
});

test('restored history rejects a thumbnail response from a different session without breaking text',async t=>{
  const descriptor={image_id:'a'.repeat(64),name:'saved.png',mime_type:'image/png',bytes:PNG.length,width:1,height:1};
  const history={session_id:'s1',state:'complete',cursor:0,pending:[],turns:[{key:'old',state:'complete'}],messages:[{role:'user',request_key:'old',text:'历史文字',images:[descriptor]}]};
  const f=fixture(t,{history,imageReply:{...descriptor,session_id:'other',data_url:'data:image/png;base64,'+PNG.toString('base64')}});await f.ready();await tick();
  assert.match(f.root.textContent,/历史文字/);assert.match(f.root.textContent,/图片不可用/);assert.equal(f.posts().length,0);
});

test('oversized context/body is rejected before a POST while preserving attachments',async t=>{
  const f=fixture(t);await f.ready();await f.add();f.context.extra='中'.repeat(800000);f.input.value='保留';await f.submit();
  assert.equal(f.posts().length,0);assert.equal(f.previews().length,1);assert.equal(f.input.value,'保留');assert.match(f.root.textContent,/超过 2 MiB/);
});

test('text-only request keeps its original wire fields and does not append an empty images array',async t=>{
  const f=fixture(t);await f.ready();f.input.value='  原有文字消息  ';await f.submit();
  assert.equal(f.posts().length,1);const body=f.posts()[0].body;
  assert.equal(body.message,'原有文字消息');assert.equal('images' in body,false);assert.equal('model' in body,false);
  assert.deepEqual(Object.keys(body).sort(),['context','idempotency_key','message','session_id']);assert.equal(f.input.value,'');
});

test('catalog refresh failure with an image never replaces the selected model',async t=>{
  const f=fixture(t);await f.ready();await f.add();f.model.value='text';f.model.fire('change');f.state.modelFailure=true;
  const refresh=f.document.body.querySelectorAll('button').find(button=>button.textContent==='刷新模型目录');await refresh.click();
  assert.equal(f.model.value,'text');assert.equal(f.model.disabled,true);assert.equal(f.previews().length,1);assert.equal(f.posts().length,0);
});

test('uncertain text-only send retains its explicit model across failed and missing-ID catalog refreshes',async t=>{
  const models=[{id:'vision',model:'vision',displayName:'Vision fixture',inputModalities:['text','image']},{id:'text',displayName:'Text fixture',inputModalities:['text']}];
  const f=fixture(t,{models});await f.ready();f.model.value='text';f.model.fire('change');f.input.value='未确认的文字草稿';f.state.mode='unknown-empty';await f.submit();
  assert.equal(f.previews().length,0);assert.equal(f.input.readOnly,true);
  const sent=f.posts()[0].body,key=sent.idempotency_key;
  assert.equal(sent.model,'text');
  const refresh=f.document.body.querySelectorAll('button').find(button=>button.textContent==='刷新模型目录');
  f.state.modelFailure=true;await refresh.click();
  assert.equal(f.model.value,'text');assert.deepEqual(f.model.children.map(option=>option.value),['text']);
  assert.match(f.root.textContent,/原模型和草稿已保留/);assert.equal(f.model.disabled,true);
  f.state.modelFailure=false;models.pop();await refresh.click();
  assert.equal(f.model.value,'text');assert.ok(f.model.children.some(option=>option.value==='text'&&option.textContent.includes('保留原选择')));
  assert.equal(f.input.value,'未确认的文字草稿');assert.equal(f.input.readOnly,true);assert.equal(f.model.disabled,true);
  await f.submit();assert.equal(f.posts().length,1);assert.equal(f.posts()[0].body.idempotency_key,key);assert.equal(f.posts()[0].body.model,'text');
});
