import test from 'node:test';
import assert from 'node:assert/strict';
import {reference,referenceWindow} from '../../apps/web/demo/reference.js';
test('reference respects causality and the closed-form constant-input RC response',()=>{
  const p=reference();assert.equal(p.vout[0][1],0);
  assert(p.vout.filter(([t])=>t<1e-9).every(([,v])=>Math.abs(v)<1e-12));
  const at=t=>p.vout.find(([x])=>Math.abs(x-t)<1e-20)[1];
  assert(Math.abs((1-at(3e-9))/(1-at(2e-9))-Math.exp(-1))<1e-10);
  assert(p.vout.every(([,v])=>Number.isFinite(v)&&v>=-1e-10&&v<=1+1e-10));
  p.ir.forEach(([,i],n)=>assert(Math.abs(i-(p.vin[n][1]-p.vout[n][1])/1000)<1e-12));
});
test('cursor measurements do not use display downsampling',()=>{
  const p=reference().vout,base={start:0,end:12e-9,cursor_a:2.003e-9,cursor_b:3.007e-9};
  const sparse=referenceWindow(p,{...base,limit:80}),dense=referenceWindow(p,{...base,limit:2000});
  assert.deepEqual(sparse.measurement,dense.measurement);assert(sparse.points.length<dense.points.length);
  assert.equal(sparse.measurement.basis,'analytic_rc_reference');
});
