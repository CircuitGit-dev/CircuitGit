"""Public TMI identities preserve observed ABI evidence without mutating drafts."""
import copy
import unittest

from onboarding_discovery import digest
from onboarding_recommendations import _project_choice


def field(value, confidence='preset', basis=None, missing=None):
    return {'value': value, 'confidence': confidence,
            'basis': basis or [], 'missing': missing or [], 'requires_acceptance': True}


def projection_inputs(relative='RH_64/libTMImodel.so', *, observed_tmi=True):
    raw = {'candidate_id': 'a' * 64}
    platform_id = digest({'candidate_id': raw['candidate_id'],
                          'relative_library': 'RH_64/libTMImodel.so'})
    candidate = {'candidate_id': 'b' * 64,
                 'tmi_candidates': [{'tmi_candidate_id': platform_id}] if observed_tmi else []}
    platform = {'system': 'Linux', 'machine': 'x86_64',
                'os_release': {'id': 'centos', 'id_like': ['rhel']},
                'basis': {'system': 'remote_uname', 'machine': 'remote_uname',
                          'os_release': 'remote_os_release'}, 'os_release_status': 'observed'}
    basis = [{'code': 'remote_platform_abi_candidate', 'kind': 'inference',
              'platform': platform if relative else None,
              'observed_matches': [relative] if relative else [],
              'runtime_compatibility_verified': False}] if observed_tmi else [
                  {'code': 'no_tmi_reference_in_observed_closure', 'kind': 'observation'}]
    missing = [{'field': 'tmi_relative_library', 'code': 'tmi_platform_unknown',
                'message': 'Remote platform is unknown.'}] if observed_tmi and relative is None else []
    tmi = field(relative, 'inferred' if relative else 'unknown' if observed_tmi else 'observed',
                basis, missing)
    if observed_tmi:
        tmi['runtime_validation_required'] = True
    intent = {'supply_v': .9, 'frequency_hz': 1e9, 'temperature_c': 27,
              'nominal_temperature_c': 27, 'cycles': 5, 'load_f': 2e-15,
              'rise_s': 1e-11, 'fall_s': 1e-11, 'points_per_period': 1000,
              'input_port': 'IN', 'output_port': 'OUT', 'vdd_port': 'HI', 'vss_port': 'LO'}
    proposal = {'sections': field(['typical'], 'inferred'),
                'tmi_relative_library': tmi,
                'model_contracts': {'device': field({'polarity': 'n',
                    'terminals': ['d', 'g', 's', 'b']}, 'observed')},
                'intent': {'preset': 'inverter_smoke',
                           'fields': {name: field(value) for name, value in intent.items()},
                           'missing': []}, 'missing': [], 'rank_basis': []}
    state = {'revision': 3, 'source_sha256': 'c' * 64,
             'source': {'requirements': {'required_masters': ['device']}}}
    return raw, proposal, candidate, state, 'discovery_synthetic'


class RecommendationProjectionTests(unittest.TestCase):
    def project(self, *args, **kwargs):
        inputs = projection_inputs(*args, **kwargs)
        original = copy.deepcopy(inputs)
        choice = _project_choice(*inputs)
        self.assertEqual(inputs, original, 'Projection must not mutate source suggestions')
        self.assertEqual(choice['recommendation_id'], digest(
            {key: value for key, value in choice.items() if key != 'recommendation_id'}))
        self.assertFalse(choice['ready_to_run'])
        self.assertTrue(choice['requires_acceptance'])
        return choice, inputs[1]['tmi_relative_library']

    def test_tmi_field_uses_public_id_and_preserves_remote_platform_basis(self):
        choice, original = self.project()
        projected = choice['provenance']['fields']['tmi_candidate_id']
        self.assertEqual(projected['value'], choice['tmi_candidate_id'])
        self.assertRegex(projected['value'], r'^[0-9a-f]{64}$')
        self.assertNotEqual(projected['value'], original['value'])
        self.assertEqual(projected['basis'], original['basis'])
        self.assertEqual(projected['confidence'], 'inferred')
        self.assertTrue(projected['runtime_validation_required'])
        self.assertTrue(choice['ready_for_prepare'])
        projected['basis'][0]['observed_matches'].append('changed')
        self.assertEqual(original['basis'][0]['observed_matches'], ['RH_64/libTMImodel.so'])

    def test_unknown_remote_platform_keeps_null_with_missing_conditions(self):
        choice, original = self.project(None)
        projected = choice['provenance']['fields']['tmi_candidate_id']
        self.assertIsNone(choice['tmi_candidate_id'])
        self.assertIsNone(projected['value'])
        self.assertEqual(projected['confidence'], 'unknown')
        self.assertEqual(projected['basis'], original['basis'])
        self.assertEqual(projected['missing'], original['missing'])
        self.assertFalse(choice['ready_for_prepare'])
        self.assertIn('tmi_selection_missing', {row['code'] for row in choice['missing']})

    def test_no_observed_tmi_reference_keeps_observed_null_without_inventing_a_gap(self):
        choice, original = self.project(None, observed_tmi=False)
        projected = choice['provenance']['fields']['tmi_candidate_id']
        self.assertIsNone(choice['tmi_candidate_id'])
        self.assertEqual(projected, original)
        self.assertEqual(projected['confidence'], 'observed')
        self.assertEqual(choice['missing'], [])
        self.assertTrue(choice['ready_for_prepare'])


if __name__ == '__main__':
    unittest.main()
