"""Real loopback HTTP + synthetic sessions; never starts a model or simulation."""
import copy
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
import urllib.error
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/workbench'))
import remote_node as node
from browser_development import LocalDevelopment
from icwb.service import Failure, digest

ORIGIN, OTHER = 'https://example.github.io', 'https://other.example'
TOKEN = 'x' * 43


class Sessions:
    def __init__(self, service):
        self.service, self.lock, self.deleted, self.rows = service, threading.RLock(), {}, {}
        self.instances = self.rows
        self.create('default')

    def create(self, sid):
        self.rows[sid] = SimpleNamespace(service=self.service, lock=threading.RLock(),
                                        state='idle', pending={}, metadata_busy=False,
                                        active_calls=0, closing=False, deleted=False, turns={})

    def get(self, sid):
        if sid not in self.rows: raise ValueError('Unknown session')
        return self.rows[sid]

    def info(self, sid):
        return {'session_id': sid, 'state': self.get(sid).state}

    def _saved_session(self, sid):
        return {}


class Routes:
    def __init__(self):
        self.service = SimpleNamespace(config={'state_dir': '/synthetic/unused'}, state=Path('/synthetic/unused'))
        self.sessions = Sessions(self.service)
        self.calls = []

    def get(self, path, query):
        return {'development': {'available': True, 'workspace': '/wrong-global-workspace', 'access': 'full'}}

    def post(self, path, body):
        self.calls.append((path, copy.deepcopy(body)))
        return {'accepted': True, 'session_config': copy.deepcopy(self.sessions.get(body.get('session_id', 'default')).service.config)}


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.routes = Routes()
        self.server = node.Server(('127.0.0.1', 0), node.Handler)
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)
        self.node = node.Node(self.routes, TOKEN, [ORIGIN, OTHER], 'fixture', self.base)
        self.settings = LocalDevelopment(Path(self.temp.name) / 'owner-settings', self.routes, self.node.pairing, self.base)
        self.node.development = self.settings
        self.server.node = self.node
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.key = self.pair()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.temp.cleanup()

    def pair(self, origin=ORIGIN):
        rid, csrf = self.node.pairing.create(origin, 'a' * 32)
        return self.node.pairing.decide(rid, csrf, True)['accessCode']

    def call(self, path, body=None, *, token=None, origin=ORIGIN, headers=None):
        h = {'Origin': origin, 'Authorization': 'Bearer ' + (self.key if token is None else token)}
        if body is not None: h['Content-Type'] = 'application/json'
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, headers=h,
                                     data=None if body is None else json.dumps(body).encode())
        try: response = urllib.request.urlopen(req, timeout=3)
        except urllib.error.HTTPError as error: response = error
        with response:
            raw = response.read().decode()
            return response.status, dict(response.headers), raw if response.headers.get_content_type() == 'text/html' else json.loads(raw)

    def form(self, token=None, origin=ORIGIN):
        status, _, data = self.call('/api/ai/development/settings-request', {}, token=token, origin=origin)
        self.assertEqual(status, 200, data)
        url = data['data']['url']; self.assertNotIn(self.key, url); self.assertNotIn(TOKEN, url)
        status, headers, markup = self.call(url[len(self.base):], token='', origin='')
        self.assertEqual(status, 200)
        config = json.loads(re.search(r'const c=(\{[^\n]+?\});', markup).group(1))
        body = {'request_id': config['requestId'], 'csrf': config['csrf'],
                'enabled': True, 'workspace': str(ROOT), 'access': 'manual'}
        return body, headers, markup

    def enable(self, access='full', token=None, origin=ORIGIN):
        body, _, _ = self.form(token=token, origin=origin)
        body['access'] = access
        status, _, data = self.call('/development/settings/confirm', body, token='', origin=self.base)
        self.assertEqual(status, 200, data)
        return body

    def turn(self, sid='default', **extra):
        return {'session_id': sid, 'message': 'synthetic only', 'context': {'version': 1},
                'idempotency_key': 'synthetic-key', 'model': 'catalog-model',
                'reasoning_effort': 'low', 'permission_mode': 'developer', **extra}

    def test_default_disabled_manual_and_configuration_only_for_local_pair(self):
        for token, allowed in [(TOKEN, False), (self.key, True)]:
            status, _, result = self.call('/api/ai/development?session_id=default', token=token)
            self.assertEqual(status, 200)
            self.assertEqual(result['data']['can_configure'], allowed)
            self.assertFalse(result['data']['available'])
            self.assertEqual(result['data']['access'], 'manual')
        self.assertEqual(self.routes.calls, [])
        self.assertFalse(self.settings.path.exists())

    def test_request_is_not_a_permission_grant_and_has_no_overrides(self):
        self.form()
        self.assertEqual(self.call('/api/ai/turn', self.turn())[0], 403)
        self.assertEqual(self.call('/api/ai/development/settings-request', {}, token=TOKEN)[0], 403)
        self.assertEqual(self.call('/api/ai/development/settings-request', {'workspace': str(ROOT)})[0], 400)
        self.assertEqual(self.routes.calls, [])

    def test_popup_has_no_bearer_cors_or_framing_and_defaults_manual(self):
        _, headers, markup = self.form()
        self.assertEqual(headers['X-Frame-Options'], 'DENY')
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertNotIn(TOKEN, markup); self.assertNotIn(self.key, markup)
        self.assertIn('value="manual" selected', markup)
        self.assertNotIn('type="checkbox" checked', markup)

    def test_local_origin_csrf_and_one_use_confirm_required(self):
        body, _, _ = self.form()
        self.assertEqual(self.call('/development/settings/confirm', body)[0], 403)
        self.assertEqual(self.call('/development/settings/confirm', {**body, 'csrf': 'wrong'}, origin=self.base)[0], 403)
        self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base, headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertFalse(self.settings.path.exists())
        self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base)[0], 200)
        self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base)[0], 403)
        self.assertEqual(self.routes.calls, [])

    def test_invalid_choices_and_workspace_do_not_write_or_authorize(self):
        body, _, _ = self.form()
        cases = [{'enabled': 'true'}, {'access': 'auto'}, {'workspace': self.temp.name},
                 {'workspace': 'relative/path'}, {'extra': True}]
        for change in cases:
            with self.subTest(change=change):
                self.assertIn(self.call('/development/settings/confirm', {**body, **change}, origin=self.base)[0], (400, 403))
        self.assertFalse(self.settings.path.exists())
        self.assertEqual(self.call('/api/ai/turn', self.turn())[0], 403)

    def test_full_turn_uses_owner_configuration_without_changing_global_defaults(self):
        self.enable()
        status, _, data = self.call('/api/ai/turn', self.turn())
        self.assertEqual(status, 200, data)
        self.assertEqual(data['data']['session_config']['development_access'], 'full')
        self.assertEqual(data['data']['session_config']['development_workspace'], str(ROOT))
        self.assertNotIn('development_access', self.routes.service.config)
        self.routes.sessions.create('ordinary')
        self.assertNotIn('development_access', self.routes.sessions.get('ordinary').service.config)
        self.assertEqual(self.routes.calls, [('/api/ai/turn', self.turn())])

    def test_manual_developer_choice_preserved(self):
        self.enable('manual')
        status, _, data = self.call('/api/ai/turn', self.turn())
        self.assertEqual(status, 200)
        self.assertEqual(data['data']['session_config']['development_access'], 'manual')

    def test_remote_owner_bearer_other_grant_and_other_origin_do_not_inherit_full(self):
        self.enable()
        other_key = self.pair()
        other_origin_key = self.pair(OTHER)
        for key, origin in [(TOKEN, ORIGIN), (other_key, ORIGIN), (other_origin_key, OTHER)]:
            with self.subTest(origin=origin, owner=key == TOKEN):
                self.assertEqual(self.call('/api/ai/turn', self.turn(), token=key, origin=origin)[0], 403)
                self.assertFalse(self.call('/api/ai/development', token=key, origin=origin)[2]['data']['available'])
        self.assertEqual(self.routes.calls, [])

    def test_public_body_cannot_override_confirmed_profile(self):
        self.enable('manual')
        for extra in [{'development_access': 'full'}, {'development_workspace': '/tmp'}, {'workspace': str(ROOT)}]:
            self.assertEqual(self.call('/api/ai/turn', self.turn(**extra))[0], 400)
        self.assertNotIn('development_access', self.routes.sessions.get('default').service.config)
        self.assertEqual(self.routes.calls, [])

    def test_saved_choice_is_owner_only_prefill_not_authority_after_restart(self):
        self.enable()
        if os.name != 'nt':
            self.assertEqual(self.settings.path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.settings.state.stat().st_mode & 0o777, 0o700)
        raw = self.settings.path.read_text()
        self.assertNotIn(self.key, raw); self.assertNotIn(TOKEN, raw)
        fresh = LocalDevelopment(self.settings.state, self.routes, self.node.pairing, self.base)
        self.node.development = fresh
        self.assertFalse(fresh.capability(self.key, ORIGIN)['available'])
        self.assertEqual(self.call('/api/ai/turn', self.turn())[0], 403)
        _, _, markup = self.form()
        self.assertIn('value="full" selected', markup)
        self.assertNotIn('type="checkbox" checked', markup)

    def test_insecure_and_symlinked_settings_fail_closed(self):
        self.enable()
        if os.name != 'nt':
            self.settings.path.chmod(0o644)
            with self.assertRaises(ValueError): LocalDevelopment(self.settings.state, self.routes, self.node.pairing, self.base)
        self.settings.path.unlink()
        target = Path(self.temp.name) / 'other'; target.write_text('{}')
        try:
            self.settings.path.symlink_to(target)
        except OSError:
            return
        with self.assertRaises(ValueError): LocalDevelopment(self.settings.state, self.routes, self.node.pairing, self.base)
        link = Path(self.temp.name) / 'link'; link.symlink_to(self.settings.state)
        with self.assertRaises(ValueError): LocalDevelopment(link, self.routes, self.node.pairing, self.base)

    def test_settings_ticket_expiry_and_pair_revocation_are_checked_again(self):
        body, _, _ = self.form()
        self.settings.requests[body['request_id']]['expires'] = 0
        self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base)[0], 403)
        body, _, _ = self.form()
        self.node.pairing.revoke(self.key)
        self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base)[0], 403)
        self.assertEqual(self.routes.calls, [])

    def test_grant_revocation_blocks_new_turn_and_existing_native_approval(self):
        self.enable(); self.call('/api/ai/turn', self.turn())
        before = len(self.routes.calls)
        self.node.pairing.revoke(self.key)
        self.assertEqual(self.call('/api/ai/turn', self.turn())[0], 403)
        self.assertEqual(self.call('/api/ai/approval', {'session_id': 'default', 'approval_id': 'one', 'decision': 'approve'}, token=TOKEN)[0], 403)
        self.assertEqual(len(self.routes.calls), before)

    def test_active_unknown_and_pending_session_cannot_start_or_change_settings(self):
        self.enable(); self.call('/api/ai/turn', self.turn())
        session = self.routes.sessions.get('default')
        initial = self.settings.path.read_text()
        for state in ['starting', 'running', 'suspended', 'unknown']:
            session.state = state
            body, _, _ = self.form(); body['access'] = 'manual'
            self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base)[0], 409)
            self.assertEqual(self.call('/api/ai/turn', self.turn())[0], 409)
        session.state = 'complete'
        for pending in ['pending', 'resolving', 'suspended']:
            session.pending = {'one': {'status': pending}}
            body, _, _ = self.form()
            self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base)[0], 409)
        self.assertEqual(self.settings.path.read_text(), initial)
        self.assertEqual(len(self.routes.calls), 1)

    def test_metadata_and_native_call_in_flight_block_settings_change(self):
        self.enable(); self.call('/api/ai/turn', self.turn())
        session = self.routes.sessions.get('default')
        for field in ['metadata_busy', 'active_calls', 'closing', 'deleted']:
            setattr(session, field, True)
            body, _, _ = self.form()
            self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base)[0], 409)
            setattr(session, field, False)

    def test_unrelated_suspended_ordinary_session_is_not_modified(self):
        session = self.routes.sessions.get('default'); session.state = 'suspended'
        self.enable()
        self.routes.sessions.create('new')
        self.assertEqual(self.call('/api/ai/turn', self.turn('new'))[0], 200)
        self.assertEqual(session.state, 'suspended')
        self.assertNotIn('development_access', session.service.config)

    def test_other_browser_cannot_drive_an_authorized_developer_session(self):
        self.enable(); self.call('/api/ai/turn', self.turn())
        other = self.pair(); self.enable(token=other)
        operations = [('/api/ai/turn', self.turn(permission_mode='manual')),
                      ('/api/ai/approval', {'session_id': 'default', 'approval_id': 'one', 'decision': 'approve'}),
                      ('/api/ai/resume', {'session_id': 'default', 'expected_turn_id': 'one'}),
                      ('/api/ai/sessions/delete', {'session_id': 'default'})]
        for path, body in operations:
            self.assertEqual(self.call(path, body, token=other)[0], 403)
        self.assertFalse(self.call('/api/ai/development?session_id=default', token=other)[2]['data']['available'])
        self.assertEqual(len(self.routes.calls), 1)

    def test_ordinary_turn_settings_and_circuit_approval_remain_unchanged(self):
        for permission in ['manual', 'read_only']:
            body = self.turn(permission_mode=permission)
            self.assertEqual(self.call('/api/ai/turn', body, token=TOKEN)[0], 200)
            self.assertEqual(self.routes.calls[-1], ('/api/ai/turn', body))
        approval = {'session_id': 'default', 'approval_id': 'explicit-frozen-request', 'decision': 'deny'}
        self.assertEqual(self.call('/api/ai/approval', approval, token=TOKEN)[0], 200)
        self.assertEqual(self.routes.calls[-1], ('/api/ai/approval', approval))

    def test_disabled_grant_cannot_start_developer_but_keeps_manual_path(self):
        self.enable(); self.call('/api/ai/turn', self.turn())
        body, _, _ = self.form(); body['enabled'] = False
        self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base)[0], 200)
        self.assertEqual(self.call('/api/ai/turn', self.turn())[0], 403)
        self.assertEqual(self.call('/api/ai/turn', self.turn(permission_mode='manual'))[0], 200)
        self.assertEqual(json.loads(self.settings.path.read_text())['access'], 'manual')

    def test_restored_developer_receipt_requires_a_new_conversation(self):
        self.enable()
        session = self.routes.sessions.get('default')
        session.state = 'complete'; session.turns = {'old': {'permission_mode': 'developer', 'state': 'complete'}}
        self.assertEqual(self.call('/api/ai/turn', self.turn())[0], 403)
        self.assertEqual(self.routes.calls, [])

    def test_restored_developer_actions_cannot_use_remote_owner_key(self):
        self.enable()
        session = self.routes.sessions.get('default')
        session.state = 'suspended'; session.turns = {'old': {'permission_mode': 'developer', 'state': 'suspended'}}
        session.pending = {'one': {'status': 'suspended'}}
        for token in [TOKEN, self.key]:
            for path, body in [('/api/ai/approval', {'session_id': 'default', 'approval_id': 'one', 'decision': 'approve'}),
                               ('/api/ai/resume', {'session_id': 'default', 'expected_turn_id': 'old'}),
                               ('/api/ai/turn', self.turn(permission_mode='manual'))]:
                self.assertEqual(self.call(path, body, token=token)[0], 403)
        info = self.call('/api/ai/development?session_id=default')[2]['data']
        self.assertFalse(info['available']); self.assertEqual(info['reason'], 'restored_developer_session')
        self.assertEqual(self.routes.calls, [])
        self.assertEqual(self.call('/api/ai/interrupt', {'session_id': 'default'}, token=TOKEN)[0], 200)
        self.assertEqual(self.routes.calls, [('/api/ai/interrupt', {'session_id': 'default'})])

    def test_saved_developer_capability_does_not_instantiate_a_session(self):
        self.enable()
        self.routes.sessions.instances = {}
        self.routes.sessions._saved_session = lambda sid: {'turns': [{'permission_mode': 'developer'}]}
        info = self.call('/api/ai/development?session_id=default')[2]['data']
        self.assertFalse(info['available']); self.assertEqual(info['reason'], 'restored_developer_session')
        self.assertEqual(self.routes.sessions.instances, {})

    def test_accepted_turn_retransmission_keeps_frozen_receipt_and_profile(self):
        self.enable('manual'); original = self.turn()
        self.assertEqual(self.call('/api/ai/turn', original)[0], 200)
        self.enable('full')
        session = self.routes.sessions.get('default')
        receipt = {'key': original['idempotency_key'], 'permission_mode': 'developer',
                   'development_access': 'manual', 'state': 'running'}
        session.turns[original['idempotency_key']] = copy.deepcopy(receipt)
        requests = []
        def frozen(path, body):
            requests.append(copy.deepcopy(body))
            if body != original: raise Failure('conflict', 'Turn key reused with changed input', 3)
            return copy.deepcopy(receipt)
        self.routes.post = frozen
        for state in ['running', 'suspended']:
            session.state = state
            status, _, data = self.call('/api/ai/turn', original)
            self.assertEqual(status, 200, data); self.assertEqual(data['data'], receipt)
        self.assertEqual(self.call('/api/ai/turn', {**original, 'message': 'changed'})[0], 409)
        self.assertEqual(session.service.config['development_access'], 'manual')
        self.assertEqual(session.turns[original['idempotency_key']], receipt)
        self.assertEqual(len(requests), 3)

    def test_archived_idempotency_receipt_is_not_restarted(self):
        self.enable(); original = self.turn()
        self.call('/api/ai/turn', original)
        session = self.routes.sessions.get('default'); session.state = 'suspended'
        session.service.state = Path(self.temp.name) / 'session'
        file = session.service.state / 'ai-turns' / (digest(original['idempotency_key']) + '.json')
        file.parent.mkdir(parents=True); file.write_text('{"saved":"unknown"}')
        self.routes.post = lambda path, body: {'frozen': True, 'automatic_retry': False}
        status, _, data = self.call('/api/ai/turn', original)
        self.assertEqual(status, 200); self.assertTrue(data['data']['frozen'])
        self.assertEqual(file.read_text(), '{"saved":"unknown"}')
        self.assertEqual(session.state, 'suspended')

    def test_known_checkout_is_only_a_form_suggestion(self):
        self.node.development = LocalDevelopment(self.settings.state, self.routes, self.node.pairing, self.base, workspace_hint=ROOT)
        _, _, markup = self.form()
        self.assertIn('value="' + str(ROOT) + '"', markup)
        self.assertNotIn('type="checkbox" checked', markup)
        self.assertFalse(self.node.development.capability(self.key, ORIGIN)['available'])
        self.assertFalse(self.settings.path.exists())

    def test_inflight_start_blocks_settings_but_does_not_block_interrupt(self):
        self.enable()
        entered, release = threading.Event(), threading.Event()
        results = []
        original_post = self.routes.post
        def delayed(path, body):
            if path == '/api/ai/turn':
                entered.set()
                if not release.wait(3): raise AssertionError('Test did not release synthetic startup')
            return original_post(path, body)
        self.routes.post = delayed
        worker = threading.Thread(target=lambda: results.append(self.call('/api/ai/turn', self.turn())))
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            body, _, _ = self.form(); body['access'] = 'manual'
            self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base)[0], 409)
            self.assertEqual(self.call('/api/ai/interrupt', {'session_id': 'default'}, token=TOKEN)[0], 200)
        finally:
            release.set(); worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0][0], 200)
        self.assertEqual(self.settings.inflight, {})

    def test_changed_profile_is_applied_only_to_next_explicit_turn(self):
        self.enable('manual'); self.call('/api/ai/turn', self.turn())
        session = self.routes.sessions.get('default')
        self.enable('full')
        self.assertEqual(session.service.config['development_access'], 'manual')
        self.assertEqual(self.call('/api/ai/turn', self.turn())[0], 200)
        self.assertEqual(session.service.config['development_access'], 'full')

    def test_unknown_query_session_and_fields_rejected(self):
        self.assertEqual(self.call('/api/ai/development?session_id=missing')[0], 400)
        self.assertEqual(self.call('/api/ai/development?workspace=/tmp')[0], 400)
        self.assertEqual(self.routes.calls, [])

    def test_remote_proxy_and_wrong_host_never_open_local_owner_form(self):
        body, _, _ = self.form()
        path = '/development/settings?request=' + body['request_id']
        self.assertEqual(self.call(path, headers={'Host': 'evil.example'})[0], 403)
        self.node.url = 'https://remote.example'
        self.assertEqual(self.call(path)[0], 403)
        self.assertEqual(self.call('/development/settings/confirm', body, origin=self.base)[0], 403)

    def test_metadata_does_not_leak_developer_capability_to_owner_key(self):
        self.enable(); self.call('/api/ai/turn', self.turn())
        status, _, result = self.call('/api/ai/models?session_id=default', token=TOKEN)
        self.assertEqual(status, 200)
        self.assertFalse(result['data']['development']['available'])
        self.assertIsNone(result['data']['development']['workspace'])


if __name__ == '__main__': unittest.main()
