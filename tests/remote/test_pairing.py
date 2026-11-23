import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/workbench'))
sys.path.insert(0,str(ROOT/'apps/codex'))
from browser_pairing import Pairing, confirmation_html
from browser_login import LocalLogin
from icwb.service import Failure
from remote_node import Handler, Node


class PairTests(unittest.TestCase):
    def test_confirmation_is_one_use_bound_to_origin_and_expires(self):
        now=[0];p=Pairing(clock=lambda:now[0]);origin='https://example.github.io'
        rid,csrf=p.create(origin,'a'*32)
        self.assertFalse(p.accepts(csrf,origin))
        with self.assertRaises(PermissionError):p.decide(rid,'wrong',True)
        result=p.decide(rid,csrf,True);token=result['accessCode']
        self.assertTrue(p.accepts(token,origin));self.assertFalse(p.accepts(token,'https://evil.example'))
        with self.assertRaises(PermissionError):p.decide(rid,csrf,True)
        now[0]=8*3600;self.assertFalse(p.accepts(token,origin))
        rid,csrf=p.create(origin,'b'*32);now[0]+=181
        with self.assertRaises(PermissionError):p.decide(rid,csrf,True)

    def test_deny_has_no_grant_and_markup_does_not_contain_owner_key(self):
        p=Pairing();rid,csrf=p.create('https://example.github.io','a'*32)
        self.assertNotIn('accessCode',p.decide(rid,csrf,False));self.assertEqual(p.grants,{})
        markup=confirmation_html('https://example.github.io','a'*32,'request','csrf','http://127.0.0.1:8767','nonce')
        self.assertIn('允许并连接',markup);self.assertNotIn('browser-access.key',markup)

    def test_simulation_mode_describes_only_available_workflow_and_keeps_confirmation_protocol(self):
        args=('https://example.github.io','a'*32,'request','csrf','http://127.0.0.1:8767','nonce')
        normal=confirmation_html(*args)
        simulation=confirmation_html(*args,mode='simulation-only')
        self.assertIn('连接本机仿真环境',simulation)
        self.assertIn('你提供的独立网表',simulation)
        self.assertIn('你选中的仿真主机及授权范围',simulation)
        self.assertIn('准备、运行仿真并查看结果',simulation)
        for unavailable in ('Codex','登录','订阅','PR','提交 Git','恢复版本'):
            self.assertNotIn(unavailable,simulation)
        self.assertIn('连接本机 Codex',normal)
        self.assertIn('Codex 登录状态',normal)
        self.assertIn('创建或更新 PR',normal)
        self.assertEqual(normal.split('<script nonce=',1)[1],simulation.split('<script nonce=',1)[1])
        with self.assertRaises(ValueError):confirmation_html(*args,mode='unsupported')

    def test_connect_page_selects_simulation_copy_for_nodes_without_chat_routes(self):
        for routes,heading in ((None,'连接本机仿真环境'),(object(),'连接本机 Codex')):
            node=Node(routes,'synthetic-token',['https://example.github.io'],'fixture-node','http://127.0.0.1:8767')
            pages=[];guards=[]
            handler=types.SimpleNamespace(node=node,local_guard=lambda:guards.append(True),
                route=lambda:('/connect',{'origin':['https://example.github.io'],'state':['s'*32]}),
                send_page=lambda page,nonce:pages.append((page,nonce)))
            Handler.connect_page(handler)
            self.assertEqual(guards,[True])
            self.assertIn('<h1>'+heading+'</h1>',pages[0][0])
            self.assertEqual(len(node.pairing.requests),1)
            self.assertEqual(node.pairing.grants,{})
            request=next(iter(node.pairing.requests.values()))
            self.assertEqual(request['origin'],'https://example.github.io')
            self.assertEqual(request['state'],'s'*32)

    def test_simulation_copy_retains_origin_escaping(self):
        page=confirmation_html('https://example.invalid/<img src=x>','a'*32,'request','csrf',
            'http://127.0.0.1:8767','nonce',mode='simulation-only')
        self.assertNotIn('<img src=x>',page)
        self.assertIn('&lt;img src=x&gt;',page)


class FakeRpc:
    closed=False
    def __init__(self):self.calls=[];self.account=None;self.requires=True;self.url='https://auth.openai.com/authorize?state=official'
    def call(self,method,args):
        self.calls.append((method,args))
        if method=='account/read':return {'account':self.account,'requiresOpenaiAuth':self.requires}
        if method=='account/login/start':return {'type':'chatgpt','loginId':'test-login','authUrl':self.url}
        raise AssertionError(method)
    def close(self):self.closed=True


class LoginTests(unittest.TestCase):
    def owner(self):
        login=LocalLogin({'state_dir':'/tmp'});rpc=FakeRpc();login.rpc=rpc;return login,rpc
    def test_status_never_starts_login_and_real_plan_is_projected_without_tokens(self):
        login,rpc=self.owner();self.assertTrue(login.status()['can_login'])
        self.assertEqual([c[0] for c in rpc.calls],['account/read'])
        rpc.account={'type':'chatgpt','planType':'plus','email':'private@example.com','accessToken':'secret'}
        data=login.status();self.assertEqual(data['account']['plan_type'],'plus')
        self.assertNotIn('secret',json.dumps(data));self.assertNotIn('private@example.com',json.dumps(data))
        with self.assertRaises(Failure):login.start()
    def test_official_flow_is_explicit_correlated_and_not_replayed(self):
        login,rpc=self.owner();result=login.start();self.assertTrue(result['auth_url'].startswith('https://auth.openai.com/'))
        with self.assertRaises(Failure):login.start()
        self.assertEqual(sum(c[0]=='account/login/start' for c in rpc.calls),1)
        login.event({'method':'account/login/completed','params':{'loginId':'unrelated','success':True}})
        self.assertEqual(login.status()['login_state'],'pending')
        login.event({'method':'account/login/completed','params':{'loginId':'test-login','success':True}})
        rpc.account={'type':'chatgpt','planType':'plus'};self.assertEqual(login.status()['login_state'],'complete')
    def test_unknown_provider_and_untrusted_login_url_do_not_claim_subscription(self):
        login,rpc=self.owner();rpc.requires=False
        self.assertFalse(login.status()['can_login']);self.assertEqual(login.status()['account']['plan_type'],'unknown')
        with self.assertRaises(Failure):login.start()
        rpc.requires=True;rpc.url='https://evil.example/auth'
        with self.assertRaises(Failure):login.start()
        with self.assertRaises(Failure):login.start()
        self.assertEqual(sum(c[0]=='account/login/start' for c in rpc.calls),1)
    def test_login_timeout_does_not_expose_upstream_data_or_retry(self):
        login,rpc=self.owner();original=rpc.call;attempts=[]
        def call(method,args):
            if method=='account/login/start':
                attempts.append(method);raise Failure('app_server_timeout','secret-token-value',75)
            return original(method,args)
        rpc.call=call
        with self.assertRaises(Failure) as caught:login.start()
        self.assertNotIn('secret-token-value',str(caught.exception))
        with self.assertRaises(Failure):login.start()
        self.assertEqual(len(attempts),1)

if __name__=='__main__':unittest.main()
