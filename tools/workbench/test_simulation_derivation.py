"""Offline native PSF -> local CSV -> real WaveformService provenance checks."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from simulation_runtime import SimulationRuntime
from waveforms import WaveformError, WaveformService

COMMIT = 'a' * 40
RUN = 'derived-fixture-run'


def psf(*, unit='s'):
    return '\n'.join(['HEADER', '"PSFversion" "1.00"', '"PSF sweep points" 3',
        'TYPE', '"axis" FLOAT DOUBLE PROP(', '"units" "' + unit + '"', ')',
        '"voltage" FLOAT DOUBLE PROP(', '"units" "V"', ')',
        'SWEEP', '"time" "axis"', 'TRACE', '"out" "voltage"', 'VALUE',
        '"time" 0', '"out" 0', '"time" 1e-9', '"out" 1.2', '"time" 2e-9', '"out" 0.6', 'END', ''])


class DerivationTests(unittest.TestCase):
    def setUp(self):
        source = os.environ.get('SPICEOWL_SOURCE_DIR')
        if not source:
            self.skipTest('Set SPICEOWL_SOURCE_DIR for the actual installed PSF parser integration')
        self.assertTrue((Path(source) / 'spiceowl/integrations/spectre_results.py').is_file())
        path_patch = patch.object(sys, 'path', [source, *sys.path])
        path_patch.start(); self.addCleanup(path_patch.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.folder = self.root / RUN
        self.folder.mkdir()
        self.record = {'run_id': RUN, 'project_id': 'demo', 'source_commit': COMMIT,
                       'configuration_id': 'tran', 'state': 'collected',
                       'plan': {'simulator': {'output_format': 'psfascii'}, 'postprocess': {'signals': [{'name': 'out'}]}}}
        self.runner = Mock()
        self.runner.read.side_effect = lambda rid: copy.deepcopy(self.record) if rid == RUN else self.fail('Wrong run')
        self.runner.path.side_effect = lambda rid: self.folder if rid == RUN else self.fail('Wrong run')
        self.runner.save.side_effect = self.save_record
        self.runner.status.side_effect = AssertionError('GET must never observe remote status')
        self.runner.collect.side_effect = AssertionError('GET must never recollect')
        self.runner.dispatch.side_effect = AssertionError('GET must never dispatch')
        self.app = types.SimpleNamespace(cfg={'runtime_root': str(self.root)}, runner=self.runner,
            workspace=types.SimpleNamespace(projects={'demo': {}}), resource_pool=None)
        self.app.supervision = Mock()
        self.app.supervision.snapshot.return_value = {'runs': [{'run_id': RUN, 'source_commit': COMMIT,
            'configuration': 'tran', 'execution_target': None, 'execution': {'state': 'succeeded', 'exit_code': 0}}]}
        self.runtime = SimulationRuntime(self.app)
        self.addCleanup(self.runtime.close)
        self.viewer = WaveformService(self.runner)
        self.make_archive()

    def save_record(self, value):
        self.record = copy.deepcopy(value)

    def make_archive(self, members=None):
        if members is None:
            members = [('./psf/transient.tran', psf().encode()), ('./psf/spectre.out', b'Synthetic completed run\n')]
        archive = self.folder / 'native.tar.gz'
        inventory = []
        with tarfile.open(archive, 'w:gz') as output:
            for name, raw in members:
                member = tarfile.TarInfo(name)
                member.size = len(raw)
                output.addfile(member, io.BytesIO(raw))
                inventory.append({'path': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})
        self.record['collection'] = {'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                                     'bytes': archive.stat().st_size, 'contains_full_raw': True}
        (self.folder / 'archive-files.json').write_text(json.dumps(inventory))
        return archive

    def derive(self):
        self.runtime.derive_results(RUN)

    def read_json(self, name):
        return json.loads((self.folder / name).read_text())

    def mutate_json(self, name, update):
        value = self.read_json(name)
        update(value)
        (self.folder / name).write_text(json.dumps(value))

    def assert_no_pass_or_export(self):
        summary = self.read_json('waveform-validity.json')
        self.assertEqual(summary['specification'], 'unknown')
        self.assertFalse((self.folder / 'waveforms.csv').exists())
        self.assertNotIn('local_derivation', self.record)
        self.assertEqual(self.runtime.snapshot('demo')['runs'][0]['acceptance']['specification'], 'unknown')

    def test_tiny_native_archive_derives_real_parser_csv_and_loads_without_invented_remote_csv(self):
        before = (self.folder / 'archive-files.json').read_bytes()
        self.derive()
        record, identity, signals, rows, basis = self.viewer._load(RUN)
        self.assertEqual(rows, [[0.0, 0.0], [1e-9, 1.2], [2e-9, .6]])
        self.assertEqual([signal['psf_name'] for signal in signals], ['out'])
        self.assertEqual(identity['source_commit'], COMMIT)
        self.assertEqual(identity['archive_sha256'], self.record['collection']['sha256'])
        self.assertEqual(record['local_derivation']['csv_sha256'], identity['csv_sha256'])
        self.assertEqual((self.folder / 'archive-files.json').read_bytes(), before)
        self.assertFalse(any(row['path'].endswith('waveforms.csv') for row in self.read_json('archive-files.json')))
        self.assertEqual(self.read_json('waveform-validity.json')['data_validity'], 'valid')
        self.assertEqual(self.read_json('waveform-validity.json')['specification'], 'unknown')
        self.assertNotIn('OCEAN', basis)
        self.assertNotIn('OCEAN', signals[0]['name_evidence'])

    def test_csv_content_changed_after_derivation_is_rejected(self):
        self.derive()
        path = self.folder / 'waveforms.csv'
        path.write_bytes(path.read_bytes() + b'3e-9,7\n')
        with self.assertRaises(WaveformError) as error:
            self.viewer._load(RUN)
        self.assertEqual(error.exception.code, 'hash_mismatch')

    def test_native_digest_metadata_run_source_and_derivation_record_are_bound(self):
        self.derive()
        base_record = copy.deepcopy(self.record)
        metadata = (self.folder / 'waveforms.json').read_bytes()
        cases = [lambda: self.mutate_json('waveforms.json', lambda v: v.update(native_archive_sha256='c' * 64)),
                 lambda: self.record['collection'].update(sha256='c' * 64),
                 lambda: self.record.update(source_commit='c' * 40),
                 lambda: self.record['local_derivation'].update(run_id='other-run'),
                 lambda: self.record['local_derivation'].update(source_commit='c' * 40),
                 lambda: self.record['local_derivation'].update(csv_sha256='c' * 64),
                 lambda: self.record.pop('local_derivation'),
                 lambda: self.mutate_json('waveforms.json', lambda v: v.update(producer='unrecognized'))]
        for index, mutation in enumerate(cases):
            self.record = copy.deepcopy(base_record)
            (self.folder / 'waveforms.json').write_bytes(metadata)
            mutation()
            with self.subTest(index=index), self.assertRaises(WaveformError):
                self.viewer._load(RUN)

    def test_changing_csv_and_metadata_hash_still_needs_original_derivation_record(self):
        self.derive()
        path = self.folder / 'waveforms.csv'
        path.write_bytes(path.read_bytes().replace(b'0,0\r\n', b'0,0.5\r\n', 1))
        changed = hashlib.sha256(path.read_bytes()).hexdigest()
        self.mutate_json('waveforms.json', lambda v: v.update(csv_sha256=changed))
        with self.assertRaises(WaveformError):
            self.viewer._load(RUN)

    def test_metadata_cannot_relabel_a_voltage_as_current_without_changing_derived_csv(self):
        self.derive()
        self.mutate_json('waveforms.json', lambda value: value['waveforms'][0].update(unit='A'))
        with self.assertRaises(WaveformError):
            self.viewer._load(RUN)

    def test_native_inventory_cannot_be_replaced_under_an_existing_local_derivation(self):
        self.derive()
        self.mutate_json('archive-files.json', lambda value: value[0].update(sha256='f' * 64))
        with self.assertRaises(WaveformError):
            self.viewer._load(RUN)

    def test_runtime_validity_from_another_run_source_or_archive_is_never_adopted(self):
        self.derive()
        original = (self.folder / 'waveform-validity.json').read_bytes()
        for field, value in [('run_id', 'other-run'), ('source_commit', 'c' * 40), ('native_archive_sha256', 'd' * 64)]:
            (self.folder / 'waveform-validity.json').write_bytes(original)
            self.mutate_json('waveform-validity.json', lambda summary: summary.update({field: value}))
            with self.subTest(field=field):
                acceptance = self.runtime.snapshot('demo')['runs'][0]['acceptance']
                self.assertEqual(acceptance['data_validity'], 'unknown')
                self.assertEqual(acceptance['specification'], 'unknown')

    def test_modified_or_missing_native_archive_cannot_be_derived(self):
        path = Path(self.record['collection']['archive'])
        original = path.read_bytes()
        path.write_bytes(original + b'changed')
        with self.assertRaises(ValueError):
            self.derive()
        path.unlink()
        with self.assertRaises(ValueError):
            self.derive()
        self.assertFalse((self.folder / 'waveforms.csv').exists())

    def test_binary_multiple_or_missing_tran_stays_unknown_specification(self):
        for members in [[('./psf/transient.tran', b'\xff\x00PSF-BINARY')],
                        [('./psf/a.tran', psf().encode()), ('./psf/b.tran', psf().encode())],
                        [('./console.log', b'No saved transient result')]]:
            with self.subTest(members=[name for name, _ in members]):
                self.make_archive(members)
                self.derive()
                self.assert_no_pass_or_export()

    def test_nonsecond_axis_is_never_silently_labelled_as_seconds(self):
        self.make_archive([('./psf/transient.tran', psf(unit='ms').encode())])
        self.derive()
        self.assert_no_pass_or_export()

    def test_missing_required_signal_does_not_publish_a_valid_display_csv(self):
        self.record['plan']['postprocess']['signals'] = [{'name': 'not_saved'}]
        self.derive()
        self.assertEqual(self.read_json('waveform-validity.json')['data_validity'], 'invalid')
        self.assert_no_pass_or_export()

    def test_metadata_and_csv_byte_limits_apply_before_parsing(self):
        self.derive()
        for name, limit in [('waveforms.json', 16 * 1024**2), ('waveforms.csv', 64 * 1024**2)]:
            path = self.folder / name
            original = path.read_bytes()
            with path.open('wb') as output:
                output.truncate(limit + 1)
            with self.subTest(name=name), self.assertRaises(WaveformError) as error:
                self.viewer._load(RUN)
            self.assertEqual(error.exception.code, 'data_limit')
            path.write_bytes(original)

    def test_oversized_second_tran_is_not_discarded_to_make_a_multi_analysis_archive_look_single(self):
        self.make_archive([('./psf/a.tran', psf().encode()), ('./psf/b.tran', b'\0' * (16 * 1024**2 + 1))])
        self.derive()
        self.assert_no_pass_or_export()

    def test_cached_catalog_and_runtime_gets_never_derive_collect_or_change_files(self):
        self.derive()
        files = {path.name: (path.stat().st_mtime_ns, path.read_bytes()) for path in self.folder.iterdir()}
        with patch.object(self.runtime, 'derive_results', side_effect=AssertionError('GET must never derive')):
            for _ in range(2):
                catalog = self.viewer.catalog(RUN)
                snapshot = self.runtime.snapshot('demo')
                self.assertEqual(catalog['run_id'], RUN)
                self.assertEqual(snapshot['runs'][0]['acceptance']['specification'], 'unknown')
        self.assertEqual(files, {path.name: (path.stat().st_mtime_ns, path.read_bytes()) for path in self.folder.iterdir()})
        self.runner.status.assert_not_called()
        self.runner.collect.assert_not_called()
        self.runner.dispatch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
