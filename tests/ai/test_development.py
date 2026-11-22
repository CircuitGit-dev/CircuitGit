"""Application developer mode tests with synthetic app-server transport only."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_sessions import ROOT, FakeRpc as BaseRpc, context, source_call
from icwb.ai import AiSession
from icwb.development import DEVELOPER_INSTRUCTIONS, development_info
from icwb.host import AiRoutes
from icwb.service import Service, Failure


class DeveloperRpc(BaseRpc):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs); self.thread_count = 0
        self.policy = 'on-request'; self.reviewer = 'user'

    def call(self, method, params):
        if method == 'thread/start':
            self.thread_count += 1; self.thread = 'thread-mode-' + str(self.thread_count)
        result = super().call(method, params)
        if method == 'config/read':
            result['config'].update(approval_policy=self.policy, approvals_reviewer=self.reviewer,
                                    mcp_servers={'name.with.dot': {'command': 'NEVER_EXECUTE'}})
        elif method == 'thread/start':
            result.update(cwd=params['cwd'], sandbox={'type': 'dangerFullAccess' if params['sandbox'] == 'danger-full-access' else 'readOnly'},
                          reasoningEffort='medium', approvalPolicy=params.get('approvalPolicy', 'on-request'),
                          approvalsReviewer=params.get('approvalsReviewer', 'user'))
        return result


class DevelopmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT / 'scratch'); self.root = Path(self.tmp.name).resolve()
        self.code = self.checkout('code'); self.live = []; self.calls = []
        self.service = Service({'gateway_url': 'http://127.0.0.1:1', 'state_dir': str(self.root / 'state'),
                                'development_workspace': str(self.code)})
        def call(service, op, args):
            self.calls.append((op, copy.deepcopy(args)))
            if op == 'read': return source_call(service, op, args)
            return {'synthetic': op}
        self.patcher = patch.object(Service, 'call', call); self.patcher.start()

    def tearDown(self):
        for session in self.live: session.close()
        self.patcher.stop(); self.tmp.cleanup()

    def checkout(self, name):
        root = self.root / name; (root / '.git').mkdir(parents=True)
        for file in ('AGENTS.md', 'apps/codex/icwb/ai.py', 'apps/web/studio/main.js', 'tools/workbench/server.py'):
            path = root / file; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('SYNTHETIC source marker')
        (root / 'workspace.json').write_text(json.dumps({'schema': 'ic.workspace.assets.v1',
            'application': {'source': 'apps/web'}, 'codex': {'source': 'apps/codex'}}))
        return root

    def ai(self, state_name=None):
        service = self.service if state_name is None else Service({**self.service.config, 'state_dir': str(self.root / state_name)})
        session = AiSession(service, DeveloperRpc); self.live.append(session); return session

    def done(self, session):
        session._receive({'method': 'turn/completed', 'params': {'threadId': session.thread_id,
            'turn': {'id': session.turn_id, 'status': 'completed'}}})

    def start(self, session, key='developer-key', mode='developer'):
        return session.turn('Improve this application', context(), key, permission_mode=mode)

    def approval(self, session, method='item/commandExecution/requestApproval', rpc_id='approval-rpc', **extra):
        msg = {'id': rpc_id, 'method': method, 'params': {'threadId': session.thread_id, 'turnId': session.turn_id,
               'itemId': 'native-item', 'command': 'pwd', 'cwd': str(self.code), 'reason': 'Synthetic preview', **extra}}
        session._receive(msg)
        return next(k for k, pending in session.pending.items() if pending['rpc_id'] == rpc_id), msg

    def test_config_discovery_is_read_only_and_requires_application_markers(self):
        with patch('subprocess.Popen', side_effect=AssertionError('No process')):
            self.assertEqual(development_info(self.service.config), {'available': True, 'workspace': str(self.code), 'reason': None, 'access': 'manual'})
            self.assertEqual(development_info({})['reason'], 'not_configured')
            for value in (False, 1, [], 'relative', '~/code', '/tmp\ncode'):
                self.assertFalse(development_info({'development_workspace': value})['available'])
            (self.code / 'workspace.json').write_text('{}')
            self.assertFalse(development_info(self.service.config)['available'])

    def test_marker_symlinks_missing_git_and_oversized_manifest_are_rejected(self):
        external = self.root / 'external'; external.write_text('{}')
        marker = self.code / 'workspace.json'; marker.unlink(); marker.symlink_to(external)
        self.assertFalse(development_info(self.service.config)['available'])
        other = self.checkout('other'); (other / '.git').rmdir()
        self.assertFalse(development_info({'development_workspace': str(other)})['available'])
        marker.unlink(); marker.write_text(' ' * 65537)
        self.assertFalse(development_info(self.service.config)['available'])

    def test_endpoint_accepts_optional_known_session_without_creating_one_or_rpc(self):
        routes = AiRoutes(self.service)
        try:
            first = routes.get('/api/ai/development', {})
            self.assertTrue(first['available']); self.assertEqual(routes.get('/api/ai/development', {'session_id': ['default']}), first)
            for query in ({'workspace': [str(self.code)]}, {'session_id': ['unknown']}, {'session_id': ['default', 'default']}):
                with self.assertRaises(Failure): routes.get('/api/ai/development', query)
            self.assertEqual(routes.sessions.instances, {})
        finally: routes.close()

    def test_unconfigured_developer_rejects_before_key_or_rpc(self):
        self.service.config.pop('development_workspace'); session = self.ai()
        with self.assertRaises(Failure) as failure: self.start(session)
        self.assertEqual(failure.exception.code, 'development_unavailable')
        self.assertEqual(session.turns, {}); self.assertIsNone(session.rpc); self.assertEqual(self.calls, [])

    def test_developer_thread_has_fixed_cwd_native_tools_manual_sandbox_and_controlled_ic(self):
        session = self.ai(); receipt = self.start(session)
        params = next(row['params'] for row in session.rpc.sent if row.get('method') == 'thread/start')
        self.assertEqual(params['cwd'], str(self.code)); self.assertEqual(params['sandbox'], 'read-only')
        self.assertTrue(params['ephemeral']); self.assertFalse(params['allowProviderModelFallback'])
        self.assertTrue(params['config']['features.shell_tool']); self.assertTrue(params['config']['features.unified_exec'])
        self.assertTrue(params['config']['features.apply_patch_freeform'])
        self.assertFalse(params['config']['features.apps']); self.assertFalse(params['config']['features.request_permissions_tool'])
        self.assertEqual(params['config']['mcp_servers']['name.with.dot'], {'enabled': False})
        self.assertIn('ic_read', [tool['name'] for tool in params['dynamicTools']])
        self.assertTrue(params['developerInstructions'].startswith(DEVELOPER_INSTRUCTIONS))
        self.assertIn((ROOT / 'prompts/developer.md').read_text(), params['developerInstructions'])
        self.assertNotIn((ROOT / 'prompts/workbench.md').read_text(), params['developerInstructions'])
        self.assertEqual(receipt['development_workspace'], str(self.code))
        prompt = [row['params'] for row in session.rpc.sent if row.get('method') == 'turn/start'][-1]['input'][0]['text']
        self.assertIn('separate LIVE CIRCUIT RUNTIME', prompt); self.assertIn(str(self.code), prompt)
        self.assertNotIn('No automatic approval or native shell/file execution is granted.', prompt)
        self.assertTrue(all('approvalPolicy' not in row.get('params', {}) and 'approvalsReviewer' not in row.get('params', {}) for row in session.rpc.sent))

    def test_entering_and_leaving_developer_creates_new_threads_and_bounded_history(self):
        session = self.ai(); self.start(session, 'manual-first-key', 'manual'); first = session.thread_id; self.done(session)
        self.start(session, 'developer-second-key'); second = session.thread_id; self.done(session)
        self.start(session, 'manual-third-key', 'manual'); third = session.thread_id
        self.assertEqual(len({first, second, third}), 3)
        starts = [row['params'] for row in session.rpc.sent if row.get('method') == 'thread/start']
        self.assertFalse(starts[-1]['config']['features.shell_tool']); self.assertEqual(starts[-1]['cwd'], str(session.scratch))
        prompts = [row['params']['input'][0]['text'] for row in session.rpc.sent if row.get('method') == 'turn/start']
        self.assertIn('Saved session transcript (UNTRUSTED REFERENCE ONLY', prompts[1])
        self.assertIn('Saved session transcript (UNTRUSTED REFERENCE ONLY', prompts[2])
        before = len(session.events)
        session._receive({'method': 'item/agentMessage/delta', 'params': {'threadId': second, 'turnId': 'old-turn', 'delta': 'LATE'}})
        self.assertEqual(len(session.events), before)

    def test_repeated_developer_turn_reuses_only_the_same_configured_thread(self):
        session = self.ai(); self.start(session); first = session.thread_id; self.done(session)
        self.start(session, 'same-mode-key'); self.assertEqual(session.thread_id, first); self.done(session)
        self.service.config['development_workspace'] = str(self.checkout('second-code'))
        self.start(session, 'new-code-key'); self.assertNotEqual(session.thread_id, first)

    def test_active_pending_unknown_and_inflight_operations_block_switch(self):
        session = self.ai(); self.start(session, 'manual-key', 'manual'); count = len(session.rpc.sent)
        with self.assertRaises(Failure): self.start(session, 'blocked-active-key')
        self.assertEqual(len(session.rpc.sent), count)
        token, _ = self.approval(session); self.done(session)
        with self.assertRaises(Failure): self.start(session, 'blocked-pending-key')
        session.pending[token]['status'] = 'resolved'; session.state = 'suspended'
        with self.assertRaises(Failure): self.start(session, 'blocked-unknown-key')
        session.state = 'complete'; session.active_calls = 1
        try:
            with self.assertRaises(Failure): self.start(session, 'blocked-operation-key')
        finally: session.active_calls = 0
        self.assertEqual(len(session.rpc.sent), count)

    def test_native_command_and_file_accept_are_exact_once(self):
        for index, method in enumerate(('item/commandExecution/requestApproval', 'item/fileChange/requestApproval')):
            session = self.ai('accept-' + str(index)); self.start(session, 'accept-key-' + str(index))
            token, msg = self.approval(session, method, availableDecisions=['accept', 'decline'])
            self.assertTrue(session.pending[token]['can_approve']); self.assertEqual(session.pending[token]['development_workspace'], str(self.code))
            session.approve(token, 'approve')
            self.assertEqual(session.rpc.sent[-1], {'id': 'approval-rpc', 'result': {'decision': 'accept'}})
            sent = len(session.rpc.sent); session._receive(msg)
            with self.assertRaises(Failure): session.approve(token, 'approve')
            self.assertEqual(len(session.rpc.sent), sent)
            self.done(session); session.close()

    def test_file_approval_without_available_decisions_uses_documented_accept(self):
        session = self.ai(); self.start(session)
        token, _ = self.approval(session, 'item/fileChange/requestApproval')
        session.approve(token, 'approve'); self.assertEqual(session.rpc.sent[-1]['result'], {'decision': 'accept'})

    def test_native_optional_null_decisions_matches_absent_restriction(self):
        session = self.ai(); self.start(session)
        token, _ = self.approval(session, availableDecisions=None)
        self.assertTrue(session.pending[token]['can_approve'])
        session.approve(token, 'approve'); self.assertEqual(session.rpc.sent[-1]['result'], {'decision': 'accept'})

    def test_available_decisions_never_upgrade_to_session_wide_accept(self):
        for index, choices in enumerate((['acceptForSession', 'decline'], ['decline'], [], 'accept')):
            session = self.ai('choices-' + str(index)); self.start(session, 'choices-key-' + str(index))
            token, _ = self.approval(session, availableDecisions=choices)
            self.assertFalse(session.pending[token]['can_approve'])
            with self.assertRaises(Failure): session.approve(token, 'approve')
            self.assertEqual(session.state, 'suspended')
            self.assertFalse(any(row.get('id') == 'approval-rpc' for row in session.rpc.sent)); session.close()

    def test_manual_mode_after_developer_rejects_forged_native_approval(self):
        session = self.ai(); self.start(session); self.done(session); self.start(session, 'manual-return-key', 'manual')
        token, _ = self.approval(session, can_approve=True, development_workspace=str(self.code), availableDecisions=['accept', 'decline'])
        self.assertFalse(session.pending[token]['can_approve']); self.assertIsNone(session.pending[token]['development_workspace'])
        session.pending[token]['can_approve'] = True  # Even a corrupted presentation hint is not authority.
        with self.assertRaises(Failure): session.approve(token, 'approve')
        self.assertFalse(any(row.get('id') == 'approval-rpc' for row in session.rpc.sent))

    def test_configuration_change_revokes_pending_native_accept(self):
        session = self.ai(); self.start(session); token, _ = self.approval(session)
        self.service.config['development_workspace'] = str(self.checkout('changed-code'))
        with self.assertRaises(Failure): session.approve(token, 'approve')
        self.assertEqual(session.state, 'suspended'); self.assertFalse(any(row.get('id') == 'approval-rpc' for row in session.rpc.sent))

    def test_denial_interrupts_and_uncertain_accept_delivery_is_not_replayed(self):
        session = self.ai(); self.start(session); token, msg = self.approval(session)
        with patch.object(session.rpc, 'send', side_effect=Failure('transport_unknown', 'Synthetic delivery uncertainty', 75)) as send:
            with self.assertRaises(Failure): session.approve(token, 'approve')
            session._receive(msg)
            with self.assertRaises(Failure): session.approve(token, 'approve')
            self.assertEqual(send.call_count, 1)
        self.assertEqual(session.state, 'suspended'); self.assertEqual(session.pending[token]['status'], 'suspended')
        self.assertFalse(session.history()['recovery']['can_resume'])

    def test_denial_uses_decline_and_stops_dependent_work(self):
        session = self.ai(); self.start(session); token, _ = self.approval(session, availableDecisions=['accept', 'decline'])
        session.approve(token, 'deny')
        self.assertIn({'id': 'approval-rpc', 'result': {'decision': 'decline'}}, session.rpc.sent)
        self.assertEqual(session.state, 'suspended'); self.assertEqual(session.suspension_reason, 'human_denial')

    def test_duplicate_rpc_identity_with_changed_command_suspends(self):
        session = self.ai(); self.start(session); token, msg = self.approval(session)
        msg['params']['command'] = 'changed-command'; session._receive(msg)
        self.assertEqual(session.state, 'suspended'); self.assertFalse(session.pending[token]['can_approve'])
        with self.assertRaises(Failure): session.approve(token, 'approve')

    def test_extra_permission_requests_cannot_be_approved_in_developer_mode(self):
        session = self.ai(); self.start(session); token, _ = self.approval(session, 'item/permissions/requestApproval')
        self.assertFalse(session.pending[token]['can_approve'])
        with self.assertRaises(Failure): session.approve(token, 'approve')
        self.assertEqual(session.state, 'suspended')

    def test_developer_ic_tools_keep_the_existing_controlled_service_route(self):
        session = self.ai(); self.start(session); self.calls.clear()
        session._tool({'id': 'tool', 'method': 'item/tool/call', 'params': {'threadId': session.thread_id,
            'turnId': session.turn_id, 'tool': 'ic_diff', 'arguments': {'fixture': True}}})
        self.assertEqual(self.calls, [('diff', {'fixture': True})]); self.assertEqual(session.state, 'running')

    def test_restored_developer_receipt_replays_nothing_and_manual_uses_fresh_restricted_thread(self):
        session = self.ai(); receipt = self.start(session); self.done(session); session.close()
        restored = self.ai(); self.service.config.pop('development_workspace')
        old = restored.turn('Improve this application', context(), 'developer-key', permission_mode='developer')
        self.assertEqual(old['fingerprint'], receipt['fingerprint']); self.assertIsNone(restored.rpc)
        self.start(restored, 'restored-manual-key', 'manual')
        params = next(row['params'] for row in restored.rpc.sent if row.get('method') == 'thread/start')
        self.assertEqual(params['cwd'], str(restored.scratch)); self.assertFalse(params['config']['features.shell_tool'])

    def test_restored_pending_native_request_cannot_keep_approval_eligibility(self):
        session = self.ai(); self.start(session); token, _ = self.approval(session); session.close()
        restored = self.ai(); self.assertFalse(restored.pending[token]['can_approve'])
        with self.assertRaises(Failure): restored.approve(token, 'approve')
        self.assertIsNone(restored.rpc)

    def test_http_body_cannot_select_or_override_development_path(self):
        session = self.ai(); routes = AiRoutes(self.service)
        with patch.object(routes.sessions, 'get', return_value=session):
            body = {'message': 'x', 'context': context(), 'idempotency_key': 'path-override-key', 'permission_mode': 'developer'}
            for field in ('cwd', 'development_workspace', 'development_access', 'sandbox', 'approvalPolicy'):
                with self.assertRaises(Failure): routes.post('/api/ai/turn', {**body, field: str(self.code)})
        self.assertIsNone(session.rpc)

    def test_automatic_or_unknown_developer_policy_never_starts_a_thread(self):
        for index, (policy, reviewer) in enumerate((('never', 'user'), ('on-request', 'guardian'), ('unknown-policy', 'user'))):
            session = self.ai('policy-' + str(index)); session.connect(); session.rpc.policy = policy; session.rpc.reviewer = reviewer
            with self.assertRaises(Failure): self.start(session, 'policy-key-' + str(index))
            self.assertFalse(any(row.get('method') == 'thread/start' for row in session.rpc.sent)); session.close()

    def test_null_config_policy_inherits_only_a_runtime_confirmed_manual_policy(self):
        session = self.ai(); session.connect(); session.rpc.policy = None
        receipt = self.start(session)
        self.assertEqual(receipt['state'], 'running')
        self.assertEqual(session.thread_mode, 'developer')
        params = next(row['params'] for row in session.rpc.sent if row.get('method') == 'thread/start')
        self.assertNotIn('approvalPolicy', params)
        self.done(session); session.close()
        for index, rejected in enumerate(({'approvalPolicy': 'never'}, {'approvalPolicy': None}, {'approvalsReviewer': 'guardian'})):
            other = self.ai('inherited-policy-' + str(index)); other.connect(); other.rpc.policy = None
            original = other.rpc.call
            def call(method, params):
                result = original(method, params)
                if method == 'thread/start': result.update(rejected)
                return result
            with patch.object(other.rpc, 'call', side_effect=call), self.assertRaises(Failure) as failure:
                self.start(other, 'rejected-inheritance-' + str(index))
            self.assertEqual(failure.exception.code, 'manual_approval_unavailable')
            self.assertEqual(other.state, 'suspended')
            self.assertFalse(any(row.get('method') == 'turn/start' for row in other.rpc.sent))

    def test_developer_requires_runtime_confirmation_of_cwd_and_read_only_sandbox(self):
        for index, bad in enumerate(({'cwd': None}, {'cwd': '/unexpected'}, {'sandbox': None}, {'sandbox': {'type': 'dangerFullAccess'}})):
            session = self.ai('unconfirmed-' + str(index)); session.connect(); original = session.rpc.call
            def call(method, params):
                result = original(method, params)
                if method == 'thread/start': result.update(bad)
                return result
            with patch.object(session.rpc, 'call', side_effect=call), self.assertRaises(Failure):
                self.start(session, 'unconfirmed-key-' + str(index))
            self.assertEqual(session.state, 'suspended')
            self.assertFalse(any(row.get('method') == 'turn/start' for row in session.rpc.sent))

    def test_access_defaults_to_manual_and_invalid_operator_values_fail_closed(self):
        self.assertEqual(development_info(self.service.config)['access'], 'manual')
        self.service.config['development_access'] = 'full'
        self.assertEqual(development_info(self.service.config)['access'], 'full')
        for value in (None, False, [], 'danger-full-access', 'auto', 'FULL'):
            self.service.config['development_access'] = value
            report = development_info(self.service.config)
            self.assertFalse(report['available']); self.assertIsNone(report['access'])
            session = self.ai()
            with self.assertRaises(Failure) as error: self.start(session)
            self.assertEqual(error.exception.code, 'development_unavailable')
            self.assertIsNone(session.rpc); self.assertEqual(session.turns, {})

    def test_full_profile_sets_only_thread_policy_without_per_action_approval(self):
        self.service.config['development_access'] = 'full'; before = copy.deepcopy(self.service.config)
        session = self.ai(); session.connect(); session.rpc.policy = 'never'; session.rpc.reviewer = 'auto_review'
        session.metadata_policy_blocked = True
        receipt = session.turn('Develop app', context(), 'full-access-key', model='quick-id', permission_mode='developer')
        params = next(row['params'] for row in session.rpc.sent if row.get('method') == 'thread/start')
        self.assertEqual((params['sandbox'], params['approvalPolicy'], params['approvalsReviewer']),
                         ('danger-full-access', 'never', 'user'))
        self.assertEqual(params['cwd'], str(self.code)); self.assertTrue(params['ephemeral'])
        self.assertEqual(receipt['development_access'], 'full'); self.assertEqual(receipt['model'], 'quick-slug')
        self.assertEqual(self.service.config, before); self.assertEqual(session.pending, {})
        self.assertFalse(any('id' in row for row in session.rpc.sent))
        self.assertIn('including source edits, tests, builds, and local web publication', params['developerInstructions'])
        prompt = [row['params'] for row in session.rpc.sent if row.get('method') == 'turn/start'][-1]['input'][0]['text']
        self.assertIn('Host application access: full', prompt); self.assertIn('approvalPolicy=never', prompt)
        self.assertNotIn('sandbox remains read-only', prompt)
        self.assertNotIn('do not restart or replace the gateway', prompt)

    def test_full_profile_does_not_relax_ordinary_manual_or_read_only_modes(self):
        self.service.config['development_access'] = 'full'
        for index, mode in enumerate(('manual', 'read_only')):
            session = self.ai('restricted-' + str(index)); session.metadata_policy_blocked = True
            with self.assertRaises(Failure) as error: self.start(session, 'blocked-mode-key', mode)
            self.assertEqual(error.exception.code, 'manual_approval_unavailable'); self.assertIsNone(session.rpc)
            session.metadata_policy_blocked = False; self.start(session, 'ordinary-key', mode)
            params = next(row['params'] for row in session.rpc.sent if row.get('method') == 'thread/start')
            self.assertEqual(params['sandbox'], 'read-only'); self.assertNotIn('approvalPolicy', params)
            self.assertFalse(params['config']['features.shell_tool']); self.assertIsNone(session.thread_access)

    def test_full_requires_exact_native_sandbox_policy_reviewer_and_workspace(self):
        self.service.config['development_access'] = 'full'
        cases = ({'cwd': None}, {'sandbox': {'type': 'readOnly'}}, {'sandbox': None},
                 {'approvalPolicy': 'on-request'}, {'approvalPolicy': None}, {'approvalsReviewer': 'guardian'})
        for index, bad in enumerate(cases):
            session = self.ai('bad-full-' + str(index)); session.connect(); original = session.rpc.call
            def call(method, params):
                result = original(method, params)
                if method == 'thread/start': result.update(bad)
                return result
            with patch.object(session.rpc, 'call', side_effect=call), self.assertRaises(Failure) as error:
                self.start(session, 'bad-full-key')
            if 'approvalPolicy' in bad or 'approvalsReviewer' in bad:
                self.assertEqual(error.exception.code, 'development_policy_unconfirmed')
            self.assertFalse(any(row.get('method') == 'turn/start' for row in session.rpc.sent))
            self.assertEqual(session.state, 'suspended'); self.assertFalse(session.history()['recovery']['can_resume'])

    def test_access_changes_create_new_threads_without_relabeling_previous_receipts(self):
        session = self.ai(); manual = self.start(session); first = session.thread_id; self.done(session)
        self.service.config['development_access'] = 'full'
        full = self.start(session, 'became-full-key'); second = session.thread_id; self.done(session)
        self.service.config['development_access'] = 'manual'
        again = self.start(session, 'manual-again-key'); third = session.thread_id; self.done(session)
        self.start(session, 'ordinary-return-key', 'manual'); fourth = session.thread_id
        self.assertEqual(len({first, second, third, fourth}), 4)
        self.assertEqual((manual['development_access'], full['development_access'], again['development_access']), ('manual', 'full', 'manual'))
        starts = [row['params'] for row in session.rpc.sent if row.get('method') == 'thread/start']
        self.assertEqual([params['sandbox'] for params in starts], ['read-only', 'danger-full-access', 'read-only', 'read-only'])
        self.assertNotIn('approvalPolicy', starts[0]); self.assertNotIn('approvalPolicy', starts[2]); self.assertNotIn('approvalPolicy', starts[3])

    def test_existing_manual_pending_is_not_upgraded_or_accepted_when_config_becomes_full(self):
        session = self.ai(); self.start(session); token, _ = self.approval(session)
        self.service.config['development_access'] = 'full'
        with self.assertRaises(Failure): self.start(session, 'cannot-upgrade-pending-key')
        with self.assertRaises(Failure): session.approve(token, 'approve')
        self.assertFalse(any(row.get('id') == 'approval-rpc' for row in session.rpc.sent))
        self.assertEqual(session.turns['developer-key']['development_access'], 'manual')

    def test_full_unexpected_native_requests_suspend_without_fabricated_accept(self):
        self.service.config['development_access'] = 'full'
        for index, method in enumerate(('item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval')):
            session = self.ai('unexpected-' + str(index)); self.start(session)
            token, msg = self.approval(session, method, availableDecisions=['accept', 'decline'])
            self.assertEqual(session.state, 'suspended'); self.assertEqual(session.suspension_reason, 'developer_unexpected_approval')
            self.assertFalse(session.pending[token]['can_approve']); self.assertEqual(session.pending[token]['status'], 'suspended')
            session._receive(msg)
            with self.assertRaises(Failure): session.approve(token, 'approve')
            self.assertFalse(any(row.get('id') == 'approval-rpc' for row in session.rpc.sent))
            self.assertFalse(session.history()['recovery']['can_resume'])

    def test_full_ic_mutation_still_waits_for_human_controlled_service_approval(self):
        self.service.config['development_access'] = 'full'; session = self.ai(); self.start(session)
        request = {'request_id': 'review-request', 'fingerprint': 'frozen-fingerprint', 'state': 'pending_approval'}
        msg = {'id': 'ic-request', 'method': 'item/tool/call', 'params': {'threadId': session.thread_id,
               'turnId': session.turn_id, 'tool': 'ic_apply', 'arguments': {}, 'callId': 'apply-call'}}
        with patch.object(session.service, 'call', return_value=request) as call, patch.object(session.service, 'resolve', return_value={'state': 'accepted'}) as resolve:
            session._tool(msg)
            call.assert_called_once_with('apply', {})
            self.assertEqual(session.pending['review-request']['kind'], 'workbench'); self.assertTrue(session.pending['review-request']['can_approve'])
            self.assertFalse(any(row.get('id') == 'ic-request' for row in session.rpc.sent)); resolve.assert_not_called()
            session.approve('review-request', 'approve')
            resolve.assert_called_once_with('review-request', 'approve', 'frozen-fingerprint')

    def test_full_settings_do_not_change_idempotent_manual_receipts(self):
        session = self.ai(); original = self.start(session); self.done(session)
        self.service.config['development_access'] = 'full'; count = len(session.rpc.sent)
        repeated = self.start(session)
        self.assertEqual(repeated, original); self.assertEqual(repeated['development_access'], 'manual')
        self.assertEqual(len(session.rpc.sent), count)

    def metadata_session(self):
        from test_connection_metadata import FakeRpc
        session = AiSession(self.service, FakeRpc); self.live.append(session); session.connect()
        return session

    def test_full_metadata_exempts_only_developer_and_keeps_real_policy_report(self):
        self.service.config['development_access'] = 'full'; session = self.metadata_session()
        session.rpc.replies['config/read']['config'].update(approval_policy='never', approvals_reviewer='auto_review')
        report = session.connection()
        self.assertEqual(report['policy']['status'], 'blocked'); self.assertTrue(session.metadata_policy_blocked)
        self.assertEqual(report['chat']['status'], 'unverified'); self.assertTrue(report['chat']['requires_developer_mode'])
        self.assertEqual(report['development']['access'], 'full'); self.assertFalse(report['inference']['checked'])
        with self.assertRaises(Failure): self.start(session, 'metadata-normal-key', 'manual')
        session.rpc.replies['thread/start'] = {'thread': {'id': 'metadata-full-thread'}, 'cwd': str(self.code),
            'model': 'fixture-model', 'modelProvider': 'fixture-provider', 'sandbox': {'type': 'dangerFullAccess'},
            'approvalPolicy': 'never', 'approvalsReviewer': 'user'}
        session.rpc.replies['turn/start'] = {'turn': {'id': 'metadata-full-turn'}}
        receipt = session.turn('develop', context(), 'metadata-full-key', model='fixture-id', permission_mode='developer')
        self.assertEqual(receipt['state'], 'running'); self.assertEqual(receipt['development_access'], 'full')

    def test_full_metadata_does_not_hide_login_catalog_or_rpc_errors(self):
        self.service.config['development_access'] = 'full'
        for index, kind in enumerate(('signed_out', 'catalog', 'account', 'quota')):
            service = Service({**self.service.config, 'state_dir': str(self.root / ('metadata-error-' + str(index)))})
            from test_connection_metadata import FakeRpc
            session = AiSession(service, FakeRpc); self.live.append(session); session.connect()
            session.rpc.replies['config/read']['config']['approval_policy'] = 'never'
            if kind == 'signed_out': session.rpc.replies['account/read'] = {'account': None, 'requiresOpenaiAuth': True}
            else:
                method = {'catalog': 'model/list', 'account': 'account/read', 'quota': 'account/rateLimits/read'}[kind]
                session.rpc.replies[method] = Failure('fixture_metadata_failure', 'Synthetic check failed', 4)
            report = session.connection()
            self.assertFalse(report['chat'].get('requires_developer_mode', False))
            self.assertNotEqual(report['chat']['status'], 'unverified')

    def test_full_metadata_can_report_missing_inherited_policy_without_claiming_manual(self):
        self.service.config['development_access'] = 'full'; session = self.metadata_session()
        session.rpc.replies['config/read']['config'].update(approval_policy=None, approvals_reviewer=None)
        report = session.connection()
        self.assertEqual(report['policy']['status'], 'unknown')
        self.assertEqual(report['chat']['status'], 'unverified'); self.assertTrue(report['chat']['requires_developer_mode'])

    def test_full_failed_model_can_resume_input_without_loosening_ordinary_policy(self):
        self.service.config['development_access'] = 'full'; session = self.ai(); session.metadata_policy_blocked = True
        self.start(session)
        session._receive({'method': 'turn/completed', 'params': {'threadId': session.thread_id,
            'turn': {'id': session.turn_id, 'status': 'failed', 'error': {'message': 'Synthetic server failure', 'codexErrorInfo': 'internalServerError'}}}})
        self.assertTrue(session.history()['recovery']['can_resume'])
        turn_id = session.turn_id; count = len(session.rpc.sent)
        session.resume(turn_id)
        self.assertEqual(len(session.rpc.sent), count); self.assertTrue(session.metadata_policy_blocked)
        with self.assertRaises(Failure): self.start(session, 'still-blocked-manual-key', 'manual')


if __name__ == '__main__': unittest.main(verbosity=2)
