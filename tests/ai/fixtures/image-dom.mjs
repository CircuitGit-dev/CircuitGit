// Minimal browser API fixture: no browser process, network, account or model access.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=', 'base64');
export function imageDocument() {
  const doc = {};
  class Node {
    constructor(tag) {this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.dataset={};this.attributes={};this.listeners={};this.className='';this.value='';this.hidden=false;this.disabled=false;this.open=false;this._text='';this.selectionStart=0;this.selectionEnd=0;}
    get classList() {const node=this;return {add(...names){const set=new Set(node.className.split(' ').filter(Boolean));names.forEach(n=>set.add(n));node.className=[...set].join(' ');},remove(...names){node.className=node.className.split(' ').filter(n=>!names.includes(n)).join(' ');},contains(name){return node.className.split(' ').includes(name);},toggle(name,force){const next=force??!this.contains(name);next?this.add(name):this.remove(name);return next;}};}
    set textContent(value) {this._text=String(value??'');this.replaceChildren();}
    get textContent() {return this._text+this.children.map(child=>child.textContent).join('');}
    get childNodes() {return this.children;}
    get firstChild() {return this.children[0]||null;}
    get lastElementChild() {return this.children.at(-1)||null;}
    append(...nodes) {for(let node of nodes){if(typeof node==='string')node=doc.createTextNode(node);node.remove();node.parentElement=this;this.children.push(node);}}
    prepend(...nodes) {for(const node of nodes.reverse())this.insertBefore(node,this.firstChild);}
    insertBefore(node,before) {if(before===null){this.append(node);return;}node.remove();const index=this.children.indexOf(before);if(index<0)throw Error('Invalid insertBefore fixture parent');node.parentElement=this;this.children.splice(index,0,node);}
    replaceChildren(...nodes) {for(const child of this.children)child.parentElement=null;this.children=[];this.append(...nodes);}
    remove() {if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}}
    setAttribute(key,value) {this.attributes[key]=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);}
    getAttribute(key) {return this.attributes[key]??null;}
    addEventListener(type,callback) {(this.listeners[type] ||= []).push(callback);}
    removeEventListener(type,callback) {this.listeners[type]=(this.listeners[type]||[]).filter(item=>item!==callback);}
    fire(type,event={}) {if(type==='click'&&this.disabled)return;for(const callback of this.listeners[type]||[])callback(event);return this['on'+type]?.(event);}
    matches(selector) {if(selector.startsWith('.'))return selector.slice(1).split('.').every(name=>this.classList.contains(name));if(selector.startsWith('[')){const [,key,value]=/^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(selector)||[];return value===undefined?this.getAttribute(key)!==null:this.getAttribute(key)===value;}return this.tagName===selector.toUpperCase();}
    querySelectorAll(selector) {return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
    querySelector(selector) {return this.querySelectorAll(selector)[0]||null;}
    focus() {doc.activeElement=this;}
    click() {return this.fire('click');}
    showModal() {this.open=true;}
    close() {this.open=false;this.fire('close');}
    scrollIntoView() {}
    setRangeText(text,start,end) {this.value=this.value.slice(0,start)+text+this.value.slice(end);this.selectionStart=this.selectionEnd=start+text.length;}
    requestSubmit() {this.lastSubmission=this.onsubmit?.({preventDefault(){}});}
  }
  doc.createElement=tag=>{
    const node=new Node(tag);
    if(tag==='canvas'){node.getContext=()=>({clearRect(){},drawImage(){},fillRect(){}});node.toBlob=(callback,mime)=>callback(new Blob([PNG],{type:mime}));}
    return node;
  };
  doc.createTextNode=text=>{const node=new Node('#text');node.textContent=text;return node;};
  doc.createDocumentFragment=()=>new Node('#fragment');
  doc.body=new Node('body');
  doc.defaultView={URL,FileReader:class {readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result=`data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;this.onload?.();}).catch(()=>this.onerror?.());}},createImageBitmap:async()=>({width:1,height:1,close(){}})};
  doc.Option=function(text,value){const node=new Node('option');node.textContent=text;node.value=value;return node;};
  return doc;
}

export const tick = () => new Promise(resolve=>setImmediate(resolve));
export async function until(check) {for(let i=0;i<50;i++){if(check())return;await tick();}throw Error('Fixture condition did not settle');}
