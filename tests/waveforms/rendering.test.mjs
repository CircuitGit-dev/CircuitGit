import test from 'node:test';
import assert from 'node:assert/strict';
import {displayEnvelope,frameScheduler} from '../../modules/waveforms/rendering.js';
test('pixel envelope preserves narrow positive and negative spikes in time order',()=>{
 const points=Array.from({length:100000},(_,i)=>[i,0]);points[19999][1]=42;points[20000][1]=-31;points[90001][1]=100;
 const shown=displayEnvelope(points,10000,30000,300);
 assert(shown.length<=604);assert(shown.includes(points[19999]));assert(shown.includes(points[20000]));assert(!shown.includes(points[90001]));
 for(let i=1;i<shown.length;i++)assert(shown[i][0]>shown[i-1][0]);
 assert.equal(points.length,100000);assert.equal(points[90001][1],100);
});
test('sparse and nonuniform time axes keep boundary neighbours; off-data window remains empty',()=>{
 const points=[[0,0],[.00001,20],[.001,-10],[4,1],[5,2]];
 assert.deepEqual(displayEnvelope(points,.01,3,100),[[.001,-10],[4,1]]);
 assert.deepEqual(displayEnvelope(points,7,8,100),[]);assert.deepEqual(displayEnvelope(points,-2,-1,100),[]);
 assert.deepEqual(displayEnvelope(points,0,5,300),points);
});
test('multiple frame requests draw once; disposing cancels pending work',()=>{
 let next=0,draws=0;const pending=new Map();const scheduler=frameScheduler(()=>draws++,fn=>{pending.set(++next,fn);return next;},id=>pending.delete(id));
 for(let i=0;i<100;i++)scheduler.schedule();assert.equal(pending.size,1);
 const callbacks=[...pending.values()];pending.clear();callbacks.forEach(fn=>fn());assert.equal(draws,1);
 scheduler.schedule();scheduler.dispose();assert.equal(pending.size,0);scheduler.schedule();assert.equal(pending.size,0);
});
