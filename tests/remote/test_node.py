"""Real HTTP boundary tests with a synthetic AI route owner; no model invocation."""
import importlib.util
import json
import os
import re
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote_node', ROOT / 'tools/workbench/remote_node.py')
node = importlib.util.module_from_spec(spec)
spec.loader.exec_module(node)
TOKEN = 'x' * 43
ORIGIN = 'https://example.github.io'

class Routes:
    def __init__(self): self.calls = []
    def get(self, path, query): self.calls.append((path, query));return {'synthetic': True}
    def post(self, path, body): self.calls.append((path, body));return {'accepted': True}


class GatewayOnboardingTests(unittest.TestCase):
    def setUp(self):
        self.identity='a'*32
        self.health={'api_version':'1','mode':'live','connection_id':self.identity,
            'capabilities':{'simulation_onboarding':True,'simulation_onboarding_api_version':'1',
                            'simulation_onboarding_native_entry':True}}
        self.gateway=Mock()
        self.gateway.request.return_value=self.health
        self.proxy=node.GatewayOnboarding(self.gateway)

    def test_probe_is_a_passive_health_read_and_chat_survives_gateway_unavailability(self):
        owner=node.Node(Routes(),TOKEN,[ORIGIN],'original-chat-node','http://127.0.0.1:8767')
        owner.onboarding=self.proxy
        info=owner.info()
        self.gateway.request.assert_called_once_with('/api/health')
        self.assertEqual(info['connection_id'],self.identity)
        self.assertEqual(info['node_id'],'original-chat-node')
        self.assertTrue(info['capabilities']['chat'])
        self.gateway.request.side_effect=node.Failure('transport_unknown','Synthetic offline gateway',75)
        info=owner.info()
        self.assertFalse(info['capabilities']['simulation_onboarding'])
        self.assertTrue(info['capabilities']['chat'])
        self.assertEqual(info['connection_id'],'original-chat-node')

    def test_browser_and_native_requests_keep_the_original_identity_and_distinct_provenance(self):
        self.proxy.refresh();self.gateway.reset_mock()
        session={'schema':'ic.onboarding.session.v1','intake_id':'intake_'+'b'*32,'connection_id':self.identity}
        self.gateway.request.return_value=session
        args={'file_name':'fresh.scs','text':'synthetic source'}
        self.assertEqual(self.proxy.write('netlist',args),session)
        self.gateway.request.assert_called_once_with('/api/simulation/onboarding/netlist',args,
            onboarding_entry=None,onboarding_connection_id=self.identity,route_timeout=20)
        self.gateway.reset_mock()
        self.assertEqual(self.proxy.read('session',{'intake_id':session['intake_id']},origin='native_agent'),session)
        self.gateway.request.assert_called_once_with('/api/simulation/onboarding/session?intake_id='+session['intake_id'],None,
            onboarding_entry='native_agent',onboarding_connection_id=self.identity,route_timeout=20)

    def test_unknown_run_is_never_replayed_and_uses_bounded_operation_timeout(self):
        self.proxy.refresh();self.gateway.reset_mock()
        self.gateway.request.side_effect=node.Failure('transport_unknown','Synthetic lost response',75)
        args={'intake_id':'intake_'+'b'*32,'plan_id':'c'*64,'revision':4}
        with self.assertRaises(node.Failure):self.proxy.write('run',args)
        self.gateway.request.assert_called_once_with('/api/simulation/onboarding/run',args,
            onboarding_entry=None,onboarding_connection_id=self.identity,route_timeout=320)

    def test_header_probe_retains_its_remote_deadline_and_checks_connection(self):
        self.proxy.refresh();self.gateway.reset_mock()
        args={'intake_id':'intake_'+'b'*32,'revision':4,'probe_id':'probe_'+'c'*32,'roots':['/observed/headers']}
        session={'schema':'ic.onboarding.session.v1','intake_id':args['intake_id'],'connection_id':self.identity}
        self.gateway.request.return_value=session
        self.assertEqual(self.proxy.write('veriloga-headers',args),session)
        self.gateway.request.assert_called_once_with('/api/simulation/onboarding/veriloga-headers',args,
            onboarding_entry=None,onboarding_connection_id=self.identity,route_timeout=300)
        self.gateway.request.return_value={**session,'connection_id':'d'*32}
        with self.assertRaisesRegex(node.Failure,'another connection'):self.proxy.write('veriloga-headers',args)

    def test_routes_and_returned_source_connection_are_checked_without_fallback(self):
        self.proxy.refresh();self.gateway.reset_mock()
        for operation in ('../../api/jobs','waveforms/../session','shell'):
            with self.assertRaises(ValueError):self.proxy.read(operation,{})
        self.gateway.request.assert_not_called()
        self.gateway.request.return_value={'schema':'ic.onboarding.session.v1','connection_id':'c'*32}
        with self.assertRaisesRegex(node.Failure,'another connection') as mismatch:
            self.proxy.write('netlist',{'file_name':'fresh.scs','text':'source'})
        self.assertEqual(mismatch.exception.exit_code,75)
        self.assertEqual(self.gateway.request.call_count,1)


