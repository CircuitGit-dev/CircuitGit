import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spectrumSeries} from '../../modules/simulation/environment/spectrum.js';

const spectrum=()=>({label:'Synthetic frequency samples',frequencyUnit:'Hz',amplitudeUnit:'V',frequency:[0,10,20,30],amplitude:[0,.2,.5,.1]});
test('frequency plot retains supplied values and units without FFT or normalization',()=>{
  const value=spectrum(),view=spectrumSeries(value);assert.deepEqual(view.points,[[0,0],[10,.2],[20,.5],[30,.1]]);
  assert.deepEqual(view.domain,{xmin:0,xmax:30,ymin:0,ymax:.5});assert.equal(view.amplitudeUnit,'V');assert.deepEqual(value,spectrum());
});
test('invalid, unpaired, unsorted and unlabelled scientific data fails closed',()=>{
  for(const change of [{frequency:[0,10]},{frequency:[0,10,10,30]},{frequency:[0,20,10,30]},{frequency:[-1,10,20,30]},{amplitude:[0,NaN,1,2]},{amplitude:[0,Infinity,1,2]},{amplitudeUnit:''},{frequencyUnit:null},{label:''}])assert.throws(()=>spectrumSeries({...spectrum(),...change}));
});
test('bounded display sampling retains actual narrow positive and negative peaks',()=>{
  const value={...spectrum(),frequency:Array.from({length:10001},(_,i)=>i),amplitude:Array(10001).fill(-80)};value.amplitude[4444]=11;value.amplitude[5555]=-123;
  const view=spectrumSeries(value,{maxDisplayPoints:128});assert(view.points.length<=128);assert(view.points.some(([x,y])=>x===4444&&y===11));assert(view.points.some(([x,y])=>x===5555&&y===-123));
  assert.deepEqual(view.points[0],[0,-80]);assert.deepEqual(view.points.at(-1),[10000,-80]);assert(view.points.every(([x],i)=>!i||x>view.points[i-1][0]));
});
test('null decibel bins remain gaps and are never converted to zero',()=>{
  const value={...spectrum(),amplitude:[null,-80,-40,null]},view=spectrumSeries(value);assert.deepEqual(view.points,[[0,null],[10,-80],[20,-40],[30,null]]);assert.equal(view.domain.ymax,-40);assert.equal(spectrumSeries({...value,amplitude:[null,null,null,null]}).domain,null);
});
