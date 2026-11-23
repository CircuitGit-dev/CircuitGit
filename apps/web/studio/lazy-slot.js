/** One mount per panel lifetime. Visibility changes never discard drafts or remount the renderer. */
export function whenVisible(slot,mount,{onError=()=>{}}={}){
  let task=null,disposed=false;
  const ensure=()=>{
    if(disposed)return Promise.reject(Error('Panel loader disposed'));
    if(!task)task=Promise.resolve().then(mount).catch(error=>{onError(error);throw error;});
    return task;
  };
  const activate=shown=>{if(shown)void ensure().catch(()=>{});};
  const unsubscribe=slot.onVisibility?.(activate);
  if(slot.isVisible())activate(true);
  return {ensure,retry(){task=null;return ensure();},dispose(){disposed=true;unsubscribe?.();}};
}
