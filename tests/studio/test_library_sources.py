"""Canonical source compiler tests: only local bytes, no models or simulation."""
from copy import deepcopy
import json
from pathlib import Path
import re
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/workbench'))
import library_sources as ls

COMMIT = 'a' * 40
BINDINGS = 'lib/pipetisar-real/TB_PIPE_RS9_N06/simulation/source-bindings.json'
DESTINATION = 'netlist/project.scs'


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def exterior(raw):
    text = raw.decode()
    spans = sorted((block.start, block.end) for block in ls.electrical_blocks(raw).values())
    first, result = 0, []
    for start, end in spans:
        result.append(text[first:start]); first = end
    return result + [text[first:]]


class LibrarySourcesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bindings_raw = (ROOT / BINDINGS).read_bytes()
        cls.bindings = ls.load_bindings(cls.bindings_raw)
        paths = {BINDINGS, *(row['source'] for row in cls.bindings['subcircuits']),
                 *(target['template_source'] for target in cls.bindings['targets'].values())}
        cls.data = {path: (ROOT / path).read_bytes() for path in paths}
        cls.observed = {path: ls.digest(raw) for path, raw in cls.data.items()}

    def setUp(self):
        self.reads = []

    def read(self, commit, path, overrides=None):
        self.assertEqual(commit, COMMIT)
        self.reads.append((commit, path))
        return overrides[path] if overrides and path in overrides else self.data[path]

    def compile(self, configuration='PIPE_LOW', overrides=None, out=None):
        target = self.bindings['targets'][configuration]
        original = out if out is not None else {DESTINATION: self.data[target['template_source']], 'netlist/model.scs': b'include "external-pdk.scs"\n'}
        before = dict(original)
        result = ls.compile_sources(BINDINGS, configuration, COMMIT, self.read, original, overrides)
        self.assertEqual(original, before, 'compiler must not mutate caller outputs')
        return result

    def test_both_real_configurations_cover_all_21_blocks_and_preserve_exterior(self):
        for configuration in self.bindings['targets']:
            with self.subTest(configuration=configuration):
                files, sources, report = self.compile(configuration)
                template = self.data[self.bindings['targets'][configuration]['template_source']]
                self.assertEqual(len(report['subcircuits']), 21)
                self.assertTrue(all(row['baseline_equivalent'] for row in report['subcircuits']))
                self.assertEqual(len(sources), 23)
                self.assertEqual(sources[BINDINGS], ls.digest(self.bindings_raw))
                self.assertEqual(exterior(files[DESTINATION]), exterior(template))
                self.assertEqual(files['netlist/model.scs'], b'include "external-pdk.scs"\n')
                self.assertNotIn(b'@RNL', files[DESTINATION])
                self.assertFalse(report['simulation_started'])
                self.assertEqual(report['compiled_sha256'], ls.digest(files[DESTINATION]))
        self.assertEqual({path: ls.digest((ROOT / path).read_bytes()) for path in self.data}, self.observed)

    def test_every_canonical_child_electrical_edit_changes_compiled_hash_and_records_input(self):
        original, _, old_report = self.compile()
        for row in self.bindings['subcircuits']:
            with self.subTest(subcircuit=row['source_subcircuit']):
                raw = self.data[row['source']]
                block = ls.electrical_blocks(raw)[row['source_subcircuit']]
                assignment = re.search(r'\b[A-Za-z_][A-Za-z0-9_]*=([^\s\\]+)', '\n'.join(block.statements[1:-1]))
                text = raw.decode()
                segment = text[block.start:block.end]
                if assignment:
                    old = assignment[0]; new = old + '*1.01'
                    segment = segment.replace(old, new, 1)
                else:
                    instance = next(line for line in block.statements[1:-1] if '(' in line)
                    name = instance.split()[0]
                    match = re.search(r'(?m)^(\s*' + re.escape(name) + r'\s*\()([^)]*)(\))', segment)
                    self.assertIsNotNone(match)
                    nodes = re.sub(r'\\\s*\n\s*', ' ', match[2]).split()
                    other = next(index for index, node in enumerate(nodes) if node != nodes[0])
                    nodes[0], nodes[other] = nodes[other], nodes[0]
                    segment = segment[:match.start(2)] + ' '.join(nodes) + segment[match.end(2):]
                changed = (text[:block.start] + segment + text[block.end:]).encode()
                files, sources, report = self.compile(overrides={row['source']: changed})
                self.assertNotEqual(files[DESTINATION], original[DESTINATION])
                self.assertNotEqual(report['compiled_sha256'], old_report['compiled_sha256'])
                self.assertEqual(sources[row['source']], ls.digest(changed))
                if assignment: self.assertIn(new.encode(), files[DESTINATION])
                status = next(item for item in report['subcircuits'] if item['source'] == row['source'])
                self.assertTrue(status['canonical_modified']); self.assertIsNone(status['baseline_equivalent'])

    def test_reader_uses_only_exact_commit_pinned_explicit_sources(self):
        self.compile()
        self.assertEqual(len(self.reads), 23)
        self.assertEqual({path for _, path in self.reads}, {BINDINGS, self.bindings['targets']['PIPE_LOW']['template_source'], *(row['source'] for row in self.bindings['subcircuits'])})
        with self.assertRaisesRegex(ValueError, 'pinned'):
            ls.compile_sources(BINDINGS, 'PIPE_LOW', 'HEAD', self.read, {})

    def test_model_includes_and_drawing_comments_from_native_sources_are_not_imported(self):
        row = self.bindings['subcircuits'][0]
        original, _, _ = self.compile()
        changed = b'include "untrusted-native-model.scs"\n// @RNL draw only\n' + self.data[row['source']] + b'\nsubckt empty_stub a b\nends empty_stub\n'
        files, sources, _ = self.compile(overrides={row['source']: changed})
        self.assertEqual(files, original)
        self.assertEqual(sources[row['source']], ls.digest(changed))
        self.assertNotIn(b'untrusted-native-model', files[DESTINATION]); self.assertNotIn(b'empty_stub', files[DESTINATION])

    def test_port_order_missing_port_and_unknown_bus_changes_fail_closed(self):
        row = self.bindings['subcircuits'][0]
        raw = self.data[row['source']]
        for changed in [raw.replace(b'subckt Switch A B ctrl', b'subckt Switch B A ctrl'), raw.replace(b'subckt Switch A B ctrl', b'subckt Switch A B'), raw.replace(b'net12', b'new_bus_99')]:
            with self.subTest(changed=changed[:100]), self.assertRaisesRegex(ValueError, 'port|indexed-alias'):
                self.compile(overrides={row['source']: changed})
        bus_row = next(row for row in self.bindings['subcircuits'] if row['identifiers'])
        alias = next(iter(bus_row['identifiers']))
        changed = self.data[bus_row['source']].replace(alias.encode(), (alias + '_99').encode())
        with self.assertRaises(ValueError):
            self.compile(overrides={bus_row['source']: changed})

    def test_body_truncation_duplicate_instance_master_and_terminal_changes_rejected(self):
        row = self.bindings['subcircuits'][0]; raw = self.data[row['source']]
        changes = [raw.replace(b'parameters Rseries=50', b''), raw.replace(b'R0 (B net12)', b'W0 (B net12)'), raw.replace(b'resistor r=Rseries', b'capacitor c=Rseries'), raw.replace(b'R0 (B net12)', b'R0 (B net12 A)'), b'subckt Switch A B ctrl\nends Switch\n']
        for changed in changes:
            with self.subTest(changed=changed[:120]), self.assertRaisesRegex(ValueError, 'body|duplicate|stub'):
                self.compile(overrides={row['source']: changed})

    def test_existing_template_cannot_bypass_canonical_sources_or_binding_hash(self):
        template = self.data[self.bindings['targets']['PIPE_LOW']['template_source']]
        with self.assertRaisesRegex(ValueError, 'staged template differs'):
            self.compile(out={DESTINATION: template.replace(b'Rseries=50', b'Rseries=51')})
        bad = deepcopy(self.bindings); bad['targets']['PIPE_LOW']['template_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'template hash'):
            self.compile(overrides={BINDINGS: encoded(bad)})

    def test_undeclared_or_nonbijective_aliases_and_wrong_baseline_proof_rejected(self):
        index = next(index for index, row in enumerate(self.bindings['subcircuits']) if row['identifiers'])
        edits = []
        bad = deepcopy(self.bindings); row = bad['subcircuits'][index]; names = list(row['identifiers']); row['identifiers'][names[0]] = row['identifiers'][names[1]]; edits.append(bad)
        bad = deepcopy(self.bindings); bad['subcircuits'][index]['contract']['alias_count'] += 1; edits.append(bad)
        bad = deepcopy(self.bindings); bad['subcircuits'][index]['baseline']['electrical_sha256'] = '0' * 64; edits.append(bad)
        bad = deepcopy(self.bindings); bad['subcircuits'][index]['contract']['identifier_counts'][names[0]] += 1; edits.append(bad)
        for bad in edits:
            with self.subTest(binding=bad['subcircuits'][index]['target_subcircuit']), self.assertRaises(ValueError):
                self.compile(overrides={BINDINGS: encoded(bad)})

    def test_unbound_child_terminal_count_rejected_even_with_updated_local_signature(self):
        bad = deepcopy(self.bindings)
        row = next(row for row in bad['subcircuits'] if row['source_subcircuit'] == 'PIPE_MDAC4_G8_SC')
        raw = self.data[row['source']]; changed = raw.replace(b'S_INN (VINN BN TRACK)', b'S_INN (VINN BN TRACK VSS)')
        self.assertNotEqual(raw, changed)
        row['contract']['instances']['S_INN']['terminals'] = 4
        with self.assertRaisesRegex(ValueError, 'child subcircuit terminal count'):
            self.compile(overrides={BINDINGS: encoded(bad), row['source']: changed})

    def test_schema_identity_paths_duplicate_json_and_malformed_blocks_are_rejected(self):
        for path in ['../bindings.json', '/bindings.json', 'lib/x/%2e%2e/a', 'lib/x/a?token=bad']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                ls.compile_sources(path, 'PIPE_LOW', COMMIT, self.read, {})
        for source in ['lib/other/cell/a.scs', 'lib/pipetisar-real/cell/simulation/project.scs']:
            bad = deepcopy(self.bindings); bad['subcircuits'][0]['source'] = source
            with self.assertRaisesRegex(ValueError, 'native library'):
                ls.load_bindings(encoded(bad))
        bad = deepcopy(self.bindings); bad['subcircuits'][0]['target_subcircuit'] = 'RenamedSwitch'
        with self.assertRaisesRegex(ValueError, 'does not rename'):
            ls.load_bindings(encoded(bad))
        with self.assertRaisesRegex(ValueError, 'duplicate JSON'):
            ls.load_bindings(b'{"schema":1,"schema":2}')
        for raw in [b'subckt A a b\nsubckt B a b\nends B\nends A\n', b'subckt A a b\nends B\n', b'subckt A a b\n', b'subckt A a b \\\n', b'ends A\n']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                ls.electrical_blocks(raw)


if __name__ == '__main__':
    unittest.main()
