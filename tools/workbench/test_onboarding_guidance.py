"""Offline finite-step guidance and recommendation acceptance boundaries."""
import copy
import unittest

from onboarding_guidance import next_actions
from onboarding_recommendations import resolve_preparation, public_evidence
from workspace import Conflict


def snapshot():
    recommendation = {'schema':'ic.onboarding.recommended-selection.v1','recommendation_id':'a'*64,
        'recommendation_revision':3,'source_sha256':'b'*64,'discovery_id':'discovery_new',
        'candidate_id':'c'*64,'sections':['pre_simu','Typical'],'tmi_candidate_id':None,
        'model_contracts':{'left':{'polarity':'n','terminals':['d','g','s','b']}},
        'intent':{'supply_v':.9,'load_f':2e-15},'ready_for_prepare':True,'missing':[]}
    return {'intake_id':'intake_'+'1'*32,'connection_id':'2'*32,'revision':3,
        'source_sha256':'b'*64,'state':'models_discovered','plans':[],
        'discovery':{'discovery_id':'discovery_new','candidates':[], 'recommended_selection':recommendation},
        'recommended_selection':recommendation}


class GuidanceTests(unittest.TestCase):
    def test_default_prepare_uses_frozen_recommendation_and_field_overrides(self):
        state=snapshot();args={'intake_id':state['intake_id'],'revision':3,'intent':{'load_f':4e-15}}
        resolved,gaps,source=resolve_preparation(state,args)
        self.assertEqual(gaps,[])
        self.assertEqual(resolved['intent'],{'supply_v':.9,'load_f':4e-15})
        self.assertEqual(source['mode'],'recommendation_default')
        self.assertEqual(source['overrides'],['intent.load_f'])
        self.assertEqual(state['recommended_selection']['intent']['load_f'],2e-15)
        self.assertEqual(resolved['sections'],['pre_simu','Typical'])

    def test_recommendation_revision_is_distinct_from_current_revision(self):
        state=snapshot();state['revision']=8
        action=next_actions(state)[0]
        self.assertEqual(action['arguments']['revision'],8)
        self.assertEqual(action['arguments']['recommendation_revision'],3)
        self.assertEqual(action['tool'],'ic_onboarding_prepare')
        self.assertEqual(resolve_preparation(state,action['arguments'])[1],[])
        for update in ({'recommendation_id':'d'*64},{'recommendation_revision':8},
                       {'recommendation_revision':True}):
            with self.subTest(update=update),self.assertRaises(Conflict):
                resolve_preparation(state,{**action['arguments'],**update})

    def test_incomplete_or_over_limit_suggestion_requires_matching_override(self):
        state=snapshot();state['recommended_selection']['missing']=[
            {'field':'supply_v','code':'supply_exceeds_declared_limit','message':'Explicit voltage choice needed.'}]
        args={'intake_id':state['intake_id'],'revision':3}
        self.assertEqual(resolve_preparation(state,args)[1][0]['code'],'supply_exceeds_declared_limit')
        self.assertTrue(resolve_preparation(state,{**args,'intent':{'load_f':3e-15}})[1])
        self.assertFalse(resolve_preparation(state,{**args,'intent':{'supply_v':.7}})[1])
        self.assertFalse(next_actions(state)[0]['ready'])

    def test_full_explicit_selection_remains_supported_without_recommendation(self):
        state=snapshot();choice=copy.deepcopy(state['recommended_selection'])
        state['recommended_selection']=None;state['discovery']['recommended_selection']=None
        fields=('discovery_id','candidate_id','sections','tmi_candidate_id','model_contracts','intent')
        args={'intake_id':state['intake_id'],'revision':3,**{k:choice[k] for k in fields}}
        self.assertEqual(resolve_preparation(state,args)[2]['mode'],'explicit_selection')
        with self.assertRaises(ValueError):
            resolve_preparation(state,{'intake_id':state['intake_id'],'revision':3,'accept_recommendation':False})

    def test_complete_port_override_resolves_grouped_port_suggestion_gap(self):
        state=snapshot();state['recommended_selection']['missing']=[
            {'field':'intent.ports','code':'port_role_ambiguous','message':'Explicit port roles needed.'}]
        args={'intake_id':state['intake_id'],'revision':3}
        ports={'input_port':'A','output_port':'Y','vdd_port':'P','vss_port':'N'}
        self.assertFalse(resolve_preparation(state,{**args,'intent':ports})[1])
        self.assertTrue(resolve_preparation(state,{**args,'intent':{'input_port':'A'}})[1])

    def test_unknown_submission_only_offers_original_key_lookup(self):
        state=snapshot();state['plans']=[{'plan_id':'d'*64,'dispatch_outcome':'unknown'}]
        actions=next_actions(state)
        self.assertEqual([a['tool'] for a in actions],['ic_onboarding_submission'])
        self.assertEqual(actions[0]['arguments'],{'intake_id':state['intake_id'],'plan_id':'d'*64})
        self.assertEqual(actions[0]['kind'],'read')

    def test_job_guidance_keeps_original_identity_and_never_relaunches(self):
        state=snapshot();state['job']={'job_id':'original-job','inspection_state':'working'}
        action=next_actions(state)[0]
        self.assertEqual(action['tool'],'ic_onboarding_inspect')
        self.assertEqual(action['arguments']['job_id'],'original-job')
        state['job'].update(inspection_state='complete',waveforms={'available':True})
        self.assertEqual([a['tool'] for a in next_actions(state)],
                         ['ic_onboarding_waveforms_catalog','ic_onboarding_waveforms_mapping'])
        state['job']['inspection_state']='uncertain'
        self.assertEqual([a['tool'] for a in next_actions(state)],['ic_onboarding_session'])

    def test_prepare_and_run_do_not_become_enabled_from_error_text(self):
        state=snapshot();state['prepared']={'state':'prepared','plan_id':'d'*64}
        state['plans']=[{'plan_id':'d'*64,'dispatch_outcome':'recorded'}]
        self.assertEqual(next_actions(state)[0]['operation'],'submission')
        state['plans'][0]['dispatch_outcome']='pre_dispatch_rejected'
        self.assertEqual(next_actions(state)[0]['operation'],'prepare')
        self.assertFalse(next_actions(state)[0]['ready'])

    def test_inflight_revision_offers_reads_instead_of_a_second_mutation(self):
        state=snapshot()
        for phase in ('probe','discover-pdk','prepare','submitting'):
            state['state']=phase
            with self.subTest(phase=phase):
                actions=next_actions(state)
                self.assertEqual([a['tool'] for a in actions],['ic_onboarding_session'])
                self.assertEqual(actions[0]['kind'],'read')

    def test_public_recommendation_evidence_excludes_paths_and_source_bodies(self):
        value={'path':'/private/source','source_path':'/private/secret','source_text':'restricted body',
               'rows':[{'from':'/private/entry','line':12,'code':'observed_include'}]}
        self.assertEqual(public_evidence(value),{'rows':[{'line':12,'code':'observed_include'}]})


if __name__=='__main__':unittest.main()
