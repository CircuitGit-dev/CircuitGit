"""Synthetic host + gateway only. No real approval, model, network or simulation."""
import copy
import io
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'apps/codex'), str(ROOT/'modules/gateway_client')]
from icwb.elicitation import INPUT_SCHEMA, MAX_REVIEW_BYTES, ReviewSession, form_supported, tools
from icwb.mcp import MAX_REQUEST, run
from icwb.service import Failure, Service, atom, canonical, digest

ARGS = {'project_id': 'SYNTHETIC-project', 'configuration': 'SYNTHETIC-tran',
        'source_commit': 'a'*40, 'idempotency_key': 'SYNTHETIC-never-real'}
RID = digest(['SYNTHETIC', ARGS['idempotency_key']])
FP = digest(['sim_submit', ARGS])
BINDING = {'request_id': RID, 'fingerprint': FP}
CAPS = {'elicitation': {'form': {}}}


class SyntheticGateway:
    origin = 'http://127.0.0.1:1'
    def __init__(self, service, mode):
        self.service, self.mode, self.dispatches = service, mode, 0

    def request(self, path, body=None):
        print('SYNTHETIC gateway diagnostic (must be stderr in MCP)')
        if path == '/api/project' and body is None:
            return {'fixture': 'SYNTHETIC', 'dispatches': self.dispatches,
                    'resolutions': self.service.resolutions}
        if path != '/SYNTHETIC/dispatch' or body != {'fixture': True}:
            raise AssertionError('Unexpected route; no actual gateway is allowed')
        # Exercise the existing real resolver's durable-before-dispatch invariant.
        assert self.service.saved('requests', RID)['state'] == 'dispatching'
        self.dispatches += 1
        if self.mode == 'unknown':
            raise Failure('transport_unknown', 'SYNTHETIC lost result', 75)
        return {'fixture': True, 'run_id': 'SYNTHETIC-run'}


class SyntheticService(Service):
    def __init__(self, root, mode='normal'):
        super().__init__({'gateway_url': SyntheticGateway.origin, 'state_dir': str(root),
                          'disabled_operations': ['sim_submit'] if mode == 'policy' else []})
        self.resolutions = 0
        self.gateway = SyntheticGateway(self, mode)
        receipt = {'schema': 'ic.workbench.request.v1', **BINDING,
                   'gateway': self.gateway.origin, 'operation': 'sim_submit',
                   'arguments': copy.deepcopy(ARGS), 'route': '/SYNTHETIC/dispatch',
                   'body': {'fixture': True}, 'state': 'pending_approval',
                   'review': {'project_id': ARGS['project_id'], 'source_commit': ARGS['source_commit'],
                              'diff': '--- SYNTHETIC old\n+++ SYNTHETIC new\n-stop=1n\n+stop=2n'},
                   'automatic_retry': False}
        atom(self.state/'requests'/(RID+'.json'), receipt)

    def resolve(self, *args):
        print('SYNTHETIC resolver diagnostic (must be stderr in MCP)')
        self.resolutions += 1
        return super().resolve(*args)


class SyntheticViews:
    def resources(self):
        print('SYNTHETIC resource diagnostic')
        return [{'uri': 'ui://SYNTHETIC'}]

    def read_resource(self, uri):
        assert uri == 'ui://SYNTHETIC'
        print('SYNTHETIC read resource diagnostic')
        return {'contents': [{'uri': uri, 'text': 'SYNTHETIC HTML only'}]}

    def call(self, name, args):
        return {'fixture': 'SYNTHETIC view', 'name': name}, None


class SyntheticLifecycle:
    tool_names = {'ic_plugin_status', 'ic_plugin_connect'}
    def __init__(self, fail=False):
        self.events, self.fail = [], fail

    def tools(self):
        print('SYNTHETIC lifecycle diagnostic')
        return [{'name': n, 'inputSchema': {'type': 'object', 'properties': {},
                                          'additionalProperties': False}}
                for n in sorted(self.tool_names)]

    def ensure(self):
        self.events.append('ensure')
        print('SYNTHETIC ensure diagnostic')
        if self.fail:
            raise Failure('forbidden', 'SYNTHETIC policy blocked connection', 4)

    def call(self, name, args):
        if args != {}:
            raise Failure('invalid_input', 'No lifecycle arguments')
        self.events.append(name)
        return {'fixture': True, 'events': self.events[:]}


