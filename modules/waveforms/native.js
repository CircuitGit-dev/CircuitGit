// Render explicitly selected saved AC/DC datasets. Numeric conversion and AC
// measurements are supplied by SpiceOwl; raw saved values retain their units.
import {appendBode,appendOperatingPoints} from '../simulation/environment/spectrum.js';
const SVG='http://www.w3.org/2000/svg',finite=v=>typeof v==='number'&&Number.isFinite(v);
const label=(doc,tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};

export function appendSavedSeries(parent,{name,points,xUnit,yUnit,breakBeforeIndices=[]}){
  if(!Array.isArray(points)||points.length>10000||points.some(row=>!Array.isArray(row)||row.length!==2||!finite(row[0])||row[1]!==null&&!finite(row[1])))throw Error('保存扫描点格式无效。');
  if(!Array.isArray(breakBeforeIndices)||breakBeforeIndices.some(i=>!Number.isInteger(i)||i<1||i>=points.length)||new Set(breakBeforeIndices).size!==breakBeforeIndices.length)throw Error('保存扫描缺口边界无效。');
  const starts=new Set(breakBeforeIndices);
  const doc=parent.ownerDocument,figure=label(doc,'figure');figure.className='wf-native-figure';figure.append(label(doc,'figcaption',name));
  const values=points.filter(row=>row[1]!==null);if(values.length<2){figure.append(label(doc,'pre',JSON.stringify({points,x_unit:xUnit,y_unit:yUnit},null,2)));parent.append(figure);return;}
  const xmin=Math.min(...points.map(row=>row[0])),xmax=Math.max(...points.map(row=>row[0])),ymin=Math.min(...values.map(row=>row[1])),ymax=Math.max(...values.map(row=>row[1]));
  const x=v=>60+550*(v-xmin)/(xmax-xmin||1),y=v=>195-165*(v-ymin)/(ymax-ymin||1);
  const svg=doc.createElementNS(SVG,'svg');svg.setAttribute('viewBox','0 0 640 240');svg.setAttribute('role','img');svg.setAttribute('aria-label',name+' · '+xUnit+' / '+yUnit);
  let segment=false;const path=doc.createElementNS(SVG,'path');path.setAttribute('d',points.map(([a,b],index)=>{if(starts.has(index))segment=false;if(b===null){segment=false;return '';}const result=(segment?'L':'M')+x(a)+' '+y(b);segment=true;return result;}).join(' '));path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('vector-effect','non-scaling-stroke');svg.append(path);
  points.forEach(([a,b],i)=>{if(b!==null&&!(i>0&&points[i-1][1]!==null&&!starts.has(i))&&!(i+1<points.length&&points[i+1][1]!==null&&!starts.has(i+1))){const dot=doc.createElementNS(SVG,'circle');dot.setAttribute('cx',x(a));dot.setAttribute('cy',y(b));dot.setAttribute('r','2');dot.setAttribute('fill','currentColor');svg.append(dot);}});
  for(const [left,top,text]of [[60,220,xmin+' '+xUnit],[480,220,xmax+' '+xUnit],[5,30,ymax+' '+yUnit],[5,195,ymin+' '+yUnit]]){const item=doc.createElementNS(SVG,'text');item.setAttribute('x',left);item.setAttribute('y',top);item.setAttribute('font-size','11');item.setAttribute('fill','currentColor');item.textContent=text;svg.append(item);}figure.append(svg);parent.append(figure);
}

