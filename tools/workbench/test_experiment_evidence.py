"""Independent synthetic native-archive review; no SSH, solver or model files."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from experiment_workflow import ExperimentWorkflow
from runner import atomic, filehash, record_digest
from simulation_runtime import SimulationRuntime

try:
    from spiceowl.experiments import prepare_experiment
except ImportError:
    prepare_experiment = None

COMMIT = 'a' * 40
PLAN = 'b' * 64
MODEL_HASH = 'c' * 64
MODEL_PATH = '/synthetic/models/toy.scs'
TERMINAL_STATE = 'simulator_complete_pending_measurements'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def prepared_fixture():
    source = b'simulator lang=spectre\nsubckt Toy IN OUT HI LO\nR0 (IN OUT) resistor r=1000\nends Toy\n'
    specification = {
        'schema': 'spiceowl.experiment-spec.v1', 'recipe': 'prepared-transient',
        'roles': {'inputs': ['IN'], 'outputs': ['OUT'], 'vdd': 'HI', 'vss': 'LO'},
        'supply': {'positive_v': 1.0, 'negative_v': 0.0}, 'temperature_k': 300.15,
        'nominal_temperature_k': 300.15, 'corner': 'TT', 'parameters': {},
        'stimuli': [{'port': 'IN', 'type': 'dc', 'value_v': 0.5}], 'loads': [],
        'analysis': {'stop_s': 2e-9, 'max_step_s': 1e-9, 'strobe_period_s': 1e-9},
        'acceptance': {'required_units': {'time': 's', 'IN': 'V', 'OUT': 'V', 'HI': 'V', 'LO': 'V'},
                       'sample_count': 3, 'coverage': {'start_s': 0.0, 'end_s': 2e-9, 'tolerance_s': 1e-18},
                       'max_sample_gap_s': 1.001e-9, 'voltage_bounds_v': [-0.05, 1.05],
                       'supply_tolerance_v': 1e-6,
                       'windows': [{'signal': 'OUT', 'start_s': 0.0, 'end_s': 2e-9,
                                    'minimum_samples': 3, 'min_v': 0.4, 'max_v': 0.6}]} }
    profile = {'schema': 'spiceowl.experiment-model-profile.v1', 'id': 'synthetic_evidence',
               'models': {}, 'corners': {'TT': [{'alias': 'PDK_MAIN', 'section': 'typical'}]}}
    result = prepare_experiment({'toy.scs': source},
        {'mode': 'cell', 'source_id': 'toy.scs', 'subcircuit': 'Toy'}, specification, profile)
    if result['status'] != 'ready':
        raise AssertionError(result)
    return result


def psf_fixture():
    lines = ['HEADER', '"PSF sweep points" 3', 'TYPE',
             '"seconds" FLOAT DOUBLE PROP("units" "s")',
             '"volts" FLOAT DOUBLE PROP("units" "V")',
             'SWEEP', '"time" "seconds"', 'TRACE']
    lines += ['"' + signal + '" "volts"' for signal in ['IN', 'OUT', 'HI', 'LO']]
    lines.append('VALUE')
    for at in [0.0, 1e-9, 2e-9]:
        lines += ['"time" ' + format(at, '.17g'), '"IN" 0.5', '"OUT" 0.5', '"HI" 1', '"LO" 0']
    return ('\n'.join(lines + ['END']) + '\n').encode()


@unittest.skipIf(prepare_experiment is None, 'Requires the pinned SpiceOwl experiment package')
class ExperimentNativeEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        prepared = prepared_fixture()
        self.site = {'schema': 'ic.sim.site.v1', 'ssh_target': 'synthetic-node',
            'remote_runs_root': '/synthetic/ic_on_github_runs', 'cadence_cshrc': '/synthetic/tools/setup.csh',
            'spectre_bin': '/synthetic/tools/spectre', 'external_files': {'PDK_MAIN': MODEL_PATH},
            'expected_host': 'synthetic-node', 'expected_user': 'synthetic-user'}
        self.bundle = self.root / 'bundle.json'
        self.bundle.write_text(json.dumps({'schema': 'ic.sim.bundle.v1', 'source_root': '.',
            'entrypoint': 'netlist/input.scs', 'external_sha256': {'PDK_MAIN': MODEL_HASH},
            'files': [{'source': name, 'destination': name, 'sha256': sha(raw)}
                      for name, raw in prepared['files'].items()]}))
        self.payload = {name: raw.replace(b'@EXTERNAL_PDK_MAIN@', MODEL_PATH.encode())
                        for name, raw in prepared['files'].items()}
        provenance = {'source_commit': COMMIT, 'source_clean': True, 'source_root': str(self.root),
                      'bundle_sha256': filehash(self.bundle), 'runner_sha256': 'd' * 64,
                      'site_config_sha256': sha(json.dumps(self.site, sort_keys=True).encode()),
                      'files': [{'source': str(self.root / name), 'destination': name,
                                 'source_sha256': sha(prepared['files'][name]), 'staged_sha256': sha(raw)}
                                for name, raw in self.payload.items()]}
        context = {'schema': 'ic.execution.context.v1', 'plan_id': 'e' * 64, 'site': self.site,
                   'resource_selection': {'host_id': 'synthetic-node'}}
        self.record = {'schema': 'ic.sim.run.v2', 'run_id': 'synthetic-run-1', 'job_id': 'synthetic-run-1',
            'project_id': 'toy', 'configuration_id': 'toy-tran',
            'source_commit': COMMIT, 'state': TERMINAL_STATE, 'remote_state': TERMINAL_STATE,
            'simulator_exit_code': 0, 'remote_directory': '/synthetic/ic_on_github_runs/synthetic-run-1',
            'ssh_target': 'synthetic-node', 'execution_site': self.site,
            'execution_site_sha256': record_digest(self.site), 'execution_context': context,
            'execution_context_sha256': record_digest(context), 'launch_attempts': 1,
            'experiment': {'plan_id': PLAN, 'manifest_sha256': sha(json.dumps(prepared['recipe'], sort_keys=True, separators=(',', ':')).encode())},
            'plan': {'schema': 'ic.sim.plan.v2', 'provenance': provenance,
                     'external_sha256': {'PDK_MAIN': MODEL_HASH}}, 'collection': None}
        self.data = {'identity': {'project_id': 'toy', 'configuration': 'toy-tran', 'source_commit': COMMIT},
                     'bundle_path': str(self.bundle), 'bundle_sha256': filehash(self.bundle),
                     'recipe': prepared['recipe'], 'qualification_scope': None,
                     'dependency_audit': {'schema': 'spiceowl.model-dependency-audit.v1',
                         'files': [{'path': MODEL_PATH, 'sha256': MODEL_HASH, 'roles': ['model']}],
                         'directories': []}}
        self.native = copy.deepcopy(self.record)
        self.native['state'] = 'preflight'
        self.runner = Mock()
        self.runner.path.side_effect = lambda rid: self.root / 'runs' / rid
        self.runner.execution_site.return_value = copy.deepcopy(self.site)
        self.app = types.SimpleNamespace(cfg={'runtime_root': str(self.root / 'runtime')},
            workspace=types.SimpleNamespace(key=b'x' * 32), runner=self.runner)
        self.runtime = SimulationRuntime(self.app)
        self.workflow = ExperimentWorkflow(self.runtime)
        self.workflow.plan = Mock(return_value=self.data)
        patcher = patch('experiment_workflow.core.ssh', side_effect=AssertionError('No remote operations'))
        patcher.start(); self.addCleanup(patcher.stop)
        self.files = {**self.payload, 'run.json': json.dumps(self.native).encode(),
                      'state': (TERMINAL_STATE + '\n').encode(), 'exit_code': b'0\n',
                      'external.sha256': (MODEL_HASH + '  ' + MODEL_PATH + '\n').encode(),
                      'external-checksums.log': (MODEL_PATH + ': OK\n').encode(),
                      'psf/spectre.out': ('Reading file: ' + MODEL_PATH + '\n'
                          'spectre completes with 0 errors, 0 warnings, and 0 notices.\n').encode(),
                      'psf/toy.tran': psf_fixture()}

    def archive(self, changes=None, *, omit=(), duplicate=None):
        files = {**self.files, **(changes or {})}
        for name in omit:
            files.pop(name)
        path = self.root / 'native.tar.gz'
        with tarfile.open(path, 'w:gz') as stream:
            rows = list(files.items())
            if duplicate:
                rows.append((duplicate, files[duplicate]))
            for name, raw in rows:
                item = tarfile.TarInfo('./' + name); item.size = len(raw)
                stream.addfile(item, io.BytesIO(raw))
        self.record['collection'] = {'archive': str(path), 'sha256': filehash(path)}
        self.record['collection_phase'] = 'complete'
        return copy.deepcopy(self.record)

    def test_correct_native_binding_uses_real_measurement_and_report(self):
        result = self.workflow.validate_result(self.archive())
        self.assertEqual(result['run_id'], self.record['run_id'])
        self.assertEqual(result['measurements']['data_validity'], 'valid')
        self.assertEqual(result['report']['functional_performance']['status'], 'pass')
        self.assertEqual(result['report']['dependency_provenance']['status'], 'verified_within_scope')

    def test_missing_or_foreign_native_identity_must_be_rejected(self):
        with self.assertRaises(ValueError):
            self.workflow.validate_result(self.archive(omit=['run.json']))
        for field, value in [('schema', 'unrecognized'), ('run_id', 'another-run'), ('job_id', 'another-run'),
                             ('source_commit', 'f' * 40),
                             ('project_id', 'other'), ('configuration_id', 'other-tran'),
                             ('remote_directory', '/synthetic/ic_on_github_runs/another-run')]:
            native = copy.deepcopy(self.native); native[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.workflow.validate_result(self.archive({'run.json': json.dumps(native).encode()}))

    def test_native_execution_status_and_plan_must_agree_with_local_receipt(self):
        for name, raw in [('state', b'simulator_failed\n'), ('exit_code', b'9\n')]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.workflow.validate_result(self.archive({name: raw}))
        native = copy.deepcopy(self.native)
        native['plan']['provenance']['bundle_sha256'] = 'f' * 64
        with self.assertRaises(ValueError):
            self.workflow.validate_result(self.archive({'run.json': json.dumps(native).encode()}))

    def test_checksum_success_requires_exact_lines_without_conflicting_failures(self):
        for text in ['/decoy' + MODEL_PATH + ': OK\n',
                     'arbitrary prefix ' + MODEL_PATH + ': OK\n',
                     MODEL_PATH + ': FAILED\n/decoy' + MODEL_PATH + ': OK\n',
                     MODEL_PATH + ': OK\n' + MODEL_PATH + ': FAILED\n']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.workflow.validate_result(self.archive({'external-checksums.log': text.encode()}))

    def test_duplicate_external_manifest_path_with_conflicting_digest_is_rejected(self):
        wrong = self.files['external.sha256'] + ('f' * 64 + '  ' + MODEL_PATH + '\n').encode()
        with self.assertRaises(ValueError):
            self.workflow.validate_result(self.archive({'external.sha256': wrong}))

    def test_archive_and_input_bytes_must_match_their_frozen_digests(self):
        record = self.archive()
        with Path(record['collection']['archive']).open('ab') as stream:
            stream.write(b'synthetic archive mutation')
        with self.assertRaises(ValueError):
            self.workflow.validate_result(record)
        with self.assertRaises(ValueError):
            self.workflow.validate_result(self.archive({'netlist/input.scs': b'// changed input\n'}))

    def test_duplicate_native_artifact_names_are_rejected(self):
        for name in ['run.json', 'psf/toy.tran', 'external-checksums.log']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.workflow.validate_result(self.archive(duplicate=name))

    def test_saved_report_requires_matching_completed_inspection_receipt(self):
        record = self.archive(); result = self.workflow.validate_result(record)
        folder = self.runner.path(record['run_id'])
        report_path = folder / 'simulation-report.json'
        document = {'run_id': record['run_id'], 'source_commit': COMMIT,
                    'native_archive_sha256': record['collection']['sha256'], 'report': result['report']}
        atomic(report_path, document)
        self.assertIsNone(self.runtime.saved_report(record))
        atomic(folder / 'experiment-result.json', result)
        atomic(folder / 'experiment-inspection.json', {'state': 'complete', 'run_id': record['run_id'],
            'report_sha256': filehash(report_path), 'result_sha256': filehash(folder / 'experiment-result.json')})
        self.assertEqual(self.runtime.saved_report(record), result['report'])
        document['report']['operating_qualification']['status'] = 'passed_within_scope'
        atomic(report_path, document)
        self.assertIsNone(self.runtime.saved_report(record))


if __name__ == '__main__':
    unittest.main()
