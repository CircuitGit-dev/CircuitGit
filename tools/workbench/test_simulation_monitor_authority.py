"""Persisted watch grants are rechecked before any monitor transport call."""
import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from simulation_runtime import SimulationRuntime, _MonitorRunner, policy
from runner import atomic


class MonitorAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.record = {'run_id':'fixture-run', 'state':'submitted', 'project_id':'demo',
            'configuration_id':'tran', 'source_commit':'a'*40,
            'execution_context':{'schema':'ic.execution.context.v1','plan_id':'b'*64,'site':{},
                'resource_selection':{'host_id':'node-a','recommendation':{'candidates':[
                    {'host_id':'node-a','resource_observed_at':'2026-11-23T00:00:00+00:00'}]}}}}
        self.runner = Mock(root=self.root / 'runs')
        self.runner.path.side_effect = lambda rid: self.runner.root / rid
        self.runner.read.side_effect = lambda rid: copy.deepcopy(self.record)
        self.runner.status.return_value = self.record
        self.runner.execution_site.return_value = {}
        self.scope = {'enabled':True,'projects':['demo'],'hosts':['node-a'],
            'callers':['paired-helper'],'operations':['watch','unwatch','runtime']}
        self.app = SimpleNamespace(cfg={'runtime_root':str(self.root),'simulation_direct':self.scope},
            workspace=SimpleNamespace(projects={'demo':{}}), runner=self.runner)
        self.runtime = SimulationRuntime(self.app)
        self.monitor = Mock()
        self.monitor.snapshot.return_value = {'watches':[
            {'run_id':'fixture-run','watch_state':'armed','allow_collect':False}]}
        self.runtime.monitor = Mock(return_value=self.monitor)
        self.adapter = _MonitorRunner(self.runtime)

    def arm(self):
        self.runtime.arm(self.record, 'paired-helper')

    def test_arm_records_exact_original_caller_and_identity_before_start(self):
        self.arm()
        saved = json.loads((self.runner.path('fixture-run')/'monitor-authority.json').read_text())
        self.assertEqual(saved['caller'],'paired-helper')
        self.assertEqual(saved['identity'],{'run_id':'fixture-run','project_id':'demo',
            'configuration':'tran','source_commit':'a'*40})
        self.monitor.watch.assert_called_once_with('fixture-run',allow_collect=False)
        self.monitor.start.assert_called_once_with()
        self.runner.status.assert_not_called()
        self.adapter.status('fixture-run')
        self.runner.status.assert_called_once_with('fixture-run')

    def test_old_watch_without_a_connection_grant_never_reaches_ssh(self):
        self.assertEqual(self.adapter.status('fixture-run')['status_transport'],'blocked')
        self.runner.status.assert_not_called()

    def test_revoked_caller_host_project_or_watch_permission_blocks_next_poll(self):
        self.arm()
        for field, value in [('enabled',False),('callers',[]),('projects',[]),('hosts',[]),('operations',[])]:
            before = self.scope[field]
            self.scope[field] = value
            with self.subTest(field=field):
                self.assertEqual(self.adapter.status('fixture-run')['status_transport'],'blocked')
            self.scope[field] = before
        self.runner.status.assert_not_called()

    def test_changed_historical_source_or_reused_authority_for_other_run_is_blocked(self):
        self.arm()
        self.record['source_commit'] = 'c'*40
        self.assertFalse(self.runtime.watch_permitted('fixture-run'))
        self.record['source_commit'] = 'a'*40
        grant = json.loads((self.runner.path('fixture-run')/'monitor-authority.json').read_text())
        atomic(self.runner.path('other-run')/'monitor-authority.json',grant)
        self.assertFalse(self.runtime.watch_permitted('other-run'))
        self.runner.status.assert_not_called()

    def test_runtime_monitor_never_inherits_auto_collect_from_an_old_registry(self):
        self.arm()
        with self.assertRaises(PermissionError):
            self.adapter.collect('fixture-run')
        self.runner.collect.assert_not_called()

    def test_resume_is_opt_in_and_requires_an_existing_currently_authorized_watch(self):
        self.assertFalse(self.runtime.resume())
        self.runtime.monitor.assert_not_called()
        self.scope['resume_monitors'] = True
        self.assertFalse(self.runtime.resume())
        self.monitor.start.assert_not_called()
        self.arm()
        self.monitor.reset_mock()
        self.assertTrue(self.runtime.resume())
        self.monitor.start.assert_called_once_with()
        self.monitor.reset_mock()
        self.scope['hosts'] = []
        self.assertFalse(self.runtime.resume())
        self.monitor.start.assert_not_called()

    def test_resume_does_not_arm_terminal_or_auto_collection_watches(self):
        self.arm(); self.monitor.reset_mock(); self.scope['resume_monitors'] = True
        for receipt in [{'run_id':'fixture-run','watch_state':'terminal','allow_collect':False},
                        {'run_id':'fixture-run','watch_state':'armed','allow_collect':True}]:
            self.monitor.snapshot.return_value = {'watches':[receipt]}
            self.assertFalse(self.runtime.resume())
        self.monitor.start.assert_not_called()

    def test_invalid_resume_setting_is_rejected(self):
        with self.assertRaises(ValueError):
            policy({**self.scope,'resume_monitors':'true'})


if __name__ == '__main__':
    unittest.main()
