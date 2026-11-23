"""Synthetic same-run analysis receipts; never a real numerical/solver result."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/ci'))
import test_testbench_workflow as fixtures
import testbench_bundle as ci
import check as source_check


class TestbenchCITest(unittest.TestCase):
    setUp = fixtures.TestbenchWorkflowTest.setUp
    git = fixtures.TestbenchWorkflowTest.git
    write = fixtures.TestbenchWorkflowTest.write
    head = fixtures.TestbenchWorkflowTest.head
    sha = fixtures.TestbenchWorkflowTest.sha
    proposal_args = fixtures.TestbenchWorkflowTest.proposal_args
    def register_fixture(self):
        args = self.proposal_args()
        args['manifest']['criteria'] = [{'metric': 'mean', 'op': '>=', 'threshold': 0.5, 'unit': 'V'}]
        args['manifest']['postprocess']['inputs'] = {'values': {'name': 'out', 'analysis': 'tran', 'quantity': 'voltage'}}
        args['manifest']['postprocess']['parameters'] = {'backend': 'spiceowl', 'signal_unit': 'V'}
        review = self.workflow.preview_testbench(**args)
        receipt = self.workflow.confirm(review['review_id'], 'human-ci-test-fixture')
        self.registration = receipt['registration_commit']
        source = review['payload']['source']
        self.binding = {'library_id': 'demo', 'cell_id': 'gain', 'testbench_id': 'gain-tran',
                        'registration_commit': self.registration, 'source_sha256': source['sha256'], 'source_files': source['files'],
                        'testbench_sha256': review['payload']['binding']['testbench_sha256'],
                        'original_source_sha256': self.sha(self.before), 'source_commit': 'd' * 40,
                        'archive_sha256': 'a' * 64, 'intake_id': 'intake_synthetic', 'job_id': 'synthetic-job-1',
                        'signal_catalog': {'job_id': 'synthetic-job-1', 'signals': [
                            {'id': 'signal_unique_for_this_run', 'psf_name': 'out', 'analysis': 'tran', 'quantity': 'voltage', 'unit': 'V', 'status': 'available'}]}}
        self.calls = []
        owner = self
        class SyntheticAnalyzer:
            def analyze(_self, request):
                owner.calls.append(copy.deepcopy(request))
                return owner.result(request)
        self.analyzer = SyntheticAnalyzer()
        return review

    def result(self, request):
        requested = {k: request[k] for k in ('operation', 'inputs', 'parameters', 'criteria')}
        return {'schema': 'ic.onboarding.analysis.v1', 'synthetic': True,
                **{k: self.binding[k] for k in ('intake_id', 'job_id', 'source_commit', 'original_source_sha256', 'archive_sha256')},
                'run_id': self.binding['job_id'], 'analysis_id': 'c' * 64,
                'request': requested, 'request_sha256': ci.digest(requested),
                'input': {'archive_sha256': self.binding['archive_sha256'], 'csv_sha256': '1' * 64, 'raw_signature': '2' * 64,
                          'effective_config_sha256': '3' * 64, 'source_hashes': self.binding['source_files'], 'sample_count': 128,
                          'full_resolution': True, 'display_downsampling_used': False,
                          'selection': {k: {'id': v} for k, v in request['inputs'].items()}},
                'result': {'schema': 'spiceowl.adctools.result.v1', 'operation': request['operation'],
                           'algorithm_version': 'synthetic-contract-fixture', 'backend': 'spiceowl', 'backend_version': 'fixture',
                           'status': 'valid', 'metrics': {'mean': {'value': 1.0, 'unit': 'V', 'status': 'valid'}},
                           'warnings': [], 'specification_result': 'not_evaluated'},
                'evaluation': {'specification_result': 'pass', 'criteria': [
                    {**criterion, 'value': 1.0, 'verdict': 'pass', 'reason': None} for criterion in request['criteria']]},
                'evaluation_scope': 'exploratory', 'artifact': None}

    def run_fixture(self, **changes):
        return ci.run_registered_analysis(self.workflow, 'demo', 'gain', 'gain-tran', self.registration,
                                          {**self.binding, **changes}, self.analyzer)

    def test_ci_registration_dispatch_parse_and_readback(self):
        self.register_fixture()
        result = self.run_fixture()
        self.assertEqual(result['status'], 'passed')
        self.assertFalse(result['script_executed']); self.assertFalse(result['simulation_started'])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]['inputs'], {'values': 'signal_unique_for_this_run'})
        self.assertEqual(self.run_fixture(), result)
        self.assertEqual(len(self.calls), 1)
        saved = self.workflow.get_testbench_result('demo', 'gain', 'gain-tran', result['result_id'])
        self.assertEqual(saved, result)
        inventory = self.workflow.get_ci('demo', 'gain')['agent_testbenches']
        self.assertEqual(inventory['bundles'][0]['execution_status'], 'passed')
        self.assertEqual(inventory['bundles'][0]['latest_result']['result_id'], result['result_id'])
        with self.assertRaises(ValueError):
            self.workflow.get_testbench_result('demo', 'rc', 'gain-tran', result['result_id'])

    def test_ci_blocks_wrong_cell_tb_source_and_ambiguous_signal_before_dispatch(self):
        self.register_fixture()
        for change in ({'cell_id': 'other'}, {'source_sha256': '0' * 64}, {'testbench_sha256': '0' * 64},
                       {'source_files': {}}, {'original_source_sha256': '0' * 64}, {'signal_catalog': {'job_id': 'wrong', 'signals': []}}):
            with self.assertRaises(ValueError): self.run_fixture(**change)
        catalog = copy.deepcopy(self.binding['signal_catalog'])
        catalog['signals'].append({**catalog['signals'][0], 'id': 'another-run-local-signal'})
        with self.assertRaises(ValueError): self.run_fixture(signal_catalog=catalog)
        self.assertEqual(self.calls, [])
        self.write(self.path, self.after)
        with self.assertRaises(ValueError): self.run_fixture()
        self.assertEqual(self.calls, [])

    def test_ci_lost_or_mismatched_artifact_is_not_replayed(self):
        self.register_fixture()
        original = self.analyzer.analyze
        def corrupt(request):
            result = original(request); result['archive_sha256'] = 'f' * 64; return result
        self.analyzer.analyze = corrupt
        with self.assertRaises(ValueError): self.run_fixture()
        self.assertEqual(self.run_fixture()['status'], 'unknown')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.workflow.get_testbenches('demo', 'gain')['bundles'][0]['execution_status'], 'unknown')

    def test_ci_git_registration_without_human_receipt_does_not_authorize_execution(self):
        self.register_fixture()
        for path in (self.workflow.state / 'operations').glob('*/complete.json'):
            path.unlink()
        with self.assertRaises(ValueError): self.run_fixture()
        self.assertEqual(self.calls, [])

    def test_ci_result_rejects_downsampling_forged_pass_and_wrong_criteria(self):
        self.register_fixture()
        request = {'intake_id': self.binding['intake_id'], 'job_id': self.binding['job_id'], 'operation': 'tran_metrics',
                   'inputs': {'values': 'signal_unique_for_this_run'}, 'parameters': {'backend': 'spiceowl', 'signal_unit': 'V'},
                   'criteria': [{'metric': 'mean', 'op': '>=', 'threshold': 0.5, 'unit': 'V'}]}
        for mode in ('sampled', 'forged', 'criteria', 'request'):
            result = self.result(request)
            if mode == 'sampled': result['input']['display_downsampling_used'] = True
            if mode == 'forged':
                result['result']['metrics']['mean']['value'] = 0.1
                result['evaluation']['criteria'][0]['value'] = 0.1
            if mode == 'criteria': result['evaluation']['criteria'][0]['threshold'] = 0
            if mode == 'request': result['request_sha256'] = '0' * 64
            with self.assertRaises(ValueError): ci.parse_result(result, request, self.binding)

    def test_ci_source_checker_verifies_bundle_without_execution(self):
        self.register_fixture()
        cells = source_check.cell_index(self.root)
        rows = source_check.registered_bundles(self.root, cells, {('demo', 'gain')})
        self.assertEqual(rows[0]['analysis_status'], 'not_run')
        self.assertFalse(rows[0]['script_executed'])
        self.write(self.path, self.after)
        with self.assertRaises(ValueError):
            source_check.registered_bundles(self.root, cells, {('demo', 'gain')})


if __name__ == '__main__':
    suite = unittest.TestSuite(TestbenchCITest(name) for name in dir(TestbenchCITest) if name.startswith('test_ci_'))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
