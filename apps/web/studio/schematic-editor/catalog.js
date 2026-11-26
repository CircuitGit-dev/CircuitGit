// Device & subcircuit catalog for the Virtuoso-style `I` (Add Instance) picker.
// Dynamically incorporates real PDK models probed from SSH/SpiceOwl and models observed in the open netlist.
import {parseVerilogAModule,verilogaModuleBasename} from '../../library/veriloga.js';
import {parseParamsText} from './rnl-codec.js';

const NMOS4_SYMBOL_DEF=`%cg_sym_nmos4 = @DEFINE-SYMBOL(box=[0, -3, 4, 3]) {
//     @LINE {(2, 1.5) (4, 1.5) (4, 3)};
//     @LINE {(2, -1.5) (2, 1.5)};
//     @LINE {(3, -1) (4, -1.5) (3, -2)};
//     @LINE {(0, 0) (1.5, 0)};
//     @LINE {(1.5, 1.5) (1.5, -1.5)};
//     @LINE {(2, -1.5) (4, -1.5) (4, -3)};
//     ? @TEXT("\${name}", size=0.85, halign="start", valign="baseline", key="name") => @PLACE(4.8, 2.4);
//     ? @TEXT("\${model}", size=0.75, halign="start", valign="baseline", key="model") => @PLACE(4.8, 1.1);
//     (4, 3) @PIN(terminal=1);
//     (0, 0) @PIN(terminal=2);
//     (4, -3) @PIN(terminal=3);
//     (4, -1) @PIN(terminal=4)
//   }`;

const PMOS4_SYMBOL_DEF=`%cg_sym_pmos4 = @DEFINE-SYMBOL(box=[0, -3, 4, 3]) {
//     @LINE {(0, 0) (0.7, 0)};
//     @LINE {(1.5, 1.5) (1.5, -1.5)};
//     @LINE {(2, -1.5) (4, -1.5) (4, -3)};
//     @LINE {(2, 1.5) (4, 1.5) (4, 3)};
//     (1.1, 0) @CIRCLE(radius=0.4);
//     @LINE {(3.7, 2) (2.7, 1.5) (3.7, 1)};
//     @LINE {(2, -1.5) (2, 1.5)};
//     ? @TEXT("\${name}", size=0.85, halign="start", valign="baseline", key="name") => @PLACE(4.8, 2.4);
//     ? @TEXT("\${model}", size=0.75, halign="start", valign="baseline", key="model") => @PLACE(4.8, 1.1);
//     (4, -3) @PIN(terminal=1);
//     (0, 0) @PIN(terminal=2);
//     (4, 3) @PIN(terminal=3);
//     (4, 1) @PIN(terminal=4)
//   }`;

const RES_SYMBOL_DEF=`%cg_sym_resistor = @DEFINE-SYMBOL(box=[-5, -1.4, 5, 1.4]) {
//     (-5, 0) @PIN(terminal=1);
//     (5, 0) @PIN(terminal=2);
//     @LINE {(-5, 0) (-3, 0) (-2.5, 0.8) (-1.5, -0.8) (-0.5, 0.8) (0.5, -0.8) (1.5, 0.8) (2.5, -0.8) (3, 0) (5, 0)};
//     ? @TEXT("\${name}", size=1, key="name", halign="middle") => @PLACE(0, 2.2);
//     ? @TEXT("\${r}", size=0.9, halign="middle") => @PLACE(0, -2.2)
//   }`;

const CAP_SYMBOL_DEF=`%cg_sym_capacitor = @DEFINE-SYMBOL(box=[-2.2, -4, 2.2, 4]) {
//     (0, 4) @PIN(terminal=1);
//     (0, -4) @PIN(terminal=2);
//     @LINE {(0, 4) (0, 0.5)};
//     @LINE {(-2, 0.5) (2, 0.5)};
//     @LINE {(-2, -0.5) (2, -0.5)};
//     @LINE {(0, -0.5) (0, -4)};
//     ? @TEXT("\${name}", size=1, key="name") => @PLACE(2.8, 1.2);
//     ? @TEXT("\${c}", size=0.9) => @PLACE(2.8, -1.2)
//   }`;

