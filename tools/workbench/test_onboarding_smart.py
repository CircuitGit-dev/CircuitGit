"""No-LLM recommendation workflow over the real isolated intake implementation."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import experiment_workflow
from test_onboarding_integration import _IntakeFixture, SECRET
from workspace import Conflict


class SmartOnboardingTests(_IntakeFixture):
    def recommended(self):
        state=self.discover()
        choice=state['recommended_selection']
        self.assertIsNotNone(choice,state['discovery'].get('recommendation_missing'))
        self.assertTrue(choice['ready_for_prepare'],choice['missing'])
        self.assertEqual(state['next_actions'][0]['tool'],'ic_onboarding_prepare')
        return state

    def prepare_recommended(self,state,**overrides):
        args={**state['next_actions'][0]['arguments'],**overrides}
        with patch.object(experiment_workflow.ExperimentWorkflow,'_audit',side_effect=self.local_audit) as audit:
            result=self.runtime.write('prepare',args,origin='test_harness')
        self.assertEqual(result['state'],'prepared',result.get('prepared'))
        audit.assert_called_once()
        return result

    def test_no_llm_driver_can_prepare_submit_once_and_inspect_original_job(self):
        state=self.recommended();chosen=copy.deepcopy(state['recommended_selection'])
        prepared=self.prepare_recommended(state)
        for field in ('discovery_id','candidate_id','sections','tmi_candidate_id','model_contracts','intent'):
            self.assertEqual(prepared['selection'][field],chosen[field])
        self.assertEqual(prepared['recommended_selection']['recommendation_revision'],state['revision'])
        self.assertEqual(prepared['input_provenance'][-1]['recommendation']['mode'],'recommendation_default')
        self.assertIsNone(prepared['input_provenance'][-1]['explicit_model_contracts'])
        self.assertIsNotNone(prepared['source_commit'])
        self.enable_reservation(prepared)
        call=prepared['next_actions'][0]
        self.assertEqual(call['tool'],'ic_onboarding_run')
        submitted=self.runtime.write(call['operation'],call['arguments'],origin='test_harness')
        inspected=self.runtime.write(submitted['next_actions'][0]['operation'],
            submitted['next_actions'][0]['arguments'],origin='test_harness')
        self.assertEqual(inspected['job']['job_id'],submitted['job']['job_id'])
        self.assertEqual(inspected['job']['inspection_state'],'working')
        repeated=self.runtime.write(call['operation'],call['arguments'],origin='test_harness')
        self.assertEqual(repeated['job']['job_id'],submitted['job']['job_id'])
        self.reserve.assert_called_once();self.dispatch.assert_not_called();self.ssh.assert_not_called()

    def test_partial_override_is_echoed_and_unchanged_defaults_remain_bound(self):
        state=self.recommended();prepared=self.prepare_recommended(state,intent={'load_f':4e-15})
        self.assertEqual(prepared['selection']['intent']['load_f'],4e-15)
        self.assertEqual(prepared['selection']['intent']['supply_v'],state['recommended_selection']['intent']['supply_v'])
        provenance=prepared['input_provenance'][-1]['recommendation']
        self.assertEqual(provenance['overrides'],['intent.load_f'])
        self.assertEqual(provenance['recommendation_id'],state['recommended_selection']['recommendation_id'])

    def test_full_legacy_selection_echoes_effective_inferred_model_contracts(self):
        prepared=self.prepare()
        self.assertEqual(prepared['input_provenance'][-1]['explicit_model_contracts'],{})
        self.assertEqual(prepared['selection']['model_contracts'],{
            'device_alpha':{'polarity':'n','terminals':['d','g','s','b']},
            'device_beta':{'polarity':'p','terminals':['d','g','s','b']}})

    def test_a_new_discovery_invalidates_displayed_recommendation_before_any_prepare(self):
        state=self.recommended();old=state['next_actions'][0]['arguments']
        changed=self.discover(state)
        self.assertNotEqual(changed['recommended_selection']['recommendation_id'],state['recommended_selection']['recommendation_id'])
        with patch('onboarding_prepare.create_child_config') as create,self.assertRaises(Conflict):
            self.runtime.write('prepare',{**old,'revision':changed['revision']},origin='test_harness')
        create.assert_not_called()
        self.assertEqual(self.runtime.read('session',{'intake_id':state['intake_id']})['revision'],changed['revision'])

    def test_unknown_outcome_guidance_never_creates_another_run(self):
        prepared=self.prepare_recommended(self.recommended());self.enable_reservation(prepared)
        child=self.child_for(prepared)
        with patch.object(child.simulation,'control',side_effect=TimeoutError('synthetic lost reply')):
            with self.assertRaises(TimeoutError):self.submit_intake(prepared)
        restored=self.runtime.read('session',{'intake_id':prepared['intake_id']})
        self.assertEqual([row['tool'] for row in restored['next_actions']],['ic_onboarding_submission'])
        self.assertEqual(restored['next_actions'][0]['arguments']['plan_id'],prepared['prepared']['plan_id'])
        self.reserve.assert_not_called();self.dispatch.assert_not_called()


def write_smart_examples(path):
    fixture=SmartOnboardingTests()
    try:
        fixture.setUp()
        netlist=fixture.new_source();probe=fixture.probe(netlist);discovery=fixture.discover(probe)
        prepared=fixture.prepare_recommended(discovery);fixture.enable_reservation(prepared)
        action=prepared['next_actions'][0]
        submitted=fixture.runtime.write(action['operation'],action['arguments'],origin='test_harness')
        action=submitted['next_actions'][0]
        inspected=fixture.runtime.write(action['operation'],action['arguments'],origin='test_harness')
        payload={'schema':'ic.onboarding.smart-examples.v1','synthetic':True,
            'producer':'tools/workbench/test_onboarding_smart.py --write-examples',
            'evidence':{'runtime':'actual Application, recommendation projection, compiler, Workspace and Runner reservation',
                'model_and_source':'original synthetic fixtures', 'discovery_transport':'mocked; real local scanner output',
                'prepare_inputs':'only intake/revision and current recommendation ID/revision',
                'llm_calls':0,'ssh_calls':0,'solver_invocations':0,'dispatch':'deferred fixture callback'},
            'snapshots':{'netlist':netlist,'probe':probe,'discover':discovery,'prepare':prepared,'run':submitted,'inspect':inspected}}
        raw=json.dumps(payload,ensure_ascii=False,indent=2,allow_nan=False)+'\n'
        fixture.assertNotIn(str(fixture.root),raw);fixture.assertNotIn(SECRET,raw)
    finally:fixture.doCleanups()
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(raw);return path


if __name__=='__main__':
    if sys.argv[1:]==['--write-examples']:
        print(write_smart_examples(Path(__file__).resolve().parents[2]/'docs/contracts/onboarding-smart.example.json'))
    else:unittest.main()
