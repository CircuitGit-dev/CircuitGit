"""Synthetic local Testbench CI registration; no model, network, SSH or solver."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import test_workflow as fixtures


class TestbenchWorkflowTest(unittest.TestCase):
    # Reuse the isolated fixture, not its whole regression suite on discovery.
    setUp = fixtures.LibraryWorkflowTest.setUp
    git = fixtures.LibraryWorkflowTest.git
    write = fixtures.LibraryWorkflowTest.write
    head = fixtures.LibraryWorkflowTest.head
    sha = fixtures.LibraryWorkflowTest.sha
    def proposal_args(self):
        text = 'simulator lang=spectre\ninclude "dut.scs"\nX0 (in out) gain\nV0 (in 0) vsource dc=1\ntran1 tran stop=1u\nsave out\n'
        return {"library_id": "demo", "cell_id": "gain", "testbench_id": "gain-tran", "base_commit": self.head(),
                "testbench": text, "analysis": "# Synthetic reviewed code; never executed by registration.\nraise RuntimeError('must not execute')\n",
                "manifest": {"schema": "ic.agent_testbench.v1", "text": text,
                             "interface": {"subckt": "gain", "instance": "X0", "port_bindings": {"a": "in", "b": "out"}},
                             "analyses": [{"name": "tran1", "kind": "tran", "parameters": {"stop": "1u"}}], "stimuli": [],
                             "objectives": [{"metric": "mean", "description": "Synthetic DC fixture"}],
                             "criteria": [{"metric": "mean", "min": 0.5}],
                             "postprocess": {"operation": "tran_metrics", "inputs": {"time": "@time", "signal": "out"}, "parameters": {}}},
                "title": "Register synthetic gain transient", "body": "Version exact testbench, analysis and criterion bytes."}

    def test_testbench_preview_is_local_and_cannot_execute_directly(self):
        args = self.proposal_args()
        review = self.workflow.preview_testbench(**args)
        self.assertEqual(self.head(), self.initial)
        self.assertFalse((self.root / 'lib/demo/gain/testbenches').exists())
        self.assertEqual(review['operation'], 'register_testbench')
        self.assertEqual(len(review['payload']['per_file_diffs']), 4)
        for field in ('source_sha256', 'testbench_sha256', 'analysis_sha256', 'manifest_sha256', 'criteria_sha256'):
            self.assertEqual(len(review['payload']['binding'][field]), 64)
        self.assertEqual(self.workflow.get_testbenches('demo', 'gain')['proposals'][0]['state'], 'prepared')
        with self.assertRaises(fixtures.MOD.WorkflowError):
            self.workflow.execute('register_testbench', args, 'agent-cannot-approve')
        self.assertNotIn('register_testbench', self.workflow.EXECUTE_OPERATIONS)

    def test_testbench_confirmation_creates_scoped_commit_preserving_staging(self):
        self.write('application.js', '// unrelated staged application change\n')
        self.git('add', 'application.js')
        staged = self.git('show', ':application.js')
        review = self.workflow.preview_testbench(**self.proposal_args())
        receipt = self.workflow.confirm(review['review_id'], 'human-testbench-registration')
        self.assertTrue(receipt['registered'])
        self.assertFalse(receipt['simulation_started'])
        self.assertEqual(receipt['execution_status'], 'not_run')
        self.assertEqual(staged, self.git('show', ':application.js'))
        changed = self.git('diff-tree', '--no-commit-id', '--name-only', '-r', self.head()).decode().splitlines()
        self.assertEqual(len(changed), 4)
        self.assertTrue(all(p.startswith('lib/demo/gain/testbenches/') for p in changed))
        self.assertEqual(self.git('show', 'HEAD:' + self.path).decode(), self.before)
        self.assertEqual(self.workflow.confirm(review['review_id'], 'human-testbench-registration'), receipt)
        bundle = self.workflow.get_testbenches('demo', 'gain')['bundles'][0]
        self.assertEqual(bundle['registration_commit'], receipt['commit'])
        self.assertTrue(bundle['source_matches'])
        self.assertFalse(bundle['arbitrary_script_execution'])
        self.assertEqual(self.workflow.history('demo', 'gain')['commits'][0]['sha'], receipt['commit'])
        detail = self.workflow.describe('demo', 'gain')
        self.assertTrue(all(not f['editable'] for f in detail['files'] if '/testbenches/' in f['path']))
        pr = self.workflow.preview_pr('demo', 'gain', receipt['commit'], 'Synthetic testbench registration')
        self.assertEqual(set(pr['payload']['files']), set(changed))
        self.assertEqual(pr['operation'], 'pr')

    def test_testbench_changed_source_invalidates_review_and_registered_ci(self):
        review = self.workflow.preview_testbench(**self.proposal_args())
        self.write(self.path, self.after)
        with self.assertRaises(fixtures.MOD.WorkflowError):
            self.workflow.confirm(review['review_id'], 'changed-source-cannot-register')
        self.write(self.path, self.before)
        self.workflow.confirm(review['review_id'], 'register-original-source')
        self.write(self.path, self.after)
        self.assertFalse(self.workflow.get_testbenches('demo', 'gain')['bundles'][0]['source_matches'])
        with self.assertRaises(fixtures.MOD.WorkflowError):
            self.workflow.preview_testbench(**self.proposal_args())

    def test_testbench_preserves_existing_working_files_and_rejects_tampering(self):
        path = 'lib/demo/gain/testbenches/gain-tran/analysis.py'
        self.write(path, '# pre-existing user draft\n')
        with self.assertRaises(fixtures.MOD.WorkflowError):
            self.workflow.preview_testbench(**self.proposal_args())
        self.assertEqual((self.root / path).read_text(), '# pre-existing user draft\n')
        (self.root / path).unlink()
        review = self.workflow.preview_testbench(**self.proposal_args())
        self.workflow.confirm(review['review_id'], 'register-before-integrity-test')
        self.write(path, '# changed without review\n')
        self.git('add', path); self.git('commit', '-m', 'Synthetic integrity corruption')
        with self.assertRaises(fixtures.MOD.WorkflowError):
            self.workflow.get_testbenches('demo', 'gain')

    def test_testbench_rejects_invalid_python_private_data_and_identity(self):
        args = self.proposal_args()
        for changed in ({'analysis': 'def ('}, {'testbench_id': '../other'}, {'analysis': '# /Users/private/secrets\n'},
                        {'manifest': {'schema': 'wrong'}}, {'base_commit': '0' * 40}):
            with self.assertRaises(fixtures.MOD.WorkflowError):
                self.workflow.preview_testbench(**{**args, **changed})

    def test_testbench_inventory_alias_change_invalidates_authorization_without_rewriting_history(self):
        review = self.workflow.preview_testbench(**self.proposal_args())
        registered = self.workflow.confirm(review['review_id'], 'human-before-alias-update')
        self.manifest['cells'][0]['views'][0]['aliases'] = {'lib/demo/gain/netlist/shared.scs': self.shared}
        self.write('lib/demo/library.json', self.manifest)
        self.git('add', 'lib/demo/library.json'); self.git('commit', '-m', 'Synthetic changed source mapping')
        inventory = self.workflow.get_testbenches('demo', 'gain')
        self.assertFalse(inventory['bundles'][0]['source_matches'])
        self.assertEqual(inventory['bundles'][0]['registration_commit'], registered['commit'])


if __name__ == '__main__':
    suite = unittest.TestSuite(TestbenchWorkflowTest(name) for name in dir(TestbenchWorkflowTest) if name.startswith('test_testbench_'))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
