"""Actual loopback HTTP routes over a new synthetic onboarding application.

No SSH, solver, account runtime, historical store or child process is available.
The fixture grants an in-memory browser credential solely to exercise the HTTP
pairing boundary; it never changes a real user's connection or approval state.
"""
import http.client
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

import onboarding_runtime
import onboarding_waveforms
import remote_node
import runner
import server


PREFIX = '/api/simulation/onboarding/'
LIMIT = 2 * 1024 * 1024
SOURCE = 'simulator lang=spectre\nM0 (OUT IN LO LO) synthetic_n w=2u l=180n\n'
INTAKE = 'intake_' + 'a'*32
JOB = 'synthetic-original-job'
SIGNAL = 's_' + 'b'*32


class OnboardingHTTPTests(unittest.TestCase):
    def patch(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        home = self.root / 'fresh-home'
        (home / '.ssh').mkdir(parents=True)
        (home / '.ssh/config').write_text('Host synthetic-node\n  HostName fixture.invalid\n')
        self.patch(patch('pathlib.Path.home', return_value=home))
        self.process = self.patch(patch.object(subprocess, 'run', side_effect=AssertionError('No child process')))
        self.popen = self.patch(patch.object(subprocess, 'Popen', side_effect=AssertionError('No child process')))
        self.ssh = self.patch(patch.object(runner.core, 'ssh', side_effect=AssertionError('No SSH')))
        self.doctor = self.patch(patch.object(runner.core, 'doctor', side_effect=AssertionError('No remote preflight')))
        self.cfg = onboarding_runtime.create_onboarding_config(self.root / 'fresh-store')
        self.app = server.Application(self.cfg, self.root / 'empty-web')
        self.addCleanup(self.close_app)
        self.gateway = server.Server(('127.0.0.1', 0), server.Handler)
        self.gateway.app = self.app
        self.gateway_origin = 'http://127.0.0.1:' + str(self.gateway.server_port)
        self.node_http = remote_node.Server(('127.0.0.1', 0), remote_node.Handler)
        self.node_origin = 'http://127.0.0.1:' + str(self.node_http.server_port)
        self.browser_origin = 'https://synthetic-browser.invalid'
        self.node = remote_node.Node(None, 'synthetic-owner-access-token',
            [self.browser_origin, self.gateway_origin], self.cfg['onboarding']['connection_id'],
            self.node_origin, 'Synthetic onboarding fixture')
        self.node.onboarding = self.app.onboarding
        self.node_http.node = self.node
        request_id, csrf = self.node.pairing.create(self.browser_origin, 'a'*43)
        self.paired_token = self.node.pairing.decide(request_id, csrf, True)['accessCode']
        for listener in (self.gateway, self.node_http):
            thread = threading.Thread(target=lambda listener=listener: listener.serve_forever(poll_interval=.01), daemon=True)
            thread.start()
            self.addCleanup(self.close_http, listener, thread)

    def close_http(self, listener, thread):
        listener.shutdown()
        listener.server_close()
        thread.join(2)

    def close_app(self):
        self.app.onboarding.close()
        self.app.simulation.close()
        self.app.pool.shutdown(wait=True)

    def request(self, endpoint, path, *, method='GET', data=None, raw=None, headers=None, advertised_length=None):
        listener = self.gateway if endpoint == 'gateway' else self.node_http
        default = {'Content-Type': 'application/json', 'Connection': 'close'}
        if endpoint == 'gateway':
            default.update(Origin=self.gateway_origin, **{'X-Workbench-Token': self.app.token})
        else:
            default.update(Origin=self.browser_origin, Authorization='Bearer ' + self.paired_token)
        default.update(headers or {})
        default = {name: value for name, value in default.items() if value is not None}
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else raw
        connection = http.client.HTTPConnection('127.0.0.1', listener.server_port, timeout=5)
        try:
            if advertised_length is None:
                connection.request(method, path, body=body, headers=default)
            else:
                # An oversized declared body is rejected before reading its
                # bytes. Sending headers only avoids platform BrokenPipe races.
                connection.putrequest(method, path)
                for name, value in default.items():
                    connection.putheader(name, value)
                connection.putheader('Content-Length', str(advertised_length))
                connection.endheaders()
            response = connection.getresponse()
            reply = response.read()
            self.assertEqual(int(response.getheader('Content-Length')), len(reply))
            return response.status, json.loads(reply), reply, dict(response.getheaders())
        finally:
            connection.close()

    def netlist(self, endpoint='gateway'):
        status, data, _, _ = self.request(endpoint, PREFIX + 'netlist', method='POST',
            data={'file_name': 'fresh.scs', 'text': SOURCE})
        self.assertEqual(status, 200, data)
        return data['data']

    def test_health_and_node_info_expose_one_store_identity_without_chat(self):
        _, health, _, _ = self.request('gateway', '/api/health')
        _, info, _, _ = self.request('node', '/node/info')
        expected = self.cfg['onboarding']['connection_id']
        self.assertEqual(health['data']['connection_id'], expected)
        self.assertEqual(info['data']['connection_id'], expected)
        self.assertEqual(info['data']['node_id'], expected)
        self.assertTrue(health['data']['capabilities']['simulation_onboarding'])
        self.assertTrue(health['data']['capabilities']['simulation_onboarding_native_entry'])
        self.assertTrue(info['data']['capabilities']['simulation_onboarding_native_entry'])
        self.assertFalse(health['data']['capabilities']['git'])
        self.assertFalse(health['data']['capabilities']['publish'])
        self.assertFalse(info['data']['capabilities']['chat'])
        self.assertFalse(info['data']['capabilities']['projects'])
        self.assertFalse(info['data']['capabilities']['approvals'])
        self.assertFalse(info['data']['automatic_model_start'])
        self.assertIsNone(self.node.routes)
        self.assertIsNone(self.app.ai)
        for endpoint in ('gateway', 'node'):
            with self.subTest(endpoint=endpoint):
                status, result, _, _ = self.request(endpoint, '/api/ai/models')
                self.assertIn(status, (403, 404))
                self.assertFalse(result['ok'])
                status, result, _, _ = self.request(endpoint, '/api/ai/turn', method='POST', data={'text': 'synthetic'})
                self.assertIn(status, (403, 404))
                self.assertFalse(result['ok'])
        self.process.assert_not_called(); self.popen.assert_not_called(); self.ssh.assert_not_called()

    def test_netlist_and_repeated_session_get_share_the_actual_runtime(self):
        first = self.netlist('node')
        path = PREFIX + 'session?' + urlencode({'intake_id': first['intake_id']})
        with patch.object(self.app.runner, 'status') as status_call, patch.object(self.app.runner, 'collect') as collect:
            for endpoint in ('gateway', 'node', 'gateway', 'node'):
                status, data, _, _ = self.request(endpoint, path)
                self.assertEqual(status, 200, data)
                self.assertEqual(data['data'], first)
            status_call.assert_not_called(); collect.assert_not_called()
        self.assertEqual(first['input_provenance'][0]['origin'], 'interactive_client')
        self.assertIsNone(first['source_commit'])
        self.assertEqual((self.app.onboarding._folder(first['intake_id']) / 'source.scs').read_text(), SOURCE)
        second = self.netlist('gateway')
        self.assertNotEqual(first['intake_id'], second['intake_id'], 'A second explicit import is a new intake')
        self.assertEqual(first['source_sha256'], second['source_sha256'])
        self.assertFalse(self.app.workspace.root.exists())
        self.ssh.assert_not_called()

    def test_native_entry_header_records_provenance_on_both_servers(self):
        for endpoint in ('gateway','node'):
            with self.subTest(endpoint=endpoint):
                code,data,_,_=self.request(endpoint,PREFIX+'netlist',method='POST',
                    data={'file_name':'agent.scs','text':SOURCE},headers={'X-IC-Onboarding-Entry':'native_agent'})
                self.assertEqual(code,200,data)
                state=data['data']
                self.assertEqual(state['input_provenance'][0]['origin'],'native_agent')
                with patch.object(self.app.onboarding,'read',return_value=state) as read:
                    code,data,_,_=self.request(endpoint,PREFIX+'session?'+urlencode({'intake_id':state['intake_id']}),
                        headers={'X-IC-Onboarding-Entry':'native_agent'})
                    self.assertEqual(code,200,data)
                    read.assert_called_once_with('session',{'intake_id':state['intake_id']},origin='native_agent')

    def test_unknown_or_duplicate_entry_header_never_reaches_runtime(self):
        for endpoint in ('gateway','node'):
            for headers in ({'X-IC-Onboarding-Entry':'interactive_client'},
                            {'X-IC-Onboarding-Entry':''},
                            {'X-IC-Onboarding-Entry':'administrator'},
                            {'X-IC-Onboarding-Entry':'native_agent','x-ic-onboarding-entry':'native_agent'}):
                with self.subTest(endpoint=endpoint,headers=headers), \
                        patch.object(self.app.onboarding,'read') as read, \
                        patch.object(self.app.onboarding,'write') as write:
                    code,data,_,_=self.request(endpoint,PREFIX+'ssh-hosts',headers=headers)
                    self.assertEqual(code,400,data)
                    code,data,_,_=self.request(endpoint,PREFIX+'netlist',method='POST',
                        data={'file_name':'agent.scs','text':SOURCE},headers=headers)
                    self.assertEqual(code,400,data)
                    read.assert_not_called();write.assert_not_called()

    def test_native_entry_metadata_does_not_grant_origin_token_or_pairing_authority(self):
        checks=[('gateway',{'X-Workbench-Token':None}),('gateway',{'Origin':None}),
                ('gateway',{'Origin':'https://untrusted.invalid'}),
                ('node',{'Authorization':'Bearer '+self.node.token}),
                ('node',{'Authorization':None}),('node',{'Origin':None})]
        for endpoint,headers in checks:
            with self.subTest(endpoint=endpoint,headers=headers),patch.object(self.app.onboarding,'write') as write:
                code,data,_,_=self.request(endpoint,PREFIX+'netlist',method='POST',
                    data={'file_name':'agent.scs','text':SOURCE},
                    headers={**headers,'X-IC-Onboarding-Entry':'native_agent'})
                self.assertEqual(code,403,data)
                write.assert_not_called()

    def test_regular_chat_node_keeps_its_identity_and_advertises_the_intake_store(self):
        from types import SimpleNamespace
        self.node.node_id='existing-chat-node'
        self.node.routes=SimpleNamespace(get=lambda path,qs:{'models':['synthetic']})
        code,data,_,_=self.request('node','/node/info')
        self.assertEqual(code,200,data)
        self.assertEqual(data['data']['node_id'],'existing-chat-node')
        self.assertEqual(data['data']['connection_id'],self.app.onboarding.connection_id)
        self.assertTrue(data['data']['capabilities']['chat'])
        code,data,_,_=self.request('node','/api/ai/models')
        self.assertEqual(code,200,data)
        self.assertEqual(data['data'],{'models':['synthetic']})
        state=self.netlist('node')
        self.assertEqual(state['connection_id'],self.app.onboarding.connection_id)

    def test_existing_gateway_proxy_uses_both_http_boundaries_and_preserves_entry_origin(self):
        from icwb.service import Gateway
        self.node.onboarding=remote_node.GatewayOnboarding(Gateway(self.gateway_origin))
        code,info,_,_=self.request('node','/node/info')
        self.assertEqual(code,200,info)
        self.assertEqual(info['data']['connection_id'],self.app.onboarding.connection_id)
        for origin in ('interactive_client','native_agent'):
            with self.subTest(origin=origin):
                headers={} if origin=='interactive_client' else {'X-IC-Onboarding-Entry':'native_agent'}
                code,data,_,_=self.request('node',PREFIX+'netlist',method='POST',
                    data={'file_name':'fresh.scs','text':SOURCE},headers=headers)
                self.assertEqual(code,200,data)
                state=data['data']
                self.assertEqual(state['input_provenance'][0]['origin'],origin)
                code,data,_,_=self.request('node',PREFIX+'session?'+urlencode({'intake_id':state['intake_id']}),headers=headers)
                self.assertEqual(code,200,data)
                self.assertEqual(data['data'],state)

    def test_existing_gateway_proxy_rejects_changed_connection_before_sending_a_mutation(self):
        from icwb.service import Gateway
        proxy=remote_node.GatewayOnboarding(Gateway(self.gateway_origin));proxy.refresh()
        self.node.onboarding=proxy
        self.app.onboarding.connection_id='f'*32
        with patch.object(self.app.onboarding,'write') as write:
            code,data,_,_=self.request('node',PREFIX+'netlist',method='POST',
                data={'file_name':'fresh.scs','text':SOURCE})
            self.assertEqual(code,409,data)
            write.assert_not_called()

    def test_read_routes_reject_duplicate_blank_unknown_and_malformed_query_fields(self):
        state = self.netlist()
        intake = state['intake_id']
        queries = ['intake_id=' + intake + '&intake_id=' + intake, 'intake_id=',
            'intake_id=' + intake + '&unknown=x', 'intake_id=' + intake + '&unknown=',
            'intake_id=' + intake + '&broken', '', 'intake_id=%00',
            'intake_id=' + intake + '&' + '&'.join('extra'+str(i)+'=x' for i in range(13))]
        for endpoint in ('gateway', 'node'):
            for query in queries:
                with self.subTest(endpoint=endpoint, query=query):
                    code, data, _, _ = self.request(endpoint, PREFIX + 'session?' + query)
                    self.assertEqual(code, 400, data)
                    self.assertFalse(data['ok'])
            for query in ('path=/synthetic/private', 'unknown='):
                code, data, _, _ = self.request(endpoint, PREFIX + 'ssh-hosts?' + query)
                self.assertEqual(code, 400, data)

    def test_write_routes_reject_query_fields_before_importing_another_source(self):
        for endpoint in ('gateway', 'node'):
            for query in ('unknown=x', 'unknown=', 'a=x&a=y'):
                with self.subTest(endpoint=endpoint, query=query), patch.object(self.app.onboarding, 'write') as write:
                    code, data, _, _ = self.request(endpoint, PREFIX + 'netlist?' + query,
                        method='POST', data={'file_name': 'fresh.scs', 'text': SOURCE})
                    self.assertEqual(code, 400, data)
                    self.assertFalse(data['ok'])
                    write.assert_not_called()

    def test_mutations_require_origin_and_the_correct_gateway_or_paired_node_credential(self):
        cases = [('gateway', {'Origin': None}), ('gateway', {'Origin': 'https://untrusted.invalid'}),
            ('gateway', {'X-Workbench-Token': None}), ('gateway', {'X-Workbench-Token': 'wrong'}),
            ('node', {'Origin': None}), ('node', {'Origin': 'https://untrusted.invalid'}),
            ('node', {'Authorization': None}), ('node', {'Authorization': 'Bearer wrong'}),
            ('node', {'Authorization': 'Bearer ' + self.node.token})]
        for endpoint, headers in cases:
            with self.subTest(endpoint=endpoint, headers=list(headers)), patch.object(self.app.onboarding, 'write') as write:
                code, data, _, _ = self.request(endpoint, PREFIX + 'netlist', method='POST',
                    data={'file_name': 'fresh.scs', 'text': SOURCE}, headers=headers)
                self.assertEqual(code, 403, data)
                write.assert_not_called()
        self.node.pairing.revoke(self.paired_token)
        code, data, _, _ = self.request('node', PREFIX + 'netlist', method='POST',
            data={'file_name': 'fresh.scs', 'text': SOURCE})
        self.assertEqual(code, 403, data)

    def test_node_reads_allow_owner_bearer_but_mutations_require_pairing(self):
        code, data, _, _ = self.request('node', '/node/info', headers={'Authorization': 'Bearer ' + self.node.token})
        self.assertEqual(code, 200, data)
        code, data, _, _ = self.request('node', '/node/info', headers={'Authorization': None})
        self.assertEqual(code, 403, data)
        code, data, _, _ = self.request('node', '/node/info', headers={'Origin': None})
        self.assertEqual(code, 403, data)

    def test_exact_two_mib_body_is_accepted_and_larger_declared_body_never_reaches_runtime(self):
        body = json.dumps({'file_name': 'fresh.scs', 'text': SOURCE}).encode()
        body += b' ' * (LIMIT - len(body))
        for endpoint in ('gateway', 'node'):
            with self.subTest(endpoint=endpoint):
                code, data, _, _ = self.request(endpoint, PREFIX + 'netlist', method='POST', raw=body)
                self.assertEqual(code, 200, data)
            with patch.object(self.app.onboarding, 'write') as write:
                code, data, _, _ = self.request(endpoint, PREFIX + 'netlist', method='POST', advertised_length=LIMIT + 1)
                self.assertEqual(code, 400, data)
                write.assert_not_called()

    @staticmethod
    def response_data(size):
        remaining = size - len(json.dumps({'ok': True, 'data': {'payload': ''}}, ensure_ascii=False).encode())
        return {'payload': '波' * (remaining // 3) + 'x' * (remaining % 3)}

    def test_success_envelope_is_limited_by_utf8_bytes_on_both_http_servers(self):
        for endpoint in ('gateway', 'node'):
            for size in (LIMIT, LIMIT + 1):
                with self.subTest(endpoint=endpoint, bytes=size), patch.object(self.app.onboarding, 'read', return_value=self.response_data(size)):
                    code, data, raw, _ = self.request(endpoint, PREFIX + 'ssh-hosts')
                    if size == LIMIT:
                        self.assertEqual(code, 200, data)
                        self.assertEqual(len(raw), LIMIT)
                        self.assertTrue(data['ok'])
                    else:
                        self.assertEqual(code, 503, data)
                        self.assertEqual(data['error']['code'], 'response_size_limit')
                        self.assertNotIn('data', data)
                        self.assertLess(len(raw), 512)

    def test_failed_run_request_is_not_replayed_by_either_http_adapter(self):
        for endpoint in ('gateway', 'node'):
            with self.subTest(endpoint=endpoint), patch.object(self.app.onboarding, 'write', side_effect=TimeoutError('Synthetic lost response')) as write:
                code, data, _, _ = self.request(endpoint, PREFIX + 'run', method='POST',
                    data={'intake_id': INTAKE, 'revision': 1, 'plan_id': 'c'*64})
                self.assertIn(code, (500, 503), data)
                self.assertFalse(data['ok'])
                write.assert_called_once_with('run', {'intake_id': INTAKE, 'revision': 1, 'plan_id': 'c'*64},origin='interactive_client')
        self.ssh.assert_not_called()

    def test_three_waveform_routes_dispatch_only_the_supported_operation_and_query(self):
        # Keep the actual waveform query validator while stubbing saved artifacts.
        def saved_read(helper, operation, args):
            query = onboarding_waveforms._query(operation, args)
            return {'operation': operation, 'intake_id': query['intake_id'], 'job_id': query['job_id'], 'read_only': True}
        with (patch.object(onboarding_waveforms.OnboardingWaveforms, 'read', autospec=True, side_effect=saved_read) as read,
              patch.object(self.app.runner, 'read') as job_read,
              patch.object(self.app.runner, 'status') as status,
              patch.object(self.app.runner, 'collect') as collect):
            for endpoint in ('gateway', 'node'):
                for operation in ('catalog', 'mapping', 'window'):
                    args = {'intake_id': INTAKE, 'job_id': JOB}
                    if operation == 'window':
                        args.update(signal_ids=SIGNAL, start='0', stop='1e-9', max_points='100')
                    code, data, _, _ = self.request(endpoint, PREFIX + 'waveforms/' + operation + '?' + urlencode(args))
                    self.assertEqual(code, 200, data)
                    self.assertEqual(data['data']['operation'], operation)
                    self.assertTrue(data['data']['read_only'])
                    self.assertEqual(read.call_args.args[1:], (operation, args))
            self.assertEqual(read.call_count, 6)
            job_read.assert_not_called(); status.assert_not_called(); collect.assert_not_called()

    def test_waveform_queries_and_path_variants_cannot_select_arbitrary_jobs_or_files(self):
        def saved_read(helper, operation, args):
            onboarding_waveforms._query(operation, args)
            return {'read_only': True}
        base = {'intake_id': INTAKE, 'job_id': JOB}
        invalid_queries = [{**base, 'path': '/synthetic/private/file'}, {**base, 'run_id': 'another-job'},
            {**base, 'job_id': '../../another-job'}, {**base, 'intake_id': ''}, {**base, 'unknown': ''}]
        with (patch.object(onboarding_waveforms.OnboardingWaveforms, 'read', autospec=True, side_effect=saved_read) as read,
              patch.object(self.app.runner, 'read') as job_read,
              patch.object(self.app.runner, 'status') as status,
              patch.object(self.app.runner, 'collect') as collect):
            for endpoint in ('gateway', 'node'):
                for args in invalid_queries:
                    with self.subTest(endpoint=endpoint, args=args):
                        code, data, _, _ = self.request(endpoint, PREFIX + 'waveforms/catalog?' + urlencode(args))
                        self.assertEqual(code, 400, data)
                for suffix in ('waveforms/jobs/' + JOB, 'waveforms/catalog/../../jobs/' + JOB,
                               'jobs/' + JOB + '/waveforms', 'waveforms/catalog/', 'waveforms/%2e%2e/jobs/' + JOB):
                    read.reset_mock()
                    code, data, _, _ = self.request(endpoint, PREFIX + suffix + '?' + urlencode(base))
                    self.assertIn(code, (400, 404), data)
                    read.assert_not_called()
            job_read.assert_not_called(); status.assert_not_called(); collect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
