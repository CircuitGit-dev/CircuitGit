"""Automatic discovery advances through bounded scopes, never rotating IDs."""
import copy
import unittest
from unittest.mock import patch

from onboarding_discovery import MAX_AUTOMATIC_SEARCH_ROUNDS
from test_onboarding_integration import _IntakeFixture


class SearchGuidanceTests(_IntakeFixture):
    def snapshot(self, roots, paths):
        return {'roots':roots,'entry_candidates':[],'files':[],
            'directory_suggestions':[{'path':path,'basis':['model_directory_name_hint'],
                                     'scanned':True} for path in paths],
            'search_complete':False,'status':'incomplete','phase':'directory_inventory',
            'transport':{'exit_code':124,'completion':'timeout_directory_snapshot'}}

    def scan(self, state, evidence, **extra):
        with patch('onboarding_discovery.remote_discovery',return_value=evidence) as remote:
            result=self.runtime.write('discover-pdk',{'intake_id':state['intake_id'],
                'revision':state['revision'],'probe_ids':[p['probe_id'] for p in state['probes']],
                **extra},origin='test_harness')
        remote.assert_called_once()
        return result

    def test_same_root_stays_blocked_across_new_discovery_ids_and_reload(self):
        state=self.probe(self.new_source())
        evidence=self.snapshot(['/synthetic/spectre'],['/synthetic/spectre/.'])
        first=self.scan(state,evidence,search_paths=['/synthetic/spectre'])
        second=self.scan(first,evidence,search_paths=['/synthetic/spectre/.'])
        left=first['discovery']['search_directories'][0]
        right=second['discovery']['search_directories'][0]
        self.assertNotEqual(left['directory_id'],right['directory_id'])
        self.assertEqual(left['search_scope_id'],right['search_scope_id'])
        self.assertTrue(right['search_attempted'])
        self.assertEqual(right['automatic_search_blocked_reason'],'already_searched_scope')
        for result in (first,second,self.runtime.read('session',{'intake_id':second['intake_id']})):
            self.assertFalse(result['next_actions'][0]['ready'])
            self.assertEqual(result['next_actions'][0]['reason_code'],'automatic_search_requires_input')
            self.assertNotIn('discovery_search_history',result)

    def test_narrower_scanned_child_runs_once_and_cannot_return_to_parent(self):
        state=self.probe(self.new_source())
        parent='/synthetic/models';child=parent+'/spectre'
        first=self.scan(state,self.snapshot([parent],[parent,child]),search_paths=[parent])
        call=first['next_actions'][0]
        self.assertTrue(call['ready'])
        with patch('onboarding_discovery.remote_discovery',return_value=self.snapshot([child],[child,parent])) as remote:
            second=self.runtime.write(call['operation'],call['arguments'],origin='test_harness')
        self.assertEqual(remote.call_args.args[4],[child])
        self.assertFalse(second['next_actions'][0]['ready'])
        self.assertTrue(all(row['search_attempted'] for row in second['discovery']['search_directories']))
        self.ssh.assert_not_called()

    def test_fresh_directory_names_cannot_exceed_persisted_round_budget(self):
        state=self.probe(self.new_source())
        root='/synthetic/spectre'
        first_evidence=self.snapshot([root],[root+'/next'])
        state=self.scan(state,first_evidence,search_paths=[root])
        for index in range(1,MAX_AUTOMATIC_SEARCH_ROUNDS):
            call=state['next_actions'][0]
            self.assertTrue(call['ready'],index)
            root+='/next'
            with patch('onboarding_discovery.remote_discovery',return_value=self.snapshot([root],[root+'/next'])):
                state=self.runtime.write(call['operation'],call['arguments'],origin='test_harness')
        state=self.runtime.read('session',{'intake_id':state['intake_id']})
        self.assertEqual(state['discovery']['automatic_search']['rounds_completed'],MAX_AUTOMATIC_SEARCH_ROUNDS)
        self.assertFalse(state['next_actions'][0]['ready'])
        self.assertEqual(state['discovery']['search_directories'][0]['automatic_search_blocked_reason'],'search_round_limit')

    def test_model_file_basis_is_membership_and_not_string_equality(self):
        state=self.probe(self.new_source());root='/synthetic/pdk'
        evidence=self.snapshot([root],[root+'/spectre-a',root+'/spectre-z'])
        evidence['directory_suggestions'][1]['basis'].append('contains_candidate_model_files')
        state=self.scan(state,evidence,search_paths=[root])
        selected=state['next_actions'][0]['arguments']['search_directory_ids'][0]
        row=next(row for row in state['discovery']['search_directories'] if row['directory_id']==selected)
        self.assertTrue(row['label'].endswith('spectre-z'))

    def test_new_probe_invalidates_previous_search_scope_history(self):
        state=self.probe(self.new_source());root='/synthetic/spectre'
        evidence=self.snapshot([root],[root+'/next'])
        first=self.scan(state,evidence,search_paths=[root])
        refreshed=self.probe(first)
        self.assertNotIn('discovery_search_history',self.runtime._load(refreshed['intake_id']))
        second=self.scan(refreshed,copy.deepcopy(evidence),search_paths=[root])
        self.assertEqual(second['discovery']['automatic_search']['rounds_completed'],1)
        self.assertNotEqual(first['discovery']['search_directories'][0]['search_scope_id'],
                            second['discovery']['search_directories'][0]['search_scope_id'])


if __name__=='__main__':unittest.main()
