// Display supplied frequency-domain samples. This component never computes an
// FFT or substitutes a reference curve for unavailable analysis output.
const SVG='http://www.w3.org/2000/svg';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const label=value=>typeof value==='string'&&value.trim().length>0&&value.length<=160;

export function spectrumSeries(value,{maxSamples=262144,maxDisplayPoints=4096}={}){
  if(!value||!label(value.label)||!label(value.frequencyUnit)||!label(value.amplitudeUnit)||
     !Array.isArray(value.frequency)||!Array.isArray(value.amplitude)||value.frequency.length!==value.amplitude.length||
     value.frequency.length<2||value.frequency.length>maxSamples||!Number.isInteger(maxDisplayPoints)||maxDisplayPoints<8)
    throw Error('频谱缺少成对数据、单位或可核对的样本范围。');
  const requestedBreaks=value.breakBeforeIndices||[];
  if(!Array.isArray(requestedBreaks)||requestedBreaks.some(i=>!Number.isInteger(i)||i<1||i>=value.frequency.length)||new Set(requestedBreaks).size!==requestedBreaks.length)throw Error('频谱缺口边界无效。');
  const inputBreaks=new Set(requestedBreaks);
  let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;
  for(let i=0;i<value.frequency.length;i++){
    const x=value.frequency[i],y=value.amplitude[i];
    if(!finite(x)||y!==null&&!finite(y)||x<0||i&&x<=value.frequency[i-1])throw Error('频谱数据必须为有限数值或明确缺口，频率按严格递增顺序给出。');
    xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);if(y!==null){ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}
  }
  if(!finite(ymin)||!finite(ymax))return {label:value.label,frequencyUnit:value.frequencyUnit,amplitudeUnit:value.amplitudeUnit,count:value.frequency.length,points:[],breakBeforeIndices:[],domain:null};
  const count=value.frequency.length,indices=[];
  if(count<=maxDisplayPoints){for(let i=0;i<count;i++)indices.push(i);}
  else{
    indices.push(0);
    const buckets=Math.floor((maxDisplayPoints-2)/3),step=(count-2)/buckets;
    for(let bucket=0;bucket<buckets;bucket++){
      const start=1+Math.floor(bucket*step),end=1+Math.floor((bucket+1)*step);let low=null,high=null,gap=null;
      for(let i=start;i<end;i++){if(value.amplitude[i]===null){gap??=i;continue;}if(low===null||value.amplitude[i]<value.amplitude[low])low=i;if(high===null||value.amplitude[i]>value.amplitude[high])high=i;}
      for(const index of [...new Set([low,high,gap].filter(index=>index!==null))].sort((a,b)=>a-b))indices.push(index);
    }
    indices.push(count-1);
  }
  const prefix=[0];for(let i=0;i<count;i++)prefix.push(prefix[i]+(value.amplitude[i]===null||inputBreaks.has(i)?1:0));
  const breakBeforeIndices=indices.flatMap((index,i)=>i&&prefix[index+1]-prefix[indices[i-1]+1]>0?[i]:[]);
  const points=indices.map(i=>[value.frequency[i],value.amplitude[i]]);
  return {label:value.label,frequencyUnit:value.frequencyUnit,amplitudeUnit:value.amplitudeUnit,count,points,breakBeforeIndices,domain:{xmin,xmax,ymin,ymax}};
}

const number=value=>Math.abs(value)>=10000||value!==0&&Math.abs(value)<.001?value.toExponential(2):Number(value.toPrecision(4)).toString();

