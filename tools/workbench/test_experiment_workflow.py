"""Real workspace/Runner/runtime with synthetic Git and mocked remote boundaries."""
import concurrent.futures
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import experiment_workflow
import runner
import server
import workspace
from simulation_runtime import SimulationRuntime
from supervision import Supervision

try:
    from spiceowl.integrations.model_dependencies import validate_audit_config
except ImportError:
    validate_audit_config = None

PROJECT, RECIPE, HOST = 'synthetic-project', 'synthetic-inverter', 'synthetic-node'
SOURCE = 'projects/toy/circuit.scs'
MODEL = '/synthetic/models/toy.scs'
MODEL_RAW = b'Original offline model identity fixture.'
MODEL_SHA = hashlib.sha256(MODEL_RAW).hexdigest()
CALLER = 'spiceowl-local'
TEXT = (b'simulator lang=spectre\nsubckt Toy IN OUT HI LO\n'
        b'A (OUT IN LO LO) device_alpha w=2u l=200n nf=1 multi=1\n'
        b'B (OUT IN HI HI) device_beta w=3u l=200n nf=1 multi=1\nends Toy\n')


def specification():
    return {'schema': 'spiceowl.experiment-spec.v1', 'recipe': 'inverter-tran',
        'roles': {'inputs': ['IN'], 'outputs': ['OUT'], 'vdd': 'HI', 'vss': 'LO'},
        'supply': {'positive_v': 1.0, 'negative_v': 0.0}, 'temperature_k': 300.15,
        'nominal_temperature_k': 300.15, 'corner': 'TT', 'parameters': {},
        'stimuli': [{'port': 'IN', 'type': 'pulse', 'low_v': 0.0, 'high_v': 1.0,
                     'delay_s': 0.0, 'rise_s': .25e-9, 'fall_s': .25e-9,
                     'width_s': 1.5e-9, 'period_s': 4e-9}],
        'loads': [{'port': 'OUT', 'capacitance_f': 1e-15}],
        'analysis': {'stop_s': 4e-9, 'max_step_s': .25e-9, 'strobe_period_s': .25e-9},
        'acceptance': {'required_units': {'time': 's', 'IN': 'V', 'OUT': 'V', 'HI': 'V', 'LO': 'V'},
            'sample_count': 17, 'coverage': {'start_s': 0, 'end_s': 4e-9, 'tolerance_s': 1e-18},
            'max_sample_gap_s': .251e-9, 'voltage_bounds_v': [-.05, 1.05], 'supply_tolerance_v': 1e-6,
            'logic': {'low_max_v': .1, 'high_min_v': .9, 'crossing_v': .5,
                'windows': [{'kind': 'input_high_output_low', 'start_s': .5e-9, 'end_s': 1.5e-9, 'minimum_samples': 4},
                            {'kind': 'input_low_output_high', 'start_s': 2.5e-9, 'end_s': 3.5e-9, 'minimum_samples': 4}]}}}


class DeferredExecutor:
    def __init__(self):
        self.calls = []

    def submit(self, fn, *args):
        future = concurrent.futures.Future()
        self.calls.append((fn, args, future))
        return future

    def complete(self, index=0):
        fn, args, future = self.calls[index]
        try:
            result = fn(*args)
        except Exception as error:
            future.set_exception(error)
            raise
        future.set_result(result)
        return result


