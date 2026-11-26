import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  isVerilogAFile,
  verilogaModuleBasename,
  parseVerilogAModule,
  extractAhdlIncludes,
  indexLibraryVerilogAFiles,
  indexSnapshotVerilogAFiles,
  parseInstanceStatement,
  extractInstanceMaster,
  resolveVerilogAModel,
  tokenizeVerilogALine,
} from '../../apps/web/library/veriloga.js';
import {displayViewsForCell,formatViewLabel,filterLibraries,validateLibrary} from '../../apps/web/library/model.js';

const RAIL_CLAMP_VA=`\`include "constants.vams"
\`include "disciplines.vams"
// Shunt rail limiter
module PIPE_RailClamp(P,N,VDD,VSS);
 inout P,N,VDD,VSS;
 electrical P,N,VDD,VSS;
 parameter real gclamp=1e4 from (0:inf);
 parameter real margin=1m from (0:inf);
 parameter integer enable=1 from [0:1];
 analog begin
  I(P,VDD)<+enable*gclamp*V(P,VDD);
 end
endmodule
`;

test('isVerilogAFile and verilogaModuleBasename identify .va and .vams paths',()=>{
  assert.equal(isVerilogAFile('models/PIPE_RailClamp.va'),true);
  assert.equal(isVerilogAFile('lib/demo/foo.VAMS'),true);
  assert.equal(isVerilogAFile('lib/demo/foo.scs'),false);
  assert.equal(verilogaModuleBasename('lib/a/b/PIPE_RailClamp.va'),'PIPE_RailClamp');
  assert.equal(verilogaModuleBasename('RS9_IO_N06.vams'),'RS9_IO_N06');
});

test('parseVerilogAModule extracts module name, ports, parameters, includes, and analog line',()=>{
  const parsed=parseVerilogAModule(RAIL_CLAMP_VA);
  assert.equal(parsed.moduleName,'PIPE_RailClamp');
  assert.equal(parsed.moduleLine,4);
  assert.deepEqual(parsed.includes,['constants.vams','disciplines.vams']);
  assert.deepEqual(parsed.ports.map(p=>p.name),['P','N','VDD','VSS']);
  assert.equal(parsed.ports[0].direction,'inout');
  assert.equal(parsed.ports[0].discipline,'electrical');
  assert.equal(parsed.parameters.length,3);
  assert.deepEqual(parsed.parameters[0],{type:'real',name:'gclamp',defaultValue:'1e4',range:'from (0:inf)',line:7});
  assert.equal(parsed.parameters[2].type,'integer');
  assert.equal(parsed.parameters[2].defaultValue,'1');
  assert.equal(parsed.analogLine,10);
});

test('extractAhdlIncludes finds Spectre ahdl_include and SPICE .hdl directives',()=>{
  const refs=extractAhdlIncludes(`
    ahdl_include "models/PIPE_RailClamp.va"
    .hdl 'extra/clock.vams'
    include "other.scs"
  `);
  assert.deepEqual(refs,['models/PIPE_RailClamp.va','extra/clock.vams']);
});

test('parseInstanceStatement and extractInstanceMaster handle multiline Spectre and SPICE instances',()=>{
  const spectreStmt=`    XLIMIT (ROP RON VDD VSS) PIPE_RailClamp gclamp=100 margin=20m knee=1m \\
        enable=LimitEnable`;
  const sp=parseInstanceStatement(spectreStmt,'XLIMIT');
  assert.equal(sp.masterName,'PIPE_RailClamp');
  assert.deepEqual(sp.ports,['ROP','RON','VDD','VSS']);
  assert.deepEqual(sp.params,[
    {name:'gclamp',value:'100'},
    {name:'margin',value:'20m'},
    {name:'knee',value:'1m'},
    {name:'enable',value:'LimitEnable'},
  ]);

  const spiceStmt=`XCLAMP rop ron vdd vss PIPE_RailClamp gclamp=50\n+ margin=5m`;
  const sp2=parseInstanceStatement(spiceStmt,'XCLAMP');
  assert.equal(sp2.masterName,'PIPE_RailClamp');
  assert.deepEqual(sp2.ports,['rop','ron','vdd','vss']);
  assert.deepEqual(sp2.params,[{name:'gclamp',value:'50'},{name:'margin',value:'5m'}]);

  const doc={
    files:[{name:'PIPE_MDAC4_G8_SC.scs',path:'/PIPE_MDAC4_G8_SC.scs',text:'subckt MDAC\n'+spectreStmt+'\nends\n'}],
    levels:[{host:1,kind:'subckt',title:'MDAC',children:[{instance:'XLIMIT',master:'PIPE_RailClamp',level:null,symbol:0}]}],
    objects:[{kind:'instance',name:'XLIMIT',level:1,level_title:'MDAC',lines:[0,2,3],opens:null}],
  };
  const info=extractInstanceMaster(doc,0,0);
  assert.equal(info.instanceName,'XLIMIT');
  assert.equal(info.masterName,'PIPE_RailClamp');
  assert.equal(info.opens,null);
  assert.deepEqual(info.ports,['ROP','RON','VDD','VSS']);
  assert.equal(info.file,'PIPE_MDAC4_G8_SC.scs');
  assert.equal(info.line,2);
});

