"""Fresh intake integration with newly authored models and mocked remote seams.

No historical profile, real server, solver, credential or live model is read.
Local Git is permitted only beneath each fixture's new temporary directory.
"""
import contextlib
import concurrent.futures
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import onboarding_runtime
import experiment_workflow
import runner
import server
from workspace import Conflict

try:
    from spiceowl.onboarding.pdk_discovery import build_pdk_discovery_script
except ImportError:
    build_pdk_discovery_script = None


HOST = 'synthetic-new-host'
SOURCE = ('simulator lang=spectre\n'
          'A (OUT IN LO LO) device_alpha w=2u l=200n nf=1 multi=1\n'
          'B (OUT IN HI HI) device_beta w=3u l=200n nf=1 multi=1\n')
MODEL = ('simulator lang=spectre\nsection typical\n'
         'model core_n bsim4 type=n\nmodel core_p bsim4 type=p\n'
         'subckt device_alpha d g s b\nM0 (d g s b) core_n\nends device_alpha\n'
         'subckt device_beta d g s b\nM0 (d g s b) core_p\nends device_beta\n'
         'endsection typical\n')
SECRET = 'SYNTHETIC_PRIVATE_LICENSE_DO_NOT_PROJECT'


def explicit_intent():
    return {'supply_v': 1.0, 'frequency_hz': 1e9, 'temperature_c': 27,
        'nominal_temperature_c': 27, 'input_port': 'IN', 'output_port': 'OUT',
        'vdd_port': 'HI', 'vss_port': 'LO', 'cycles': 2, 'load_f': 1e-15,
        'rise_s': 1e-11, 'fall_s': 1e-11, 'points_per_period': 100}


class DeferredExecutor:
    def __init__(self):
        self.calls = []

    def submit(self, fn, *args):
        future = concurrent.futures.Future()
        self.calls.append((fn, args, future))
        return future

    def shutdown(self, wait=True):
        # No thread was started; cancel pending fixture callbacks at teardown.
        for _, _, future in self.calls:
            future.cancel()