@unittest.skipIf(validate_audit_config is None, 'Requires the pinned SpiceOwl experiment package')
class ExperimentWorkflowIntegrationTests(unittest.TestCase):
    def patch(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.seed = self.root / 'seed'
        self.seed.mkdir()
        # All process calls must be local Git. This also catches accidental SSH
        # archive downloads that bypass the mocked core.ssh transport.
        execute = subprocess.run
        def git_only(argv, *args, **kwargs):
            if not isinstance(argv, list) or argv[0] != 'git':
                raise AssertionError('Only local Git commands are allowed in this fixture')
            return execute(argv, *args, **kwargs)
        self.patch(patch.object(subprocess, 'run', side_effect=git_only))
        self.git('init', '-b', 'main')
        path = self.seed / SOURCE; path.parent.mkdir(parents=True); path.write_bytes(TEXT)
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
                 '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Original synthetic source')
        self.site = {'schema': 'ic.sim.site.v1', 'ssh_target': HOST,
            'remote_runs_root': '/synthetic/ic_on_github_runs', 'cadence_cshrc': '/synthetic/tools/setup.csh',
            'spectre_bin': '/synthetic/tools/spectre', 'external_files': {},
            'expected_host': HOST, 'expected_user': 'synthetic-user'}
        runner.atomic(self.root / 'site.json', self.site)
        self.dependencies = {'roots': ['/synthetic/models'], 'main': MODEL, 'sections': ['typical'],
                             'required_masters': ['device_alpha', 'device_beta']}
        electrical = {'schema': 'spiceowl.experiment-model-profile.v1', 'id': 'synthetic-model',
            'models': {'device_alpha': {'polarity': 'n', 'terminals': ['d', 'g', 's', 'b']},
                       'device_beta': {'polarity': 'p', 'terminals': ['d', 'g', 's', 'b']}},
            'corners': {'TT': [{'alias': 'PDK_MAIN', 'section': 'typical'}]}}
        self.registration = {'id': RECIPE, 'project_id': PROJECT, 'source_paths': [SOURCE],
            'selection': {'mode': 'instances', 'source_id': SOURCE, 'subcircuit': 'Toy',
                          'instances': ['A', 'B'], 'ports': ['IN', 'OUT', 'HI', 'LO']},
            'spec': specification(), 'model_profile': 'synthetic-model', 'host_ids': [HOST],
            'qualification_checks': ['soa_voltage', 'model_parameter_range']}
        self.profile = {'electrical': electrical, 'dependencies': self.dependencies,
                        'expected_main_sha256': MODEL_SHA, 'audit_host': HOST}
        self.cfg = {'github_repo': 'example/synthetic-experiment', 'seed_repo': str(self.seed),
            'runtime_root': str(self.root / 'runtime'), 'base_branch': 'main', 'runtime_branch': 'codex/synthetic-workflow',
            'projects': [{'id': PROJECT, 'source_path': SOURCE, 'configurations': []}],
            'simulation_direct': {'enabled': True, 'projects': [PROJECT], 'hosts': [HOST],
                'callers': [CALLER, 'local-studio'],
                'operations': ['prepare', 'run', 'inspect', 'runtime', 'watch', 'collect', 'status']},
            'experiment_workflow': {'recipes': [self.registration], 'profiles': {'synthetic-model': self.profile}}}
        normalized = validate_audit_config(self.dependencies)
        self.audit = {'schema': 'spiceowl.model-dependency-audit.v1', 'static_only': True,
            'status': 'complete_for_supported_static_syntax',
            'files': [{'path': MODEL, 'kind': 'file', 'sha256': MODEL_SHA, 'bytes': len(MODEL_RAW), 'roles': ['model']}],
            'directories': [], 'edges': [], 'master_declarations': [
                {'name': name, 'port_count': 4, 'path': MODEL, 'line': index + 1}
                for index, name in enumerate(['device_alpha', 'device_beta'])],
            'missing_masters': [], 'unknown': [], 'unknown_count': 0, 'unknown_truncated': False,
            'visited_sections': 1, 'bytes_read': len(MODEL_RAW), 'limits': normalized['limits']}
        self.ssh = self.patch(patch.object(runner.core, 'ssh', side_effect=AssertionError('No real SSH')))
        self.doctor = self.patch(patch.object(runner.core, 'doctor', return_value={
            'exit_code': 0, 'identity_ok': True, 'all_references_readable': True, 'all_tools_available': True,
            'dependency_sha256': {'PDK_MAIN': MODEL_SHA, 'cadence_setup': 'c' * 64, 'spectre': 'd' * 64}}))
        self.make_runtime()
        self.commit = self.ws.head()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.seed), *args], check=True, capture_output=True).stdout

    def make_runtime(self):
        self.ws = workspace.Workspace(self.cfg, self.site, b'original-workflow-key' * 2)
        recheck = lambda selected: {'eligible': True, 'host_id': selected['host_id'],
            'checked_at': '2026-11-23T00:00:00+00:00', 'selection': copy.deepcopy(selected)}
        self.runner = runner.Runner(self.root / 'runs', self.site, self.ws.frozen, self.ws.key, recheck)
        self.executor = DeferredExecutor()
        self.resource_pool = Mock()
        self.resource_pool.members = {HOST: {'site_file': str(self.root / 'site.json')}}
        self.resource_pool.requirements = {'cpu_count': 1, 'memory_bytes': 1024 ** 3, 'simulator': 'spectre'}
        self.resource_pool.data_dir = str(self.root / 'private-host-state')
        self.resource_pool.prepare.return_value = {'execution_plan_id': 'e' * 64}
        self.app = types.SimpleNamespace(cfg=self.cfg, workspace=self.ws, runner=self.runner,
            resource_pool=self.resource_pool, pool=self.executor, operations={}, ai=None,
            supervision=Supervision(self.runner, self.ws.projects))
        self.runtime = SimulationRuntime(self.app); self.app.simulation = self.runtime
        self.addCleanup(self.runtime.close)
        self.workflow = experiment_workflow.ExperimentWorkflow(self.runtime)
        self.runtime._experiments = self.workflow
        self.audit_call = self.patch(patch.object(self.workflow, '_audit', side_effect=lambda *_: copy.deepcopy(self.audit)))
        def selected_pool(plan_id, data):
            self.resource_pool.resolve.return_value = {'schema': 'ic.execution.context.v1', 'plan_id': 'e' * 64,
                'site': data['sites'][HOST], 'resource_selection': {'host_id': HOST}}
            return self.resource_pool
        self.pool_call = self.patch(patch.object(self.workflow, '_pool', side_effect=selected_pool))
        self.reserve = self.patch(patch.object(self.runner, 'reserve', wraps=self.runner.reserve))
        self.dispatch = self.patch(patch.object(self.runner, 'dispatch', wraps=self.runner.dispatch))
        self.collect = self.patch(patch.object(self.runner, 'collect', wraps=self.runner.collect))
        self.monitor = Mock(); self.monitor.watch.return_value = {'state': 'watching'}
        self.patch(patch.object(self.runtime, 'monitor', return_value=self.monitor))

    def prepare(self, **changes):
        return self.runtime.control('prepare', {'project_id': PROJECT, 'recipe_id': RECIPE,
            'source_commit': self.commit, **changes}, None, CALLER)

    def submit_plan(self, plan):
        return self.runtime.control('run', {'project_id': PROJECT, 'plan_id': plan['plan_id']},
                                    'experiment-' + plan['plan_id'], CALLER)

    def inspect(self, job):
        return self.runtime.control('inspect', {'project_id': PROJECT, 'job_id': job['job_id']}, None, CALLER)

    def dispatched(self):
        plan = self.prepare(); job = self.submit_plan(plan)
        self.ssh.side_effect = lambda *_a, **_kw: subprocess.CompletedProcess([], 0, b'', b'')
        receipt = self.executor.complete()
        self.assertEqual(receipt['state'], 'submitted', receipt.get('error'))
        self.assertEqual(receipt['launch_attempts'], 1)
        return plan, job

    @staticmethod
    def terminal():
        return subprocess.CompletedProcess([], 0,
            b'STATE simulator_complete_pending_measurements\nEXIT 0\nPID 1\nALIVE no\n', b'')

    def test_prepare_is_deterministic_and_uses_committed_source_without_dispatch(self):
        first, second = self.prepare(), self.prepare()
        self.assertEqual(first['state'], 'prepared')
        self.assertEqual(first['plan_id'], second['plan_id'])
        data = self.workflow.plan(first['plan_id'], PROJECT)
        self.assertEqual(data['identity']['source_commit'], self.commit)
        self.assertEqual(data['source']['sources'][0]['sha256'], hashlib.sha256(TEXT).hexdigest())
        b = json.loads(Path(data['bundle_path']).read_text())
        self.assertEqual(b['external_sha256']['PDK_MAIN'], MODEL_SHA)
        for statement in TEXT.splitlines()[2:4]:
            self.assertIn(statement, (Path(data['bundle_path']).parent / 'netlist/dut.scs').read_bytes())
        self.reserve.assert_not_called(); self.dispatch.assert_not_called(); self.ssh.assert_not_called()
        self.assertEqual(self.executor.calls, [])

    def test_unregistered_recipe_and_missing_scientific_fields_are_structured(self):
        result = self.prepare(recipe_id='unregistered')
        self.assertEqual(result['missing'][0]['code'], 'recipe_not_registered')
        self.registration['spec'].pop('supply')
        result = self.prepare()
        self.assertEqual(result['state'], 'blocked'); self.assertIsNone(result['plan_id'])
        self.assertEqual(result['missing'][0]['field'], 'spec.supply')
        self.audit_call.assert_not_called(); self.reserve.assert_not_called()

    def test_missing_profile_model_revision_master_count_and_include_mismatch_block(self):
        baseline_profile, baseline_audit = copy.deepcopy(self.profile), copy.deepcopy(self.audit)
        cases = [('model_revision_mismatch', lambda: self.profile.update(expected_main_sha256='f' * 64)),
                 ('model_terminal_contract_unverified', lambda: self.audit['master_declarations'][0].update(port_count=3)),
                 ('model_terminal_contract_unverified', lambda: self.audit.update(master_declarations=[])),
                 ('include_profile_mismatch', lambda: self.profile['electrical']['corners']['TT'][0].update(section='slow')),
                 ('include_profile_mismatch', lambda: self.profile['electrical']['corners']['TT'][0].update(alias='OTHER_MODEL'))]
        for code, mutate in cases:
            self.profile.clear(); self.profile.update(copy.deepcopy(baseline_profile))
            self.audit.clear(); self.audit.update(copy.deepcopy(baseline_audit)); mutate()
            with self.subTest(code=code):
                result = self.prepare()
                self.assertEqual(result['state'], 'blocked'); self.assertIsNone(result['plan_id'])
                self.assertEqual(result['missing'][0]['code'], code)
        self.cfg['experiment_workflow']['profiles'].clear()
        self.assertEqual(self.prepare()['missing'][0]['code'], 'model_profile_missing')
        self.reserve.assert_not_called(); self.ssh.assert_not_called()

    def local_model_audit(self, files):
        """Run the real static scanner only over authored temporary fixtures."""
        from spiceowl.integrations.model_dependencies import build_model_audit_script
        root=self.root/'synthetic-models';root.mkdir()
        for name,text in files.items():
            (root/name).write_text(text)
        self.dependencies.update(roots=[str(root)],main=str(root/'main.scs'))
        self.profile['expected_main_sha256']=hashlib.sha256((root/'main.scs').read_bytes()).hexdigest()
        def inspect(_site,config,_python):
            output=io.StringIO()
            with contextlib.redirect_stdout(output):
                exec(build_model_audit_script(config),{})
            return json.loads(output.getvalue())
        self.audit_call.side_effect=inspect

    def test_recipe_audit_cannot_borrow_models_from_another_corner(self):
        self.dependencies.update(sections=['typical','slow'],required_masters=[])
        self.local_model_audit({'main.scs':
            'section typical\nendsection typical\nsection slow\n'
            'subckt device_alpha d g s b\nends device_alpha\n'
            'subckt device_beta d g s b\nends device_beta\nendsection slow\n'})
        registered=copy.deepcopy(self.profile)
        result=self.prepare()
        self.assertEqual(result['state'],'blocked')
        self.assertIsNone(result['plan_id'])
        self.assertEqual(result['missing'][0]['code'],'dependency_audit_incomplete')
        actual=self.audit_call.call_args.args[1]
        self.assertEqual(actual['sections'],['typical'])
        self.assertEqual(set(actual['required_masters']),{'device_alpha','device_beta'})
        self.assertEqual(self.profile,registered)
        self.reserve.assert_not_called();self.ssh.assert_not_called()

    def test_recipe_audit_keeps_transitive_sections_and_global_models(self):
        self.dependencies.update(sections=['typical','slow'],required_masters=[])
        self.local_model_audit({
            'main.scs':'include "global.scs"\nsection typical\ninclude "devices.scs" section=mos\n'
                       'endsection typical\nsection slow\ninclude "not-selected.scs"\nendsection slow\n',
            'global.scs':'subckt device_alpha d g s b\nends device_alpha\n',
            'devices.scs':'section mos\nsubckt device_beta d g s b\nends device_beta\nendsection mos\n',
        })
        registered=copy.deepcopy(self.profile)
        result=self.prepare()
        self.assertEqual(result['state'],'prepared')
        actual=self.audit_call.call_args.args[1]
        self.assertEqual(actual['sections'],['typical'])
        self.assertEqual(set(actual['required_masters']),{'device_alpha','device_beta'})
        plan=self.workflow.plan(result['plan_id'],PROJECT)
        declarations={row['name']:row['section'] for row in plan['dependency_audit']['master_declarations']}
        self.assertEqual(declarations,{'device_alpha':None,'device_beta':'mos'})
        self.assertEqual(len(plan['dependency_audit']['files']),3)
        self.assertEqual(self.profile,registered)
        self.reserve.assert_not_called();self.ssh.assert_not_called()

    def test_forged_complete_audit_coverage_or_outside_root_is_rejected(self):
        baseline = copy.deepcopy(self.audit)
        for mutate in (lambda: self.audit.update(unknown_count=1),
                       lambda: self.audit.update(limits={}),
                       lambda: self.audit['files'][0].update(path='/outside/model.scs'),
                       lambda: self.audit['files'][0].update(bytes=True)):
            self.audit.clear(); self.audit.update(copy.deepcopy(baseline)); mutate()
            with self.assertRaises(ValueError): self.prepare()
        self.reserve.assert_not_called()

    def test_source_revision_and_allowlist_are_checked_before_remote_audit(self):
        with self.assertRaises(ValueError): self.prepare(source_commit='f' * 40)
        self.registration['source_paths'] = ['projects/other/private.scs']
        with self.assertRaises(ValueError): self.prepare()
        self.audit_call.assert_not_called()

    def test_frozen_bundle_tampering_prevents_reservation(self):
        plan = self.prepare(); data = self.workflow.plan(plan['plan_id'], PROJECT)
        Path(data['bundle_path']).write_text('{}\n')
        with self.assertRaisesRegex(ValueError, 'bundle changed'): self.submit_plan(plan)
        self.reserve.assert_not_called(); self.ssh.assert_not_called()

    def test_repeated_run_reserves_and_dispatches_only_once(self):
        plan = self.prepare(); job = self.submit_plan(plan)
        self.assertEqual(self.submit_plan(plan)['job_id'], job['job_id'])
        self.assertEqual(len(self.executor.calls), 1)
        self.ssh.side_effect = lambda *_a, **_kw: subprocess.CompletedProcess([], 0, b'', b'')
        self.assertEqual(self.executor.complete()['state'], 'submitted')
        repeated = self.submit_plan(plan)
        self.assertEqual(repeated['job_id'], job['job_id'])
        self.assertEqual(repeated['launch_attempts'], 1)
        self.reserve.assert_called_once(); self.dispatch.assert_called_once()
        self.assertEqual(len(self.executor.calls), 1)
        self.assertEqual(self.ssh.call_count, 2)
        self.assertEqual(self.runner.lookup_submission('experiment-' + plan['plan_id']), job['job_id'])

    def test_original_key_cannot_resolve_a_different_experiment_plan(self):
        first = self.prepare(); self.submit_plan(first)
        self.registration['spec']['loads'][0]['capacitance_f'] = 2e-15
        second = self.prepare()
        self.assertNotEqual(first['plan_id'], second['plan_id'])
        path = self.runner.root / 'keys.json'; keys = json.loads(path.read_text())
        keys['experiment-' + second['plan_id']] = keys['experiment-' + first['plan_id']]
        runner.atomic(path, keys)
        with self.assertRaises(ValueError): self.submit_plan(second)
        self.assertEqual(self.reserve.call_count, 1)
        self.assertEqual(len(self.executor.calls), 1); self.ssh.assert_not_called()

    def test_restart_preserves_original_mapping_and_does_not_replay_queued_job(self):
        plan = self.prepare(); job = self.submit_plan(plan)
        self.make_runtime()
        repeated = self.submit_plan(plan)
        self.assertEqual(repeated['job_id'], job['job_id'])
        self.assertEqual(repeated['state'], 'queued')
        self.reserve.assert_not_called(); self.dispatch.assert_not_called(); self.pool_call.assert_not_called()
        self.ssh.assert_not_called(); self.assertEqual(self.executor.calls, [])

    def test_restart_after_launch_disconnect_reuses_unknown_job_without_a_second_launch(self):
        plan = self.prepare(); job = self.submit_plan(plan)
        self.ssh.side_effect = [subprocess.CompletedProcess([], 0, b'', b''),
                                TimeoutError('Synthetic launch response was lost')]
        self.assertEqual(self.executor.complete()['state'], 'launch_outcome_unknown')
        self.assertEqual(self.runner.read(job['job_id'])['launch_attempts'], 1)
        self.make_runtime()
        repeated = self.submit_plan(plan)
        self.assertEqual(repeated['job_id'], job['job_id'])
        self.assertEqual(repeated['state'], 'launch_outcome_unknown')
        self.assertEqual(repeated['launch_attempts'], 1)
        self.assertEqual(self.ssh.call_count, 2)
        self.reserve.assert_not_called(); self.dispatch.assert_not_called(); self.pool_call.assert_not_called()
        self.assertEqual(self.executor.calls, [])

    def revoked_before_dispatch(self, operation):
        plan = self.prepare(); job = self.submit_plan(plan)
        self.runtime.scope['operations'].remove(operation)
        with self.assertRaises(PermissionError): self.executor.complete()
        self.dispatch.assert_not_called(); self.ssh.assert_not_called()
        self.assertEqual(self.runner.read(job['job_id'])['launch_attempts'], 0)
        self.runtime.scope['operations'].append(operation)
        self.assertEqual(self.inspect(job)['inspection_state'], 'uncertain')
        self.assertEqual(len(self.executor.calls), 1)

    def test_queued_run_grant_revoked_before_dispatch_is_not_executed(self):
        self.revoked_before_dispatch('run')

    def test_queued_watch_grant_revoked_before_dispatch_is_not_executed(self):
        self.revoked_before_dispatch('watch')

    def test_inspection_queues_collection_once_then_preserves_uncertain_receipt_across_restart(self):
        plan, job = self.dispatched(); self.ssh.side_effect = lambda *_a, **_kw: self.terminal()
        self.assertEqual(self.inspect(job)['inspection_state'], 'collecting')
        calls = self.ssh.call_count
        self.assertEqual(self.inspect(job)['inspection_state'], 'working')
        self.assertEqual(self.ssh.call_count, calls); self.assertEqual(len(self.executor.calls), 2)
        self.ssh.side_effect = [self.terminal(), TimeoutError('Synthetic archive connection interrupted')]
        self.executor.complete(1)
        self.assertEqual(self.collect.call_count, 1)
        self.assertEqual(self.inspect(job)['inspection_state'], 'uncertain')
        calls = self.ssh.call_count
        self.make_runtime()
        self.assertEqual(self.inspect(job)['inspection_state'], 'uncertain')
        self.assertEqual(self.ssh.call_count, calls)
        self.collect.assert_not_called(); self.assertEqual(self.executor.calls, [])

    def test_disconnected_status_is_uncertain_and_never_queues_collection_or_relaunch(self):
        plan, job = self.dispatched()
        self.ssh.side_effect = TimeoutError('Synthetic status connection interrupted')
        result = self.inspect(job)
        self.assertEqual(result['inspection_state'], 'uncertain')
        self.assertEqual(result['job_id'], job['job_id'])
        self.assertEqual(result['plan_id'], plan['plan_id'])
        self.collect.assert_not_called(); self.assertEqual(len(self.executor.calls), 1)
        self.assertEqual(self.runner.read(job['job_id'])['launch_attempts'], 1)

    def test_preflight_failure_returns_uncertain_and_never_launches(self):
        plan = self.prepare(); job = self.submit_plan(plan)
        self.doctor.return_value['identity_ok'] = False
        self.executor.complete()
        self.assertEqual(self.inspect(job)['inspection_state'], 'uncertain')
        self.assertEqual(self.runner.read(job['job_id'])['state'], 'preflight_failed')
        self.ssh.assert_not_called(); self.collect.assert_not_called()

    def test_reconcile_state_is_uncertain_without_queueing_a_second_attempt(self):
        plan, job = self.dispatched()
        self.ssh.side_effect = lambda *_a, **_kw: subprocess.CompletedProcess([], 0,
            b'STATE unknown\nEXIT \nPID 1\nALIVE no\n', b'')
        self.assertEqual(self.inspect(job)['inspection_state'], 'uncertain')
        self.assertEqual(self.runner.read(job['job_id'])['state'], 'reconcile_required')
        self.assertEqual(len(self.executor.calls), 1); self.collect.assert_not_called()

    def test_runtime_get_route_reads_stored_experiment_state_without_remote_operations(self):
        job = self.submit_plan(self.prepare())
        self.audit_call.reset_mock(); self.doctor.reset_mock(); self.reserve.reset_mock()
        handler = object.__new__(server.Handler)
        handler.server = types.SimpleNamespace(app=self.app, server_port=18881)
        handler.path = '/api/simulation/runtime?project_id=' + PROJECT
        handler.headers = {'Host': '127.0.0.1:18881'}
        handler.send = Mock()
        handler.do_GET()
        status, response = handler.send.call_args.args[:2]
        self.assertEqual(status, 200, response)
        snapshot = response['data']
        self.assertEqual(snapshot['runs'][0]['run_id'], job['job_id'])
        self.assertEqual(snapshot['experiments']['recipes'][0]['recipe_id'], RECIPE)
        self.audit_call.assert_not_called(); self.doctor.assert_not_called(); self.ssh.assert_not_called()
        self.reserve.assert_not_called(); self.dispatch.assert_not_called(); self.collect.assert_not_called()
        self.assertEqual(len(self.executor.calls), 1)


if __name__ == '__main__':
    unittest.main()
