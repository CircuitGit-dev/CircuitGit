// phase2-interface.md HTTP v1. Same-origin only; never place SSH/GitHub credentials here.
export class ApiError extends Error{constructor(message,status=0,data={}){super(message);this.status=status;this.data=data;}}
export class Gateway{
  constructor(){this.base='/api';this.token=null;}
  async request(path,{method='GET',body,timeout=20000}={}){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const headers={Accept:'application/json'};
      if(body!==undefined)headers['Content-Type']='application/json';
      if(this.token&&method!=='GET')headers['X-Workbench-Token']=this.token;
      const response=await fetch(this.base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store',signal:controller.signal});
      let result;try{result=await response.json();}catch{throw new ApiError('网关返回非 JSON 数据。',response.status);}
      if(!response.ok||result.ok===false)throw new ApiError(result.error?.message||result.message||`HTTP ${response.status}`,response.status,result.error||result);
      if(result.ok!==true)throw new ApiError('网关响应未符合 HTTP v1 契约。',response.status,result);
      return result.data;
    }catch(error){if(error.name==='AbortError')throw new ApiError('网关响应超时；写操作未自动重试。请刷新任务核对。');throw error;}finally{clearTimeout(timer);}
  }
  async health(){const data=await this.request('/health',{timeout:5000});this.token=data.mutation_token||data.token;return data;}
  project(){return this.request('/project');}
  sync(){return this.request('/sync',{method:'POST',body:{},timeout:30000});}
  files(projectId){return this.request('/tree?project_id='+encodeURIComponent(projectId));}
  file(path){return this.request('/file?path='+encodeURIComponent(path));}
  preview(body){return this.request('/changes/preview',{method:'POST',body});}
  save(body){return this.request('/changes/commit',{method:'POST',body,timeout:30000});}
  plan(body){return this.request('/plan',{method:'POST',body});}
  preflight(body){return this.request('/preflight',{method:'POST',body,timeout:30000});}
  submit(body){return this.request('/jobs',{method:'POST',body,timeout:30000});}
  jobs(){return this.request('/jobs');}
  job(id){return this.request('/jobs/'+encodeURIComponent(id));}
  async results(id){return normalizeResults(await this.request('/jobs/'+encodeURIComponent(id)+'/results'));}
  async artifactText(path){const url=new URL(path,location.href);if(url.origin!==location.origin)throw new ApiError('结果日志必须同源。');const response=await fetch(url,{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new ApiError('日志读取失败',response.status);if(Number(response.headers.get('content-length'))>512*1024)throw new ApiError('日志超过预览上限，请下载完整文件。');const text=await response.text();return text.length>512*1024?text.slice(0,512*1024)+'\n[预览已截断；完整文件请下载]':text;}
  collect(id){return this.request('/jobs/'+encodeURIComponent(id)+'/collect',{method:'POST',body:{raw:true},timeout:30000});}
  archive(id){return this.request('/jobs/'+encodeURIComponent(id)+'/publish',{method:'POST',body:{complete:true},timeout:30000});}
  schematic(projectId,path,sourceHash){return this.request('/schematic?'+new URLSearchParams({project_id:projectId,path,...(sourceHash?{source_hash:sourceHash}:{})}));}
}

export function normalizePublication(publication){if(!publication)return null;return {...publication,backend_status:publication.status,status:publication.status==='complete'?'published':publication.status};}
export function normalizeResults(results){return {...results,publication:normalizePublication(results.publication)};}
