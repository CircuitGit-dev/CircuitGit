"""Synthetic local exports through the real WaveformService, never a live run."""
import copy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from onboarding_waveforms import (MAX_RESPONSE_BYTES, OnboardingWaveforms,
                                  WaveformBinding, dispatch)
from waveforms import WaveformError, WaveformService


INTAKE = 'intake_' + 'a' * 32
RUN = 'synthetic-original-run'
COMMIT = 'a' * 40
SOURCE_PATH = 'projects/synthetic/input.scs'
SOURCE = b'subckt Example IN OUT\nR1 (IN OUT) resistor r=1000\nends Example\n'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class OnboardingWaveformsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.folder = self.root / RUN
        self.folder.mkdir()
        archive = b'original synthetic archive identity, no simulation performed'
        self.record = {'run_id': RUN, 'job_id': RUN, 'source_commit': COMMIT,
            'state': 'collected', 'collection': {'sha256': sha(archive)},
            'plan': {'configuration': {'synthetic': True}, 'postprocess': {},
                     'provenance': {'materialization': {'source_sha256': {SOURCE_PATH: sha(SOURCE)}}}}}
        self.runner = Mock()
        self.runner.read.side_effect = lambda rid: copy.deepcopy(self.record) if rid == RUN else self.fail('Unbound run read')
        self.runner.path.side_effect = lambda rid: self.folder if rid == RUN else self.fail('Unbound artifact path')
        for method in ('status', 'collect', 'dispatch', 'save'):
            getattr(self.runner, method).side_effect = AssertionError('Read must never ' + method)
        self.service = WaveformService(self.runner)
        self.binding = WaveformBinding(INTAKE, RUN, RUN, COMMIT, self.service,
            archive_sha256=sha(archive), original_source_sha256=sha(SOURCE),
            compiled_source_sha256=sha(SOURCE), transformation='none', compiled_source_path=SOURCE_PATH)
        self.resolve = Mock(side_effect=lambda intake, job: self.binding)
        self.api = OnboardingWaveforms(self.resolve)
        self.export()

    def export(self, count=21):
        raw = ('out X,out Y,in Y\n' + ''.join('%s,%s,%s\n' % (i / 10, i % 3, i % 2)
                                             for i in range(count))).encode()
        meta = {'run_id': RUN, 'source_commit': COMMIT, 'csv_sha256': sha(raw),
                'csv_samples': count, 'waveforms': [
                    {'name': 'out', 'time_unit': 's', 'unit': 'V'},
                    {'name': 'in', 'time_unit': 's', 'unit': 'V'}]}
        (self.folder / 'waveforms.csv').write_bytes(raw)
        (self.folder / 'waveforms.json').write_text(json.dumps(meta))
        (self.folder / 'archive-files.json').write_text(json.dumps([
            {'path': './export/waveforms.csv', 'sha256': sha(raw), 'bytes': len(raw)},
            {'path': './psf/synthetic.tran', 'sha256': sha(b'synthetic'), 'bytes': 9}]))

    def args(self, **kwargs):
        return {'intake_id': INTAKE, 'job_id': RUN, **kwargs}

    def signals(self):
        return [s['id'] for s in self.service.catalog(RUN)['signals']]

    def expect_error(self, code, operation, args):
        with self.assertRaises(WaveformError) as caught:
            self.api.read(operation, args)
        self.assertEqual(caught.exception.code, code)

    def test_actual_catalog_has_manual_signals_and_preserves_source_archive_identity(self):
        result = self.api.read('catalog', self.args())
        self.assertEqual([s['label'] for s in result['catalog']['signals']], ['out', 'in'])
        self.assertEqual(result['catalog']['source_hashes'], {SOURCE_PATH: sha(SOURCE)})
        self.assertEqual(result['original_source_sha256'], result['compiled_source_sha256'])
        self.assertEqual(result['archive_sha256'], self.record['collection']['sha256'])
        self.assertEqual(result['run_id'], RUN)
        self.assertFalse(result['probe']['enabled'])
        self.resolve.assert_called_once_with(INTAKE, RUN)

    def test_unmapped_original_run_still_has_independently_readable_manual_curves(self):
        result = self.api.read('mapping', self.args())
        self.assertEqual(result['mapping']['status'], 'unmapped')
        self.assertEqual(result['mapping']['objects'], [])
        self.assertFalse(result['probe']['enabled'])
        self.assertEqual(result['probe']['reason'], 'no_source_geometry_binding')
        window = self.api.read('window', self.args(signal_ids=self.signals()))
        self.assertEqual(len(window['series']), 2)
        self.assertEqual(window['series'][0]['points'][0], [0., 0.])

    def test_window_uses_actual_native_service_start_end_limit_and_signal_ids(self):
        ids = self.signals()
        result = dispatch(self.api, 'window', {
            'intake_id': [INTAKE], 'job_id': [RUN], 'signal_ids': [','.join(ids)],
            'start': ['0.25'], 'stop': ['1.65'], 'max_points': ['6']})
        for sid, series in zip(ids, result['series']):
            self.assertEqual(series['signal']['id'], sid)
            self.assertEqual(series['window']['requested'], [.25, 1.65])
            self.assertLessEqual(len(series['points']), 6)
            self.assertTrue(series['display']['decimated'])
            self.assertFalse(series['measurement']['uses_display_samples'])
        self.assertFalse(result['probe']['enabled'])

    def test_installed_source_mapping_does_not_claim_current_geometry_context(self):
        catalog = self.service.catalog(RUN)
        manifest = {'schema': 'ic.waveform-map.v1',
            **{k: catalog[k] for k in ('run_id', 'source_commit', 'effective_config_sha256', 'raw_signature')},
            'source': {'kind': 'canonical', 'path': SOURCE_PATH, 'sha256': sha(SOURCE)},
            'geometry': {'bundle_commit': 'b' * 40, 'manifest_sha256': 'c' * 64, 'entry_id': 'synthetic'},
            'objects': [{'selector': {'kind': 'net', 'name': 'OUT', 'scope': 'Example',
                                     'viewer_source_path': SOURCE_PATH, 'occurrence_path': []},
                         'status': 'available', 'signal_id': catalog['signals'][0]['id'],
                         'psf_name': 'out', 'analysis': 'tran', 'unit': 'V', 'scale': 1,
                         'evidence': 'Original synthetic manifest for validation tests only'}]}
        path = self.root / 'synthetic-mapping.json'
        path.write_text(json.dumps(manifest))
        self.service.bindings[RUN] = str(path)
        result = self.api.read('mapping', self.args())
        self.assertEqual(result['mapping']['status'], 'verified_binding')
        self.assertFalse(result['probe']['enabled'])
        self.assertFalse(result['probe']['current_geometry_context_verified'])
        self.assertEqual(result['probe']['reason'], 'current_geometry_context_unverified')

    def test_existing_csv_without_bound_archive_is_not_usable(self):
        self.record['collection'] = None
        self.binding = replace(self.binding, archive_sha256=None)
        self.expect_error('identity_mismatch', 'catalog', self.args())

    def test_completed_receipt_without_existing_exports_is_not_waveform_availability(self):
        self.record['state'] = 'succeeded'
        (self.folder / 'waveforms.json').unlink()
        descriptor = self.api.describe(INTAKE, RUN)
        self.assertFalse(descriptor['available'])
        self.assertEqual(descriptor['unavailable_reason'], 'not_extracted')
        self.assertFalse(descriptor['source_binding_verified'])
        self.expect_error('not_extracted', 'catalog', self.args())

    def test_describe_verifies_actual_exports_and_reports_both_source_hashes(self):
        descriptor = self.api.describe(INTAKE, RUN)
        self.assertTrue(descriptor['available'])
        self.assertTrue(descriptor['source_binding_verified'])
        self.assertEqual(descriptor['available_signal_ids'], self.signals())
        for key in ('raw_signature', 'effective_config_sha256', 'csv_sha256', 'archive_sha256'):
            self.assertRegex(descriptor[key], r'^[a-f0-9]{64}$')
        self.assertEqual(descriptor['original_source_sha256'], sha(SOURCE))
        self.assertEqual(descriptor['compiled_source_sha256'], sha(SOURCE))
        self.assertEqual(descriptor['transformation'], 'none')

    def test_flat_wrapper_tracks_distinct_original_and_compiled_source_bytes(self):
        original = b'R1 (IN OUT) resistor r=1000\n'
        self.binding = replace(self.binding, original_source_sha256=sha(original),
                               transformation='added_explicit_subcircuit_wrapper')
        descriptor = self.api.describe(INTAKE, RUN)
        self.assertTrue(descriptor['available'])
        self.assertNotEqual(descriptor['original_source_sha256'], descriptor['compiled_source_sha256'])
        self.assertNotIn(sha(original), descriptor['source_hashes'].values())
        self.assertIn(sha(SOURCE), descriptor['source_hashes'].values())

    def test_changed_source_cannot_masquerade_as_no_transformation(self):
        self.binding = replace(self.binding, original_source_sha256='f' * 64)
        self.expect_error('identity_mismatch', 'catalog', self.args())

    def test_binding_rejects_wrong_intake_run_source_or_archive_before_artifact_read(self):
        original = self.binding
        cases = [{'intake_id': 'intake_' + 'b' * 32}, {'job_id': 'other'}, {'run_id': 'other'},
                 {'source_commit': 'c' * 40}, {'archive_sha256': 'd' * 64},
                 {'compiled_source_sha256': 'e' * 64, 'original_source_sha256': 'e' * 64},
                 {'compiled_source_path': 'other/source.scs'}, {'transformation': 'guessed'}]
        for change in cases:
            self.binding = replace(original, **change)
            with self.subTest(change=change):
                self.expect_error('identity_mismatch', 'catalog', self.args())
        self.binding = original
        self.record['job_id'] = 'other-original'
        self.expect_error('identity_mismatch', 'catalog', self.args())

    def test_query_rejects_paths_unknown_analysis_duplicate_ids_and_bounds_before_resolver(self):
        sid = self.signals()[0]
        cases = [('catalog', self.args(path='/etc/passwd')),
                 ('catalog', self.args(run_id='other')),
                 ('window', self.args(signal_ids=['/etc/passwd'])),
                 ('window', self.args(signal_ids=[sid, sid])),
                 ('window', self.args(signal_ids=[sid], analysis='ac')),
                 ('window', self.args(signal_ids=[sid], max_points=True)),
                 ('window', self.args(signal_ids=[sid], max_points=10001)),
                 ('window', self.args(signal_ids=[sid], max_points=3)),
                 ('window', self.args(signal_ids=[sid], start='nan')),
                 ('window', self.args(signal_ids=[sid], start=1, stop=1)),
                 ('window', self.args(signal_ids=[sid], start=True)),
                 ('window', self.args(signal_ids=[sid], start='1' * 5000))]
        for operation, args in cases:
            self.resolve.reset_mock()
            with self.subTest(args=args), self.assertRaises(WaveformError):
                self.api.read(operation, args)
            self.resolve.assert_not_called()

    def test_parse_qs_duplicates_blank_fields_and_unknown_operation_are_errors(self):
        for query in ({'intake_id': [INTAKE, INTAKE], 'job_id': [RUN]},
                      {'intake_id': [''], 'job_id': [RUN]},
                      {'intake_id': INTAKE, 'job_id': [RUN]}):
            with self.assertRaises(WaveformError):
                dispatch(self.api, 'catalog', query)
        self.expect_error('not_found', 'fetch', self.args())

    def test_absent_signal_does_not_fallback_to_first_saved_name(self):
        self.expect_error('signal_absent', 'window', self.args(signal_ids=['s_' + 'b' * 32]))

    def test_changed_csv_hash_remains_error_and_descriptor_does_not_hide_it(self):
        with (self.folder / 'waveforms.csv').open('ab') as stream:
            stream.write(b'3,4,5\n')
        self.expect_error('hash_mismatch', 'catalog', self.args())
        with self.assertRaises(WaveformError) as caught:
            self.api.describe(INTAKE, RUN)
        self.assertEqual(caught.exception.code, 'hash_mismatch')

    def test_multisignal_read_rejects_identity_change_between_catalog_and_window(self):
        real = self.service.waveform
        def changed(*args, **kwargs):
            value = real(*args, **kwargs)
            value['raw_signature'] = 'f' * 64
            return value
        with patch.object(self.service, 'waveform', side_effect=changed):
            self.expect_error('identity_mismatch', 'window', self.args(signal_ids=self.signals()))

    def test_response_limit_covers_the_complete_actual_http_envelope(self):
        real = self.service.catalog
        def oversized(rid):
            value = real(rid)
            value['untrusted_note'] = 'x' * MAX_RESPONSE_BYTES
            return value
        with patch.object(self.service, 'catalog', side_effect=oversized):
            self.expect_error('response_limit', 'catalog', self.args())

    def test_reads_do_not_change_files_or_call_status_collect_derive_submit(self):
        before = {p.name: (p.stat().st_mtime_ns, p.read_bytes()) for p in self.folder.iterdir()}
        with patch('subprocess.Popen', side_effect=AssertionError('No process on waveform GET')):
            self.api.read('catalog', self.args())
            self.api.read('mapping', self.args())
            self.api.read('window', self.args(signal_ids=self.signals()))
            self.api.describe(INTAKE, RUN)
        after = {p.name: (p.stat().st_mtime_ns, p.read_bytes()) for p in self.folder.iterdir()}
        self.assertEqual(before, after)
        for method in ('status', 'collect', 'dispatch', 'save'):
            getattr(self.runner, method).assert_not_called()


if __name__ == '__main__':
    unittest.main()
