"""Synthetic discovery/account tests. Never executes Codex or opens a network socket."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'apps/codex'))
from icwb.ai import AiSession
from icwb.connection_metadata import (MetadataRpc, discover_runtime, empty_connection,
                                      metadata_error, probe_metadata, project_account, project_usage)
from icwb.host import AiRoutes
from icwb.rpc import Rpc
from icwb.service import Failure, Service


class FakeRpc:
    created = []

    def __init__(self, executable, cwd, callback, timeout=30):
        self.executable = executable; self.callback = callback; self.sent = []; self.closed = False; self.info = {}
        self.replies = {
            'account/read': {'account': {'type': 'chatgpt', 'planType': 'pro', 'email': 'PRIVATE_EMAIL'}, 'requiresOpenaiAuth': True},
            'config/read': {'config': {'model': 'fixture-model', 'model_provider': 'fixture-provider',
                                      'approval_policy': 'on-request', 'approvals_reviewer': 'user',
                                      'token': 'PRIVATE_CONFIG_TOKEN'}},
            'model/list': {'data': [{'id': 'fixture-id', 'model': 'fixture-model', 'displayName': 'Fixture model',
                                    'hidden': False, 'isDefault': True}], 'nextCursor': None},
            'account/rateLimits/read': {'rateLimits': {'limitId': 'codex', 'primary': {
                'usedPercent': 25, 'windowDurationMins': 300, 'resetsAt': 1794844800}, 'secondary': None}},
        }
        self.created.append(self)

    def call(self, method, params):
        self.sent.append({'method': method, 'params': copy.deepcopy(params)})
        if method not in self.replies:
            raise AssertionError('UNAUTHORIZED RPC ' + method)
        result = self.replies[method]
        if isinstance(result, Exception):
            raise result
        if callable(result):
            return result(params)
        return copy.deepcopy(result)

    def send(self, value):
        self.sent.append(copy.deepcopy(value))

    def close(self):
        self.closed = True


def context():
    return {'version': 1, 'mode': 'live', 'project': {'id': 'SYNTHETIC'}, 'file': {
        'path': 'projects/fixture.scs', 'dirty': False, 'baseCommit': 'a' * 40,
        'persistedSha256': 'b' * 64, 'currentTextSha256': 'b' * 64}}


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def exe(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('SYNTHETIC FILE: NEVER EXECUTE'); path.chmod(0o700)
        return path

    def discover(self, config=None, path='', apps=()):
        return discover_runtime(config or {}, search_path=path, app_roots=apps)

    def test_priority_and_no_public_path_or_auth_contents(self):
        configured = self.exe(self.root / 'configured'); path_exe = self.exe(self.root / 'bin/codex')
        app = self.root / 'Codex.app'; self.exe(app / 'Contents/Resources/codex')
        with patch('subprocess.Popen', side_effect=AssertionError('NO PROCESS')), patch.object(Path, 'read_text', side_effect=AssertionError('NO FILE CONTENT')):
            public, selected = self.discover({'codex_bin': str(configured), 'token': 'PRIVATE'}, str(path_exe.parent), [app])
        self.assertEqual(selected, str(configured)); self.assertEqual(public['codex']['source'], 'configured')
        self.assertNotIn(str(self.root), json.dumps(public)); self.assertNotIn('PRIVATE', json.dumps(public))
        self.assertEqual(public['desktop']['running'], 'unknown')
        public, selected = self.discover(path=str(path_exe.parent), apps=[app])
        self.assertEqual(selected, str(path_exe)); self.assertEqual(public['codex']['source'], 'path')

    def test_invalid_explicit_config_does_not_fallback(self):
        exe = self.exe(self.root / 'bin/codex')
        for value in (str(self.root / 'missing'), '../codex', 'codex --flag', None, '', 'codex\n'):
            with self.subTest(value=value):
                public, selected = self.discover({'codex_bin': value}, str(exe.parent))
                self.assertIsNone(selected); self.assertFalse(public['codex']['executable_found'])
                self.assertEqual(public['codex']['source'], 'configured')

    def test_only_absolute_path_entries_and_executable_files(self):
        self.exe(self.root / 'codex')
        with patch('icwb.connection_metadata.shutil.which', side_effect=AssertionError('empty PATH must not search cwd')):
            for config in ({}, {'codex_bin': 'codex'}):
                public, selected = self.discover(config, ':.:relative:')
                self.assertIsNone(selected)
        nonexe = self.root / 'bin/codex'; nonexe.parent.mkdir(); nonexe.write_text('NOT EXECUTABLE')
        self.assertIsNone(self.discover(path=str(nonexe.parent))[1])

    def test_codex_and_chatgpt_bundles_system_and_user(self):
        for base in ('Applications', 'home/Applications'):
            for name, suffix in (('Codex.app', 'Contents/Resources/codex'),
                                 ('ChatGPT.app', 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')):
                with self.subTest(base=base, name=name):
                    app = self.root / base / name; binary = self.exe(app / suffix)
                    public, selected = self.discover(apps=[app])
                    self.assertEqual(selected, str(binary)); self.assertEqual(public['codex']['source'], 'official_app')
                    self.assertIs(public['desktop']['installed'], True)

    def test_routes_discovery_does_not_construct_session(self):
        routes = object.__new__(AiRoutes); routes.service = Mock(config={'codex_bin': '/definitely/missing/codex'})
        routes.sessions = Mock()
        with patch('subprocess.Popen', side_effect=AssertionError('NO PROCESS')):
            report = routes.get('/api/ai/discovery', {})
        self.assertEqual(report['schema'], 'ic.ai.discovery.v1'); routes.sessions.get.assert_not_called()
        with self.assertRaises(Failure): routes.get('/api/ai/discovery', {'path': ['/bad']})
        with self.assertRaises(Failure): routes.post('/api/ai/connect', {'session_id': 'default', 'provider': 'evil'})
        with self.assertRaises(Failure): routes.post('/api/ai/connect', {})
        routes.sessions.get.assert_not_called()


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name).resolve()
        self.binary = self.root / 'codex'; self.binary.write_text('NEVER EXECUTE'); self.binary.chmod(0o700)
        self.sessions = []

    def tearDown(self):
        for session in self.sessions: session.close()
        self.tmp.cleanup()

    def ai(self, *, factory=FakeRpc, sid='default'):
        service = Service({'gateway_url': 'http://127.0.0.1:1', 'state_dir': str(self.root / sid), 'codex_bin': str(self.binary)})
        service.call = Mock(side_effect=AssertionError('NO PROJECT OR MODEL OPERATIONS'))
        session = AiSession(service, factory, session_id=sid); self.sessions.append(session)
        return session

    def existing(self):
        session = self.ai(); session.connect()
        return session, session.rpc

    def test_connect_queries_only_four_methods_and_reuses_its_rpc(self):
        session = self.ai(); config_before = copy.deepcopy(session.service.config)
        first = session.connection(); rpc = session.rpc
        self.assertEqual(first['status'], 'connected'); self.assertEqual(first['chat']['status'], 'unverified')
        self.assertTrue(first['runtime']['process_started']); self.assertFalse(first['runtime']['reused_rpc'])
        self.assertEqual(first['account']['plan_type'], 'pro'); self.assertEqual(first['usage']['buckets'][0]['primary']['used_percent'], 25)
        self.assertEqual(rpc.sent, [
            {'method': 'account/read', 'params': {'refreshToken': False}},
            {'method': 'config/read', 'params': {'includeLayers': False}},
            {'method': 'account/rateLimits/read', 'params': {}},
            {'method': 'model/list', 'params': {'limit': 100, 'includeHidden': False}}])
        second = session.connection(); self.assertIs(session.rpc, rpc)
        self.assertTrue(second['runtime']['reused_rpc']); self.assertFalse(second['runtime']['process_started'])
        self.assertEqual(session.state, 'idle'); self.assertIsNone(session.thread_id); self.assertEqual(session.turns, {})
        self.assertEqual(session.service.config, config_before); session.service.call.assert_not_called()
        serialized = json.dumps(first); self.assertNotIn('PRIVATE', serialized); self.assertNotIn(str(self.root), serialized)
        self.assertEqual(first['inference'], {'checked': False, 'historical_completed_turns': 0})

    def test_provider_never_implies_a_plan_or_login(self):
        session, rpc = self.existing()
        rpc.replies['account/read'] = {'account': None, 'requiresOpenaiAuth': False}
        rpc.replies['config/read']['config']['model_provider'] = 'chatgpt-pro-subscription'
        report = session.connection()
        self.assertEqual(report['account']['plan_type'], 'unknown'); self.assertEqual(report['account']['login_status'], 'unknown')
        self.assertEqual(report['status'], 'partial'); self.assertEqual(report['chat']['status'], 'unknown')
        self.assertEqual(report['chat']['reason'], 'account_not_reported')
        self.assertFalse(any(c['method'] == 'account/rateLimits/read' for c in rpc.sent))

    def test_signed_out_and_api_key_do_not_query_chatgpt_quota(self):
        for account, required, login in ((None, True, 'signed_out'), ({'type': 'apiKey', 'planType': 'pro'}, True, 'signed_in')):
            session, rpc = self.existing(); rpc.replies['account/read'] = {'account': account, 'requiresOpenaiAuth': required}
            report = session.connection()
            self.assertEqual(report['account']['login_status'], login); self.assertEqual(report['account']['plan_type'], 'unknown')
            self.assertFalse(any(c['method'] == 'account/rateLimits/read' for c in rpc.sent))
            if account is None: self.assertEqual(report['chat']['reason'], 'sign_in_required')

    def test_unknown_account_modes_and_external_credential_chains(self):
        for kind in ('futureMode', 'amazonBedrock', 'agentIdentity', 'personalAccessToken'):
            projected = project_account({'account': {'type': kind, 'planType': 'pro', 'token': 'PRIVATE'}, 'requiresOpenaiAuth': False})
            self.assertEqual(projected['login_status'], 'unknown'); self.assertEqual(projected['plan_type'], 'unknown')
        projected = project_account({'account': {'type': 'chatgpt', 'planType': None}, 'requiresOpenaiAuth': True})
        self.assertEqual(projected['plan_type'], 'unknown')

    def test_unsupported_optional_quota_is_partial_and_keeps_rpc_code(self):
        session, rpc = self.existing()
        rpc.replies['account/rateLimits/read'] = Failure('app_server_error', 'PRIVATE upstream token', 4, {'rpc_code': -32601, 'secret': 'PRIVATE'})
        report = session.connection()
        self.assertEqual(report['status'], 'partial'); self.assertEqual(report['usage']['status'], 'unsupported')
        self.assertEqual(report['chat']['status'], 'unverified')
        self.assertEqual(report['errors'][0]['details'], {'method': 'account/rateLimits/read', 'rpc_code': -32601})
        self.assertNotIn('PRIVATE', json.dumps(report)); self.assertEqual(len(rpc.sent), 4)

    def test_failed_account_preserves_method_and_does_not_retry(self):
        session, rpc = self.existing(); rpc.replies['account/read'] = Failure('app_server_error', 'PRIVATE', 4, {'rpc_code': -32602})
        report = session.connection()
        self.assertEqual(report['status'], 'partial'); self.assertEqual(report['account']['status'], 'unknown')
        self.assertEqual(report['errors'][0]['details'], {'method': 'account/read', 'rpc_code': -32602})
        self.assertEqual(sum(c['method'] == 'account/read' for c in rpc.sent), 1)
        self.assertEqual(report['chat']['status'], 'unknown'); self.assertFalse(report['automatic_retry'])

    def test_timeout_stops_remaining_metadata_work(self):
        session, rpc = self.existing(); rpc.replies['account/read'] = Failure('app_server_timeout', 'PRIVATE', 75)
        report = session.connection()
        self.assertEqual(len(rpc.sent), 1); self.assertEqual(report['status'], 'partial')
        self.assertEqual(report['catalog']['reason'], 'transport_unavailable')

    def test_nonmanual_policy_blocks_turn_with_no_thread(self):
        for changes in ({'approvals_reviewer': 'auto_review'}, {'approval_policy': 'never'}, {'approvals_reviewer': 'futureReviewer'}):
            session, rpc = self.existing(); rpc.replies['config/read']['config'].update(changes)
            report = session.connection(); before = len(rpc.sent)
            self.assertEqual(report['chat']['reason'], 'manual_approval_required'); self.assertEqual(report['policy']['status'], 'blocked')
            with self.assertRaises(Failure): session.turn('do not run', context(), 'blocked-key')
            self.assertEqual(len(rpc.sent), before); self.assertIsNone(session.thread_id); session.service.call.assert_not_called()

    def test_start_thread_precheck_keeps_original_manual_guard(self):
        session, rpc = self.existing(); rpc.replies['config/read']['config']['approvals_reviewer'] = 'auto_review'
        with self.assertRaises(Failure): session._start_thread()
        self.assertEqual([c['method'] for c in rpc.sent], ['config/read'])
        rpc.sent.clear(); rpc.replies['config/read']['config']['approvals_reviewer'] = 'user'
        rpc.replies['thread/start'] = {'thread': {'id': 'synthetic'}, 'model': 'fixture-model', 'modelProvider': 'fixture-provider',
                                       'approvalsReviewer': 'auto_review', 'approvalPolicy': 'on-request'}
        with self.assertRaises(Failure): session._start_thread()
        self.assertEqual(session.state, 'suspended'); self.assertNotIn('turn/start', [c['method'] for c in rpc.sent])

    def test_unknown_policy_does_not_claim_ready(self):
        session, rpc = self.existing(); del rpc.replies['config/read']['config']['approvals_reviewer']
        report = session.connection()
        self.assertEqual(report['policy']['status'], 'unknown'); self.assertEqual(report['chat']['status'], 'unknown')
        self.assertEqual(report['chat']['reason'], 'policy_not_reported')

    def test_ordinary_catalog_start_uses_shared_discovery_without_connect_button(self):
        session = self.ai(factory=Rpc); before = copy.deepcopy(session.service.config)
        discovered = {'codex': {'source': 'official_app', 'reason': None}}
        with patch('icwb.ai.discover_runtime', return_value=(discovered, str(self.binary))) as discovery, patch('icwb.ai.MetadataRpc', FakeRpc):
            catalog = session.models()
            self.assertEqual(catalog['models'][0]['id'], 'fixture-id')
            self.assertEqual(session.rpc.executable, str(self.binary)); self.assertEqual(session.rpc_source, 'official_app')
            session.connect(); discovery.assert_called_once()
        self.assertEqual(session.service.config, before); self.assertIsNone(session.thread_id)

    def test_ordinary_catalog_bad_explicit_runtime_does_not_spawn_or_fallback(self):
        session = self.ai(factory=Rpc); session.service.config['codex_bin'] = '/definitely/missing/codex'
        with patch('icwb.ai.MetadataRpc', side_effect=AssertionError('NO SPAWN')):
            with self.assertRaises(Failure) as error: session.models()
        self.assertEqual(error.exception.code, 'configured_executable_unavailable'); self.assertIsNone(session.rpc)

    def test_ineligible_sessions_and_pending_approvals_not_touched(self):
        for state in ('running', 'starting', 'suspended', 'complete'):
            session = self.ai(); session.state = state; before = len(FakeRpc.created)
            report = session.connection()
            self.assertEqual(report['chat']['reason'], 'session_unavailable'); self.assertEqual(len(FakeRpc.created), before)
            self.assertEqual(session.state, state)
        session, rpc = self.existing(); session.pending['old'] = {'status': 'suspended'}
        self.assertEqual(session.connection()['status'], 'unavailable'); self.assertEqual(rpc.sent, [])
        session.pending = {}; rpc.closed = True
        self.assertEqual(session.connection()['status'], 'unavailable'); self.assertIs(session.rpc, rpc)

    def test_historical_inference_is_separate_and_completed_rpc_reused(self):
        session, rpc = self.existing(); session.state = 'complete'
        session.turns['old'] = {'state': 'complete'}; session.turns['error'] = {'state': 'suspended'}
        result = session.connection()
        self.assertEqual(result['inference'], {'checked': False, 'historical_completed_turns': 1})
        self.assertFalse(result['catalog']['inference_verified']); self.assertIs(session.rpc, rpc)

    def test_provider_change_does_not_replace_thread_or_catalog(self):
        session, rpc = self.existing(); session.state = 'complete'; session.thread_id = 'owned-thread'; session.thread_provider = 'old'
        session.catalog = {'models': ['old']}
        report = session.connection()
        self.assertEqual(report['status'], 'partial'); self.assertEqual(report['catalog']['reason'], 'provider_changed')
        self.assertEqual(session.catalog, {'models': ['old']}); self.assertEqual(session.thread_id, 'owned-thread')

    def test_missing_runtime_does_not_spawn_or_fallback(self):
        session = self.ai(); session.service.config['codex_bin'] = '/definitely/missing/codex'; before = len(FakeRpc.created)
        report = session.connection()
        self.assertEqual(report['chat']['reason'], 'runtime_unavailable'); self.assertEqual(len(FakeRpc.created), before)

    def test_startup_failure_no_replay_by_other_routes(self):
        factory = Mock(side_effect=Failure('app_server_error', 'PRIVATE', 4, {'method': 'initialize', 'rpc_code': -32602}))
        session = self.ai(factory=factory); result = session.connection()
        self.assertEqual(result['status'], 'unavailable'); self.assertIsNone(result['runtime']['process_started'])
        self.assertEqual(result['errors'][0]['details'], {'method': 'initialize', 'rpc_code': -32602})
        session.connection()
        with self.assertRaises(Failure): session.models()
        self.assertEqual(factory.call_count, 1); self.assertNotIn('PRIVATE', json.dumps(result))

    def test_metadata_server_request_cannot_execute_or_request_approval(self):
        session, rpc = self.existing()
        def account(params):
            session._receive({'id': 'malicious', 'method': 'item/tool/call', 'params': {'tool': 'ic_apply', 'token': 'PRIVATE'}})
            return {'account': None, 'requiresOpenaiAuth': False}
        rpc.replies['account/read'] = account
        report = session.connection()
        self.assertEqual(report['status'], 'partial'); self.assertEqual(report['chat']['status'], 'blocked')
        self.assertEqual(session.pending, {}); session.service.call.assert_not_called()
        self.assertNotIn('PRIVATE', json.dumps(report)); self.assertEqual(rpc.sent[1]['error']['code'], -32601)

    def test_concurrent_turn_and_second_connect_are_blocked_without_rpc(self):
        session, rpc = self.existing(); entered = threading.Event(); release = threading.Event()
        def account(params):
            entered.set(); self.assertTrue(release.wait(5))
            return {'account': None, 'requiresOpenaiAuth': False}
        rpc.replies['account/read'] = account
        thread = threading.Thread(target=session.connection); thread.start()
        try:
            self.assertTrue(entered.wait(5)); before = len(rpc.sent)
            self.assertEqual(session.connection()['status'], 'unavailable')
            with self.assertRaises(Failure): session.turn('no concurrent turn', context(), 'concurrent-key')
            self.assertEqual(len(rpc.sent), before); session.service.call.assert_not_called()
        finally:
            release.set(); thread.join(5)
        self.assertFalse(thread.is_alive()); self.assertFalse(session.metadata_busy)

    def test_route_requires_exact_explicit_known_session(self):
        service = self.ai().service; routes = AiRoutes(service)
        routes.sessions.factory = lambda service, session_id: self.ai(sid=session_id)
        try:
            sid = routes.sessions.create('Explicit connection metadata')['session_id']
            self.assertEqual(routes.post('/api/ai/connect', {'session_id': sid})['session_id'], sid)
            with self.assertRaises(Failure): routes.post('/api/ai/connect', {'session_id': 'unknown'})
        finally: routes.close()


class ProjectionTests(unittest.TestCase):
    def test_multi_bucket_units_and_missing_windows(self):
        result = project_usage({'rateLimits': {'limitId': 'ignored'}, 'rateLimitsByLimitId': {
            'codex': {'limitId': 'codex', 'planType': 'plus', 'primary': {'usedPercent': 0, 'windowDurationMins': 15, 'resetsAt': 1794844800}, 'credits': {'balance': 'PRIVATE'}},
            'other': {'limitId': 'other', 'secondary': {'usedPercent': 101, 'resetsAt': None}}}})
        self.assertEqual(len(result['buckets']), 2); self.assertEqual(result['buckets'][0]['primary']['resets_at'], 1794844800)
        self.assertIsNone(result['buckets'][0]['secondary']); self.assertIsNone(result['buckets'][1]['primary'])
        self.assertEqual(result['buckets'][1]['secondary']['used_percent'], 101); self.assertNotIn('PRIVATE', json.dumps(result))

    def test_missing_empty_and_invalid_quota_are_not_zero_usage(self):
        for value in ({}, {'rateLimits': None}, {'rateLimitsByLimitId': {}, 'rateLimits': {'primary': {'usedPercent': 50}}}):
            result = project_usage(value); self.assertEqual(result['status'], 'unknown'); self.assertEqual(result['buckets'], [])
        invalid = [[], {'rateLimitsByLimitId': []}, {'rateLimitsByLimitId': {str(i): {} for i in range(33)}},
                   {'rateLimitsByLimitId': {'a': {'limitId': 'b'}}},
                   {'rateLimits': {'primary': {'usedPercent': True}}},
                   {'rateLimits': {'primary': {'usedPercent': float('nan')}}}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(Failure): project_usage(value)

    def test_catalog_projection_drops_unknown_fields_and_bounds_pagination(self):
        rpc = FakeRpc('', '', lambda msg: None)
        item = rpc.replies['model/list']['data'][0]; item['token'] = 'PRIVATE'
        item['supportedReasoningEfforts'] = [{'reasoningEffort': 'medium', 'description': 'fixture', 'token': 'PRIVATE'}]
        result = probe_metadata(rpc, empty_connection('fixture'))
        self.assertNotIn('PRIVATE', json.dumps(result)); self.assertEqual(result['catalog']['models'][0]['inputModalities'], ['text', 'image'])
        rpc.sent.clear(); rpc.replies['model/list']['nextCursor'] = 'repeated'; rpc.replies['model/list']['data'] = []
        result = probe_metadata(rpc, empty_connection('fixture'))
        self.assertEqual(result['status'], 'partial'); self.assertEqual(result['catalog']['models'], [])
        self.assertEqual(sum(c['method'] == 'model/list' for c in rpc.sent), 2)

    def test_malformed_metadata_is_partial_without_raw_error_message(self):
        rpc = FakeRpc('', '', lambda msg: None); rpc.replies['account/read'] = {'account': {'type': 'chatgpt', 'planType': {'token': 'PRIVATE'}}}
        result = probe_metadata(rpc, empty_connection('fixture'))
        self.assertEqual(result['status'], 'partial'); self.assertEqual(result['account']['account_type'], 'unknown')
        self.assertNotIn('PRIVATE', json.dumps(result))
        error = metadata_error(RuntimeError('PRIVATE'), 'config/read')
        self.assertNotIn('PRIVATE', json.dumps(error)); self.assertEqual(error['details']['method'], 'config/read')

    def test_failed_initialization_cleans_up_only_its_owned_process(self):
        process = Mock(); process.poll.return_value = None; reader = Mock()
        def fail_init(rpc, *args, **kwargs):
            rpc.process = process; rpc.reader = reader
            raise Failure('app_server_error', 'synthetic initialize failure', 4)
        with patch('icwb.connection_metadata.Rpc.__init__', fail_init):
            with self.assertRaises(Failure): MetadataRpc('fixture', 'fixture', lambda msg: None)
        process.terminate.assert_called_once(); process.wait.assert_called_once(); reader.join.assert_called_once()


if __name__ == '__main__':
    unittest.main(verbosity=2)
