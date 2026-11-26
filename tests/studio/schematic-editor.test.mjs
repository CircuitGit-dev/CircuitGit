import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadCore} from '../../apps/web/vendor/rnl-viewer/core/core.js';
import {
  addInstance,
  computeWorldPins,
  connectWire,
  deleteInstance,
  labelNet,
  moveInstance,
  nextOrientation,
  parseEditableScope,
  rotateInstance,
  transformPoint,
  updateInstanceProperties,
} from '../../apps/web/studio/schematic-editor/rnl-codec.js';
import {
  BUILTIN_DEVICES,
  buildCustomDeviceSpec,
  buildInstanceCatalog,
  extractModelsFromDocument,
  extractPdkModelsFromSession,
} from '../../apps/web/studio/schematic-editor/catalog.js';

const RC_TEXT=readFileSync(new URL('../../apps/web/demo/rc.scs',import.meta.url),'utf8');
const BOOTSTRAP_TEXT=readFileSync(new URL('../../lib/pipetisar-real/RS9_L5_9bit_Bootstrap/schematic/RS9_L5_9bit_Bootstrap.scs',import.meta.url),'utf8');

test('parseEditableScope and computeWorldPins resolve placed RC and Virtuoso subckt pins accurately',()=>{
  const rcPins=computeWorldPins(RC_TEXT,'(top)');
  const r0Pin1=rcPins.find(p=>p.instance==='R0'&&p.terminal===1);
  const r0Pin2=rcPins.find(p=>p.instance==='R0'&&p.terminal===2);
  assert.ok(r0Pin1&&r0Pin2);
  assert.equal(r0Pin1.x,-5);assert.equal(r0Pin1.y,4);assert.equal(r0Pin1.net,'in');
  assert.equal(r0Pin2.x,5);assert.equal(r0Pin2.y,4);assert.equal(r0Pin2.net,'out');

  const bsPins=computeWorldPins(BOOTSTRAP_TEXT,'RS9_L5_9bit_Bootstrap');
  // M1 is at (-24, -6) R0 with %symbol_0 where pin 2 (gate) is at (0,0) and pin 1 (drain) is at (4,3)
  const m1Gate=bsPins.find(p=>p.instance==='M1'&&p.terminal===2);
  const m1Drain=bsPins.find(p=>p.instance==='M1'&&p.terminal===1);
  assert.ok(m1Gate&&m1Drain);
  assert.equal(m1Gate.x,-24);assert.equal(m1Gate.y,-6);assert.equal(m1Gate.net,'CLK');
  assert.equal(m1Drain.x,-20);assert.equal(m1Drain.y,-3);assert.equal(m1Drain.net,'net3');

  // Verify orientation transforms
  assert.deepEqual(transformPoint(4,3,'R90'),[-3,4]);
  assert.deepEqual(transformPoint(4,3,'R180'),[-4,-3]);
  assert.deepEqual(transformPoint(4,3,'R270'),[3,-4]);
  assert.deepEqual(transformPoint(4,3,'MX'),[4,-3]);
  assert.deepEqual(transformPoint(4,3,'MY'),[-4,3]);
  assert.equal(nextOrientation('R0','rotate'),'R90');
  assert.equal(nextOrientation('R270','rotate'),'R0');
  assert.equal(nextOrientation('R0','mirror-x'),'MX');
});