export function appendSpectrum(parent,value,{logFrequency=false,yLabel='幅度'}={}){
  const series=spectrumSeries(value),doc=parent.ownerDocument;
  const figure=doc.createElement('figure');figure.className='ic-env-spectrum';figure.dataset.analysisSpectrum='';
  const caption=doc.createElement('figcaption');caption.textContent=series.label;figure.append(caption);
  if(!series.domain){const note=doc.createElement('p');note.className='ic-sim-note';note.textContent='频谱返回的幅度均为缺口，没有可绘制的有限值。';figure.append(note);parent.append(figure);return figure;}
  const {xmin,xmax,ymin,ymax}=series.domain;
  const svg=doc.createElementNS(SVG,'svg');svg.setAttribute('viewBox','0 0 640 250');svg.setAttribute('role','img');svg.setAttribute('aria-label',series.label+' · 频率 / '+series.frequencyUnit+' · '+yLabel+' / '+series.amplitudeUnit);
  const left=68,right=620,top=22,bottom=200,pad=(ymax-ymin||Math.max(Math.abs(ymin),1))*.06;
  if(logFrequency&&xmin<=0)throw Error('对数频率坐标要求严格为正的保存频率。');
  const lower=ymin-pad,upper=ymax+pad,tx=x=>logFrequency?Math.log10(x):x,
    mapX=x=>left+(tx(x)-tx(xmin))/(tx(xmax)-tx(xmin))*(right-left),mapY=y=>bottom-(y-lower)/(upper-lower)*(bottom-top);
  const element=(tag,attributes,text)=>{const node=doc.createElementNS(SVG,tag);for(const[key,value]of Object.entries(attributes))node.setAttribute(key,String(value));if(text!==undefined)node.textContent=text;svg.append(node);return node;};
  for(let i=0;i<=4;i++){
    const x=logFrequency?10**(tx(xmin)+(tx(xmax)-tx(xmin))*i/4):xmin+(xmax-xmin)*i/4,y=lower+(upper-lower)*i/4;
    element('line',{x1:mapX(x),x2:mapX(x),y1:top,y2:bottom,class:'ic-env-spectrum-grid'});
    element('line',{x1:left,x2:right,y1:mapY(y),y2:mapY(y),class:'ic-env-spectrum-grid'});
    element('text',{x:mapX(x),y:bottom+18,'text-anchor':'middle'},number(x));
    element('text',{x:left-8,y:mapY(y)+4,'text-anchor':'end'},number(y));
  }
  const starts=new Set(series.breakBeforeIndices);
  let segment=false;const path=series.points.map(([x,y],index)=>{if(starts.has(index))segment=false;if(y===null){segment=false;return '';}const command=(segment?'L':'M')+mapX(x).toFixed(2)+' '+mapY(y).toFixed(2);segment=true;return command;}).join(' ');
  element('path',{d:path,class:'ic-env-spectrum-line','vector-effect':'non-scaling-stroke'});
  series.points.forEach(([x,y],i)=>{if(y!==null&&!(i>0&&series.points[i-1][1]!==null&&!starts.has(i))&&!(i+1<series.points.length&&series.points[i+1][1]!==null&&!starts.has(i+1)))element('circle',{cx:mapX(x),cy:mapY(y),r:2,fill:'currentColor'});});
  element('text',{x:(left+right)/2,y:245,'text-anchor':'middle'},'频率 / '+series.frequencyUnit);
  element('text',{x:left,y:14},yLabel+' / '+series.amplitudeUnit);figure.append(svg);
  const note=doc.createElement('p');note.className='ic-sim-note';note.textContent=series.count===series.points.length?`${series.count} 个频域样本。`:`${series.count} 个频域样本 · 保留峰谷显示 ${series.points.length} 点。`;figure.append(note);parent.append(figure);return figure;
}

