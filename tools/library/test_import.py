import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import import_adc as imp


class NativeImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plan = json.loads(imp.PLAN.read_text())

    def test_public_views_match_pinned_files_except_declared_interface(self):
        changed, count = 0, 0
        for lib in self.plan['libraries']:
            m = json.loads((imp.ROOT / 'lib' / lib['id'] / 'library.json').read_text())
            for cell in m['cells']:
                count += 1
                self.assertIsNone(cell['project_id'])
                p = json.loads((imp.ROOT / cell['directory'] / 'docs/provenance.json').read_text())
                view = next(v for v in cell['views'] if v['kind'] == 'rnl')
                self.assertEqual(view['level'], p['native_level'])
                self.assertEqual(set(view['files']), {f['path'] for f in p['files']})
                for f in p['files']:
                    raw = (imp.ROOT / f['path']).read_bytes()
                    self.assertEqual(imp.digest(raw), f['sha256'])
                    if f['transformation'] == 'none':
                        self.assertEqual(f['source_sha256'], f['sha256'])
                        imp.audit(raw, f['path'])
                    else:
                        changed += 1
                        self.assertEqual(raw, imp.stub())
                        self.assertNotEqual(f['source_sha256'], f['sha256'])
        self.assertEqual(count, 96)
        self.assertEqual(changed, 4)

    def test_spectre_and_rnl_dependency_closures(self):
        for lib in self.plan['libraries']:
            for c in lib['cells']:
                folder = imp.ROOT / 'lib' / lib['id'] / c['id'] / ('symbol' if c['symbol_only'] else 'schematic')
                for name in c['files']:
                    for dep in imp.includes((folder / name).read_text()):
                        self.assertIn((Path(name).parent / imp.relative(dep)).as_posix(), c['files'])

    def test_partial_export_and_non_runnable_status_are_explicit(self):
        report = json.loads((imp.ROOT / 'lib/validation/native-render.json').read_text())
        self.assertEqual(report['checked_views'], 96)
        self.assertFalse(report['auto_layout'])
        self.assertFalse(report['simulation_performed'])
        self.assertTrue(all(v['geometry_matches_source'] for v in report['views']))
        top = next(v for v in report['views'] if v['library'] == 'pipetisar-real' and v['cell'] == 'TB_PIPE_RS9_N06')
        self.assertEqual((top['source_instance_definitions'], top['viewer_instance_definitions']), (711, 709))

    def test_private_models_and_vendor_implementations_rejected(self):
        for raw in [b'include "/home/private/models.scs"', b'model secret bsim4 type=n',
                    b'ahdl_include "private.va"', b'subckt ND2D0BWP12T30P140ULVT A Z\nends',
                    b'subckt trans_ulvt_mac_pcell_0 A Y\nends']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                imp.audit(raw, 'fixture.scs')

    def test_nonstring_and_traversal_paths_rejected(self):
        for name in [None, {}, '', '/absolute', '../escape', 'a/../b', 'a//b', 'a\\b', 'https:thing']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                imp.relative(name)

    def test_write_rejects_symlinked_ancestor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; root.mkdir()
            outside = Path(tmp) / 'outside'; outside.mkdir()
            (root / 'escape').symlink_to(outside, target_is_directory=True)
            with patch.object(imp, 'ROOT', root), self.assertRaises(ValueError):
                imp.write(root / 'escape/file.scs', b'private')
            self.assertFalse((outside / 'file.scs').exists())

    def sample(self, tmp):
        plan = copy.deepcopy(self.plan)
        library = copy.deepcopy(plan['libraries'][0])
        cell = next(c for c in library['cells'] if c['id'] == 'Switch')
        library['cells'] = [cell]
        seed = Path(tmp) / 'seed'
        for name in cell['files']:
            dest = seed / plan['source_root'] / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes((imp.ROOT / 'lib/pipetisar-real/Switch/schematic' / name).read_bytes())
        return seed, plan, library

    def test_changed_source_pin_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            seed, plan, library = self.sample(tmp)
            f = seed / plan['source_root'] / library['cells'][0]['files'][0]
            f.write_bytes(f.read_bytes() + b'\n// changed\n')
            with patch.object(imp, 'ROOT', Path(tmp) / 'out'), self.assertRaisesRegex(ValueError, 'Source pin changed'):
                imp.import_library(seed, plan, library, None, False)

    def test_missing_declared_package_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            seed, plan, library = self.sample(tmp)
            library['cells'][0]['files'].remove('eda-symbol.rnl')
            with patch.object(imp, 'ROOT', Path(tmp) / 'out'), self.assertRaisesRegex(ValueError, 'Incomplete native include closure'):
                imp.import_library(seed, plan, library, None, False)

    def test_single_cell_refresh_does_not_remove_other_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            seed, plan, library = self.sample(tmp)
            original = json.loads((imp.ROOT / 'lib/pipetisar-real/library.json').read_text())
            out = Path(tmp) / 'out'
            p = out / 'lib/pipetisar-real/library.json';p.parent.mkdir(parents=True)
            p.write_text(json.dumps(original))
            with patch.object(imp, 'ROOT', out):
                imp.import_library(seed, plan, plan['libraries'][0], 'Switch', False)
            result = json.loads(p.read_text())
            self.assertEqual(len(result['cells']), 22)
            self.assertEqual(result['cells'][0], original['cells'][0])


if __name__ == '__main__':
    unittest.main()
