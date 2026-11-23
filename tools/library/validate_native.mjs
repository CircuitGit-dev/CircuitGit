// Offline rendering of every explicitly imported native view. Never solves or routes.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadCore} from '../../apps/web/vendor/rnl-viewer/core/core.js';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = process.argv.slice(2);
const option = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const seed = option('--seed-root');
const output = option('--report');
const plan = JSON.parse(readFileSync(join(root, 'tools/library/adc-import-plan.json')));
const sha = data => createHash('sha256').update(data).digest('hex');
const wasm = readFileSync(join(root, 'apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm'));
const core = await loadCore(wasm);
const rows = [];
const intended = (doc, name) => name === '@top' ? doc.levels[0] : doc.levels.find(l => l.title === name);
const geometry = (doc, level) => level.hits.map(({kind, points, objects}) => ({
  kind, points, objects: objects.map(i => ({kind: doc.objects[i].kind, name: doc.objects[i].name}))
}));

if (seed) assert.equal(sha(readFileSync(join(seed, plan.source_manifest))), plan.source_manifest_sha256);
for (const library of plan.libraries) {
  const manifest = JSON.parse(readFileSync(join(root, 'lib', library.id, 'library.json')));
  for (const cell of library.cells) {
    const record = manifest.cells.find(c => c.id === cell.id);
    assert(record, `Missing library cell ${library.id}/${cell.id}`);
    const view = record.views.find(v => v.kind === 'rnl');
    assert.equal(view.level, cell.native_level);
    const prefix = `lib/${library.id}/${cell.id}/${view.id}/`;
    const files = {};
    for (const name of cell.files) {
      assert(view.files.includes(prefix + name));
      files['/native/' + name] = readFileSync(join(root, prefix, name), 'utf8');
    }
    const request = {entry: '/native/' + cell.entry, files, auto_include: false};
    const doc = core.build(request);
    assert.equal(doc.failed, null, `${library.id}/${cell.id} failed`);
    assert.equal(doc.diagnostics.filter(d => ['error', 'fatal'].includes(d.severity)).length, 0);
    assert.equal(doc.missing.length, 0);
    const level = intended(doc, cell.native_level);
    assert(level && !level.empty && level.svg.includes('<svg'), `Missing intended drawing ${cell.id}`);
    const omitted = cell.files.includes('trans_ulvt_mac.scs');
    const retained = doc.levels.filter(l => !omitted || l.title !== 'trans_ulvt_mac_pcell_0');
    assert.equal(retained.reduce((n, l) => n + l.unplaced.length, 0), 0, `Unplaced original geometry ${cell.id}`);
    let original = null;
    if (seed) {
      const sourceFiles = {};
      for (const name of cell.files) {
        const raw = readFileSync(join(seed, plan.source_root, name));
        assert.equal(sha(raw), plan.files[name].sha256);
        sourceFiles['/native/' + name] = raw.toString('utf8');
        if (name !== 'trans_ulvt_mac.scs') assert.equal(files['/native/' + name], raw.toString('utf8'));
      }
      original = core.build({...request, files: sourceFiles});
      assert.equal(original.failed, null);
      // The omitted PDK implementation may change document object indices. Compare
      // hit geometry through object identities instead of those positional indices.
      for (const l of retained) {
        const before = original.levels.find(s => s.title === l.title);
        assert(before, `Lost original level ${l.title}`);
        assert.deepEqual(geometry(doc, l), geometry(original, before), `Changed native geometry ${cell.id}/${l.title}`);
      }
      if (!omitted) assert.equal(level.svg, intended(original, cell.native_level).svg);
    }
    rows.push({library: library.id, cell: cell.id, view: view.id, level: view.level,
      render: 'passed', geometry_matches_source: original ? true : null,
      retained_levels: retained.length, unplaced_in_retained_levels: 0,
      viewer_instance_definitions: doc.objects.filter(o => o.kind === 'instance').length,
      source_instance_definitions: original ? original.objects.filter(o => o.kind === 'instance').length : null,
      external_interface_stub: omitted, selected_hit_geometry_sha256: sha(JSON.stringify(geometry(doc, level))),
      selected_svg_sha256: sha(level.svg), diagnostic_counts: doc.diagnostics.reduce((a,d) => (a[d.severity]=(a[d.severity]||0)+1,a), {})});
  }
}
const report = {schema: 'circuitgit.native-validation.v1', renderer_wasm_sha256: sha(wasm),
  checked_views: rows.length, source_comparison: !!seed, auto_include: false, auto_layout: false,
  simulation_performed: false, native_export_fidelity: 'partial',
  limitations: ['Dynamic parameter/terminal labels were already omitted by the source exporter.',
    'Omitted external transmission-gate implementation is an empty interface with six unplaced ports; it is not a runnable model.',
    'Rendering and source-geometry equality do not establish electrical correctness, full OA fidelity or ADC performance.'], views: rows};
if (output) {
  const path = resolve(output); mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({views: rows.length, passed: rows.length, source_comparison: !!seed,
  external_interface_views: rows.filter(r => r.external_interface_stub).length, auto_layout: false}));
