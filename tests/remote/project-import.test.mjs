import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCircuitFileName,
  normalizeRelativePath,
  scoreEntryCandidate,
  prepareLocalImportFiles,
  selectImportEntry,
  buildImportedRnlSource,
  formatSshImportError,
} from '../../apps/web/studio/project-import.js';
import {createOnboardingBridge,createOnboardingPendingStore,createOnboardingSelectionStore,snapshotOnboardingSource} from '../../apps/web/remote/onboarding-bridge.js';

test('local import path normalization and sensitivity filter reject unsafe files',()=>{
  assert.equal(isCircuitFileName('tb_sar.scs'),true);
  assert.equal(isCircuitFileName('sub/opamp.SP'),true);
  assert.equal(isCircuitFileName('diagram.png'),false);
  assert.equal(isCircuitFileName('.env'),false);
  assert.equal(isCircuitFileName('id_rsa.txt'),false);
  assert.equal(isCircuitFileName('my_secret.scs'),false);
  assert.equal(normalizeRelativePath('my_adc\\sub\\comp.scs'),'my_adc/sub/comp.scs');
  assert.equal(normalizeRelativePath('../escape.scs'),null);
  assert.equal(normalizeRelativePath('.git/config'),null);
  assert.equal(normalizeRelativePath('dir/private.key'),null);
});

test('prepareLocalImportFiles strips shared folder prefix and ranks top-level testbench first',()=>{
  const bundle=prepareLocalImportFiles([
    {path:'sar_project/models/corner.inc',text:'// corner'},
    {path:'sar_project/sub/comp.scs',text:'subckt COMP in out\nends COMP\n'},
    {path:'sar_project/TB_SAR_TOP.scs',text:'simulator lang=spectre\ninclude "sub/comp.scs"\n'},
    {path:'sar_project/.env',text:'SECRET=1'},
    {path:'sar_project/photo.png',text:'binary'},
  ]);
  assert.equal(bundle.projectName,'sar_project');
  assert.equal(bundle.defaultEntry,'TB_SAR_TOP.scs');
  assert.equal(bundle.candidates.length,3);
  assert(scoreEntryCandidate('TB_SAR_TOP.scs')>scoreEntryCandidate('models/corner.inc'));

  const chosen=selectImportEntry({
    filesByPath:bundle.filesByPath,
    entryPath:bundle.defaultEntry,
    projectName:bundle.projectName,
  });
  assert.equal(chosen.fileName,'TB_SAR_TOP.scs');
  assert.equal(Object.keys(chosen.supportFiles).sort().join(','),'models/corner.inc,sub/comp.scs');
});

test('buildImportedRnlSource creates an RNL source compatible with snapshotOnboardingSource',async()=>{
  const source=buildImportedRnlSource({
    entryPath:'TB_SAR_TOP.scs',
    fileName:'TB_SAR_TOP.scs',
    text:'simulator lang=spectre\ninclude "sub/comp.scs"\n',
    supportFiles:{'sub/comp.scs':'subckt COMP a b\nends COMP\n'},
  });
  assert.equal(source.path,'/TB_SAR_TOP.scs');
  assert.equal(await source.read('/sub/comp.scs'),'subckt COMP a b\nends COMP\n');
  assert.equal(await source.read('sub/comp.scs'),'subckt COMP a b\nends COMP\n');
  const doc={path:source.path,files:[{path:'TB_SAR_TOP.scs',text:source.snapshot['/TB_SAR_TOP.scs']}]};
  assert.deepEqual(snapshotOnboardingSource(doc),{
    file_name:'TB_SAR_TOP.scs',
    text:'simulator lang=spectre\ninclude "sub/comp.scs"\n',
  });
});

test('formatSshImportError clearly explains legacy local connector upgrade path',()=>{
  const msg=formatSshImportError(Object.assign(Error('Unknown node write route'),{status:400}));
  assert.match(msg,/版本较旧/);
  assert.match(msg,/本地网表/);
  const preflight=formatSshImportError(Object.assign(Error('无法读取节点。'),{data:{code:'node_unreachable'}}));
  assert.match(preflight,/版本较旧/);
  const legacyPost=formatSshImportError(Object.assign(Error('发送结果尚不确定；请重新连接并核对原会话，不要重复发送。'),{data:{code:'transport_unknown'}}));
  assert.match(legacyPost,/版本较旧/);
  const auth=formatSshImportError(Error('Permission denied (publickey).'));
  assert.match(auth,/SSH 免密登录/);
});

test('onboarding bridge allows browseRemoteNetlists and importRemoteNetlist before intake creation',async()=>{
  const storageMap=new Map(),storage={getItem:k=>storageMap.get(k)||null,setItem:(k,v)=>storageMap.set(k,v)};
  const calls=[];
  const info={schema:'circuitgit.remote-node.v1',node_id:'n1',connection_id:'store-1',single_owner:true,auth:'bearer',capabilities:{chat:false,simulation_onboarding:true,simulation_onboarding_api_version:'1'}};
  const transport={
    base:'http://127.0.0.1:18885',
    close(){},
    request:async(path,options={})=>{
      calls.push({path,options});
      if(path==='/node/info')return info;
      if(path==='/simulation/onboarding/ssh-browse')return {schema:'ic.onboarding.ssh-browse.v1',ssh_target:'eda-box',cwd:'/home/u',parent:'/home',entries:[{name:'tb.scs',path:'/home/u/tb.scs',kind:'file',size:42}],total:1,truncated:false};
      if(path==='/simulation/onboarding/ssh-import')return {schema:'ic.onboarding.ssh-import.v1',ssh_target:'eda-box',remote_path:'/home/u/tb.scs',remote_dir:'/home/u',file_name:'tb.scs',text:'// netlist',support_files:{},skipped:[]};
      throw Error('unexpected '+path);
    },
  };
  const bridge=createOnboardingBridge({
    win:{location:{origin:'https://circuitgit.invalid'}},
    pair:({base})=>({result:Promise.resolve({url:base,accessCode:'x'.repeat(43)}),cancel(){}}),
    clientFactory:()=>transport,
    pendingStore:createOnboardingPendingStore({storage}),
    selectionStore:createOnboardingSelectionStore({storage}),
  });
  await bridge.connect({port:18885});
  const listing=await bridge.browseRemoteNetlists({ssh_target:'eda-box',path:'~'});
  assert.equal(listing.cwd,'/home/u');
  assert.equal(calls.at(-1).options.timeout,35000);
  const imported=await bridge.importRemoteNetlist({ssh_target:'eda-box',path:'/home/u/tb.scs',include_dependencies:true});
  assert.equal(imported.file_name,'tb.scs');
  assert.equal(calls.at(-1).options.timeout,35000);
});
