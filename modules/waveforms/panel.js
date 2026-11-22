import {freshness,resolveSelection} from './mapping.js';
import {displayEnvelope,frameScheduler} from './rendering.js';
const COLORS=['#58d5ee','#ffbd68','#ca99ff','#6ed8a7','#ff819e','#b6cf62','#9daeff','#ecaeed'];
export function engineering(value,unit=''){
  if(value===null||value===undefined||!Number.isFinite(value))return '—';
  if(value===0)return `0 ${unit}`;
  const exp=Math.max(-15,Math.min(9,Math.floor(Math.log10(Math.abs(value))/3)*3));
  const prefix=({'-15':'f','-12':'p','-9':'n','-6':'µ','-3':'m','0':'','3':'k','6':'M','9':'G'})[exp];
  return `${Number((value/10**exp).toPrecision(5))} ${prefix}${unit}`;
}

export function mountWaveformPanel(root,{contextAdapter,api,maxTraces=16,followSelection=true,manualSignals=true,managedRun=false,probeAllowed=()=>true,labels={}}={}){
  if(!contextAdapter?.getContext||!contextAdapter?.subscribe)throw Error('Shared getContext/subscribe adapter required');
  if(!api||!['jobs','catalog','mapping','waveform'].every(key=>typeof api[key]==='function'))throw Error('Waveform data adapter required');
  root.classList.add('wf-panel');root.setAttribute('aria-label','波形查看器');
  // Only constant markup; all external labels are assigned with textContent.
  root.innerHTML=`<div class="wf-top"><h2>Waveforms <small>波形</small></h2><select class="wf-run" aria-label="选择运行"><option value="">选择已保存运行</option></select><button data-action="refresh">刷新运行</button></div>
    <div class="wf-banner" role="status"></div><div class="wf-provenance"></div>
    <div class="wf-body"><aside><input class="wf-search" type="search" aria-label="搜索信号" placeholder="搜索已导出信号…"><button type="button" data-action="add-all" disabled>绘制已导出波形</button><div class="wf-list"></div><p class="wf-note">目录仅覆盖已导出信号。电压是节点量；电流需器件端口与方向。</p><p class="wf-note">当前支持 transient。AC / 复数 / sweep / corner family 尚不支持。</p></aside>
    <div><div class="wf-toolbar"><button data-action="fit">Fit</button><button data-action="zoom-in" aria-label="放大">＋</button><button data-action="zoom-out" aria-label="缩小">−</button><label>开始(s) <input class="wf-start" type="number" step="any"></label><label>结束(s) <input class="wf-end" type="number" step="any"></label><button data-action="window">应用时间窗</button><button data-action="cancel">取消读取</button></div>
    <canvas class="wf-plot" tabindex="0" aria-label="瞬态波形：滚轮缩放、拖动平移、点击设置游标" role="img"></canvas><div class="wf-legend"></div>
    <div class="wf-toolbar"><label>游标 <select class="wf-cursor-mode" aria-label="活动游标"><option>A</option><option>B</option></select></label><label>A(s) <input class="wf-a" type="number" step="any"></label><label>B(s) <input class="wf-b" type="number" step="any"></label><button data-action="measure">读取游标</button></div><div class="wf-cursors"></div><p class="wf-note wf-data-note"></p><p class="wf-layout-note">滚轮以指针为中心缩放 · 拖动平移 · ←/→平移 · ＋/−缩放 · F适配 · V/A分 pane</p></div></div>
    <div class="wf-status" aria-live="polite"></div><div class="wf-choices"></div><details class="wf-proposal" hidden><summary>下次运行保存建议（仅预览）</summary><pre></pre></details>`;
  const $=s=>root.querySelector(s),plot=$('.wf-plot'),run=$('.wf-run');
  const frames=frameScheduler(draw,requestAnimationFrame,cancelAnimationFrame),drawCache=new WeakMap();
  run.disabled=managedRun;
  let rid='',catalog=null,manifest=null,traces=new Map(),windowRange=null,cursors={a:null,b:null},disposed=false,revision=0,controller=null,lastSelection='',lastContextRun=null,colorIndex=0;
  let refreshTimer=null,activeRead=null,queuedRefresh=false,viewGeneration=0,lastReadAt=0;
  const listeners=[];const on=(el,event,fn,opts)=>{el.addEventListener(event,fn,opts);listeners.push(()=>el.removeEventListener(event,fn,opts));};
  const status=(message)=>{const node=$('.wf-status');if(node.textContent!==message)node.textContent=message;};
  function context(){return contextAdapter.getContext();}
  function banner(){const f=freshness(manifest,context());$('.wf-banner').textContent=f.message+(!f.ok&&manualSignals?' 可从左侧信号列表查看该运行的历史波形。':'');$('.wf-banner').dataset.state=f.status;}
  function invalidate(){clearTimeout(refreshTimer);refreshTimer=null;queuedRefresh=false;viewGeneration++;controller?.abort();controller=new AbortController();return {version:++revision,signal:controller.signal};}
  const isActive=v=>!disposed&&v===revision;
  function bounds(){const ranges=catalog?.signals.filter(s=>s.status==='available'&&s.domain).map(s=>s.domain)||[];return ranges.length?[Math.min(...ranges.map(d=>d[0])),Math.max(...ranges.map(d=>d[1]))]:[0,1];}
  function setWindow(a,b){if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b){status('时间窗需有限数字且开始 < 结束。');return false;}windowRange=[a,b];$('.wf-start').value=a;$('.wf-end').value=b;return true;}
  function renderList(){
    const list=$('.wf-list');list.replaceChildren();$('[data-action=add-all]').hidden=!manualSignals;$('[data-action=add-all]').disabled=!manualSignals||!catalog?.signals.some(s=>s.status==='available'&&s.analysis==='tran');const q=$('.wf-search').value.toLowerCase();
    for(const signal of catalog?.signals||[]){if(!signal.label.toLowerCase().includes(q))continue;const b=document.createElement('button');b.type='button';b.dataset.signalId=signal.id;b.textContent=`${signal.label} · ${signal.unit||'待提取'}`;b.title=signal.psf_name;b.disabled=!manualSignals;b.onclick=()=>signal.status==='available'?void add(signal):status('已在真实 raw catalog 保存，尚未提取；不会自动启动 OCEAN。');list.append(b);}
    if(!list.childElementCount)list.textContent=catalog?'无匹配的已导出信号。':'选择一个运行。';
  }
  function renderLegend(){
    const legend=$('.wf-legend');legend.replaceChildren();for(const [id,t]of traces){const item=document.createElement('span');item.className='wf-trace';item.dataset.trace=id;
      const dot=document.createElement('span');dot.className='wf-dot';dot.style.background=t.color;
      const toggle=document.createElement('button');toggle.textContent=`${t.signal.label} (${t.signal.unit})${t.scale===-1?' ×−1':''}${t.signal.quantity==='current'?' · '+((t.mapping?.polarity||t.signal.polarity)==='into_terminal'?'流入端口':'方向见映射'):''}`;toggle.setAttribute('aria-pressed',String(t.visible));toggle.title=t.mapping?.polarity||t.signal.polarity||'PSF导出符号；电流方向未绑定时不推断';toggle.onclick=()=>{t.visible=!t.visible;renderLegend();paint();};
      const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label','移除 '+t.signal.label);remove.onclick=()=>{traces.delete(id);void reload();};item.append(dot,toggle,remove);legend.append(item);}
  }
  function renderMeasurements(){
    const container=$('.wf-cursors');container.replaceChildren();const table=document.createElement('table');const head=table.createTHead().insertRow();
    for(const label of ['信号','A','B','Δt','Δy','方法']){const th=document.createElement('th');th.textContent=label;head.append(th);}
    for(const t of traces.values()){const m=!t.pending&&t.data?.measurement;if(!m)continue;const r=table.insertRow();const a=m.cursors?.a,b=m.cursors?.b;
      for(const text of [t.signal.label,engineering(a?.y===undefined?null:a.y*t.scale,t.signal.unit),engineering(b?.y===undefined?null:b.y*t.scale,t.signal.unit),engineering(m.delta?.dt,'s'),engineering(m.delta?.dy===undefined?null:m.delta.dy*t.scale,t.signal.unit),labels.measurement||(m.basis==='PSFXL_native_samples'?'PSFXL原始样本 / 线性插值':'OCEAN重采样 CSV / 线性插值')])r.insertCell().textContent=text;}
    container.append(table);
    const counts=[...traces.values()].filter(t=>t.data).map(t=>`${t.signal.label}: ${t.data.display.returned_points}/${t.data.display.input_points}`);
    $('.wf-data-note').textContent=labels.dataNote||`${counts.join(' · ')}${counts.length?' · ':''}显示为窗口 min/max 保峰抽样；游标读取完整 CSV 并明确插值，不使用绘图抽样。原 CSV 已经可能经过 OCEAN 5 ps 插值。`;
  }
  function markPending(){viewGeneration++;let changed=false;for(const t of traces.values()){if(!t.pending)changed=true;t.pending=true;}if(changed)renderMeasurements();paint();}
  function scheduleReload(){
    markPending();status('预览中，实时更新细节…');
    if(activeRead){queuedRefresh=true;return;}
    if(refreshTimer!==null)return;
    refreshTimer=setTimeout(()=>{refreshTimer=null;void reload();},Math.max(0,180-(performance.now()-lastReadAt)));
  }
  async function reload(){
    clearTimeout(refreshTimer);refreshTimer=null;
    if(activeRead){markPending();queuedRefresh=true;return activeRead;}
    const task=readWindow();activeRead=task;
    try{await task;}finally{if(activeRead===task)activeRead=null;if(queuedRefresh&&!disposed){queuedRefresh=false;if(drag?.moved)scheduleReload();else void reload();}}
  }
  async function readWindow(){
    if(!rid||!windowRange)return;const {version,signal}=invalidate();status('读取时间窗…');
    const generation=viewGeneration;lastReadAt=performance.now();for(const t of traces.values())t.pending=true;
    renderMeasurements();paint();
    const entries=[...traces.entries()];
    const results=await Promise.allSettled(entries.map(async([id,t])=>{
      const params={start:windowRange[0],end:windowRange[1],limit:Math.min(4000,Math.max(200,Math.round(plot.clientWidth*2)))};
      if(cursors.a!==null)params.cursor_a=cursors.a;if(cursors.b!==null)params.cursor_b=cursors.b;
      // Revalidate through the adapter, including its bound revision and cursor context.
      const data=await api.waveform(rid,t.signal.id,params,{signal});
      return [id,data];
    }));
    if(!isActive(version))return;
    const current=generation===viewGeneration&&!drag?.moved;
    const errors=[];for(const result of results){if(result.status==='fulfilled'){const [id,data]=result.value;if(traces.has(id)){
      const t=traces.get(id);t.data=data;t.pending=!current;
      const span=d=>d?.points?.length?(d.points.at(-1)[0]-d.points[0][0]):-1;
      if(span(data)>span(t.overview))t.overview=data;
    }}else if(result.reason?.name!=='AbortError')errors.push(result.reason.message);}
    renderLegend();renderMeasurements();paint();status(errors.length?'读取失败：'+errors.join('；'):!current?'预览中，实时更新细节…':traces.size?(labels.loaded||'已加载真实运行数据。'):'点击 RNL 节点或目录中的信号叠加。');
  }
  async function add(signal,mapping=null){
    if(signal.analysis!=='tran'){status('此分析尚不支持。');return;}
    const scale=mapping?.scale??1,id=signal.id+':'+scale;
    if(!traces.has(id)){if(traces.size>=maxTraces){status(`最多叠加 ${maxTraces} 条曲线，请移除后继续。`);return;}traces.set(id,{signal,mapping,scale,color:COLORS[colorIndex++%COLORS.length],visible:true,data:null});}
    else traces.get(id).visible=true;
    renderLegend();await reload();
  }
  async function addAll(){
    if(!manualSignals||!catalog||!rid)return;
    const available=catalog.signals.filter(s=>s.status==='available'&&s.analysis==='tran');
    let skipped=0;
    for(const signal of available){
      const id=signal.id+':1';
      if(traces.has(id)){traces.get(id).visible=true;continue;}
      if(traces.size>=maxTraces){skipped++;continue;}
      traces.set(id,{signal,mapping:null,scale:1,color:COLORS[colorIndex++%COLORS.length],visible:true,data:null});
    }
    renderLegend();await reload();
    if(skipped)status(`最多叠加 ${maxTraces} 条；其余 ${skipped} 条请移除已有曲线后选择。`);
  }
  async function setRun(id){
    const {version,signal}=invalidate();rid=id;run.value=id;traces.clear();catalog=null;manifest=null;windowRange=null;colorIndex=0;
    $('.wf-provenance').textContent='';$('.wf-choices').replaceChildren();$('.wf-proposal').hidden=true;renderList();renderLegend();renderMeasurements();paint();banner();
    if(!rid)return;status('读取该运行的信号库存与映射…');
    try{const [c,m]=await Promise.all([api.catalog(id,{signal}),api.mapping(id,{signal})]);if(!isActive(version))return;catalog=c;manifest=m;setWindow(...bounds());
      cursors={a:bounds()[0]+(bounds()[1]-bounds()[0])/3,b:bounds()[0]+2*(bounds()[1]-bounds()[0])/3};$('.wf-a').value=cursors.a;$('.wf-b').value=cursors.b;
      $('.wf-provenance').textContent=labels.provenance||`${id} · source ${c.source_commit} · CSV SHA256 ${c.csv_sha256}`;banner();renderList();paint();status(labels.catalog||'目录为真实导出子集；选择信号开始查看。');lastSelection='';if(followSelection)void acceptContext(context());
    }catch(e){if(isActive(version)&&e.name!=='AbortError')status('目录读取失败：'+e.message);}
  }
  async function refreshRuns(){try{const response=await api.jobs();if(disposed)return;const old=rid;run.replaceChildren(new Option('选择已保存运行',''));for(const j of response.jobs||[])run.add(new Option(`${j.associated_project_id||j.project_id||''} · ${j.configuration||''} · ${j.run_id}`,j.run_id));run.value=old;
    const initial=context()?.run?.runId;if(!rid&&initial&&[...run.options].some(o=>o.value===initial))await setRun(initial);
  }catch(e){if(!disposed)status('运行列表读取失败：'+e.message);}}
  async function acceptContext(ctx){
    if(disposed)return;banner();const nextRun=ctx?.run?.runId;
    if(nextRun&&nextRun!==lastContextRun){lastContextRun=nextRun;if(nextRun!==rid){void setRun(nextRun);return;}}
    const guardKey=JSON.stringify(context());
    const key=JSON.stringify([ctx?.selection,ctx?.file?.currentTextSha256,ctx?.file?.dirty,ctx?.geometry,ctx?.project?.sourceCommit,rid]);if(key===lastSelection)return;lastSelection=key;
    $('.wf-choices').replaceChildren();$('.wf-proposal').hidden=true;
    if(!catalog||!ctx?.selection)return;
    if(!probeAllowed(ctx)){status('探针已退出或选择已过期；请在主窗口重新选择。');return;}
    const result=resolveSelection(manifest,ctx,catalog);
    if(result.status==='resolved'){await add(result.signal,result.mapping);return;}
    if(['source_mismatch','geometry_mismatch'].includes(result.status))invalidate();
    status(result.message);const choices=$('.wf-choices');
    for(const item of result.choices||[]){const b=document.createElement('button');const x=item.selector;b.textContent=[x.occurrence_path.length?x.occurrence_path.join(' / '):'(top)',x.name,x.terminal_name||'',x.bus_bit??'',item.polarity||''].filter(x=>x!=='').join(' · ');b.onclick=()=>{
      if(!probeAllowed(ctx)||JSON.stringify(context())!==guardKey){status('选择上下文已变化，请重新选择对象。');return;}
      void acceptContext({...ctx,selection:{...ctx.selection,kind:x.kind,occurrencePath:x.occurrence_path,terminalName:x.terminal_name,busBit:x.bus_bit}});
    };choices.append(b);}
    if(result.proposal){$('.wf-proposal').hidden=false;$('.wf-proposal pre').textContent=typeof result.proposal==='string'?result.proposal:JSON.stringify(result.proposal,null,2);}
  }
  function paint(){frames.schedule();}
  function draw(){
    const width=plot.clientWidth,height=plot.clientHeight,dpr=devicePixelRatio||1;if(disposed||width<1||height<1)return;
    const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);if(plot.width!==pixelWidth)plot.width=pixelWidth;if(plot.height!==pixelHeight)plot.height=pixelHeight;
    const c=plot.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.fillStyle='#0b1522';c.fillRect(0,0,width,height);c.font='11px system-ui';
    const groups=['V','A'].map(unit=>({unit,items:[...traces.values()].filter(t=>t.visible&&t.signal.unit===unit&&t.data&&(t.data.points.length||t.overview?.points.length))})).filter(g=>g.items.length);
    if(!groups.length){c.fillStyle='#9eafc4';c.fillText(traces.size?'当前窗口无数据 / 正在读取':'点击节点或信号名称叠加真实波形',20,42);return;}
    const left=66,right=Math.max(left+1,width-18),top=height<180?16:22,pane=Math.max(24,(height-top-8)/groups.length);
    groups.forEach((g,gi)=>{let low=Infinity,high=-Infinity;const vectors=new Map();
      for(const t of g.items){
        // Keep a wider overview while new detail catches up; never erase curves to load.
        const [a,b]=windowRange,domain=t.signal.domain||[a,b],lo=Math.max(a,domain[0]),hi=Math.min(b,domain[1]);
        const covers=data=>data?.points?.length&&data.points[0][0]<=lo&&data.points.at(-1)[0]>=hi;
        const data=!covers(t.data)&&covers(t.overview)?t.overview:t.data;
        const key=JSON.stringify([windowRange,width]);let cached=drawCache.get(data);if(cached?.key!==key){cached={key,points:displayEnvelope(data.points,...windowRange,Math.max(1,Math.min(1600,width-84)))};drawCache.set(data,cached);}vectors.set(t,cached.points);for(const p of cached.points){low=Math.min(low,p[1]*t.scale);high=Math.max(high,p[1]*t.scale);}}
      if(!Number.isFinite(low)||!Number.isFinite(high)){c.fillStyle='#9eafc4';c.fillText('此时间段暂无已读取数据 · F 返回全部范围',left,top+gi*pane+18);return;}
      const pad=(high-low||Math.abs(high)*.1||1)*.08;low-=pad;high+=pad;
      const y0=top+gi*pane,y1=y0+Math.max(8,pane-26);const x=x=>left+(x-windowRange[0])/(windowRange[1]-windowRange[0])*(right-left),y=v=>y1-(v-low)/(high-low)*(y1-y0);
      c.fillStyle='#bdcce0';c.fillText(g.unit,left,y0-5);for(let n=0;n<=4;n++){const v=low+(high-low)*n/4,py=y(v);c.strokeStyle='#24354a';c.beginPath();c.moveTo(left,py);c.lineTo(right,py);c.stroke();c.fillText(engineering(v,g.unit),2,py+3);}
      for(let n=0;n<=4;n++){const v=windowRange[0]+(windowRange[1]-windowRange[0])*n/4,px=x(v);c.strokeStyle='#24354a';c.beginPath();c.moveTo(px,y0);c.lineTo(px,y1);c.stroke();c.fillStyle='#9eafc4';c.fillText(engineering(v,'s'),Math.max(left-15,Math.min(right-52,px-15)),y1+18);}
      c.save();c.beginPath();c.rect(left,y0,right-left,y1-y0);c.clip();for(const t of g.items){c.strokeStyle=t.color;c.lineWidth=1.5;c.beginPath();vectors.get(t).forEach((p,i)=>i?c.lineTo(x(p[0]),y(p[1]*t.scale)):c.moveTo(x(p[0]),y(p[1]*t.scale)));c.stroke();}
      for(const [name,value]of Object.entries(cursors)){if(value===null)continue;c.strokeStyle=name==='a'?'#efebaf':'#f49dcb';c.setLineDash([4,4]);c.beginPath();c.moveTo(x(value),y0);c.lineTo(x(value),y1);c.stroke();c.setLineDash([]);c.fillStyle=c.strokeStyle;c.fillText(name.toUpperCase(),x(value)+3,y0+14);}c.restore();
    });
    if(drag?.mode==='zoom'&&drag.moved){const x0=Math.min(drag.localX,drag.currentX),x1=Math.max(drag.localX,drag.currentX);c.fillStyle='#69bdfc25';c.fillRect(x0,0,x1-x0,height);c.strokeStyle='#69bdfc';c.strokeRect(x0+.5,.5,x1-x0,height-1);}
    if([...traces.values()].some(t=>t.pending)){c.fillStyle='#a9bbd0';c.fillText('预览 · 等待细节',Math.max(70,width-115),14);}
  }
  function zoom(factor,anchor=.5){if(!windowRange)return;const [a,b]=windowRange,w=(b-a)*factor,x=a+(b-a)*anchor;if(w<Number.EPSILON*Math.max(Math.abs(x),1e-18))return;if(setWindow(x-w*anchor,x+w*(1-anchor)))scheduleReload();}
  let drag=null,interaction='pan';
  function setInteraction(mode){if(!['pan','zoom'].includes(mode))return;const moved=drag?.moved;interaction=mode;drag=null;plot.dataset.interaction=mode;paint();if(moved)void reload();}
  const fraction=x=>Math.max(0,Math.min(1,(x-66)/Math.max(1,plot.clientWidth-84)));
  on(plot,'pointerdown',e=>{if(!windowRange||e.button!==0)return;clearTimeout(refreshTimer);refreshTimer=null;queuedRefresh=false;viewGeneration++;plot.focus({preventScroll:true});plot.setPointerCapture(e.pointerId);const x=e.clientX-plot.getBoundingClientRect().left;drag={x:e.clientX,localX:x,currentX:x,start:[...windowRange],moved:false,mode:interaction};});
  on(plot,'pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x;if(Math.abs(dx)>4&&!drag.moved){drag.moved=true;markPending();}drag.currentX=e.clientX-plot.getBoundingClientRect().left;if(drag.moved){if(drag.mode==='pan'){const dt=dx/Math.max(1,plot.clientWidth-84)*(drag.start[1]-drag.start[0]);setWindow(drag.start[0]-dt,drag.start[1]-dt);scheduleReload();}paint();}});
  on(plot,'pointerup',e=>{if(!drag)return;const d=drag;drag=null;if(d.moved){if(d.mode==='zoom'){const span=d.start[1]-d.start[0],a=fraction(Math.min(d.localX,d.currentX)),b=fraction(Math.max(d.localX,d.currentX));if(a<b)setWindow(d.start[0]+a*span,d.start[0]+b*span);setInteraction('pan');}void reload();return;}const f=fraction(e.clientX-plot.getBoundingClientRect().left);const k=$('.wf-cursor-mode').value.toLowerCase();cursors[k]=windowRange[0]+f*(windowRange[1]-windowRange[0]);$('.wf-'+k).value=cursors[k];void reload();});
  on(plot,'pointercancel',()=>{const moved=drag?.moved;drag=null;if(moved)scheduleReload();});
  on(plot,'wheel',e=>{if(!windowRange)return;e.preventDefault();zoom(e.deltaY<0?.8:1.25,Math.max(0,Math.min(1,(e.offsetX-66)/(plot.clientWidth-84))));},{passive:false});
  on(plot,'keydown',e=>{if(!windowRange)return;if(['+','=','-','f','F','ArrowLeft','ArrowRight'].includes(e.key))e.preventDefault();if(['+','='].includes(e.key))zoom(.8);else if(e.key==='-')zoom(1.25);else if(e.key.toLowerCase()==='f'){setWindow(...bounds());void reload();}else if(['ArrowLeft','ArrowRight'].includes(e.key)){const dt=(windowRange[1]-windowRange[0])*.2*(e.key==='ArrowLeft'?-1:1);setWindow(windowRange[0]+dt,windowRange[1]+dt);scheduleReload();}});
  on(run,'change',()=>{if(!managedRun)void setRun(run.value);});on($('.wf-search'),'input',renderList);
  on(root,'click',e=>{const action=e.target.closest('[data-action]')?.dataset.action;if(!action)return;
    if(action==='add-all')void addAll();else if(action==='refresh')void refreshRuns();else if(action==='fit'){setWindow(...bounds());void reload();}else if(action==='zoom-in')zoom(.8);else if(action==='zoom-out')zoom(1.25);else if(action==='window'){if(setWindow(Number($('.wf-start').value),Number($('.wf-end').value)))void reload();}else if(action==='measure'){const a=$('.wf-a').value,b=$('.wf-b').value;if(a===''||b===''||!Number.isFinite(Number(a))||!Number.isFinite(Number(b))){status('游标必须为有限秒数。');return;}cursors={a:Number(a),b:Number(b)};void reload();}else if(action==='cancel'){invalidate();for(const t of traces.values())t.data=null;renderMeasurements();paint();status('已取消本地读取；未取消或启动仿真。');}});
  const resize=new ResizeObserver(paint);resize.observe(plot);const unsubscribe=contextAdapter.subscribe(ctx=>{
    if(followSelection){void acceptContext(ctx||context());return;}
    // Controlled consumers update identity/freshness without interpreting ordinary selection as a probe.
    banner();if(catalog)invalidate();lastSelection='';$('.wf-choices').replaceChildren();$('.wf-proposal').hidden=true;
    const f=freshness(manifest,ctx||context());if(!f.ok)status(f.message);
  });
  banner();renderList();paint();void refreshRuns();
  return {setRun,refreshRuns,setInteraction,
    async probe(ctx=context()){
      if(disposed||JSON.stringify(ctx)!==JSON.stringify(context())||!probeAllowed(ctx))return false;
      lastSelection='';await acceptContext(ctx);return !disposed;
    },
    destroy(){disposed=true;invalidate();frames.dispose();unsubscribe?.();resize.disconnect();listeners.forEach(f=>f());root.replaceChildren();},
    snapshot(){return {runId:rid,traceCount:traces.size,window:windowRange,cursors,signals:[...traces.values()].map(t=>({id:t.signal.id,label:t.signal.label,visible:t.visible,loaded:!!t.data&&!t.pending})),state:$('.wf-banner').dataset.state};}};
}
