// Read only Document identities and actual visits; never infer routes or pins from coordinates.
const matches=(path,file)=>typeof path==='string'&&typeof file==='string'&&path===file;
const scope=(doc,o)=>doc.levels.find(l=>l.host===o.level)?.kind==='file'?'(top)':o.level_title;
const sourcePath=(doc,o,index)=>doc.files[o.lines?.[0]??doc.spans.find(s=>s.object===index&&s.kind!=='ref')?.file]?.path??null;
export function navigationMetadata(doc,path,current,rootEntry){
  const fail=reason=>({occurrencePath:null,occurrenceResolved:false,occurrenceReason:reason,occurrenceEvidence:null});
  if(!doc||!rootEntry||!matches(doc.files?.[doc.levels?.[0]?.lines?.[0]??0]?.path,rootEntry))return fail('Direct cell entry is not the simulation TB root');
  if(!path.length||path[0].level!==0||doc.levels[0]?.kind!=='file'||path[0].via!==null)return fail('Navigation does not begin at the TB file root');
  const names=[],steps=[];
  for(let i=1;i<path.length;i++){
    const previous=doc.levels[path[i-1].level],next=doc.levels[path[i].level],via=path[i].via;
    if(!previous||!next||typeof via!=='string')return fail('Navigation contains an unresolved or cross-document step');
    const candidates=doc.objects.map((o,index)=>({o,index})).filter(({o})=>o.kind==='instance'&&o.level===previous.host&&o.name===via&&o.opens===path[i].level);
    if(candidates.length!==1)return fail('Navigation step lacks one matching parent instance');
    const {o,index}=candidates[0];names.push(o.name);steps.push({name:o.name,scope:scope(doc,o),viewerSourcePath:sourcePath(doc,o,index),fromLevel:previous.title,toLevel:next.title});
  }
  if(path.at(-1).level!==current)return fail('Navigation is changing');
  return {occurrencePath:names,occurrenceResolved:true,occurrenceReason:null,occurrenceEvidence:{kind:'validated-viewer-visits',rootEntry,namespace:'native-export',steps}};
}
export function selectionMetadata(doc,path,current,index,rootEntry){
  const o=doc?.objects[index];if(!o||!['instance','net','usage'].includes(o.kind))return null;
  let navigation=navigationMetadata(doc,path,current,rootEntry);
  if(doc.levels[current]?.host!==o.level)navigation={occurrencePath:null,occurrenceResolved:false,occurrenceReason:'Selection is outside the displayed occurrence',occurrenceEvidence:null};
  // occurrencePath is the parent occurrence; the selected device remains in name.
  const terminalOptions=[];
  for(const usage of o.usages||[])for(const role of usage.roles||[]){
    if(typeof role.terminal!=='string'||typeof role.member!=='string')continue;
    const marker=role.member.lastIndexOf(':');if(marker<0)continue;
    const owner=role.member.slice(0,marker),index=role.member.slice(marker+1);
    if(o.kind==='instance'&&owner!=='#'+o.name)continue;
    if(!/^\d+$/.test(index))continue;
    if(!terminalOptions.some(t=>t.member===role.member&&t.name===role.terminal))terminalOptions.push({name:role.terminal,index:Number(index),member:role.member,evidence:'Document usage role'});
  }
  const terminalName=o.kind==='usage'&&terminalOptions.length===1?terminalOptions[0].name:null;
  return {...navigation,terminalName,terminalReason:terminalName?null:'Object/net selection does not identify a unique clicked terminal',terminalOptions,netName:o.kind==='net'?o.name:null,busBit:null,busBitReason:'No explicit scalar bus-bit identity in Document',viewerSourcePath:sourcePath(doc,o,index)};
}