def request(rid, method, params=None):
    return {'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params or {}}


def tool(rid, name, args=None):
    return request(rid, 'tools/call', {'name': name, 'arguments': args or {}})


class FakeHost:
    """Real stdio transport, strictly synthetic subprocess service."""
    def __init__(self, root, timeout=2, mode='normal', capabilities=CAPS, protocol='2025-11-25'):
        self.process = subprocess.Popen([sys.executable, '-u', '-B', __file__, '--synthetic-stdio',
            str(root), str(timeout), mode], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
        self.buffer, self.messages = b'', []
        self.send(request(1, 'initialize', {'protocolVersion': protocol, 'capabilities': capabilities}))
        assert self.read()['id'] == 1
        self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def send(self, *messages):
        self.raw((''.join(canonical(m)+'\n' for m in messages)).encode())

    def raw(self, data):
        self.process.stdin.write(data)
        self.process.stdin.flush()

    def read(self, timeout=4):
        deadline = time.monotonic()+timeout
        while b'\n' not in self.buffer:
            left = deadline-time.monotonic()
            if left <= 0 or not select.select([self.process.stdout.fileno()], [], [], left)[0]:
                raise AssertionError('Synthetic host timed out waiting for protocol output')
            data = os.read(self.process.stdout.fileno(), 65536)
            if not data:
                raise AssertionError('Unexpected EOF from synthetic MCP')
            self.buffer += data
        line, self.buffer = self.buffer.split(b'\n', 1)
        value = json.loads(line)  # Any diagnostic on stdout makes the test fail.
        assert value['jsonrpc'] == '2.0'
        self.messages.append(value)
        return value

    def begin(self, rid=2):
        self.send(tool(rid, 'ic_request_review', BINDING))
        message = self.read()
        assert message['method'] == 'elicitation/create', message
        return message

    def answer(self, elicitation, result):
        self.send({'jsonrpc': '2.0', 'id': elicitation['id'], 'result': result})
        return self.read()

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)
        remainder = self.process.stdout.read()
        stderr = self.process.stderr.read().decode()
        self.process.stdout.close()
        self.process.stderr.close()
        assert self.process.returncode == 0, stderr
        for line in (self.buffer+remainder).splitlines():
            json.loads(line)
        return stderr


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.service = SyntheticService(Path(self.temp.name)/'state')
        self.sent, self.finished, self.now = [], [], 0
        self.session = ReviewSession(self.service, self.sent.append,
            lambda rid, **value: self.finished.append((rid, value)), timeout=5, clock=lambda: self.now)

    def tearDown(self):
        self.temp.cleanup()

    def begin(self):
        self.assertIsNone(self.session.begin(BINDING, 10, CAPS, '2025-11-25'))
        return self.sent[-1]['id']

    def answer(self, result):
        self.session.receive({'jsonrpc': '2.0', 'id': self.sent[-1]['id'], 'result': result})

    def state(self):
        return self.service.saved('requests', RID)['state']

    def test_closed_model_schema_and_flags_are_rejected(self):
        self.assertEqual(set(INPUT_SCHEMA['required']), set(BINDING))
        self.assertFalse(INPUT_SCHEMA['additionalProperties'])
        self.assertEqual(tools()[0]['_meta']['ui']['visibility'], ['model', 'app'])
        for args in [None, [], {}, {**BINDING, 'decision': 'approve'}, {**BINDING, 'confirmed': True},
                     {**BINDING, 'approve': True}, {**BINDING, 'fingerprint': 'a'*63},
                     {**BINDING, 'request_id': True}, {**BINDING, 'request_id': 'A'*64}]:
            with self.subTest(args=args), self.assertRaises(Failure):
                self.session.begin(args, 1, CAPS, '2025-11-25')
        self.assertEqual(self.sent, [])
        self.assertEqual(self.service.resolutions, 0)

    def test_capabilities_are_negotiated_not_guessed(self):
        for capabilities in [{}, {'elicitation': None}, {'elicitation': True}, {'elicitation': []},
                             {'elicitation': {'url': {}}}, {'elicitation': {'form': False}}]:
            with self.subTest(capabilities=capabilities):
                result = self.session.begin(BINDING, 1, capabilities, '2025-11-25')
                self.assertEqual(result['review_status'], 'unsupported')
        self.assertFalse(form_supported(CAPS, '2025-03-26'))
        self.assertTrue(form_supported({'elicitation': {}}, '2025-06-18'))
        self.assertTrue(form_supported(CAPS, '2025-11-25'))
        self.assertEqual(self.state(), 'pending_approval')
        self.assertEqual(self.sent, [])

    def test_form_contains_action_full_diff_and_identity(self):
        self.begin()
        params = self.sent[-1]['params']
        self.assertEqual(params['mode'], 'form')
        self.assertIs(params['requestedSchema']['properties']['approve']['default'], False)
        for text in ['提交仿真任务', ARGS['project_id'], ARGS['configuration'], ARGS['source_commit'], RID, FP,
                     '--- SYNTHETIC old\n+++ SYNTHETIC new\n-stop=1n\n+stop=2n']:
            self.assertIn(text, params['message'])
        self.assertEqual(self.service.resolutions, 0)

    def test_matching_accept_uses_existing_resolver_once(self):
        rpc_id = self.begin()
        response = {'jsonrpc': '2.0', 'id': rpc_id, 'result': {'action': 'accept', 'content': {'approve': True}}}
        self.session.receive(response)
        self.session.receive(response)
        again = self.session.begin(BINDING, 11, CAPS, '2025-11-25')
        self.assertEqual(again['review_status'], 'already_resolved')
        self.assertEqual(self.state(), 'accepted')
        self.assertEqual(self.service.resolutions, 1)
        self.assertEqual(self.service.gateway.dispatches, 1)
        self.assertEqual(len(self.finished), 1)

    def test_decline_denies_without_dispatch(self):
        self.begin(); self.answer({'action': 'decline', 'content': None})
        self.assertEqual(self.state(), 'denied')
        self.assertEqual(self.service.resolutions, 1)
        self.assertEqual(self.service.gateway.dispatches, 0)

    def test_cancel_and_unchecked_forms_leave_pending(self):
        for result in [{'action': 'cancel'}, {'action': 'cancel', 'content': None},
                       {'action': 'accept', 'content': {'approve': False}}]:
            self.begin(); self.answer(result)
            self.assertEqual(self.state(), 'pending_approval')
        self.assertEqual(self.service.resolutions, 0)

    def test_invalid_and_host_error_responses_never_resolve(self):
        for value in [None, [], {}, {'action': 'approve'}, {'action': 'accept'},
                      {'action': 'accept', 'content': {'approve': 'true'}},
                      {'action': 'accept', 'content': {'approve': 1}},
                      {'action': 'accept', 'content': {'approve': True, 'confirmed': True}},
                      {'action': 'decline', 'content': {'approve': True}}]:
            self.begin(); self.answer(value)
            self.assertEqual(self.finished[-1][1]['data']['review_status'], 'invalid_response')
        for response in [lambda i: {'jsonrpc': '2.0', 'id': i, 'error': {'code': -32000}},
                         lambda i: {'jsonrpc': '2.0', 'id': i, 'result': {'action': 'accept', 'content': {'approve': True}}, 'error': {}}]:
            rpc_id = self.begin(); self.session.receive(response(rpc_id))
        self.assertEqual(self.state(), 'pending_approval')
        self.assertEqual(self.service.resolutions, 0)

    def test_wrong_id_concurrency_and_parent_cancellation(self):
        rpc_id = self.begin()
        for wrong in [True, 10, '10', None, 'wrong-'+rpc_id]:
            self.session.receive({'jsonrpc': '2.0', 'id': wrong, 'result': {'action': 'accept', 'content': {'approve': True}}})
        with self.assertRaisesRegex(Failure, 'already open'):
            self.session.begin(BINDING, 11, CAPS, '2025-11-25')
        self.session.cancel('10')
        self.session.cancel(rpc_id)
        self.assertIsNotNone(self.session.active)
        self.session.cancel(10)
        self.assertIsNone(self.session.active)
        self.assertEqual(self.sent[-1]['params']['requestId'], rpc_id)
        self.assertEqual(self.state(), 'pending_approval')
        self.assertEqual(self.service.resolutions, 0)

    def test_deadline_consumes_response_before_resolution(self):
        self.begin(); self.now = 5
        self.answer({'action': 'accept', 'content': {'approve': True}})
        self.assertEqual(self.finished[-1][1]['data']['review_status'], 'timeout')
        self.assertEqual(self.state(), 'pending_approval')
        self.assertEqual(self.service.resolutions, 0)

    def test_changed_frozen_review_is_not_approved(self):
        self.begin()
        receipt = self.service.saved('requests', RID); receipt['review']['diff'] = 'CHANGED SYNTHETIC'
        atom(self.service.state/'requests'/(RID+'.json'), receipt)
        self.answer({'action': 'accept', 'content': {'approve': True}})
        self.assertEqual(self.finished[-1][1]['error'].code, 'conflict')
        self.assertEqual(self.service.resolutions, 0)

    def test_unknown_fingerprint_and_large_review_fail_without_form(self):
        with self.assertRaises(Failure):
            self.session.begin({**BINDING, 'request_id': '0'*64}, 10, CAPS, '2025-11-25')
        with self.assertRaises(Failure):
            self.session.begin({**BINDING, 'fingerprint': '0'*64}, 10, CAPS, '2025-11-25')
        receipt = self.service.saved('requests', RID); receipt['review']['diff'] = 'x'*MAX_REVIEW_BYTES
        atom(self.service.state/'requests'/(RID+'.json'), receipt)
        with self.assertRaisesRegex(Failure, 'exceeds'):
            self.begin()
        self.assertEqual(self.sent, [])

    def test_policy_rejection_keeps_pending_and_unknown_dispatch_never_retries(self):
        self.service.disabled.add('sim_submit')
        self.begin(); self.answer({'action': 'accept', 'content': {'approve': True}})
        self.assertEqual(self.finished[-1][1]['error'].code, 'forbidden')
        self.assertEqual(self.state(), 'pending_approval')
        self.assertEqual(self.service.gateway.dispatches, 0)
        self.service.disabled.clear(); self.service.gateway.mode = 'unknown'
        self.begin(); self.answer({'action': 'accept', 'content': {'approve': True}})
        self.assertEqual(self.state(), 'uncertain')
        again = self.session.begin(BINDING, 11, CAPS, '2025-11-25')
        self.assertEqual(again['review_status'], 'already_resolved')
        self.assertEqual(self.service.gateway.dispatches, 1)

    def test_second_connection_observes_resolution_without_redispatch(self):
        second = ReviewSession(self.service, lambda m: None, lambda *a, **k: None)
        self.begin(); second.begin(BINDING, 12, CAPS, '2025-11-25')
        rpc_id = second.active['rpc_id']
        self.answer({'action': 'accept', 'content': {'approve': True}})
        second.receive({'jsonrpc': '2.0', 'id': rpc_id, 'result': {'action': 'accept', 'content': {'approve': True}}})
        self.assertEqual(self.service.resolutions, 1)
        self.assertEqual(self.service.gateway.dispatches, 1)


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.hosts = []

    def host(self, **options):
        host = FakeHost(Path(self.temp.name)/str(len(self.hosts)), **options)
        self.hosts.append(host)
        return host

    def tearDown(self):
        try:
            for host in self.hosts:
                self.assertIn('SYNTHETIC', host.close() or 'SYNTHETIC')
        finally:
            self.temp.cleanup()

    def test_stdio_correct_correlation_duplicates_and_protocol_purity(self):
        h = self.host(); prompt = h.begin()
        response = {'jsonrpc': '2.0', 'id': prompt['id'], 'result': {'action': 'accept', 'content': {'approve': True}}}
        h.send(response, response, tool(3, 'ic_projects'))
        self.assertEqual(h.read()['result']['structuredContent']['data']['request']['state'], 'accepted')
        metrics = h.read()['result']['structuredContent']['data']
        self.assertEqual(metrics['dispatches'], 1); self.assertEqual(metrics['resolutions'], 1)
        h.send(tool(4, 'ic_request_review', BINDING))
        self.assertEqual(h.read()['result']['structuredContent']['data']['review_status'], 'already_resolved')

    def test_noise_notifications_tools_and_resources_cannot_authorize(self):
        h = self.host(); prompt = h.begin()
        h.send({'jsonrpc': '2.0', 'id': 'wrong', 'result': {'action': 'accept', 'content': {'approve': True}}},
               {'jsonrpc': '2.0', 'method': 'elicitation/create', 'params': {'action': 'accept', 'content': {'approve': True}}},
               {'jsonrpc': '2.0', 'method': 'tools/call', 'params': {'name': 'ic_request_review', 'arguments': {**BINDING, 'approve': True}}},
               {'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {'requestId': '2'}},
               tool(2, 'ic_request_review', BINDING), tool(3, 'ic_request_review', BINDING),
               request(4, 'ping'), request(5, 'resources/list'), request(6, 'resources/read', {'uri': 'ui://SYNTHETIC'}),
               tool(7, 'ic_approve', {**BINDING, 'confirmed': True}))
        self.assertEqual(h.read()['result']['structuredContent']['error']['code'], 'review_in_progress')
        for expected in [4, 5, 6]: self.assertEqual(h.read()['id'], expected)
        self.assertTrue(h.read()['result']['isError'])
        result = h.answer(prompt, {'action': 'cancel'})
        self.assertEqual(result['id'], 2)
        self.assertEqual(result['result']['structuredContent']['data']['request']['state'], 'pending_approval')

    def test_idle_pipe_deadline_and_late_response(self):
        h = self.host(timeout=0.1); prompt = h.begin()
        self.assertEqual(h.read()['method'], 'notifications/cancelled')
        self.assertEqual(h.read()['result']['structuredContent']['data']['review_status'], 'timeout')
        h.send({'jsonrpc': '2.0', 'id': prompt['id'], 'result': {'action': 'accept', 'content': {'approve': True}}}, tool(3, 'ic_projects'))
        self.assertEqual(h.read()['result']['structuredContent']['data']['dispatches'], 0)

    def test_partial_line_cannot_block_review_timeout(self):
        h = self.host(timeout=0.1); h.begin(); h.raw(b'{"jsonrpc":"2.0",')
        self.assertEqual(h.read()['method'], 'notifications/cancelled')
        self.assertEqual(h.read()['result']['structuredContent']['data']['review_status'], 'timeout')
        h.raw(b'"id":3,"method":"ping"}\n')
        self.assertEqual(h.read()['id'], 3)

    def test_parent_notification_cancels_but_request_form_does_not(self):
        h = self.host(); h.begin()
        h.send(request(3, 'notifications/cancelled', {'requestId': 2}))
        self.assertEqual(h.read()['error']['code'], -32601)
        h.send({'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {'requestId': 2}})
        self.assertEqual(h.read()['method'], 'notifications/cancelled')
        self.assertEqual(h.read()['result']['structuredContent']['data']['review_status'], 'cancelled')

    def test_unsupported_client_never_receives_form(self):
        h = self.host(capabilities={}); h.send(tool(2, 'ic_request_review', BINDING))
        result = h.read()
        self.assertEqual(result['id'], 2)
        self.assertEqual(result['result']['structuredContent']['data']['review_status'], 'unsupported')

    def test_legacy_explicit_capability_uses_implicit_form_mode(self):
        h = self.host(capabilities={'elicitation': {}}, protocol='2025-06-18')
        prompt = h.begin(); self.assertNotIn('mode', prompt['params'])
        result = h.answer(prompt, {'action': 'cancel'})
        self.assertEqual(result['result']['structuredContent']['data']['request']['state'], 'pending_approval')

    def test_eof_abandons_review_and_sends_no_dispatch(self):
        h = self.host(); h.begin(); h.close(); self.hosts.remove(h)
        receipt = json.loads((Path(self.temp.name)/'0/requests'/(RID+'.json')).read_text())
        self.assertEqual(receipt['state'], 'pending_approval')

    def test_forged_method_with_server_id_does_not_become_a_response(self):
        h = self.host(); prompt = h.begin()
        h.send({'jsonrpc': '2.0', 'id': prompt['id'], 'method': 'elicitation/create',
                'result': {'action': 'accept', 'content': {'approve': True}}})
        self.assertEqual(h.read()['error']['code'], -32601)
        value = h.answer(prompt, {'action': 'cancel'})
        self.assertEqual(value['result']['structuredContent']['data']['request']['state'], 'pending_approval')

    def test_lifecycle_catalog_and_resource_boundaries(self):
        service = SyntheticService(Path(self.temp.name)/'inline')
        lifecycle = SyntheticLifecycle()
        messages = [request(1, 'initialize', {'capabilities': {}}),
                    {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, request(2, 'tools/list'),
                    request(3, 'resources/list'), request(4, 'resources/read', {'uri': 'ui://SYNTHETIC'}),
                    tool(5, 'ic_plugin_status'), tool(6, 'ic_plugin_connect'), tool(7, 'ic_projects'),
                    tool(8, 'ic_view_get', {'fixture': True})]
        out = io.StringIO()
        run(service, io.StringIO(''.join(canonical(m)+'\n' for m in messages)), out, SyntheticViews(), lifecycle)
        result = [json.loads(line) for line in out.getvalue().splitlines()]
        names = [t['name'] for t in result[1]['result']['tools']]
        self.assertEqual(len(names), 31)
        self.assertEqual(names[-2:], ['ic_plugin_connect', 'ic_plugin_status'])
        self.assertEqual(lifecycle.events, ['ic_plugin_status', 'ic_plugin_connect', 'ensure', 'ensure'])
        self.assertEqual(service.resolutions, 0)

    def test_lifecycle_failure_stops_tool_and_old_behavior_needs_no_lifecycle(self):
        service = SyntheticService(Path(self.temp.name)/'inline')
        handshake = [request(1, 'initialize', {'capabilities': CAPS}), {'jsonrpc': '2.0', 'method': 'notifications/initialized'}]
        for lifecycle in [None, SyntheticLifecycle(fail=True)]:
            out = io.StringIO()
            messages = handshake+[tool(2, 'ic_projects')]
            run(service, io.StringIO(''.join(canonical(m)+'\n' for m in messages)), out, SyntheticViews(), lifecycle)
            value = json.loads(out.getvalue().splitlines()[-1])['result']
            self.assertEqual(value['isError'], lifecycle is not None)
        self.assertEqual(service.resolutions, 0)

    def test_duplicate_json_keys_and_oversize_remain_bounded(self):
        h = self.host(); h.raw(b'{"jsonrpc":"2.0","id":3,"id":4,"method":"ping"}\n')
        self.assertEqual(h.read()['error']['code'], -32700)
        h.send(request(5, 'ping')); self.assertEqual(h.read()['id'], 5)
        service = SyntheticService(Path(self.temp.name)/'large')
        out = io.StringIO()
        result = run(service, io.StringIO('x'*(MAX_REQUEST+1)), out, SyntheticViews())
        self.assertEqual(result, 2); self.assertEqual(json.loads(out.getvalue())['error']['code'], -32600)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--synthetic-stdio':
        raise SystemExit(run(SyntheticService(Path(sys.argv[2]), sys.argv[4]), views=SyntheticViews(), review_timeout=float(sys.argv[3])))
    unittest.main(verbosity=2)
