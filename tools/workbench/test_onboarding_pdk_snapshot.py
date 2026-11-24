"""Exact owner-cache snapshot retention for explicit discovery; no remote I/O."""
import contextlib
import copy
import io
import json
import unittest
from unittest.mock import patch

from onboarding_lut import load_library_snapshot,lookup_discovery,store_library
from onboarding_pdk_scope import load_scope_selection
from runner import atomic
from test_onboarding_integration import _IntakeFixture,SOURCE


class CachedLibrarySnapshotTests(_IntakeFixture):
    def setUp(self):
        super().setUp();self.capture['private']['identity']['uid']=1000
        self.cache=self.runtime.root/'pdk-cache'
        self.requirements=self.new_source()['source']['requirements']

    def library(self):
        from spiceowl.onboarding.pdk_discovery import build_pdk_library_script
        output=io.StringIO()
        with contextlib.redirect_stdout(output):exec(build_pdk_library_script(roots=[str(self.models)]),{})
        return json.loads(output.getvalue())

    def stored(self):
        library=self.library();store_library(self.cache,self.capture,library,observed_at=100)
        found=lookup_discovery(self.cache,self.capture,self.requirements,now=101)
        return library,found['public']

    def test_exact_bound_snapshot_preserves_original_observation_without_reconstruction(self):
        library,lookup=self.stored()
        copied=load_library_snapshot(self.cache,self.capture,lookup,now=101)
        self.assertEqual(copied,library);self.assertIsNot(copied,library)
        self.ssh.assert_not_called();self.doctor.assert_not_called()

    def test_foreign_host_root_or_identity_never_falls_back_to_another_record(self):
        library,lookup=self.stored()
        other=copy.deepcopy(self.capture);other['private']['identity']['username']='another-synthetic-user'
        for capture,proof,roots in ((other,lookup,None),(self.capture,lookup,['/synthetic/foreign-root']),
                *[(self.capture,{**lookup,key:'f'*64},None) for key in ('library_id','content_fingerprint','cache_id')]):
            with self.subTest(roots=roots,proof=proof),self.assertRaises(ValueError):
                load_library_snapshot(self.cache,capture,proof,roots=roots,now=101)
        self.ssh.assert_not_called()

    def test_stale_and_future_clock_records_cannot_be_exported(self):
        _,lookup=self.stored()
        for now in (99,200):
            with self.subTest(now=now),self.assertRaises(ValueError):
                load_library_snapshot(self.cache,self.capture,lookup,max_age_s=5,now=now)
        self.ssh.assert_not_called()

    def test_owner_response_library_hash_is_rechecked_before_retention(self):
        _,lookup=self.stored()
        from spiceowl.onboarding.pdk_lut import PdkLut
        original=PdkLut.lookup_library_snapshot
        def changed(cache,**args):
            result=original(cache,**args)
            result['library']['files'][0]['sha256']='0'*64
            return result
        with patch.object(PdkLut,'lookup_library_snapshot',changed),self.assertRaises(ValueError):
            load_library_snapshot(self.cache,self.capture,lookup,now=101)
        self.ssh.assert_not_called()

    def discover_intake(self,source=SOURCE,*,library=None):
        state=self.probe(self.new_source(source))
        remote=patch('onboarding_discovery.remote_discovery',return_value=library) if library is not None else \
            patch('onboarding_discovery.remote_discovery',side_effect=AssertionError('An exact cache hit must not scan'))
        with remote as scan:
            state=self.runtime.write('discover-pdk',{'intake_id':state['intake_id'],'revision':state['revision'],
                'probe_ids':[state['probes'][0]['probe_id']]},origin='test_harness')
        if library is not None:scan.assert_called_once()
        else:scan.assert_not_called()
        return state

    def reuse_and_select(self,*,legacy=False):
        library=self.library();first=self.discover_intake(library=library)
        second=self.discover_intake(SOURCE+'// independently authored source revision\n')
        self.assertNotEqual(first['intake_id'],second['intake_id'])
        lut=second['discovery']['lut'][0]
        self.assertFalse(lut['scan_performed']);self.assertFalse(lut['scan_required'])
        folder=self.runtime._folder(second['intake_id'])
        self.assertEqual(json.loads((folder/'libraries'/(library['library_id']+'.json')).read_text()),library)
        identity={'intake_id':second['intake_id'],'probe_id':second['probes'][0]['probe_id'],
                  'library_id':library['library_id']}
        if legacy:
            previous_path=folder/'discoveries'/(second['discovery']['discovery_id']+'.json')
            old=json.loads(previous_path.read_text())
            for row in old['rows']:row.pop('library_binding',None)
            atomic(previous_path,old);old_bytes=previous_path.read_bytes()
            with self.assertRaisesRegex(ValueError,'explicit cache-only rebinding'):
                self.runtime.read('pdk-scopes',identity)
            with patch('onboarding_discovery.remote_discovery',side_effect=AssertionError('Explicit cache binding never scans')) as scan:
                second=self.runtime.write('discover-pdk',{'intake_id':second['intake_id'],
                    'revision':second['revision'],'probe_ids':[identity['probe_id']],
                    'library_selection':{'probe_id':identity['probe_id'],'library_id':library['library_id'],
                        'library_candidate_id':library['entry_candidates'][0]['candidate_id']}},origin='test_harness')
            scan.assert_not_called();self.assertEqual(previous_path.read_bytes(),old_bytes)
        catalog=self.runtime.read('pdk-scopes',identity)['catalog']
        entry=next(row for row in catalog['items'] if row['label']=='entry.scs')
        scopes=self.runtime.read('pdk-scopes',{**identity,'entry_id':entry['entry_id']})['catalog']
        sections=[row['section_id'] for row in scopes['items'] if row['section'] is not None]
        chosen=self.runtime.write('select-pdk-scope',{**identity,'revision':second['revision'],
            'entry_id':entry['entry_id'],'section_ids':sections},origin='test_harness')
        self.assertEqual(chosen['pdk_scope_selection']['status'],'requires_audit')
        self.assertFalse(chosen['pdk_scope_selection']['ready_to_run'])
        selected=load_scope_selection(folder,self.runtime._load(second['intake_id']),chosen['pdk_scope_selection']['selection_id'])
        self.assertEqual(selected['public']['source_sha256'],second['source_sha256'])
        self.assertEqual(selected['private']['entry_path'],str(self.model_file))
        self.ssh.assert_not_called();self.doctor.assert_not_called()
        return second

    def test_second_intake_retains_the_exact_cached_library_then_selects_locally(self):
        self.assertEqual(self.reuse_and_select()['discovery']['lut'][0]['status'],'hit')

    def test_cached_partial_same_entry_sections_can_be_selected_without_a_new_scan(self):
        self.model_file.write_text('simulator lang=spectre\n'
            'section MOS_TT\nsubckt device_alpha d g s b\nR (d s) resistor r=1k\nends device_alpha\nendsection MOS_TT\n'
            'section CAP_TT\nsubckt device_beta d g s b\nC (d s) capacitor c=1p\nends device_beta\nendsection CAP_TT\n')
        self.assertEqual(self.reuse_and_select()['discovery']['lut'][0]['status'],'partial')

    def test_legacy_retained_discovery_rebinds_cache_only_then_selects_actual_scope_union(self):
        self.model_file.write_text('simulator lang=spectre\n'
            'section MOS_TT\nsubckt device_alpha d g s b\nR (d s) resistor r=1k\nends device_alpha\nendsection MOS_TT\n'
            'section CAP_TT\nsubckt device_beta d g s b\nC (d s) capacitor c=1p\nends device_beta\nendsection CAP_TT\n')
        self.assertEqual(self.reuse_and_select(legacy=True)['discovery']['lut'][0]['status'],'partial')


if __name__=='__main__':unittest.main()
