import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pairLocal,
  LOCAL_CONNECTOR,
  probeLocalConnector,
  wakeLocalConnector,
  saveSessionGrant,
  loadSessionGrant,
  clearSessionGrant,
} from '../../apps/web/remote/pair.js';
import {buildInstallCommand,sanitizeInstallDir} from '../../apps/web/studio/workspace-hub.js';

function fixture(blocked=false){
  let listener;const timers=new Map();let timer=0;
  const popup={closed:false,close(){this.closed=true;}};
  const state='0123456789abcdef0123456789abcdef';
  const win={crypto:{randomUUID:()=>state},location:{origin:'https://example.github.io'},
    addEventListener(t,fn){listener=fn;},removeEventListener(){listener=null;},
    open(url){win.opened=url;return blocked?null:popup;},
    setTimeout(fn){timers.set(++timer,fn);return timer;},clearTimeout(id){timers.delete(id);},
    setInterval(fn){timers.set(++timer,fn);return timer;},clearInterval(id){timers.delete(id);}};
  const send=(type,extra={},override={})=>listener?.({origin:LOCAL_CONNECTOR,source:popup,data:{type,state,...extra},...override});
  return {win,popup,timers,send};
}
test('pairs only with the opened local window, exact origin and request state',async()=>{
  const f=fixture();let ready=0;const flow=pairLocal({win:f.win,onReady:()=>ready++});
  assert(f.win.opened.startsWith(LOCAL_CONNECTOR+'/connect?'));
  f.send('circuitgit.local.ready',{}, {origin:'https://evil.example'});
  f.send('circuitgit.local.ready',{}, {source:{}});
  f.send('circuitgit.local.ready',{state:'wrong'});assert.equal(ready,0);
  f.send('circuitgit.local.ready');assert.equal(ready,1);
  f.send('circuitgit.local.result',{allowed:true,accessCode:'x'.repeat(43),endpoint:'https://evil.example'});
  assert.deepEqual(await flow.result,{url:LOCAL_CONNECTOR,accessCode:'x'.repeat(43)});
  assert(f.popup.closed);assert.equal(f.timers.size,0);
});
test('blocked popup, cancellation, timeout and denial never yield a credential',async()=>{
  const blocked=fixture(true);await assert.rejects(pairLocal({win:blocked.win}).result,/阻止/);
  const cancelled=fixture(),a=pairLocal({win:cancelled.win});a.cancel();await assert.rejects(a.result,/取消/);
  const missing=fixture(),b=pairLocal({win:missing.win});missing.timers.get(1)();await assert.rejects(b.result,/未检测到/);
  const denied=fixture(),c=pairLocal({win:denied.win});denied.send('circuitgit.local.ready');denied.send('circuitgit.local.result',{allowed:false});await assert.rejects(c.result,/取消/);
});

test('probeLocalConnector and wakeLocalConnector handle ready, legacy 403/400, wakeup, and missing states',async()=>{
  assert.equal(await probeLocalConnector({fetcher:async()=>({ok:true,status:200,json:async()=>({ok:true,data:{ready:true}})})}),true);
  assert.equal(await probeLocalConnector({fetcher:async()=>({ok:false,status:403,json:async()=>({ok:false,error:{code:'forbidden',message:'Invalid node access code'}})})}),true);
  assert.equal(await probeLocalConnector({fetcher:async()=>({ok:false,status:400,json:async()=>({ok:false,error:{code:'invalid_request',message:'Unknown node read route'}})})}),true);
  assert.equal(await probeLocalConnector({fetcher:async()=>({ok:false,status:500,json:async()=>({ok:false})})}),false);
  assert.equal(await probeLocalConnector({fetcher:async()=>{throw Error('refused');}}),false);

  let probes=0,iframeSrc='';
  const fakeWin={document:{createElement:()=>({style:{},setAttribute(){},remove(){},set src(v){iframeSrc=v;}}),body:{append(){}}},setTimeout:(fn)=>fn()};
  const woken=await wakeLocalConnector({win:fakeWin,timeout:200,interval:10,fetcher:async()=>{probes++;return probes>=2?{ok:true,json:async()=>({ok:true,data:{ready:true}})}:{ok:false};}});
  assert.deepEqual(woken,{status:'ready',alreadyRunning:false});
  assert.equal(iframeSrc,'circuitgit://start');

  const missing=await wakeLocalConnector({win:fakeWin,timeout:40,interval:10,fetcher:async()=>{throw Error('down');}});
  assert.deepEqual(missing,{status:'missing',alreadyRunning:false});
});

test('session grant round-trips in tab storage and clears cleanly',()=>{
  const map=new Map();
  const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  const token='a'.repeat(43);
  assert.equal(saveSessionGrant({url:LOCAL_CONNECTOR,accessCode:token},storage),true);
  assert.deepEqual(loadSessionGrant(storage),{url:LOCAL_CONNECTOR,accessCode:token});
  assert.equal(saveSessionGrant({url:'https://evil.example',accessCode:token},storage),false);
  clearSessionGrant(storage);
  assert.equal(loadSessionGrant(storage),null);
});

test('buildInstallCommand generates safe macOS/Linux and Windows one-liners with custom install path',()=>{
  assert.equal(
    buildInstallCommand({isWindows:false,dir:'~/CircuitGit',autostart:false}),
    'curl -fsSL https://circuitgit-dev.github.io/CircuitGit/install.sh | bash'
  );
  assert.equal(
    buildInstallCommand({isWindows:false,dir:'/Users/alice/EDA/CircuitGit',autostart:true}),
    'curl -fsSL https://circuitgit-dev.github.io/CircuitGit/install.sh | CIRCUITGIT_DIR="/Users/alice/EDA/CircuitGit" CIRCUITGIT_AUTOSTART=1 bash'
  );
  assert.equal(
    buildInstallCommand({isWindows:true,dir:'D:\\Tools\\CircuitGit',autostart:true}),
    "$env:CIRCUITGIT_DIR='D:\\Tools\\CircuitGit'; $env:CIRCUITGIT_AUTOSTART='1'; irm https://circuitgit-dev.github.io/CircuitGit/install.ps1 | iex"
  );
  assert.equal(sanitizeInstallDir('~/ok; rm -rf /',false),'~/CircuitGit');
  assert.equal(sanitizeInstallDir('C:\\bad$(whoami)',true),'%USERPROFILE%\\CircuitGit');
});
