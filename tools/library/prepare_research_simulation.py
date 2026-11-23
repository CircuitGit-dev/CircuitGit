#!/usr/bin/env python3
"""Reproduce research input bundles from explicitly audited local exports.

No simulator, network, site settings or private model file is accessed. PDK
definitions present in the original export are removed, leaving hash-pinned
external aliases. Existing audit/configuration/native source bytes are preserved.
"""
import argparse
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/workbench'))
import library_sources as compiler
from deduplicate import electrical_blocks, bus_rename_audit
from import_adc import PRIVATE, EXTERNAL_DEF

LIBRARY = 'pipetisar-research'
CASES = {'TB_PIPE_CA4_RS9_N06': ['PIPE_LOW', 'PIPE_NYQUIST'], 'TB_MDAC_CA4_N06': ['MDAC_CODES']}
PDK = {'ND2D4BWP12T30P140ULVT': 'RESEARCH_ULVT_ND2D4',
       'ND2D0BWP12T30P140ULVT': 'RESEARCH_ULVT_ND2D0',
       'trans_ulvt_mac_pcell_0': 'PDK_TRANS_ULVT_PCELL'}
SNAPSHOT = 'outputs/adc/real_sar_20261106/model_snapshot'
RESEARCH = 'outputs/adc/mdac_array_20261106'


