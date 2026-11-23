"""Finite runtime authority and replay tests; executor, pool, Runner are local fakes."""
import concurrent.futures
import copy
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

import server
import simulation_runtime
from simulation_runtime import SimulationRuntime
from supervision import execution_target

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'modules/gateway_client'))
from ic_gateway.service import Gateway
COMMIT, PLAN = 'a' * 40, 'b' * 64
IDENTITY = {'project_id': 'demo', 'configuration': 'tran', 'source_commit': COMMIT}
RUN_ARGS = {**IDENTITY, 'run_id': 'run-1'}
TIME = '2026-11-23T01:00:00+00:00'


def scope(**changes):
    return {'enabled': True, 'projects': ['demo'], 'hosts': ['node-a'],
            'callers': ['local-studio', 'paired-helper', 'native-agent'],
            'operations': ['submit', 'collect', 'status', 'watch', 'unwatch', 'resources_scan', 'runtime'], **changes}


def context(host='node-a'):
    return {'schema': 'ic.execution.context.v1', 'plan_id': PLAN, 'site': {'fixture': host},
            'resource_selection': {'host_id': host, 'recommendation': {'candidates': [
                {'host_id': host, 'resource_observed_at': TIME}]}}}


def run(host='node-a', **changes):
    return {'run_id': 'run-1', 'project_id': 'demo', 'source_commit': COMMIT,
            'configuration_id': 'tran', 'state': 'submitted', 'execution_context': context(host), **changes}


def diagnosis(*args, execution_state='unknown', exit_code=None, acceptance=None, **kwargs):
    return {'schema': 'spiceowl.spectre-diagnostics.v1', 'observed_context': {'execution_state': execution_state},
            'diagnostics': [{'category': 'unknown', 'severity': 'info', 'code': 'unclassified',
                             'evidence_line_numbers': [], 'redacted_excerpt': '', 'suggested_actions': []}],
            'scientific_acceptance': {'execution': execution_state,
                                     'data_validity': (acceptance or {}).get('data_validity', 'unknown'),
                                     'specification': (acceptance or {}).get('specification', 'unknown')},
            'agent_proposal': None, 'advisory_only': True}


