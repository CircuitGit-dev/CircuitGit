// Read the selected Document object's exact source span. Values remain literal
// Spectre expressions; this inspector neither resolves PDKs nor evaluates them.
import {indexSpectre} from './netlist.js';

const dimensions=['w','l','nf','m','multi'];
function parameterValues(source){
  const values=new Map();let i=0;
  while(i<source.length){
    while(/\s/.test(source[i]||'')&&i<source.length)i++;
    if(source.slice(i,i+2)==='//')break;
    const key=source.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/);
    if(!key)break;
    i+=key[0].length;const start=i;let quote=null,depth=0;
    while(i<source.length){
      const char=source[i];
      if(quote){if(char==='\\'){i+=2;continue;}if(char===quote)quote=null;}
      else if(char==='"'||char==="'")quote=char;
      else if('([{'.includes(char))depth++;
      else if(')]}'.includes(char)){if(depth===0)break;depth--;}
      else if(depth===0&&(/\s/.test(char)||source.slice(i,i+2)==='//'))break;
      i++;
    }
    if(quote||depth||start===i)break;
    const name=key[1].toLowerCase();
    // Repeated definitions are ambiguous; do not choose a winning value here.
    values.set(name,values.has(name)?null:source.slice(start,i));
  }
  return dimensions.flatMap(name=>typeof values.get(name)==='string'?[{name,value:values.get(name)}]:[]);
}
export {parameterValues as literalDimensions};

export function selectedInstanceProperties(document,index){
  const object=document?.objects?.[index];
  if(object?.kind!=='instance')return null;
  const unavailable=reason=>({available:false,name:object.name,reason});
  const range=object.lines;
  if(!Array.isArray(range)||range.length!==3||!range.every(Number.isSafeInteger))return unavailable('未记录实例的精确源码范围');
  const [fileIndex,start,end]=range,file=document.files?.[fileIndex];
  if(fileIndex<0||start<1||end<start||end-start>100||typeof file?.text!=='string'||typeof file.path!=='string')return unavailable('源码范围不可用');
  if((file.format||file.default_format||document.dialect)!=='spectre')return unavailable('当前源码格式尚无尺寸读取器');
  const lines=file.text.split('\n');
  if(end>lines.length)return unavailable('源码范围超出文件');
  const statement=lines.slice(start-1,end).join('\n');
  if(statement.length>16384)return unavailable('实例语句超过读取范围');
  const instances=indexSpectre(statement).flatMap(scope=>scope.instances);
  if(instances.length!==1||instances[0].name!==object.name||instances[0].start!==1||instances[0].end!==end-start+1)return unavailable('实例与源码范围不唯一对应');
  const instance=instances[0];
  return {available:true,name:object.name,model:instance.model,dimensions:parameterValues(instance.parameters),
    parameters:instance.parameters,statement,source:{path:file.path,start,end}};
}

export function appendInstanceProperties(parent,properties){
  if(!properties)return;
  const span=parent.ownerDocument.createElement('span');span.dataset.instanceProperties=properties.available?'available':'unavailable';
  if(!properties.available){span.textContent=' · 参数未知';span.title=properties.reason;parent.append(span);return;}
  const dimensions=properties.dimensions.map(({name,value})=>`${name}=${value}`);
  span.textContent=' · '+[properties.model,...dimensions].join(' · ');
  span.title=`型号：${properties.model}\n${dimensions.join('\n')}\n来源：${properties.source.path}:${properties.source.start}\n${properties.statement}`;
  span.setAttribute('aria-label',`选中实例 ${properties.name}，型号 ${properties.model}${dimensions.length?'，'+dimensions.join('，'):''}，参数表达式按源码显示`);
  parent.append(span);
}
