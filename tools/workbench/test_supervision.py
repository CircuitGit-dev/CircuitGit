"""Synthetic saved runs through real loopback HTTP; never invokes a simulator or model."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.parse import quote
import runner
import ic_sim
import test_backend

class SupervisionTests(unittest.TestCase):
    setUp = test_backend.BackendTests.setUp
    tearDown = test_backend.BackendTests.tearDown
    request = test_backend.BackendTests.request

    def record(self, rid='20261120T010000Z-synthetic', **changes):
        value={'run_id':rid,'schema':'ic.sim.run.v2','project_id':'demo','source_commit':'a'*40,
            'configuration_id':'tran','state':'simulator_complete_pending_measurements',
            'remote_state':'simulator_complete_pending_measurements','simulator_exit_code':0,
            'observed_at':'2026-10-01T00:00:00+00:00','plan':{'design_id':'demo','configuration':{}},
            'ssh_target':'PRIVATE_REMOTE','remote_directory':'/PRIVATE/path','collection':None,'synthetic':True}
        value.update(changes);self.app.runner.save(value);return value

    def snapshots(self):
        return {str(p.relative_to(self.app.runner.root)):(p.stat().st_mtime_ns,p.read_bytes())
                for p in self.app.runner.root.rglob('*') if p.is_file() and not p.is_symlink()}

    def test_passive_http_preserves_all_state_and_redacts_execution_configuration(self):
        self.record();before=self.snapshots()
        with patch.object(ic_sim,'ssh',side_effect=AssertionError('No SSH')), \
             patch.object(self.app.runner,'status',side_effect=AssertionError('No active status')), \
             patch.object(self.app.runner,'dispatch',side_effect=AssertionError('No dispatch')), \
             patch.object(self.app.runner,'collect',side_effect=AssertionError('No collection')):
            status,result=self.request('/api/supervision?project_id=demo')
        self.assertEqual(status,200);data=result['data'];run=data['runs'][0]
        self.assertEqual(data['schema'],'ic.supervision.snapshot.v1');self.assertEqual(data['source'],'stored_observations')
        self.assertEqual(run['latest_observed_at'],'2026-10-01T00:00:00+00:00')
        self.assertNotEqual(run['latest_observed_at'],data['read_at'])
        self.assertEqual(run['execution']['state'],'succeeded');self.assertEqual(run['specification']['state'],'not_evaluated')
        self.assertNotIn('PRIVATE',json.dumps(data));self.assertEqual(self.snapshots(),before)
        self.assertIn('synthetic_fixture',[issue['code'] for issue in run['issues']])

    def test_legacy_alias_preserves_original_source_and_missing_hash(self):
        self.record(project_id='old-alias')
        _,result=self.request('/api/supervision?project_id=demo');run=result['data']['runs'][0]
        self.assertEqual(run['project_id'],'demo');self.assertEqual(run['original_project_id'],'old-alias')
        self.assertEqual(run['association_basis'],'recorded_plan_design_id')
        self.assertEqual(run['source_commit'],'a'*40);self.assertIsNone(run['compiled_inputs_sha256'])
        self.assertNotEqual(run['source_commit'],self.app.workspace.head())

    def test_recorded_project_takes_precedence_over_other_design_alias(self):
        self.app.workspace.projects['second']={}
        self.record(project_id='second',plan={'design_id':'demo'})
        self.assertEqual(self.request('/api/supervision?project_id=demo')[1]['data']['runs'],[])
        run=self.request('/api/supervision?project_id=second')[1]['data']['runs'][0]
        self.assertEqual(run['association_basis'],'recorded_project_id')

    def test_submission_lookup_is_read_only_and_supports_encoded_keys(self):
        r=self.record();key='caller/key % title'
        runner.atomic(self.app.runner.root/'keys.json',{key:{'run_id':r['run_id'],'fingerprint':'b'*64}})
        before=self.snapshots()
        with patch.object(self.app.runner,'reserve',side_effect=AssertionError('No reserve')):
            status,result=self.request('/api/submissions/'+quote(key,safe=''))
        self.assertEqual(status,200);self.assertTrue(result['data']['found'])
        self.assertEqual(result['data']['run_id'],r['run_id']);self.assertEqual(result['data']['submission_key'],key)
        self.assertEqual(self.snapshots(),before)
        self.assertEqual(self.request('/api/submissions/missing-key')[1]['data']['found'],False)

    def test_missing_index_never_creates_files_or_locks(self):
        before=self.snapshots();status,result=self.request('/api/submissions/missing-key')
        self.assertEqual(status,200);self.assertFalse(result['data']['found']);self.assertIsNone(result['data']['run'])
        self.assertEqual(self.snapshots(),before)

    def test_damaged_known_mapping_is_a_conflict_not_a_missing_submission(self):
        runner.atomic(self.app.runner.root/'keys.json',{'known-key':{'run_id':'absent-run','fingerprint':'b'*64}})
        status,result=self.request('/api/submissions/known-key')
        self.assertEqual(status,409);self.assertEqual(result['error']['code'],'conflict')
        self.assertIn('do not resubmit',result['error']['message'])

    def test_artifact_and_waveform_identity_require_exact_saved_evidence(self):
        r=self.record(collection={'contains_full_raw':True,'sha256':'c'*64},collection_phase='complete')
        folder=self.app.runner.path(r['run_id']);(folder/'full-results.tar.gz').write_bytes(b'synthetic')
        runner.atomic(folder/'waveforms.json',{'run_id':r['run_id'],'source_commit':'b'*40})
        run=self.request('/api/supervision?project_id=demo')[1]['data']['runs'][0]
        self.assertIsNone(run['waveform_run_id']);self.assertEqual(run['data']['state'],'collected')
        archive=next(a for a in run['artifacts'] if a['name']=='full-results.tar.gz')
        self.assertEqual(archive['sha256'],'c'*64);self.assertEqual(archive['digest_source'],'stored_record')
        runner.atomic(folder/'waveforms.json',{'run_id':r['run_id'],'source_commit':'a'*40})
        self.assertEqual(self.request('/api/supervision?project_id=demo')[1]['data']['runs'][0]['waveform_run_id'],r['run_id'])

    def test_missing_observation_and_metric_scope_are_not_invented(self):
        self.record(observed_at=None,simulator_exit_code=None,scientific_metrics=[{'name':'metric','value':.1,'passed':True,'scope':'one node'}])
        run=self.request('/api/supervision?project_id=demo')[1]['data']['runs'][0]
        self.assertEqual(run['execution']['state'],'unknown');self.assertEqual(run['observation']['state'],'missing')
        self.assertIsNone(run['latest_observed_at']);self.assertEqual(run['specification']['state'],'reported')
        self.assertEqual(run['specification']['metrics'][0]['scope'],'one node');self.assertNotIn('passed',run['specification'])

    def test_bad_and_symlinked_records_are_reported_as_unavailable(self):
        self.record();folder=self.app.runner.root/'bad-run';folder.mkdir();(folder/'run.json').write_text('{')
        external=self.root/'external-run';external.mkdir();(external/'run.json').write_text('{"run_id":"linked-run","project_id":"demo"}')
        (self.app.runner.root/'linked-run').symlink_to(external,target_is_directory=True)
        data=self.request('/api/supervision?project_id=demo')[1]['data']
        self.assertEqual(len(data['runs']),1);self.assertGreaterEqual(data['unavailable_records'],2)
        self.assertEqual(self.request('/api/submissions/short')[0],400)

    def test_http_query_and_origin_guards(self):
        for path in ('/api/supervision','/api/supervision?project_id=','/api/supervision?project_id=demo&project_id=demo',
                     '/api/supervision?project_id=demo&active=1','/api/submissions/missing-key?submit=true'):
            with self.subTest(path=path):self.assertEqual(self.request(path)[0],400)
        self.assertEqual(self.request('/api/supervision?project_id=unknown')[0],404)
        self.assertEqual(self.request('/api/supervision?project_id=demo',headers={'Host':'evil.invalid'})[0],403)

    def test_bounds_report_incomplete_coverage(self):
        for i in range(26):self.record('synthetic-%03d'%i)
        data=self.request('/api/supervision?project_id=demo')[1]['data']
        self.assertEqual(len(data['runs']),25);self.assertTrue(data['truncated']);self.assertEqual(data['scanned_records'],26)

if __name__=='__main__':unittest.main(verbosity=2)
