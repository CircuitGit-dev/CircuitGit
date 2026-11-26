// Pure source-snapshot resolver and patcher for multi-file RNL documents.
// Handles relative Document.files[].path values (via sourcePath) and library alias closures
// so schematic edits apply reliably to both top-level cells and descended subcircuits.

export function resolveDocFilePath(doc,file){
  if(!file?.path)return doc?.path||'/circuit.scs';
  const raw=String(file.path).replaceAll('\\','/');
  if(/^(?:[A-Za-z]:\/|\/|<)/.test(raw))return raw;
  const entry=String(doc?.path||'').replaceAll('\\','/');
  if(!entry||!entry.includes('/'))return '/'+raw.replace(/^\/+/,'');
  const parts=(entry.slice(0,entry.lastIndexOf('/')+1)+raw).split('/');
  const out=[];
  for(const part of parts){
    if(part==='.')continue;
    if(part==='..'&&out.length&&out.at(-1)!=='..')out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function resolveCanonicalFilePath(resolvedPath,aliases=null){
  const norm=String(resolvedPath||'').startsWith('/')?String(resolvedPath):'/'+String(resolvedPath||'').replace(/^\/+/,'');
  if(!aliases||typeof aliases!=='object')return norm;
  const rel=norm.replace(/^\/+/,'');
  if(Object.hasOwn(aliases,rel)&&typeof aliases[rel]==='string'){
    return '/'+aliases[rel].replace(/^\/+/,'');
  }
  return norm;
}

export function patchSourceSnapshot(baseSource,{
  doc=null,
  fileIndex=0,
  targetPath='',
  rawPath='',
  nextText='',
  aliases=null,
}={}){
  const effectiveAliases=aliases||baseSource?.aliases||null;
  const resolved=targetPath||(doc?.files?.[fileIndex]?resolveDocFilePath(doc,doc.files[fileIndex]):baseSource?.path||'/circuit.scs');
  const canonical=resolveCanonicalFilePath(resolved,effectiveAliases);
  const canonRel=canonical.replace(/^\/+/,'');

  const snap=Object.create(null);
  if(baseSource?.snapshot){
    for(const [k,v] of Object.entries(baseSource.snapshot))snap[k]=v;
  }
  if(doc?.files){
    for(const f of doc.files){
      if(!f||typeof f.text!=='string')continue;
      const p=resolveDocFilePath(doc,f);
      if(p&&!Object.hasOwn(snap,p))snap[p]=f.text;
    }
  }

  const updateKeys=new Set([resolved,canonical]);
  if(fileIndex===0&&baseSource?.path)updateKeys.add(baseSource.path);
  if(effectiveAliases&&typeof effectiveAliases==='object'){
    for(const [logical,target] of Object.entries(effectiveAliases)){
      if(typeof target==='string'&&target.replace(/^\/+/,'')===canonRel){
        updateKeys.add('/'+logical.replace(/^\/+/,''));
      }
    }
  }
  if(rawPath&&Object.hasOwn(snap,rawPath))updateKeys.add(rawPath);
  const relResolved=resolved.replace(/^\/+/,'');
  if(Object.hasOwn(snap,relResolved))updateKeys.add(relResolved);

  for(const k of updateKeys)snap[k]=nextText;

  const filesMap=new Map();
  if(baseSource?.files instanceof Map){
    for(const [k,v] of baseSource.files.entries())filesMap.set(k,v);
  }
  for(const [k,v] of Object.entries(snap)){
    filesMap.set(k,()=>new Blob([v],{type:'text/plain'}));
  }

  const entryPath=baseSource?.path||doc?.path||resolved;
  const entryText=Object.hasOwn(snap,entryPath)?snap[entryPath]:nextText;
  const nextSource={
    ...baseSource,
    name:baseSource?.name||doc?.name||'circuit.scs',
    path:entryPath,
    aliases:effectiveAliases||undefined,
    snapshot:snap,
    files:filesMap,
    open:async()=>({path:entryPath,text:Object.hasOwn(snap,entryPath)?snap[entryPath]:entryText}),
    read:async requested=>{
      if(Object.hasOwn(snap,requested))return snap[requested];
      if(typeof baseSource?.read==='function')return baseSource.read(requested);
      return null;
    },
  };
  if(baseSource&&baseSource.text!==undefined){
    nextSource.text=entryText;
  }else{
    delete nextSource.text;
  }
  return {nextSource,resolvedPath:resolved,canonicalPath:canonical,updatedKeys:[...updateKeys]};
}
