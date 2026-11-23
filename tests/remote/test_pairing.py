import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/workbench'))
sys.path.insert(0,str(ROOT/'apps/codex'))
from browser_pairing import Pairing, confirmation_html
from browser_login import LocalLogin
from icwb.service import Failure


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
