// Limit the complete UTF-8 JSON envelope before decoding or parsing it. This is
// used only by simulation API routes; it never truncates a scientific report.
export const SIMULATION_RESPONSE_LIMIT=2*1024*1024;
export function isSimulationApiPath(path){
  try{return new URL(path,'http://gateway.invalid').pathname.startsWith('/api/simulation/');}catch{return false;}
}
function sizeError(){
  const error=Error('仿真响应超过 2 MiB 限制。请核对原任务记录；请求不会自动重发。');
  error.code='response_size_limit';error.data={code:error.code,limit_bytes:SIMULATION_RESPONSE_LIMIT};return error;
}
export async function readSimulationJson(response){
  const chunks=[];let size=0;
  if(response.body){
    const reader=response.body.getReader();
    try{
      for(;;){
        const {value,done}=await reader.read();if(done)break;
        size+=value.byteLength;
        if(size>SIMULATION_RESPONSE_LIMIT){await reader.cancel().catch(()=>{});throw sizeError();}
        chunks.push(value);
      }
    }finally{reader.releaseLock();}
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
