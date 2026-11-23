"""Local cache adaptation using newly authored scanner receipts, never SSH."""
import copy
import json
from pathlib import Path
import unittest

from onboarding_lut import lookup_discovery, lookup_model_bindings, store_discovery
from test_onboarding_integration import _IntakeFixture, SOURCE


class OnboardingLutTests(_IntakeFixture):
    def setUp(self):
        super().setUp()
        self.capture['private']['identity']['uid']=1000
        self.cache_root=self.root/'private-cache'
        self.requirements=self.new_source()['source']['requirements']

    def store(self):
        self.evidence=self.synthetic_discovery(self.requirements)
        return store_discovery(self.cache_root,self.capture,self.evidence,observed_at=100)

    def test_missing_cache_lookup_never_creates_storage_or_starts_a_scan(self):
        result=lookup_discovery(self.cache_root,self.capture,self.requirements,now=101)
        self.assertEqual(result['public']['status'],'miss')
        self.assertIsNone(result['discovery'])
        self.assertFalse(self.cache_root.exists())
        self.ssh.assert_not_called()

    def test_new_source_same_model_scope_uses_bound_receipt_and_keeps_original_evidence(self):
        stored=self.store();original=copy.deepcopy(self.evidence)
        new=self.new_source(SOURCE+'// user-authored source revision\n')['source']['requirements']
        result=lookup_discovery(self.cache_root,self.capture,new,now=110)
        self.assertEqual(result['public']['status'],'hit')
        self.assertEqual(result['public']['cache_id'],stored['cache_id'])
        self.assertEqual(result['discovery']['source_sha256'],new['source_sha256'])
        self.assertEqual(result['public']['original_source_sha256'],self.requirements['source_sha256'])
        self.assertNotEqual(result['discovery']['discovery_id'],original['discovery_id'])
        self.assertEqual(self.evidence,original)
        self.assertFalse(result['public']['remote_freshness_verified'])
        self.assertTrue(result['public']['fresh_dependency_audit_required'])
        self.assertNotIn(str(self.models),json.dumps(result['public']))
        self.ssh.assert_not_called()

    def test_expired_refresh_and_different_server_roots_or_model_set_never_hit(self):
        self.store()
        expired=lookup_discovery(self.cache_root,self.capture,self.requirements,now=120,max_age_s=5)
        self.assertEqual(expired['public']['status'],'stale')
        self.assertIsNone(expired['discovery'])
        refresh=lookup_discovery(self.cache_root,self.capture,self.requirements,now=101,refresh=True)
        self.assertEqual(refresh['public']['status'],'refresh_required')
        self.assertIsNone(refresh['discovery'])
        changed=copy.deepcopy(self.capture);changed['private']['identity']['hostname']='another-server'
        self.assertEqual(lookup_discovery(self.cache_root,changed,self.requirements,now=101)['public']['status'],'miss')
        self.assertEqual(lookup_discovery(self.cache_root,self.capture,self.requirements,roots=['/synthetic/other'],now=101)['public']['status'],'miss')
        requirements={**self.requirements,'required_masters':['not_previously_observed']}
        self.assertEqual(lookup_discovery(self.cache_root,self.capture,requirements,now=101)['public']['status'],'miss')

    def test_incomplete_identity_does_not_fall_back_to_other_stored_environment(self):
        self.store();capture=copy.deepcopy(self.capture)
        capture['private']['identity'].pop('uid')
        result=lookup_discovery(self.cache_root,capture,self.requirements,now=101)
        self.assertEqual(result['public']['status'],'miss')
        self.assertEqual(result['public']['missing'][0]['code'],'cache_identity_unavailable')
        self.assertIsNone(result['discovery'])

    def test_empty_external_model_scope_requires_no_cache(self):
        result=lookup_discovery(self.cache_root,{},dict(self.requirements,required_masters=[]))
        self.assertEqual(result['public']['status'],'not_required')
        self.assertFalse(self.cache_root.exists())

    def test_best_index_is_explicitly_cached_identity_and_not_a_new_source_binding(self):
        self.store()
        result=lookup_model_bindings(self.cache_root,self.capture,self.requirements,now=101)
        self.assertEqual(result['public']['status'],'hit')
        self.assertTrue(result['public']['binding']['requires_source_rebinding'])
        self.assertEqual(result['public']['binding']['source_identity'],'original_cached_observation')
        self.assertTrue(result['recommendation']['recommended_candidate_id'])
        self.assertNotIn(str(self.models),json.dumps(result['public']))


if __name__=='__main__':unittest.main()
