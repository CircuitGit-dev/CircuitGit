import {normalizeNative,nativeStatus,sourceSelection,localURL,entryStatus,viewerSourcePath} from './model.js';
import {checkManifest} from '../vendor/rnl-viewer/manifest.js';
export {normalizeNative,nativeStatus,sourceSelection} from './model.js';
export function mount(container,initial){
  let options=initial,model=normalizeNative(initial.payload,location.href),mapping=model.mapping,entry=null,ready=false,rendered=false,destroyed=false,serial=0,pending=null,activeRequest=null,manifestData=null,displayedLevel=null;
  const frame=document.createElement('iframe');frame.title='Native Virtuoso RNL snapshot';frame.style.cssText='width:100%;height:100%;min-height:320px;border:0;background:white';
  const url=new URL('../vendor/rnl-viewer/index.html',import.meta.url);url.searchParams.set('embed','1');url.searchParams.set('native','1');url.searchParams.set('origin',location.origin);url.searchParams.set('grid','none');url.searchParams.set('usages','0');url.searchParams.set('currents','0');const rootEntry=model.geometry.cells?.find(c=>c.id===model.geometry.root_cell)?.entrypoint;if(rootEntry)url.searchParams.set('root-entry',rootEntry);frame.src=url.href;container.replaceChildren(frame);
  const freshness=()=>entryStatus(model,entry,options.sourceHash,{dirty:options.dirty});
  const emit=(fields={})=>{const f=freshness();if(f.nativeReady&&((entry&&entry.id!==model.defaultEntry.id)||(displayedLevel&&displayedLevel!==(model.defaultEntry.level||manifestData?.level)))){f.nativeReady=false;f.state='partial';f.fidelity='unverified-for-selected-cell';}options.onStatus?.({...f,entry:entry?.id,displayedLevel,rendered,entries:model.entries,files:manifestData?.files||[],...fields});};
  const send=message=>frame.contentWindow?.postMessage({rnl:1,...message},location.origin);
  async function open(id){
    const revision=++serial;entry=model.entries.find(e=>e.id===id)||model.defaultEntry;rendered=false;displayedLevel=null;manifestData=null;activeRequest='native-'+revision;pending=null;options.onClear?.();emit({renderState:'loading'});
    try{
      const response=await fetch(entry.manifest,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Native manifest HTTP '+response.status);
      const raw=await response.json();const manifest=checkManifest(raw);for(const file of manifest.files)localURL(file.url||new URL(file.path,manifest.base).href,location.href);
      if(manifest.settings.autoInclude!==false)throw Error('Native manifest must disable automatic package lookup');
      if(revision!==serial||destroyed)return;manifestData=manifest;
      if(model.mappingURL&&!mapping){const result=await fetch(model.mappingURL,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(30000)}).then(r=>{if(!r.ok)throw Error('Mapping HTTP '+r.status);return r.json();});mapping=result.ok===true?result.data:result;}
      if(revision!==serial||destroyed)return;
      pending={type:'open',manifest:entry.manifest,requestId:activeRequest};if(ready)send(pending);
    }catch(error){if(revision===serial)emit({renderState:'error',message:error.message});}
  }
  function receive(event){
    if(event.origin!==location.origin||event.source!==frame.contentWindow||destroyed)return;const m=event.data;
    if(m?.rnl===1){
      if(m.type==='ready'){if(!m.features?.includes('manifest')){emit({renderState:'error',message:'Bundled viewer does not support multi-file manifest'});return;}ready=true;if(pending)send(pending);}
      else if(m.type==='loaded'&&m.requestId===activeRequest){rendered=!m.errors;pending=null;emit({renderState:m.errors?'error':'loaded',levels:m.levels,errors:m.errors,warnings:m.warnings,manifestFiles:manifestData?.files.length});if(rendered){const level=entry.level||manifestData?.level;if(level&&level!=='(top)')send({type:'level',name:level});requestAnimationFrame(()=>send({type:'fit'}));}}
      else if(m.type==='error'&&(!m.requestId||m.requestId===activeRequest)){rendered=false;emit({renderState:'error',message:m.message});}
      else if(m.type==='level'){displayedLevel=m.name;options.onLevel?.({name:m.name,entry:entry?.id});if(rendered)emit({renderState:'loaded'});}
    }else if(m?.ic===1&&m.type==='context'&&rendered){options.onContext?.({navigation:m.navigation,entry_id:entry?.id});
    }else if(m?.ic===1&&m.type==='selection-clear'){options.onClear?.();
    }else if(m?.ic===1&&m.type==='selection'&&rendered){
      const current=freshness();
      // Event paths must be exact members of the active closure, never basename suffixes.
      const resolvedPath=viewerSourcePath(m.source_path,manifestData,m.document_path);
      if(!resolvedPath){options.onClear?.();return;}
      const normalizedContext={...m.context,viewerSourcePath:resolvedPath};
      const context=current.snapshotOnly?{...normalizedContext,occurrencePath:null,occurrenceResolved:false,occurrenceReason:'Independent export has no simulation TB occurrence',occurrenceEvidence:null}:normalizedContext;
      const selected=current.canonicalMappingEnabled?sourceSelection(mapping,{...m,source_path:resolvedPath},options.sourceHash,{allowCanonical:current.sourceMatch&&!current.stale}):null;
      if(selected)options.onSelect?.({...selected,entry_id:entry.id,native:true,context,export_lines:m.lines});
      else options.onUnmapped?.({kind:m.kind,name:m.name,scope:m.scope,entry_id:entry.id,context,export_source_path:resolvedPath,export_lines:m.lines||null,reason:current.snapshotOnly?'Independent export: canonical source mapping disabled':current.stale?'Native snapshot differs from editable source':'No unambiguous exporter mapping to canonical source',readonly:true});
    }
  }
  window.addEventListener('message',receive);void open(initial.entryId||model.defaultEntry.id);
  return {frame,open,entries:model.entries,fit(){send({type:'fit'});},setScope(name){if(!rendered)return false;send({type:'level',name:name==='(top)'?manifestData.entry.split('/').at(-1):name});return true;},update(next){options={...options,...next};if(next.payload){model=normalizeNative(next.payload,location.href);mapping=model.mapping;void open(next.entryId||model.defaultEntry.id);}else emit({renderState:rendered?'loaded':'loading'});},destroy(){destroyed=true;serial++;window.removeEventListener('message',receive);frame.remove();},dispose(){this.destroy();}};
}
