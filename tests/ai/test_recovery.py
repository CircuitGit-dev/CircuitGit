"""Explicit input recovery from proven model failures. Fake RPC only; no model or EDA calls."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_sessions import FakeRpc, context, source_call
from icwb.ai import AiSession, recoverable_model_error
from icwb.host import AiRoutes
from icwb.service import Service, Failure, digest


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.service = Service({'gateway_url': 'http://127.0.0.1:1', 'state_dir': self.tmp.name})
        self.patch = patch.object(Service, 'call', source_call); self.patch.start()
        self.sessions = []
        self.ai = self.session()

    def tearDown(self):
        for ai in self.sessions: ai.close()
        self.patch.stop(); self.tmp.cleanup()

    def session(self, service=None, sid='default'):
        ai = AiSession(service or self.service, FakeRpc, session_id=sid)
        self.sessions.append(ai); return ai

    def start(self):
        return self.ai.turn('A synthetic model connection check', context(), 'recovery-original-key', 'quick-id')

    def complete(self, status='failed', error=None):
        error = error or {'message': 'Synthetic upstream is overloaded', 'codexErrorInfo': 'internalServerError'}
        self.ai._receive({'method': 'turn/completed', 'params': {'threadId': self.ai.thread_id,
            'turn': {'id': self.ai.turn_id, 'status': status, 'error': error, 'durationMs': 51}}})

    def test_failed_turn_can_reopen_input_without_replaying_or_altering_history(self):
        receipt = self.start(); tid = receipt['turn_id']; self.complete()
        history = self.ai.history(); messages = copy.deepcopy(history['messages']); sent = copy.deepcopy(self.ai.rpc.sent)
        self.assertEqual(history['recovery'], {'can_resume': True, 'reason': 'model_failure', 'expected_turn_id': tid})
        self.assertEqual(self.ai.poll(0)['recovery'], history['recovery'])
        with self.assertRaises(Failure): self.ai.turn('No implicit recovery', context(), 'next-before-resume', 'quick-id')
        result = self.ai.resume(tid)
        self.assertEqual(result, {'session_id': 'default', 'state': 'complete', 'resumed': True, 'history_retained': True, 'automatic_retry': False})
        self.assertEqual(self.ai.rpc.sent, sent); self.assertEqual(self.ai.messages, messages)
        old = self.ai.turns['recovery-original-key']
        self.assertEqual(old['state'], 'suspended'); self.assertEqual(old['terminal_status'], 'failed')
        self.assertIn('input_resumed_at_ms', old); self.assertIsNone(self.ai.request_key); self.assertIsNone(self.ai.turn_id)
        self.assertFalse(self.ai.history()['recovery']['can_resume'])
        # Reusing the original key remains a receipt read, not a new turn.
        self.assertEqual(self.ai.turn('A synthetic model connection check', context(), 'recovery-original-key', 'quick-id'), old)
        self.assertEqual(self.ai.rpc.sent, sent)
        self.ai.turn('A new question after explicit recovery', context(), 'next-after-recovery', 'quick-id')
        self.assertEqual(sum(r.get('method') == 'turn/start' for r in self.ai.rpc.sent), 2)

    def test_stale_or_repeated_resume_cannot_change_state(self):
        receipt = self.start(); self.complete()
        before = copy.deepcopy(self.ai.history())
        for value in ('wrong-turn', '', None, 13, 'x' * 241):
            with self.subTest(value=value), self.assertRaises(Failure): self.ai.resume(value)
        self.assertEqual(self.ai.history(), before)
        self.ai.resume(receipt['turn_id'])
        with self.assertRaises(Failure): self.ai.resume(receipt['turn_id'])

    def test_pending_approvals_and_other_inflight_operations_block_recovery(self):
        receipt = self.start(); self.complete()
        for status in ('pending', 'resolving', 'suspended'):
            self.ai.pending['approval'] = {'status': status}
            with self.subTest(status=status):
                self.assertEqual(self.ai.history()['recovery']['reason'], 'unresolved_approval')
                with self.assertRaises(Failure): self.ai.resume(receipt['turn_id'])
        self.ai.pending.clear()
        for attr, value in [('metadata_busy', True), ('metadata_policy_blocked', True), ('metadata_start_failed', True), ('active_calls', 1)]:
            original = getattr(self.ai, attr); setattr(self.ai, attr, value)
            with self.subTest(attribute=attr):
                self.assertFalse(self.ai.history()['recovery']['can_resume'])
                with self.assertRaises(Failure): self.ai.resume(receipt['turn_id'])
            setattr(self.ai, attr, original)

    def test_unknown_timeout_interrupt_denial_disconnect_and_shutdown_remain_suspended(self):
        receipt = self.start(); tid = receipt['turn_id']
        self.assertFalse(self.ai.history()['recovery']['can_resume'])
        self.ai.state = 'suspended'
        self.assertEqual(self.ai.history()['recovery']['reason'], 'unknown_outcome')
        with self.assertRaises(Failure): self.ai.resume(tid)
        self.ai.state = 'running'; self.complete()
        for reason in ('user_interrupt', 'human_denial', 'browser_heartbeat_lost', 'operation_error', 'approval_failed', 'transport_disconnected', 'manual_approval_unavailable', 'shutdown_unfinished'):
            self.ai.suspension_reason = reason
            with self.subTest(reason=reason), self.assertRaises(Failure): self.ai.resume(tid)
        self.ai.suspension_reason = 'model_failure'; self.ai.rpc.closed = True
        with self.assertRaises(Failure): self.ai.resume(tid)

    def test_permission_and_unclassified_terminal_errors_are_not_resumable(self):
        self.start()
        for error in [
            {'message': 'Unknown error', 'codexErrorInfo': 'unknown'},
            {'message': 'Not authorized', 'codexErrorInfo': {'httpConnectionFailed': {'httpStatusCode': 401}}},
            {'message': 'Forbidden', 'codexErrorInfo': {'httpConnectionFailed': {'httpStatusCode': 403}}},
            {'message': 'Permission denied', 'codexErrorInfo': 'internalServerError'},
            {'message': 'Denied', 'codexErrorInfo': {'httpConnectionFailed': {'httpStatusCode': None}}},
        ]:
            self.ai.state = 'running'; self.ai.turns[self.ai.request_key].pop('terminal_evidence', None)
            self.complete(error=error)
            with self.subTest(error=error):
                self.assertFalse(self.ai.history()['recovery']['can_resume'])
                with self.assertRaises(Failure): self.ai.resume(self.ai.turn_id)
        for status in (408, 429, 500, 502, 503, 504):
            self.assertTrue(recoverable_model_error({'message': 'Synthetic service failure', 'codexErrorInfo': {'httpConnectionFailed': {'httpStatusCode': status}}}))

    def test_failed_terminal_proof_survives_restart_without_starting_rpc(self):
        receipt = self.start(); self.complete(); self.ai.close()
        restored = self.session(); self.assertIsNone(restored.rpc)
        self.assertEqual(restored.history()['recovery']['expected_turn_id'], receipt['turn_id'])
        self.assertTrue(restored.history()['recovery']['can_resume'])
        restored.resume(receipt['turn_id']); self.assertIsNone(restored.rpc)
        self.assertEqual(restored.messages[0]['text'], 'A synthetic model connection check')
        saved = json.loads((self.service.state / 'ai-session.json').read_text())
        self.assertEqual(saved['state'], 'complete'); self.assertEqual(saved['turns'][0]['state'], 'suspended')

    def test_legacy_live_event_requires_exact_identity_and_no_unsafe_event(self):
        receipt = self.start(); self.complete()
        for key in ('terminal_evidence', 'terminal_error', 'terminal_status'): receipt.pop(key)
        self.ai.suspension_reason = None
        self.assertTrue(self.ai.history()['recovery']['can_resume'])
        self.ai.events[-1]['params']['turn']['id'] = 'different-turn'
        self.assertFalse(self.ai.history()['recovery']['can_resume'])
        self.ai.events[-1]['params']['turn']['id'] = self.ai.turn_id
        self.ai.event('session/interrupted', {'reason': 'human_denial'})
        self.assertFalse(self.ai.history()['recovery']['can_resume'])

    def test_legacy_persisted_suspension_is_not_upgraded_without_terminal_proof(self):
        self.start(); self.complete()
        for key in ('terminal_evidence', 'terminal_error', 'terminal_status'): self.ai.turns[self.ai.request_key].pop(key)
        self.ai.suspension_reason = None; self.ai.close()
        restored = self.session()
        self.assertFalse(restored.history()['recovery']['can_resume'])
        self.assertEqual(restored.history()['recovery']['reason'], 'unknown_outcome')

    def test_real_interrupt_then_model_terminal_cannot_override_the_stop_reason(self):
        receipt = self.start(); self.ai.interrupt('human_denial'); self.complete()
        self.assertEqual(self.ai.history()['recovery']['reason'], 'human_denial')
        with self.assertRaises(Failure): self.ai.resume(receipt['turn_id'])

    def test_proof_identity_mismatch_and_saved_unfinished_state_fail_closed(self):
        receipt = self.start(); self.complete()
        receipt['terminal_evidence']['turn_id'] = 'other-turn'
        self.assertFalse(self.ai.history()['recovery']['can_resume'])
        with self.assertRaises(Failure): self.ai.resume(receipt['turn_id'])
        receipt['terminal_evidence']['turn_id'] = receipt['turn_id']; self.ai.close()
        path = self.service.state / 'ai-session.json'; saved = json.loads(path.read_text()); saved['state'] = 'running'
        path.write_text(json.dumps(saved))
        restored = self.session()
        self.assertEqual(restored.history()['recovery']['reason'], 'restart_unfinished')
        with self.assertRaises(Failure): restored.resume(receipt['turn_id'])

    def test_late_old_terminal_notifications_do_not_suspend_recovered_input(self):
        receipt = self.start(); tid = receipt['turn_id']; thread = receipt['thread_id']; self.complete(); self.ai.resume(tid)
        count = len(self.ai.events)
        for method, params in [('turn/completed', {'threadId': thread, 'turn': {'id': tid, 'status': 'failed'}}),
                               ('error', {'threadId': thread, 'turnId': tid, 'error': {'message': 'late'}})]:
            self.ai._receive({'method': method, 'params': params})
        self.assertEqual(self.ai.state, 'complete'); self.assertEqual(len(self.ai.events), count)

    def test_error_receipt_is_bounded_redacted_and_persisted_in_both_records(self):
        receipt = self.start(); self.complete(error={'message': 'Bearer hidden-token password=private ' + 'x' * 4000,
            'codexErrorInfo': {'httpConnectionFailed': {'httpStatusCode': 503, 'private': 'DO_NOT_COPY'}}, 'additionalDetails': 'DO_NOT_COPY'})
        self.assertLessEqual(len(receipt['terminal_error']['message']), 2000)
        self.assertNotIn('hidden-token', json.dumps(receipt)); self.assertNotIn('DO_NOT_COPY', json.dumps(receipt))
        one = json.loads((self.service.state / 'ai-turns' / (digest(receipt['key']) + '.json')).read_text())
        saved = json.loads((self.service.state / 'ai-session.json').read_text())
        self.assertEqual(one['terminal_evidence'], saved['turns'][0]['terminal_evidence'])
        self.assertEqual(saved['suspension_reason'], 'model_failure')

    def test_route_requires_exact_session_and_turn_fields(self):
        routes = AiRoutes(self.service); routes.sessions.factory = lambda service, session_id: self.session(service, session_id)
        try:
            for body in ({}, {'expected_turn_id': 'turn'}, {'session_id': 'default'},
                         {'session_id': 'default', 'expected_turn_id': 'turn', 'approve': True}):
                with self.subTest(body=body), self.assertRaises(Failure): routes.post('/api/ai/resume', body)
            ai = routes.sessions.get('default'); ai.turn('Synthetic route test', context(), 'route-failure-key')
            ai._receive({'method': 'turn/completed', 'params': {'threadId': ai.thread_id,
                'turn': {'id': ai.turn_id, 'status': 'failed', 'error': {'message': 'Synthetic failure', 'codexErrorInfo': 'internalServerError'}}}})
            tid = ai.turn_id; sent = copy.deepcopy(ai.rpc.sent)
            result = routes.post('/api/ai/resume', {'session_id': 'default', 'expected_turn_id': tid})
            self.assertTrue(result['resumed']); self.assertEqual(sent, ai.rpc.sent)
        finally: routes.close()


if __name__ == '__main__': unittest.main(verbosity=2)