test('resolveVerilogAModel prioritizes imported snapshot over library manifests and matches module declarations',()=>{
  const libA={
    id:'lib-a',name:'Library A',
    cells:[{id:'TB',name:'TB',kind:'testbench',views:[{id:'simulation',kind:'spectre',entry:'lib/a/in.scs',files:['lib/a/in.scs','lib/a/models/PIPE_RailClamp.va']}]}],
  };
  const libB={
    id:'lib-b',name:'Library B',
    cells:[{id:'TB',name:'TB',kind:'testbench',views:[{id:'simulation',kind:'spectre',entry:'lib/b/in.scs',files:['lib/b/in.scs','lib/b/models/PIPE_RailClamp.va','lib/b/models/PIPE_ThermDAC4_FS2.va']}]}],
  };

  // Prefers active library when multiple libraries contain the same .va module.
  const fromLibA=resolveVerilogAModel({masterName:'PIPE_RailClamp',libraries:[libA,libB],activeLibraryId:'lib-a'});
  assert.equal(fromLibA.sourceType,'library');
  assert.equal(fromLibA.path,'lib/a/models/PIPE_RailClamp.va');

  // Falls back to sibling library when active library lacks the file (e.g. PIPE_ThermDAC4_FS2).
  const fromSibling=resolveVerilogAModel({masterName:'PIPE_ThermDAC4_FS2',libraries:[libA,libB],activeLibraryId:'lib-a'});
  assert.equal(fromSibling.sourceType,'library');
  assert.equal(fromSibling.path,'lib/b/models/PIPE_ThermDAC4_FS2.va');

  // Imported project `.va` overrides library manifests and matches by `module` name even if filename differs.
  const fromImport=resolveVerilogAModel({
    masterName:'PIPE_RailClamp',
    importedProject:{origin:'ssh',sshTarget:'eda-box',rnlSnapshot:{'/models/custom_clamp.va':RAIL_CLAMP_VA}},
    libraries:[libA,libB],
    activeLibraryId:'lib-a',
  });
  assert.equal(fromImport.sourceType,'inline');
  assert.equal(fromImport.path,'models/custom_clamp.va');
  assert.equal(fromImport.origin,'SSH · eda-box');
  assert.equal(fromImport.text,RAIL_CLAMP_VA);

  // Snapshot indexing indexes both filename stem and declared module name.
  const snapIdx=indexSnapshotVerilogAFiles({'/models/custom_clamp.va':RAIL_CLAMP_VA});
  assert.ok(snapIdx.byKey.has('pipe_railclamp'));
  assert.ok(snapIdx.byKey.has('custom_clamp'));
});

