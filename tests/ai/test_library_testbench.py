"""Synthetic end-to-end library tools + real Git + finite mocked gateway only."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'apps/codex'), str(ROOT / 'tests/library')]
import test_testbench_ci as fixtures
from icwb.library import call
from icwb.service import Service, Failure
from icwb.library_analysis import _electrical_support


class LibraryTestbenchTools(unittest.TestCase):
    def setUp(self):
        self.seed = fixtures.TestbenchCITest()
        self.seed.setUp(); self.addCleanup(self.seed.doCleanups)
        self.seed.register_fixture()
        self.workflow = self.seed.workflow
        self.seed.binding['intake_id'] = 'intake_' + 'a' * 32
        self.args = {key: self.seed.binding[key] for key in
                     ('library_id', 'cell_id', 'testbench_id', 'registration_commit', 'intake_id', 'job_id')}
        self.config = {'gateway_url': 'http://127.0.0.1:1', 'state_dir': str(self.seed.root / '.local/agent'),
                       'library_workspace': str(self.seed.root), 'library_repository': 'fixture/circuits',
                       'library_access': 'direct', 'library_state_dir': str(self.workflow.state)}
        self.service = Service(self.config); self.service.library_workflow = self.workflow
        self.make_evidence()
        self.service.call = Mock(side_effect=self.gateway)

    def make_evidence(self, support=None):
        bundle = self.workflow.get_testbenches('demo', 'gain')['bundles'][0]
        record = json.loads(self.workflow._blob(self.workflow._head(), bundle['manifest_path']))
        base = 'projects/' + self.args['intake_id'] + '/'
        contents = {base + 'dut.scs': self.workflow._blob(self.workflow._head(), self.seed.path).decode(),
                    base + 'tb.scs': record['agent_manifest']['text'], base + 'agent-testbench.json': json.dumps(record['agent_manifest'])}
        contents.update({base + 'support/' + name: text for name, text in (support or {}).items()})
        files = {path: {'text': text, 'sha256': hashlib.sha256(text.encode()).hexdigest()} for path, text in contents.items()}
        snapshot = {'schema': 'ic.agent-tb.review-snapshot.v1', 'source_commit': self.seed.binding['source_commit'],
                    'original_source_sha256': self.seed.binding['original_source_sha256'],
                    'testbench': record['agent_manifest'], 'files': files}
        digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
        plan = {'job_id': self.args['job_id'], 'plan_id': 'f' * 64, 'review_id': 'e' * 64,
                'review_digest': digest, 'source_commit': self.seed.binding['source_commit'],
                'testbench_sha256': record['binding']['testbench_sha256']}
        self.session = {'mode': 'agent-tb', 'intake_id': self.args['intake_id'],
                        'source_sha256': self.seed.binding['original_source_sha256'], 'plans': [plan],
                        'support_files': {name: {'sha256': hashlib.sha256(text.encode()).hexdigest()} for name, text in (support or {}).items()},
                        # An unrelated current draft must not substitute for this historical job.
                        'agent_tb': {'draft_id': 'unrelated-new-draft'}, 'prepared': {'plan_id': 'unrelated-new-plan'}}
        self.review = {'state': 'approved', 'plan_id': plan['plan_id'], 'review_id': plan['review_id'],
                       'review_digest': digest, 'snapshot': snapshot}
        hashes = {name: row['sha256'] for name, row in files.items()}
        self.seed.binding['archive_source_hashes'] = hashes
        self.catalog = {**{key: self.seed.binding[key] for key in
                           ('intake_id', 'job_id', 'source_commit', 'original_source_sha256', 'archive_sha256')},
                        'catalog': {'run_id': self.args['job_id'], 'source_commit': plan['source_commit'],
                                    'archive_sha256': self.seed.binding['archive_sha256'], 'source_hashes': hashes,
                                    'signals': self.seed.binding['signal_catalog']['signals']}}

    def gateway(self, operation, arguments):
        if operation == 'onboarding_session': return copy.deepcopy(self.session)
        if operation == 'onboarding_agent_tb_review':
            self.assertEqual(arguments['review_id'], self.session['plans'][0]['review_id'])
            return copy.deepcopy(self.review)
        if operation == 'onboarding_waveforms_catalog': return copy.deepcopy(self.catalog)
        if operation == 'onboarding_analysis':
            result = self.seed.result(arguments)
            result['input']['source_hashes'] = self.seed.binding['archive_source_hashes']
            return result
        raise AssertionError('Unexpected gateway/SSH/solver operation: ' + operation)

    def analyze(self, **changes):
        return call(self.service, 'ic_library_analyze_testbench', {**self.args, **changes})

    def test_registered_tool_runs_exact_historical_analysis_and_reconciles(self):
        result = self.analyze()
        self.assertEqual(result['status'], 'passed'); self.assertTrue(result['synthetic'])
        self.assertFalse(result['simulation_started']); self.assertFalse(result['script_executed'])
        self.assertEqual(self.analyze(), result)
        methods = [row.args[0] for row in self.service.call.call_args_list]
        self.assertEqual(methods.count('onboarding_analysis'), 1)
        self.assertEqual(set(methods), {'onboarding_session', 'onboarding_agent_tb_review', 'onboarding_waveforms_catalog', 'onboarding_analysis'})
        self.assertEqual(call(self.service, 'ic_library_read', {'operation': 'get_testbench_result', 'arguments': {
            'library_id': 'demo', 'cell_id': 'gain', 'testbench_id': 'gain-tran', 'result_id': result['result_id']}}), result)

    def test_tool_rejects_unapproved_review_current_draft_substitution_and_archive_mismatch(self):
        original = copy.deepcopy((self.review, self.catalog, self.session))
        for mode in ('unapproved', 'other_manifest', 'digest', 'nested_job', 'nested_commit', 'archive', 'compiled_source', 'unknown_job'):
            self.review, self.catalog, self.session = copy.deepcopy(original)
            if mode == 'unapproved': self.review['state'] = 'pending'
            if mode == 'other_manifest': self.review['snapshot']['testbench']['text'] += '\n// other draft'
            if mode == 'digest': self.review['review_digest'] = '0' * 64
            if mode == 'nested_job': self.catalog['catalog']['run_id'] = 'another-job'
            if mode == 'nested_commit': self.catalog['catalog']['source_commit'] = '0' * 40
            if mode == 'archive': self.catalog['catalog']['archive_sha256'] = '0' * 64
            if mode == 'compiled_source': self.catalog['catalog']['source_hashes'].clear()
            if mode == 'unknown_job': self.session['plans'][0]['job_id'] = 'another-job'
            with self.subTest(mode=mode), self.assertRaises(Failure): self.analyze()
        self.assertFalse(any(row.args[0] == 'onboarding_analysis' for row in self.service.call.call_args_list))

    def test_tool_rejects_runtime_override_and_readonly_before_gateway(self):
        with self.assertRaises(Failure): self.analyze(runtime_binding=self.seed.binding)
        self.service.config['library_access'] = 'read_only'
        with self.assertRaises(Failure): self.analyze()
        self.service.call.assert_not_called()

    def test_tool_proposal_only_freezes_review_and_cannot_register(self):
        args = self.seed.proposal_args()
        args['testbench_id'] = 'second-reviewed-tb'
        before = self.seed.head()
        proposal = call(self.service, 'ic_library_propose_testbench', args)
        self.assertEqual(proposal['registration_status'], 'pending_review')
        self.assertTrue(proposal['human_review_required'])
        self.assertEqual(self.seed.head(), before)
        self.assertFalse((self.seed.root / 'lib/demo/gain/testbenches/second-reviewed-tb').exists())
        with self.assertRaises(Failure):
            call(self.service, 'ic_library_execute', {'operation': 'register_testbench', 'arguments': {
                'library_id': 'demo', 'cell_id': 'gain', 'review_id': proposal['review_id']}, 'idempotency_key': 'agent-cannot-register'})
        self.service.call.assert_not_called()

    def test_tool_matches_aliased_electrical_support_in_original_snapshot(self):
        text = 'include "child.scs" // exact child dependency\n' + self.seed.before
        self.seed.write(self.seed.path, text)
        self.seed.manifest['cells'][0]['views'][0]['aliases'] = {'lib/demo/gain/netlist/child.scs': self.seed.shared}
        self.seed.write('lib/demo/library.json', self.seed.manifest)
        self.seed.git('add', self.seed.path, 'lib/demo/library.json'); self.seed.git('commit', '-m', 'Synthetic include source')
        proposal = self.seed.proposal_args()
        proposal['manifest']['criteria'] = [{'metric': 'mean', 'op': '>=', 'threshold': 0.5, 'unit': 'V'}]
        proposal['manifest']['postprocess'] = {'operation': 'tran_metrics', 'inputs': {'values': {'name': 'out'}},
                                              'parameters': {'backend': 'spiceowl', 'signal_unit': 'V'}}
        review = self.workflow.preview_testbench(**proposal)
        receipt = self.workflow.confirm(review['review_id'], 'human-register-aliased-support')
        self.args['registration_commit'] = receipt['registration_commit']
        self.seed.binding.update(registration_commit=receipt['registration_commit'], original_source_sha256=self.seed.sha(text),
                                 source_sha256=review['payload']['source']['sha256'], source_files=review['payload']['source']['files'])
        self.make_evidence(support={'child.scs': '// shared read-only source\n'})
        self.session['support_files']['child.scs']['sha256'] = '0' * 64
        with self.assertRaises(Failure): self.analyze()
        self.session['support_files']['child.scs']['sha256'] = self.seed.sha('// shared read-only source\n')
        result = self.analyze()
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(sum(row.args[0] == 'onboarding_analysis' for row in self.service.call.call_args_list), 1)

    def test_electrical_support_uses_includes_aliases_and_not_readme_or_geometry(self):
        path = self.seed.path
        text = 'include "child.scs" // only actual dependency\n' + self.seed.before
        self.seed.write(path, text)
        self.seed.manifest['cells'][0]['views'][0]['aliases'] = {'lib/demo/gain/netlist/child.scs': self.seed.shared}
        self.seed.write('lib/demo/library.json', self.seed.manifest)
        self.seed.git('add', path, 'lib/demo/library.json'); self.seed.git('commit', '-m', 'Synthetic include mapping')
        scope = self.workflow._scope('demo', 'gain')
        source = self.workflow._testbench_source(scope)
        self.assertEqual(_electrical_support(self.workflow, scope, path, source['files']), {'child.scs': self.seed.sha('// shared read-only source\n')})
        for bad in ('include "../../../../outside.scs"', 'include computed_path', 'ahdl_include "child.scs"', '/*\ninclude "child.scs"\n*/'):
            self.seed.write(path, bad + '\n' + self.seed.before)
            self.seed.git('add', path); self.seed.git('commit', '-m', 'Synthetic unsupported include')
            scope = self.workflow._scope('demo', 'gain'); source = self.workflow._testbench_source(scope)
            with self.subTest(statement=bad), self.assertRaises((ValueError, Failure)):
                _electrical_support(self.workflow, scope, path, source['files'])


if __name__ == '__main__': unittest.main()
