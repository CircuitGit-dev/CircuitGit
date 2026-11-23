"""Loopback HTTP contract tests using signed resource plans and fake execution."""
import copy
import hashlib
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch

import server
from spiceowl_pool import canonical


COMMIT = 'a' * 40
IDENTITY = {'project_id': 'demo', 'configuration': 'tran', 'source_commit': COMMIT}


class PoolHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'bundle.json'
        self.bundle.write_text('{"fixture":true}')
        self.site = {'schema': 'ic.sim.site.v1', 'ssh_target': 'fixture-route',
                     'remote_runs_root': '/fixture/ic_on_github_runs', 'cadence_cshrc': '/fixture/setup',
                     'spectre_bin': '/fixture/spectre', 'external_files': {},
                     'expected_host': 'fixture-host', 'expected_user': 'fixture-user'}
        site_path = self.root / 'site.json'
        site_path.write_text(json.dumps(self.site))
        requirement = {'cpu_count': 1, 'memory_bytes': 1024**3, 'simulator': 'spectre'}
        config_path = self.root / 'pool.json'
        config_path.write_text(json.dumps({'schema': 'ic.spiceowl-pool.v1', 'spiceowl_data_dir': str(self.root / 'owl'),
                                          'requirements': requirement,
                                          'members': [{'host_id': 'node-a', 'site_file': str(site_path)}]}))
        profile = {'schema': 'spiceowl.host.v1', 'host_id': 'node-a', 'label': 'Fixture A',
                   'ssh_target': 'fixture-route', 'expected_host': 'fixture-host', 'expected_user': 'fixture-user',
                   'tools': [{'kind': 'spectre', 'executable': '/fixture/spectre'}]}
        self.selection = {'schema': 'spiceowl.resource-selection.v1', 'host_id': 'node-a',
                          'requirements': requirement, 'selected_at': '2026-11-23T00:00:00+00:00',
                          'profile': profile, 'profile_sha256': hashlib.sha256(canonical(profile)).hexdigest(),
                          'simulator_version': '25.1.0', 'recommendation': {
                              'recommended_host_id': 'node-a', 'evaluated_at': '2026-11-23T00:00:00+00:00',
                              'candidates': [{'host_id': 'node-a', 'resource_observed_at': '2026-11-23T00:00:00+00:00'}],
                              'excluded': []}}
        self.backend = Mock()
        self.backend.select.side_effect = lambda *args: copy.deepcopy(self.selection)
        external = types.ModuleType('spiceowl.integrations.circuitgit_pool')
        self.factory = Mock(return_value=self.backend)
        external.CircuitGitPool = self.factory
        self.start(patch.dict(sys.modules, {'spiceowl.integrations.circuitgit_pool': external}))
        self.runner = Mock()
        simulator = {'profile': 'spectre-default', 'args': ['-64'], 'output_format': 'psfxl'}
        self.runner.plan.return_value = {'provenance': {'source_commit': COMMIT, 'files': []},
                                         'simulator': copy.deepcopy(simulator), 'blockers': []}
        self.runner.preflight.return_value = {'plan': {'provenance': {'source_commit': COMMIT},
                                                      'simulator': copy.deepcopy(simulator)}, 'probe': {'identity_ok': True}}
        self.runner.path.side_effect = lambda run_id: self.root / 'runs' / run_id
        self.record = {'run_id': 'fixture-run', 'job_id': 'fixture-run', 'source_commit': COMMIT,
                       'project_id': 'demo', 'configuration_id': 'tran', 'state': 'queued',
                       'plan': {'design_id': 'demo'}, 'collection': None, 'publication': None}
        self.runner.reserve.return_value = (self.record, False)
        workspace = Mock()
        workspace.projects = {'demo': {}}
        workspace.materialize.return_value = self.bundle
        self.start(patch.object(server, 'Workspace', return_value=workspace))
        self.start(patch.object(server, 'Runner', return_value=self.runner))
        for name in ('Publisher', 'Geometry', 'Supervision', 'WaveformService'):
            self.start(patch.object(server, name))
        self.start(patch.object(server.core, 'ssh', side_effect=AssertionError('No SSH in HTTP tests')))
        cfg = {'runtime_root': str(self.root / 'runtime'), 'site_file': str(site_path),
               'spiceowl_pool_file': str(config_path)}
        self.app = server.Application(cfg, self.root)
        self.addCleanup(self.app.pool.shutdown, True)
        self.http = server.Server(('127.0.0.1', 0), server.Handler)
        self.http.app = self.app
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=.02), daemon=True)
        self.thread.start()
        self.addCleanup(self.close_http)
        self.origin = 'http://127.0.0.1:' + str(self.http.server_port)

    def start(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def close_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(2)

    def request(self, path, body, **overrides):
        headers = {'Origin': self.origin, 'X-Workbench-Token': self.app.token, 'Content-Type': 'application/json'}
        headers.update(overrides)
        headers = {key: value for key, value in headers.items() if value is not None}
        connection = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=3)
        connection.request('POST', path, body=json.dumps(body), headers=headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def preflight(self):
        status, result = self.request('/api/preflight', IDENTITY)
        self.assertEqual(status, 200, result)
        return result['data']

    def test_pool_construction_and_plan_do_not_probe_or_select(self):
        self.factory.assert_not_called()
        status, result = self.request('/api/plan', IDENTITY)
        self.assertEqual(status, 200, result)
        self.assertEqual(result['data']['execution_mode'], 'resource_pool')
        self.assertTrue(result['data']['resource_selection_required'])
        self.runner.plan.assert_called_once_with(self.bundle, COMMIT)
        self.runner.preflight.assert_not_called()
        self.backend.select.assert_not_called()
        self.factory.assert_not_called()

    def test_preflight_prepares_a_plan_but_does_not_reserve(self):
        result = self.preflight()
        self.assertRegex(result['execution_plan_id'], '^[a-f0-9]{64}$')
        self.assertEqual(result['execution_target']['plan_id'], result['execution_plan_id'])
        self.backend.select.assert_called_once()
        self.runner.preflight.assert_called_once_with(self.bundle, COMMIT, site=self.site)
        self.runner.reserve.assert_not_called()
        self.runner.dispatch.assert_not_called()

    def test_jobs_require_plan_and_resolve_before_reserve(self):
        body = {**IDENTITY, 'idempotency_key': 'same-fixture-key'}
        status, _ = self.request('/api/jobs', body)
        self.assertEqual(status, 400)
        self.runner.reserve.assert_not_called()
        prepared = self.preflight()
        body['execution_plan_id'] = prepared['execution_plan_id']
        for _ in range(2):
            status, result = self.request('/api/jobs', body)
            self.assertEqual(status, 202, result)
        self.assertEqual(self.runner.reserve.call_count, 2)
        args, kwargs = self.runner.reserve.call_args
        self.assertEqual(args, (self.bundle, 'same-fixture-key', COMMIT, 'demo', 'tran'))
        self.assertEqual(kwargs['execution_context']['plan_id'], body['execution_plan_id'])
        self.assertEqual(kwargs['execution_context']['site'], self.site)
        self.backend.select.assert_called_once()
        self.backend.recheck.assert_not_called()
        self.runner.dispatch.assert_not_called()

    def test_new_reservation_dispatches_once_with_no_second_selection(self):
        result = self.preflight()
        self.runner.reserve.side_effect = [(self.record, True), (self.record, False)]
        body = {**IDENTITY, 'idempotency_key': 'same-fixture-key', 'execution_plan_id': result['execution_plan_id']}
        for _ in range(2):
            status, response = self.request('/api/jobs', body)
            self.assertEqual(status, 202, response)
        self.app.operations['fixture-run'].result(timeout=2)
        self.runner.dispatch.assert_called_once_with('fixture-run')
        self.backend.select.assert_called_once()

    def test_invalid_signature_or_identity_never_reaches_reserve(self):
        result = self.preflight()
        body = {**IDENTITY, 'idempotency_key': 'fixture-key', 'execution_plan_id': result['execution_plan_id']}
        for field, value in [('source_commit', 'b' * 40), ('configuration', 'other'), ('project_id', 'other'),
                             ('execution_plan_id', 'not-a-plan')]:
            status, response = self.request('/api/jobs', body | {field: value})
            self.assertEqual(status, 400, response)
        path = self.app.resource_pool.root / (result['execution_plan_id'] + '.json')
        signed = json.loads(path.read_text())
        signed['data']['site']['ssh_target'] = 'changed'
        path.write_text(json.dumps(signed))
        status, response = self.request('/api/jobs', body)
        self.assertEqual(status, 400, response)
        self.runner.reserve.assert_not_called()
        self.backend.select.assert_called_once()

    def test_jobs_security_guards_run_before_materialization_and_reservation(self):
        result = self.preflight()
        body = {**IDENTITY, 'idempotency_key': 'fixture-key', 'execution_plan_id': result['execution_plan_id']}
        self.app.workspace.materialize.reset_mock()
        cases = [{'Origin': 'https://elsewhere.invalid'}, {'Origin': None}, {'X-Workbench-Token': 'wrong'},
                 {'X-Workbench-Token': None}, {'Sec-Fetch-Site': 'cross-site'}, {'Host': 'elsewhere.invalid'}]
        for headers in cases:
            status, response = self.request('/api/jobs', body, **headers)
            self.assertEqual(status, 403, response)
        self.app.workspace.materialize.assert_not_called()
        self.runner.reserve.assert_not_called()
        self.backend.select.assert_called_once()

    def test_fixed_site_mode_remains_token_free(self):
        self.app.resource_pool = None
        status, result = self.request('/api/plan', IDENTITY)
        self.assertEqual(status, 200, result)
        self.assertFalse(result['data']['resource_selection_required'])
        self.assertEqual(result['data']['execution_mode'], 'fixed_site')
        status, result = self.request('/api/preflight', IDENTITY)
        self.assertEqual(status, 200, result)
        self.runner.preflight.assert_called_once_with(self.bundle, COMMIT)
        body = {**IDENTITY, 'idempotency_key': 'legacy-key'}
        status, result = self.request('/api/jobs', body)
        self.assertEqual(status, 202, result)
        self.assertIsNone(self.runner.reserve.call_args.kwargs['execution_context'])
        self.runner.reserve.reset_mock()
        status, result = self.request('/api/jobs', body | {'execution_plan_id': 'b' * 64})
        self.assertEqual(status, 400, result)
        self.runner.reserve.assert_not_called()
        self.backend.select.assert_not_called()

    def test_failed_selection_never_falls_back_to_default_site(self):
        self.backend.select.side_effect = ValueError('No eligible host')
        status, result = self.request('/api/preflight', IDENTITY)
        self.assertEqual(status, 400, result)
        self.backend.select.assert_called_once()
        self.runner.preflight.assert_not_called()
        self.runner.reserve.assert_not_called()


if __name__ == '__main__':
    unittest.main()