class _IntakeFixture(unittest.TestCase):
    def patch(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'fresh-user'
        (self.home / '.ssh').mkdir(parents=True)
        (self.home / '.ssh/config').write_text('Host ' + HOST + '\n  HostName fixture.invalid\n')
        self.patch(patch('pathlib.Path.home', return_value=self.home))
        self.old = self.root / 'synthetic-historical-store'
        self.old.mkdir()
        (self.old / 'profile.json').write_text(SECRET)
        original_open = Path.open
        def without_history(path, *args, **kwargs):
            if Path(path).absolute().is_relative_to(self.old):
                raise AssertionError('Onboarding must not read historical fixture storage')
            return original_open(path, *args, **kwargs)
        self.patch(patch('pathlib.Path.open', autospec=True, side_effect=without_history))
        execute = subprocess.run
        def only_fixture_git(argv, *args, **kwargs):
            if not isinstance(argv, list) or argv[0] != 'git':
                raise AssertionError('Only synthetic local Git is allowed, never an external command')
            cwd = kwargs.get('cwd')
            if '-C' in argv:
                cwd = argv[argv.index('-C') + 1]
            if len(argv) > 1 and argv[1] == 'clone':
                if any(not Path(p).is_absolute() or not Path(p).resolve().is_relative_to(self.root) for p in argv[-2:]):
                    raise AssertionError('Clone endpoints must be newly authored local fixture directories')
            elif cwd is None or not Path(cwd).resolve().is_relative_to(self.root):
                raise AssertionError('Git must remain in this new temporary fixture')
            if any(action in argv for action in ('push', 'fetch', 'pull', 'ls-remote')):
                raise AssertionError('Fixture Git may not contact a remote')
            return execute(argv, *args, **kwargs)
        self.process = self.patch(patch.object(subprocess, 'run', side_effect=only_fixture_git))
        self.ssh = self.patch(patch.object(runner.core, 'ssh', side_effect=AssertionError('No real SSH')))
        self.doctor = self.patch(patch.object(runner.core, 'doctor', side_effect=AssertionError('No implicit preflight')))
        with patch('onboarding_runtime.Path.home', return_value=self.home):
            self.cfg = onboarding_runtime.create_onboarding_config(self.root / 'fresh')
        self.app = server.Application(self.cfg, self.root / 'synthetic-web')
        self.addCleanup(self.close_app)
        self.runtime = self.app.onboarding
        self.models = self.root / 'new-synthetic-models'
        self.models.mkdir()
        self.model_file = self.models / 'entry.scs'
        self.model_file.write_text(MODEL)
        self.capture = {
            'public': {'schema': 'spiceowl.server-environment.v1', 'alias': HOST,
                'state': 'observed', 'transport': 'reachable',
                'identity': {'observed': True, 'verified': False},
                'tools': [{'kind': 'spectre', 'configured': True, 'usable': 'unknown'}],
                'licenses': [{'name': 'CDS_LIC_FILE', 'configured': True, 'usable': 'unknown'}]},
            'private': {'schema': 'spiceowl.server-environment.private.v1', 'probe_kind': 'python',
                'identity': {'hostname': HOST, 'username': 'synthetic-user', 'home': '/synthetic/home'},
                'path': ['/synthetic/tools'], 'environment': [],
                'tools': [{'kind': 'spectre', 'path': '/synthetic/tools/spectre', 'version': None},
                          {'kind': 'python', 'path': '/synthetic/tools/python3', 'version': '3.11'}],
                'licenses': [{'name': 'CDS_LIC_FILE', 'configured': True, 'value': SECRET}],
                'scripts': [], 'setup_candidates': [{'source_id': '1'*16, 'path': '/synthetic/tools/setup.csh',
                    'sha256': 'c'*64, 'shell_kind': 'csh', 'executed_by_probe': True}],
                'activation': {'selected_source_id': '1'*16},
                'pdk_candidates': [{'path': str(self.models), 'exists': True}],
                'resources': {'cpu_count': 4, 'memory_available_bytes': 8 * 1024**3}}}
        self.capture_call = self.patch(patch('spiceowl.onboarding.environment.capture_server_environment',
            side_effect=lambda *_: copy.deepcopy(self.capture)))

    def close_app(self):
        self.app.onboarding.close()
        self.app.simulation.close()
        self.app.pool.shutdown(wait=True)

    def new_source(self, source=SOURCE):
        return self.runtime.write('netlist', {'file_name': 'user-input.scs', 'text': source}, origin='test_harness')

    def probe(self, state, targets=None):
        return self.runtime.write('probe', {'intake_id': state['intake_id'], 'revision': state['revision'],
            'ssh_targets': targets or [HOST]}, origin='test_harness')

    def synthetic_discovery(self, requirements):
        program = build_pdk_discovery_script(required_masters=requirements['required_masters'],
            roots=[str(self.models)], source_sha256=requirements['source_sha256'])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exec(program, {})
        result = json.loads("\n".join(line for line in output.getvalue().splitlines() if not line.startswith("SPICEOWL_DISCOVERY_DIRECTORY_SNAPSHOT ")))
        self.assertTrue(result['entry_candidates'], result)
        return result

    def discover(self, state=None, **extra):
        state = state or self.probe(self.new_source())
        evidence = self.synthetic_discovery(state['source']['requirements'])
        with patch('onboarding_discovery.remote_discovery', return_value=evidence) as remote:
            result = self.runtime.write('discover-pdk', {'intake_id': state['intake_id'],
                'revision': state['revision'], 'probe_ids': [p['probe_id'] for p in state['probes']],
                **extra}, origin='test_harness')
        self.discovery_evidence = evidence
        self.discovery_call = remote
        return result

    def prepare_args(self, state):
        candidates = [c for c in state['discovery']['candidates'] if c['section_candidates'] == ['typical']]
        self.assertEqual(len(candidates), 1, state['discovery'])
        return {'intake_id': state['intake_id'], 'revision': state['revision'],
            'discovery_id': state['discovery']['discovery_id'], 'candidate_id': candidates[0]['candidate_id'],
            'sections': ['typical'], 'tmi_candidate_id': None, 'model_contracts': {}, 'intent': explicit_intent()}

    def local_audit(self, site, config, python):
        from spiceowl.integrations.model_dependencies import build_model_audit_script
        self.assertEqual(config['roots'], [str(self.models)])
        self.assertEqual(config['main'], str(self.model_file))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exec(build_model_audit_script(config), {})
        return json.loads("\n".join(line for line in output.getvalue().splitlines() if not line.startswith("SPICEOWL_DISCOVERY_DIRECTORY_SNAPSHOT ")))

    def prepare(self, state=None, **changes):
        state = state or self.discover()
        args = {**self.prepare_args(state), **changes}
        with patch.object(experiment_workflow.ExperimentWorkflow, '_audit', side_effect=self.local_audit) as audit:
            prepared = self.runtime.write('prepare', args, origin='test_harness')
        self.audit_call = audit
        return prepared

    def child_for(self, prepared):
        state = self.runtime._load(prepared['intake_id'])
        plan = self.runtime._plan_row(state, prepared['prepared']['plan_id'])
        return self.runtime._child(state, plan)

    def enable_reservation(self, prepared):
        child = self.child_for(prepared)
        child.pool.shutdown(wait=True)
        child.pool = DeferredExecutor()
        self.executor = child.pool
        self.reserve = self.patch(patch.object(child.runner, 'reserve', wraps=child.runner.reserve))
        self.dispatch = self.patch(patch.object(child.runner, 'dispatch', side_effect=AssertionError('Dispatch is deliberately deferred')))
        self.doctor.side_effect = None
        self.doctor.return_value = {'exit_code': 0, 'identity_ok': True, 'all_references_readable': True,
            'all_tools_available': True, 'dependency_sha256': {'PDK_MAIN': hashlib.sha256(MODEL.encode()).hexdigest(),
                'cadence_setup': 'c'*64, 'spectre': 'd'*64}}
        pool = Mock()
        self.selected_pool = pool
        pool.members = {HOST: {}}
        pool.prepare.return_value = {'execution_plan_id': 'e'*64}
        def selected_pool(plan_id, data):
            pool.resolve.return_value = {'schema': 'ic.execution.context.v1', 'plan_id': 'e'*64,
                'site': data['sites'][HOST], 'resource_selection': {'host_id': HOST}}
            return pool
        self.pool_call = self.patch(patch.object(experiment_workflow.ExperimentWorkflow, '_pool', side_effect=selected_pool))
        return child

    def submit_intake(self, prepared):
        return self.runtime.write('run', {'intake_id': prepared['intake_id'], 'revision': prepared['revision'],
            'plan_id': prepared['prepared']['plan_id']}, origin='test_harness')


@unittest.skipIf(build_pdk_discovery_script is None, 'Requires paired SpiceOwl discovery')
class OnboardingDiscoveryIntegrationTests(_IntakeFixture):
    def test_discovery_is_bound_to_current_source_and_explicit_probe(self):
        state = self.probe(self.new_source())
        result = self.discover(state)
        self.assertEqual(result['state'], 'models_discovered')
        self.assertEqual(result['revision'], state['revision'] + 1)
        self.discovery_call.assert_called_once_with(HOST, self.cfg['onboarding']['ssh_config'],
            self.capture, state['source']['requirements'], None, None)
        self.assertFalse(result['discovery']['selection_made'])
        self.assertFalse(result['discovery']['simulation_started'])
        self.assertTrue(result['discovery']['candidates'])
        self.assertTrue(all(not c['ready_to_run'] for c in result['discovery']['candidates']))
        self.assertIsNone(result['source_commit'])
        self.assertFalse(self.app.workspace.root.exists())
        self.process.assert_not_called()
        self.ssh.assert_not_called()
        self.doctor.assert_not_called()
        self.assertNotIn(str(self.models), json.dumps(result))
        self.assertNotIn(SECRET, json.dumps(result))

    def test_cross_intake_or_replaced_probe_is_rejected_before_discovery(self):
        first = self.probe(self.new_source())
        second = self.probe(self.new_source())
        with patch('onboarding_discovery.remote_discovery') as remote:
            with self.assertRaises(ValueError):
                self.runtime.write('discover-pdk', {'intake_id': second['intake_id'],
                    'revision': second['revision'], 'probe_ids': [first['probes'][0]['probe_id']]},
                    origin='test_harness')
            remote.assert_not_called()
        replaced = self.probe(first)
        with patch('onboarding_discovery.remote_discovery') as remote:
            with self.assertRaises(ValueError):
                self.runtime.write('discover-pdk', {'intake_id': replaced['intake_id'],
                    'revision': replaced['revision'], 'probe_ids': [first['probes'][0]['probe_id']]},
                    origin='test_harness')
            remote.assert_not_called()

    def test_stale_discovery_does_not_issue_another_remote_observation(self):
        state = self.probe(self.new_source())
        self.discover(state)
        with patch('onboarding_discovery.remote_discovery') as remote:
            with self.assertRaises(Conflict):
                self.runtime.write('discover-pdk', {'intake_id': state['intake_id'],
                    'revision': state['revision'], 'probe_ids': [state['probes'][0]['probe_id']]},
                    origin='test_harness')
            remote.assert_not_called()

    def test_discovery_failure_is_bounded_and_keeps_startup_details_private(self):
        state = self.probe(self.new_source())
        with patch('onboarding_discovery.remote_discovery', side_effect=ValueError(SECRET + str(self.models))):
            result = self.runtime.write('discover-pdk', {'intake_id': state['intake_id'],
                'revision': state['revision'], 'probe_ids': [state['probes'][0]['probe_id']]},
                origin='test_harness')
        self.assertFalse(result['discovery']['simulation_started'])
        self.assertFalse(result['discovery']['selection_made'])
        self.assertEqual(result['discovery']['candidates'], [])
        self.assertIn('pdk_discovery_incomplete', {row['code'] for row in result['discovery']['missing']})
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertNotIn(str(self.models), json.dumps(result))
        self.ssh.assert_not_called()

    def test_explicit_hints_are_passed_only_to_the_selected_probe(self):
        state = self.probe(self.new_source())
        self.discover(state, search_paths=['/synthetic/requested-pdk'], cds_lib_hint='/synthetic/requested/cds.lib')
        self.assertEqual(self.discovery_call.call_args.args[4:],
            (['/synthetic/requested-pdk'], '/synthetic/requested/cds.lib'))

    def test_identical_model_candidates_on_two_probes_keep_distinct_selection_ids(self):
        state = self.probe(self.new_source(), targets=[HOST, 'synthetic-second-alias'])
        result = self.discover(state)
        candidates = result['discovery']['candidates']
        self.assertEqual(len(candidates), 2)
        self.assertEqual(len({c['candidate_id'] for c in candidates}), 2)
        self.assertEqual({c['probe_id'] for c in candidates}, {p['probe_id'] for p in state['probes']})
        self.assertFalse(result['discovery']['selection_made'])

    def test_late_discovery_reply_cannot_overwrite_a_newer_probe_revision(self):
        state = self.probe(self.new_source())
        evidence = self.synthetic_discovery(state['source']['requirements'])
        def another_revision(*args,**kwargs):
            current = self.runtime.read('session', {'intake_id': state['intake_id']})
            self.runtime._begin({'intake_id': current['intake_id'], 'revision': current['revision']}, 'probe')
            return evidence
        with patch('onboarding_discovery.remote_discovery', side_effect=another_revision):
            with self.assertRaises(Conflict):
                self.runtime.write('discover-pdk', {'intake_id': state['intake_id'],
                    'revision': state['revision'], 'probe_ids': [state['probes'][0]['probe_id']]},
                    origin='test_harness')
        current = self.runtime.read('session', {'intake_id': state['intake_id']})
        self.assertEqual(current['revision'], state['revision'] + 2)
        self.assertNotIn('discovery', current)


@unittest.skipIf(build_pdk_discovery_script is None, 'Requires paired SpiceOwl discovery')
class OnboardingPreparedIntegrationTests(_IntakeFixture):
    def test_prepare_freezes_only_supplied_source_and_current_discovery(self):
        state = self.discover()
        prepared = self.prepare(state)
        self.assertEqual(prepared['state'], 'prepared', prepared.get('prepared'))
        self.assertEqual(len(prepared['source_commit']), 40)
        self.assertEqual(prepared['prepared']['source_commit'], prepared['source_commit'])
        self.assertEqual(prepared['source_mapping']['original_source_sha256'], hashlib.sha256(SOURCE.encode()).hexdigest())
        self.assertEqual(prepared['prepared']['submission_key'], 'experiment-' + prepared['prepared']['plan_id'])
        child = self.child_for(prepared)
        self.assertTrue(child.workspace.local_only)
        self.assertTrue(child.workspace.root.is_relative_to(self.runtime._folder(state['intake_id'])))
        self.assertEqual(child.workspace.head(), prepared['source_commit'])
        self.assertEqual(child.workspace.projects.keys(), {state['intake_id']})
        self.assertEqual(child.runner.list(), [])
        self.audit_call.assert_called_once()
        self.ssh.assert_not_called()
        self.doctor.assert_not_called()
        self.assertNotIn(str(self.root), json.dumps(prepared))
        self.assertNotIn(SECRET, json.dumps(prepared))

    def test_persisted_crlf_source_keeps_original_bytes_through_real_preparation(self):
        source = SOURCE.replace('\n', '\r\n')
        original = source.encode('utf-8')
        imported = self.new_source(source)
        folder = self.runtime._folder(imported['intake_id'])
        self.assertEqual((folder / 'source.scs').read_bytes(), original)
        discovered = self.discover(self.probe(imported))
        prepared = self.prepare(discovered)
        self.assertEqual(prepared['state'], 'prepared', prepared.get('prepared'))
        mapping = prepared['source_mapping']
        self.assertEqual(mapping['original_source_sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(prepared['source_sha256'], imported['source_sha256'])
        expected, cursor = bytearray(), 0
        for insertion in mapping['wrapper']['insertions']:
            offset = insertion['original_byte_offset']
            expected += original[cursor:offset]
            expected += insertion['text'].encode('utf-8')
            cursor = offset
        expected += original[cursor:]
        child = self.child_for(prepared)
        compiled = (child.workspace.root / mapping['source_id']).read_bytes()
        self.assertEqual(compiled, bytes(expected))
        self.assertEqual(hashlib.sha256(compiled).hexdigest(), mapping['compiled_source_sha256'])
        self.assertEqual((folder / 'source.scs').read_bytes(), original)
        self.ssh.assert_not_called()
        self.doctor.assert_not_called()

    def test_other_discovery_or_tampered_original_source_cannot_prepare_a_child(self):
        state = self.discover()
        with patch('onboarding_prepare.create_child_config') as create:
            with self.assertRaises(Conflict):
                self.prepare(state, discovery_id='discovery_' + 'f'*32)
            create.assert_not_called()
        source = self.runtime._folder(state['intake_id']) / 'source.scs'
        source.write_text(SOURCE.replace('2u', '20u'))
        with patch('onboarding_prepare.create_child_config') as create:
            result = self.prepare(state)
            self.assertEqual(result['state'], 'needs_input')
            self.assertIn('source_requirements_mismatch', {m['code'] for m in result['prepared']['missing']})
            self.assertIsNone(result['prepared']['plan_id'])
            create.assert_not_called()
        self.audit_call.assert_not_called()
        self.process.assert_not_called()

    def test_discovery_outer_source_binding_cannot_be_changed_before_prepare(self):
        state = self.discover()
        path = self.runtime._folder(state['intake_id']) / 'discoveries' / (state['discovery']['discovery_id'] + '.json')
        evidence = json.loads(path.read_text())
        evidence['source_sha256'] = 'f'*64
        runner.atomic(path, evidence)
        with patch('onboarding_prepare.create_child_config') as create:
            with self.assertRaisesRegex(ValueError, 'source digest'):
                self.prepare(state)
            create.assert_not_called()
        self.process.assert_not_called()

    def test_inner_candidate_receipt_must_also_belong_to_the_intake_source(self):
        from onboarding_discovery import digest
        state = self.discover()
        path = self.runtime._folder(state['intake_id']) / 'discoveries' / (state['discovery']['discovery_id'] + '.json')
        evidence = json.loads(path.read_text())
        candidate_receipt = evidence['rows'][0]['result']
        candidate_receipt['source_sha256'] = 'f'*64
        candidate_receipt['discovery_id'] = digest({k: v for k, v in candidate_receipt.items() if k != 'discovery_id'})
        runner.atomic(path, evidence)
        with patch('onboarding_prepare.create_child_config') as create:
            with self.assertRaisesRegex(ValueError, 'different source'):
                self.prepare(state)
            create.assert_not_called()
        self.process.assert_not_called()

    def test_run_and_inspect_keep_full_session_and_one_original_queued_job(self):
        prepared = self.prepare()
        child = self.enable_reservation(prepared)
        submitted = self.submit_intake(prepared)
        job = submitted['job']
        self.assertEqual(submitted['intake_id'], prepared['intake_id'])
        self.assertEqual(submitted['schema'], onboarding_runtime.SCHEMA)
        self.assertEqual(submitted['state'], 'submitted')
        self.assertEqual(job['state'], 'queued')
        self.assertEqual(job['source_commit'], prepared['source_commit'])
        self.assertEqual(job['launch_attempts'], 0)
        repeated = self.submit_intake(prepared)
        self.assertEqual(repeated['job']['job_id'], job['job_id'])
        inspected = self.runtime.write('inspect', {'intake_id': prepared['intake_id'],
            'job_id': job['job_id']}, origin='test_harness')
        self.assertEqual(inspected['schema'], onboarding_runtime.SCHEMA)
        self.assertEqual(inspected['job']['job_id'], job['job_id'])
        self.assertEqual(inspected['job']['inspection_state'], 'working')
        self.assertEqual(child.runner.lookup_submission(prepared['prepared']['submission_key']), job['job_id'])
        self.reserve.assert_called_once()
        self.dispatch.assert_not_called()
        self.assertEqual(len(self.executor.calls), 1)
        self.ssh.assert_not_called()

    def test_lost_reply_after_reservation_reconciles_without_another_runner_call(self):
        prepared = self.prepare()
        child = self.enable_reservation(prepared)
        control = child.simulation.control
        def lose_reply(operation, *args):
            result = control(operation, *args)
            if operation == 'run':
                raise TimeoutError('Synthetic response lost after reservation')
            return result
        with patch.object(child.simulation, 'control', side_effect=lose_reply) as call:
            with self.assertRaises(TimeoutError):
                self.submit_intake(prepared)
            state = self.runtime.read('session', {'intake_id': prepared['intake_id']})
            self.assertEqual(state['state'], 'submission_uncertain')
            receipt = self.runtime.read('submission', {'intake_id': prepared['intake_id'],
                'plan_id': prepared['prepared']['plan_id']})
            self.assertTrue(receipt['found'])
            self.assertFalse(receipt['replay_permitted'])
            repeated = self.submit_intake(prepared)
            self.assertEqual(repeated['job']['job_id'], receipt['run_id'])
            call.assert_called_once()
        self.reserve.assert_called_once()
        self.dispatch.assert_not_called()
        self.assertEqual(len(self.executor.calls), 1)
        self.ssh.assert_not_called()

    def test_lost_current_run_reply_lookup_persists_job_and_submitted_state_for_later_session_reads(self):
        prepared = self.prepare()
        child = self.enable_reservation(prepared)
        original_control = child.simulation.control
        def reserved_then_lost(operation, *args):
            original_control(operation, *args)
            raise TimeoutError('Synthetic POST response lost after durable reservation')
        with patch.object(child.simulation, 'control', side_effect=reserved_then_lost) as control:
            with self.assertRaises(TimeoutError):
                self.submit_intake(prepared)
            unresolved = self.runtime.read('session', {'intake_id': prepared['intake_id']})
            self.assertEqual(unresolved['state'], 'submission_uncertain')
            self.assertNotIn('job', unresolved)
            receipt = self.runtime.read('submission', {'intake_id': prepared['intake_id'],
                'plan_id': prepared['prepared']['plan_id']})
            self.assertTrue(receipt['found'])
            recovered = self.runtime.read('session', {'intake_id': prepared['intake_id']})
            self.assertEqual(recovered['state'], 'submitted')
            self.assertEqual(recovered['job'], receipt['job'])
            self.assertEqual(recovered['job']['job_id'], receipt['run_id'])
            self.assertEqual(recovered['prepared']['plan_id'], receipt['plan_id'])
            for _ in range(2):
                self.assertEqual(self.runtime.read('session', {'intake_id': prepared['intake_id']}), recovered)
            control.assert_called_once()
        self.reserve.assert_called_once()
        self.dispatch.assert_not_called()
        self.assertEqual(len(self.executor.calls), 1)

    def test_historical_inspect_conflicts_without_touching_current_plan_but_original_saved_waveforms_remain_readable(self):
        plan_a = self.prepare()
        child_a = self.enable_reservation(plan_a)
        submitted_a = self.submit_intake(plan_a)
        job_a = submitted_a['job']['job_id']
        # Explicit synthetic saved exports exercise the actual read-only service;
        # these fixture bytes are not evidence of a simulator invocation.
        record = child_a.runner.read(job_a)
        record['collection'] = {'sha256': hashlib.sha256(b'synthetic original archive').hexdigest()}
        child_a.runner.save(record)
        folder_a = child_a.runner.path(job_a)
        csv = b'out X,out Y,in Y\n0,1,0\n1e-9,0,1\n'
        csv_hash = hashlib.sha256(csv).hexdigest()
        (folder_a / 'waveforms.csv').write_bytes(csv)
        runner.atomic(folder_a / 'waveforms.json', {'run_id': job_a, 'source_commit': plan_a['source_commit'],
            'csv_sha256': csv_hash, 'csv_samples': 2, 'waveforms': [
                {'name': 'out', 'time_unit': 's', 'unit': 'V'}, {'name': 'in', 'time_unit': 's', 'unit': 'V'}]})
        runner.atomic(folder_a / 'archive-files.json', [
            {'path': './export/waveforms.csv', 'sha256': csv_hash, 'bytes': len(csv)},
            {'path': './psf/synthetic.tran', 'sha256': hashlib.sha256(b'synthetic').hexdigest(), 'bytes': 9}])
        intent_b = explicit_intent(); intent_b['load_f'] = 2e-15
        plan_b = self.prepare(submitted_a, intent=intent_b)
        self.assertNotEqual(plan_a['prepared']['plan_id'], plan_b['prepared']['plan_id'])
        child_b = self.enable_reservation(plan_b)
        submitted_b = self.submit_intake(plan_b)
        job_b = submitted_b['job']['job_id']
        self.assertNotEqual(job_a, job_b)
        session_path = self.runtime._folder(plan_a['intake_id']) / 'session.json'
        current = json.loads(session_path.read_text())
        old = self.runtime._plan_row(current, plan_a['prepared']['plan_id'])
        old.update(dispatch_outcome='unknown'); old.pop('job_id', None)
        runner.atomic(session_path, current)
        recovered_a = self.runtime.read('submission', {'intake_id': plan_a['intake_id'],
            'plan_id': plan_a['prepared']['plan_id']})
        self.assertEqual(recovered_a['run_id'], job_a)
        current_b = self.runtime.read('session', {'intake_id': plan_b['intake_id']})
        self.assertEqual(current_b['prepared'], submitted_b['prepared'])
        self.assertEqual(current_b['job'], submitted_b['job'])
        self.assertEqual(current_b['state'], submitted_b['state'])
        self.assertEqual(current_b['revision'], submitted_b['revision'])
        before = session_path.read_bytes()
        with (patch.object(child_a.simulation, 'control') as control_a,
              patch.object(child_b.simulation, 'control') as control_b,
              patch.object(child_a.runner, 'status') as status_a,
              patch.object(child_a.runner, 'collect') as collect_a):
            with patch.object(self.runtime, '_submission') as historical_lookup:
                with self.assertRaises(Conflict):
                    self.runtime.write('run', {'intake_id':plan_a['intake_id'],
                        'revision':current_b['revision'],'plan_id':plan_a['prepared']['plan_id']},origin='test_harness')
                historical_lookup.assert_not_called()
            with self.assertRaises(Conflict) as caught:
                self.runtime.write('inspect', {'intake_id': plan_a['intake_id'], 'job_id': job_a},
                    origin='test_harness')
            handler = object.__new__(server.Handler)
            handler.server = SimpleNamespace(app=self.app)
            handler.send = Mock()
            handler.error(caught.exception)
            self.assertEqual(handler.send.call_args.args[0], 409)
            self.assertEqual(handler.send.call_args.args[1]['error']['code'], 'conflict')
            self.assertEqual(session_path.read_bytes(), before)
            catalog = self.runtime.read('waveforms/catalog', {'intake_id': plan_a['intake_id'], 'job_id': job_a})
            mapping = self.runtime.read('waveforms/mapping', {'intake_id': plan_a['intake_id'], 'job_id': job_a})
            sid = catalog['catalog']['signals'][0]['id']
            window = self.runtime.read('waveforms/window', {'intake_id': plan_a['intake_id'],
                'job_id': job_a, 'signal_ids': [sid]})
            for response in (catalog, mapping, window):
                self.assertEqual(response['job_id'], job_a)
                self.assertEqual(response['source_commit'], plan_a['source_commit'])
                self.assertTrue(response['read_only'])
            self.assertEqual(window['series'][0]['points'], [[0.0, 1.0], [1e-9, 0.0]])
            self.assertEqual(session_path.read_bytes(), before)
            control_a.assert_not_called(); control_b.assert_not_called()
            status_a.assert_not_called(); collect_a.assert_not_called()
        self.ssh.assert_not_called()

    def test_uncertain_reply_before_reservation_never_implicitly_replays(self):
        prepared = self.prepare()
        child = self.enable_reservation(prepared)
        with patch.object(child.simulation, 'control', side_effect=TimeoutError('Synthetic response lost before reservation')) as call:
            with self.assertRaises(TimeoutError):
                self.submit_intake(prepared)
            repeated = self.submit_intake(prepared)
            self.assertIsNone(repeated['job'])
            self.assertFalse(repeated['submission']['found'])
            self.assertFalse(repeated['submission']['replay_permitted'])
            self.assertEqual(repeated['submission']['dispatch_outcome'], 'unknown')
            call.assert_called_once()
        self.reserve.assert_not_called()
        self.dispatch.assert_not_called()
        self.assertEqual(len(self.executor.calls), 0)

    def assert_pre_dispatch_rejection_is_durable_and_allows_only_a_new_plan(self, prepared, rejected, child):
        self.assertEqual(rejected['state'], 'pre_dispatch_rejected')
        receipt = rejected['submission']
        self.assertFalse(receipt['found'])
        self.assertFalse(receipt['replay_permitted'])
        self.assertIsNone(receipt['job'])
        self.assertIsNone(receipt['run_id'])
        rejection = receipt['rejection']
        self.assertEqual(rejection['schema'], 'ic.experiment.pre-dispatch-rejection.v1')
        self.assertEqual(rejection['phase'], 'before_runner_reserve')
        self.assertEqual(rejection['code'], experiment_workflow.PreDispatchRejected.code)
        self.assertFalse(rejection['launch_attempted'])
        self.assertEqual(rejection['plan_id'], prepared['prepared']['plan_id'])
        self.assertEqual(rejection['project_id'], prepared['intake_id'])
        self.assertEqual(rejection['source_commit'], prepared['source_commit'])
        self.assertEqual(rejection['submission_key'], prepared['prepared']['submission_key'])
        stored = self.runtime._load(prepared['intake_id'])
        self.assertEqual(self.runtime._plan_row(stored, rejection['plan_id'])['rejection'], rejection)
        with patch.object(child.simulation, 'control') as control:
            for _ in range(2):
                refreshed = self.runtime.read('session', {'intake_id': prepared['intake_id']})
                lookup = self.runtime.read('submission', {'intake_id': prepared['intake_id'], 'plan_id': rejection['plan_id']})
                self.assertEqual(refreshed['submission'], receipt)
                self.assertEqual(lookup, receipt)
                self.assertEqual(self.submit_intake(prepared)['submission'], receipt)
            control.assert_not_called()
        self.reserve.assert_not_called()
        self.dispatch.assert_not_called()
        self.assertEqual(len(self.executor.calls), 0)
        intent = explicit_intent(); intent['load_f'] = 3e-15
        next_plan = self.prepare(self.runtime.read('session', {'intake_id': prepared['intake_id']}), intent=intent)
        self.assertEqual(next_plan['state'], 'prepared', next_plan)
        self.assertNotEqual(next_plan['prepared']['plan_id'], prepared['prepared']['plan_id'])
        self.assertNotIn('submission', next_plan)
        with patch.object(child.simulation, 'control') as control:
            with self.assertRaises(Conflict):
                self.submit_intake(prepared)
            old = self.runtime.read('submission', {'intake_id':prepared['intake_id'],
                'plan_id':prepared['prepared']['plan_id']})
            self.assertEqual(old['rejection'], rejection)
            self.assertFalse(old['replay_permitted'])
            control.assert_not_called()
        self.reserve.assert_not_called()
        self.ssh.assert_not_called()

    def test_actual_workflow_no_eligible_host_records_a_bound_pre_dispatch_rejection(self):
        prepared = self.prepare()
        child = self.enable_reservation(prepared)
        self.doctor.return_value = {**self.doctor.return_value, 'identity_ok': False}
        rejected = self.submit_intake(prepared)
        self.selected_pool.prepare.assert_not_called()
        self.assert_pre_dispatch_rejection_is_durable_and_allows_only_a_new_plan(prepared, rejected, child)

    def test_actual_workflow_resource_pool_rejection_happens_before_runner_reservation(self):
        prepared = self.prepare()
        child = self.enable_reservation(prepared)
        # Exercise the actual workflow catch around its pool boundary, not a
        # fake typed exception injected at the onboarding control adapter.
        self.selected_pool.prepare.side_effect = ValueError('Synthetic resource pool has no eligible capacity')
        rejected = self.submit_intake(prepared)
        self.selected_pool.prepare.assert_called_once()
        self.selected_pool.resolve.assert_not_called()
        self.assert_pre_dispatch_rejection_is_durable_and_allows_only_a_new_plan(prepared, rejected, child)

    def test_untyped_matching_rejection_text_or_code_cannot_release_an_uncertain_submission(self):
        message = 'Resource or dependency preflight rejected this request before Runner reservation.'
        for error_type in (ValueError, TimeoutError):
            with self.subTest(error_type=error_type.__name__):
                prepared = self.prepare()
                child = self.enable_reservation(prepared)
                error = error_type(message)
                error.code = experiment_workflow.PreDispatchRejected.code
                with patch.object(child.simulation, 'control', side_effect=error) as control:
                    with self.assertRaises(error_type):
                        self.submit_intake(prepared)
                    current = self.runtime.read('session', {'intake_id': prepared['intake_id']})
                    self.assertEqual(current['state'], 'submission_uncertain')
                    row = self.runtime._plan_row(self.runtime._load(prepared['intake_id']), prepared['prepared']['plan_id'])
                    self.assertEqual(row['dispatch_outcome'], 'unknown')
                    self.assertNotIn('rejection', row)
                    repeat = self.submit_intake(prepared)
                    self.assertFalse(repeat['submission']['replay_permitted'])
                    self.assertEqual(repeat['submission']['dispatch_outcome'], 'unknown')
                    self.assertNotIn('rejection', repeat['submission'])
                    with self.assertRaises(Conflict):
                        self.prepare(current)
                    control.assert_called_once()
                self.reserve.assert_not_called()
                self.assertEqual(len(self.executor.calls), 0)

    def test_error_after_actual_runner_reservation_is_not_typed_as_pre_dispatch_rejection(self):
        prepared = self.prepare()
        child = self.enable_reservation(prepared)
        reserve = child.runner.reserve._mock_wraps
        def reserve_then_fail(*args, **kwargs):
            reserve(*args, **kwargs)
            raise ValueError('Resource or dependency preflight rejected this request before Runner reservation.')
        self.reserve.side_effect = reserve_then_fail
        with self.assertRaises(ValueError):
            self.submit_intake(prepared)
        self.reserve.assert_called_once()
        self.assertIsNotNone(child.runner.lookup_submission(prepared['prepared']['submission_key']))
        current = self.runtime.read('session', {'intake_id': prepared['intake_id']})
        self.assertEqual(current['state'], 'submission_uncertain')
        row = self.runtime._plan_row(self.runtime._load(prepared['intake_id']), prepared['prepared']['plan_id'])
        self.assertEqual(row['dispatch_outcome'], 'unknown')
        self.assertNotIn('rejection', row)
        with self.assertRaises(Conflict):
            self.prepare(current)
        with self.assertRaises(ValueError):
            self.submit_intake(prepared)
        self.reserve.assert_called_once()
        self.dispatch.assert_not_called()
        self.assertEqual(len(self.executor.calls), 0)

    def test_session_and_submission_reads_never_status_or_collect(self):
        prepared = self.prepare()
        child = self.enable_reservation(prepared)
        submitted = self.submit_intake(prepared)
        with patch.object(child.runner, 'status') as status, patch.object(child.runner, 'collect') as collect:
            for _ in range(2):
                state = self.runtime.read('session', {'intake_id': prepared['intake_id']})
                receipt = self.runtime.read('submission', {'intake_id': prepared['intake_id'],
                    'plan_id': prepared['prepared']['plan_id']})
                self.assertEqual(state['job']['job_id'], submitted['job']['job_id'])
                self.assertEqual(receipt['run_id'], submitted['job']['job_id'])
            status.assert_not_called()
            collect.assert_not_called()
        self.dispatch.assert_not_called()

    def test_original_child_resumes_from_its_new_config_without_replay(self):
        prepared = self.prepare()
        self.enable_reservation(prepared)
        submitted = self.submit_intake(prepared)
        self.runtime.close()
        self.runtime._children.clear()
        with (patch.object(runner.Runner, 'reserve') as reserve,
              patch.object(runner.Runner, 'dispatch') as dispatch,
              patch.object(runner.Runner, 'status') as status,
              patch.object(runner.Runner, 'collect') as collect):
            receipt = self.runtime.read('submission', {'intake_id': prepared['intake_id'],
                'plan_id': prepared['prepared']['plan_id']})
            self.assertEqual(receipt['run_id'], submitted['job']['job_id'])
            self.assertEqual(receipt['job']['state'], 'queued')
            reserve.assert_not_called(); dispatch.assert_not_called()
            status.assert_not_called(); collect.assert_not_called()
        child = self.child_for(prepared)
        self.assertEqual(child.workspace.head(), prepared['source_commit'])
        self.assertTrue(child.workspace.root.is_relative_to(self.runtime._folder(prepared['intake_id'])))
        self.ssh.assert_not_called()

    def test_redirected_child_configuration_is_rejected_before_application_reads_it(self):
        prepared = self.prepare()
        child = self.child_for(prepared)
        path = Path(child.cfg['runtime_root']).parent / 'configuration.json'
        original = json.loads(path.read_text())
        self.runtime.close()
        self.runtime._children.clear()
        for field in ('site_file', 'runs_root'):
            cfg = {**original, field: str(self.old / 'profile.json')}
            runner.atomic(path, cfg)
            with self.subTest(field=field), patch.object(server, 'Application') as create:
                with self.assertRaises(ValueError):
                    self.runtime.read('submission', {'intake_id': prepared['intake_id'],
                        'plan_id': prepared['prepared']['plan_id']})
                create.assert_not_called()
            self.runtime._children.clear()
        runner.atomic(path, original)

    def test_missing_original_workspace_is_not_recreated_during_a_read(self):
        prepared = self.prepare()
        child = self.child_for(prepared)
        workspace = child.workspace.root
        moved = workspace.with_name('temporarily-unavailable-workspace')
        self.runtime.close()
        self.runtime._children.clear()
        workspace.rename(moved)
        try:
            with patch.object(server, 'Application') as create:
                with self.assertRaises(ValueError):
                    self.runtime.read('submission', {'intake_id': prepared['intake_id'],
                        'plan_id': prepared['prepared']['plan_id']})
                create.assert_not_called()
            self.assertFalse(workspace.exists())
        finally:
            moved.rename(workspace)


def write_session_examples(path):
    """Generate contract examples by running the same isolated runtime fixtures."""
    fixture = _IntakeFixture()
    try:
        fixture.setUp()
        netlist = fixture.new_source()
        session = fixture.runtime.read('session', {'intake_id': netlist['intake_id']})
        probed = fixture.probe(netlist)
        discovered = fixture.discover(probed)
        prepared = fixture.prepare(discovered)
        fixture.assertEqual(prepared['state'], 'prepared', prepared.get('prepared'))
        fixture.enable_reservation(prepared)
        submitted = fixture.submit_intake(prepared)
        inspected = fixture.runtime.write('inspect', {'intake_id': submitted['intake_id'],
            'job_id': submitted['job']['job_id']}, origin='test_harness')
        payload = {'schema': 'ic.onboarding.session-examples.v1', 'synthetic': True,
            'producer': 'tools/workbench/test_onboarding_integration.py --write-examples',
            'evidence': {'runtime': 'actual onboarding Application, Workspace, ExperimentWorkflow and Runner',
                'source': 'newly authored two-device netlist and synthetic model file',
                'discovery_transport': 'mocked; local static scanner generated the captured evidence',
                'source_git': 'actual newly initialized temporary local repository',
                'reservation': 'actual Runner reservation', 'dispatch': 'deferred fixture callback',
                'simulation_executed': False, 'inspection': 'actual working response for the queued job'},
            'snapshots': {'netlist': netlist, 'getSession': session, 'probe': probed,
                'discover': discovered, 'prepare': prepared, 'run': submitted, 'inspect': inspected}}
        raw = json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False) + '\n'
        fixture.assertNotIn(str(fixture.root), raw)
        fixture.assertNotIn(SECRET, raw)
    finally:
        fixture.doCleanups()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(raw)
    return path


def write_rejection_examples(path):
    """Serialize actual typed rejection and subsequent read replies from a fixture."""
    fixture = _IntakeFixture()
    try:
        fixture.setUp()
        prepared = fixture.prepare()
        fixture.assertEqual(prepared['state'], 'prepared', prepared.get('prepared'))
        fixture.enable_reservation(prepared)
        fixture.doctor.return_value = {**fixture.doctor.return_value, 'identity_ok': False}
        rejected = fixture.submit_intake(prepared)
        lookup = fixture.runtime.read('submission', {'intake_id': prepared['intake_id'],
            'plan_id': prepared['prepared']['plan_id']})
        session = fixture.runtime.read('session', {'intake_id': prepared['intake_id']})
        fixture.assertEqual(rejected['state'], 'pre_dispatch_rejected')
        fixture.assertEqual(rejected['submission'], lookup)
        fixture.assertEqual(session['submission'], lookup)
        fixture.assertEqual(lookup['rejection']['phase'], 'before_runner_reserve')
        fixture.assertFalse(lookup['replay_permitted'])
        fixture.reserve.assert_not_called()
        fixture.dispatch.assert_not_called()
        fixture.ssh.assert_not_called()
        payload = {'schema': 'ic.onboarding.rejection-examples.v1', 'synthetic': True,
            'producer': 'tools/workbench/test_onboarding_integration.py --write-rejection-example',
            'evidence': {'runtime': 'actual onboarding Application, Workspace and ExperimentWorkflow',
                'source': 'newly authored two-device netlist and synthetic model file',
                'discovery_transport': 'mocked; local static scanner generated the captured evidence',
                'source_git': 'actual newly initialized temporary local repository',
                'preflight': 'synthetic identity mismatch from the mocked doctor boundary',
                'rejection': 'actual ExperimentWorkflow PreDispatchRejected control flow',
                'runner_reservation_attempted': False, 'simulation_executed': False},
            'snapshots': {'runRejected': rejected, 'readSubmissionRejected': lookup,
                'getSessionRejected': session}}
        raw = json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False) + '\n'
        fixture.assertNotIn(str(fixture.root), raw)
        fixture.assertNotIn(SECRET, raw)
    finally:
        fixture.doCleanups()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(raw)
    return path


if __name__ == '__main__':
    if sys.argv[1:] == ['--write-examples']:
        output = Path(__file__).resolve().parents[2] / 'docs/contracts/onboarding-session.example.json'
        print(write_session_examples(output))
    elif sys.argv[1:] == ['--write-rejection-example']:
        output = Path(__file__).resolve().parents[2] / 'docs/contracts/onboarding-rejection.example.json'
        print(write_rejection_examples(output))
    else:
        unittest.main()
