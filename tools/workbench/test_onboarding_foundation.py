"""Independent fresh-intake foundation tests; all files and probes are synthetic."""
import contextlib
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import server
from onboarding_runtime import create_onboarding_config, EmptyWorkspace
from runner import atomic
from workspace import Conflict, Workspace

try:
    from spiceowl.onboarding.pdk_discovery import inspect_netlist
    import spiceowl.onboarding.environment
except ImportError:
    inspect_netlist = None


SOURCE = 'simulator lang=spectre\nM0 (OUT IN LO LO) synthetic_n w=2u l=180n\n'
SECRET = 'SYNTHETIC_OLD_LICENSE_VALUE'


class _FreshFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'new-user'
        self.home.mkdir()
        self.old = self.root / 'synthetic-old-store'
        self.old.mkdir()
        self.sentinel = self.old / 'site.local.json'
        self.sentinel.write_text(SECRET)
        self.manual_request = self.old / 'manual-request.json'
        self.manual_request.write_text(json.dumps({'request_id': 'synthetic-old-request',
            'state': 'pending_approval', 'approved': False}))

    def configure(self, name='fresh'):
        with patch('onboarding_runtime.Path.home', return_value=self.home):
            return create_onboarding_config(self.root / name)

    @contextlib.contextmanager
    def no_old_reads_or_execution(self):
        original_open = Path.open
        def only_current(path, *args, **kwargs):
            if Path(path).absolute().is_relative_to(self.old):
                raise AssertionError('Historical fixture content must not be read')
            return original_open(path, *args, **kwargs)
        with (patch('pathlib.Path.open', autospec=True, side_effect=only_current),
              patch('subprocess.run', side_effect=AssertionError('No Git, SSH or child process')),
              patch('subprocess.Popen', side_effect=AssertionError('No Git, SSH or child process')),
              patch('server.core.ssh', side_effect=AssertionError('No SSH'))):
            yield


