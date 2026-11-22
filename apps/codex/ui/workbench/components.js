import {mount as schematic} from '../schematic/index.js';
import {mount as waveforms} from '../waveforms/index.js';
import {mount as simulation} from '../simulation/index.js';

const components={schematic,waveforms,simulation};

export async function mountPanel(root,descriptor,host){
  if(!components[descriptor.kind])throw Error('Unknown workbench component');
  const scoped=host.componentHost(descriptor);
  const adapter=Object.freeze({...scoped,
    get initial(){return scoped.initial;},get view(){return scoped.view;},
    get capabilities(){return scoped.capabilities;},get hostContext(){return scoped.hostContext;},
    assetURL:host.assetURL,assetText:host.assetText,assetBytes:host.assetBytes,
  });
  let component;
  try{component=await components[descriptor.kind](root,adapter);}
  catch(error){scoped.dispose();throw error;}
  let disposed=false;
  return {
    ready:component.ready,
    beforeClose:async()=>{if(!disposed)await component.beforeClose?.();},
    setVisible:visible=>{if(!disposed)component.setVisible?.(visible);},
    resize:()=>{if(!disposed)component.resize?.();},
    dispose(){if(disposed)return;disposed=true;try{component.dispose();}finally{scoped.dispose();}},
  };
}
