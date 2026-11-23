// Bounded JSON for user-authored metadata. Reject duplicate keys before an
// edit can silently erase one, including escaped spellings of the same key.
export function parseEnvironmentJson(text,{objectOnly=true,maxBytes=1024*1024}={}){
  if(typeof text!=='string'||new TextEncoder().encode(text).length>maxBytes)throw Error('JSON 内容超过允许大小。');
  const value=JSON.parse(text);
  if(objectOnly&&(!value||Array.isArray(value)||typeof value!=='object'))throw Error('配置必须是 JSON 对象。');
  const stack=[];
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(char==='"'){
      let end=index+1;
      for(;end<text.length;end++){if(text[end]==='\\'){end++;continue;}if(text[end]==='"')break;}
      const top=stack.at(-1);
      if(top?.keys&&top.key){const key=JSON.parse(text.slice(index,end+1));if(top.keys.has(key))throw Error('重复 JSON 字段：'+key);top.keys.add(key);top.key=false;}
      index=end;
    }else if(char==='{')stack.push({keys:new Set(),key:true});
    else if(char==='[')stack.push({});
    else if(char==='}'||char===']')stack.pop();
    else if(char===','&&stack.at(-1)?.keys)stack.at(-1).key=true;
  }
  return value;
}
