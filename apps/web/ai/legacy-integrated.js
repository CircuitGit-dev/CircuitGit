/** Consumes UI owner's actual phase4-context public API v1. No app state adapter here. */
import '../app.js';
import {mountAI} from './ai-panel.js';

const adapter = window.ICWorkbenchContext;
const host = document.querySelector('.results-panel');
if (!adapter || !['getContext','subscribe','readSelection'].every(k=>typeof adapter[k]==='function')) {
  console.error('IC AI requires the UI phase4-context API v1; component was not mounted.');
} else if (host && !document.querySelector('#ai-panel')) {
  const panel=document.createElement('section');panel.id='ai-panel';panel.setAttribute('aria-label','电路 AI 助手');
  host.insertAdjacentElement('afterend',panel);
  mountAI(panel,{contextAdapter:adapter});
}
