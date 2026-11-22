"""Synthetic protocol failure/approval tests. No model/network service beyond fixture gateway."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from test_service import Fixture, ROOT
from icwb.ai import AiSession
from icwb.service import Failure, canonical
from icwb.host import AiRoutes


class FakeRpc:
    def __init__(self, executable, cwd, callback, timeout=30):
        self.callback = callback; self.sent = []; self.closed = False; self.info = {}
    def call(self, method, params):
        self.sent.append({'method': method, 'params': params})
        if method == 'thread/start': return {'thread': {'id': 'synthetic-thread'}, 'model': 'SYNTHETIC', 'modelProvider': 'SYNTHETIC', 'approvalPolicy': 'on-request', 'approvalsReviewer': 'user'}
        if method == 'turn/start': return {'turn': {'id': 'synthetic-turn'}}
        return {}
    def send(self, payload): self.sent.append(payload)
    def close(self): self.closed = True


class AiTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / '.test-state'; scratch.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.fixture = Fixture(Path(self.tmp.name)); self.s = self.fixture.service
        self.ai = AiSession(self.s, FakeRpc)
        self.ai.connect(); self.ai.thread_id = 'synthetic-thread'; self.ai.turn_id = 'synthetic-turn'; self.ai.state = 'running'
    def tearDown(self):
        self.ai.close(); self.fixture.close(); self.tmp.cleanup()
    def context(self):
        f=self.s.call('read', {'project_id': 'demo'})['file']
        return {'version':1,'revision':1,'project':{'id':'demo','sourceCommit':f['base_commit']},
                'file':{'path':f['path'],'baseCommit':f['base_commit'],'persistedSha256':f['sha256'],'currentTextSha256':f['sha256'],'dirty':False}}
    def mutation(self):
        f=self.s.call('read', {'project_id':'demo'})['file']
        review=self.s.call('diff', {'project_id':'demo','base_commit':f['base_commit'],'changes':[{'path':f['path'],'sha256':f['sha256'],'content':f['content'].replace('r=1k','r=3k')}]})
        message={'id':'server-rpc-1','method':'item/tool/call','params':{'threadId':'synthetic-thread','turnId':'synthetic-turn','callId':'synthetic-call',
                  'tool':'ic_apply','arguments':{'review_id':review['review_id'],'message':'SYNTHETIC approved change','idempotency_key':'synthetic-ai-edit-1'}}}
        self.ai._tool(message)
        return next(iter(self.ai.pending))
    def test_mutation_waits_for_human_then_denial(self):
        before=self.fixture.app.workspace.head(); aid=self.mutation()
        self.assertEqual(self.ai.rpc.sent,[])
        self.assertEqual(self.fixture.app.workspace.head(),before)
        self.ai.approve(aid,'deny')
        self.assertEqual(self.fixture.app.workspace.head(),before)
        self.assertEqual(self.ai.state,'suspended')
        self.assertFalse(self.ai.rpc.sent[0]['result']['success'])
    def test_human_accept_exact_diff_once(self):
        aid=self.mutation();before=self.fixture.app.workspace.head()
        self.ai.approve(aid,'approve')
        after=self.fixture.app.workspace.head();self.assertNotEqual(before,after)
        with self.assertRaises(Failure):self.ai.approve(aid,'approve')
        self.assertEqual(after,self.fixture.app.workspace.head())
    def test_model_cannot_approve(self):
        self.ai._tool({'id':'evil','params':{'threadId':'synthetic-thread','turnId':'synthetic-turn','tool':'ic_approve','arguments':{},'callId':'evil'}})
        self.assertFalse(self.ai.rpc.sent[-1]['result']['success'])
    def test_disconnect_keeps_request_no_dispatch(self):
        before=self.fixture.app.workspace.head();aid=self.mutation()
        self.ai._receive({'method':'transport/disconnected','params':{'reason':'synthetic'}})
        with self.assertRaises(Failure):self.ai.approve(aid,'approve')
        self.assertEqual(self.fixture.app.workspace.head(),before)
        self.assertEqual(self.s.call('request_status',{'request_id':aid})['state'],'pending_approval')
    def test_approval_delivery_failure_preserves_accepted_receipt(self):
        aid=self.mutation()
        with patch.object(self.ai.rpc,'send',side_effect=Failure('transport_unknown','SYNTHETIC disconnect',75)):
            with self.assertRaises(Failure):self.ai.approve(aid,'approve')
        self.assertEqual(self.s.call('request_status',{'request_id':aid})['state'],'accepted')
        self.assertEqual(self.ai.state,'suspended')
    def test_unsupported_approval_never_guesses_accept(self):
        self.ai._receive({'id':7,'method':'unknown/requestApproval','params':{'threadId':'synthetic-thread','turnId':'synthetic-turn'}})
        with self.assertRaises(Failure):self.ai.approve(next(iter(self.ai.pending)),'approve')
        self.assertEqual(self.ai.rpc.sent,[]);self.assertEqual(self.ai.state,'suspended')
    def test_native_command_approval_forwarded_denial(self):
        self.ai._receive({'id':7,'method':'item/commandExecution/requestApproval','params':{'threadId':'synthetic-thread','turnId':'synthetic-turn','command':'SYNTHETIC command'}})
        self.ai.approve(next(iter(self.ai.pending)),'deny')
        self.assertEqual(self.ai.rpc.sent[0],{'id':7,'result':{'decision':'decline'}})
    def test_stale_turn_cannot_call_tools(self):
        self.ai._tool({'id':'old','params':{'threadId':'synthetic-thread','turnId':'OLD','tool':'ic_projects','arguments':{}}})
        self.assertFalse(self.ai.rpc.sent[-1]['result']['success'])
    def test_turn_key_persisted_across_restart_no_replay(self):
        self.ai.state='idle';self.ai.thread_id=None
        context=self.context();r=self.ai.turn('Synthetic read request',context,'synthetic-turn-key')
        replacement=AiSession(self.s,FakeRpc)
        try:
            repeated=replacement.turn('Synthetic read request',context,'synthetic-turn-key')
            # Restart preserves the receipt identity while suspending unfinished work.
            self.assertEqual({**r, 'state': 'suspended'}, repeated)
            self.assertEqual(replacement.state, 'suspended');self.assertIsNone(replacement.rpc)
        finally:replacement.close()
    def test_context_dirty_and_hash_mismatch(self):
        self.ai.state='idle';c=self.context();c['file']['dirty']=True
        with self.assertRaises(Failure):self.ai.turn('Synthetic',c,'dirty-key-001')
        c=self.context();c['file']['persistedSha256']='0'*64
        with self.assertRaises(Failure):self.ai.turn('Synthetic',c,'stale-key-001')
    def test_events_replay_no_tool_replay(self):
        aid=self.mutation();one=self.ai.poll(0);two=self.ai.poll(one['cursor'])
        self.assertEqual(two['events'],[]);self.assertEqual(self.ai.rpc.sent,[])
        self.assertEqual(two['pending'][0]['approval_id'],aid)
    def test_heartbeat_expiry_suspends(self):
        aid=self.mutation();self.ai.last_seen=time.monotonic()-25
        time.sleep(1.2)
        self.assertEqual(self.ai.state,'suspended')
        with self.assertRaises(Failure):self.ai.approve(aid,'approve')


if __name__=='__main__':unittest.main(verbosity=2)