class DeferredExecutor:
    def __init__(self):
        self.calls = []

    def submit(self, function, *args):
        future = concurrent.futures.Future()
        self.calls.append((function, args, future))
        return future

    def complete(self, index=0):
        function, args, future = self.calls[index]
        try:
            result = function(*args)
            future.set_result(result)
            return result
        except Exception as error:
            future.set_exception(error)
            raise


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'bundle.json'
        self.bundle.write_text('{}')
        self.runner = Mock()
        self.records, self.keys = {'run-1': run()}, {}
        self.runner.read.side_effect = lambda rid: copy.deepcopy(self.records[rid])
        self.runner.list.side_effect = lambda: copy.deepcopy(list(self.records.values()))
        self.runner.path.side_effect = lambda rid: self.root / 'runs' / rid
        self.runner.lookup_submission.side_effect = lambda key: self.keys.get(key)
        self.runner.execution_site.side_effect = lambda record: record['execution_context']['site']
        self.runner.status.side_effect = lambda rid: copy.deepcopy(self.records[rid])
        self.runner.dispatch.side_effect = lambda rid: copy.deepcopy(self.records[rid])
        self.runner.collect.return_value = {'state': 'collected'}
        self.executor = DeferredExecutor()
        self.backend = Mock()
        self.backend.scan_resources.return_value = {'schema': 'spiceowl.host-pool.snapshot.v1', 'checked_at': TIME,
            'hosts': [{'host_id': 'node-a', 'label': 'Fixture A', 'reachable': True, 'cpu_busy_percent': None,
                       'load_1m': None, 'cpu_count': None, 'memory_available_bytes': None,
                       'memory_total_bytes': None, 'observed_at': TIME, 'error_code': None}]}
        self.pool = Mock()
        self.pool.members = {'node-a': {}, 'node-b': {}}
        self.pool._backend.return_value = self.backend
        self.pool.prepare.side_effect = self.prepare
        self.pool.resolve.return_value = context()
        self.runner.reserve.side_effect = self.reserve
        self.app = types.SimpleNamespace(cfg={'runtime_root': str(self.root / 'runtime'), 'simulation_direct': scope()},
            workspace=types.SimpleNamespace(projects={'demo': {}}), runner=self.runner,
            resource_pool=self.pool, pool=self.executor, operations={}, identity=Mock(side_effect=self.materialize),
            public_job=lambda record: {key: record[key] for key in ('run_id', 'project_id', 'source_commit', 'state')},
            token='fixture-local-token', ai=None)
        self.app.web = self.root
        self.app.supervision = Mock()
        self.app.supervision.snapshot.side_effect = self.observations
        self.runtime = SimulationRuntime(self.app)
        self.runtime.derive_results = Mock()
        self.app.simulation = self.runtime
        self.monitor = Mock()
        self.monitor.watch.return_value = {'state': 'watching'}
        self.monitor.snapshot.return_value = None
        self.runtime.monitor = Mock(return_value=self.monitor)
        self.addCleanup(self.runtime.close)
        self._patch(patch.object(server.core, 'ssh', side_effect=AssertionError('No SSH in runtime fixture')))

    def _patch(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def prepare(self, runner, bundle, identity, *, host_ids):
        if not host_ids:
            raise ValueError('No allowed pool member')
        return {'execution_plan_id': PLAN}

    def materialize(self, args):
        if args != IDENTITY:
            raise ValueError('Materialization identity mismatch')
        return self.bundle

    def reserve(self, bundle, key, source, project, configuration, execution_context):
        self.records['run-1'] = run(execution_context=copy.deepcopy(execution_context))
        self.keys[key] = 'run-1'
        return copy.deepcopy(self.records['run-1']), True

    def observations(self, project):
        return {'runs': [{'run_id': record['run_id'], 'source_commit': record['source_commit'],
                         'configuration': record['configuration_id'], 'execution_target': execution_target(record),
                         'execution': {'state': 'failed', 'exit_code': 137}}
                        for record in self.records.values() if record['project_id'] == project]}

    def control(self, operation='submit', args=None, key='fixture-stable-key', caller='local-studio'):
        return self.runtime.control(operation, IDENTITY if args is None else args, key, caller)

    def install_diagnoser(self):
        module = types.ModuleType('spiceowl.integrations.spectre_diagnostics')
        module.diagnose_spectre = Mock(side_effect=diagnosis)
        self._patch(patch.dict(sys.modules, {'spiceowl.integrations.spectre_diagnostics': module}))
        return module.diagnose_spectre

    def assert_no_execution(self):
        self.runner.reserve.assert_not_called()
        self.runner.dispatch.assert_not_called()
        self.runner.collect.assert_not_called()
        self.assertEqual(self.executor.calls, [])

    def test_missing_or_disabled_scope_denies_every_mutating_operation(self):
        for configured in (None, scope(enabled=False)):
            self.runtime.scope = configured
            for operation in ('submit', 'collect', 'status', 'watch', 'unwatch', 'resources_scan'):
                args = {'project_id': 'demo'} if operation == 'resources_scan' else IDENTITY if operation == 'submit' else RUN_ARGS
                with self.subTest(operation=operation), self.assertRaises(PermissionError):
                    self.control(operation, args)
        self.assert_no_execution()
        self.pool.prepare.assert_not_called()

    def test_caller_project_and_operation_boundaries_stop_before_any_preparation(self):
        for configured, caller, args in [(scope(callers=['native-agent']), 'local-studio', IDENTITY),
                                        (scope(projects=['other']), 'local-studio', IDENTITY),
                                        (scope(operations=['status']), 'local-studio', IDENTITY)]:
            self.runtime.scope = configured
            with self.assertRaises(PermissionError):
                self.control(args=args, caller=caller)
        self.app.identity.assert_not_called()
        self.pool.prepare.assert_not_called()
        self.assert_no_execution()

    def test_arguments_cannot_inject_scope_caller_host_or_plan(self):
        for key, value in [('caller', 'native-agent'), ('scope', scope()), ('host_id', 'node-b'), ('execution_plan_id', PLAN)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.control(args=IDENTITY | {key: value})
        self.assert_no_execution()
        self.pool.prepare.assert_not_called()

    def test_new_submit_filters_pool_members_and_preserves_key(self):
        first = self.control()
        second = self.control()
        self.assertEqual(first, second)
        self.pool.prepare.assert_called_once_with(self.runner, self.bundle, IDENTITY, host_ids=['node-a'])
        self.pool.resolve.assert_called_once_with(PLAN, self.bundle, IDENTITY)
        self.assertEqual(self.runner.reserve.call_count, 1)
        self.assertEqual(self.runner.reserve.call_args.args[1], 'fixture-stable-key')
        self.assertEqual(len(self.executor.calls), 1)

    def test_resolved_context_outside_authorized_hosts_cannot_be_reserved(self):
        self.pool.resolve.return_value = context('node-b')
        with self.assertRaises(PermissionError):
            self.control()
        self.runner.reserve.assert_not_called()
        self.assertEqual(self.executor.calls, [])

    def test_same_key_unknown_or_terminal_run_does_not_reselect_or_relaunch(self):
        self.keys['fixture-stable-key'] = 'run-1'
        for state in ('launch_outcome_unknown', 'reconcile_required', 'submitted', 'simulator_failed', 'collected'):
            self.records['run-1']['state'] = state
            self.assertEqual(self.control()['state'], state)
        self.pool.prepare.assert_not_called()
        self.runner.reserve.assert_not_called()
        self.runner.dispatch.assert_not_called()
        self.assertEqual(self.executor.calls, [])

    def test_new_key_cannot_bypass_an_existing_unknown_submission(self):
        for state in ('launch_outcome_unknown', 'reconcile_required'):
            self.records['run-1']['state'] = state
            with self.subTest(state=state), self.assertRaises((PermissionError, ValueError)):
                self.control(key='replacement-unknown-key')
        self.pool.prepare.assert_not_called()
        self.assert_no_execution()

    def test_submit_configuration_or_source_mismatch_stops_before_selection(self):
        for field, value in [('source_commit', 'b' * 40), ('configuration', 'other')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.control(args=IDENTITY | {field: value})
        self.pool.prepare.assert_not_called()
        self.assert_no_execution()

    def test_historical_operations_require_project_source_configuration_and_host(self):
        for operation in ('status', 'watch', 'unwatch', 'collect'):
            for field, value in [('source_commit', 'c' * 40), ('configuration', 'other'), ('project_id', 'other')]:
                with self.subTest(operation=operation, field=field), self.assertRaises((PermissionError, ValueError)):
                    self.control(operation, RUN_ARGS | {field: value})
            self.records['run-1'] = run('node-b')
            with self.assertRaises(PermissionError):
                self.control(operation, RUN_ARGS)
            self.records['run-1'] = run()
        self.runner.status.assert_not_called()
        self.monitor.watch.assert_not_called()
        self.monitor.unwatch.assert_not_called()
        self.assert_no_execution()

    def test_collect_claims_original_run_only_once_even_with_different_later_keys(self):
        self.records['run-1']['remote_state'] = 'simulator_complete_pending_measurements'
        first = self.control('collect', RUN_ARGS)
        repeated = self.control('collect', RUN_ARGS, key='another-stable-key')
        self.assertEqual(first, repeated)
        self.assertEqual(first['run_id'], 'run-1')
        self.assertEqual(len(self.executor.calls), 1)
        self.assertEqual(self.executor.complete()['state'], 'complete')
        self.assertEqual(self.control('collect', RUN_ARGS)['state'], 'complete')
        self.runner.collect.assert_called_once_with('run-1')
        self.pool.prepare.assert_not_called()
        self.runner.dispatch.assert_not_called()

    def test_early_collection_does_not_claim_or_poison_later_terminal_collection(self):
        self.assertFalse(self.runtime.snapshot('demo')['runs'][0]['collectable'])
        with self.assertRaisesRegex(ValueError, 'terminal run'):
            self.control('collect', RUN_ARGS)
        self.assertFalse((self.runner.path('run-1')/'direct-collection.json').exists())
        self.assertEqual(self.executor.calls, [])
        self.records['run-1']['remote_state'] = 'simulator_failed'
        self.assertTrue(self.runtime.snapshot('demo')['runs'][0]['collectable'])
        self.assertEqual(self.control('collect', RUN_ARGS)['state'], 'collecting')
        self.assertEqual(self.executor.complete()['state'], 'complete')

    def test_uncertain_collection_never_collects_again_or_launches(self):
        self.records['run-1']['remote_state'] = 'simulator_complete_pending_measurements'
        self.runner.collect.side_effect = RuntimeError('Synthetic lost collection response')
        self.control('collect', RUN_ARGS)
        self.assertEqual(self.executor.complete()['state'], 'uncertain')
        self.assertEqual(self.control('collect', RUN_ARGS, key='new-key-ignored')['state'], 'uncertain')
        self.runner.collect.assert_called_once()
        self.assertEqual(len(self.executor.calls), 1)
        self.runner.dispatch.assert_not_called()

    def test_submit_only_grant_does_not_implicitly_start_watch(self):
        self.runtime.scope = scope(operations=['submit'])
        self.control()
        self.executor.complete()
        self.monitor.watch.assert_not_called()
        self.monitor.start.assert_not_called()

    def test_scan_is_explicit_deduplicates_active_request_and_cached_get_does_not_probe(self):
        self.install_diagnoser()
        for _ in range(2):
            self.runtime.snapshot('demo')
        self.backend.scan_resources.assert_not_called()
        self.runtime.scan('demo', 'local-studio')
        self.runtime.scan('demo', 'local-studio')
        self.assertEqual(len(self.executor.calls), 1)
        self.assertTrue(self.runtime.snapshot('demo')['pool']['scan_in_progress'])
        self.executor.complete()
        self.backend.scan_resources.assert_called_once_with(['node-a'])
        first = self.runtime.snapshot('demo')
        second = self.runtime.snapshot('demo')
        self.assertEqual(first['pool']['checked_at'], TIME)
        self.assertEqual(first['pool'], second['pool'])
        self.runner.status.assert_not_called()
        self.runner.dispatch.assert_not_called()
        self.runner.collect.assert_not_called()
        self.assertIsNone(self.runtime._monitor)

    def normalize_in_javascript(self, snapshot):
        node = os.environ.get('NODE_BINARY') or shutil.which('node')
        if not node:
            self.skipTest('Set NODE_BINARY to validate the actual JavaScript runtime contract')
        module = (ROOT / 'modules/simulation/runtime.js').as_uri()
        script = 'import {normalizeRuntimeSnapshot} from ' + json.dumps(module) + ';let input="";for await(const part of process.stdin)input+=part;normalizeRuntimeSnapshot(JSON.parse(input),"demo");console.log("valid");'
        result = subprocess.run([node, '--input-type=module', '-e', script], input=json.dumps(snapshot), text=True,
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_snapshot_diagnostics_and_acceptance_match_browser_contract_without_remote_calls(self):
        diagnose = self.install_diagnoser()
        folder = self.runner.path('run-1')
        folder.mkdir(parents=True)
        (folder / 'latest-status.log').write_text('Synthetic exit 137\n')
        self.records['run-1']['collection'] = {'sha256': 'e' * 64}
        (folder / 'waveform-validity.json').write_text(json.dumps({'data_validity': 'invalid', 'run_id': 'run-1',
            'source_commit': COMMIT, 'native_archive_sha256': 'e' * 64}))
        snapshot = self.runtime.snapshot('demo')
        self.assertEqual(snapshot['runs'][0]['acceptance'], snapshot['runs'][0]['diagnostics']['scientific_acceptance'])
        self.assertEqual(snapshot['runs'][0]['acceptance']['specification'], 'unknown')
        self.assertEqual(snapshot['runs'][0]['monitor']['state'], 'not_watched')
        diagnose.assert_called_once()
        self.normalize_in_javascript(snapshot)
        self.runner.status.assert_not_called()
        self.assert_no_execution()

    def test_missing_optional_diagnoser_still_returns_displayable_unknown_evidence(self):
        with patch.object(simulation_runtime.importlib, 'import_module', side_effect=ImportError('Unavailable optional package')):
            snapshot = self.runtime.snapshot('demo')
        self.normalize_in_javascript(snapshot)
        self.assertEqual(snapshot['runs'][0]['acceptance']['data_validity'], 'unknown')
        self.assertEqual(snapshot['runs'][0]['acceptance']['specification'], 'unknown')
        self.assert_no_execution()

    def test_actual_spiceowl_diagnostics_normalize_and_redact_private_log_evidence(self):
        source = os.environ.get('SPICEOWL_SOURCE_DIR')
        if not source:
            self.skipTest('Set SPICEOWL_SOURCE_DIR to validate the actual diagnostics integration')
        self.assertTrue((Path(source) / 'spiceowl/integrations/spectre_diagnostics.py').is_file())
        folder = self.runner.path('run-1')
        folder.mkdir(parents=True)
        (folder / 'latest-status.log').write_text('ERROR (SFE-23): /PRIVATE/model.scs references undefined model PRIVATE_NAME.\nFATAL: Memory allocation failed.\n')
        self.records['run-1']['collection'] = {'sha256': 'e' * 64}
        (folder / 'waveform-validity.json').write_text(json.dumps({'data_validity': 'invalid', 'run_id': 'run-1',
            'source_commit': COMMIT, 'native_archive_sha256': 'e' * 64}))
        with patch.object(sys, 'path', [source, *sys.path]), patch.dict(sys.modules):
            snapshot = self.runtime.snapshot('demo')
        row = snapshot['runs'][0]
        self.assertEqual([finding['category'] for finding in row['diagnostics']['diagnostics']], ['model_missing', 'oom'])
        self.assertEqual(row['acceptance'], {'execution': 'failed', 'data_validity': 'invalid', 'specification': 'unknown'})
        self.assertNotIn('PRIVATE', json.dumps(snapshot))
        self.normalize_in_javascript(snapshot)
        self.runner.status.assert_not_called()
        self.assert_no_execution()


class RuntimeHttpTests(RuntimeTests):
    # Run only HTTP-specific methods here; unittest would otherwise duplicate the base cases.
    def setUp(self):
        super().setUp()
        self.install_diagnoser()
        self.http = server.Server(('127.0.0.1', 0), server.Handler)
        self.http.app = self.app
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=.02), daemon=True)
        self.thread.start()
        self.addCleanup(self.close_http)
        self.origin = 'http://127.0.0.1:' + str(self.http.server_port)

    def close_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(2)

    def request(self, path, body=None, headers=None):
        values = {'Origin': self.origin, 'Content-Type': 'application/json', 'X-Workbench-Token': self.app.token}
        values.update(headers or {})
        conn = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=3)
        conn.request('GET' if body is None else 'POST', path, body=None if body is None else json.dumps(body), headers=values)
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def install_authority(self):
        source = os.environ.get('SPICEOWL_SOURCE_DIR')
        if not source:
            self.skipTest('Set SPICEOWL_SOURCE_DIR to exercise actual SpiceOwl HMAC integration')
        path = Path(source) / 'spiceowl/integrations/authority.py'
        self.assertTrue(path.is_file(), 'SPICEOWL_SOURCE_DIR must contain spiceowl/integrations/authority.py')
        spec = importlib.util.spec_from_file_location('spiceowl.integrations.authority', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self._patch(patch.dict(sys.modules, {'spiceowl.integrations.authority': module}))
        key_path = self.root / 'authority.key'
        key_path.write_bytes(b'k' * 32)
        key_path.chmod(0o600)
        self.runtime.scope = scope(callers=['native-agent'], authority_key_file=str(key_path))
        return module, key_path

    def signed_headers(self, module, body, *, method='POST', path='/api/simulation/control', caller='native-agent', timestamp=None):
        return {'X-IC-Simulation-Caller': caller,
                'X-IC-Simulation-Authorization': module.sign(b'k' * 32, caller, method, path,
                    json.dumps(body).encode(), timestamp=timestamp)}

    def test_http_body_cannot_supply_caller_or_authority_scope(self):
        command = {'operation': 'submit', 'arguments': IDENTITY, 'idempotency_key': 'http-fixture-key'}
        for key, value in [('caller', 'native-agent'), ('scope', scope()), ('caller_id', 'native-agent')]:
            status, result = self.request('/api/simulation/control', command | {key: value})
            self.assertEqual(status, 400, result)
        self.assert_no_execution()

    def test_http_unsigned_caller_header_cannot_elevate_local_studio(self):
        self.runtime.scope = scope(callers=['native-agent'])
        command = {'operation': 'submit', 'arguments': IDENTITY, 'idempotency_key': 'http-fixture-key'}
        status, result = self.request('/api/simulation/control', command,
                                      headers={'X-IC-Simulation-Caller': 'native-agent'})
        self.assertEqual(status, 403, result)
        self.assert_no_execution()

    def test_http_valid_authority_is_required_in_addition_to_browser_origin_and_token(self):
        module, _ = self.install_authority()
        command = {'operation': 'submit', 'arguments': IDENTITY, 'idempotency_key': 'http-signed-fixture-key'}
        status, result = self.request('/api/simulation/control', command)
        self.assertEqual(status, 403, result)
        self.assert_no_execution()
        status, result = self.request('/api/simulation/control', command, self.signed_headers(module, command))
        self.assertEqual(status, 202, result)
        self.assertEqual(result['data']['run_id'], 'run-1')
        self.assertEqual(self.runner.reserve.call_count, 1)

    def test_http_authority_binds_caller_method_path_and_exact_body(self):
        module, _ = self.install_authority()
        command = {'operation': 'submit', 'arguments': IDENTITY, 'idempotency_key': 'http-signed-fixture-key'}
        cases = [({'method': 'GET'}, command), ({'path': '/api/simulation/resources/scan'}, command),
                 ({}, command | {'idempotency_key': 'tampered-action-key'})]
        for settings, sent in cases:
            headers = self.signed_headers(module, command, **settings)
            status, result = self.request('/api/simulation/control', sent, headers)
            self.assertEqual(status, 403, result)
        headers = self.signed_headers(module, command)
        headers['X-IC-Simulation-Caller'] = 'paired-helper'
        self.assertEqual(self.request('/api/simulation/control', command, headers)[0], 403)
        self.assert_no_execution()

    def test_http_expired_authority_is_rejected_without_execution(self):
        module, _ = self.install_authority()
        command = {'operation': 'submit', 'arguments': IDENTITY, 'idempotency_key': 'http-signed-fixture-key'}
        status, result = self.request('/api/simulation/control', command,
            self.signed_headers(module, command, timestamp=int(time.time()) - 121))
        self.assertEqual(status, 403, result)
        self.assert_no_execution()

    def test_real_gateway_signer_and_runtime_verifier_interoperate(self):
        _, key_path = self.install_authority()
        client = Gateway(self.origin)
        command = {'operation': 'submit', 'arguments': IDENTITY, 'idempotency_key': 'http-signed-fixture-key'}
        result = client.request('/api/simulation/control', command, caller_id='native-agent', authority_key_file=str(key_path))
        self.assertEqual(result['run_id'], 'run-1')
        self.assertEqual(self.runner.reserve.call_count, 1)

    def test_http_cached_get_is_passive_and_scan_requires_explicit_post(self):
        for _ in range(2):
            status, result = self.request('/api/simulation/runtime?project_id=demo')
            self.assertEqual(status, 200, result)
        self.backend.scan_resources.assert_not_called()
        self.assertEqual(len(self.executor.calls), 0)
        status, result = self.request('/api/simulation/resources/scan', {'project_id': 'demo'})
        self.assertEqual(status, 202, result)
        self.assertEqual(len(self.executor.calls), 1)
        self.executor.complete()
        self.backend.scan_resources.assert_called_once_with(['node-a'])


# Share setup/helpers without rerunning all parent tests with an HTTP server.
for _name in list(RuntimeTests.__dict__):
    if _name.startswith('test_'):
        setattr(RuntimeHttpTests, _name, None)


if __name__ == '__main__':
    unittest.main()
