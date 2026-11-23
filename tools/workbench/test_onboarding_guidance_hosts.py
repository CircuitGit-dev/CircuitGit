"""Guided host activation uses fresh synthetic captures and the real intake runtime."""
import copy
from unittest.mock import patch
import unittest

from test_onboarding_integration import _IntakeFixture


FIRST='synthetic-first-host'
SECOND='synthetic-second-host'
FIRST_SOURCE='source-'+'a'*20
SECOND_SOURCE='source-'+'b'*20
ALTERNATIVE_SOURCE='source-'+'c'*20


class GuidedHostActivationTests(_IntakeFixture):
    def setUp(self):
        super().setUp()
        self.choices={FIRST:[FIRST_SOURCE],SECOND:[SECOND_SOURCE]}
        self.capture_call.side_effect=self.capture_host
        self.activation=self.patch(patch('spiceowl.onboarding.environment.activate_observed_environment',
                                         side_effect=self.activate_host))

    def capture_host(self,target,ssh_config):
        capture=copy.deepcopy(self.capture)
        capture['public']['alias']=target
        capture['public'].pop('activation',None)
        capture['public']['setup_candidates']=[{'source_id':source,'activation_supported':True}
                                               for source in self.choices[target]]
        capture['private'].pop('activation',None)
        capture['private']['identity']['hostname']=target
        capture['private']['setup_candidates']=[{
            'source_id':source,'path':'/synthetic/tools/'+source+'.csh','sha256':'c'*64,
            'shell_kind':'csh','executed_by_probe':False} for source in self.choices[target]]
        return capture

    def activate_host(self,target,ssh_config,capture,source_id):
        self.assertIn(source_id,self.choices[target])
        activated=copy.deepcopy(capture)
        activated['public']['activation']={'selected_source_id':source_id}
        activated['private']['activation']={'selected_source_id':source_id}
        return activated

    def mixed_state(self):
        state=self.probe(self.new_source(),[FIRST,SECOND])
        # The user initially activated just the first server. A fresh raw capture
        # intentionally has no activation; the chosen setup must be carried on.
        return self.runtime.write('probe',{'intake_id':state['intake_id'],'revision':state['revision'],
            'ssh_targets':[FIRST,SECOND],'overrides':{'setup_source_ids':{FIRST:FIRST_SOURCE}}},origin='test_harness')

    def test_stepwise_driver_preserves_first_host_then_advances_to_discovery(self):
        state=self.mixed_state();self.activation.reset_mock()
        action=state['next_actions'][0]
        self.assertEqual(action['operation'],'probe');self.assertTrue(action['ready'])
        self.assertEqual(action['arguments']['overrides']['setup_source_ids'],
                         {FIRST:FIRST_SOURCE,SECOND:SECOND_SOURCE})
        state=self.runtime.write(action['operation'],action['arguments'],origin='test_harness')
        self.assertEqual({row['ssh_target']:row['environment']['activation']['selected_source_id']
                          for row in state['probes']},{FIRST:FIRST_SOURCE,SECOND:SECOND_SOURCE})
        self.assertEqual(self.activation.call_count,2)
        action=state['next_actions'][0]
        self.assertEqual(action['operation'],'discover-pdk');self.assertTrue(action['ready'])
        self.assertEqual(action['arguments']['probe_ids'],[row['probe_id'] for row in state['probes']])
        self.assertNotIn('overrides',action['arguments'])
        self.ssh.assert_not_called();self.doctor.assert_not_called()

    def test_ambiguous_second_host_keeps_first_selection_without_choosing_for_user(self):
        self.choices[SECOND]=[SECOND_SOURCE,ALTERNATIVE_SOURCE]
        state=self.mixed_state();self.activation.reset_mock()
        action=state['next_actions'][0]
        self.assertEqual(action['operation'],'probe');self.assertFalse(action['ready'])
        self.assertEqual(action['arguments']['overrides']['setup_source_ids'],{FIRST:FIRST_SOURCE})
        self.assertEqual([row['field'] for row in action['missing']],['overrides.setup_source_ids.'+SECOND])
        self.activation.assert_not_called()
        args=copy.deepcopy(action['arguments']);args['overrides']['setup_source_ids'][SECOND]=ALTERNATIVE_SOURCE
        state=self.runtime.write('probe',args,origin='test_harness')
        self.assertEqual(state['next_actions'][0]['operation'],'discover-pdk')
        self.assertEqual({row['ssh_target']:row['environment']['activation']['selected_source_id']
                          for row in state['probes']},{FIRST:FIRST_SOURCE,SECOND:ALTERNATIVE_SOURCE})
        self.ssh.assert_not_called()

    def test_missing_second_host_setup_stays_blocked_and_preserves_first_selection(self):
        self.choices[SECOND]=[]
        state=self.mixed_state();self.activation.reset_mock()
        action=state['next_actions'][0]
        self.assertEqual(action['operation'],'probe');self.assertFalse(action['ready'])
        self.assertEqual(action['arguments']['ssh_targets'],[FIRST,SECOND])
        self.assertEqual(action['arguments']['overrides']['setup_source_ids'],{FIRST:FIRST_SOURCE})
        self.assertEqual([row['field'] for row in action['missing']],['overrides.setup_source_ids.'+SECOND])
        self.activation.assert_not_called();self.ssh.assert_not_called();self.doctor.assert_not_called()


if __name__=='__main__':unittest.main()
