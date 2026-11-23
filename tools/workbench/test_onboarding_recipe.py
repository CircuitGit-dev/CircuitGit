"""Synthetic intent compilation; no model files, network, legacy state or Git."""
import copy
import hashlib
import json
import unittest
from unittest.mock import patch

try:
    from onboarding_recipe import build_intake_recipe
    from spiceowl.onboarding.pdk_discovery import inspect_netlist
except ImportError:
    build_intake_recipe = None

SOURCE_ID = 'projects/intake_synthetic/input.scs'
FLAT = ('// Authored two-device fixture.\n'
        'A (OUT IN LO LO) device_alpha w=2u l=200n nf=1 multi=1 \\\n'
        '    synthetic_param=7\n'
        'B (OUT IN HI HI) device_beta w=3u l=200n nf=1 multi=1\n')


def intent():
    return {'supply_v': .9, 'frequency_hz': 1e9, 'temperature_c': 27,
            'input_port': 'IN', 'output_port': 'OUT', 'vdd_port': 'HI', 'vss_port': 'LO',
            'cycles': 5, 'load_f': 2e-15, 'rise_s': 1e-11, 'fall_s': 1e-11, 'points_per_period': 1000}


def models():
    return [{'name': 'device_alpha', 'confidence': 'verified', 'needs_confirmation': False,
             'polarity': 'n', 'ordered_terminal_roles': ['d', 'g', 's', 'b']},
            {'name': 'device_beta', 'confidence': 'verified', 'needs_confirmation': False,
             'polarity': 'p', 'ordered_terminal_roles': ['d', 'g', 's', 'b']}]