export const BUILTIN_DEVICES=[
  {
    id:'resistor',
    category:'基础器件',
    name:'resistor',
    label:'电阻 (resistor)',
    prefix:'R',
    model:'resistor',
    ports:['1','2'],
    params:[{name:'r',value:'1k'}],
    symbolId:'%cg_sym_resistor',
    previewBox:[-5,-1.4,5,1.4],
    symbolDef:RES_SYMBOL_DEF,
  },
  {
    id:'capacitor',
    category:'基础器件',
    name:'capacitor',
    label:'电容 (capacitor)',
    prefix:'C',
    model:'capacitor',
    ports:['1','2'],
    params:[{name:'c',value:'1p'}],
    symbolId:'%cg_sym_capacitor',
    previewBox:[-2.2,-4,2.2,4],
    symbolDef:CAP_SYMBOL_DEF,
  },
  {
    id:'inductor',
    category:'基础器件',
    name:'inductor',
    label:'电感 (inductor)',
    prefix:'L',
    model:'inductor',
    ports:['1','2'],
    params:[{name:'l',value:'1n'}],
    symbolId:'%cg_sym_inductor',
    previewBox:[-5,-1.5,5,1.5],
    symbolDef:`%cg_sym_inductor = @DEFINE-SYMBOL(box=[-5, -1.5, 5, 1.5]) {
//     (-5, 0) @PIN(terminal=1);
//     (5, 0) @PIN(terminal=2);
//     @LINE {(-5, 0) (-3, 0)};
//     @ARC {(-3, 0) (-2, 1.2) (-1, 0)};
//     @ARC {(-1, 0) (0, 1.2) (1, 0)};
//     @ARC {(1, 0) (2, 1.2) (3, 0)};
//     @LINE {(3, 0) (5, 0)};
//     ? @TEXT("\${name}", size=1, key="name", halign="middle") => @PLACE(0, 2.2)
//   }`,
  },
  {
    id:'vsource',
    category:'电源与地',
    name:'vsource',
    label:'电压源 (vsource)',
    prefix:'V',
    model:'vsource',
    ports:['1','2'],
    params:[{name:'type',value:'dc'},{name:'dc',value:'1'}],
    symbolId:'%cg_sym_vsource',
    previewBox:[-2.2,-4,2.2,4],
    symbolDef:`%cg_sym_vsource = @DEFINE-SYMBOL(box=[-2.2, -4, 2.2, 4]) {
//     (0, 4) @PIN(terminal=1);
//     (0, -4) @PIN(terminal=2);
//     (0, 0) @CIRCLE(radius=2);
//     @LINE {(0, 4) (0, 2)};
//     @LINE {(0, -2) (0, -4)};
//     @LINE {(-0.6, 0.8) (0.6, 0.8)};
//     @LINE {(0, 0.2) (0, 1.4)};
//     @LINE {(-0.6, -0.8) (0.6, -0.8)};
//     ? @TEXT("\${name}", size=1, key="name", halign="end") => @PLACE(-2.8, 1.2)
//   }`,
  },
  {
    id:'isource',
    category:'电源与地',
    name:'isource',
    label:'电流源 (isource)',
    prefix:'I',
    model:'isource',
    ports:['1','2'],
    params:[{name:'type',value:'dc'},{name:'dc',value:'10u'}],
    symbolId:'%cg_sym_isource',
    previewBox:[-2.2,-4,2.2,4],
    symbolDef:`%cg_sym_isource = @DEFINE-SYMBOL(box=[-2.2, -4, 2.2, 4]) {
//     (0, 4) @PIN(terminal=1);
//     (0, -4) @PIN(terminal=2);
//     (0, 0) @CIRCLE(radius=2);
//     @LINE {(0, 4) (0, 2)};
//     @LINE {(0, -2) (0, -4)};
//     @LINE {(0, 1.1) (0, -1.1)};
//     @LINE {(-0.6, -0.4) (0, -1.1) (0.6, -0.4)};
//     ? @TEXT("\${name}", size=1, key="name", halign="end") => @PLACE(-2.8, 1.2)
//   }`,
  },
  {
    id:'gnd',
    category:'电源与地',
    name:'gnd',
    label:'接地符号 (GND / 0)',
    prefix:'GND',
    model:'gnd',
    ports:['0'],
    params:[],
    virtualKind:'ground',
    previewBox:[-2,-3,2,0],
  },
  {
    id:'nmos',
    category:'通用晶体管',
    name:'nmos',
    label:'通用 NMOS 4T (nmos)',
    prefix:'M',
    model:'nmos',
    ports:['d','g','s','b'],
    params:[{name:'w',value:'1u'},{name:'l',value:'180n'}],
    symbolId:'%cg_sym_nmos4',
    previewBox:[0,-3,4,3],
    symbolDef:NMOS4_SYMBOL_DEF,
  },
  {
    id:'pmos',
    category:'通用晶体管',
    name:'pmos',
    label:'通用 PMOS 4T (pmos)',
    prefix:'M',
    model:'pmos',
    ports:['d','g','s','b'],
    params:[{name:'w',value:'2u'},{name:'l',value:'180n'}],
    symbolId:'%cg_sym_pmos4',
    previewBox:[0,-3,4,3],
    symbolDef:PMOS4_SYMBOL_DEF,
  },
];