class Tests(unittest.TestCase):
    def setUp(self):
        self.routes = Routes()
        self.server = node.Server(('127.0.0.1', 0), node.Handler)
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)
        self.server.node = node.Node(self.routes, TOKEN, [ORIGIN], 'fixture-node', self.base + '/prefix')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
    def call(self, path='/node/info', method='GET', body=None, headers=None, prefix='/prefix'):
        h = {'Origin': ORIGIN, 'Authorization': 'Bearer ' + TOKEN}
        if body is not None: h['Content-Type'] = 'application/json'
        h.update(headers or {})
        request = urllib.request.Request(self.base + prefix + path, method=method, headers=h,
                                        data=None if body is None else json.dumps(body).encode())
        try: response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as e: response = e
        with response:
            data = response.read();return response.status, dict(response.headers), (data.decode() if response.headers.get_content_type()=='text/html' else json.loads(data)) if data else None
    def test_metadata_requires_origin_host_and_bearer(self):
        status, headers, data = self.call()
        self.assertEqual(status, 200);self.assertEqual(data['data']['schema'], 'circuitgit.remote-node.v1')
        self.assertNotIn(TOKEN, json.dumps(data));self.assertEqual(headers['Access-Control-Allow-Origin'], ORIGIN)
        for h in [{'Authorization': ''}, {'Authorization': 'Bearer wrong'}, {'Origin': 'https://evil.example'}, {'Host': 'evil.example'}]:
            self.assertEqual(self.call(headers=h)[0], 403)
        self.assertEqual(self.routes.calls, [])
    def test_preflight_is_exact_and_has_no_ai_side_effects(self):
        status, headers, _ = self.call('/api/ai/turn', 'OPTIONS', headers={'Authorization': '', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type', 'Access-Control-Request-Private-Network': 'true'})
        self.assertEqual(status, 204);self.assertEqual(headers['Access-Control-Allow-Private-Network'], 'true')
        self.assertNotIn('Access-Control-Allow-Credentials', headers);self.assertEqual(self.routes.calls, [])
        self.assertEqual(self.call('/api/ai/turn', 'OPTIONS', headers={'Origin':'https://evil.example','Access-Control-Request-Method':'POST'})[0], 403)
    def test_only_ai_routes_and_explicit_approvals_are_forwarded(self):
        self.assertEqual(self.call('/api/jobs', 'POST', {})[0], 400)
        self.assertEqual(self.call('/api/ai/turn', 'POST', {'permission_mode':'developer'})[0], 403)
        self.assertEqual(self.routes.calls, [])
        body={'session_id':'one','approval_id':'frozen','decision':'deny'}
        self.assertEqual(self.call('/api/ai/approval', 'POST', body)[0], 200)
        self.assertEqual(self.routes.calls, [('/api/ai/approval',body)])
    def test_context_and_session_identity_reach_the_owner_unchanged(self):
        self.assertEqual(self.call('/api/ai/context?project_id=rc&session_id=one')[0], 200)
        self.assertEqual(self.routes.calls, [('/api/ai/context',{'project_id':['rc'],'session_id':['one']})])
        self.assertEqual(self.call('/api/ai/context?project_id=rc&project_id=other')[0], 400)
        self.assertEqual(len(self.routes.calls), 1)
    def test_code_is_stable_owner_only_and_never_a_public_oauth_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory);a,identity,key=node.node_identity(state);b,other,_=node.node_identity(state)
            self.assertEqual(a,b);self.assertEqual(identity,other)
            if os.name != 'nt':
                self.assertEqual(key.stat().st_mode&0o777,0o600)
                key.chmod(0o644)
                with self.assertRaises(ValueError):node.node_identity(state)
        self.assertFalse(self.server.node.info()['capabilities']['hosted_subscription_oauth'])
    def test_unencrypted_remote_urls_and_wildcards_are_rejected(self):
        for url in ['http://server.example','https://*.example','https://example.com/path','https://u:p@example.com']:
            with self.assertRaises(ValueError):node.origin(url)
    def test_existing_client_config_gets_separate_browser_state(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'client.local.json'
            existing={'gateway_url':'http://127.0.0.1:8766','state_dir':str(Path(directory)/'host'),
                      'development_workspace':directory,'development_access':'full'}
            path.write_text(json.dumps(existing))
            config=node.node_config(path)
            self.assertEqual(config['state_dir'],str((Path(directory)/'host/browser-node').resolve()))
            self.assertNotIn('development_access',config)
            self.assertNotIn('development_workspace',config)
            self.assertEqual(json.loads(path.read_text()),existing)
            self.assertEqual(node.node_config(path,state_dir=Path(directory)/'isolated')['state_dir'],str((Path(directory)/'isolated').resolve()))
    def test_local_confirmation_has_csrf_framing_origin_and_replay_guards(self):
        self.server.node=node.Node(self.routes,TOKEN,[ORIGIN],'local-test',self.base)
        status,headers,html=self.call('/connect?origin='+quote(ORIGIN,safe='')+'&state='+'a'*32,prefix='',headers={'Origin':''})
        self.assertEqual(status,200);self.assertEqual(headers['X-Frame-Options'],'DENY')
        self.assertIn("frame-ancestors 'none'",headers['Content-Security-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin',headers);self.assertNotIn(TOKEN,html)
        config=json.loads(re.search(r'const c=(\{[^\n]+\});',html).group(1))
        body={'request_id':config['requestId'],'csrf':config['csrf'],'allow':True}
        self.assertEqual(self.call('/connect/confirm','POST',body,prefix='')[0],403)
        self.assertEqual(self.call('/connect/confirm','POST',{**body,'csrf':'wrong'},prefix='',headers={'Origin':self.base})[0],403)
        status,_,result=self.call('/connect/confirm','POST',body,prefix='',headers={'Origin':self.base})
        self.assertEqual(status,200);key=result['data']['accessCode'];self.assertNotEqual(key,TOKEN)
        self.assertEqual(self.call('/node/info',prefix='',headers={'Authorization':'Bearer '+key})[0],200)
        self.assertEqual(self.call('/node/info',prefix='',headers={'Authorization':'Bearer '+key,'Origin':'https://evil.example'})[0],403)
        self.assertEqual(self.call('/connect/confirm','POST',body,prefix='',headers={'Origin':self.base})[0],403)
        self.assertEqual(self.routes.calls,[])
    def test_remote_owner_code_does_not_authorize_local_account_login(self):
        self.server.node=node.Node(self.routes,TOKEN,[ORIGIN],'local-test',self.base)
        self.assertEqual(self.call('/api/ai/auth/status',prefix='')[0],403)
        self.assertEqual(self.call('/api/ai/auth/login','POST',{},prefix='')[0],403)
        self.server.node=node.Node(self.routes,TOKEN,[ORIGIN],'remote-test','https://node.example')
        self.assertEqual(self.call('/connect?origin='+quote(ORIGIN,safe='')+'&state='+'a'*32,prefix='')[0],403)
        self.assertEqual(self.routes.calls,[])

    def test_paired_simulation_keeps_caller_scope_server_owned_and_never_retries(self):
        calls=[]
        self.server.node=node.Node(self.routes,TOKEN,[ORIGIN],'local-test',self.base)
        def simulate(operation, arguments, key, *, caller_id):
            calls.append((operation,arguments,key,caller_id)); return {'state':'outcome_unknown','automatic_retry':False}
        self.server.node.simulation=simulate
        body={'operation':'submit','arguments':{'project_id':'fixture','configuration':'TRAN','source_commit':'a'*40},'idempotency_key':'original-key'}
        self.assertEqual(self.call('/api/simulation/execute','POST',body,prefix='')[0],403)
        rid,csrf=self.server.node.pairing.create(ORIGIN,'p'*32)
        code=self.server.node.pairing.decide(rid,csrf,True)['accessCode']
        headers={'Authorization':'Bearer '+code}
        for extra in ({'caller_id':'native-agent'},{'approved':True},{'operation':'shell'}):
            self.assertEqual(self.call('/api/simulation/execute','POST',{**body,**extra},prefix='',headers=headers)[0],400)
        self.assertEqual(calls,[])
        status,_,result=self.call('/api/simulation/execute','POST',body,prefix='',headers=headers)
        self.assertEqual(status,200);self.assertEqual(result['data']['state'],'outcome_unknown')
        self.assertEqual(calls,[('submit',body['arguments'],'original-key','paired-helper')])
        self.assertEqual(self.call('/api/simulation/execute',prefix='',headers=headers)[0],400)
        self.assertEqual(len(calls),1)
        self.server.node.simulation=None
        self.assertEqual(self.call('/api/simulation/execute','POST',body,prefix='',headers=headers)[0],403)

    def test_paired_experiment_operations_preserve_identity_and_server_owned_scope(self):
        calls=[]
        self.server.node=node.Node(self.routes,TOKEN,[ORIGIN],'local-test',self.base)
        def simulate(operation, arguments, key, *, caller_id):
            calls.append((operation,arguments,key,caller_id))
            return {'operation':operation,'state':'synthetic','automatic_retry':False}
        self.server.node.simulation=simulate
        rid,csrf=self.server.node.pairing.create(ORIGIN,'p'*32)
        code=self.server.node.pairing.decide(rid,csrf,True)['accessCode']
        headers={'Authorization':'Bearer '+code}
        plan='b'*64
        bodies=[
            {'operation':'prepare','arguments':{'project_id':'fixture','recipe_id':'inverter-tran','source_commit':'a'*40}},
            {'operation':'run','arguments':{'project_id':'fixture','plan_id':plan}},
            {'operation':'run','arguments':{'project_id':'fixture','plan_id':plan},'idempotency_key':'experiment-'+plan},
            {'operation':'inspect','arguments':{'project_id':'fixture','job_id':'original-job'}},
        ]
        for body in bodies:
            with self.subTest(operation=body['operation'],key=body.get('idempotency_key')):
                before=len(calls)
                self.assertEqual(self.call('/api/simulation/execute','POST',body,prefix='')[0],403)
                for extra in ({'caller_id':'native-agent'},{'approved':True}):
                    self.assertEqual(self.call('/api/simulation/execute','POST',{**body,**extra},prefix='',headers=headers)[0],400)
                self.assertEqual(self.call('/api/simulation/execute?replay=1','POST',body,prefix='',headers=headers)[0],400)
                self.assertEqual(len(calls),before)
                status,_,result=self.call('/api/simulation/execute','POST',body,prefix='',headers=headers)
                self.assertEqual(status,200)
                self.assertEqual(result['data']['operation'],body['operation'])
                self.assertEqual(calls[before:],[(body['operation'],body['arguments'],body.get('idempotency_key'),'paired-helper')])
        self.assertEqual(self.routes.calls,[])

    def test_paired_experiment_unknown_outcome_does_not_retry_or_replace_key(self):
        calls=[]
        self.server.node=node.Node(self.routes,TOKEN,[ORIGIN],'local-test',self.base)
        def simulate(operation, arguments, key, *, caller_id):
            calls.append((operation,arguments,key,caller_id))
            raise TimeoutError('Synthetic lost owner response')
        self.server.node.simulation=simulate
        rid,csrf=self.server.node.pairing.create(ORIGIN,'p'*32)
        code=self.server.node.pairing.decide(rid,csrf,True)['accessCode']
        headers={'Authorization':'Bearer '+code}
        plan='b'*64
        body={'operation':'run','arguments':{'project_id':'fixture','plan_id':plan},'idempotency_key':'experiment-'+plan}
        self.assertGreaterEqual(self.call('/api/simulation/execute','POST',body,prefix='',headers=headers)[0],400)
        self.assertEqual(calls,[('run',body['arguments'],body['idempotency_key'],'paired-helper')])
        self.assertEqual(self.routes.calls,[])

if __name__ == '__main__':unittest.main()
