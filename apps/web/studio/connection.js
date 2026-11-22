import {mount as mountConnections} from './agent-connections/index.js';

export async function mount(host){
  const controller=mountConnections(host);
  try{controller.updateConnection(await host.gateway.request('/ai/connection',{timeout:5000}));}
  catch{controller.updateConnection(undefined);}
  return controller;
}