function inferDeviceTemplate(modelName,{polarity=null,ports=null,params=null,sourceTag='PDK'}={}){
  const lower=String(modelName||'').toLowerCase();
  const isPmos=polarity==='p'||/^(?:pch|pmos|pfet|p_|lvp|hvp|svtp|ulvp|pm\d)/i.test(lower);
  const isNmos=polarity==='n'||(!isPmos&&/^(?:nch|nmos|nfet|n_|lvn|hvn|svtn|ulvn|nm\d)/i.test(lower));
  const isCap=!isNmos&&!isPmos&&/(?:^c(?:ap|fmom|mim|mos|var)|mom|mim|cap$)/i.test(lower);
  const isRes=!isNmos&&!isPmos&&!isCap&&/(?:^r(?:es|nod|ppoly|npoly|metal|diff|po|nw)|_res$)/i.test(lower);

  if(isNmos||isPmos){
    return {
      id:`pdk:${modelName}`,
      category:sourceTag==='PDK'?'已探测 PDK 器件':'当前工程 PDK 器件',
      name:modelName,
      label:`${modelName} (${isPmos?'PMOS':'NMOS'} · ${sourceTag})`,
      prefix:'M',
      model:modelName,
      ports:Array.isArray(ports)&&ports.length?ports:['d','g','s','b'],
      params:Array.isArray(params)&&params.length?params:[{name:'l',value:'30n'},{name:'w',value:isPmos?'500n':'250n'},{name:'nf',value:'1'},{name:'multi',value:'1'}],
      symbolId:isPmos?'%cg_sym_pmos4':'%cg_sym_nmos4',
      previewBox:[0,-3,4,3],
      symbolDef:isPmos?PMOS4_SYMBOL_DEF:NMOS4_SYMBOL_DEF,
    };
  }
  if(isCap){
    return {
      id:`pdk:${modelName}`,
      category:sourceTag==='PDK'?'已探测 PDK 器件':'当前工程 PDK 器件',
      name:modelName,
      label:`${modelName} (电容 · ${sourceTag})`,
      prefix:'C',
      model:modelName,
      ports:Array.isArray(ports)&&ports.length?ports:['1','2'],
      params:Array.isArray(params)&&params.length?params:[{name:'c',value:'100f'}],
      symbolId:'%cg_sym_capacitor',
      previewBox:[-2.2,-4,2.2,4],
      symbolDef:CAP_SYMBOL_DEF,
    };
  }
  if(isRes){
    return {
      id:`pdk:${modelName}`,
      category:sourceTag==='PDK'?'已探测 PDK 器件':'当前工程 PDK 器件',
      name:modelName,
      label:`${modelName} (电阻 · ${sourceTag})`,
      prefix:'R',
      model:modelName,
      ports:Array.isArray(ports)&&ports.length?ports:['1','2'],
      params:Array.isArray(params)&&params.length?params:[{name:'w',value:'1u'},{name:'l',value:'2u'}],
      symbolId:'%cg_sym_resistor',
      previewBox:[-5,-1.4,5,1.4],
      symbolDef:RES_SYMBOL_DEF,
    };
  }
  const finalPorts=Array.isArray(ports)&&ports.length?ports:['1','2'];
  const rows=Math.max(Math.ceil(finalPorts.length/2),1);
  const halfH=Math.max(3,rows*2+1);
  return {
    id:`pdk:${modelName}`,
    category:sourceTag==='PDK'?'已探测 PDK 器件':'当前工程 PDK 器件',
    name:modelName,
    label:`${modelName} (${finalPorts.length} 端口 · ${sourceTag})`,
    prefix:'X',
    model:modelName,
    ports:finalPorts,
    params:Array.isArray(params)?params:[],
    previewBox:[0,-halfH,14,halfH],
  };
}

