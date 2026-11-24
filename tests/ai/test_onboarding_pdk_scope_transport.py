"""Cached PDK scope boundaries; synthetic transport, no PDK or network IO."""
import copy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'modules/gateway_client'), str(ROOT/'tools/workbench')]
from ic_gateway.contracts import SCHEMAS
from ic_gateway.service import Service, Failure, validate, check_pdk_scope_response
from remote_node import GatewayOnboarding

CONNECTION = 'a'*32
IDENTITY = {'intake_id': 'intake_'+'b'*32, 'probe_id': 'probe_'+'c'*32, 'library_id': 'd'*64}
ENTRY, SECTION, SELECTION, SOURCE = 'e'*64, 'f'*64, '0'*64, '1'*64
SAVE = {**IDENTITY, 'revision': 3, 'entry_id': ENTRY, 'section_ids': [SECTION]}


def catalog():
    return {'schema': 'ic.onboarding.pdk-scopes.v1', 'connection_id': CONNECTION,
        'intake_id': IDENTITY['intake_id'], 'probe_id': IDENTITY['probe_id'], 'revision': 3,
        'catalog': {'schema': 'spiceowl.pdk-scope-catalog.v1', 'library_id': IDENTITY['library_id'],
            'entry_id': None, 'kind': 'entries', 'items': [{'entry_id': ENTRY, 'label': 'synthetic.scs',
                'entry_sha256': '2'*64, 'section_count': 1}],
            'total': 1, 'next_offset': None, 'status': 'available', 'missing': [],
            'library_complete_within_policy': False, 'ready_to_run': False}}


def selection():
    return {'schema': 'ic.onboarding.session.v1', 'connection_id': CONNECTION,
        'intake_id': IDENTITY['intake_id'], 'revision': 4, 'source_sha256': SOURCE,
        'pdk_scope_selection': {'selection_id': SELECTION, 'probe_id': IDENTITY['probe_id'],
            'library_id': IDENTITY['library_id'], 'entry_id': ENTRY, 'section_ids': [SECTION],
            'source_sha256': SOURCE, 'status': 'requires_audit', 'ready_to_run': False,
            'fresh_audit_required': True, 'selected_tmi_option_id': None, 'requirements_sha256': '3'*64,
            'scientific_compatibility': 'not_evaluated', 'model_contracts_reused': False,
            'sections': ['Synthetic'], 'required_model_names': ['fixture'], 'covered_model_names': ['fixture'],
            'missing_model_names': [], 'tmi_options': [], 'missing': []}}


class ScopeTransportTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.service = Service({'gateway_url': 'http://127.0.0.1:1', 'state_dir': tmp.name})
        self.service.gateway = Mock()
        self.health = {'api_version': '1', 'mode': 'live', 'connection_id': CONNECTION,
            'capabilities': {'simulation_onboarding': True, 'simulation_onboarding_native_entry': True,
                'simulation_onboarding_api_version': '1'}}

    def test_native_catalog_and_save_have_local_budgets_and_exact_identity(self):
        for operation, arguments, result in [('onboarding_pdk_scopes', IDENTITY, catalog()),
                ('onboarding_select_pdk_scope', SAVE, selection())]:
            with self.subTest(operation=operation):
                self.service.gateway.reset_mock()
                self.service.gateway.request.side_effect = [self.health, result]
                self.assertEqual(self.service.call(operation, arguments), result)
                calls = self.service.gateway.request.call_args_list
                self.assertEqual(len(calls), 2)
                self.assertEqual(calls[-1].kwargs['route_timeout'], 20)
                self.assertEqual(calls[-1].kwargs['onboarding_connection_id'], CONNECTION)
                self.assertEqual(calls[-1].args[1], SAVE if operation.endswith('select_pdk_scope') else None)

    def test_catalog_and_selection_reject_paths_duplicate_ids_and_out_of_bounds_before_io(self):
        invalid = [('onboarding_pdk_scopes', {**IDENTITY, 'entry_id': '/private/model.scs'}),
            ('onboarding_pdk_scopes', {**IDENTITY, 'offset': True}),
            ('onboarding_pdk_scopes', {**IDENTITY, 'limit': 129}),
            ('onboarding_pdk_scopes', {**IDENTITY, 'offset': 16385}),
            ('onboarding_pdk_scopes', {**IDENTITY, 'refresh': True}),
            ('onboarding_select_pdk_scope', {**SAVE, 'section_ids': [SECTION, SECTION]}),
            ('onboarding_select_pdk_scope', {**SAVE, 'section_ids': [format(i, '064x') for i in range(65)]}),
            ('onboarding_select_pdk_scope', {**SAVE, 'tmi_option_id': None}),
            ('onboarding_select_pdk_scope', {**SAVE, 'origin': 'interactive_client'})]
        for operation, arguments in invalid:
            with self.subTest(arguments=arguments), self.assertRaises(Failure):
                self.service.call(operation, arguments)
        self.service.gateway.request.assert_not_called()

    def test_testbench_binding_is_a_disjoint_minimal_scope_variant(self):
        schema = SCHEMAS['onboarding_agent_tb_draft']['properties']['selection']
        value = {'scope_selection_id': SELECTION, 'host_ids': ['observed-host']}
        validate(schema, value)
        for extra in [{'candidate_id': ENTRY}, {'discovery_id': 'discovery_'+'a'*32},
                {'sections': ['TT']}, {'model_contracts': {}}, {'tmi_candidate_id': None}]:
            with self.subTest(extra=extra), self.assertRaises(Failure): validate(schema, {**value, **extra})
        with self.assertRaises(Failure): validate(schema, {'scope_selection_id': SELECTION})

    def test_foreign_catalog_and_impossible_pagination_are_rejected(self):
        changes = [({'connection_id': 'x'}, None), ({'probe_id': 'probe_'+'a'*32}, None),
            (None, {'library_id': 'a'*64}), (None, {'entry_id': ENTRY}),
            (None, {'ready_to_run': True}), (None, {'next_offset': 0}),
            (None, {'items': [{'entry_id': ENTRY}, {'entry_id': ENTRY}]}),
            (None, {'total': True}), (None, {'total': 2}), (None, {'items': []})]
        for outer, inner in changes:
            result = catalog()
            if outer: result.update(outer)
            if inner: result['catalog'].update(inner)
            with self.subTest(outer=outer, inner=inner), self.assertRaises(Failure):
                check_pdk_scope_response('pdk-scopes', result, IDENTITY, CONNECTION)

    def test_save_cannot_promote_readiness_or_change_order_source_or_revision(self):
        for changes in [{'ready_to_run': True}, {'source_sha256': 'a'*64},
                {'section_ids': [ENTRY]}, {'status': 'ready'}, {'fresh_audit_required': False},
                {'selected_tmi_option_id': '5'*64}, {'requirements_sha256': None}]:
            result = selection(); result['pdk_scope_selection'].update(changes)
            with self.subTest(changes=changes), self.assertRaises(Failure):
                check_pdk_scope_response('select-pdk-scope', result, SAVE, CONNECTION)
        result = selection(); result['revision'] = 3
        with self.assertRaises(Failure): check_pdk_scope_response('select-pdk-scope', result, SAVE, CONNECTION)

    def test_helper_forwards_once_with_original_connection_and_checks_inner_scope(self):
        gateway = Mock(); proxy = GatewayOnboarding(gateway)
        proxy.enabled, proxy.connection_id = True, CONNECTION
        gateway.request.return_value = catalog()
        proxy.read('pdk-scopes', {**IDENTITY, 'offset': '0', 'limit': '64'})
        self.assertEqual(gateway.request.call_args.kwargs['route_timeout'], 20)
        gateway.request.return_value = selection()
        proxy.write('select-pdk-scope', SAVE)
        result = selection(); result['pdk_scope_selection']['library_id'] = 'a'*64
        gateway.request.return_value = result
        with self.assertRaises(Failure): proxy.write('select-pdk-scope', SAVE)
        gateway.reset_mock(); gateway.request.side_effect = Failure('transport_unknown', 'lost', 75)
        with self.assertRaises(Failure): proxy.write('select-pdk-scope', SAVE)
        self.assertEqual(gateway.request.call_count, 1)


if __name__ == '__main__': unittest.main()
