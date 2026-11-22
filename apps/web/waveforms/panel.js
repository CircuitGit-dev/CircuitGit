// Browser transport adapter; the shared panel has no gateway or popup dependency.
import {mountWaveformPanel as mountPanel} from '../../../modules/waveforms/panel.js';
import {waveformAPI} from './api.js';
export {engineering} from '../../../modules/waveforms/panel.js';
export function mountWaveformPanel(root,options={}) {
  return mountPanel(root,{...options,api:options.api||waveformAPI()});
}