/**
 * Extract real PDK device models from a connected SpiceOwl / SSH onboarding session.
 */
export function extractPdkModelsFromSession(session){
  if(!session||typeof session!=='object')return {detected:false,label:'',models:[]};
  const candidates=session.discovery?.candidates||[];
  const chosenId=session.selected_candidate_id||session.recommended_selection?.candidate_id||'';
  const ordered=chosenId
    ? [...candidates.filter(c=>c.candidate_id===chosenId),...candidates.filter(c=>c.candidate_id!==chosenId)]
    : candidates;
  const models=[];
  const seen=new Set();
  let label='';
  for(const cand of ordered){
    if(!label&&cand?.label)label=cand.label;
    for(const contract of cand?.model_contracts||[]){
      const name=String(contract?.name||'').trim();
      if(!name||seen.has(name.toLowerCase()))continue;
      seen.add(name.toLowerCase());
      models.push(inferDeviceTemplate(name,{
        polarity:contract.polarity||null,
        ports:Array.isArray(contract.ordered_terminal_roles)&&contract.ordered_terminal_roles.length?contract.ordered_terminal_roles:null,
        sourceTag:'PDK',
      }));
    }
  }
  return {
    detected:candidates.length>0||models.length>0,
    label:label||(candidates.length?`已发现 ${candidates.length} 个 PDK 候选`:''),
    models,
  };
}

/**
 * Scan the currently open RNL document's Spectre files to discover all PDK/primitive models
 * already used in the active circuit (e.g., nch_ulvt_mac, nch_lvt_mac, pch_lvt_mac, cfmom_2t, rnods).
 */
export function extractModelsFromDocument(doc){
  if(!doc?.files?.length)return [];
  const subcktNames=new Set((doc.levels||[]).map(lv=>String(lv?.title||'').toLowerCase()));
  const builtinLower=new Set(['resistor','capacitor','inductor','vsource','isource','gnd','nmos','pmos','subckt','ends','simulator','global','parameters','include','ahdl_include','save','saveoptions','tran','ac','dc','options','model']);
  const found=new Map();
  const keepParamKeys=new Set(['w','l','nf','m','multi','r','c','nr','lr','s']);

  for(const file of doc.files){
    const text=typeof file?.text==='string'?file.text:'';
    if(!text)continue;
    const lines=text.split(/\r?\n/);
    for(let i=0;i<lines.length;i++){
      let raw=lines[i];
      if(/^\s*(\/\/|\*|$)/.test(raw))continue;
      while(/\\\s*$/.test(raw)&&i+1<lines.length)raw=raw.replace(/\\\s*$/,' ')+lines[++i].trim();
      const cleaned=raw.replace(/\/\/.*$/,'').trim();
      const m=cleaned.match(/^([^\s()]+)\s*\(([^)]*)\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/);
      if(!m)continue;
      const nodes=m[2].trim().split(/\s+/).filter(Boolean);
      const model=m[3];
      const lower=model.toLowerCase();
      if(builtinLower.has(lower)||subcktNames.has(lower)||found.has(lower))continue;
      const parsedParams=parseParamsText(m[4]).filter(p=>keepParamKeys.has(p.name.toLowerCase())).slice(0,5);
      found.set(lower,inferDeviceTemplate(model,{
        ports:nodes.length===4?['d','g','s','b']:Array.from({length:Math.max(2,nodes.length)},(_,k)=>String(k+1)),
        params:parsedParams,
        sourceTag:'当前工程',
      }));
    }
  }
  return [...found.values()];
}

export function buildCustomDeviceSpec(modelName,{kind='nmos',paramsText=''}={}){
  const clean=String(modelName||'').trim();
  if(!clean||/\s/.test(clean))throw Error('请输入有效的 PDK 器件型号（不能包含空格）。');
  const polarity=kind==='pmos'?'p':kind==='nmos'?'n':null;
  const spec=inferDeviceTemplate(clean,{polarity,sourceTag:'自定义'});
  if(kind==='resistor'){
    spec.prefix='R';spec.ports=['1','2'];spec.symbolId='%cg_sym_resistor';spec.symbolDef=RES_SYMBOL_DEF;spec.previewBox=[-5,-1.4,5,1.4];
  }else if(kind==='capacitor'){
    spec.prefix='C';spec.ports=['1','2'];spec.symbolId='%cg_sym_capacitor';spec.symbolDef=CAP_SYMBOL_DEF;spec.previewBox=[-2.2,-4,2.2,4];
  }else if(kind==='subckt'){
    spec.prefix='X';spec.symbolId='';spec.symbolDef='';
  }
  if(paramsText&&paramsText.trim())spec.params=parseParamsText(paramsText);
  return spec;
}

