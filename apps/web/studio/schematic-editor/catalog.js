// Device & subcircuit catalog for the Virtuoso-style `I` (Add Instance) picker.
import {parseVerilogAModule,verilogaModuleBasename} from '../../library/veriloga.js';

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
    symbolDef:`%cg_sym_resistor = @DEFINE-SYMBOL(box=[-5, -1.4, 5, 1.4]) {
//     (-5, 0) @PIN(terminal=1);
//     (5, 0) @PIN(terminal=2);
//     @LINE {(-5, 0) (-3, 0) (-2.5, 0.8) (-1.5, -0.8) (-0.5, 0.8) (0.5, -0.8) (1.5, 0.8) (2.5, -0.8) (3, 0) (5, 0)};
//     ? @TEXT("\${name}", size=1, key="name", halign="middle") => @PLACE(0, 2.2);
//     ? @TEXT("\${r}", size=0.9, halign="middle") => @PLACE(0, -2.2)
//   }`,
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
    symbolDef:`%cg_sym_capacitor = @DEFINE-SYMBOL(box=[-2.2, -4, 2.2, 4]) {
//     (0, 4) @PIN(terminal=1);
//     (0, -4) @PIN(terminal=2);
//     @LINE {(0, 4) (0, 0.5)};
//     @LINE {(-2, 0.5) (2, 0.5)};
//     @LINE {(-2, -0.5) (2, -0.5)};
//     @LINE {(0, -0.5) (0, -4)};
//     ? @TEXT("\${name}", size=1, key="name") => @PLACE(2.8, 1.2);
//     ? @TEXT("\${c}", size=0.9) => @PLACE(2.8, -1.2)
//   }`,
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
    id:'nch_ulvt_mac',
    category:'PDK MOS',
    name:'nch_ulvt_mac',
    label:'NMOS 4T (nch_ulvt_mac)',
    prefix:'M',
    model:'nch_ulvt_mac',
    ports:['d','g','s','b'],
    params:[{name:'l',value:'30n'},{name:'w',value:'250n'},{name:'nf',value:'1'},{name:'multi',value:'1'}],
    symbolId:'%cg_sym_nmos4',
    previewBox:[0,-3,4,3],
    symbolDef:`%cg_sym_nmos4 = @DEFINE-SYMBOL(box=[0, -3, 4, 3]) {
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
//   }`,
  },
  {
    id:'pch_ulvt_mac',
    category:'PDK MOS',
    name:'pch_ulvt_mac',
    label:'PMOS 4T (pch_ulvt_mac)',
    prefix:'M',
    model:'pch_ulvt_mac',
    ports:['d','g','s','b'],
    params:[{name:'l',value:'30n'},{name:'w',value:'500n'},{name:'nf',value:'1'},{name:'multi',value:'1'}],
    symbolId:'%cg_sym_pmos4',
    previewBox:[0,-3,4,3],
    symbolDef:`%cg_sym_pmos4 = @DEFINE-SYMBOL(box=[0, -3, 4, 3]) {
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
//   }`,
  },
  {
    id:'nmos',
    category:'PDK MOS',
    name:'nmos',
    label:'通用 NMOS 4T (nmos)',
    prefix:'M',
    model:'nmos',
    ports:['d','g','s','b'],
    params:[{name:'w',value:'1u'},{name:'l',value:'180n'}],
    symbolId:'%cg_sym_nmos4',
    previewBox:[0,-3,4,3],
    symbolDef:`%cg_sym_nmos4 = @DEFINE-SYMBOL(box=[0, -3, 4, 3]) {
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
//   }`,
  },
  {
    id:'pmos',
    category:'PDK MOS',
    name:'pmos',
    label:'通用 PMOS 4T (pmos)',
    prefix:'M',
    model:'pmos',
    ports:['d','g','s','b'],
    params:[{name:'w',value:'2u'},{name:'l',value:'180n'}],
    symbolId:'%cg_sym_pmos4',
    previewBox:[0,-3,4,3],
    symbolDef:`%cg_sym_pmos4 = @DEFINE-SYMBOL(box=[0, -3, 4, 3]) {
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
//   }`,
  },
];

/**
 * Assemble the complete `I` (Add Instance) catalog from built-in devices, loaded subcircuits in `doc`,
 * cells in the active project library, and Verilog-A models.
 */
export function buildInstanceCatalog({doc=null,activeLibrary=null,verilogaModels=[]}={}){
  const items=[...BUILTIN_DEVICES];
  const seen=new Set(items.map(i=>i.model.toLowerCase()));

  // 1. Subcircuits already defined in the loaded RNL document (immediate ports available!)
  if(doc?.levels?.length){
    for(let i=1;i<doc.levels.length;i++){
      const lv=doc.levels[i];
      if(!lv?.title||seen.has(lv.title.toLowerCase()))continue;
      seen.add(lv.title.toLowerCase());
      const ports=Array.isArray(lv.ports)&&lv.ports.length?lv.ports:['in','out'];
      const rows=Math.max(Math.ceil(ports.length/2),1);
      const halfH=Math.max(3,rows*2+1);
      items.push({
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

  // 2. Other circuit cells in the active library
  if(activeLibrary?.library?.cells?.length){
    for(const cell of activeLibrary.library.cells){
      if(!cell?.name||cell.kind==='testbench'||seen.has(cell.name.toLowerCase()))continue;
      seen.add(cell.name.toLowerCase());
      items.push({
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

  // 3. Verilog-A behavioral models
  for(const model of Array.isArray(verilogaModels)?verilogaModels:[]){
    const modName=model?.moduleName||verilogaModuleBasename(model?.path||'');
    if(!modName||seen.has(modName.toLowerCase()))continue;
    seen.add(modName.toLowerCase());
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
    items.push({
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

  return items;
}
