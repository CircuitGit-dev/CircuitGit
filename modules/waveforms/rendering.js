/** Display-only reduction. Keep neighbours and time-ordered extrema per screen column.
 * Measurements must continue to use the server's original-vector cursor result.
 */
export function displayEnvelope(points,start,end,columns){
  if(!points.length||!(start<end))return [];
  const lower=x=>{let a=0,b=points.length;while(a<b){const m=(a+b)>>>1;if(points[m][0]<x)a=m+1;else b=m;}return a;};
  const lo=Math.max(0,lower(start)-1),hi=Math.min(points.length,lower(end)+1);
  if(points[lo]?.[0]>end||points[hi-1]?.[0]<start)return [];
  const buckets=Math.max(1,Math.floor(columns)),selected=[lo];let bucket=-1,min=lo,max=lo;
  const flush=()=>{if(bucket<0)return;selected.push(...(min===max?[min]:min<max?[min,max]:[max,min]));};
  for(let i=lo;i<hi;i++){
    const next=Math.max(0,Math.min(buckets-1,Math.floor((points[i][0]-start)/(end-start)*buckets)));
    if(next!==bucket){flush();bucket=next;min=max=i;}
    else{if(points[i][1]<points[min][1])min=i;if(points[i][1]>points[max][1])max=i;}
  }
  flush();selected.push(hi-1);
  return [...new Set(selected)].sort((a,b)=>a-b).map(i=>points[i]);
}

export function frameScheduler(draw,request,cancel){
  let frame=null,disposed=false;
  return {schedule(){if(disposed||frame!==null)return;frame=request(()=>{frame=null;if(!disposed)draw();});},
    dispose(){disposed=true;if(frame!==null)cancel(frame);frame=null;}};
}
