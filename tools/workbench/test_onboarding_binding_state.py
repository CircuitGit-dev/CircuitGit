"""Saved synthetic library coverage is distinct from a ready source binding."""
import contextlib
import copy
import io
import json
import unittest
from unittest.mock import patch

from onboarding_discovery import public_discovery
from onboarding_guidance import next_actions
from test_onboarding_integration import _IntakeFixture, SOURCE


class CachedBindingStateTests(_IntakeFixture):
    def setUp(self):
        super().setUp()
        self.capture['private']['identity']['uid']=1000
        (self.models/'separate.scs').write_text('simulator lang=spectre\nsection typical\n'
            'subckt device_gamma a b\nR (a b) resistor r=1k\nends device_gamma\nendsection typical\n')

    def library(self):
        from spiceowl.onboarding.pdk_discovery import build_pdk_library_script
        output=io.StringIO()
        with contextlib.redirect_stdout(output):exec(build_pdk_library_script(roots=[str(self.models)]),{})
        return json.loads(output.getvalue())

    def stored_combination(self):
        state=self.probe(self.new_source(SOURCE.replace('device_beta','device_gamma')))
        args={'intake_id':state['intake_id'],'revision':state['revision'],
              'probe_ids':[row['probe_id'] for row in state['probes']],'refresh':True}
        with patch('onboarding_discovery.remote_discovery',return_value=self.library()) as remote:
            result=self.runtime.write('discover-pdk',args,origin='test_harness')
        remote.assert_called_once()
        return result

    def assert_pending_binding(self,state):
        discovery=state['discovery']
        self.assertEqual(discovery['candidates'],[])
        self.assertEqual(discovery['coverage'][0]['status'],'partial')
        self.assertEqual(discovery['coverage'][0]['phase'],'library_binding_pending')
        self.assertIsNone(discovery['coverage'][0]['search_complete'])
        self.assertNotIn('unknown_count',discovery['coverage'][0])
        codes={gap['code'] for gap in discovery['missing']}
        self.assertIn('multi_entry_selection_required',codes)
        self.assertIn('combined_dependency_audit_required',codes)
        self.assertNotIn('no_model_candidates',codes)
        self.assertNotIn('pdk_library_binding_incomplete',codes)
        self.assertFalse(discovery['selection_made']);self.assertFalse(discovery['simulation_started'])
        self.assertFalse(any(row['operation']=='discover-pdk' and row['ready'] for row in state['next_actions']))

    def test_runtime_store_and_cache_query_preserve_partial_index_without_rescanning(self):
        first=self.stored_combination();self.assert_pending_binding(first)
        lut=first['discovery']['lut'][0]
        self.assertEqual(lut['status'],'refresh_required');self.assertTrue(lut['scan_required'])
        self.assertEqual(lut['storage']['status'],'stored')
        self.assertEqual(lut['projection']['status'],'partial');self.assertFalse(lut['projection']['scan_required'])
        self.assertFalse(lut['projection']['combination']['combination_verified'])
        self.assertFalse(lut['projection']['ready_to_run'])
        before=copy.deepcopy(lut)
        self.assert_pending_binding(self.runtime.read('session',{'intake_id':first['intake_id']}))
        self.assertEqual(first['discovery']['lut'][0],before)
        with patch('onboarding_discovery.remote_discovery',side_effect=AssertionError('Cached binding never rescans')) as remote:
            second=self.runtime.write('discover-pdk',{'intake_id':first['intake_id'],'revision':first['revision'],
                'probe_ids':[first['probes'][0]['probe_id']]},origin='test_harness')
        remote.assert_not_called();self.assert_pending_binding(second)
        self.assertEqual(second['next_actions'][0]['operation'],'session')
        self.assertEqual(second['next_actions'][1]['operation'],'prepare')
        self.assertFalse(second['next_actions'][1]['ready'])
        self.ssh.assert_not_called();self.doctor.assert_not_called()

    def test_agent_without_draft_can_author_but_sees_saved_binding_gaps(self):
        state=self.stored_combination();state['mode']='agent-tb'
        actions=next_actions(state)
        self.assertEqual(actions[0]['operation'],'source');self.assertTrue(actions[0]['ready'])
        draft=next(row for row in actions if row['operation']=='agent-tb/draft')
        self.assertFalse(draft['ready'])
        self.assertTrue({'agent_authored_testbench_required','multi_entry_selection_required',
            'combined_dependency_audit_required'}<={row['code'] for row in draft['missing']})
        self.assertFalse(any(row['operation']=='discover-pdk' for row in actions))

    def test_agent_selected_unprojected_entry_does_not_become_ready_to_prepare(self):
        state=self.stored_combination();state['mode']='agent-tb'
        state['agent_tb']={'draft_id':'synthetic-draft','selection':{'candidate_id':'a'*64}}
        action=next_actions(state)[0]
        self.assertEqual(action['operation'],'agent-tb/prepare');self.assertFalse(action['ready'])
        self.assertIn('multi_entry_selection_required',{row['code'] for row in action['missing']})

    def test_projection_coverage_keeps_unknowns_and_other_host_failure_separate(self):
        state=self.stored_combination();lut=copy.deepcopy(state['discovery']['lut'][0]);probe=lut['probe_id']
        lut['projection']['coverage'].update(search_complete=False,unknown_count=7,
            complete_within_policy=False,whole_pdk_qualified=False)
        rows=[{'probe_id':probe,'result':None,'lut':lut,'error_code':'pdk_library_binding_incomplete'},
              {'probe_id':'probe_'+'e'*32,'result':None,'error_code':'pdk_discovery_incomplete'}]
        original=copy.deepcopy(rows);public=public_discovery(rows,'discovery_'+'a'*32)
        self.assertEqual(rows,original)
        self.assertEqual(public['coverage'][0]['status'],'partial')
        self.assertEqual(public['coverage'][0]['unknown_count'],7)
        self.assertFalse(public['coverage'][0]['search_complete'])
        self.assertFalse(public['coverage'][0]['complete_within_policy'])
        self.assertEqual(public['coverage'][1]['status'],'unavailable')
        narrow=[gap for gap in public['missing'] if gap['field']=='search_paths']
        self.assertEqual([gap['probe_id'] for gap in narrow],['probe_'+'e'*32])

    def test_genuine_missing_or_stale_observations_keep_scan_guidance(self):
        for status,scan_required in (('miss',True),('stale',True),('partial',True)):
            with self.subTest(status=status):
                public=public_discovery([{'probe_id':'probe_'+'b'*32,'result':None,
                    'error_code':'pdk_discovery_incomplete','lut':{'status':status,'scan_required':scan_required,
                    'library_id':'c'*64}}],'discovery_'+'a'*32)
                self.assertEqual(public['coverage'][0]['status'],'unavailable')
                self.assertIn('no_model_candidates',{row['code'] for row in public['missing']})
                state={'intake_id':'intake_'+'d'*32,'revision':2,'discovery':public}
                action=next_actions(state)[0]
                self.assertEqual(action['operation'],'discover-pdk');self.assertFalse(action['ready'])

    def test_pending_cached_binding_overrides_old_directory_narrowing_hint(self):
        state=self.stored_combination()
        state['discovery']['search_directories']=[{'directory_id':'a'*64,
            'probe_id':state['probes'][0]['probe_id'],'label':'synthetic/models/spectre',
            'automatic_search_allowed':True}]
        actions=next_actions(state)
        self.assertTrue(all(row['operation']!='discover-pdk' for row in actions))
        self.assertFalse(next(row for row in actions if row['operation']=='prepare')['ready'])


if __name__=='__main__':unittest.main()
