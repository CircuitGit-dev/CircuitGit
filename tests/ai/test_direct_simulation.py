"""Trusted direct adapter grants, durable uncertainty, and manual-key isolation."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'modules/gateway_client'))
from ic_gateway.service import Failure, Service, Gateway
sys.path.insert(0, str(ROOT / 'tools/workbench'))
from simulation_runtime import SimulationRuntime

COMMIT = 'a' * 40
IDENTITY = {'project_id': 'demo', 'configuration': 'tran', 'source_commit': COMMIT}
RUN_ARGS = {**IDENTITY, 'run_id': 'fixture-run'}
KEY = 'direct-fixture-key'


def scope(**changes):
    return {'enabled': True, 'projects': ['demo'], 'hosts': ['node-a'],
            'callers': ['paired-helper', 'native-agent'],
            'operations': ['submit', 'collect', 'status', 'watch', 'unwatch', 'resources_scan', 'runtime'],
            **changes}


class FakeGateway:
    origin = 'http://127.0.0.1:1'

    def __init__(self):
        self.calls = []
        self.error = None
        self.control = None

    def request(self, path, body=None, **authority):
        self.calls.append((path, copy.deepcopy(body), copy.deepcopy(authority)))
        if path == '/api/simulation/control':
            if self.error:
                raise self.error
            if self.control:
                try:
                    return self.control(body['operation'], body['arguments'], body.get('idempotency_key'), authority['caller_id'])
                except PermissionError as error:
                    raise Failure('forbidden', str(error), 4, {'http_status': 403}) from error
                except ValueError as error:
                    raise Failure('invalid_input', str(error), 2, {'http_status': 400}) from error
            return {'run_id': 'fixture-run', 'state': 'submitted'}
        if path.startswith('/api/simulation/runtime?'):
            return {'schema': 'ic.simulation.runtime.v1', 'runs': [], 'pool': {'hosts': []}}
        if path == '/api/project':
            return {'source_commit': COMMIT, 'projects': [{'id': 'demo', 'configurations': [{'id': 'tran'}]}]}
        if path == '/api/plan':
            return {**IDENTITY, 'resource_selection_required': False}
        if path == '/api/jobs' and body is None:
            return {'jobs': [dict(RUN_ARGS)]}
        if path == '/api/jobs/fixture-run/results':
            return {'state': 'not_collected'}
        raise AssertionError('Unexpected gateway request: ' + path)

    def controls(self):
        return [value for value in self.calls if value[0] == '/api/simulation/control']


class DirectSimulationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.key_file = Path(self.temp.name) / 'authority.key'
        self.key_file.write_bytes(b'k' * 32)
        self.key_file.chmod(0o600)
        self.config = {'gateway_url': FakeGateway.origin, 'state_dir': str(Path(self.temp.name) / 'state'),
                       'simulation_direct': scope(authority_key_file=str(self.key_file))}
        self.service = Service(self.config)
        self.gateway = FakeGateway()
        self.service.gateway = self.gateway

    def execute(self, operation='submit', arguments=None, key=KEY, caller='paired-helper'):
        return self.service.execute_simulation(operation, IDENTITY if arguments is None else arguments, key, caller_id=caller)

    def test_missing_disabled_or_mismatched_local_grants_never_contact_gateway(self):
        for grant in (None, {}, scope(enabled=False), scope(callers=['native-agent']),
                      scope(projects=['other']), scope(operations=['status'])):
            with self.subTest(grant=grant), self.assertRaises(Failure) as error:
                self.service.config['simulation_direct'] = grant
                self.execute()
            self.assertEqual(error.exception.code, 'forbidden')
        self.assertEqual(self.gateway.calls, [])

    def test_installed_disabled_operations_override_grant(self):
        for name in ('sim_execute', 'sim_submit'):
            self.service.disabled = {name}
            with self.subTest(name=name), self.assertRaises(Failure):
                self.execute()
        self.assertEqual(self.gateway.calls, [])

    def test_allowed_call_forwards_only_finite_body_with_trusted_caller_and_key_path(self):
        receipt = self.execute()
        self.assertEqual(receipt['state'], 'accepted')
        self.assertEqual(receipt['authorization_basis'], 'installed_connection_grant')
        self.assertFalse(receipt['automatic_retry'])
        self.assertEqual(self.gateway.controls(), [('/api/simulation/control',
            {'operation': 'submit', 'arguments': IDENTITY, 'idempotency_key': KEY},
            {'caller_id': 'paired-helper', 'authority_key_file': str(self.key_file)})])
        self.assertNotIn(str(self.key_file), json.dumps(receipt))

    def test_argument_scope_caller_host_command_or_key_path_cannot_be_injected(self):
        for key in ('caller_id', 'caller', 'scope', 'simulation_direct', 'authority_key_file', 'host_id', 'command'):
            with self.subTest(key=key), self.assertRaises(Failure):
                self.execute(arguments=IDENTITY | {key: 'untrusted-value'})
        self.assertEqual(self.gateway.calls, [])

    def test_identity_fields_are_complete_and_well_formed_before_dispatch(self):
        invalid = [{k: v for k, v in IDENTITY.items() if k != missing} for missing in IDENTITY]
        invalid += [IDENTITY | {'source_commit': 'latest'}, IDENTITY | {'configuration': 'tran; run'},
                    IDENTITY | {'project_id': '../other'}, IDENTITY | {'run_id': 'fixture-run'}]
        for arguments in invalid:
            with self.subTest(arguments=arguments), self.assertRaises(Failure):
                self.execute(arguments=arguments)
        self.assertEqual(self.gateway.calls, [])

    def test_submit_and_collect_require_original_stable_key(self):
        for operation, args in [('submit', IDENTITY), ('collect', RUN_ARGS)]:
            for key in (None, '', 'short', 'x' * 161, 'invalid\nkey'):
                with self.subTest(operation=operation, key=key), self.assertRaises(Failure):
                    self.execute(operation, args, key)
        self.assertEqual(self.gateway.calls, [])

    def test_native_tool_pins_caller_and_ignores_no_untrusted_override(self):
        args = {'operation': 'submit', 'arguments': IDENTITY, 'idempotency_key': KEY}
        for key in ('caller_id', 'scope', 'authority_key_file'):
            with self.subTest(key=key), self.assertRaises(Failure):
                self.service.call('sim_execute', args | {key: 'injected'})
        self.assertEqual(self.gateway.calls, [])
        receipt = self.service.call('sim_execute', args)
        self.assertEqual(receipt['caller_id'], 'native-agent')
        self.assertEqual(self.gateway.controls()[0][2]['caller_id'], 'native-agent')

    def test_nested_tool_arguments_cannot_add_authority(self):
        with self.assertRaises(Failure):
            self.service.call('sim_execute', {'operation': 'submit', 'arguments': IDENTITY | {'caller_id': 'native-agent'}, 'idempotency_key': KEY})
        self.assertEqual(self.gateway.calls, [])

    def test_backend_grant_must_also_authorize_the_trusted_caller(self):
        app = types.SimpleNamespace(cfg={'runtime_root': str(Path(self.temp.name) / 'runtime'),
                                        'simulation_direct': scope(callers=['local-studio'])},
                                    workspace=types.SimpleNamespace(projects={'demo': {}}))
        runtime = SimulationRuntime(app)
        self.addCleanup(runtime.close)
        self.gateway.control = runtime.control
        receipt = self.execute()
        self.assertEqual(receipt['state'], 'rejected')
        self.assertEqual(receipt['error']['details']['http_status'], 403)
        self.assertEqual(len(self.gateway.controls()), 1)

    def test_same_key_returns_original_receipt_across_service_restart(self):
        original = self.execute()
        fresh = Service(self.config)
        fresh.gateway = self.gateway
        repeated = fresh.execute_simulation('submit', IDENTITY, KEY)
        self.assertEqual(original, repeated)
        self.assertEqual(len(self.gateway.controls()), 1)

    def test_reusing_key_with_changed_source_configuration_project_or_caller_conflicts(self):
        self.execute()
        self.service.config['simulation_direct']['projects'].append('other')
        for args, caller in [(IDENTITY | {'source_commit': 'b' * 40}, 'paired-helper'),
                             (IDENTITY | {'configuration': 'other'}, 'paired-helper'),
                             (IDENTITY | {'project_id': 'other'}, 'paired-helper'),
                             (IDENTITY, 'native-agent')]:
            with self.subTest(args=args, caller=caller), self.assertRaises(Failure) as error:
                self.execute(arguments=args, caller=caller)
            self.assertEqual(error.exception.code, 'conflict')
        self.assertEqual(len(self.gateway.controls()), 1)

    def test_uncertain_dispatch_cannot_be_replayed_with_same_or_new_key(self):
        self.gateway.error = Failure('transport_unknown', 'Synthetic lost dispatch response', 75)
        original = self.execute()
        self.assertEqual(original['state'], 'uncertain')
        self.assertEqual(self.execute(), original)
        with self.assertRaises(Failure) as error:
            self.execute(key='replacement-action-key')
        self.assertEqual(error.exception.code, 'unresolved_prior_request')
        self.assertEqual(len(self.gateway.controls()), 1)

    def test_server_error_is_uncertain_and_non_server_rejection_stays_rejected(self):
        for code, state in [(500, 'uncertain'), (403, 'rejected'), (400, 'rejected')]:
            self.service = Service(self.config | {'state_dir': str(Path(self.temp.name) / str(code))})
            self.gateway = FakeGateway()
            self.service.gateway = self.gateway
            self.gateway.error = Failure('gateway_error', 'Synthetic backend response', 2, {'http_status': code})
            with self.subTest(code=code):
                receipt = self.execute()
                self.assertEqual(receipt['state'], state)
                self.assertEqual(self.execute(), receipt)
                self.assertEqual(len(self.gateway.controls()), 1)

    def test_unexpected_exception_leaves_durable_inflight_receipt_and_never_resends(self):
        self.gateway.error = RuntimeError('Synthetic interruption after dispatch began')
        with self.assertRaises(RuntimeError):
            self.execute()
        repeated = self.execute()
        self.assertEqual(repeated['state'], 'authorized_dispatching')
        with self.assertRaises(Failure) as error:
            self.execute(key='replacement-action-key')
        self.assertEqual(error.exception.code, 'unresolved_prior_request')
        self.assertEqual(len(self.gateway.controls()), 1)

    def test_existing_manual_pending_submission_cannot_be_promoted_by_same_or_new_key(self):
        pending = self.service.call('sim_submit', IDENTITY | {'idempotency_key': KEY})
        self.assertEqual(pending['state'], 'pending_approval')
        with patch.object(self.service, 'resolve', side_effect=AssertionError('No automatic approval')):
            for key, code in [(KEY, 'conflict'), ('replacement-action-key', 'unresolved_prior_request')]:
                with self.subTest(key=key), self.assertRaises(Failure) as error:
                    self.execute(key=key)
                self.assertEqual(error.exception.code, code)
        self.assertEqual(self.service.saved('requests', pending['request_id'])['state'], 'pending_approval')
        self.assertEqual(self.gateway.controls(), [])

    def test_collection_forwards_original_bound_run_once(self):
        first = self.execute('collect', RUN_ARGS)
        self.assertEqual(self.execute('collect', RUN_ARGS), first)
        with self.assertRaises(Failure):
            self.execute('collect', RUN_ARGS | {'run_id': 'other-run'})
        self.assertEqual(len(self.gateway.controls()), 1)
        self.assertEqual(self.gateway.controls()[0][1]['arguments'], RUN_ARGS)

    def test_read_only_runtime_uses_get_without_request_ledger_or_execution(self):
        self.service.call('sim_runtime', {'project_id': 'demo'})
        self.assertEqual(self.gateway.controls(), [])
        self.assertEqual(self.gateway.calls[0][0], '/api/simulation/runtime?project_id=demo')
        self.assertIsNone(self.gateway.calls[0][1])
        self.assertEqual(list((self.service.state / 'requests').glob('*.json')), [])

    def test_unsigned_native_reader_cannot_inherit_browser_action_capabilities(self):
        self.service.config['simulation_direct'] = scope(callers=['local-studio'])
        self.gateway.request = Mock(return_value={'capabilities':{'scan':True,'direct_submit':True}})
        result = self.service.call('sim_runtime', {'project_id':'demo'})
        self.assertTrue(all(value is False for value in result['capabilities'].values()))
        self.gateway.request.assert_called_once_with('/api/simulation/runtime?project_id=demo')

    def test_missing_optional_signer_is_a_bounded_failure_before_control_transport(self):
        gateway = Gateway('http://127.0.0.1:1')
        with patch.dict(sys.modules, {'spiceowl.integrations.authority':None}), \
                patch('ic_gateway.service.http.client.HTTPConnection', side_effect=AssertionError('No transport')):
            with self.assertRaises(Failure) as error:
                gateway.request('/api/simulation/runtime?project_id=demo', caller_id='native-agent', authority_key_file='/private/unused')
        self.assertEqual(error.exception.code, 'simulation_authority_unavailable')
        self.assertNotIn('/private/', str(error.exception))


if __name__ == '__main__':
    unittest.main()
