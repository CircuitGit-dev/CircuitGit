import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {indexSpectre,lineRange,references,validateConfiguration,safeLocalURL,safeGithubURL,isTerminal} from '../apps/web/core.js';
const source=await readFile(new URL('../apps/web/assets/real-sar.circuit.scs',import.meta.url),'utf8');
const provenance=JSON.parse(await readFile(new URL('../apps/web/assets/provenance.json',import.meta.url),'utf8'));
test('offline real-SAR bytes match recorded SHA256',()=>assert.equal(createHash('sha256').update(source).digest('hex'),provenance.sha256));
test('real Switch instance and net map includes continuation and correct source range',()=>{const scope=indexSpectre(source).find(s=>s.name==='Switch');assert.deepEqual(scope.instances.map(i=>[i.name,i.model,i.start,i.end]),[['R0','resistor',8,8],['W0','relay',9,10]]);const relay=scope.instances[1];const [start,end]=lineRange(source,relay.start,relay.end);assert.match(source.slice(start,end),/^    W0 \(net12 A ctrl 0\) relay/);assert.match(source.slice(start,end),/rclosed=100.0m$/);assert.deepEqual(references(scope,'net12').map(i=>i.name),['R0','W0']);});
test('duplicate instance names remain scoped and comments are not instances',()=>{const scopes=indexSpectre('// X0 (a b) bogus\nsubckt A a b\nX0 (a b) resistor r=1\nends A\nsubckt B a b\nX0 (a b) capacitor c=1p\nends B');assert.equal(scopes.length,2);assert.equal(scopes[0].instances[0].model,'resistor');assert.equal(scopes[1].instances[0].model,'capacitor');});
test('invalid configuration is rejected; expressions are not evaluated or altered',()=>{assert.ok(validateConfiguration('[]').errors.length);assert.ok(validateConfiguration('{').errors.length);assert.ok(validateConfiguration('{"parameters":null}').errors.length);assert.ok(validateConfiguration('{"parameters":{"X":{}}}').errors.length);assert.deepEqual(validateConfiguration('{"parameters":{"Fs":"1/Tper"}}').value.parameters,{Fs:'1/Tper'});});
test('artifact links reject foreign origins and executable URL schemes',()=>{assert.equal(safeLocalURL('https://attacker.test/a','http://127.0.0.1:8765/'),null);assert.equal(safeLocalURL('javascript:alert(1)','http://127.0.0.1:8765/'),null);assert.equal(safeLocalURL('/api/artifacts/x','http://127.0.0.1:8765/'),'http://127.0.0.1:8765/api/artifacts/x');assert.equal(safeGithubURL('https://github.com.evil.test/'),null);});
test('pending measurements is a terminal solver state, reconcile is not',()=>{assert.ok(isTerminal('simulator_complete_pending_measurements'));assert.ok(!isTerminal('reconcile'));});

import {normalizeResults} from '../apps/web/api.js';
test('backend complete publication is normalized without losing hash receipt',()=>{const result=normalizeResults({publication:{status:'complete',assets:[{sha256:'abc'}]}});assert.equal(result.publication.status,'published');assert.equal(result.publication.backend_status,'complete');assert.equal(result.publication.assets[0].sha256,'abc');});