def dump(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def checked(seed, path, expected):
    p = seed / path
    if p.is_symlink() or not p.resolve().is_relative_to(seed.resolve()):
        raise ValueError('Export path escapes supplied seed')
    raw = p.read_bytes()
    if compiler.digest(raw) != expected:
        raise ValueError('Audited export hash changed: ' + path)
    return raw


def prepare(seed, root=ROOT):
    manifest = json.loads((root / f'lib/{LIBRARY}/library.json').read_text())
    cells = {cell['id']: cell for cell in manifest['cells']}
    baseline_path = 'lib/pipetisar-real/TB_PIPE_RS9_N06/simulation/PIPE_LOW/bundle.json'
    baseline = json.loads((root / baseline_path).read_text())
    inherited_pins = {r['alias']: r['sha256'] for r in baseline['external_dependencies'] if r['alias'] in ('PDK_MAIN', 'STDCELL_SVT_LVT')}
    snapshot_raw = (seed / (SNAPSHOT + '.json')).read_bytes()
    snapshots = json.loads(snapshot_raw)
    outputs, summaries = {}, []
    for cell_id, configurations in CASES.items():
        prefix = f'lib/{LIBRARY}/{cell_id}/simulation'
        bindings = {'schema': compiler.SCHEMA, 'library_id': LIBRARY, 'cell_id': cell_id, 'targets': {}, 'subcircuits': []}
        tb_path = f'lib/{LIBRARY}/{cell_id}/schematic/research/{cell_id}.scs'
        tb_raw = (root / tb_path).read_bytes()
        native_provenance = json.loads((root / f'lib/{LIBRARY}/{cell_id}/docs/provenance.json').read_text())
        native_record = next(row for row in native_provenance['files'] if row['path'] == tb_path)
        if compiler.digest(tb_raw) != native_record['sha256']:
            raise ValueError('Preparation requires the preserved native testbench baseline; update TB bindings/templates explicitly for edited electrical sources')
        bindings['electrical_guards'] = [{'source': tb_path, 'source_sha256': compiler.digest(tb_raw),
                                          'electrical_sha256': compiler.electrical_hash(tb_raw)}]
        first_rows = None
        for config in configurations:
            folder = prefix + '/' + config
            audit_path = folder + '/audit.json'
            audit_raw = (root / audit_path).read_bytes(); audit = json.loads(audit_raw)
            configuration_raw = (root / (folder + '/configuration.json')).read_bytes()
            configuration = json.loads(configuration_raw)
            runtime_configuration = dict(configuration)
            runtime_configuration['description'] = config + ': canonical research inputs; pinned project VA snapshot; external licensed models required'
            runtime_configuration_raw = dump(runtime_configuration)
            input_raw = checked(seed, audit['source'], audit['source_sha256'])
            design_path = str(Path(audit['source']).parent / 'design_netlist.scs')
            design_raw = checked(seed, design_path, audit['design_sha256'])
            design = design_raw.decode(); original = compiler.electrical_blocks(design_raw)
            audit_blocks = electrical_blocks(design_raw)
            rows, external, deletions, sources = [], dict(inherited_pins), [], {}
            for name, block in original.items():
                if name in audit['external_implementation_definitions_to_remove']:
                    if name not in PDK: raise ValueError('Unreviewed external definition ' + name)
                    alias = PDK[name]; raw = design[block.start:block.end].encode()
                    external[alias] = compiler.digest(raw)
                    deletions.append({'subcircuit': name, 'alias': alias, 'body_sha256': external[alias], 'bytes': len(raw)})
                    continue
                owner = cells[name]
                paths = {p for v in owner['views'] for p in v['files'] if p.endswith('/' + name + '.scs')}
                if len(paths) != 1: raise ValueError('Canonical owner is ambiguous: ' + name)
                path = paths.pop()
                if not path.startswith(f'lib/{LIBRARY}/{name}/'): raise ValueError('Wrong-library canonical owner')
                raw = (root / path).read_bytes(); native = compiler.electrical_blocks(raw)[name]
                comparison = bus_rename_audit(audit_blocks[name], electrical_blocks(raw)[name])
                if comparison['status'] not in ('exact-tokens-after-bus-renaming', 'same-statements-after-bus-renaming'):
                    raise ValueError('Canonical electrical comparison failed: ' + name)
                identifiers = {native: exported for exported, native in comparison['identifiers'].items()}
                row = {'target_subcircuit': name, 'source': path, 'source_subcircuit': name,
                       'source_ports': list(native.ports), 'target_ports': list(block.ports),
                       'identifiers': dict(sorted(identifiers.items())), 'contract': compiler.source_contract(native, identifiers),
                       'baseline': {'source_sha256': compiler.digest(raw), 'electrical_sha256': compiler.block_hash(native),
                                    'template_electrical_sha256': compiler.block_hash(block),
                                    'equivalence': 'statements' if comparison['status'].startswith('same-statements') else 'tokens'}}
                rows.append(row); sources[path] = raw
            if len(deletions) != len(audit['external_implementation_definitions_to_remove']):
                raise ValueError('External implementation removal inventory differs')
            for removal in sorted(deletions, key=lambda r: original[r['subcircuit']].start, reverse=True):
                block = original[removal['subcircuit']]
                design = design[:block.start] + 'include "@EXTERNAL_' + removal['alias'] + '@"\n' + design[block.end:]
            payload = {'netlist/project.scs': design.encode()}
            text = input_raw.decode()
            if design_raw.decode() in text:
                if text.count(design_raw.decode()) != 1: raise ValueError('Inline design is ambiguous')
                text = text.replace(design_raw.decode(), '\ninclude "project.scs"\n', 1)
            elif 'include "netlist"' in text:
                text = text.replace('include "netlist"', 'include "project.scs"')
            else:
                raise ValueError('No audited design inclusion in input')
            local_dependencies, va_dependencies, references = [], [], []
            def reference(match):
                command, old = match[1], match[2]
                if old == 'project.scs': return match[0]
                references.append({'directive': command, 'original_reference_sha256': compiler.digest(old.encode())})
                if command == 'ahdl_include':
                    name = Path(old).parts[-3]
                    if name not in audit['project_veriloga_dependencies'] or snapshots[name]['source'] != old:
                        raise ValueError('Unbound Verilog-A reference')
                    rel = SNAPSHOT + '/' + name + '.va'
                    raw = checked(seed, rel, snapshots[name]['sha256'])
                    if re.search(r'\bmodule\s+' + re.escape(name) + r'\b', raw.decode()) is None:
                        raise ValueError('Verilog-A module identity mismatch')
                    payload['netlist/models/' + name + '.va'] = raw
                    va_dependencies.append({'module': name, 'source': rel, 'sha256': compiler.digest(raw),
                                            'snapshot_time': snapshots[name]['snapshot_time'], 'historical_run_revision_verified': False})
                    return f'ahdl_include "models/{name}.va"'
                if old.endswith('.scs') and '/.codex_runs/mdac_array_20261106/' in old:
                    name = Path(old).name
                    if name not in (cell_id + '_save.scs', 'numerical_options.scs'): raise ValueError('Unreviewed local include')
                    rel = RESEARCH + '/' + name; raw = (seed / rel).read_bytes()
                    payload['netlist/' + name] = raw
                    local_dependencies.append({'source': rel, 'sha256': compiler.digest(raw),
                                               'revision_basis': 'selected-local-snapshot',
                                               'historical_run_revision_verified': False})
                    return f'include "{name}"'
                if old.endswith('crn28ull_1d8_elk_v1d8_2p2_shrink0d9_embedded_usage.scs'):
                    return 'include "@EXTERNAL_PDK_MAIN@"'
                if old.endswith('tcbn28hpcplusbwp12t30p140svtlvt_170a.spi'):
                    return 'include "@EXTERNAL_STDCELL_SVT_LVT@"'
                raise ValueError('Unreviewed input include')
            text = re.sub(r'(?m)^\s*(include|ahdl_include)\s+"([^"\n]+)"', reference, text)
            payload['netlist/input.scs'] = text.encode()
            if {row['module'] for row in va_dependencies} != set(audit['project_veriloga_dependencies']):
                raise ValueError('Verilog-A closure differs')
            for path, raw in payload.items():
                if PRIVATE.search(raw.decode()) or EXTERNAL_DEF.search(raw.decode()):
                    raise ValueError('Private path or PDK implementation remains in ' + path)
            target_path = folder + '/netlist/project.scs'
            bindings['targets'][config] = {'template_source': target_path, 'template_sha256': compiler.digest(payload['netlist/project.scs']), 'destination': 'netlist/project.scs'}
            if first_rows is None: first_rows = rows
            elif first_rows != rows: raise ValueError('Configurations need distinct canonical contracts')
            bundle = {'schema': 'ic.sim.bundle.v1', 'design_id': LIBRARY + '-' + cell_id,
                      'library': '2026_PIPETISAR_RESEARCH', 'top_cell': 'PIPE_TOP_CA4_RS9_N06' if cell_id.startswith('TB_PIPE') else 'MDAC4_ARRAY_G8_N06',
                      'testbench': cell_id, 'test': config, 'test_id': LIBRARY + '-' + cell_id + '-' + config,
                      'source_root': '.', 'entrypoint': 'netlist/input.scs', 'design_origin': 'audited-research-export-with-pinned-va-snapshot',
                      'reviewed_for_distribution': False, 'external_dependencies': [{'alias': alias, 'sha256': pin} for alias, pin in sorted(external.items())],
                      'configuration': {'parameters_observed': audit['parameters_observed'], 'analysis_observed': audit['analysis_observed'], 'model_sections': audit['external_model_sections']},
                      'simulator': configuration['simulator'], 'postprocess': configuration['postprocess'],
                      'files': [{'source': name, 'destination': name, 'sha256': compiler.digest(raw)} for name, raw in sorted(payload.items())]}
            provenance = {'schema': 'circuitgit.research-inputs.v1', 'source': audit['source'], 'source_sha256': audit['source_sha256'],
                          'design_source': design_path, 'design_sha256': audit['design_sha256'], 'history': audit['history'], 'test': config,
                          'audit_path': audit_path, 'audit_sha256': compiler.digest(audit_raw), 'configuration_sha256': compiler.digest(configuration_raw),
                          'runtime_configuration_sha256': compiler.digest(runtime_configuration_raw),
                          'published_bytes_are_original': False, 'external_definitions_removed': deletions,
                          'inherited_external_pin_source': baseline_path, 'inherited_external_pins': inherited_pins,
                          'model_snapshot_manifest': SNAPSHOT + '.json', 'model_snapshot_manifest_sha256': compiler.digest(snapshot_raw),
                          'veriloga': va_dependencies, 'local_dependencies': local_dependencies, 'redacted_references': references,
                          'canonical_sources': {path: compiler.digest(raw) for path, raw in sorted(sources.items())},
                          'limitations': ['Project VA uses the explicitly pinned archived snapshot; matching the historical simulator binary revision is not established.',
                                          'Saved-signal and numerical-options includes are selected, hash-pinned local versions; original input/design hashes do not verify their historical run revisions.',
                                          'Only explicitly bound canonical child subcircuits are recompiled; electrical edits to the guarded displayed testbench entry require an explicit TB binding/input template update and otherwise fail compilation.',
                                          'The two global PDK pins are inherited from the existing declared operator model revision, not newly measured from this history.',
                                          'Licensed PDK/standard-cell bodies, site configuration and credentials are excluded. No simulation was run.'],
                          'simulation_executed': False}
            outputs.update({folder + '/' + name: raw for name, raw in payload.items()})
            outputs[folder + '/bundle.json'] = dump(bundle); outputs[folder + '/provenance.json'] = dump(provenance)
            outputs[folder + '/run-configuration.json'] = runtime_configuration_raw
            summaries.append({'cell': cell_id, 'configuration': config, 'canonical_subcircuits': len(rows), 'va_modules': len(va_dependencies), 'external_aliases': sorted(external)})
        bindings['subcircuits'] = first_rows
        bindings_path = prefix + '/source-bindings.json'; outputs[bindings_path] = dump(bindings)
        def reader(commit, path, overrides=None):
            if overrides and path in overrides: return overrides[path]
            return outputs[path] if path in outputs else (root / path).read_bytes()
        for config, target in bindings['targets'].items():
            compiled, _, report = compiler.compile_sources(bindings_path, config, '0' * 40, reader, {'netlist/project.scs': outputs[target['template_source']]})
            if not all(row['baseline_equivalent'] for row in report['subcircuits']): raise ValueError('Initial canonical comparison incomplete')
    return outputs, summaries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed-root', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    outputs, summaries = prepare(args.seed_root)
    for name, raw in outputs.items():
        path = ROOT / name
        if args.check:
            if path.read_bytes() != raw: raise ValueError('Generated input differs: ' + name)
        else:
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
    print(json.dumps({'status': 'verified' if args.check else 'prepared', 'files': len(outputs), 'configurations': summaries, 'simulation_started': False}))


if __name__ == '__main__': main()
