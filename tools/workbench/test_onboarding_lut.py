"""Local cache adaptation using newly authored scanner receipts, never SSH."""
import copy
import contextlib
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from onboarding_lut import lookup_discovery, lookup_model_bindings, store_discovery, store_library
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

    def library(self):
        from spiceowl.onboarding.pdk_discovery import build_pdk_library_script
        output=io.StringIO()
        with contextlib.redirect_stdout(output):exec(build_pdk_library_script(roots=[str(self.models)]),{})
        return json.loads(output.getvalue())

    def test_full_library_reuses_distinct_device_sets_with_current_source_bindings(self):
        library=self.library();stored=store_library(self.cache_root,self.capture,library,observed_at=100)
        for i,names in enumerate((['device_alpha'],['device_beta'],['device_alpha','device_beta'])):
            requirements={**self.requirements,'source_sha256':str(i+1)*64,'required_masters':names}
            lookup=lookup_discovery(self.cache_root,self.capture,requirements,now=101)
            self.assertEqual(lookup['public']['status'],'hit')
            self.assertEqual(lookup['public']['library_id'],stored['library_id'])
            self.assertEqual(lookup['public']['binding_mode'],'per_device_library_query')
            self.assertEqual(lookup['discovery']['required_masters'],names)
            self.assertEqual(lookup['discovery']['source_sha256'],requirements['source_sha256'])
            self.assertFalse(lookup['public']['remote_freshness_verified'])
            self.assertNotIn(str(self.models),json.dumps(lookup['public']))
        self.ssh.assert_not_called()

    def test_full_library_missing_device_and_age_remain_explicit_gaps(self):
        store_library(self.cache_root,self.capture,self.library(),observed_at=100)
        missing=lookup_discovery(self.cache_root,self.capture,{**self.requirements,'required_masters':['device_alpha','absent']},now=101)
        self.assertEqual(missing['public']['status'],'partial')
        self.assertIsNone(missing['discovery']);self.assertTrue(missing['public']['scan_required'])
        self.assertEqual(missing['public']['missing'][0]['model_names'],['absent'])
        stale=lookup_discovery(self.cache_root,self.capture,self.requirements,now=200,max_age_s=5)
        self.assertEqual(stale['public']['status'],'stale');self.assertIsNone(stale['discovery'])

    def test_disjoint_entries_remain_a_combination_draft_and_do_not_rescan(self):
        (self.models/'separate.scs').write_text('simulator lang=spectre\nsection typical\nsubckt device_gamma a b\nR (a b) resistor r=1k\nends device_gamma\nendsection typical\n')
        store_library(self.cache_root,self.capture,self.library(),observed_at=100)
        requirements={**self.requirements,'required_masters':['device_alpha','device_gamma']}
        result=lookup_discovery(self.cache_root,self.capture,requirements,now=101)
        self.assertEqual(result['public']['status'],'partial');self.assertIsNone(result['discovery'])
        self.assertFalse(result['public']['scan_required'])
        self.assertFalse(result['public']['combination']['combination_verified'])
        self.assertEqual(result['public']['combination']['entry_count'],2)
        self.assertNotIn(str(self.models),json.dumps(result['public']))
        self.ssh.assert_not_called()

    def test_runtime_scans_library_once_then_projects_a_different_requested_set(self):
        first=self.probe(self.new_source());library=self.library()
        args={'intake_id':first['intake_id'],'revision':first['revision'],'probe_ids':[first['probes'][0]['probe_id']]}
        with patch('onboarding_discovery.remote_discovery',return_value=library) as scan:
            first=self.runtime.write('discover-pdk',args,origin='test_harness')
        self.assertTrue(scan.call_args.kwargs['full_library'])
        self.assertEqual(first['discovery']['lut'][0]['storage']['status'],'stored')
        self.assertTrue((self.runtime._folder(first['intake_id'])/'libraries'/(library['library_id']+'.json')).is_file())
        second=self.probe(self.new_source(SOURCE.replace('device_beta','device_alpha')))
        args={'intake_id':second['intake_id'],'revision':second['revision'],'probe_ids':[second['probes'][0]['probe_id']]}
        with patch('onboarding_discovery.remote_discovery',side_effect=AssertionError('Covered devices require no repeat scan')):
            second=self.runtime.write('discover-pdk',args,origin='test_harness')
        row=second['discovery']['lut'][0]
        self.assertEqual(row['status'],'hit');self.assertFalse(row['scan_performed'])
        self.assertEqual(row['rebound_source_sha256'],second['source_sha256'])
        self.assertTrue(second['discovery']['candidates']);self.ssh.assert_not_called()

    def test_bounded_entry_choice_stays_in_original_library_and_never_scans(self):
        state=self.probe(self.new_source())
        store_library(self.runtime.root/'pdk-cache',self.capture,self.library())
        args={'intake_id':state['intake_id'],'revision':state['revision'],'probe_ids':[state['probes'][0]['probe_id']]}
        # Tighten the real owner's query budget to exercise bounded choices on
        # a small synthetic inventory, without fabricating a partial receipt.
        with patch('spiceowl.onboarding.pdk_discovery.MAX_RESULT_BYTES',128), \
             patch('onboarding_discovery.remote_discovery',side_effect=AssertionError('Cached choices cannot scan')):
            state=self.runtime.write('discover-pdk',args,origin='test_harness')
        lut=state['discovery']['lut'][0]
        self.assertEqual(lut['status'],'partial');self.assertFalse(lut['scan_performed'])
        choice=lut['entry_choices'][0]
        selection={'probe_id':lut['probe_id'],'library_id':lut['library_id'],
                   'library_candidate_id':choice['library_candidate_id']}
        args.update(revision=state['revision'],library_selection={**selection,'library_id':'f'*64})
        with patch('onboarding_discovery.remote_discovery',side_effect=AssertionError('Pinned selection never scans')):
            with self.assertRaises(ValueError):self.runtime.write('discover-pdk',args,origin='test_harness')
            self.assertEqual(self.runtime.read('session',{'intake_id':state['intake_id']})['revision'],state['revision'])
            args['library_selection']=selection
            selected=self.runtime.write('discover-pdk',args,origin='test_harness')
        self.assertTrue(selected['discovery']['candidates'])
        self.assertEqual(selected['discovery']['lut'][0]['library_id'],lut['library_id'])
        self.assertFalse(selected['discovery']['lut'][0]['scan_performed'])

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