test('real published libraries expose veriloga views for behavioral cells and testbenches',()=>{
  const realLib=JSON.parse(readFileSync(new URL('../../lib/pipetisar-real/library.json',import.meta.url),'utf8'));
  const researchLib=JSON.parse(readFileSync(new URL('../../lib/pipetisar-research/library.json',import.meta.url),'utf8'));
  const libraries=[realLib,researchLib];

  // Validate library manifests remain accepted by frozen schema.
  validateLibrary(realLib,'pipetisar-real');
  validateLibrary(researchLib,'pipetisar-research');

  // Index finds all 5 real behavioral models.
  const idx=indexLibraryVerilogAFiles(libraries,'pipetisar-real');
  for(const mod of ['PIPE_Clock250_250_500','PIPE_RailClamp','PIPE_ThermDAC4_FS2','RS9_IO_N06','RS9_Merge_N06']){
    assert.ok(idx.byKey.has(mod.toLowerCase()),`missing ${mod}`);
  }

  // Behavioral cell in pipetisar-research gains a `veriloga` view alongside `symbol` and `docs`.
  const railCell=researchLib.cells.find(c=>c.id==='PIPE_RailClamp');
  const railViews=displayViewsForCell(railCell,{library:researchLib,libraries});
  assert.deepEqual(railViews.map(v=>v.id),['symbol','veriloga','docs']);
  assert.equal(formatViewLabel(railViews[1]),'Verilog-A 行为模型 (veriloga)');

  // PIPE_ThermDAC4_FS2 in pipetisar-research resolves cleanly via sibling pipetisar-real archive.
  const dacCell=researchLib.cells.find(c=>c.id==='PIPE_ThermDAC4_FS2');
  const dacViews=displayViewsForCell(dacCell,{library:researchLib,libraries});
  assert.deepEqual(dacViews.map(v=>v.id),['symbol','veriloga','docs']);
  assert.match(dacViews[1].entry,/PIPE_ThermDAC4_FS2\.va$/);

  // Testbench in pipetisar-real surfaces deduplicated 5-module `veriloga` view.
  const tbCell=realLib.cells.find(c=>c.id==='TB_PIPE_RS9_N06');
  const tbViews=displayViewsForCell(tbCell,{library:realLib,libraries});
  const tbVa=tbViews.find(v=>v.id==='veriloga');
  assert.ok(tbVa);
  assert.equal(tbVa.files.length,5);
  assert.equal(formatViewLabel(tbVa),'Verilog-A 行为模型 (veriloga · 5 个模块)');

  // Search for "veriloga" in Library Manager finds behavioral cells and testbenches.
  const found=filterLibraries(libraries,'veriloga');
  assert.ok(found.some(l=>l.id==='pipetisar-real'&&l.cells.some(c=>c.id==='TB_PIPE_RS9_N06')));
  assert.ok(found.some(l=>l.id==='pipetisar-research'&&l.cells.some(c=>c.id==='PIPE_RailClamp')));

  // Real Verilog-A files parse comma-separated parameters, bus port expansions, and analog blocks accurately.
  const clkVa=readFileSync(new URL('../../lib/pipetisar-real/TB_PIPE_RS9_N06/simulation/PIPE_LOW/netlist/models/PIPE_Clock250_250_500.va',import.meta.url),'utf8');
  const clkParsed=parseVerilogAModule(clkVa);
  assert.deepEqual(clkParsed.parameters.map(p=>p.name),['tper','ttrack','tamp','guard','tr']);
  assert.equal(clkParsed.analogLine,7);

  const clampVa=readFileSync(new URL('../../lib/pipetisar-real/TB_PIPE_RS9_N06/simulation/PIPE_LOW/netlist/models/PIPE_RailClamp.va',import.meta.url),'utf8');
  const clampParsed=parseVerilogAModule(clampVa);
  assert.equal(clampParsed.analogLine,23); // skips `analog function real positive` on line 15

  const dacVa=readFileSync(new URL('../../lib/pipetisar-real/TB_PIPE_RS9_N06/simulation/PIPE_LOW/netlist/models/PIPE_ThermDAC4_FS2.va',import.meta.url),'utf8');
  const dacParsed=parseVerilogAModule(dacVa);
  assert.equal(dacParsed.expandedPorts.length,26); // D[14:0](15) + VP,VN(2) + K[3:0](4) + VCM,VREFP,VREFN,VDD,VSS(5)
  assert.equal(dacParsed.expandedPorts[0],'D[14]');
  assert.equal(dacParsed.expandedPorts[15],'VP');
});

test('tokenizeVerilogALine classifies directives, keywords, builtins, operators, numbers, and block comments safely',()=>{
  const r1=tokenizeVerilogALine('`include "constants.vams" // header',false);
  assert.equal(r1.inBlockComment,false);
  assert.deepEqual(r1.tokens.filter(t=>t.type!=='plain').map(t=>[t.type,t.text]),[
    ['directive','`include'],
    ['string','"constants.vams"'],
    ['comment','// header'],
  ]);

  const r2=tokenizeVerilogALine('  I(P,VDD) <+ 1e4 * V(P,VDD) + 100u;',false);
  assert.ok(r2.tokens.some(t=>t.type==='builtin'&&t.text==='I'));
  assert.ok(r2.tokens.some(t=>t.type==='operator'&&t.text==='<+'));
  assert.ok(r2.tokens.some(t=>t.type==='number'&&t.text==='1e4'));
  assert.ok(r2.tokens.some(t=>t.type==='number'&&t.text==='100u'));

  const r3=tokenizeVerilogALine('/* multi-line',false);
  assert.equal(r3.inBlockComment,true);
  const r4=tokenizeVerilogALine('still comment */ analog begin',r3.inBlockComment);
  assert.equal(r4.inBlockComment,false);
  assert.equal(r4.tokens[0].type,'comment');
  assert.ok(r4.tokens.some(t=>t.type==='keyword'&&t.text==='analog'));
});
