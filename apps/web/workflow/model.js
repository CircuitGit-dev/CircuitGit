export const statusLabels=Object.freeze({verified:'已有证据',review:'待人工审阅',planned:'待执行',illustrative:'方法示意'});
export function readOverview(value){
  if(value?.schema!=='ic.workflow.overview.v1'||!Array.isArray(value.cases)||!value.cases.length)throw Error('流程资料的版本或案例列表不完整。');
  const cases=new Set();
  for(const item of value.cases){
    if(typeof item.id!=='string'||!item.id||cases.has(item.id)||!Array.isArray(item.stages)||item.stages.length!==10)throw Error('每个案例必须有独立身份和 10 个流程步骤。');
    cases.add(item.id);const stages=new Set();
    for(const stage of item.stages){if(typeof stage.id!=='string'||!stage.id||stages.has(stage.id)||!Object.hasOwn(statusLabels,stage.status)||typeof stage.title!=='string')throw Error('流程步骤的身份、标题或证据状态不完整。');stages.add(stage.id);}
  }
  return value;
}
export function selectionFor(data,url){
  const params=new URL(url,'https://workflow.invalid/').searchParams;
  const item=data.cases.find(value=>value.id===params.get('case'))||data.cases[0];
  const index=Math.max(0,item.stages.findIndex(value=>value.id===params.get('stage')));
  return {item,index};
}
export function localEvidenceHref(value){
  if(typeof value!=='string'||!value||value.includes('\\')||/[\u0000-\u0020]/.test(value))return null;
  if(value.startsWith('data/')&&!value.split(/[/?#]/).includes('..')&&!value.includes('%'))return value;
  return null;
}
export function countsFor(item){return item.stages.reduce((sum,stage)=>(sum[stage.status]++,sum),{verified:0,review:0,planned:0,illustrative:0});}
