import test from 'node:test';
import assert from 'node:assert/strict';
import {whenVisible} from '../../apps/web/studio/lazy-slot.js';
function slot(shown=false){const listeners=new Set();return {isVisible:()=>shown,onVisibility(fn){listeners.add(fn);return()=>listeners.delete(fn);},show(value){shown=value;for(const fn of listeners)fn(value);}};}
test('closed panels do no work, concurrent opening mounts once, subsequent toggles retain state',async()=>{
  const target=slot();let count=0,release;const result={draft:'kept'},gate=new Promise(r=>release=r);
  const loader=whenVisible(target,async()=>{count++;await gate;return result;});await Promise.resolve();assert.equal(count,0);
  target.show(true);target.show(false);target.show(true);const a=loader.ensure(),b=loader.ensure();release();assert.equal(await a,result);assert.equal(await b,result);assert.equal(count,1);
  target.show(false);target.show(true);await loader.ensure();assert.equal(count,1);loader.dispose();
});
test('failure is retained until explicit retry; hiding does not silently retry',async()=>{
  const target=slot(true);let count=0;const errors=[];
  const loader=whenVisible(target,()=>{if(++count===1)throw Error('offline');return 'ready';},{onError:e=>errors.push(e.message)});
  await assert.rejects(loader.ensure(),/offline/);target.show(false);target.show(true);await assert.rejects(loader.ensure(),/offline/);assert.equal(count,1);
  assert.equal(await loader.retry(),'ready');assert.deepEqual(errors,['offline']);assert.equal(count,2);
});
