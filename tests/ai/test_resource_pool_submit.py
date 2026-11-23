"""Frozen selection across Service preparation and synthetic human decisions."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'modules/gateway_client'))
from ic_gateway.service import Failure, Service
sys.path.insert(0, str(ROOT / 'tools/ci'))
from spectre_request import perform

COMMIT, PLAN = 'a' * 40, 'b' * 64
IDENTITY = {'project_id': 'demo', 'configuration': 'tran', 'source_commit': COMMIT}
ARGS = {**IDENTITY, 'idempotency_key': 'original-fixture-key'}


class FakeGateway:
    origin = 'http://127.0.0.1:1'

    def __init__(self):
        self.calls = []
        self.pool = True
        self.plan = PLAN
        self.target_plan = PLAN
        self.source = COMMIT
        self.preflight_error = self.submit_error = None
        self.jobs = [{'run_id': 'fixture-run', 'project_id': 'demo', 'configuration': 'tran', 'source_commit': COMMIT}]

    def request(self, path, body=None):
        self.calls.append((path, copy.deepcopy(body)))
        if path == '/api/project':
            return {'source_commit': COMMIT, 'projects': [{'id': 'demo', 'configurations': [{'id': 'tran'}]}]}
        if path == '/api/plan':
            return {**IDENTITY, 'resource_selection_required': self.pool}
        if path == '/api/preflight':
            if self.preflight_error:
                raise self.preflight_error
            return {'execution_plan_id': self.plan, 'execution_target': {'mode': 'resource_pool', 'host_id': 'node-a', 'plan_id': self.target_plan},
                    'plan': {'provenance': {'source_commit': self.source}}}
        if path == '/api/jobs':
            if body is None:
                return {'jobs': copy.deepcopy(self.jobs)}
            if self.submit_error:
                raise self.submit_error
            return {'run_id': 'fixture-run', 'state': 'queued'}
        if path == '/api/jobs/fixture-run/results':
            return {'job_id': 'fixture-run', 'state': 'not_collected'}
        raise AssertionError('Unexpected gateway request: ' + path)

    def requests(self, path):
        return [body for route, body in self.calls if route == path]


class PoolSubmitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = {'gateway_url': FakeGateway.origin, 'state_dir': self.temp.name}
        self.service = Service(self.config)
        self.gateway = FakeGateway()
        self.service.gateway = self.gateway

    def prepare(self, args=None):
        return self.service.call('sim_submit', args or ARGS)

    def test_prepare_selects_once_and_review_contains_frozen_plan(self):
        prepared = self.prepare()
        self.assertEqual(prepared['state'], 'pending_approval')
        self.assertEqual(prepared['review']['execution_plan_id'], PLAN)
        self.assertEqual(prepared['review']['execution_target']['plan_id'], PLAN)
        self.assertNotIn('body', prepared)
        self.assertFalse(prepared['automatic_retry'])
        saved = self.service.saved('requests', prepared['request_id'])
        self.assertEqual(saved['body'], {**ARGS, 'execution_plan_id': PLAN})
        again = self.prepare()
        self.assertEqual(again['request_id'], prepared['request_id'])
        self.assertEqual(self.gateway.requests('/api/preflight'), [IDENTITY])
        self.assertEqual(self.gateway.requests('/api/jobs'), [])

    def test_approval_uses_same_token_and_key_even_after_gateway_changes(self):
        prepared = self.prepare()
        self.gateway.plan = self.gateway.target_plan = 'c' * 64
        accepted = self.service.resolve(prepared['request_id'], 'approve', prepared['fingerprint'])
        self.assertEqual(accepted['state'], 'accepted')
        self.assertEqual(self.gateway.requests('/api/jobs'), [{**ARGS, 'execution_plan_id': PLAN}])
        self.assertEqual(len(self.gateway.requests('/api/preflight')), 1)
        self.service.resolve(prepared['request_id'], 'approve', prepared['fingerprint'])
        self.prepare()
        self.assertEqual(len(self.gateway.requests('/api/jobs')), 1)
        self.assertEqual(len(self.gateway.requests('/api/preflight')), 1)

    def test_denial_never_submits_or_reselects(self):
        prepared = self.prepare()
        denied = self.service.resolve(prepared['request_id'], 'deny', prepared['fingerprint'])
        self.assertEqual(denied['state'], 'denied')
        self.assertEqual(self.prepare()['state'], 'denied')
        self.service.resolve(prepared['request_id'], 'approve', prepared['fingerprint'])
        self.assertEqual(self.gateway.requests('/api/jobs'), [])
        self.assertEqual(len(self.gateway.requests('/api/preflight')), 1)

    def test_dispatch_unknown_or_rejection_never_reselects(self):
        for error, state in [(Failure('transport_unknown', 'Synthetic lost response', 75), 'uncertain'),
                             (Failure('rejected', 'Synthetic stale resource', 2, {'http_status': 400}), 'rejected')]:
            with self.subTest(state=state):
                local = Service({**self.config, 'state_dir': str(Path(self.temp.name) / state)})
                gateway = FakeGateway()
                local.gateway = gateway
                prepared = local.call('sim_submit', ARGS)
                gateway.submit_error = error
                result = local.resolve(prepared['request_id'], 'approve', prepared['fingerprint'])
                self.assertEqual(result['state'], state)
                local.resolve(prepared['request_id'], 'approve', prepared['fingerprint'])
                local.call('sim_submit', ARGS)
                self.assertEqual(gateway.requests('/api/jobs'), [{**ARGS, 'execution_plan_id': PLAN}])
                self.assertEqual(len(gateway.requests('/api/preflight')), 1)

    def test_restart_keeps_the_frozen_token(self):
        prepared = self.prepare()
        fresh = Service(self.config)
        fresh.gateway = self.gateway
        fresh.resolve(prepared['request_id'], 'approve', prepared['fingerprint'])
        self.assertEqual(self.gateway.requests('/api/jobs'), [{**ARGS, 'execution_plan_id': PLAN}])
        self.assertEqual(len(self.gateway.requests('/api/preflight')), 1)

    def test_new_key_cannot_bypass_pending_selection(self):
        self.prepare()
        with self.assertRaises(Failure) as error:
            self.prepare(ARGS | {'idempotency_key': 'replacement-fixture-key'})
        self.assertEqual(error.exception.code, 'unresolved_prior_request')
        self.assertEqual(len(self.gateway.requests('/api/preflight')), 1)

    def test_mismatched_preflight_target_is_rejected_before_approval(self):
        self.gateway.target_plan = 'c' * 64
        with self.assertRaises(Failure):
            self.prepare()
        self.assertEqual(self.gateway.requests('/api/jobs'), [])

    def test_failed_preflight_has_no_pending_approval_or_submission(self):
        self.gateway.preflight_error = Failure('transport_unknown', 'Synthetic preflight response lost', 75)
        with self.assertRaises(Failure):
            self.prepare()
        self.assertEqual(len(self.gateway.requests('/api/preflight')), 1)
        self.assertEqual(list((self.service.state / 'requests').glob('*.json')), [])
        # No dispatch was prepared. A separate explicit prepare may check again.
        with self.assertRaises(Failure):
            self.prepare()
        self.assertEqual(len(self.gateway.requests('/api/preflight')), 2)
        self.assertEqual(list((self.service.state / 'requests').glob('*.json')), [])
        self.assertEqual(self.gateway.requests('/api/jobs'), [])

    def test_invalid_plan_token_or_source_never_submits(self):
        for token, source in [('bad-token', COMMIT), (PLAN, 'c' * 40)]:
            with self.subTest(token=token, source=source):
                local = Service({**self.config, 'state_dir': str(Path(self.temp.name) / ('bad-' + token[:4] + source[:2]))})
                gateway = FakeGateway()
                gateway.plan, gateway.source = token, source
                local.gateway = gateway
                with self.assertRaises(Failure):
                    local.call('sim_submit', ARGS)
                self.assertEqual(gateway.requests('/api/jobs'), [])

    def test_fixed_site_preparation_keeps_legacy_body_and_no_pool_preflight(self):
        self.gateway.pool = False
        prepared = self.prepare()
        self.assertEqual(self.service.saved('requests', prepared['request_id'])['body'], ARGS)
        self.service.resolve(prepared['request_id'], 'approve', prepared['fingerprint'])
        self.assertEqual(self.gateway.requests('/api/jobs'), [ARGS])
        self.assertEqual(self.gateway.requests('/api/preflight'), [])


class OperatorPoolIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = Service({'gateway_url': FakeGateway.origin, 'state_dir': self.temp.name})
        self.gateway = FakeGateway()
        self.service.gateway = self.gateway
        self.settings = {'testbenches': {'fixture': {'project_id': 'demo', 'configuration': 'tran'}}}

    def perform(self, operation, run_id=''):
        return perform(self.settings, 'fixture', COMMIT, operation, run_id, '12345', self.service)

    def test_operator_submit_reuses_real_service_frozen_plan_and_never_approves(self):
        with patch.object(self.service, 'resolve', side_effect=AssertionError('Operator must not approve')):
            first, code = self.perform('submit')
            second, second_code = self.perform('submit')
        self.assertEqual((code, second_code), (10, 10))
        self.assertEqual(first['state'], 'pending_approval')
        self.assertFalse(first['automatic_approval'])
        self.assertFalse(first['simulation_started'])
        self.assertEqual(first['request_id'], second['request_id'])
        receipt = self.service.saved('requests', first['request_id'])
        self.assertEqual(receipt['body']['execution_plan_id'], PLAN)
        self.assertRegex(receipt['body']['idempotency_key'], '^github-ci-[a-f0-9]{64}$')
        self.assertEqual(receipt['arguments']['idempotency_key'], receipt['body']['idempotency_key'])
        self.assertEqual(self.gateway.requests('/api/preflight'), [IDENTITY])
        self.assertEqual(self.gateway.requests('/api/jobs'), [])

    def test_operator_collect_prepares_existing_run_review_without_pool_reselection(self):
        with patch.object(self.service, 'resolve', side_effect=AssertionError('Operator must not approve')):
            report, code = self.perform('collect', 'fixture-run')
        self.assertEqual(code, 10)
        self.assertEqual(report['state'], 'pending_approval')
        receipt = self.service.saved('requests', report['request_id'])
        self.assertEqual(receipt['operation'], 'sim_collect')
        self.assertEqual(receipt['arguments']['run_id'], 'fixture-run')
        self.assertEqual(receipt['route'], '/api/jobs/fixture-run/collect')
        self.assertEqual([path for path, _ in self.gateway.calls], ['/api/jobs', '/api/jobs/fixture-run/results'])
        self.assertTrue(all(body is None for _, body in self.gateway.calls))

    def test_operator_results_only_reads_metadata_without_approval_or_new_selection(self):
        report, code = self.perform('results', 'fixture-run')
        self.assertEqual(code, 0)
        self.assertEqual(report['status'], 'observed')
        self.assertEqual(report['simulation_status'], 'not_evaluated')
        self.assertFalse(report['simulation_started'])
        self.assertEqual([path for path, _ in self.gateway.calls], ['/api/jobs', '/api/jobs/fixture-run/results'])
        self.assertEqual(list((self.service.state / 'requests').glob('*.json')), [])

    def test_operator_collect_and_results_require_exact_unique_historical_identity(self):
        valid = copy.deepcopy(self.gateway.jobs[0])
        invalid = [[valid | {'project_id': 'other'}], [valid | {'source_commit': 'd' * 40}],
                   [valid | {'configuration': 'other'}], [valid | {'configuration': None}],
                   [valid, copy.deepcopy(valid)], []]
        for operation in ('collect', 'results'):
            for records in invalid:
                with self.subTest(operation=operation, records=records):
                    self.gateway.jobs = records
                    self.gateway.calls.clear()
                    with self.assertRaises(ValueError):
                        self.perform(operation, 'fixture-run')
                    self.assertEqual(self.gateway.calls, [('/api/jobs', None)])
                    self.assertEqual(list((self.service.state / 'requests').glob('*.json')), [])


if __name__ == '__main__':
    unittest.main()
