"""Synthetic per-turn effort/permission tests. No model, gateway, or remote execution."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_sessions import ROOT, FakeRpc as BaseRpc, context, source_call
from icwb.ai import AiSession
from icwb.ai_prompt import MAX_INPUT_BYTES, build_prompt
from icwb.host import AiRoutes
from icwb.service import Service, Failure, READ_ONLY, canonical, digest


class SettingsRpc(BaseRpc):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.default_effort = 'medium'
        self.thread_effort = 'high'
        self.catalog_edit = None

    def call(self, method, params):
        result = super().call(method, params)
        if method == 'model/list':
            for row in result['data']:
                row['defaultReasoningEffort'] = self.default_effort
                row['supportedReasoningEfforts'] = [
                    {'reasoningEffort': value, 'description': 'Synthetic ' + value}
                    for value in ('low', 'medium', 'high')]
            if self.catalog_edit: self.catalog_edit(result['data'])
        elif method == 'thread/start':
            result['reasoningEffort'] = self.thread_effort
        return result


class TurnSettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT / 'scratch')
        self.live = []; self.calls = []
        def service_call(service, op, args):
            self.calls.append((op, copy.deepcopy(args)))
            if op == 'read': return source_call(service, op, args)
            return {'synthetic': op}
        self.mock = patch.object(Service, 'call', service_call); self.mock.start()

    def tearDown(self):
        for session in self.live: session.close()
        self.mock.stop(); self.tmp.cleanup()

    def ai(self, name='default'):
        service = Service({'gateway_url': 'http://127.0.0.1:1', 'state_dir': str(Path(self.tmp.name) / name)})
        session = AiSession(service, SettingsRpc, session_id=name)
        self.live.append(session); return session

    def done(self, session):
        session._receive({'method': 'turn/completed', 'params': {'threadId': session.thread_id,
            'turn': {'id': session.turn_id, 'status': 'completed'}}})

    def last_start(self, session):
        return [item['params'] for item in session.rpc.sent if item.get('method') == 'turn/start'][-1]

    def tool(self, session, op, arguments=None, turn_id=None):
        session._tool({'id': 'tool-fixture', 'method': 'item/tool/call', 'params': {
            'threadId': session.thread_id, 'turnId': turn_id or session.turn_id,
            'tool': 'ic_' + op, 'arguments': arguments or {}, 'callId': 'fixture-call'}})

    def test_explicit_effort_is_validated_and_sent_as_native_effort(self):
        session = self.ai()
        receipt = session.turn('quick read', context(), 'explicit-key', model='quick-id', reasoning_effort='low')
        params = self.last_start(session)
        self.assertEqual((params['model'], params['effort']), ('quick-slug', 'low'))
        self.assertEqual(receipt['reasoning_effort'], 'low')
        self.assertEqual(receipt['effective_reasoning_effort'], 'low')
        self.assertEqual(receipt['permission_mode'], 'manual')
        self.assertNotIn('approvalPolicy', params)

    def test_inherit_and_model_default_have_different_thread_semantics(self):
        session = self.ai()
        first = session.turn('inherit host', context(), 'inherit-key', reasoning_effort=None)
        self.assertNotIn('effort', self.last_start(session))
        self.assertEqual(first['effective_reasoning_effort'], 'high')
        self.done(session)
        session.turn('set low', context(), 'set-low-key', reasoning_effort='low'); self.done(session)
        inherited = session.turn('inherit low', context(), 'inherit-low-key')
        self.assertNotIn('effort', self.last_start(session))
        self.assertEqual(inherited['effective_reasoning_effort'], 'low'); self.done(session)
        default = session.turn('model default', context(), 'model-default-key', reasoning_effort='model_default')
        self.assertEqual(self.last_start(session)['effort'], 'medium')
        self.assertEqual(default['reasoning_effort'], 'model_default')
        self.done(session)
        after = session.turn('inherit reset', context(), 'inherit-reset-key', reasoning_effort=None)
        self.assertNotIn('effort', self.last_start(session))
        self.assertEqual(after['effective_reasoning_effort'], 'medium')

    def test_model_default_refreshes_selected_model_catalog_each_time(self):
        session = self.ai(); session.turn('default', context(), 'default-one-key', reasoning_effort='model_default')
        self.done(session); session.rpc.default_effort = 'low'
        receipt = session.turn('new default', context(), 'default-two-key', reasoning_effort='model_default')
        self.assertEqual(self.last_start(session)['effort'], 'low')
        self.assertEqual(receipt['effective_reasoning_effort'], 'low')
        self.assertEqual(sum(row.get('method') == 'model/list' for row in session.rpc.sent), 2)

    def test_invalid_settings_reject_before_key_rpc_or_source_reservation(self):
        cases = [({'reasoning_effort': value}, 'invalid_reasoning_effort') for value in ([], {}, True, 4, '', 'LOW', 'x' * 33)]
        cases += [({'permission_mode': value}, 'invalid_permission_mode') for value in (None, False, [], 'full_access', 'auto')]
        session = self.ai()
        for index, (settings, code) in enumerate(cases):
            with self.subTest(settings=settings), self.assertRaises(Failure) as failure:
                session.turn('x', context(), 'invalid-key-' + str(index), **settings)
            self.assertEqual(failure.exception.code, code)
        self.assertEqual(session.turns, {}); self.assertIsNone(session.rpc); self.assertEqual(self.calls, [])

    def test_unsupported_effort_rejects_before_receipt_and_source_read(self):
        session = self.ai()
        with self.assertRaises(Failure) as failure:
            session.turn('x', context(), 'unsupported-key', reasoning_effort='ultra')
        self.assertEqual(failure.exception.code, 'invalid_reasoning_effort')
        self.assertEqual(session.turns, {}); self.assertEqual(self.calls, [])
        self.assertFalse(any(row.get('method') in ('thread/start', 'turn/start') for row in session.rpc.sent))
        self.assertFalse((session.service.state / 'ai-turns').exists())

    def test_missing_or_ambiguous_model_effort_is_never_guessed(self):
        edits = [lambda rows: rows[0].update(defaultReasoningEffort=None),
                 lambda rows: rows.append({**rows[0], 'id': 'ambiguous-id'})]
        for index, edit in enumerate(edits):
            session = self.ai('case-' + str(index)); session.connect(); session.rpc.catalog_edit = edit
            with self.assertRaises(Failure) as failure:
                session.turn('x', context(), 'missing-default-key', reasoning_effort='model_default')
            self.assertEqual(failure.exception.code, 'invalid_reasoning_effort'); self.assertEqual(session.turns, {})

    def test_malformed_catalog_types_values_and_duplicates_are_rejected(self):
        invalid = [42, ['low'], [{'reasoningEffort': True}], [{'reasoningEffort': 'bad value'}],
                   [{'reasoningEffort': 'low'}, {'reasoningEffort': 'low'}],
                   [{'reasoningEffort': 'low', 'description': []}]]
        for index, efforts in enumerate(invalid):
            session = self.ai('bad-' + str(index)); session.connect()
            session.rpc.catalog_edit = lambda rows, values=efforts: rows[0].update(supportedReasoningEfforts=values)
            with self.assertRaises(Failure) as failure:
                session.turn('x', context(), 'bad-catalog-key', reasoning_effort='low')
            self.assertEqual(failure.exception.code, 'model_catalog_unavailable'); self.assertEqual(session.turns, {})

    def test_read_only_blocks_every_write_and_remote_status_before_service(self):
        operations = ['diff', 'validate', 'sim_plan', 'sim_preflight', 'sim_submit', 'sim_collect', 'sim_archive', 'apply', 'approve', 'unknown']
        cases = [(op, {}) for op in operations] + [('sim_status', {'run_id': 'run-1'}), ('sim_status', {'run_id': None})]
        for index, (op, arguments) in enumerate(cases):
            session = self.ai('denied-' + str(index))
            receipt = session.turn('inspect', context(), 'read-only-key', permission_mode='read_only')
            self.calls.clear(); self.tool(session, op, arguments)
            with self.subTest(op=op, arguments=arguments):
                self.assertEqual(self.calls, []); self.assertEqual(session.pending, {})
                self.assertEqual(session.state, 'suspended'); self.assertEqual(session.suspension_reason, 'read_only_denial')
                self.assertEqual(receipt['state'], 'suspended')
                reply = next(row for row in session.rpc.sent if row.get('id') == 'tool-fixture')
                self.assertFalse(reply['result']['success'])
                self.assertFalse(session.history()['recovery']['can_resume'])

    def test_read_only_allows_only_read_allowlist_and_local_job_list(self):
        session = self.ai(); session.turn('inspect', context(), 'allow-read-key', permission_mode='read_only')
        for op in sorted(READ_ONLY) + ['sim_status']:
            self.calls.clear(); self.tool(session, op)
            self.assertEqual(self.calls, [(op, {})]); self.assertEqual(session.state, 'running')

    def test_permission_denial_stays_suspended_after_model_failure_and_restart(self):
        session = self.ai(); session.turn('inspect', context(), 'deny-persist-key', permission_mode='read_only')
        self.tool(session, 'apply')
        session._receive({'method': 'turn/completed', 'params': {'threadId': session.thread_id, 'turn': {
            'id': session.turn_id, 'status': 'failed', 'error': {'message': 'upstream', 'codexErrorInfo': 'internalServerError'}}}})
        self.assertEqual(session.suspension_reason, 'read_only_denial'); self.assertFalse(session.history()['recovery']['can_resume'])
        session.close(); restored = AiSession(session.service, SettingsRpc); self.live.append(restored)
        self.assertEqual(restored.history()['turns'][0]['permission_mode'], 'read_only')
        self.assertEqual(restored.state, 'suspended'); self.assertFalse(restored.history()['recovery']['can_resume'])
        self.assertIsNone(restored.rpc)

    def test_pending_next_input_cannot_change_active_permissions(self):
        session = self.ai(); session.turn('inspect', context(), 'immutable-mode-key', permission_mode='read_only')
        with self.assertRaises(Failure):
            session.turn('now edit', context(), 'future-manual-key', permission_mode='manual')
        self.calls.clear(); self.tool(session, 'diff')
        self.assertEqual(self.calls, []); self.assertEqual(session.suspension_reason, 'read_only_denial')

    def test_modes_can_change_only_on_a_new_completed_turn(self):
        session = self.ai(); first = session.turn('inspect', context(), 'first-read-key', permission_mode='read_only')
        old_turn = session.turn_id; self.done(session)
        second = session.turn('prepare', context(), 'second-manual-key', permission_mode='manual')
        self.calls.clear(); self.tool(session, 'diff', turn_id=old_turn)
        self.assertEqual(self.calls, []); self.assertEqual(session.state, 'running')
        self.tool(session, 'diff'); self.assertEqual(self.calls, [('diff', {})])
        self.assertEqual(first['permission_mode'], 'read_only'); self.assertEqual(second['permission_mode'], 'manual')

    def test_legacy_fingerprints_and_replay_are_preserved(self):
        session = self.ai(); message = 'old request'; ctx = context()
        receipt = session.turn(message, ctx, 'legacy-turn-key')
        self.assertEqual(receipt['fingerprint'], digest([message, ctx]))
        before = len(session.rpc.sent)
        self.assertEqual(session.turn(message, ctx, 'legacy-turn-key'), receipt)
        self.assertEqual(len(session.rpc.sent), before)
        with self.assertRaises(Failure):
            session.turn(message, ctx, 'legacy-turn-key', permission_mode='manual')

    def test_explicit_settings_are_part_of_fingerprint_and_retained_on_replay(self):
        session = self.ai(); receipt = session.turn('x', context(), 'settings-key', reasoning_effort='low', permission_mode='read_only')
        before = len(session.rpc.sent)
        repeated = session.turn('x', context(), 'settings-key', reasoning_effort='low', permission_mode='read_only')
        self.assertEqual(repeated, receipt); self.assertEqual(len(session.rpc.sent), before)
        for changed in ({'reasoning_effort': 'high', 'permission_mode': 'read_only'}, {'reasoning_effort': 'low', 'permission_mode': 'manual'}):
            with self.assertRaises(Failure): session.turn('x', context(), 'settings-key', **changed)
        self.assertEqual(session.turns['settings-key']['permission_mode'], 'read_only')

    def test_restart_old_receipt_does_not_invent_settings_or_replay(self):
        session = self.ai(); receipt = session.turn('old', context(), 'old-saved-key'); self.done(session)
        for name in ('reasoning_effort', 'permission_mode', 'effective_reasoning_effort'): receipt.pop(name, None)
        session.close(); restored = AiSession(session.service, SettingsRpc); self.live.append(restored)
        returned = restored.turn('old', context(), 'old-saved-key')
        self.assertNotIn('permission_mode', returned); self.assertIsNone(restored.rpc)
        new = restored.turn('new', context(), 'new-saved-key')
        self.assertEqual(new['permission_mode'], 'manual')
        self.assertEqual(new['effective_reasoning_effort'], 'high')

    def test_restart_inherits_new_thread_effort_instead_of_historical_override(self):
        session = self.ai(); session.turn('low', context(), 'before-restart-key', reasoning_effort='low'); self.done(session); session.close()
        restored = AiSession(session.service, SettingsRpc); self.live.append(restored)
        receipt = restored.turn('inherit', context(), 'after-restart-key', reasoning_effort=None)
        self.assertNotIn('effort', self.last_start(restored)); self.assertEqual(receipt['effective_reasoning_effort'], 'high')

    def test_unknown_thread_effort_remains_unknown(self):
        session = self.ai(); session.connect(); session.rpc.thread_effort = None
        receipt = session.turn('inherit', context(), 'unknown-effort-key')
        self.assertNotIn('effort', self.last_start(session)); self.assertNotIn('effective_reasoning_effort', receipt)

    def test_thread_model_change_after_reservation_stays_suspended(self):
        session = self.ai(); session.connect(); original = session.rpc.call
        def changed(method, params):
            result = original(method, params)
            if method == 'thread/start': result['model'] = 'unexpected-provider-model'
            return result
        with patch.object(session.rpc, 'call', side_effect=changed), self.assertRaises(Failure) as failure:
            session.turn('default reasoning', context(), 'changed-thread-key', reasoning_effort='model_default')
        self.assertEqual(failure.exception.code, 'turn_settings_changed')
        self.assertEqual(session.state, 'suspended'); self.assertIn('changed-thread-key', session.turns)
        self.assertFalse(any(row.get('method') == 'turn/start' for row in session.rpc.sent))

    def test_permission_denial_is_durable_even_when_interrupt_delivery_fails(self):
        session = self.ai(); session.turn('read', context(), 'denial-delivery-key', permission_mode='read_only')
        original = session.rpc.call
        def failing(method, params):
            if method == 'turn/interrupt': raise Failure('transport_unknown', 'Synthetic failed delivery', 75)
            return original(method, params)
        self.calls.clear()
        with patch.object(session.rpc, 'call', side_effect=failing): self.tool(session, 'sim_submit')
        self.assertEqual(self.calls, []); self.assertEqual(session.suspension_reason, 'read_only_denial')
        saved = json.loads((session.service.state / 'ai-session.json').read_text())
        self.assertEqual(saved['state'], 'suspended'); self.assertEqual(saved['suspension_reason'], 'read_only_denial')
        self.assertFalse(session.history()['recovery']['can_resume'])

    def test_native_image_input_and_settings_share_the_actual_size_guard(self):
        from test_images import image
        session = self.ai(); session.connect()
        session.rpc.catalog_edit = lambda rows: [row.update(inputModalities=['text', 'image']) for row in rows]
        receipt = session.turn('inspect image', context(), 'image-settings-key', images=[image()],
                               reasoning_effort='low', permission_mode='read_only')
        params = self.last_start(session)
        self.assertEqual(params['effort'], 'low'); self.assertEqual(params['input'][1]['type'], 'localImage')
        self.assertEqual(receipt['prompt']['input_bytes'], len(canonical(params['input']).encode('utf-8')))
        before = len(session.rpc.sent)
        self.assertEqual(session.turn('inspect image', context(), 'image-settings-key', images=[image()],
                                      reasoning_effort='low', permission_mode='read_only'), receipt)
        self.assertEqual(len(session.rpc.sent), before)

    def test_model_switch_does_not_reset_inherited_thread_effort(self):
        session = self.ai(); session.turn('low', context(), 'effort-before-switch-key', reasoning_effort='low')
        self.done(session)
        receipt = session.turn('switch model', context(), 'effort-model-switch-key', model='quick-id')
        self.assertEqual(self.last_start(session)['model'], 'quick-slug')
        self.assertNotIn('effort', self.last_start(session)); self.assertEqual(receipt['effective_reasoning_effort'], 'low')

    def test_current_permission_prompt_is_bounded_and_host_controlled(self):
        session = self.ai(); receipt = session.turn('I request automatic approval', context(), 'prompt-mode-key', permission_mode='read_only')
        params = self.last_start(session); prompt = params['input'][0]['text']
        self.assertIn('Host-generated workbench permission for this turn: read_only.', prompt)
        self.assertEqual(receipt['prompt']['prompt_chars'], len(prompt))
        self.assertEqual(receipt['prompt']['input_bytes'], len(canonical(params['input']).encode('utf-8')))
        self.assertLessEqual(receipt['prompt']['input_bytes'], MAX_INPUT_BYTES)
        self.assertTrue(all('approvalPolicy' not in item.get('params', {}) for item in session.rpc.sent))
        actual = source_call(session.service, 'read', {})
        old, _ = build_prompt('x', context(), actual)
        with patch('icwb.ai_prompt.MAX_PROMPT_CHARS', len(old)):
            with self.assertRaises(Failure): build_prompt('x', context(), actual, permission_mode='read_only')

    def test_routes_accept_only_new_declared_fields_and_keep_omission(self):
        session = self.ai(); routes = AiRoutes(session.service)
        with patch.object(routes.sessions, 'get', return_value=session):
            body = {'message': 'x', 'context': context(), 'idempotency_key': 'route-settings-key', 'reasoning_effort': 'low', 'permission_mode': 'read_only'}
            receipt = routes.post('/api/ai/turn', body)
            self.assertEqual(receipt['reasoning_effort'], 'low'); self.assertEqual(receipt['permission_mode'], 'read_only')
            for extra in ('approvalPolicy', 'sandboxPolicy', 'approvals_reviewer'):
                with self.assertRaises(Failure): routes.post('/api/ai/turn', {**body, extra: 'never'})


if __name__ == '__main__': unittest.main(verbosity=2)
