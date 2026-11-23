"""Native host review of an authored TB; all solver transport is synthetic."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from test_onboarding_service import FixtureGateway, CONNECTION, INTAKE, PLAN, COMMIT, JOB
from ic_gateway.agent_testbench import human_signature, HUMAN_ROUTE
from ic_gateway.service import Service, Failure, canonical
from ic_gateway.contracts import SCHEMAS, READ_ONLY
from icwb.elicitation import ReviewSession

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'tools/workbench'))
from onboarding_review import verify_authorization


class ReviewedGateway(FixtureGateway):
    def __init__(self):
        super().__init__()
        self.lose_human_reply = False
        self.human_error = None
        snapshot = {'testbench': {'text': 'simulator lang=spectre\n// comparator 独立目标\n'},
                    'targets': [{'metric': 'delay_s', 'maximum': 2e-9}], 'hosts': ['synthetic-host']}
        digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.review = {'schema':'ic.agent-tb.review.v1','connection_id':CONNECTION,
            'intake_id':INTAKE,'revision':3,'draft_id':'e'*64,'plan_id':PLAN,
            'review_id':'f'*64,'review_digest':digest,'state':'pending','snapshot':snapshot}
        self.session.update(mode='agent-tb', source_sha256='1'*64, agent_tb={'testbench':snapshot['testbench']},
                            agent_tb_review={k:v for k,v in self.review.items() if k!='snapshot'})
        self.session['prepared']['recipe_id']='agent-testbench'

    def request(self, path, body=None, **kwargs):
        if '/agent-tb/review?' in path:
            self.calls.append((path, copy.deepcopy(body), kwargs));return copy.deepcopy(self.review)
        if path == HUMAN_ROUTE:
            self.calls.append((path, copy.deepcopy(body), kwargs))
            raw = canonical(body).encode()
            keyfile = Path(kwargs['human_review_key_file'])
            signature = human_signature(keyfile, path, raw)
            verify_authorization(keyfile.read_bytes(), raw, signature)
            if self.human_error:raise self.human_error
            if self.lose_human_reply:raise Failure('transport_unknown','Synthetic lost reply',75)
            return copy.deepcopy(self.session)
        return super().request(path, body, **kwargs)


class AgentReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.key=Path(self.temp.name)/'review.key';self.key.write_bytes(b'x'*32);self.key.chmod(0o600)
        self.service=Service({'gateway_url':FixtureGateway.origin,'state_dir':str(Path(self.temp.name)/'client'),
            'onboarding_review_authority_key_file':str(self.key)})
        self.gateway=ReviewedGateway();self.service.gateway=self.gateway
        self.args={'intake_id':INTAKE,'revision':3,'plan_id':PLAN}

    def pending(self):
        return self.service.call('onboarding_run', self.args)

    def posts(self):return [r for r in self.gateway.calls if r[1] is not None]

    def test_run_only_creates_host_review_with_full_frozen_bytes(self):
        result=self.pending()
        self.assertEqual(result['state'],'pending_approval');self.assertEqual(self.posts(),[])
        self.assertEqual(result['review'],self.gateway.review)
        self.assertNotIn(str(self.key),json.dumps(result));self.assertNotIn('human_review_key_file',result)
        self.assertEqual(self.pending()['request_id'],result['request_id'])
        review=ReviewSession(self.service, lambda _message:None, lambda *_args,**_kwargs:None)
        self.assertEqual(review._receipt({'request_id':result['request_id'],'fingerprint':result['fingerprint']}),result)

    def test_only_host_resolver_signs_once_and_duplicate_resolve_does_not_replay(self):
        result=self.pending();identity=(result['request_id'],'approve',result['fingerprint'])
        accepted=self.service.resolve(*identity)
        self.assertEqual(accepted['state'],'accepted');self.assertEqual(len(self.posts()),1)
        self.assertEqual(self.posts()[0][0],HUMAN_ROUTE)
        self.assertEqual(self.service.resolve(*identity),accepted)
        self.assertEqual(self.pending()['state'],'accepted');self.assertEqual(len(self.posts()),1)

    def test_changed_draft_after_form_open_is_rejected_before_dispatch(self):
        result=self.pending();self.gateway.session['agent_tb_review']['review_digest']='2'*64
        answer=self.service.resolve(result['request_id'],'approve',result['fingerprint'])
        self.assertEqual(answer['state'],'rejected');self.assertEqual(self.posts(),[])

    def test_saved_request_survives_session_revision_and_plan_changes_without_redispatch(self):
        result=self.pending()
        accepted=self.service.resolve(result['request_id'],'approve',result['fingerprint'])
        self.gateway.session['revision']=9
        self.gateway.session['prepared']['plan_id']='9'*64
        self.assertEqual(self.pending(),accepted)
        self.assertEqual(self.service.call('onboarding_run',{**self.args,'revision':9}),accepted)
        self.assertEqual(len(self.posts()),1)

    def test_unknown_review_blocks_new_preparation_without_another_post(self):
        result=self.pending();self.gateway.lose_human_reply=True
        self.service.resolve(result['request_id'],'approve',result['fingerprint'])
        with self.assertRaises(Failure) as error:
            self.service._check_onboarding_prepare(CONNECTION,INTAKE)
        self.assertEqual(error.exception.code,'onboarding_submission_unresolved')
        self.assertEqual(error.exception.details['plan_id'],PLAN)
        self.assertEqual(len(self.posts()),1)

    def test_original_lookup_reconciles_lost_review_reply_without_replay(self):
        result=self.pending();self.gateway.lose_human_reply=True
        self.service.resolve(result['request_id'],'approve',result['fingerprint'])
        lookup={'intake_id':INTAKE,'plan_id':PLAN}
        self.assertFalse(self.service.call('onboarding_submission',lookup)['found'])
        self.assertEqual(self.pending()['state'],'uncertain')
        self.gateway.job={'schema':'ic.experiment.job.v1','project_id':INTAKE,'plan_id':PLAN,
            'job_id':JOB,'run_id':JOB,'source_commit':COMMIT,'state':'queued'}
        self.assertTrue(self.service.call('onboarding_submission',lookup)['found'])
        self.assertEqual(self.pending()['state'],'accepted')
        self.service._check_onboarding_prepare(CONNECTION,INTAKE)
        self.assertEqual(len(self.posts()),1)

    def test_wrong_source_cannot_clear_uncertain_review(self):
        result=self.pending();self.gateway.lose_human_reply=True
        self.service.resolve(result['request_id'],'approve',result['fingerprint'])
        self.gateway.job={'project_id':INTAKE,'plan_id':PLAN,'job_id':JOB,'run_id':JOB,'source_commit':'0'*40}
        with self.assertRaises(Failure):
            self.service.call('onboarding_submission',{'intake_id':INTAKE,'plan_id':PLAN})
        self.assertEqual(self.pending()['state'],'uncertain')

    def test_http_400_after_reservation_is_uncertain_until_original_lookup(self):
        result=self.pending()
        self.gateway.human_error=Failure('invalid_input','Synthetic response validation failure',2,{'http_status':400})
        self.gateway.job={'project_id':INTAKE,'plan_id':PLAN,'job_id':JOB,'run_id':JOB,'source_commit':COMMIT}
        answer=self.service.resolve(result['request_id'],'approve',result['fingerprint'])
        self.assertEqual(answer['state'],'uncertain')
        with self.assertRaises(Failure):self.service._check_onboarding_prepare(CONNECTION,INTAKE)
        self.service.call('onboarding_submission',{'intake_id':INTAKE,'plan_id':PLAN})
        self.assertEqual(self.pending()['state'],'accepted')
        self.service._check_onboarding_prepare(CONNECTION,INTAKE)
        self.assertEqual(len(self.posts()),1)

    def test_denied_or_unknown_original_request_is_never_rekeyed(self):
        result=self.pending();self.gateway.lose_human_reply=True
        answer=self.service.resolve(result['request_id'],'approve',result['fingerprint'])
        self.assertEqual(answer['state'],'uncertain');self.assertEqual(self.pending()['state'],'uncertain')
        self.service.resolve(result['request_id'],'approve',result['fingerprint'])
        self.assertEqual(len(self.posts()),1)

    def test_tool_catalog_never_exposes_human_approval_or_key(self):
        self.assertNotIn('onboarding_agent_tb_run',SCHEMAS)
        for name in ('onboarding_source','onboarding_agent_tb_review'):self.assertIn(name,READ_ONLY)
        with self.assertRaises(Failure):self.service.call('onboarding_run',{**self.args,'approved':True})
        with self.assertRaises(Failure):self.service.call('onboarding_run',{**self.args,'human_review_key_file':str(self.key)})
        self.assertEqual(self.gateway.calls,[])

    def test_helper_without_native_key_offers_exact_local_review_before_approval(self):
        del self.service.config['onboarding_review_authority_key_file']
        with self.assertRaises(Failure) as error:self.pending()
        self.assertEqual(error.exception.code,'review_host_unavailable')
        url=error.exception.details['review_url']
        self.assertTrue(url.startswith(self.gateway.origin+'/agent-tb/review?'))
        self.assertIn('review_id='+self.gateway.review['review_id'],url)
        self.assertIn('intake_id='+INTAKE,url)
        self.assertEqual(list((self.service.state/'requests').glob('*.json')),[])
        self.assertEqual(self.posts(),[])

    def test_signature_exact_bytes_expiry_and_private_permissions(self):
        raw=canonical(self.args).encode();signed=human_signature(self.key,HUMAN_ROUTE,raw,now=1234)
        verify_authorization(self.key.read_bytes(),raw,signed,now=1234)
        for content,now in ((raw+b' ',1234),(raw,1400)):
            with self.assertRaises(PermissionError):verify_authorization(self.key.read_bytes(),content,signed,now=now)
        self.key.chmod(0o644)
        with self.assertRaises(Failure):human_signature(self.key,HUMAN_ROUTE,raw)

    def test_tampered_full_snapshot_cannot_be_presented_for_approval(self):
        self.gateway.review['snapshot']['testbench']['text']='changed'
        with self.assertRaises(Failure):self.pending()
        self.assertEqual(self.posts(),[])


if __name__=='__main__':unittest.main()
