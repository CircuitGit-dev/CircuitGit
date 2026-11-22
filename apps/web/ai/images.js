export const IMAGE_LIMITS = Object.freeze({count: 4, totalBytes: 1048576, side: 4096, pixels: 16777216, bodyBytes: 2097152, sourceBytes: 20971520});
const TYPES = new Set(['image/png', 'image/jpeg']);

export function imageName(name, mime) {
  const cleaned = Array.from(String(name || '图片').replace(/[\/\\\u0000-\u001f\u007f]/g, '_')).slice(0, 150).join('');
  return cleaned.replace(/\.(png|jpe?g|webp)$/i, '') + (mime === 'image/jpeg' ? '.jpg' : '.png');
}

export function imageDataBytes(dataUrl, mime) {
  if (!TYPES.has(mime) || typeof dataUrl !== 'string' || !dataUrl.startsWith(`data:${mime};base64,`)) throw Error('图片必须是本地 PNG 或 JPEG。');
  const body = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (!body || body.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) throw Error('图片编码无效。');
  const bytes = body.length / 4 * 3 - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0);
  if (bytes > IMAGE_LIMITS.totalBytes) throw Error('图片总大小不能超过 1 MiB，请缩小图片。');
  if (btoa(atob(body)) !== body) throw Error('图片编码不是规范 base64。');
  return bytes;
}

export function imageModelError(models, defaultModel, selected) {
  models = Array.isArray(models) ? models.filter(model => model && typeof model === 'object') : [];
  const choices = selected ? models.filter(model => model.id === selected) :
    models.filter(model => model.id === defaultModel || model.model === defaultModel);
  if (choices.length !== 1 || !Array.isArray(choices[0].inputModalities)) return '无法确认所选模型的图片能力，请刷新目录并明确选择支持图片的模型。';
  return choices[0].inputModalities.includes('image') ? '' : '所选模型不支持图片。请手动选择支持图片的模型，或移除图片；不会自动切换模型。';
}

export function checkImageRequest(body) {
  const images = body.images || [];
  if (!Array.isArray(images) || images.length > IMAGE_LIMITS.count) throw Error('每条消息最多添加 4 张图片。');
  let bytes = 0;
  for (const image of images) {
    if (typeof image?.name !== 'string' || !image.name || [...image.name].length > 160 || /[\/\\\u0000-\u001f\u007f]/.test(image.name)) throw Error('图片名称无效。');
    bytes += imageDataBytes(image.data_url, image.mime_type);
  }
  if (bytes > IMAGE_LIMITS.totalBytes) throw Error('图片总大小不能超过 1 MiB，请缩小或移除图片。');
  if (typeof body.message !== 'string' || [...body.message].length > 24000) throw Error('消息不能超过 24,000 个字符。');
  if (!body.message.trim() && !images.length) throw Error('请填写文字或添加图片。');
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > IMAGE_LIMITS.bodyBytes) throw Error('文字、图片和项目上下文合计超过 2 MiB，请缩小图片或减少文字。');
}

function blobDataURL(blob, view) {
  return new Promise((resolve, reject) => {
    const reader = new view.FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error('无法读取图片文件。')); reader.readAsDataURL(blob);
  });
}

async function decodeImage(file, view) {
  if (typeof view.createImageBitmap === 'function') {
    const bitmap = await view.createImageBitmap(file);
    return {image: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close()};
  }
  const url = view.URL.createObjectURL(file), image = new view.Image();
  try {
    await new Promise((resolve, reject) => {image.onload = resolve; image.onerror = reject; image.src = url;});
    return {image, width: image.naturalWidth, height: image.naturalHeight, dispose: () => view.URL.revokeObjectURL(url)};
  } catch { view.URL.revokeObjectURL(url); throw Error('浏览器无法解码这张图片。'); }
}

