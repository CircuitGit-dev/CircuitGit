import {test} from 'node:test';import assert from 'node:assert/strict';
import {createContextStore,digest} from '../../apps/web/context/store.js';
const source='M26 (d g s b) pmos\n',sha=await digest(source);
const old={mode:'live',loadState:'ready',project:{id:'sar'},file:{path:'sar.scs',persistedSha256:sha},geometry:{mode:'native',sourceMatch:true,geometrySourceSha256:sha},selection:{kind:'instance',name:'M26',targetKind:'canonical',mappingVerified:true,sourcePath:'sar.scs',sourceSha256:sha,lineStart:1,lineEnd:1},run:{runId:'sar-run'}};
test('loading and error snapshots atomically hide old project data and reject old reads',async()=>{
 const store=createContextStore();store.update(old,source);await store.settled();const oldRevision=store.api.getContext().revision;
 const seen=[];store.api.subscribe(c=>seen.push(c));store.update({...old,project:{id:'rc'},loadState:'loading'},source);
 const c=store.api.getContext();assert.equal(c.project.id,'rc');assert.equal(c.loading,true);for(const key of ['file','selection','geometry','run'])assert.equal(c[key],null);
 await assert.rejects(store.api.readSelection({contextRevision:oldRevision}),/revision changed/);
 store.update({...old,project:{id:'rc'},loadState:'error'},source);assert.equal(store.api.getContext().loading,false);assert.equal(store.api.getContext().loadState,'error');assert.equal(store.api.getContext().file,null);assert.equal(seen.length,2);
});
test('late SAR hash cannot revive a loading RC snapshot',async()=>{
 let done;const store=createContextStore({hashText:()=>new Promise(r=>done=r)});store.update(old,source);store.update({...old,project:{id:'rc'},loadState:'loading'},source);const revision=store.api.getContext().revision;done(sha);await Promise.resolve();assert.equal(store.api.getContext().revision,revision);assert.equal(store.api.getContext().file,null);assert.equal(store.api.getContext().selection,null);
});
