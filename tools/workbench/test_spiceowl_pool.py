"""Local adapter tests. The external backend and runner never perform SSH."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from spiceowl_pool import ResourcePool, canonical, validate_simulator_budget


EXTERNAL = 'spiceowl.integrations.circuitgit_pool'


class ResourcePoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config_path = self.root / 'pool.json'
        self.site_path = self.root / 'site.json'
        self.bundle = self.root / 'bundle.json'
        self.bundle.write_text('{"schema":"fixture"}')
        self.key = b'existing-gateway-signing-key'
        self.identity = {'project_id': 'inverter', 'configuration': 'tran', 'source_commit': 'a' * 40}
        self.site = {'schema': 'ic.sim.site.v1', 'ssh_target': 'private-route',
                     'remote_runs_root': '/private/ic_on_github_runs',
                     'cadence_cshrc': '/private/cadence/setup.csh', 'spectre_bin': '/private/cadence/spectre',
                     'external_files': {}, 'expected_host': 'compute-one', 'expected_user': 'researcher'}
        self.config = {'schema': 'ic.spiceowl-pool.v1', 'spiceowl_data_dir': str(self.root / 'owl'),
                       'requirements': {'cpu_count': 1, 'memory_bytes': 1024**3, 'simulator': 'spectre'},
                       'members': [{'host_id': 'node-one', 'site_file': str(self.site_path)}]}
        self.profile = {'schema': 'spiceowl.host.v1', 'host_id': 'node-one', 'label': 'Node one',
                        'ssh_target': 'resource-route', 'expected_host': 'compute-one', 'expected_user': 'researcher',
                        'tools': [{'kind': 'spectre', 'executable': '/private/cadence/spectre'}]}
        self.selection = {'schema': 'spiceowl.resource-selection.v1', 'host_id': 'node-one',
                          'requirements': copy.deepcopy(self.config['requirements']),
                          'selected_at': '2026-11-23T00:00:00+00:00', 'profile': copy.deepcopy(self.profile),
                          'profile_sha256': hashlib.sha256(canonical(self.profile)).hexdigest(),
                          'simulator_version': '25.1.0', 'recommendation': {
                              'recommended_host_id': 'node-one', 'evaluated_at': '2026-11-23T00:00:00+00:00',
                              'candidates': [{'host_id': 'node-one', 'resource_observed_at': '2026-11-22T23:59:58+00:00'}],
                              'excluded': [{'host_id': 'node-two', 'reason_codes': ['resources_stale'],
                                            'reasons': ['/private/should-not-leak password=not-a-secret-fixture']}]}}
        self.backend = Mock()
        self.backend.select.side_effect = lambda *args: copy.deepcopy(self.selection)
        self.backend.recheck.side_effect = lambda selection: copy.deepcopy(selection)
        self.factory = Mock(return_value=self.backend)
        module = types.ModuleType(EXTERNAL)
        module.CircuitGitPool = self.factory
        self.addCleanup(patch.stopall)
        patch.dict(sys.modules, {EXTERNAL: module}).start()
        self.runner = Mock()
        self.runner.plan.return_value = {'simulator': {'profile': 'spectre-default', 'args': ['-64']},
                                         'provenance': {'source_commit': 'a' * 40}}
        self.runner.preflight.return_value = {'plan': copy.deepcopy(self.runner.plan.return_value),
                                              'probe': {'identity_ok': True}}
        self.write_config()
        self.site_path.write_text(json.dumps(self.site))

    def write_config(self):
        self.config_path.write_text(json.dumps(self.config))

    def pool(self, key=None):
        return ResourcePool(self.config_path, self.root / 'runtime', key or self.key)

    def prepared(self):
        pool = self.pool()
        result = pool.prepare(self.runner, self.bundle, self.identity)
        return pool, result

    def test_constructor_is_local_and_lazy(self):
        self.pool()
        self.factory.assert_not_called()
        self.assertFalse((self.root / 'runtime').exists())

    def test_default_site_missing_model_aliases_never_blocks_selected_site_preflight(self):
        self.runner.plan.side_effect = AssertionError('No default-site preparation in pool mode')
        pool = self.pool()
        preview = pool.preview(self.bundle, self.identity)
        self.assertEqual(preview['state'], 'needs_remote_preflight')
        self.assertNotIn('provenance', preview)
        self.backend.select.assert_not_called()
        result = pool.prepare(self.runner, self.bundle, self.identity)
        self.assertIn('execution_plan_id', result)
        self.runner.plan.assert_not_called()
        self.runner.preflight.assert_called_once_with(self.bundle, 'a'*40, site=self.site)

    def test_prepare_and_resolve_preserve_frozen_site_and_key_ownership(self):
        pool, result = self.prepared()
        plan_id = result['execution_plan_id']
        self.assertRegex(plan_id, r'^[a-f0-9]{64}$')
        self.runner.preflight.assert_called_once_with(self.bundle, 'a' * 40, site=self.site)
        self.backend.select.assert_called_once_with(['node-one'], self.config['requirements'])
        self.factory.assert_called_once_with(self.config['spiceowl_data_dir'])
        self.assertEqual(result['execution_target']['resource_observed_at'], '2026-11-22T23:59:58+00:00')
        self.assertFalse(result['execution_target']['resource_reservation'])
        self.assertEqual(result['probe'], self.runner.preflight.return_value['probe'])
        for _ in range(2):
            context = pool.resolve(plan_id, self.bundle, self.identity)
            self.assertEqual(context, {'schema': 'ic.execution.context.v1', 'plan_id': plan_id,
                                      'site': self.site, 'resource_selection': self.selection})
        self.backend.select.assert_called_once()
        self.backend.recheck.assert_not_called()
        self.assertFalse(list((self.root / 'runtime').rglob('keys.json')))
        if os.name != 'nt':
            self.assertEqual((pool.root / (plan_id + '.json')).stat().st_mode & 0o777, 0o600)

    def test_review_contains_only_safe_summary(self):
        _, result = self.prepared()
        public = json.dumps({k: result[k] for k in ('execution_target', 'resource_recommendation')})
        self.assertNotIn('/private/', public)
        self.assertNotIn('password', public)
        self.assertNotIn('profile', public)
        self.assertEqual(result['resource_recommendation']['excluded'][0]['reasons'], ['resources stale'])

    def test_same_complete_material_has_same_plan_id(self):
        pool, first = self.prepared()
        second = pool.prepare(self.runner, self.bundle, self.identity)
        self.assertEqual(first['execution_plan_id'], second['execution_plan_id'])

    def test_signature_and_content_id_both_required(self):
        pool, result = self.prepared()
        path = pool.root / (result['execution_plan_id'] + '.json')
        original = path.read_text()
        signed = json.loads(original)
        signed['data']['preflight']['probe']['identity_ok'] = False
        path.write_text(json.dumps(signed))
        with self.assertRaisesRegex(ValueError, 'signature or content ID'):
            pool.resolve(result['execution_plan_id'], self.bundle, self.identity)
        path.write_text(original)
        with self.assertRaisesRegex(ValueError, 'signature or content ID'):
            self.pool(b'different-key').resolve(result['execution_plan_id'], self.bundle, self.identity)
        wrong_id = 'b' * 64
        (pool.root / (wrong_id + '.json')).write_text(original)
        with self.assertRaisesRegex(ValueError, 'signature or content ID'):
            pool.resolve(wrong_id, self.bundle, self.identity)

    def test_identity_and_bundle_changes_cannot_reuse_plan(self):
        pool, result = self.prepared()
        for field, value in [('project_id', 'other'), ('configuration', 'dc'), ('source_commit', 'b' * 40)]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'identity mismatch'):
                pool.resolve(result['execution_plan_id'], self.bundle, self.identity | {field: value})
        duplicate = self.root / 'same-bytes.json'
        duplicate.write_bytes(self.bundle.read_bytes())
        with self.assertRaisesRegex(ValueError, 'bundle path or digest'):
            pool.resolve(result['execution_plan_id'], duplicate, self.identity)
        self.bundle.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'bundle path or digest'):
            pool.resolve(result['execution_plan_id'], self.bundle, self.identity)

    def test_later_configuration_and_site_changes_never_replace_frozen_site(self):
        pool, result = self.prepared()
        self.site_path.write_text(json.dumps(self.site | {'expected_host': 'other'}))
        self.config['members'] = [{'host_id': 'other', 'site_file': str(self.root / 'missing.json')}]
        self.config['requirements']['cpu_count'] = 8
        self.write_config()
        resolved = self.pool().resolve(result['execution_plan_id'], self.bundle, self.identity)
        self.assertEqual(resolved['site'], self.site)
        self.assertEqual(resolved['resource_selection']['host_id'], 'node-one')

    def test_mismatched_site_is_rejected_before_preflight(self):
        for field in ('expected_host', 'expected_user', 'spectre_bin'):
            with self.subTest(field=field):
                self.site_path.write_text(json.dumps(self.site | {field: '/wrong' if field == 'spectre_bin' else 'wrong'}))
                with self.assertRaisesRegex(ValueError, 'does not match'):
                    self.pool().prepare(self.runner, self.bundle, self.identity)
        self.runner.preflight.assert_not_called()

    def test_failed_preflight_or_changed_bundle_never_saves_plan(self):
        self.runner.preflight.side_effect = ValueError('preflight failed')
        with self.assertRaisesRegex(ValueError, 'preflight failed'):
            self.pool().prepare(self.runner, self.bundle, self.identity)
        self.assertFalse((self.root / 'runtime').exists())
        def changed(*args, **kwargs):
            self.bundle.write_text('{}')
            return {'plan': copy.deepcopy(self.runner.plan.return_value), 'probe': {}}
        self.runner.preflight.side_effect = changed
        with self.assertRaisesRegex(ValueError, 'changed during preflight'):
            self.pool().prepare(self.runner, self.bundle, self.identity)
        self.assertFalse((self.root / 'runtime').exists())

    def test_wrong_preflight_identity_is_not_signed(self):
        self.runner.preflight.return_value['plan']['provenance']['source_commit'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'preflight source identity mismatch'):
            self.pool().prepare(self.runner, self.bundle, self.identity)
        self.assertFalse((self.root / 'runtime').exists())

    def test_duplicate_keys_in_config_and_site_fail(self):
        self.config_path.write_text(json.dumps(self.config).replace('"cpu_count": 1', '"cpu_count": 1, "cpu_count": 2'))
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON key'):
            self.pool()
        self.write_config()
        self.site_path.write_text(json.dumps(self.site).replace('"expected_user": "researcher"', '"expected_user": "researcher", "expected_user": "researcher"'))
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON key'):
            self.pool().prepare(self.runner, self.bundle, self.identity)
        self.runner.preflight.assert_not_called()

    def test_config_rejects_credentials_relative_paths_and_duplicate_members(self):
        original = copy.deepcopy(self.config)
        cases = [original | {'password': 'forbidden'}, original | {'spiceowl_data_dir': 'relative'},
                 original | {'members': []}, original | {'members': original['members'] * 2},
                 original | {'members': [{'host_id': 'node-one', 'site_file': 'relative'}]}]
        for config in cases:
            self.config = config
            self.write_config()
            with self.assertRaises(ValueError):
                self.pool()

    def test_requirements_bounds_and_boolean_rejection(self):
        for value in (True, 0, 4097, 1.5):
            self.config['requirements']['cpu_count'] = value
            self.write_config()
            with self.assertRaises(ValueError):
                self.pool()
        self.config['requirements']['cpu_count'] = 4096
        self.write_config()
        self.pool()
        for value in (False, 0, -1, 1.5):
            self.config['requirements']['memory_bytes'] = value
            self.write_config()
            with self.assertRaises(ValueError):
                self.pool()
        self.config['requirements']['memory_bytes'] = 1
        self.config['requirements']['simulator'] = 'ngspice'
        self.write_config()
        with self.assertRaisesRegex(ValueError, 'Spectre only'):
            self.pool()

    def test_profile_digest_and_unconfigured_selection_fail(self):
        self.selection['profile_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            self.pool().prepare(self.runner, self.bundle, self.identity)
        self.selection['profile_sha256'] = hashlib.sha256(canonical(self.profile)).hexdigest()
        self.selection['requirements']['memory_bytes'] += 1
        with self.assertRaisesRegex(ValueError, 'unconfigured host or resource request'):
            self.pool().prepare(self.runner, self.bundle, self.identity)
        self.runner.preflight.assert_not_called()

    def test_recheck_returns_same_host_evidence_without_reselection(self):
        pool = self.pool()
        original = copy.deepcopy(self.selection)
        latest = copy.deepcopy(original)
        latest['selected_at'] = latest['recommendation']['evaluated_at'] = '2026-11-24T00:00:00+00:00'
        latest['recommendation']['candidates'][0]['resource_observed_at'] = '2026-11-23T23:59:59+00:00'
        self.backend.recheck.side_effect = lambda selection: copy.deepcopy(latest)
        result = pool.recheck(original)
        self.assertEqual(result, {'eligible': True, 'host_id': 'node-one', 'checked_at': latest['selected_at'], 'selection': latest})
        self.backend.select.assert_not_called()
        self.assertEqual(original, self.selection)

    def test_recheck_refuses_changed_identity_and_propagates_unavailability(self):
        pool = self.pool()
        latest = copy.deepcopy(self.selection)
        latest['simulator_version'] = '26.1.0'
        self.backend.recheck.side_effect = lambda selection: latest
        with self.assertRaisesRegex(ValueError, 'changed the frozen selection identity'):
            pool.recheck(self.selection)
        self.backend.recheck.side_effect = ValueError('resources unavailable')
        with self.assertRaisesRegex(ValueError, 'resources unavailable'):
            pool.recheck(self.selection)
        self.backend.select.assert_not_called()

    def test_missing_optional_dependency_has_actionable_error(self):
        pool = self.pool()
        with patch('spiceowl_pool.importlib.import_module', side_effect=ImportError('missing')):
            with self.assertRaisesRegex(ValueError, 'Install a compatible SpiceOwl'):
                pool.prepare(self.runner, self.bundle, self.identity)
        self.runner.preflight.assert_not_called()

    def test_thread_budget_is_checked_before_any_remote_scan(self):
        self.bundle.write_text(json.dumps({'simulator': {'args': ['-64', '+aps', '+mt=32']}}))
        with self.assertRaisesRegex(ValueError, 'cpu_count'):
            self.pool().prepare(self.runner, self.bundle, self.identity)
        self.backend.select.assert_not_called()
        self.runner.preflight.assert_not_called()

    def test_local_thread_profiles_have_unambiguous_budgets(self):
        request = {'cpu_count': 2, 'memory_bytes': 1024**3, 'simulator': 'spectre'}
        for args in (['-64', '+aps', '+mt'], ['-64', '+mt=auto'], ['-64', '+mt=0'],
                     ['-64', '+mt=2', '+mt=1'], ['-64', '+mt=1', '+dp=8'],
                     ['-64', '+mt=1', '-maxn'], ['-64', '+aps'], ['-64', '+mt=32']):
            with self.subTest(args=args), self.assertRaises(ValueError):
                validate_simulator_budget({'simulator': {'args': args}}, request)
        self.assertEqual(validate_simulator_budget({'simulator': {'args': ['-64', '+aps', '+mt=2', '+lqtimeout', '60', '-maxn', '5']}}, request), 2)

    def test_simulator_settings_cannot_change_between_local_and_remote_preflight(self):
        self.runner.preflight.return_value['plan']['simulator']['args'] = ['-64', '+mt=1']
        with self.assertRaisesRegex(ValueError, 'settings changed'):
            self.pool().prepare(self.runner, self.bundle, self.identity)


if __name__ == '__main__':
    unittest.main()
