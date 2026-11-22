import {displayEnvelope} from '../../../modules/waveforms/rendering.js';

/** Exact RC response to piecewise-linear segments; these are mathematical references, not Spectre results. */
export function reference({resistance=1000,capacitance=1e-12,stop=12e-9}={}) {
  const tau=resistance*capacitance, dt=5e-12;
  const input=t=>{if(t<1e-9)return 0;const p=(t-1e-9)%10e-9;
    if(p<10e-12)return p/10e-12;if(p<5.01e-9)return 1;if(p<5.02e-9)return 1-(p-5.01e-9)/10e-12;return 0;};
  const points={vin:[],vout:[],ir:[]};let y=0,previous=0;
  for(let i=0,n=Math.ceil(stop/dt);i<=n;i++) {
    const t=Math.min(stop,i*dt),x=input(t);
    if(i){const start=input(previous),h=t-previous,slope=(x-start)/h;
      y=x-slope*tau+(y-start+slope*tau)*Math.exp(-h/tau);}
    points.vin.push([t,x]);points.vout.push([t,y]);points.ir.push([t,(x-y)/resistance]);previous=t;
  }
  return points;
}

export function interpolate(points,x) {
  if(!Number.isFinite(x)||x<points[0][0]||x>points.at(-1)[0])return null;
  let a=0,b=points.length-1;while(b-a>1){const m=(a+b)>>1;if(points[m][0]<=x)a=m;else b=m;}
  const p=points[a],q=points[b];return {x,y:p[1]+(q[1]-p[1])*(x-p[0])/(q[0]-p[0]),interpolated:true};
}

export function referenceWindow(points,params={}) {
  const start=Number(params.start??0),end=Number(params.end??points.at(-1)[0]);
  const display=displayEnvelope(points,start,end,Math.max(1,Math.floor(Number(params.limit||1000)/2)));
  const a=interpolate(points,Number(params.cursor_a)),b=interpolate(points,Number(params.cursor_b));
  return {points:display,display:{returned_points:display.length,input_points:points.length},
    measurement:{basis:'analytic_rc_reference',cursors:{a,b},delta:a&&b?{dt:b.x-a.x,dy:b.y-a.y}:null}};
}