/**
 * Assemble the complete `I` (Add Instance) catalog:
 * 1) Real PDK models from SSH/SpiceOwl discovery (if probed)
 * 2) PDK/primitive models already used in the open project/netlist
 * 3) Built-in passive, source/GND, and generic MOS primitives
 * 4) Loaded subcircuits, library cells, and Verilog-A models
 */
export function buildInstanceCatalog({doc=null,activeLibrary=null,verilogaModels=[],pdkSession=null}={}){
  const items=[];
  const seen=new Set();
  const pushUnique=item=>{
    if(!item?.model)return;
    const key=item.model.toLowerCase();
    if(seen.has(key))return;
    seen.add(key);
    items.push(item);
  };

  // 1. Live probed SSH/SpiceOwl PDK models (highest fidelity!)
  const pdkInfo=extractPdkModelsFromSession(pdkSession);
  for(const item of pdkInfo.models)pushUnique(item);

  // 2. PDK/device models already instantiated in the open schematic files
  const docModels=extractModelsFromDocument(doc);
  for(const item of docModels)pushUnique(item);

  // 3. Standard built-in primitives & generic MOS fallbacks
  for(const item of BUILTIN_DEVICES)pushUnique(item);

  // 4. Subcircuits already defined in the loaded RNL document
  if(doc?.levels?.length){
    for(let i=1;i<doc.levels.length;i++){
      const lv=doc.levels[i];
      if(!lv?.title||seen.has(lv.title.toLowerCase()))continue;
      const ports=Array.isArray(lv.ports)&&lv.ports.length?lv.ports:['in','out'];
      const rows=Math.max(Math.ceil(ports.length/2),1);
      const halfH=Math.max(3,rows*2+1);
      pushUnique({
        id:'subckt:'+lv.title,
        category:'当前项目子电路',
        name:lv.title,
        label:`${lv.title} (${ports.length} 端口)`,
        prefix:'X',
        model:lv.title,
        ports,
        params:[],
        previewBox:[0,-halfH,14,halfH],
      });
    }
  }

  // 5. Other circuit cells in the active library
  if(activeLibrary?.library?.cells?.length){
    for(const cell of activeLibrary.library.cells){
      if(!cell?.name||cell.kind==='testbench'||seen.has(cell.name.toLowerCase()))continue;
      pushUnique({
        id:'cell:'+cell.id,
        category:'当前项目子电路',
        name:cell.name,
        label:`${cell.name} (库单元)`,
        prefix:'X',
        model:cell.name,
        ports:['in','out','VDD','VSS'],
        params:[],
        previewBox:[0,-5,14,5],
      });
    }
  }

  // 6. Verilog-A behavioral models
  for(const model of Array.isArray(verilogaModels)?verilogaModels:[]){
    const modName=model?.moduleName||verilogaModuleBasename(model?.path||'');
    if(!modName||seen.has(modName.toLowerCase()))continue;
    let ports=['in','out'];
    if(typeof model.text==='string'){
      const parsed=parseVerilogAModule(model.text,modName);
      if(parsed.ports?.length){
        const names=parsed.ports.map(p=>typeof p==='string'?p:p?.name).filter(Boolean);
        if(names.length)ports=names;
      }
    }
    const rows=Math.max(Math.ceil(ports.length/2),1);
    const halfH=Math.max(3,rows*2+1);
    pushUnique({
      id:'va:'+modName,
      category:'Verilog-A 模型',
      name:modName,
      label:`${modName} (Verilog-A · ${ports.length} 端口)`,
      prefix:'X',
      model:modName,
      ports,
      params:[],
      previewBox:[0,-halfH,14,halfH],
    });
  }

  return Object.assign(items,{
    pdkStatus:{
      detected:pdkInfo.detected,
      label:pdkInfo.label,
      pdkModelCount:pdkInfo.models.length,
      docModelCount:docModels.length,
    },
  });
}