export async function prepareImage(file, {document, maxBytes = IMAGE_LIMITS.totalBytes} = {}) {
  const view = document?.defaultView;
  if (!view?.FileReader || !view?.URL?.createObjectURL || !document.createElement('canvas').toBlob) throw Error('此浏览器缺少图片读取或 Canvas 编码能力。请使用支持这些功能的浏览器。');
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Error('只支持本地 PNG、JPEG 或 WebP 图片；不支持 SVG 和外部网址。');
  if (!file.size || file.size > IMAGE_LIMITS.sourceBytes) throw Error('原始图片不能为空或超过 20 MiB，请先缩小后再添加。');
  const magic = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const valid = file.type === 'image/png' ? [137,80,78,71,13,10,26,10].every((n,i) => magic[i] === n) :
    file.type === 'image/jpeg' ? magic[0] === 255 && magic[1] === 216 && magic[2] === 255 :
    [82,73,70,70].every((n,i) => magic[i] === n) && [87,69,66,80].every((n,i) => magic[i+8] === n);
  if (!valid) throw Error('图片内容与文件类型不匹配。');
  let source;
  try {source = await decodeImage(file, view);} catch {throw Error('图片已损坏，或此浏览器无法解码。');}
  try {
    if (!source.width || !source.height || source.width * source.height > 67108864) throw Error('原始图片尺寸过大，请先缩小后再添加。');
    const scale = Math.min(1, IMAGE_LIMITS.side / source.width, IMAGE_LIMITS.side / source.height);
    let width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
    let blob = file;
    if (scale < 1 || !TYPES.has(file.type) || file.size > maxBytes) {
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
      if (!context) throw Error('浏览器 Canvas 不可用。');
      const encode = (mime, quality) => new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error('图片编码失败。')), mime, quality));
      let fitted = false;
      for (let step = 0; step < 7 && !fitted; step++) {
        canvas.width = width; canvas.height = height;
        context.clearRect(0, 0, width, height); context.drawImage(source.image, 0, 0, width, height);
        blob = await encode('image/png');
        if (blob.size <= maxBytes) {fitted = true; break;}
        // JPEG fallback uses a white background to preserve transparent diagram strokes.
        context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); context.drawImage(source.image, 0, 0, width, height);
        for (const quality of [0.9, 0.75, 0.55]) {
          blob = await encode('image/jpeg', quality);
          if (blob.size <= maxBytes) {fitted = true; break;}
        }
        if (!fitted) {width = Math.max(1, Math.floor(width * 0.7)); height = Math.max(1, Math.floor(height * 0.7));}
      }
      canvas.width = canvas.height = 1;
      if (!fitted) throw Error('图片压缩后仍超过剩余 1 MiB 配额，请移除图片或使用更小的文件。');
    }
    if (!TYPES.has(blob.type) || blob.size > maxBytes) throw Error('浏览器未能生成符合大小限制的 PNG/JPEG 图片。');
    return Object.freeze({name: imageName(file.name, blob.type), mime_type: blob.type, data_url: await blobDataURL(blob, view), bytes: blob.size, width, height, converted: blob !== file});
  } finally {source.dispose();}
}

export function createImageDraft({prepare, onChange = () => {}}) {
  let items = [], busy = false, locked = false, destroyed = false, revision = 0, error = '';
  const getState = () => ({items: [...items], busy, locked, error, bytes: items.reduce((sum, item) => sum + item.bytes, 0)});
  const publish = () => {if (!destroyed) onChange(getState());};
  return Object.freeze({getState,
    async add(files) {
      if (destroyed || busy || locked) return;
      const batch = Array.from(files);
      if (!batch.length) return;
      if (items.length + batch.length > IMAGE_LIMITS.count) {error = '每条消息最多添加 4 张图片。';publish();return;}
      busy = true; error = '';const ticket = ++revision; publish();
      try {
        const prepared = [];let remaining = IMAGE_LIMITS.totalBytes - getState().bytes;
        for (const file of batch) {const image = await prepare(file, remaining); if (destroyed || ticket !== revision) return; remaining -= image.bytes; if (remaining < 0) throw Error('图片合计超过 1 MiB。');prepared.push(image);}
        items = [...items, ...prepared];
      } catch (cause) {if (!destroyed && ticket === revision) error = cause.message || '无法添加图片。';}
      finally {if (!destroyed && ticket === revision) {busy = false;publish();}}
    },
    remove(index) {if (!destroyed && !busy && !locked) {items = items.filter((_, i) => i !== index);error = '';publish();}},
    lock(value) {if(locked === Boolean(value))return;locked = Boolean(value);publish();},
    clear() {items = [];error = '';++revision;busy = false;publish();},
    destroy() {destroyed = true;++revision;items = [];}
  });
}

export function historyImageValid(descriptor, response, sessionId) {
  if (!descriptor || !/^[a-f0-9]{64}$/.test(descriptor.image_id) || response?.session_id !== sessionId || response.image_id !== descriptor.image_id ||
      response.mime_type !== descriptor.mime_type || response.bytes !== descriptor.bytes || response.width !== descriptor.width || response.height !== descriptor.height || !TYPES.has(response.mime_type) ||
      !Number.isInteger(response.width) || !Number.isInteger(response.height) || response.width < 1 || response.height < 1 ||
      response.width > IMAGE_LIMITS.side || response.height > IMAGE_LIMITS.side || response.width * response.height > IMAGE_LIMITS.pixels) return false;
  try {return imageDataBytes(response.data_url, response.mime_type) === response.bytes;} catch {return false;}
}