class FreshStoreTests(_FreshFixture):
    def test_fresh_store_rejects_nonempty_or_symlink_target_without_reading_content(self):
        with self.no_old_reads_or_execution(), self.assertRaises(ValueError):
            create_onboarding_config(self.old)
        link = self.root / 'old-link'
        link.symlink_to(self.old, target_is_directory=True)
        with self.no_old_reads_or_execution(), self.assertRaises(ValueError):
            create_onboarding_config(link)
        empty = self.root / 'empty'
        empty.mkdir()
        with self.no_old_reads_or_execution(), patch('onboarding_runtime.Path.home', return_value=self.home):
            config = create_onboarding_config(empty)
        self.assertTrue(config['onboarding_only'])
        self.assertTrue(config['local_only'])
        self.assertEqual(config['projects'], [])
        self.assertIsNone(config['github_repo'])

    def test_connection_identity_is_stable_only_under_explicit_resume(self):
        config = self.configure()
        with self.no_old_reads_or_execution():
            resumed = create_onboarding_config(self.root / 'fresh', resume=True)
            self.assertEqual(resumed, config)
            with self.assertRaises(ValueError):
                create_onboarding_config(self.root / 'fresh')
        other = self.configure('another-fresh')
        self.assertNotEqual(config['onboarding']['connection_id'], other['onboarding']['connection_id'])
        marker = json.loads((self.root / 'fresh/onboarding-state.json').read_text())
        marker['connection_id'] = '0' * 32
        atomic(self.root / 'fresh/onboarding-state.json', marker)
        with self.assertRaises(ValueError):
            create_onboarding_config(self.root / 'fresh', resume=True)

    def test_resume_cannot_switch_to_legacy_or_outside_storage_configuration(self):
        config = self.configure()
        path = self.root / 'fresh/connection.json'
        cases = [dict(config, local_only=False), dict(config, onboarding_only=False),
                 dict(config, github_repo='synthetic/legacy'), dict(config, runtime_root=str(self.old)),
                 dict(config, projects=[{'id': 'legacy'}]), dict(config, site_file=str(self.sentinel)),
                 dict(config, seed_repo=str(self.old)), dict(config, ai_client_config=str(self.sentinel))]
        outside = copy.deepcopy(config); outside['onboarding']['state_root'] = str(self.old)
        cases.append(outside)
        for changed in cases:
            atomic(path, changed)
            with self.subTest(changed=sorted(k for k in changed if changed.get(k) != config.get(k))):
                with self.no_old_reads_or_execution(), self.assertRaises(ValueError):
                    create_onboarding_config(self.root / 'fresh', resume=True)
        atomic(path, config)

    def test_resume_rejects_invalid_flags_shapes_and_paths(self):
        config = self.configure()
        path = self.root / 'fresh/connection.json'
        cases = [dict(config, local_only=1), dict(config, onboarding_only=1),
                 dict(config, projects={}), dict(config, onboarding=[])]
        for field, value in [('enabled', 1), ('enabled', False), ('extra', True),
                             ('ssh_config', 'relative/config'), ('ssh_config', '/synthetic/../old/config'),
                             ('ssh_config', '/synthetic/\x00config'), ('ssh_config', ['/synthetic/config'])]:
            changed = copy.deepcopy(config)
            changed['onboarding'][field] = value
            cases.append(changed)
        for changed in cases:
            atomic(path, changed)
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                create_onboarding_config(self.root / 'fresh', resume=True)
        atomic(path, config)
        # An explicit alternate SSH config remains valid without reading it.
        config['onboarding']['ssh_config'] = str(self.root / 'new-user/explicit-ssh-config')
        atomic(path, config)
        with self.no_old_reads_or_execution():
            self.assertEqual(create_onboarding_config(self.root / 'fresh', resume=True), config)

    def test_resume_rejects_linked_storage_before_opening_historical_content(self):
        self.configure()
        for name in ('gateway', 'intake-store', 'node'):
            path = self.root / 'fresh' / name
            path.symlink_to(self.old, target_is_directory=True)
            with self.subTest(name=name), self.no_old_reads_or_execution(), self.assertRaises(ValueError):
                create_onboarding_config(self.root / 'fresh', resume=True)
            path.unlink()
        for name in ('connection.json', 'onboarding-state.json'):
            path = self.root / 'fresh' / name
            backup = path.with_suffix('.backup')
            path.rename(backup)
            path.symlink_to(self.sentinel)
            with self.subTest(name=name), self.no_old_reads_or_execution(), self.assertRaises(ValueError):
                create_onboarding_config(self.root / 'fresh', resume=True)
            path.unlink()
            backup.rename(path)
        for name in ('gateway/frozen', 'gateway/runs', 'gateway/simulation-runtime',
                     'gateway/signing.key', 'node/node-id', 'node/browser-access.key'):
            path = self.root / 'fresh' / name
            path.parent.mkdir(exist_ok=True)
            path.symlink_to(self.sentinel if '.' in path.name or path.name == 'node-id' else self.old)
            with self.subTest(name=name), self.no_old_reads_or_execution(), self.assertRaises(ValueError):
                create_onboarding_config(self.root / 'fresh', resume=True)
            path.unlink()

    def test_resume_rejects_malformed_markers_and_non_directory_stores(self):
        self.configure()
        path = self.root / 'fresh/onboarding-state.json'
        marker = json.loads(path.read_text())
        for changed in [[], None, {**marker, 'connection_id': 'invalid'},
                        {**marker, 'source_mode': 'legacy'}, {**marker, 'extra': True}]:
            atomic(path, changed)
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                create_onboarding_config(self.root / 'fresh', resume=True)
        for resume in (False, True):
            with self.subTest(resume=resume), self.assertRaises(ValueError):
                create_onboarding_config(self.sentinel, resume=resume)


