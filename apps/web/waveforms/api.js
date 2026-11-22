export function waveformAPI({base=location.origin,fetchImpl=fetch}={}){
  const origin=new URL(base,location.href);if(origin.origin!==location.origin)throw Error('波形 API 必须同源');
  async function get(path,{signal}={}){
    const response=await fetchImpl(new URL(path,origin),{signal,cache:'no-store',credentials:'same-origin'});
    const body=await response.json();if(!response.ok||!body.ok){const error=Error(body.error?.message||`HTTP ${response.status}`);error.code=body.error?.code;throw error;}return body.data;
  }
  const route=(run,suffix)=>`/api/jobs/${encodeURIComponent(run)}/${suffix}`;
  return {jobs:opts=>get('/api/jobs',opts),catalog:(run,opts)=>get(route(run,'signals'),opts),mapping:(run,opts)=>get(route(run,'waveform-map'),opts),
    waveform:(run,id,params={},opts)=>get(route(run,'waveform')+'?'+new URLSearchParams({signal_id:id,analysis:'tran',...params}),opts)};
}
