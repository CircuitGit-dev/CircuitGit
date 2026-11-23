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
  let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;
  for(let i=0;i<value.frequency.length;i++){
    const x=value.frequency[i],y=value.amplitude[i];
    if(!finite(x)||y!==null&&!finite(y)||x<0||i&&x<=value.frequency[i-1])throw Error('频谱数据必须为有限数值或明确缺口，频率按严格递增顺序给出。');
    xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);if(y!==null){ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}
  }
  if(!finite(ymin)||!finite(ymax))return {label:value.label,frequencyUnit:value.frequencyUnit,amplitudeUnit:value.amplitudeUnit,count:value.frequency.length,points:[],domain:null};
  const count=value.frequency.length,points=[];
  if(count<=maxDisplayPoints){for(let i=0;i<count;i++)points.push([value.frequency[i],value.amplitude[i]]);}
  else{
    points.push([value.frequency[0],value.amplitude[0]]);
    const buckets=Math.floor((maxDisplayPoints-2)/3),step=(count-2)/buckets;
    for(let bucket=0;bucket<buckets;bucket++){
      const start=1+Math.floor(bucket*step),end=1+Math.floor((bucket+1)*step);let low=null,high=null,gap=null;
      for(let i=start;i<end;i++){if(value.amplitude[i]===null){gap??=i;continue;}if(low===null||value.amplitude[i]<value.amplitude[low])low=i;if(high===null||value.amplitude[i]>value.amplitude[high])high=i;}
      for(const index of [...new Set([low,high,gap].filter(index=>index!==null))].sort((a,b)=>a-b))points.push([value.frequency[index],value.amplitude[index]]);
    }
    points.push([value.frequency[count-1],value.amplitude[count-1]]);
  }
  return {label:value.label,frequencyUnit:value.frequencyUnit,amplitudeUnit:value.amplitudeUnit,count,points,domain:{xmin,xmax,ymin,ymax}};
}

const number=value=>Math.abs(value)>=10000||value!==0&&Math.abs(value)<.001?value.toExponential(2):Number(value.toPrecision(4)).toString();

export function appendSpectrum(parent,value){
  const series=spectrumSeries(value),doc=parent.ownerDocument;
  const figure=doc.createElement('figure');figure.className='ic-env-spectrum';figure.dataset.analysisSpectrum='';
  const caption=doc.createElement('figcaption');caption.textContent=series.label;figure.append(caption);
  if(!series.domain){const note=doc.createElement('p');note.className='ic-sim-note';note.textContent='频谱返回的幅度均为缺口，没有可绘制的有限值。';figure.append(note);parent.append(figure);return figure;}
  const {xmin,xmax,ymin,ymax}=series.domain;
  const svg=doc.createElementNS(SVG,'svg');svg.setAttribute('viewBox','0 0 640 250');svg.setAttribute('role','img');svg.setAttribute('aria-label',series.label+' · 频率 / '+series.frequencyUnit+' · 幅度 / '+series.amplitudeUnit);
  const left=68,right=620,top=22,bottom=200,pad=(ymax-ymin||Math.max(Math.abs(ymin),1))*.06;
  const lower=ymin-pad,upper=ymax+pad,mapX=x=>left+(x-xmin)/(xmax-xmin)*(right-left),mapY=y=>bottom-(y-lower)/(upper-lower)*(bottom-top);
  const element=(tag,attributes,text)=>{const node=doc.createElementNS(SVG,tag);for(const[key,value]of Object.entries(attributes))node.setAttribute(key,String(value));if(text!==undefined)node.textContent=text;svg.append(node);return node;};
  for(let i=0;i<=4;i++){
    const x=xmin+(xmax-xmin)*i/4,y=lower+(upper-lower)*i/4;
    element('line',{x1:mapX(x),x2:mapX(x),y1:top,y2:bottom,class:'ic-env-spectrum-grid'});
    element('line',{x1:left,x2:right,y1:mapY(y),y2:mapY(y),class:'ic-env-spectrum-grid'});
    element('text',{x:mapX(x),y:bottom+18,'text-anchor':'middle'},number(x));
    element('text',{x:left-8,y:mapY(y)+4,'text-anchor':'end'},number(y));
  }
  let segment=false;const path=series.points.map(([x,y])=>{if(y===null){segment=false;return '';}const command=(segment?'L':'M')+mapX(x).toFixed(2)+' '+mapY(y).toFixed(2);segment=true;return command;}).join(' ');
  element('path',{d:path,class:'ic-env-spectrum-line','vector-effect':'non-scaling-stroke'});
  element('text',{x:(left+right)/2,y:245,'text-anchor':'middle'},'频率 / '+series.frequencyUnit);
  element('text',{x:left,y:14},'幅度 / '+series.amplitudeUnit);figure.append(svg);
  const note=doc.createElement('p');note.className='ic-sim-note';note.textContent=series.count===series.points.length?`${series.count} 个频域样本。`:`${series.count} 个频域样本 · 保留峰谷显示 ${series.points.length} 点。`;figure.append(note);parent.append(figure);return figure;
}
