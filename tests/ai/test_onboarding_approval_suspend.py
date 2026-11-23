"""Unconfirmed reviewed TB outcomes stop the web AI before its next tool call."""
import copy
import json
import unittest
from unittest.mock import patch

import test_ai
from icwb.ai import AiSession
from icwb.service import Failure,digest


class OnboardingApprovalSuspensionTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_ai.AiTests();self.fixture.setUp();self.addCleanup(self.fixture.tearDown)
        self.ai=self.fixture.ai;self.service=self.fixture.s
        self.key='synthetic-reviewed-tb-turn';self.intake='intake_'+'a'*32
        self.ai.request_key=self.key
        self.ai.turns[self.key]={'key':self.key,'state':'running','permission_mode':'manual',
            'thread_id':self.ai.thread_id,'turn_id':self.ai.turn_id,
            'onboarding_binding':{'schema':'ic.onboarding.context.v1','connection_id':'b'*32,
                'intake_id':self.intake,'revision':5,'source_sha256':'c'*64}}
        self.request={'request_id':'d'*64,'fingerprint':'e'*64,'state':'pending_approval',
            'operation':'onboarding_agent_tb_run','arguments':{'intake_id':self.intake,'revision':5,'plan_id':'f'*64},
            'review':{'snapshot':{'testbench':{'text':'literal frozen TB'}}},'automatic_retry':False}
        self.message={'id':'tb-rpc','method':'item/tool/call','params':{'threadId':self.ai.thread_id,
            'turnId':self.ai.turn_id,'callId':'tb-call','tool':'ic_onboarding_run','arguments':self.request['arguments']}}
        with patch.object(self.service,'call',return_value=copy.deepcopy(self.request)):
            self.ai._tool(self.message)
        self.assertEqual(self.ai.pending[self.request['request_id']]['status'],'pending')
        self.ai.rpc.sent.clear()

    def assert_suspended(self,resolution):
        with patch.object(self.service,'resolve',return_value=copy.deepcopy(resolution)) as resolve:
            reply=self.ai.approve(self.request['request_id'],'approve')
        resolve.assert_called_once_with(self.request['request_id'],'approve',self.request['fingerprint'])
        self.assertEqual(reply['status'],'suspended');self.assertFalse(reply['automatic_retry'])
        self.assertEqual(self.ai.state,'suspended');self.assertEqual(self.ai.suspension_reason,'onboarding_submission_unconfirmed')
        pending=self.ai.pending[self.request['request_id']]
        self.assertEqual(pending['request'],self.request);self.assertEqual(pending['resolution'],resolution)
        self.assertEqual(pending['status'],'suspended');self.assertFalse(pending['can_approve'])
        tool_reply=next(row for row in self.ai.rpc.sent if row.get('id')=='tb-rpc')
        self.assertFalse(tool_reply['result']['success'])
        self.assertEqual(json.loads(tool_reply['result']['contentItems'][0]['text']),resolution)
        self.assertEqual(sum(row.get('method')=='turn/interrupt' for row in self.ai.rpc.sent),1)
        stored=json.loads((self.service.state/'ai-turns'/(digest(self.key)+'.json')).read_text())
        self.assertEqual(stored['state'],'suspended')
        with patch.object(self.service,'call') as call:
            self.ai._tool({**self.message,'id':'late-next-tool'})
            call.assert_not_called()
        with patch.object(self.service,'resolve') as resolve:
            with self.assertRaises(Failure):self.ai.approve(self.request['request_id'],'approve')
            resolve.assert_not_called()
        self.assertFalse(self.ai.history()['recovery']['can_resume'])

    def test_transport_uncertain_receipt_is_preserved_and_stops_next_tools(self):
        self.assert_suspended({'request_id':self.request['request_id'],'state':'uncertain',
            'operation':'onboarding_agent_tb_run','automatic_retry':False})

    def test_rejected_review_stops_dependent_work(self):
        self.assert_suspended({'request_id':self.request['request_id'],'state':'rejected',
            'error':{'code':'review_host_unavailable'},'automatic_retry':False})

    def test_accepted_envelope_with_preflight_rejection_stops_dependent_work(self):
        self.assert_suspended({'request_id':self.request['request_id'],'state':'accepted',
            'result':{'state':'pre_dispatch_rejected','submission':{'dispatch_outcome':'pre_dispatch_rejected',
                'submission_key':'experiment-'+'f'*64,'replay_permitted':False}}})

    def test_accepted_envelope_with_nested_unknown_submission_suspends(self):
        self.assert_suspended({'request_id':self.request['request_id'],'state':'accepted',
            'result':{'state':'submitted','submission':{'dispatch_outcome':'unknown','replay_permitted':False}}})

    def test_accepted_envelope_with_uncertain_runtime_state_suspends(self):
        self.assert_suspended({'request_id':self.request['request_id'],'state':'accepted',
            'result':{'state':'submission_uncertain'}})

    def test_confirmed_accepted_submission_retains_normal_flow(self):
        result={'request_id':self.request['request_id'],'state':'accepted',
            'result':{'state':'submitted','submission':{'dispatch_outcome':'recorded','found':True}}}
        with patch.object(self.service,'resolve',return_value=result):
            response=self.ai.approve(self.request['request_id'],'approve')
        self.assertEqual(response['status'],'resolved');self.assertEqual(self.ai.state,'running')
        self.assertTrue(self.ai.rpc.sent[0]['result']['success'])
        self.assertFalse(any(row.get('method')=='turn/interrupt' for row in self.ai.rpc.sent))

    def test_failed_interrupt_delivery_keeps_local_gate_and_receipt(self):
        result={'state':'uncertain','request_id':self.request['request_id']}
        with patch.object(self.service,'resolve',return_value=result),patch.object(self.ai.rpc,'call',side_effect=Failure('transport_unknown','synthetic interrupt delivery failure',75)):
            response=self.ai.approve(self.request['request_id'],'approve')
        self.assertEqual(response['status'],'suspended');self.assertEqual(self.ai.state,'suspended')
        self.assertEqual(self.ai.pending[self.request['request_id']]['resolution'],result)

    def test_restart_preserves_original_unconfirmed_receipt_without_reapproval(self):
        result={'state':'uncertain','request_id':self.request['request_id']}
        with patch.object(self.service,'resolve',return_value=result):self.ai.approve(self.request['request_id'],'approve')
        restored=AiSession(self.service,test_ai.FakeRpc)
        try:
            self.assertEqual(restored.state,'suspended')
            self.assertEqual(restored.pending[self.request['request_id']]['request'],self.request)
            self.assertEqual(restored.pending[self.request['request_id']]['resolution'],result)
            self.assertFalse(restored.pending[self.request['request_id']]['can_approve'])
            with patch.object(self.service,'resolve') as resolve:
                with self.assertRaises(Failure):restored.approve(self.request['request_id'],'approve')
                resolve.assert_not_called()
        finally:restored.close()