export function mountNativeDatasets(parent,{api,onMode=()=>{}}){
  const doc=parent.ownerDocument,root=label(doc,'section');root.className='wf-native-view';root.hidden=true;
  const controls=label(doc,'div'),select=label(doc,'select'),content=label(doc,'div'),notice=label(doc,'p');
  select.setAttribute('aria-label','保存的分析数据集');select.dataset.waveformDataset='';content.className='wf-native-content';notice.setAttribute('role','status');
  controls.append(select);root.append(controls,notice,content);parent.append(root);
  let run=null,index=null,generation=0,request=null,disposed=false;
  const reset=()=>{generation++;request?.abort();request=new AbortController();return generation;};
  const current=ticket=>!disposed&&generation===ticket;
  const check=(value,dataset)=>{if(value.run_id!==run||value.source_commit!==index.source_commit||value.archive_sha256!==index.archive_sha256||value.dataset_id!==dataset.dataset_id||value.data_sha256!==dataset.data_sha256||value.analysis_id!==dataset.analysis.name)throw Error('保存数据集身份已变化。');};
  async function selected(){
    const ticket=reset(),did=select.value;content.replaceChildren();notice.textContent='';onMode(!!did);
    if(!did)return;const dataset=index?.datasets.find(row=>row.dataset_id===did);if(!dataset)return;
    notice.textContent='读取原始保存数据…';
    try{
      const catalog=await api.catalog(run,{dataset_id:did,signal:request.signal});if(!current(ticket))return;check(catalog,dataset);
      if(catalog.operating_points?.length)appendOperatingPoints(content,catalog.operating_points);
      const signals=label(doc,'div');signals.className='wf-native-signals';content.prepend(signals);
      const plots=label(doc,'div');plots.className='wf-native-plots';content.append(plots);const shown=new Map();
      for(const signal of catalog.signals||[]){const button=label(doc,'button',(signal.label||signal.id)+' · '+(signal.unit||'unknown'));button.type='button';button.dataset.nativeSignal=signal.id;signals.append(button);
        button.onclick=async()=>{if(shown.has(signal.id)){shown.get(signal.id).remove();shown.delete(signal.id);button.setAttribute('aria-pressed','false');return;}
          button.disabled=true;notice.textContent='读取所选原始波形…';try{const data=await api.waveform(run,signal.id,{dataset_id:did,limit:1600},{signal:request.signal});if(!current(ticket))return;check(data,dataset);if(data.signal?.id!==signal.id)throw Error('返回了其它保存信号。');
            const figure=label(doc,'section');figure.dataset.nativeTrace=signal.id;
            if(data.bode&&data.bode.frequency_hz.length>=2)appendBode(figure,data.bode);
            else if(data.axis===null)figure.append(label(doc,'pre',JSON.stringify({signal:signal.label,...data.operating_value},null,2)));
            else if(data.representation==='string')figure.append(label(doc,'pre',JSON.stringify({signal:signal.label,axis:data.axis,points:data.points},null,2)));
            else if(data.complex_points){for(const [offset,suffix]of [[1,'real'],[2,'imag']])appendSavedSeries(figure,{name:signal.label+' · '+suffix,points:data.complex_points.map(row=>[row[0],row[offset]]),xUnit:data.axis.unit,yUnit:signal.unit||'unknown',breakBeforeIndices:data.display?.break_before_indices?.[suffix]||[]});}
            else appendSavedSeries(figure,{name:signal.label,points:data.points,xUnit:data.axis.unit||'unknown',yUnit:signal.unit||'unknown',breakBeforeIndices:data.display?.break_before_indices?.values||[]});
            plots.append(figure);shown.set(signal.id,figure);button.setAttribute('aria-pressed','true');notice.textContent='保存数据 · '+dataset.analysis.name+' · '+dataset.analysis.kind+' · '+(data.display?.decimated?(data.display.extrema_preserved===false?'显示预算不足以保留全部分量峰谷：'+data.display.unpreserved_extrema_components.join(', '):'原始点保峰抽样显示'):'原始保存样本');
          }catch(error){if(current(ticket)&&error.name!=='AbortError')notice.textContent='读取失败：'+error.message;}finally{if(current(ticket))button.disabled=false;}};
      }
      notice.textContent=dataset.analysis.name+' · '+dataset.analysis.kind+' · '+catalog.sample_count+' 个原始样本；选择信号显示。';
    }catch(error){if(current(ticket)&&error.name!=='AbortError')notice.textContent='读取失败：'+error.message;}
  }
  select.addEventListener('change',selected);
  return {setCatalog(rid,catalog){reset();run=rid;index=catalog;content.replaceChildren();notice.textContent='';select.replaceChildren(label(doc,'option','选择已保存的 AC / DC 数据集'));select.firstChild.value='';for(const row of catalog?.datasets||[]){const option=label(doc,'option',row.analysis.name+' · '+row.analysis.kind);option.value=row.dataset_id;select.append(option);}root.hidden=!catalog?.datasets?.length;onMode(false);},destroy(){disposed=true;reset();select.removeEventListener('change',selected);root.remove();}};
}
