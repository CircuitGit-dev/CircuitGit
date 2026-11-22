// Browser acceptance fixture; uses real Chrome/Canvas and synthetic gateway responses.
// All page assets and gateway requests are fixtures. No backend, account or model request is made.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const arg=process.argv.indexOf('--playwright-module');
const {chromium}=await import(arg>=0?pathToFileURL(process.argv[arg+1]).href:'playwright');
const report={status:'starting',checks:[],errors:[],kind:'synthetic image / fake gateway browser fixture'};
if(process.env.EVIDENCE_DIR)await mkdir(process.env.EVIDENCE_DIR,{recursive:true});
const origin='https://ic-images-fixture.test';
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:1000,height:800}});
page.on('pageerror',error=>report.errors.push(error.message));
await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){report.errors.push('Unexpected network origin');await route.abort();return;}
  if(url.pathname==='/'){
    await route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/src/studio/ai/style.css"><link rel="stylesheet" href="/src/studio/dockview/style.css">
    <style>body{margin:20px;font-family:system-ui}.host{width:min(760px,100%);height:520px;border:1px solid #ccc}[hidden]{display:none!important}</style>
    <body class="ic-dockview"><button id="a">会话 A</button><button id="b">会话 B</button><button id="hide">隐藏 AI</button><button id="show">显示 AI</button>
    <section class="host" id="one"></section><section class="host" id="two" hidden></section>
    <script type="module">
    import {mountAI} from '/src/ai/ai-panel.js';
    window.calls=[];window.mode='success';window.active='a';window.panels={};window.saved={};
    const context={version:1,revision:1,mode:'live',project:{id:'fixture'},file:{dirty:false,currentTextSha256:'hash',persistedSha256:'hash'}};
    const catalog={default_model:'vision',models:[{id:'vision',model:'vision',displayName:'Vision fixture',inputModalities:['text','image']},{id:'text',model:'text',displayName:'Text fixture',inputModalities:['text']},{id:'unknown',displayName:'Unknown fixture'}]};
    for(const [id,element] of [['a',document.querySelector('#one')],['b',document.querySelector('#two')]]){
      const state={session_id:id,messages:[],turns:[],state:'idle',cursor:0,pending:[],events:[],images:{}};saved[id]=state;
      const root=document.createElement('div');root.className='ic-ai-studio';element.append(root);
      const panel=mountAI(root,{presentation:'clean',sessionId:id,contextAdapter:{getContext:()=>context,subscribe:()=>()=>{}},getRequest:async path=>{
        const url=new URL(path,location.href);if(url.searchParams.getAll('session_id').length!==1||url.searchParams.get('session_id')!==id)throw Error('Wrong image session');
        calls.push({method:'GET',path});
        if(url.pathname==='/models')return catalog;
        if(url.pathname==='/development')return {available:false,workspace:null,reason:'Fixture not configured'};
        if(url.pathname==='/history')return {session_id:id,messages:state.messages,turns:state.turns,state:state.state,cursor:state.cursor,pending:[]};
        if(url.pathname==='/events')return {events:state.events.filter(e=>e.sequence>Number(url.searchParams.get('after')||0)),pending:[]};
        if(url.pathname==='/image')return {...state.images[url.searchParams.get('image_id')],session_id:id};
        throw Error('Unexpected fixture GET');
      },postRequest:async(path,body)=>{
        if(path!=='/turn'||body.session_id!==id)throw Error('Unexpected fixture POST');
        calls.push({method:'POST',path,body:structuredClone(body)});
        if(mode==='rejected'){const error=Error('Synthetic rejection');error.data={code:'invalid_image'};throw error;}
        const images=[];
        for(const image of body.images||[]){const bytes=Uint8Array.from(atob(image.data_url.split(',')[1]),c=>c.charCodeAt(0));const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');const bitmap=await createImageBitmap(new Blob([bytes],{type:image.mime_type}));const descriptor={image_id:hash,name:image.name,mime_type:image.mime_type,bytes:bytes.length,width:bitmap.width,height:bitmap.height};bitmap.close();images.push(descriptor);state.images[hash]={...descriptor,data_url:image.data_url};}
        const receipt={key:body.idempotency_key,state:'complete',thread_id:'fixture-thread-'+id,turn_id:'fixture-turn-'+calls.length,...(images.length?{images}:{})};
        state.turns.push(receipt);state.messages.push({role:'user',request_key:receipt.key,text:body.message,images});state.state='complete';
        state.events.push({sequence:++state.cursor,request_key:receipt.key,method:'turn/completed',params:{turn:{id:receipt.turn_id,status:'completed',durationMs:1}}});
        if(mode==='unknown-accepted')throw Error('Synthetic lost reply');return receipt;
      }});
      const composer=root.querySelector('.ic-ai-form'),details=document.createElement('div');details.className='ic-ai-dock-details';
      for(const child of [...root.children])if(child!==composer)details.append(child);root.insertBefore(details,composer);panels[id]=panel;
    }
    const select=id=>{panels[active].setVisible(false);document.querySelector(active==='a'?'#one':'#two').hidden=true;active=id;document.querySelector(id==='a'?'#one':'#two').hidden=false;panels[id].setVisible(true);};
    document.querySelector('#a').onclick=()=>select('a');document.querySelector('#b').onclick=()=>select('b');
    document.querySelector('#hide').onclick=()=>{panels[active].setVisible(false);document.querySelector(active==='a'?'#one':'#two').hidden=true;};
    document.querySelector('#show').onclick=()=>{document.querySelector(active==='a'?'#one':'#two').hidden=false;panels[active].setVisible(true);};
    select('a');window.ready=true;
    </script></html>`});return;
  }
  if(!url.pathname.startsWith('/src/')){await route.abort();return;}
  const source=resolve(root,'apps/web',url.pathname.slice(5));
  if(!source.startsWith(resolve(root,'apps/web')+sep)){await route.abort();return;}
  await route.fulfill({contentType:source.endsWith('.css')?'text/css':'text/javascript',body:await readFile(source)});
});
try{
  await page.goto(origin);await page.waitForFunction(()=>window.ready);
  const host=page.locator('#one'),input=host.getByRole('textbox',{name:'发送给电路助手的消息'}),model=host.getByRole('combobox',{name:'下一条消息的模型',includeHidden:true});
  await model.locator('option[value="vision"]').waitFor({state:'attached'});
  const data=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=128;c.height=64;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,128,64);x.fillStyle='red';x.fillRect(12,12,32,32);x.fillStyle='black';x.fillText('fixture 42',50,35);return c.toDataURL('image/png');});
  const file={name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')};
  await host.locator('input[type=file]').setInputFiles(file);await host.locator('.ic-ai-image-preview').waitFor();
  await input.fill('草稿 A');await page.locator('#hide').click();await page.locator('#show').click();assert.equal(await input.inputValue(),'草稿 A');
  await page.locator('#b').click();assert.equal(await page.locator('#two .ic-ai-image-preview').count(),0);await page.locator('#a').click();assert.equal(await host.locator('.ic-ai-image-preview').count(),1);
  report.checks.push('image and text draft survive hide and remain isolated from the other session');
  await input.evaluate((node,data)=>{const bytes=Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'paste.png',{type:'image/png'}));transfer.setData('text/plain','\n第二行\n第三行\n第四行');node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));},data);
  await page.waitForFunction(()=>document.querySelectorAll('#one .ic-ai-image-preview').length===2);
  assert.equal(await input.evaluate(node=>node.getBoundingClientRect().height),92);
  await host.getByText('已粘贴 1 张',{exact:true}).waitFor();
  assert.equal(await host.locator('.ic-ai-image-heading').innerText(),'待发送图片 · 2/4');
  const tray=await host.locator('.ic-ai-attachments').boundingBox();assert(tray.width>150&&tray.height>80,'Draft thumbnails must remain visible under real Dockview styles');
  assert.equal(await host.locator('.ic-ai-image-preview figcaption').first().innerText(),'synthetic.png');
  if(process.env.EVIDENCE_DIR)await page.screenshot({path:resolve(process.env.EVIDENCE_DIR,'images-draft.png')});
  await host.locator('.ic-ai-remove-image').nth(1).click();assert.equal(await host.locator('.ic-ai-image-preview').count(),1);
  await host.getByRole('button',{name:'AI设置'}).click();
  for(const id of ['text','unknown']){await model.selectOption(id);await input.press('Enter');await page.waitForFunction(()=>!document.querySelector('#one textarea').readOnly);assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='POST').length),0);assert.equal(await model.inputValue(),id);}
  report.checks.push('image+text paste expands to four lines; paste/remove and unsupported or unknown model capabilities preserve drafts without POST or model switching');
  await model.selectOption('vision');await host.getByRole('button',{name:'AI设置'}).click();await input.press('Shift+Enter');
  await input.evaluate(node=>{node.dispatchEvent(new CompositionEvent('compositionstart'));node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));node.dispatchEvent(new CompositionEvent('compositionend'));});
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='POST').length),0);
  await input.fill('');await input.press('Enter');await page.waitForFunction(()=>document.querySelectorAll('#one .ic-ai-image-preview').length===0);
  await page.waitForFunction(()=>document.querySelector('#one .ic-ai-message-images img')?.naturalWidth>0);
  await page.waitForFunction(()=>panels.a.getState().phase==='complete');
  report.checks.push('IME/Shift+Enter do not submit; image-only Enter submits and displays its same-session history thumbnail');
  await host.locator('input[type=file]').setInputFiles(file);await input.fill('保持失败草稿');await page.evaluate(()=>window.mode='unknown-accepted');await input.press('Enter');
  await host.getByRole('button',{name:'核对发送结果',exact:true}).waitFor();assert.equal(await input.inputValue(),'保持失败草稿');assert.equal(await host.locator('.ic-ai-image-preview').count(),1);
  const count=await page.evaluate(()=>calls.filter(c=>c.method==='POST').length);await host.getByRole('button',{name:'核对发送结果',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('#one .ic-ai-image-preview').length===0);assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='POST').length),count);
  assert.equal(await host.locator('.ic-ai-failure-button').isVisible(),false);
  assert.match(await host.locator('.ic-ai-progress').last().innerText(),/已完成/);
  report.checks.push('lost response preserves text/image; explicit history reconciliation clears only after same-key confirmation without another POST');
  const converted=await page.evaluate(async()=>{const {prepareImage}=await import('/src/ai/images.js');const c=document.createElement('canvas');c.width=5000;c.height=10;c.getContext('2d').fillRect(0,0,5000,10);const blob=await new Promise(resolve=>c.toBlob(resolve,'image/webp'));const value=await prepareImage(new File([blob],'wide.webp',{type:blob.type}),{document});return {width:value.width,height:value.height,mime:value.mime_type,bytes:value.bytes};});
  assert(converted.width<=4096&&converted.height<=4096&&converted.bytes<=1048576);assert(['image/png','image/jpeg'].includes(converted.mime));
  report.checks.push('real Canvas resizes overwide WebP and emits bounded PNG/JPEG');
  report.posts=await page.evaluate(()=>calls.filter(c=>c.method==='POST').map(c=>({session:c.body.session_id,imageCount:c.body.images?.length||0,hasText:Boolean(c.body.message),bytes:new TextEncoder().encode(JSON.stringify(c.body)).length})));
  assert(report.posts.every(post=>post.bytes<=2097152));assert.deepEqual(report.errors,[]);
  if(process.env.EVIDENCE_DIR)await page.screenshot({path:resolve(process.env.EVIDENCE_DIR,'images-desktop.png')});
  for(const width of [400,260]){
    await page.setViewportSize({width,height:800});
    const bounds=await host.evaluate(element=>{const form=element.querySelector('.ic-ai-form'),box=element.getBoundingClientRect();return {host:{left:box.left,right:box.right},input:form.querySelector('textarea').getBoundingClientRect().width,controls:[...form.querySelectorAll('button,select,textarea')].filter(n=>n.getClientRects().length).map(n=>{const b=n.getBoundingClientRect();return {left:b.left,right:b.right};})};});
    assert(bounds.input>=Math.min(160,width-64),'Narrow dock must retain a usable input');
    assert(bounds.controls.every(b=>b.left>=bounds.host.left&&b.right<=bounds.host.right),'Composer controls must stay inside the dock');
    if(process.env.EVIDENCE_DIR)await page.screenshot({path:resolve(process.env.EVIDENCE_DIR,`images-narrow-${width}.png`)});
  }
  report.checks.push('400px and 260px narrow layouts retain usable input and visible controls');
  report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;}
finally{if(process.env.EVIDENCE_DIR)await writeFile(resolve(process.env.EVIDENCE_DIR,'images-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
