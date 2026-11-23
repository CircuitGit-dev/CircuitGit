"""Original offline fixtures for frozen execution sites; never run SSH or a solver."""
import copy
import hashlib
import hmac
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

import runner


COMMIT = 'a' * 40
SIGNING_KEY = b'original offline signing fixture'


def site(name):
    return {'schema': 'ic.sim.site.v1', 'ssh_target': 'fixture-' + name,
            'remote_runs_root': '/fixture/' + name + '/ic_on_github_runs',
            'cadence_cshrc': '/fixture/' + name + '/setup.csh',
            'spectre_bin': '/fixture/' + name + '/spectre',
            'ocean_bin': '/fixture/' + name + '/ocean',
            'expected_host': 'fixture-' + name, 'expected_user': 'fixture-user', 'external_files': {}}


def context(name='b'):
    return {'schema': 'ic.execution.context.v1', 'plan_id': 'b' * 64, 'site': site(name),
            'resource_selection': {'host_id': 'fixture-' + name, 'requirements': {'cpu_count': 1}}}


def ready(selection):
    return {'eligible': True, 'host_id': selection['host_id'],
            'checked_at': '2026-11-23T00:00:00+00:00', 'selection': copy.deepcopy(selection)}


def completed(stdout=b''):
    return subprocess.CompletedProcess([], 0, stdout, b'')


class FrozenExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.bundle = self.root / 'bundle.json'
        self.bundle.write_text('{"fixture":true}\n')
        self.deck = self.root / 'input.scs'
        self.deck.write_text('simulator lang=spectre\nR0 (out 0) resistor r=1k\n')
        self.bundle_data = {'schema': 'ic.sim.bundle.v1', 'design_id': 'fixture-project',
                            'entrypoint': 'netlist/input.scs', 'reviewed_for_distribution': True,
                            'library': 'legacy-library-field', 'library_id': 'UNTRUSTED_BUNDLE_METADATA',
                            'postprocess': {'signals': ['out'], 'end_s': 1e-9, 'step_s': 1e-10}}
        self.prepare_calls = []
        self.core_prepare = self.start(patch.object(runner.core, 'prepare', side_effect=self.prepare))
        self.git = self.start(patch.object(runner.core, 'git', return_value='tracked fixture'))
        self.doctor = self.start(patch.object(runner.core, 'doctor', return_value={
            'exit_code': 0, 'identity_ok': True, 'all_references_readable': True,
            'all_tools_available': True, 'dependency_sha256': {'cadence_setup': 'c' * 64, 'spectre': 'd' * 64}}))
        self.aliases = self.start(patch.object(runner.core, 'required_aliases', return_value=set()))
        self.ssh = self.start(patch.object(runner.core, 'ssh', side_effect=AssertionError('No SSH in fixture')))
        self.process = self.start(patch.object(runner.subprocess, 'run', side_effect=AssertionError('No process in fixture')))
        self.runner = runner.Runner(self.root / 'runs', site('a'))

    def start(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def prepare(self, bundle, selected):
        self.prepare_calls.append(copy.deepcopy(selected))
        proof = {'source_commit': COMMIT, 'source_clean': True, 'source_root': str(self.root),
                 'site_config_sha256': runner.record_digest(selected), 'bundle_sha256': runner.filehash(bundle),
                 'files': [{'source': str(self.deck)}]}
        return copy.deepcopy(self.bundle_data), {'netlist/input.scs': self.deck.read_bytes()}, proof

    def reserve(self, key='fixture-submit-key', ctx=None):
        return self.runner.reserve(self.bundle, key, COMMIT, 'fixture-project', 'TRAN', execution_context=ctx)[0]

    def signed_bundle(self, **changes):
        folder = self.root / 'frozen'
        folder.mkdir(exist_ok=True)
        self.bundle = folder / 'bundle.json'
        self.bundle.write_text('{"fixture":true}\n')
        data = {'source_commit': COMMIT, 'project_id': 'fixture-project', 'configuration': 'TRAN',
                'bundle_sha256': runner.filehash(self.bundle), 'library_id': '_Example.Library', 'cell_id': '0Cell-A'}
        data.update(changes)
        signature = hmac.new(SIGNING_KEY, json.dumps(data, sort_keys=True).encode(), hashlib.sha256).hexdigest()
        (folder / 'materialization.json').write_text(json.dumps({'data': data, 'signature': signature}))
        self.runner = runner.Runner(self.root / 'signed-runs', site('a'), folder, SIGNING_KEY)
        return data

    def mark(self, record, **changes):
        current = self.runner.read(record['run_id'])
        current.update(changes)
        self.runner.save(current)
        return current

    def test_default_site_is_deeply_frozen_and_keeps_legacy_key_fingerprint(self):
        record = self.reserve()
        self.runner.site['external_files']['OTHER'] = '/fixture/changed/model.scs'
        self.runner.site['ssh_target'] = 'fixture-c'
        stored = self.runner.read(record['run_id'])
        self.assertEqual(stored['execution_site'], site('a'))
        self.assertEqual(stored['execution_site_sha256'], runner.record_digest(site('a')))
        self.assertIsNone(stored['execution_context'])
        keys = json.loads((self.runner.root / 'keys.json').read_text())
        expected = runner.core.sha(json.dumps([str(self.bundle.resolve()), COMMIT, 'fixture-project', 'TRAN'], sort_keys=True).encode())
        self.assertEqual(keys['fixture-submit-key']['fingerprint'], expected)
        repeated, created = self.runner.reserve(self.bundle, 'fixture-submit-key', COMMIT, 'fixture-project', 'TRAN')
        self.assertFalse(created)
        self.assertEqual(repeated['run_id'], record['run_id'])
        self.assertEqual(repeated['execution_site'], site('a'))

    def test_selected_context_is_frozen_and_same_key_cannot_switch_target(self):
        selected = context()
        record = self.reserve(ctx=selected)
        selected['site']['ssh_target'] = 'fixture-c'
        selected['resource_selection']['host_id'] = 'fixture-c'
        self.assertEqual(self.runner.read(record['run_id'])['execution_context'], context())
        with self.assertRaisesRegex(ValueError, 'different input'):
            self.reserve(ctx=selected)
        self.runner.site = site('changed-default')
        repeated = self.reserve(ctx=context())
        self.assertEqual(repeated['run_id'], record['run_id'])
        self.assertEqual(repeated['execution_site'], site('b'))
        self.ssh.assert_not_called()

    def test_prepare_plan_preflight_use_explicit_site_without_changing_default(self):
        for operation in ('prepare', 'plan', 'preflight'):
            with self.subTest(operation=operation):
                getattr(self.runner, operation)(self.bundle, site=site('b'))
        self.assertTrue(all(item == site('b') for item in self.prepare_calls))
        self.doctor.assert_called_once_with(site('b'))
        self.assertEqual(self.runner.site, site('a'))

    def test_site_validation_reuses_original_loader_and_rejects_unapproved_keys(self):
        bad = context()
        bad['site']['command'] = 'unapproved fixture command'
        with self.assertRaises(runner.ExecutionBindingError) as error:
            self.reserve(ctx=bad)
        self.assertEqual(error.exception.code, 'execution_site_invalid')
        self.core_prepare.assert_not_called()
        self.assertFalse((self.runner.root / 'keys.json').exists())

    def test_dispatch_rechecks_original_selection_before_remote_io_and_uses_frozen_site(self):
        record = self.reserve(ctx=context())
        events = []
        def check(selection):
            events.append('resources')
            selection['latest'] = True
            return ready(selection)
        self.runner.resource_recheck = check
        self.runner.site = site('c')
        self.doctor.side_effect = lambda selected: (events.append('preflight') or {
            'exit_code': 0, 'identity_ok': True, 'all_references_readable': True, 'all_tools_available': True,
            'dependency_sha256': {'cadence_setup': 'c' * 64, 'spectre': 'd' * 64}})
        def ssh(selected, script, **kwargs):
            events.append('ssh')
            self.assertEqual(selected, site('b'))
            return completed()
        self.ssh.side_effect = ssh
        dispatched = self.runner.dispatch(record['run_id'])
        self.assertEqual(dispatched['state'], 'submitted')
        self.assertEqual(events, ['resources', 'preflight', 'ssh', 'ssh'])
        self.assertEqual(dispatched['execution_context']['resource_selection'], context()['resource_selection'])
        self.assertTrue(dispatched['prelaunch_resources']['selection']['latest'])
        self.assertEqual(dispatched['launch_attempts'], 1)
        self.runner.dispatch(record['run_id'])
        self.assertEqual(self.ssh.call_count, 2, 'Existing dispatch is not repeated')

    def test_missing_or_failing_resource_hook_blocks_all_remote_io_without_fake_solver_failure(self):
        for hook, code in ((None, 'resource_recheck_missing'), (Mock(side_effect=ValueError('private upstream detail')), 'resource_recheck_failed')):
            with self.subTest(code=code):
                record = self.reserve(key=code, ctx=context())
                self.runner.resource_recheck = hook
                result = self.runner.dispatch(record['run_id'])
                self.assertEqual(result['state'], 'preflight_failed')
                self.assertEqual(result['launch_attempts'], 0)
                self.assertEqual(result['error_code'], code)
                self.assertFalse(result['prelaunch_resources']['eligible'])
                self.assertNotIn('private upstream detail', result['error'])
                self.assertEqual(self.runner.dispatch(record['run_id'])['state'], 'preflight_failed')
                repeated = self.reserve(key=code, ctx=context())
                self.assertEqual(repeated['run_id'], record['run_id'])
                self.assertEqual(repeated['state'], 'preflight_failed')
        self.ssh.assert_not_called()
        self.doctor.assert_not_called()

    def test_ineligible_changed_or_malformed_recheck_never_falls_back_to_another_site(self):
        good = ready(context()['resource_selection'])
        invalid = [False, {'eligible': True}, {**good, 'eligible': False}, {**good, 'eligible': 1},
                   {**good, 'host_id': 'fixture-c'}, {**good, 'selection': {'host_id': 'fixture-c'}},
                   {**good, 'checked_at': 'not-a-time'}, {**good, 'checked_at': '2026-11-23T00:00:00'}]
        for index, evidence in enumerate(invalid):
            with self.subTest(index=index):
                record = self.reserve(key='resource-case-' + str(index), ctx=context())
                self.runner.resource_recheck = Mock(return_value=evidence)
                result = self.runner.dispatch(record['run_id'])
                self.assertEqual(result['error_code'], 'resource_recheck_rejected')
                self.assertEqual(result['execution_site'], site('b'))
                self.assertEqual(result['state'], 'preflight_failed')
                self.assertFalse(result['prelaunch_resources']['eligible'])
                self.assertEqual(result['prelaunch_resources']['response'], evidence)
                self.assertEqual(result['launch_attempts'], 0)
        self.ssh.assert_not_called()
        self.doctor.assert_not_called()

    def test_digest_mismatch_refuses_status_dispatch_collection_and_postprocess(self):
        record = self.reserve(ctx=context())
        current = self.runner.read(record['run_id'])
        current['execution_site']['ssh_target'] = 'fixture-tampered'
        self.runner.save(current)
        rejected = self.runner.dispatch(record['run_id'])
        self.assertEqual(rejected['error_code'], 'execution_site_digest_mismatch')
        self.assertEqual(rejected['state'], 'queued')
        self.mark(record, state='running_observed', remote_state='running', simulator_exit_code=None)
        observed = self.runner.status(record['run_id'])
        self.assertEqual(observed['state'], 'running_observed')
        self.assertEqual(observed['remote_state'], 'running')
        self.assertEqual(observed['status_error_code'], 'execution_site_digest_mismatch')
        for operation in ('collect', 'postprocess'):
            with self.assertRaises(runner.ExecutionBindingError):
                getattr(self.runner, operation)(record['run_id'])
        self.ssh.assert_not_called()
        self.doctor.assert_not_called()

    def test_context_tamper_and_removed_snapshot_do_not_downgrade_to_legacy(self):
        first = self.reserve(ctx=context())
        record = self.runner.read(first['run_id'])
        record['execution_context']['resource_selection']['host_id'] = 'fixture-c'
        self.runner.save(record)
        self.assertEqual(self.runner.dispatch(first['run_id'])['error_code'], 'execution_context_digest_mismatch')
        second = self.reserve(key='missing-site-fixture')
        record = self.runner.read(second['run_id'])
        del record['execution_site']
        self.runner.save(record)
        self.assertEqual(self.runner.dispatch(second['run_id'])['error_code'], 'execution_site_missing')
        third = self.reserve(key='missing-context-fixture', ctx=context())
        record = self.runner.read(third['run_id'])
        del record['execution_context']
        del record['execution_context_sha256']
        self.runner.save(record)
        self.assertEqual(self.runner.dispatch(third['run_id'])['error_code'], 'execution_context_missing')
        self.ssh.assert_not_called()

    def test_lost_launch_response_preserves_unknown_outcome_without_redispatch(self):
        record = self.reserve(ctx=context())
        self.runner.resource_recheck = Mock(side_effect=ready)
        self.ssh.side_effect = [completed(), TimeoutError('fixture transport timeout')]
        dispatched = self.runner.dispatch(record['run_id'])
        self.assertEqual(dispatched['state'], 'launch_outcome_unknown')
        self.assertEqual(dispatched['launch_attempts'], 1)
        self.runner.site = site('c')
        repeated = self.runner.dispatch(record['run_id'])
        self.assertEqual(repeated['state'], 'launch_outcome_unknown')
        self.assertEqual(repeated['execution_site'], site('b'))
        self.assertEqual(self.ssh.call_count, 2)
        self.runner.resource_recheck.assert_called_once()

    def test_failed_staging_never_launches_or_switches_host(self):
        record = self.reserve(ctx=context())
        self.runner.resource_recheck = ready
        self.ssh.side_effect = lambda selected, *args, **kwargs: subprocess.CompletedProcess([], 71, b'', b'fixture stage error')
        dispatched = self.runner.dispatch(record['run_id'])
        self.assertEqual(dispatched['state'], 'staging_outcome_unknown')
        self.assertEqual(dispatched['launch_attempts'], 0)
        self.assertEqual(dispatched['execution_site'], site('b'))
        self.runner.dispatch(record['run_id'])
        self.ssh.assert_called_once()

    def test_legacy_target_mismatch_preserves_state_and_does_not_backfill_identity(self):
        legacy = {'run_id': 'legacy-fixture', 'state': 'running_observed', 'remote_state': 'running',
                  'ssh_target': 'fixture-b', 'remote_directory': '/fixture/b/ic_on_github_runs/legacy-fixture',
                  'simulator_exit_code': None}
        self.runner.save(legacy)
        result = self.runner.status(legacy['run_id'])
        self.assertEqual((result['state'], result['remote_state'], result['simulator_exit_code']),
                         ('running_observed', 'running', None))
        self.assertEqual(result['status_error_code'], 'legacy_execution_site_mismatch')
        self.assertNotIn('execution_site', result)
        for operation in ('collect', 'postprocess'):
            with self.assertRaises(runner.ExecutionBindingError):
                getattr(self.runner, operation)(legacy['run_id'])
        self.mark(legacy, state='queued')
        self.assertEqual(self.runner.dispatch(legacy['run_id'])['state'], 'queued')
        self.ssh.assert_not_called()

    def test_legacy_matching_target_keeps_original_status_behavior(self):
        legacy = {'run_id': 'legacy-fixture', 'state': 'submitted', 'ssh_target': 'fixture-a',
                  'remote_directory': '/fixture/a/ic_on_github_runs/legacy-fixture'}
        self.runner.save(legacy)
        self.ssh.side_effect = lambda selected, script: completed(b'STATE running\nPID 123\nALIVE yes\n')
        result = self.runner.status(legacy['run_id'])
        self.assertEqual(result['state'], 'running_observed')
        self.assertNotIn('execution_site', result)
        self.assertEqual(self.ssh.call_args.args[0], site('a'))

    def test_signed_library_metadata_is_promoted_without_relabeling_legacy_fields(self):
        self.signed_bundle()
        plan = self.runner.plan(self.bundle, COMMIT, site=site('b'))
        self.assertEqual((plan['library_id'], plan['cell_id']), ('_Example.Library', '0Cell-A'))
        self.assertEqual(plan['library'], 'legacy-library-field')
        record = self.reserve(ctx=context())
        self.assertEqual((record['library_id'], record['cell_id']), ('_Example.Library', '0Cell-A'))

    def test_signed_direct_submission_preserves_optional_identity_arguments(self):
        self.signed_bundle()
        record, created = self.runner.reserve(self.bundle, 'direct-call-fixture', COMMIT)
        self.assertTrue(created)
        self.assertIsNone(record['project_id'])
        self.assertIsNone(record['configuration_id'])
        self.assertEqual(record['library_id'], '_Example.Library')

    def test_unverified_bundle_metadata_is_not_promoted(self):
        plan = self.runner.plan(self.bundle, COMMIT)
        self.assertNotIn('library_id', plan)
        self.assertNotIn('cell_id', self.reserve())

    def test_materialization_source_project_and_configuration_conflicts_reject_reservation(self):
        for field, wrong in (('source_commit', 'f' * 40), ('project_id', 'other-project'), ('configuration', 'OTHER')):
            with self.subTest(field=field):
                self.signed_bundle(**{field: wrong})
                with self.assertRaisesRegex(ValueError, 'conflict'):
                    self.reserve(key='materialization-' + field)
                self.assertEqual(self.runner.list(), [])
        self.ssh.assert_not_called()

    def test_invalid_or_unsigned_library_metadata_never_reaches_plan(self):
        self.signed_bundle(library_id='../invalid')
        with self.assertRaisesRegex(ValueError, 'invalid materialization library_id'):
            self.runner.plan(self.bundle, COMMIT)
        self.signed_bundle()
        path = self.bundle.parent / 'materialization.json'
        value = json.loads(path.read_text())
        value['data']['library_id'] = 'ChangedWithoutSignature'
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'signature'):
            self.runner.plan(self.bundle, COMMIT)

    def test_collection_and_direct_transfer_use_the_run_site_after_default_changes(self):
        record = self.reserve(ctx=context())
        self.mark(record, state='submitted')
        self.runner.site = site('c')
        archive = runner.core.archive({'./psf/tran.tran': b'original synthetic transient',
                                      './psf/spectre.out': b'spectre completes with 0 errors, 0 warnings.\n'})
        digest = hashlib.sha256(archive).hexdigest()
        def ssh(selected, script, **kwargs):
            self.assertEqual(selected, site('b'))
            if "printf 'STATE '" in script:
                return completed(b'STATE simulator_complete_pending_measurements\nEXIT 0\nALIVE no\n')
            return completed((digest + '  exports/full-results.tar.gz\n' + str(len(archive)) + '\n').encode())
        def transfer(argv, **kwargs):
            self.assertEqual(argv[5], 'fixture-b')
            kwargs['stdout'].write(archive)
            return completed()
        self.ssh.side_effect = ssh
        self.process.side_effect = transfer
        result = self.runner.collect(record['run_id'])
        self.assertEqual(result['collection']['sha256'], digest)
        self.assertEqual(result['collection_phase'], 'complete')
        self.process.assert_called_once()

    def test_postprocess_uses_frozen_setup_and_ocean_without_redirecting(self):
        record = self.reserve(ctx=context())
        self.mark(record, state='submitted')
        self.runner.site = site('c')
        generated = []
        def ssh(selected, script, **kwargs):
            self.assertEqual(selected, site('b'))
            if "printf 'STATE '" in script:
                return completed(b'STATE simulator_complete_pending_measurements\nEXIT 0\nALIVE no\n')
            if 'data' in kwargs and 'tar xzf' in script:
                with tarfile.open(fileobj=io.BytesIO(kwargs['data']), mode='r:gz') as tf:
                    generated.append(tf.extractfile('run.csh').read().decode())
            if script.startswith('cat ') and script.endswith('/waveforms.csv'):
                return completed(b'time,out\n0,0\n1e-9,1\n')
            return completed()
        self.ssh.side_effect = ssh
        with patch.dict(sys.modules, {'matplotlib.figure': None}):
            result = self.runner.postprocess(record['run_id'], wait_seconds=1)
        self.assertEqual(result['run_id'], record['run_id'])
        self.assertEqual(len(generated), 1)
        self.assertIn(site('b')['cadence_cshrc'], generated[0])
        self.assertIn(site('b')['ocean_bin'], generated[0])
        self.assertNotIn('/fixture/c/', generated[0])
        self.assertEqual(self.runner.read(record['run_id'])['postprocess_phase'], 'complete')


if __name__ == '__main__':
    unittest.main(verbosity=2)
