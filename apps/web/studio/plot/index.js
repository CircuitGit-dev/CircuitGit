import {createPlotController} from './controller.js';
export {createPlotController} from './controller.js';
export function mount(host){
  if(host.version!==1||!host.context?.subscribe||!host.plot?.attach)throw Error('RNL Studio host v1 required');
  if(host.slots.waveforms)return import('../dockview/waveforms.js').then(module=>module.mount(host));
  const controller=createPlotController({contextAdapter:host.context,notify:(text,options)=>host.notify(text,options),exitMode:()=>host.plot.setMode('none')});
  const detach=host.plot.attach(controller);
  return {controller,destroy(){detach?.();controller.destroy();}};
}
