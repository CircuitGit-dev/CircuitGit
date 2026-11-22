import test from 'node:test';
import assert from 'node:assert/strict';
import {IMAGE_LIMITS, imageName, imageDataBytes, imageModelError, checkImageRequest, createImageDraft, historyImageValid} from '../../apps/web/ai/images.js';

const data = (bytes = 10) => `data:image/png;base64,${Buffer.alloc(bytes, 1).toString('base64')}`;
const image = bytes => ({name: 'fixture.png', mime_type: 'image/png', data_url: data(bytes), bytes, width: 10, height: 10});
const body = (images = []) => ({message: images.length ? '' : 'hello', session_id: 's1', context: {}, idempotency_key: 'test-key', ...(images.length ? {images: images.map(({name,mime_type,data_url})=>({name,mime_type,data_url}))} : {})});

test('model capabilities are explicit for both selected and effective default models', () => {
  const models = [{id:'vision-id',model:'vision',inputModalities:['text','image']},{id:'text',inputModalities:['text']},{id:'unknown'}];
  assert.equal(imageModelError(models, 'vision', ''), '');
  assert.equal(imageModelError(models, null, 'vision-id'), '');
  assert.match(imageModelError(models, 'vision', 'text'), /不支持图片/);
  assert.match(imageModelError(models, 'vision', 'unknown'), /无法确认/);
  assert.match(imageModelError(models, null, ''), /无法确认/);
  assert.match(imageModelError([...models, {...models[0],id:'other'}], 'vision', ''), /无法确认/);
});

test('wire limit validates decoded bytes and serialized body including session/context', () => {
  assert.doesNotThrow(() => checkImageRequest(body([image(IMAGE_LIMITS.totalBytes)])));
  assert.throws(() => checkImageRequest(body([image(600000),image(600000)])), /1 MiB/);
  assert.throws(() => checkImageRequest(body(Array(5).fill(image(10)))), /4 张/);
  assert.throws(() => checkImageRequest({...body(),message:''}), /文字或添加图片/);
  assert.throws(() => checkImageRequest({...body(),message:'中'.repeat(24001)}), /24,000/);
  assert.throws(() => checkImageRequest({...body([image(IMAGE_LIMITS.totalBytes)]),context:{payload:'中'.repeat(300000)}}), /2 MiB/);
  assert.doesNotThrow(() => checkImageRequest(body()));
});

test('external URLs, SVG, MIME mismatch and malformed base64 cannot become image input', () => {
  for (const [url,mime] of [['https://external.invalid/a.png','image/png'],['data:image/svg+xml;base64,AAAA','image/svg+xml'],[data(),'image/jpeg'],['data:image/png;base64,ab=c','image/png']]) {
    assert.throws(() => imageDataBytes(url,mime));
  }
  assert.equal(imageName('../unsafe\\name\n.webp','image/png'), '.._unsafe_name_.png');
  assert.ok([...imageName('文'.repeat(200),'image/jpeg')].length <= 160);
});

test('drafts are independent, limited and batch preparation never partially mutates a draft on error', async () => {
  const prepare=async (file,maxBytes)=>{if(file==='bad')throw Error('bad image');assert.ok(maxBytes<=IMAGE_LIMITS.totalBytes);return image(file);};
  const a=createImageDraft({prepare}),b=createImageDraft({prepare});
  await a.add([10]);await b.add([20]);
  await a.add([30,'bad']);
  assert.deepEqual(a.getState().items.map(item=>item.bytes),[10]);
  assert.deepEqual(b.getState().items.map(item=>item.bytes),[20]);
  assert.equal(a.getState().error,'bad image');
  a.lock(true);a.remove(0);await a.add([40]);assert.equal(a.getState().items.length,1);
  a.lock(false);a.remove(0);assert.equal(a.getState().items.length,0);
  await b.add([1,2,3,4]);assert.match(b.getState().error,/4 张/);assert.equal(b.getState().items.length,1);
  a.destroy();b.destroy();
});

test('destruction prevents a late decoder from restoring images', async () => {
  let resolve;const preparing=new Promise(done=>{resolve=done;});
  const draft=createImageDraft({prepare:()=>preparing});const pending=draft.add([1]);draft.destroy();resolve(image(10));await pending;
  assert.equal(draft.getState().items.length,0);
});

test('history thumbnails require the exact session, image ID, MIME and byte size', () => {
  const descriptor={image_id:'a'.repeat(64),name:'fixture.png',mime_type:'image/png',bytes:10,width:10,height:10};
  const response={...descriptor,session_id:'s1',data_url:data()};
  assert.equal(historyImageValid(descriptor,response,'s1'),true);
  assert.equal(historyImageValid(descriptor,response,'s2'),false);
  for(const patch of [{image_id:'b'.repeat(64)},{mime_type:'image/jpeg'},{bytes:11},{width:4097},{data_url:'https://external.invalid/p.png'}]) {
    assert.equal(historyImageValid(descriptor,{...response,...patch},'s1'),false);
  }
});
