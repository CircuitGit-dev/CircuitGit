import {mountWaveformPanel} from './panel.js';
// Called by the sole integrator AFTER the web owner's context hook is published.
// This module owns no application state and never modifies editor or native geometry.
export function installWaveforms(contextAdapter=window.ICWorkbenchContext){
  if(!contextAdapter?.getContext||!contextAdapter?.subscribe)throw Error('ICWorkbenchContext must be installed first');
  const existing=document.getElementById('ic-waveform-panel');
  if(existing)throw Error('Waveform panel is already mounted');
  if(!document.querySelector('link[data-ic-waveforms]')){
    const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./panel.css',import.meta.url).href;link.dataset.icWaveforms='';document.head.append(link);
  }
  const section=document.createElement('section');section.id='ic-waveform-panel';
  const anchor=document.querySelector('.results-panel');
  if(anchor)anchor.after(section);else (document.querySelector('main')||document.body).append(section);
  const handle=mountWaveformPanel(section,{contextAdapter});
  return {...handle,destroy(){handle.destroy();section.remove();}};
}
