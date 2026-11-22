import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlotController} from '../../apps/web/studio/plot/controller.js';
import {CHANNEL,bindingOf,probeReason,validEnvelope,validState,copyContext} from '../../apps/web/studio/plot/protocol.js';
const origin='http://localhost:8123';
const initial=()=>({version:1,revision:2,mode:'live',loadState:'ready',loading:false,project:{id:'p',sourceCommit:'a'},run:{runId:'r1',sourceCommit:'b'},file:{path:'circuit.scs',currentTextSha256:'1'.repeat(64),dirty:false},geometry:{sourceMatch:true,state:'partial',canonicalMappingEnabled:true,bundleCommit:'g',manifestSha256:'2'.repeat(64)},selection:{kind:'net',name:'VINP',mappingVerified:true,targetKind:'canonical'}});
function setup(){
 let ctx=initial(),callback,listener,time=10,n=0,block=false,exit=0,interval;
 const sent=[],notices=[],windows=[];
 const win={location:{origin,href:origin+'/vendor/rnl-viewer/index.html'},crypto:{randomUUID:()=>`id-${String(++n).padStart(20,'0')}`},
  addEventListener:(type,fn)=>listener=fn,removeEventListener(){},setInterval:fn=>(interval=fn,1),clearInterval(){},
  open(url,name){if(block)return null;const p={url,name,closed:false,focus(){},postMessage(m,o){sent.push({m,o});}};windows.push(p);return p;}};
 const adapter={getContext:()=>ctx,subscribe:fn=>(callback=fn,()=>{})};
 const c=createPlotController({contextAdapter:adapter,hostWindow:win,notify:(...a)=>notices.push(a),clock:()=>time,exitMode:()=>{exit++;c.setPlotMode('none');}});
 let cs=0,child='child-000000000000001';
 const incoming=(kind,extra={},eventExtra={})=>{const p=windows.at(-1),ids=Object.fromEntries(new URL(p.url).hash.slice(1).split('&').map(x=>x.split('=')));listener({origin,source:p,data:{channel:CHANNEL,...ids,child,seq:++cs,kind,...extra},...eventExtra});};
 const handshake=()=>{incoming('ready');incoming('ack',{revision:ctx.revision,binding:bindingOf(ctx)});};
 return {c,sent,notices,windows,incoming,handshake,get ctx(){return ctx;},update(patch){ctx={...ctx,...patch};callback(ctx);},block(v){block=v;},tick(ms){time+=ms;interval();},get exit(){return exit;},changeChild(){child='child-000000000000002';cs=0;}};
}
test('open is synchronous, real handle only; normal selection never emits a probe',()=>{
 const f=setup();const result=f.c.openWindow();assert.equal(result.opened,true);assert.equal(typeof result.then,'undefined');f.handshake();f.c.onSelection(f.ctx);assert(!f.sent.some(x=>x.m.intent==='probe'));assert.equal(f.c.getState().windowState,'ready');f.c.destroy();
});
test('blocked popup preserves a valid pending probe then replays once on user reopen',()=>{
 const f=setup();f.block(true);assert.equal(f.c.openWindow().opened,false);f.c.setPlotMode('voltage');f.c.onSelection(f.ctx);assert(f.c.getState().pending);f.block(false);f.c.openWindow();f.handshake();assert.equal(f.sent.filter(x=>x.m.intent==='probe').length,1);assert(!f.c.getState().pending);f.c.destroy();
});
test('pending probe expires on revision/project/run/source update',()=>{
 for(const patch of [{revision:3},{project:{id:'other'}},{run:{runId:'r2'}},{file:{currentTextSha256:'2'.repeat(64)}}]){
  const f=setup();f.block(true);f.c.openWindow();f.c.setPlotMode('voltage');f.c.onSelection(f.ctx);f.update({...patch,revision:3});assert(!f.c.getState().pending);f.block(false);f.c.openWindow();f.handshake();assert(!f.sent.some(x=>x.m.intent==='probe'));f.c.destroy();
 }
});
test('origin, source, sender, session, child and sequence reject forged or old messages',()=>{
 const f=setup();f.c.openWindow();const p=f.windows[0],ids=Object.fromEntries(new URL(p.url).hash.slice(1).split('&').map(x=>x.split('=')));
 for(const patch of [{origin:'https://other.test'},{source:{}},{data:{channel:CHANNEL,...ids,child:'child-000000000000001',seq:1,kind:'ready',session:'wrong-session-123456'}}])f.incoming('ready',{},patch);
 assert.equal(f.sent.length,0);f.handshake();const count=f.sent.length;f.incoming('ready',{seq:1});assert.equal(f.sent.length,count);f.c.destroy();
});
test('closed window and fresh session never pretend previous curves survive',()=>{
 const f=setup();f.c.openWindow();f.handshake();const previous=f.windows[0].url;f.windows[0].closed=true;f.tick(2000);assert.equal(f.c.getState().windowState,'closed');f.c.openWindow();assert.notEqual(f.windows[1].url,previous);assert.equal(f.c.getState().windowState,'opening');f.c.destroy();
});
test('Esc request is bound to current context; exiting cancels pending plotting',()=>{
 const f=setup();f.c.openWindow();f.handshake();f.c.setPlotMode('current');f.incoming('exit',{revision:1,binding:bindingOf(f.ctx)});assert.equal(f.exit,0);f.incoming('exit',{revision:f.ctx.revision,binding:bindingOf(f.ctx)});assert.equal(f.exit,1);assert.equal(f.c.getState().mode,'none');f.c.destroy();
});
test('instance current requires device; net current, dirty and snapshot source fail closed',()=>{
 const c=initial();assert.equal(probeReason(c,'voltage'),null);assert(probeReason(c,'current'));assert(probeReason({...c,file:{...c.file,dirty:true}},'voltage'));assert(probeReason({...c,geometry:{...c.geometry,snapshotOnly:true}},'voltage'));assert.equal(probeReason({...c,selection:{...c.selection,kind:'instance',name:'VDD0'}},'current'),null);
});
test('state validates exact binding/revision and context copy drops non-public credentials',()=>{
 const ctx=initial(),base={kind:'state',intent:'probe',mode:'voltage',context:ctx,revision:ctx.revision,binding:bindingOf(ctx)};assert(validState(base));assert(!validState({...base,revision:4}));assert(!validState({...base,binding:{...base.binding,runId:'other'}}));assert(!('token' in copyContext({...ctx,token:'not-public'})));
});