test('Q key updateInstanceProperties edits Spectre parameters and renames RNL references',()=>{
  const res=updateInstanceProperties(RC_TEXT,{
    scopeName:'(top)',
    instanceName:'R0',
    newName:'R_LOAD',
    model:'resistor',
    nodes:['in','out'],
    params:[{name:'r',value:'4.7k'}],
  });
  assert.match(res.text,/R_LOAD \(in out\) resistor r=4\.7k/);
  assert.match(res.text,/#"R_LOAD" @PLACE\(0,4\)/);
  assert.doesNotMatch(res.text,/\bR0 \(in out\)/);

  // Works on multi-line PDK MOS inside subckt
  const mosRes=updateInstanceProperties(BOOTSTRAP_TEXT,{
    scopeName:'RS9_L5_9bit_Bootstrap',
    instanceName:'M9',
    params:[{name:'l',value:'30n'},{name:'w',value:'500n'},{name:'nf',value:'2'},{name:'multi',value:'1'}],
  });
  assert.match(mosRes.text,/M9 \(CLKN CLK VSS VSS\) nch_ulvt_mac l=30n w=500n nf=2 multi=1/);
  assert.match(mosRes.text,/ends RS9_L5_9bit_Bootstrap/);
});

test('I key addInstance inserts Spectre statement, symbol definition, and semicolon-safe RNL placement',()=>{
  const resSpec=BUILTIN_DEVICES.find(d=>d.id==='resistor');
  const added=addInstance(RC_TEXT,{
    scopeName:'(top)',
    prefix:resSpec.prefix,
    model:resSpec.model,
    ports:resSpec.ports,
    params:resSpec.params,
    x:20,
    y:4,
    orient:'R0',
    symbolId:resSpec.symbolId,
    symbolDef:resSpec.symbolDef,
  });
  assert.equal(added.instanceName,'R1');
  assert.match(added.text,/R1 \(net1 net2\) resistor r=1k/);
  assert.match(added.text,/%cg_sym_resistor = @DEFINE-SYMBOL/);
  assert.match(added.text,/#"R1" @SET-SYMBOL %cg_sym_resistor;/);
  assert.match(added.text,/#"R1" @PLACE\(20, 4\) => @ORIENT\("R0"\)/);
  // Previous last RNL line in rc.scs lacked a trailing semicolon; codec must have added one!
  assert.match(added.text,/@PLACE\(8\.5,5\.2\);/);

  // Adding a second resistor reuses existing %cg_sym_resistor without duplicating it
  const added2=addInstance(added.text,{
    scopeName:'(top)',
    prefix:'R',
    model:'resistor',
    ports:['1','2'],
    params:[{name:'r',value:'2k'}],
    x:32,
    y:4,
    symbolId:resSpec.symbolId,
    symbolDef:resSpec.symbolDef,
  });
  assert.equal(added2.instanceName,'R2');
  assert.equal((added2.text.match(/%cg_sym_resistor\s*=\s*@DEFINE-SYMBOL/g)||[]).length,1);

  // Adding a custom subcircuit onto a bare Spectre file creates header + RNL block + block symbol
  const bare='simulator lang=spectre\nR0 (a b) resistor r=1k\n';
  const bareAdded=addInstance(bare,{scopeName:'(top)',prefix:'X',model:'MyAmp',ports:['vinp','vinn','vout','vdd'],x:10,y:0});
  assert.match(bareAdded.text,/@RNL\(type="header"\)\s*\{\s*@VERSION\("0\.3"\)\s*\}/);
  assert.match(bareAdded.text,/X1 \(net1 net2 net3 net4\) MyAmp/);
  assert.match(bareAdded.text,/%cg_sym_MyAmp = @DEFINE-SYMBOL/);
  assert.match(bareAdded.text,/#"X1" @PLACE\(10, 0\) => @ORIENT\("R0"\)/);
});

test('M/R/Del moveInstance, rotateInstance, and deleteInstance update RNL and Spectre cleanly',()=>{
  const moved=moveInstance(RC_TEXT,{scopeName:'(top)',instanceName:'R0',x:4,y:8});
  assert.match(moved.text,/#"R0" @PLACE\(4, 8\) => @ORIENT\("R0"\)/);

  const rotated=rotateInstance(moved.text,{scopeName:'(top)',instanceName:'R0',mode:'rotate'});
  assert.equal(rotated.orient,'R90');
  assert.match(rotated.text,/#"R0" @PLACE\(4, 8\) => @ORIENT\("R90"\)/);

  const deleted=deleteInstance(rotated.text,{scopeName:'(top)',instanceName:'R0'});
  const parsed=parseEditableScope(deleted.text,'(top)');
  assert.equal(parsed.instances.some(i=>i.name==='R0'),false);
  assert.doesNotMatch(deleted.text,/#"R0"/);
});

test('W key connectWire merges Spectre nets and appends orthogonal @WIRE, and L key renames nets',()=>{
  const resSpec=BUILTIN_DEVICES.find(d=>d.id==='resistor');
  const withR1=addInstance(RC_TEXT,{
    scopeName:'(top)',
    prefix:'R',
    model:'resistor',
    ports:['1','2'],
    params:[{name:'r',value:'2k'}],
    x:24,
    y:4,
    symbolId:resSpec.symbolId,
    symbolDef:resSpec.symbolDef,
  }).text;

  const pins=computeWorldPins(withR1,'(top)');
  const r0Right=pins.find(p=>p.instance==='R0'&&p.terminal===2); // net 'out'
  const r1Left=pins.find(p=>p.instance==='R1'&&p.terminal===1);  // net 'net1'
  assert.equal(r0Right.net,'out');
  assert.equal(r1Left.net,'net1');

  const wired=connectWire(withR1,{
    scopeName:'(top)',
    start:{kind:'pin',...r0Right},
    end:{kind:'pin',...r1Left},
    waypoints:[{x:12,y:4}],
  });
  // Named net 'out' takes priority over auto-generated 'net1'!
  assert.equal(wired.net,'out');
  assert.match(wired.text,/R1 \(out net2\) resistor r=2k/);
  assert.match(wired.text,/%cg_w1 = &"out" @WIRE\(mode="straight"\) \{#"R0":2 \(12, 4\) #"R1":1\}/);

  // L key renames 'out' -> 'vout_filt' across Spectre instances and RNL wires
  const labeled=labelNet(wired.text,{scopeName:'(top)',oldNet:'out',newNet:'vout_filt',x:12,y:5});
  assert.match(labeled.text,/R0 \(in vout_filt\) resistor r=1k/);
  assert.match(labeled.text,/R1 \(vout_filt net2\) resistor r=2k/);
  assert.match(labeled.text,/&"vout_filt" @WIRE/);
  assert.match(labeled.text,/\(12, 5\) @TEXT\("vout_filt"/);
});

test('buildInstanceCatalog dynamically discovers probed PDK models, active netlist models, subcircuits, and Verilog-A',()=>{
  const mockPdkSession={
    selected_candidate_id:'pdk-n6',
    discovery:{
      candidates:[
        {
          candidate_id:'pdk-n6',
          label:'TSMC N6 (remote)',
          model_contracts:[
            {name:'nch_svt_mac',polarity:'n',ordered_terminal_roles:['d','g','s','b']},
            {name:'pch_hvt_mac',polarity:'p',ordered_terminal_roles:['d','g','s','b']},
          ],
        },
      ],
    },
  };
  const extractedPdk=extractPdkModelsFromSession(mockPdkSession);
  assert.equal(extractedPdk.detected,true);
  assert.equal(extractedPdk.label,'TSMC N6 (remote)');
  assert.deepEqual(extractedPdk.models.map(m=>m.model),['nch_svt_mac','pch_hvt_mac']);

  const docModels=extractModelsFromDocument({
    levels:[{title:'(top)'},{title:'RS9_L5_9bit_Bootstrap'}],
    files:[{path:'/RS9_L5_9bit_Bootstrap.scs',text:BOOTSTRAP_TEXT}],
  });
  const docModelNames=docModels.map(m=>m.model);
  assert.ok(docModelNames.includes('nch_ulvt_mac'));
  assert.ok(docModelNames.includes('pch_ulvt_mac'));
  assert.ok(docModelNames.includes('nch_lvt_mac'));
  assert.ok(docModelNames.includes('cfmom_2t'));
  assert.equal(docModels.find(m=>m.model==='nch_ulvt_mac').symbolId,'%cg_sym_nmos4');
  assert.equal(docModels.find(m=>m.model==='pch_ulvt_mac').symbolId,'%cg_sym_pmos4');
  assert.equal(docModels.find(m=>m.model==='cfmom_2t').symbolId,'%cg_sym_capacitor');

  const catalog=buildInstanceCatalog({
    doc:{
      levels:[{title:'TOP'},{title:'PIPE_MDAC4_G8_SC',ports:['VINP','VINN','VOUTP','VOUTN']}],
      files:[{path:'/RS9_L5_9bit_Bootstrap.scs',text:BOOTSTRAP_TEXT}],
    },
    activeLibrary:{library:{cells:[{id:'Switch',name:'Switch',kind:'circuit'},{id:'TB_TOP',name:'TB_TOP',kind:'testbench'}]}},
    verilogaModels:[{moduleName:'PIPE_RailClamp',path:'lib/a/PIPE_RailClamp.va',text:'module PIPE_RailClamp(in, out, vdd, vss);\nendmodule'}],
    pdkSession:mockPdkSession,
  });
  assert.equal(catalog.pdkStatus.detected,true);
  assert.equal(catalog.pdkStatus.pdkModelCount,2);
  assert.ok(catalog.pdkStatus.docModelCount>=4);
  assert.ok(catalog.some(i=>i.model==='nch_svt_mac'&&i.category==='已探测 PDK 器件'));
  assert.ok(catalog.some(i=>i.model==='nch_ulvt_mac'&&i.category==='当前工程 PDK 器件'));
  assert.ok(catalog.some(i=>i.id==='resistor'));
  assert.ok(catalog.some(i=>i.id==='gnd'));
  const sub=catalog.find(i=>i.model==='PIPE_MDAC4_G8_SC');
  assert.deepEqual(sub.ports,['VINP','VINN','VOUTP','VOUTN']);
  const va=catalog.find(i=>i.model==='PIPE_RailClamp');
  assert.deepEqual(va.ports,['in','out','vdd','vss']);
  // Testbenches excluded from instantiable cells
  assert.equal(catalog.some(i=>i.model==='TB_TOP'),false);

  // Without remote PDK session and on RC-only file, report PDK as not detected honestly
  const rcCatalog=buildInstanceCatalog({doc:{levels:[{title:'(top)'}],files:[{path:'/rc.scs',text:RC_TEXT}]}});
  assert.equal(rcCatalog.pdkStatus.detected,false);
  assert.equal(rcCatalog.pdkStatus.pdkModelCount,0);
  assert.equal(rcCatalog.pdkStatus.docModelCount,0);
  assert.ok(rcCatalog.some(i=>i.id==='nmos'));

  // Custom PDK device builder
  const custom=buildCustomDeviceSpec('nfet_01v8',{kind:'nmos',paramsText:'w=1u l=150n nf=2'});
  assert.equal(custom.model,'nfet_01v8');
  assert.equal(custom.symbolId,'%cg_sym_nmos4');
  assert.deepEqual(custom.params,[{name:'w',value:'1u'},{name:'l',value:'150n'},{name:'nf',value:'2'}]);
});

test('all generated RNL mutations compile cleanly with zero errors in real RNL WASM core',async()=>{
  const wasm=readFileSync(new URL('../../apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm',import.meta.url));
  const core=await loadCore(wasm);
  const compile=(label,sourceText)=>{
    const doc=core.build({entry:'/test.scs',files:{'/test.scs':sourceText},dialect:'spectre'});
    const errors=(doc.diagnostics||[]).filter(d=>d.severity==='error'||d.severity==='fatal');
    assert.equal(doc.failed,null,`${label} should not fail build`);
    assert.deepEqual(errors,[],`${label} should have zero RNL diagnostics`);
    return doc;
  };
  let text=RC_TEXT;
  let x=20;
  for(const dev of BUILTIN_DEVICES){
    text=addInstance(text,{
      scopeName:'(top)',
      prefix:dev.prefix,
      model:dev.model,
      ports:dev.ports,
      params:dev.params,
      x,
      y:0,
      symbolId:dev.symbolId||'',
      symbolDef:dev.symbolDef||'',
      virtualKind:dev.virtualKind||null,
    }).text;
    compile('add '+dev.id,text);
    x+=12;
  }
  const customPdk=buildCustomDeviceSpec('nch_hvt_mac',{kind:'nmos',paramsText:'l=30n w=500n nf=2'});
  const customText=addInstance(text,{
    scopeName:'(top)',
    prefix:customPdk.prefix,
    model:customPdk.model,
    ports:customPdk.ports,
    params:customPdk.params,
    x:20,
    y:10,
    symbolId:customPdk.symbolId,
    symbolDef:customPdk.symbolDef,
  }).text;
  compile('add custom PDK MOS',customText);

  const blockText=addInstance(text,{scopeName:'(top)',prefix:'X',model:'MyBlock',ports:['vinp','vinn','vout','vdd'],x:20,y:16}).text;
  compile('add custom block',blockText);

  text=moveInstance(text,{scopeName:'(top)',instanceName:'R1',x:24,y:6}).text;
  compile('move R1',text);
  text=rotateInstance(text,{scopeName:'(top)',instanceName:'R1',mode:'rotate'}).text;
  compile('rotate R1',text);

  const pins=computeWorldPins(text,'(top)');
  const pA=pins.find(p=>p.instance==='R0'&&p.terminal===2);
  const pB=pins.find(p=>p.instance==='R1'&&p.terminal===1);
  text=connectWire(text,{scopeName:'(top)',start:{kind:'pin',...pA},end:{kind:'pin',...pB},waypoints:[{x:14,y:4}]}).text;
  compile('wire R0:2 -> R1:1',text);

  text=labelNet(text,{scopeName:'(top)',oldNet:'out',newNet:'vout_stage1',x:14,y:6}).text;
  compile('label net',text);
  text=updateInstanceProperties(text,{scopeName:'(top)',instanceName:'R1',params:[{name:'r',value:'4.7k'}]}).text;
  compile('update props',text);
  text=deleteInstance(text,{scopeName:'(top)',instanceName:'R1'}).text;
  compile('delete R1',text);
});