@unittest.skipIf(inspect_netlist is None, 'Requires the paired SpiceOwl onboarding package')
class IntakeRuntimeFoundationTests(_FreshFixture):
    def setUp(self):
        super().setUp()
        self.config = self.configure()
        with self.no_old_reads_or_execution(), patch.object(server, 'Workspace', side_effect=AssertionError('No source Git workspace')):
            self.app = server.Application(self.config, self.root / 'empty-web')
        self.addCleanup(self.close_app)
        self.runtime = self.app.onboarding

    def close_app(self):
        self.app.onboarding.close()
        self.app.simulation.close()
        self.app.pool.shutdown(wait=True)

    def source(self, **changes):
        with self.no_old_reads_or_execution():
            return self.runtime.write('netlist', {'file_name': 'fresh.scs', 'text': SOURCE, **changes}, origin='test_harness')

    def probe(self, state):
        observed = {'public': {'schema': 'spiceowl.server-environment.v1', 'alias': 'synthetic-node',
                              'transport': 'reachable', 'identity': {'observed': True, 'verified': False},
                              'licenses': [{'name': 'CDS_LIC_FILE', 'configured': True, 'usable': 'unknown'}]},
                    'private': {'licenses': [{'name': 'CDS_LIC_FILE', 'value': SECRET}],
                                'path': ['/synthetic/private/path'], 'setup_path': '/synthetic/private/setup'}}
        with self.no_old_reads_or_execution(), patch('spiceowl.onboarding.environment.capture_server_environment', return_value=observed) as capture:
            result = self.runtime.write('probe', {'intake_id': state['intake_id'], 'revision': state['revision'],
                'ssh_targets': ['synthetic-node']}, origin='test_harness')
        capture.assert_called_once_with('synthetic-node', self.config['onboarding']['ssh_config'])
        return result

    def test_application_starts_without_source_git_site_loading_or_remote_actions(self):
        self.assertIsInstance(self.app.workspace, EmptyWorkspace)
        self.assertIsNone(self.app.workspace.repo)
        self.assertIsNone(self.app.workspace.head())
        self.assertEqual(self.app.workspace.projects, {})
        self.assertFalse(self.app.workspace.root.exists())
        self.assertFalse(self.app.workspace.describe()['capabilities']['git'])
        self.assertFalse(self.app.workspace.describe()['capabilities']['publish'])
        self.assertIsNone(self.app.resource_pool)
        self.assertIsNone(self.app.simulation.scope)
        self.assertEqual(self.app.operations, {})
        self.assertEqual(self.app.runner.list(), [])

    def test_netlist_uses_only_request_bytes_and_display_label_is_not_an_input_path(self):
        display = str(self.old / 'never-read.scs')
        state = self.source(file_name=display)
        source_path = self.runtime._folder(state['intake_id']) / 'source.scs'
        self.assertEqual(source_path.read_bytes(), SOURCE.encode('utf-8'))
        self.assertEqual(state['source_sha256'], hashlib.sha256(SOURCE.encode('utf-8')).hexdigest())
        self.assertIsNone(state['source_commit'])
        self.assertIsNone(state['source']['source_commit'])
        self.assertEqual(state['source']['requirements']['required_masters'], ['synthetic_n'])
        self.assertEqual(state['input_provenance'][0]['origin'], 'test_harness')
        self.assertFalse((self.app.workspace.root / '.git').exists())
        self.assertFalse((self.old / 'never-read.scs').exists())

    def test_revision_cas_rejects_stale_probe_before_another_observation(self):
        state = self.source()
        probed = self.probe(state)
        self.assertEqual(probed['revision'], state['revision'] + 1)
        with patch('spiceowl.onboarding.environment.capture_server_environment', side_effect=AssertionError('No stale probe')):
            with self.assertRaises(Conflict):
                self.runtime.write('probe', {'intake_id': state['intake_id'], 'revision': state['revision'],
                    'ssh_targets': ['synthetic-node']}, origin='test_harness')
        current = self.runtime.read('session', {'intake_id': state['intake_id']})
        self.assertEqual(current['revision'], probed['revision'])

    def test_stale_inflight_result_cannot_replace_newer_session_revision(self):
        state = self.source()
        folder, first = self.runtime._begin({'intake_id': state['intake_id'], 'revision': 1}, 'probe')
        _, second = self.runtime._begin({'intake_id': state['intake_id'], 'revision': 2}, 'probe')
        with self.assertRaises(Conflict):
            self.runtime._finish(folder, first, state='hosts_observed', probes=[{'stale': True}])
        self.runtime._finish(folder, second, state='hosts_observed', probes=[])
        self.assertEqual(self.runtime.read('session', {'intake_id': state['intake_id']})['revision'], 3)

    def test_public_session_omits_private_probe_values_even_if_private_fields_are_stored(self):
        state = self.probe(self.source())
        public = self.runtime.read('session', {'intake_id': state['intake_id']})
        self.assertNotIn(SECRET, json.dumps(public))
        self.assertNotIn('/synthetic/private', json.dumps(public))
        folder = self.runtime._folder(state['intake_id'])
        private_probe = json.loads((folder / 'probes' / (state['probes'][0]['probe_id'] + '.json')).read_text())
        self.assertEqual(private_probe['private']['licenses'][0]['value'], SECRET)
        stored = json.loads((folder / 'session.json').read_text())
        stored['private_probe'] = private_probe['private']
        stored['runtime_path'] = '/synthetic/private/runtime'
        stored['probes'][0]['private'] = private_probe['private']
        atomic(folder / 'session.json', stored)
        public = self.runtime.read('session', {'intake_id': state['intake_id']})
        self.assertNotIn(SECRET, json.dumps(public))
        self.assertNotIn('/synthetic/private', json.dumps(public))

    def test_request_flags_do_not_promote_origin_or_old_manual_simulation_requests(self):
        for flags in [{'confirmed': True}, {'origin': 'interactive_client'}, {'selected_by': 'user'}]:
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                self.source(**flags)
        with self.no_old_reads_or_execution():
            state = self.runtime.write('netlist', {'file_name': 'fresh.scs', 'text': SOURCE}, origin='native_agent')
        self.assertEqual(state['input_provenance'][0]['origin'], 'native_agent')
        self.assertNotIn('human_verified', json.dumps(state))
        with patch.object(self.app.runner, 'reserve') as reserve, patch.object(self.app.runner, 'dispatch') as dispatch:
            with self.assertRaises(PermissionError):
                self.app.simulation.control('submit', {'project_id': 'synthetic-old-project', 'configuration': 'tran',
                    'source_commit': 'a' * 40}, 'synthetic-old-manual-key', 'native-agent')
            reserve.assert_not_called(); dispatch.assert_not_called()
        with self.assertRaises(ValueError):
            self.runtime.read('submission', {'intake_id': state['intake_id'], 'plan_id': 'b' * 64})

    def test_local_intake_publication_is_denied_before_reading_runs_or_invoking_git(self):
        with self.no_old_reads_or_execution(), patch.object(self.app.runner, 'read') as read:
            with self.assertRaises(PermissionError):
                self.app.publisher.prepare('synthetic-old-run')
            with self.assertRaises(PermissionError):
                self.app.publisher.api('repos/synthetic/old')
            read.assert_not_called()
            for extra in [{'github_repo': 'synthetic/old'}, {'source_repository': str(self.old)}]:
                config = {**self.config, **extra}
                with self.assertRaises(ValueError):
                    Workspace(config, self.app.site, b'x' * 32)

    def test_unprepared_foundation_never_claims_discovery_or_execution_success(self):
        state = self.source()
        with self.no_old_reads_or_execution(), patch.object(self.app.runner, 'reserve') as reserve, \
                patch.object(self.app.runner, 'dispatch') as dispatch:
            for operation in ['discover-pdk', 'prepare', 'run', 'inspect']:
                with self.subTest(operation=operation), self.assertRaises(ValueError):
                    self.runtime.write(operation, {'intake_id': state['intake_id'], 'revision': state['revision']},
                                       origin='test_harness')
            reserve.assert_not_called(); dispatch.assert_not_called()
        self.assertEqual(self.runtime.read('session', {'intake_id': state['intake_id']})['revision'], state['revision'])
        self.assertEqual(json.loads(self.manual_request.read_text())['state'], 'pending_approval')


if __name__ == '__main__':
    unittest.main()
