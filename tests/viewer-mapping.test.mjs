import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {indexSpectre,deriveView,hashText} from '../apps/web/viewer-adapter/source-map.js';
import {startCore} from '../apps/web/vendor/rnl-viewer/core/client.js';
const path='projects/real-sar-20261106/circuit.scs',text=readFileSync(new URL('../projects/real-sar-20261106/circuit.scs',import.meta.url),'utf8');
const a=indexSpectre(text,path),b=indexSpectre('// New comment\n'+text.replace('Rseries=50','Rseries=51'),path);
const original=a.objects.find(o=>o.kind==='instance'&&o.scope==='Switch'&&o.name==='W0'),changed=b.objects.find(o=>o.id===original.id);
assert.equal(original.line_start,9);assert.equal(original.line_end,10);assert.equal(changed.line_start,10);assert.equal(changed.id,original.id);
assert.notEqual(await hashText(text),await hashText(text.replace('Rseries=50','Rseries=51')));
assert.throws(()=>indexSpectre('subckt x a b\nR0 (a b) resistor r=1\n',path),/Unclosed/);
assert.throws(()=>indexSpectre('R0 (a b) resistor r=1\nR0 (a b) resistor r=2',path),/Duplicate/);
assert.throws(()=>deriveView(text,path,'missing_scope'),/does not exist/);
assert.throws(()=>deriveView(text.replace('R0 (B net12)','R0 B net12'),path),/malformed/);
const core=startCore();try{
 for(const scope of ['Switch','PIPE_OTA_Diff_Ideal']){
  const d=deriveView(text,path,scope),doc=await core.build({entry:'/derived.scs',files:{'/derived.scs':d.text}});
  assert.equal(doc.diagnostics.length,0,JSON.stringify(doc.diagnostics));
  assert.equal(doc.levels.find(l=>l.title===scope).unplaced.length,0);
  const raw=text.split('\n').slice(d.coverage.source_line_start-1,d.coverage.source_line_end).filter(x=>!/^\s*\/\//.test(x));
  const drawn=d.text.split('\n').filter(x=>!/^\s*\/\//.test(x)&&x!=='simulator lang=spectre'&&x!=='');
  assert.deepEqual(drawn,raw.filter(x=>x!==''),'Electrical lines changed in derived view');
 }
 const rc=readFileSync(new URL('../projects/rc-smoke/circuit.scs',import.meta.url),'utf8');const d=deriveView(rc,'projects/rc-smoke/circuit.scs');const doc=await core.build({entry:'/rc.scs',files:{'/rc.scs':d.text}});assert.equal(doc.diagnostics.length,0,JSON.stringify(doc.diagnostics));
 console.log(JSON.stringify({status:'passed',cases:8,real_source_instances:a.objects.filter(o=>o.kind==='instance').length,real_modules:['Switch','PIPE_OTA_Diff_Ideal'],rc_core:true}));
}finally{core.terminate()}
