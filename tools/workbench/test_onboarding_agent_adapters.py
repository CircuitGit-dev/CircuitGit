"""Actual local adapters over newly authored evidence; no remote execution."""
import hashlib
import json
import time
from unittest.mock import patch

import experiment_workflow
import onboarding_runtime
import runner
import test_onboarding_agent_tb as tb
from test_onboarding_integration import _IntakeFixture,HOST
from waveforms import WaveformError
from workspace import Conflict


class AgentAdapterIntegrationTests(_IntakeFixture):
    imported=tb.AgentTestbenchTests.imported
    draft=tb.AgentTestbenchTests.draft
    agent_prepared=tb.AgentTestbenchTests.agent_prepared
    binding=tb.AgentTestbenchTests.binding

    def test_runtime_cache_hit_rebinds_new_source_but_still_audits_before_preparation(self):
        self.capture['private']['identity']['uid']=1000
        first=self.discover(self.probe(self.imported()))
        receipt=first['discovery']['lut'][0]
        self.assertEqual(receipt['status'],'miss');self.assertEqual(receipt['storage']['status'],'stored')
        second=self.runtime.write('netlist',{'file_name':'changed.scs','text':tb.DUT+'// explicit source revision\n',
            'mode':'agent-tb','support_files':{'stages.scs':tb.SUPPORT}},origin='test_harness')
        second=self.probe(second)
        args={'intake_id':second['intake_id'],'revision':second['revision'],'probe_ids':[second['probes'][0]['probe_id']]}
        with patch('onboarding_discovery.remote_discovery',side_effect=AssertionError('Cache hit must not scan')):
            hit=self.runtime.write('discover-pdk',args,origin='test_harness')
        self.assertEqual(hit['discovery']['lut'][0]['status'],'hit')
        self.assertFalse(hit['discovery']['lut'][0]['scan_performed'])
        self.assertEqual(hit['discovery']['lut'][0]['original_source_sha256'],first['source_sha256'])
        self.assertEqual(hit['discovery']['lut'][0]['rebound_source_sha256'],second['source_sha256'])
        self.assertNotIn(str(self.models),json.dumps(hit['discovery']['lut']))
        selection=self.prepare_args(hit)
        for key in ('intake_id','revision','intent'):selection.pop(key)
        selection['host_ids']=[HOST];draft=self.draft(hit,selection)
        with patch.object(experiment_workflow.ExperimentWorkflow,'_audit',side_effect=self.local_audit) as audit:
            prepared=self.runtime.write('agent-tb/prepare',{'intake_id':draft['intake_id'],'revision':draft['revision'],
                'draft_id':draft['agent_tb']['draft_id']},origin='test_harness')
        audit.assert_called_once();self.assertEqual(prepared['state'],'awaiting_human_review')

    def test_runtime_cache_refresh_and_stale_receipt_trigger_only_explicit_discovery(self):
        import onboarding_lut
        self.capture['private']['identity']['uid']=1000
        state=self.discover(self.probe(self.imported()))
        for refresh in (True,False):
            args={'intake_id':state['intake_id'],'revision':state['revision'],
                'probe_ids':[state['probes'][0]['probe_id']],'refresh':refresh}
            evidence=self.synthetic_discovery(state['source']['requirements'])
            original=onboarding_lut.lookup_discovery
            def lookup(*a,**kw):return original(*a,**kw,now=time.time()+90000)
            with patch('onboarding_lut.lookup_discovery',side_effect=lookup),patch('onboarding_discovery.remote_discovery',return_value=evidence) as scan:
                state=self.runtime.write('discover-pdk',args,origin='test_harness')
            scan.assert_called_once()
            self.assertEqual(state['discovery']['lut'][0]['status'],'refresh_required' if refresh else 'stale')
            self.assertTrue(state['discovery']['lut'][0]['scan_performed'])
        self.ssh.assert_not_called()

    def test_runtime_analysis_uses_original_full_precision_csv_and_named_math(self):
        state=self.agent_prepared();child=self.enable_reservation(state)
        submitted=self.runtime.human_run(self.binding(state),origin='native_host_form');job=submitted['job']['job_id']
        record=child.runner.read(job);record['collection']={'sha256':hashlib.sha256(b'new synthetic saved archive').hexdigest()}
        child.runner.save(record);folder=child.runner.path(job)
        raw=('out X,out Y\n'+''.join(f'{i*1e-9:.17g},{min(i/10,1):.17g}\n' for i in range(25))).encode()
        checksum=hashlib.sha256(raw).hexdigest();(folder/'waveforms.csv').write_bytes(raw)
        runner.atomic(folder/'waveforms.json',{'run_id':job,'source_commit':state['source_commit'],
            'csv_sha256':checksum,'csv_samples':25,'waveforms':[{'name':'out','time_unit':'s','unit':'V'}]})
        runner.atomic(folder/'archive-files.json',[{'path':'./export/waveforms.csv','sha256':checksum,'bytes':len(raw)},
            {'path':'./psf/tran1.tran','sha256':hashlib.sha256(b'synthetic').hexdigest(),'bytes':9}])
        sid=child.waveforms.catalog(job)['signals'][0]['id']
        request={'intake_id':state['intake_id'],'job_id':job,'operation':'tran_metrics',
            'inputs':{'time_s':'@time','values':sid},'parameters':{'backend':'spiceowl','initial':0,'final':1,
                'step_time_s':0,'settling_band':.01,'signal_unit':'V'},
            'criteria':[{'metric':'settling_s','op':'<=','threshold':2e-8,'unit':'s'}]}
        with (patch.object(child.runner,'collect',side_effect=AssertionError('Analysis never collects')),
              patch.object(child.waveforms,'waveform',side_effect=AssertionError('Do not use display sampling'))):
            result=self.runtime.write('analysis',request,origin='test_harness')
        self.assertEqual(result['result']['status'],'valid');self.assertEqual(result['evaluation']['specification_result'],'pass')
        self.assertEqual(result['evaluation_scope'],'exploratory');self.assertFalse(result['changes_original_job_verdict'])
        self.assertTrue(result['input']['full_resolution']);self.assertEqual(result['input']['sample_count'],25)
        self.assertEqual(result['input']['csv_sha256'],checksum);self.assertEqual(result['source_commit'],state['source_commit'])
        report=folder/'analysis'/(result['analysis_id']+'.json')
        self.assertEqual(hashlib.sha256(report.read_bytes()).hexdigest(),result['artifact']['sha256'])
        (folder/'waveforms.csv').write_bytes(b'changed')
        with self.assertRaises(WaveformError):self.runtime.write('analysis',request,origin='test_harness')
        self.ssh.assert_not_called();self.dispatch.assert_not_called()

    def test_orphan_projection_is_read_only_and_prevents_busy_poll_or_remote_replay(self):
        state=self.imported();folder,active=self.runtime._begin({'intake_id':state['intake_id'],'revision':state['revision']},'probe')
        self.assertEqual(self.runtime.read('session',{'intake_id':state['intake_id']})['state'],'probe')
        before=(folder/'session.json').read_bytes()
        restored=onboarding_runtime.OnboardingRuntime(self.app)
        stopped=restored.read('session',{'intake_id':state['intake_id']})
        self.assertEqual(stopped['state'],'recovery_required');self.assertEqual(stopped['recovery']['operation'],'probe')
        self.assertFalse(stopped['next_actions'][0]['ready']);self.assertFalse(stopped['recovery']['automatic_retry'])
        self.assertEqual((folder/'session.json').read_bytes(),before)
        with self.assertRaises(Conflict):restored.write('probe',{'intake_id':state['intake_id'],
            'revision':active['revision'],'ssh_targets':[HOST]},origin='test_harness')
        self.capture_call.assert_not_called();self.ssh.assert_not_called()

    def test_prepare_exception_loses_live_owner_and_requires_human_recovery(self):
        state=self.discover(self.probe(self.imported()));selection=self.prepare_args(state)
        for key in ('intake_id','revision','intent'):selection.pop(key)
        selection['host_ids']=[HOST];state=self.draft(state,selection)
        with patch('onboarding_prepare.create_child_config',side_effect=ValueError('synthetic interrupted materialization')):
            with self.assertRaises(ValueError):self.runtime.write('agent-tb/prepare',{'intake_id':state['intake_id'],
                'revision':state['revision'],'draft_id':state['agent_tb']['draft_id']},origin='test_harness')
        current=self.runtime.read('session',{'intake_id':state['intake_id']})
        self.assertEqual(current['state'],'recovery_required')
        self.assertEqual(current['recovery']['operation'],'agent-tb/prepare')
        self.assertFalse(current['next_actions'][0]['ready']);self.ssh.assert_not_called()

    def test_orphan_submitting_keeps_original_key_and_forbids_run_replay(self):
        state=self.agent_prepared();child=self.enable_reservation(state)
        self.runtime._begin({'intake_id':state['intake_id'],'revision':state['revision']},'submitting')
        self.runtime._active_operations.clear()
        current=self.runtime.read('session',{'intake_id':state['intake_id']})
        self.assertEqual(current['state'],'recovery_required')
        self.assertEqual(current['next_actions'][0]['operation'],'submission')
        with self.assertRaises(Conflict):self.runtime.write('run',{'intake_id':state['intake_id'],
            'revision':current['revision'],'plan_id':state['prepared']['plan_id']},origin='test_harness')
        receipt=self.runtime.read('submission',{'intake_id':state['intake_id'],'plan_id':state['prepared']['plan_id']})
        self.assertFalse(receipt['found']);self.assertFalse(receipt['replay_permitted'])
        self.assertEqual(receipt['submission_key'],state['prepared']['submission_key']);self.reserve.assert_not_called()