/** Plot supplied AC transfer/loop response; no FFT, normalization or stability inference. */
export function appendBode(parent,value){
  if(!value||!label(value.label)||value.frequency_unit!=='Hz'||!(value.magnitude_unit==='dB'||label(value.magnitude_unit)&&value.magnitude_unit.startsWith('dB re 1 '))||value.phase_unit!=='deg'||
    !['transfer','loop_gain'].includes(value.response_kind)||!Array.isArray(value.frequency_hz)||
    !Array.isArray(value.magnitude_db)||!Array.isArray(value.phase_deg)||value.frequency_hz.length!==value.phase_deg.length)
    throw Error('AC 幅相图需要同一频率轴、明确响应语义和 dB/deg 单位。');
  const magnitude={label:value.label+' · 幅度',frequencyUnit:'Hz',amplitudeUnit:value.magnitude_unit,frequency:value.frequency_hz,amplitude:value.magnitude_db,breakBeforeIndices:value.break_before_indices?.magnitude_db||value.display?.break_before_indices?.magnitude_db||[]};
  const phase={label:value.label+' · 相位',frequencyUnit:'Hz',amplitudeUnit:'deg',frequency:value.frequency_hz,amplitude:value.phase_deg,breakBeforeIndices:value.break_before_indices?.phase_deg||value.display?.break_before_indices?.phase_deg||[]};
  spectrumSeries(magnitude);spectrumSeries(phase);
  const logFrequency=value.frequency_hz.every(x=>x>0);
  const box=parent.ownerDocument.createElement('section');box.className='ic-env-bode';box.dataset.analysisBode='';
  appendSpectrum(box,magnitude,{logFrequency,yLabel:'幅度'});
  appendSpectrum(box,phase,{logFrequency,yLabel:'相位'});
  const note=parent.ownerDocument.createElement('p');note.className='ic-sim-note';
  note.textContent=value.response_kind==='loop_gain'?'保存的环路响应；稳定性须结合反馈约定和全部交越结果判断。':'保存的传递响应；此图不建立环路稳定性结论。';
  if(!logFrequency)note.textContent+=' 原数据含 0 Hz，使用线性频率轴保留该点。';
  box.append(note);parent.append(box);return box;
}

/** Display saved operating-point fields verbatim; PDK region numbers remain raw. */
export function appendOperatingPoints(parent,devices){
  if(!Array.isArray(devices)||devices.length>4096)throw Error('DC 工作点记录超出显示范围。');
  const doc=parent.ownerDocument,box=doc.createElement('section');box.className='ic-env-operating-points';box.dataset.operatingPoints='';
  const table=doc.createElement('table'),head=doc.createElement('thead'),header=doc.createElement('tr');
  for(const label of ['器件','模型','保存字段','数值','单位','类型','有效性']){const cell=doc.createElement('th');cell.textContent=label;header.append(cell);}head.append(header);table.append(head);
  const body=doc.createElement('tbody');let count=0;
  for(const device of devices){
    if(!device||!label(device.name)||!device.parameters||typeof device.parameters!=='object'||Array.isArray(device.parameters))throw Error('DC 工作点缺少保存字段身份。');
    for(const [name,field]of Object.entries(device.parameters)){
      if(++count>32768||!label(name)||!field||!['valid','undefined','unknown'].includes(field.status)||
        !['real','integer','complex','string'].includes(field.value_kind)||
        field.value!==null&&!(finite(field.value)||field.value_kind==='string'&&typeof field.value==='string'||field.value_kind==='complex'&&Array.isArray(field.value)&&field.value.length===2&&field.value.every(v=>v===null||finite(v)))||field.unit!==null&&!label(field.unit))throw Error('DC 工作点字段的数值或单位无效。');
      const row=doc.createElement('tr');for(const value of [device.name,device.model||device.model_type||'—',name,
        field.value===null?'—':finite(field.value)?number(field.value):Array.isArray(field.value)?JSON.stringify(field.value):field.value,field.unit||'unknown',field.value_kind,field.status]){const cell=doc.createElement('td');cell.textContent=String(value);row.append(cell);}body.append(row);
    }
  }
  table.append(body);box.append(table);const note=doc.createElement('p');note.className='ic-sim-note';
  note.textContent='仅显示原文件保存的字段与单位。region 等 PDK 编码保留原值；没有明确模型映射时工作区分类为 unknown。';
  box.append(note);parent.append(box);return box;
}