@unittest.skipIf(build_intake_recipe is None, 'Requires the current pinned SpiceOwl onboarding compiler')
class IntakeRecipeTests(unittest.TestCase):
    def build(self, source=FLAT, **changes):
        args = {'source_text': source, 'requirements': inspect_netlist(source, source_id='new-user-file.scs'),
            'candidate_models': models(), 'selected_sections': ['ObservedCorner'], 'intent': intent(),
            'source_id': SOURCE_ID, 'candidate_sections': ['ObservedCorner'], 'nominal_temperature_c': 27}
        args.update(changes)
        return build_intake_recipe(**args)

    def test_full_explicit_intent_deterministically_derives_the_reviewable_spec(self):
        first, second = self.build(), self.build()
        self.assertEqual(first['status'], 'ready', first['missing'])
        self.assertEqual(first, second)
        spec = first['spec']; pulse = spec['stimuli'][0]
        self.assertEqual(spec['supply'], {'positive_v': .9, 'negative_v': 0})
        self.assertEqual(spec['temperature_k'], 300.15)
        self.assertEqual(spec['corner'], 'selected')
        self.assertEqual(pulse['period_s'], 1e-9)
        self.assertAlmostEqual(pulse['delay_s'] / pulse['period_s'], .1, places=14)
        self.assertAlmostEqual(pulse['width_s'] / pulse['period_s'], .49, places=14)
        self.assertEqual(spec['acceptance']['sample_count'], 5001)
        self.assertEqual(len(spec['acceptance']['logic']['windows']), 10)
        self.assertEqual(spec['acceptance']['logic']['windows'][0]['minimum_samples'], 201)
        self.assertEqual(first['electrical']['corners']['selected'], [{'alias': 'PDK_MAIN', 'section': 'ObservedCorner'}])
        self.assertIsNone(first['provenance']['source_commit'])
        self.assertFalse(first['ready_to_run'])

    def test_flat_wrapper_is_a_declared_insertion_preserving_all_original_bytes(self):
        for source in (FLAT, FLAT.replace('\n', '\r\n'), FLAT.rstrip('\n')):
            with self.subTest(ending=repr(source[-2:])):
                result = self.build(source)
                self.assertEqual(result['status'], 'ready', result['missing'])
                original = source.encode(); rebuilt = bytearray(); cursor = 0
                for insertion in result['wrapper']['insertions']:
                    at = insertion['original_byte_offset']; rebuilt += original[cursor:at]
                    rebuilt += insertion['text'].encode(); cursor = at
                rebuilt += original[cursor:]
                self.assertEqual(bytes(rebuilt), result['source']['text'].encode())
                self.assertEqual(result['source']['original_sha256'], hashlib.sha256(original).hexdigest())
                self.assertTrue(result['wrapper']['added'])
                self.assertEqual(result['wrapper']['transformation'], 'added_explicit_subcircuit_wrapper')
                self.assertIn('synthetic_param=7', result['source']['text'])

    def test_existing_single_subcircuit_is_retained_without_claiming_a_new_wrapper(self):
        source = 'simulator lang=spectre\nsubckt Existing HI LO IN OUT\n' + FLAT + 'ends Existing\n'
        result = self.build(source)
        self.assertEqual(result['status'], 'ready', result['missing'])
        self.assertEqual(result['source']['text'], source)
        self.assertFalse(result['wrapper']['added'])
        self.assertEqual(result['selection'], {'mode': 'cell', 'source_id': SOURCE_ID, 'subcircuit': 'Existing'})
        self.assertEqual(result['source']['sha256'], result['source']['original_sha256'])

    def test_flat_spectre_headers_stay_outside_inserted_wrapper(self):
        result = self.build('simulator lang=spectre\nglobal 0\n' + FLAT)
        self.assertEqual(result['status'], 'ready', result['missing'])
        self.assertTrue(result['source']['text'].startswith('simulator lang=spectre\nglobal 0\n'))

    def test_missing_basic_intent_never_uses_hidden_defaults(self):
        for field in intent():
            changed = intent(); changed.pop(field)
            with self.subTest(field=field):
                result = self.build(intent=changed)
                self.assertEqual(result['status'], 'missing')
                self.assertIn('intent.' + field, {row['field'] for row in result['missing']})
                self.assertIsNone(result['spec'])

    def test_nominal_temperature_is_explicit_and_independent_of_operating_temperature(self):
        result = self.build(nominal_temperature_c=None)
        self.assertEqual(result['status'], 'missing')
        self.assertIn('nominal_temperature_missing', {r['code'] for r in result['missing']})
        changed = intent(); changed['temperature_c'] = 85
        result = self.build(intent=changed, nominal_temperature_c=27)
        self.assertEqual(result['status'], 'ready', result['missing'])
        self.assertEqual(result['spec']['temperature_k'], 358.15)
        self.assertEqual(result['spec']['nominal_temperature_k'], 300.15)
        changed['nominal_temperature_c'] = 22
        result = self.build(intent=changed, nominal_temperature_c=None)
        self.assertEqual(result['status'], 'ready', result['missing'])
        self.assertEqual(result['spec']['nominal_temperature_k'], 295.15)
        result = self.build(intent=changed, nominal_temperature_c=27)
        self.assertEqual(result['status'], 'missing')
        self.assertIn('nominal_temperature_conflict', {r['code'] for r in result['missing']})

    def test_transition_windows_and_sampling_limits_cannot_be_silently_relaxed(self):
        cases = [('rise_s', .2e-9), ('fall_s', .2e-9), ('points_per_period', 2),
                 ('points_per_period', 100000), ('cycles', 100), ('frequency_hz', 0),
                 ('supply_v', float('nan')), ('load_f', True), ('input_port', 'OUT')]
        for field, value in cases:
            changed = intent(); changed[field] = value
            with self.subTest(field=field, value=value):
                result = self.build(intent=changed)
                self.assertEqual(result['status'], 'missing')
                json.dumps(result, allow_nan=False)
        changed = intent(); changed['rise_s'] = .2e-9
        result = self.build(intent=changed)
        self.assertIn('stimulus_window_mismatch', {r['code'] for r in result['missing']})
        self.assertEqual(result['spec']['stimuli'][0]['rise_s'], .2e-9)

    def test_requirements_are_recomputed_from_the_exact_new_source(self):
        requirements = inspect_netlist(FLAT, source_id='display.scs')
        wrong = copy.deepcopy(requirements); wrong['source_sha256'] = 'f' * 64
        changed = copy.deepcopy(requirements); changed['instances'][0]['master'] = 'different'
        for supplied in (wrong, changed):
            result = self.build(requirements=supplied)
            self.assertEqual(result['missing'][0]['code'], 'source_requirements_mismatch')

    def test_candidate_contracts_require_verified_exact_selected_scope(self):
        for change in ({'candidate_sections': None}, {'selected_sections': ['OtherCorner']},
                       {'candidate_models': models()[:1]}):
            result = self.build(**change)
            self.assertEqual(result['status'], 'missing')
            self.assertIn('model_semantics_unconfirmed', {r['code'] for r in result['missing']})
        for field, value in (('confidence', 'suggested'), ('needs_confirmation', True)):
            changed = models(); changed[0][field] = value
            self.assertEqual(self.build(candidate_models=changed)['status'], 'missing')

    def test_explicit_contracts_cover_changed_scope_without_reusing_old_semantics(self):
        explicit = {row['name']: {'polarity': row['polarity'], 'terminals': row['ordered_terminal_roles']} for row in models()}
        result = self.build(selected_sections=['OtherCorner'], explicit_model_contracts=explicit)
        self.assertEqual(result['status'], 'ready', result['missing'])
        self.assertTrue(all(row['basis'] == 'explicit_intake_contract' and row['candidate_scope_matches'] is False
                            for row in result['provenance']['model_contracts'].values()))
        explicit.pop('device_alpha')
        self.assertEqual(self.build(selected_sections=['OtherCorner'], explicit_model_contracts=explicit)['status'], 'missing')

    def test_explicit_contract_requires_bijective_four_terminal_roles(self):
        for contract in ({'polarity': 'n', 'terminals': ['d', 'g', 's', 's']},
                         {'polarity': 'n', 'terminals': ['d', 'g', 's']},
                         {'polarity': 'unknown', 'terminals': ['d', 'g', 's', 'b']},
                         {'polarity': 'n', 'terminals': ['d', 'g', 's', 'b'], 'trusted': True}):
            result = self.build(explicit_model_contracts={'device_alpha': contract})
            self.assertEqual(result['status'], 'missing')

    def test_section_order_is_preserved_and_global_scope_is_explicit(self):
        result = self.build(candidate_sections=['First', 'Second'], selected_sections=['Second', 'First'])
        self.assertEqual(result['status'], 'ready', result['missing'])
        self.assertEqual([r['section'] for r in result['electrical']['corners']['selected']], ['Second', 'First'])
        result = self.build(candidate_sections=[None], selected_sections=[None])
        self.assertEqual(result['status'], 'ready', result['missing'])
        for sections in ([], ['First', 'First'], ['Bad;command']):
            self.assertEqual(self.build(selected_sections=sections)['status'], 'missing')

    def test_unsupported_spice_is_reported_without_source_rewriting(self):
        source = 'M1 OUT IN LO LO device_alpha W=2u L=200n\nM2 OUT IN HI HI device_beta W=3u L=200n\n'
        self.assertEqual(self.build(source)['status'], 'missing')

    def test_omitted_multiplicity_is_retained_and_explicit_invalid_values_are_rejected(self):
        for removed in (('nf',), ('multi',), ('nf', 'multi')):
            source = FLAT
            for name in removed:
                source = source.replace(' ' + name + '=1', '')
            result = self.build(source)
            self.assertEqual(result['status'], 'ready', result['missing'])
            for name in removed:
                self.assertNotIn(name + '=', result['source']['text'])
            self.assertIn(source.split('\n', 1)[1], result['source']['text'])
        for name, value in (('nf', '0'), ('nf', '-1'), ('nf', '1.5'), ('multi', '0'), ('multi', '-2')):
            result = self.build(FLAT.replace(name + '=1', name + '=' + value))
            self.assertEqual(result['status'], 'missing')
            self.assertIn('invalid_mos_multiplicity', {r['code'] for r in result['missing']})

    def test_dimensions_remain_explicit(self):
        for removed in (' w=2u', ' l=200n'):
            result = self.build(FLAT.replace(removed, ''))
            self.assertEqual(result['status'], 'missing')
            self.assertIn('mos_dimensions_missing', {r['code'] for r in result['missing']})

    def test_no_filesystem_subprocess_or_model_calls_and_no_argument_mutation(self):
        requirements = inspect_netlist(FLAT)
        evidence, conditions = models(), intent()
        originals = copy.deepcopy((requirements, evidence, conditions))
        with (patch('builtins.open', side_effect=AssertionError('IO')),
              patch('subprocess.run', side_effect=AssertionError('execution'))):
            result = build_intake_recipe(FLAT, requirements, evidence, ['ObservedCorner'], conditions,
                source_id=SOURCE_ID, candidate_sections=['ObservedCorner'], nominal_temperature_c=27)
        self.assertEqual(result['status'], 'ready', result['missing'])
        self.assertEqual((requirements, evidence, conditions), originals)


if __name__ == '__main__':
    unittest.main()
