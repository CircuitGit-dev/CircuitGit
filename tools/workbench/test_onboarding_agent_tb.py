"""Synthetic agent-TB flow: exact bytes, human review, and one original run key."""
import copy
import hashlib
import hmac
import http.client
import json
from pathlib import Path
import re
import threading
import time
import unittest
from unittest.mock import patch

import experiment_workflow
import onboarding_runtime
import server
from onboarding_review import BINDING_FIELDS,verify_authorization,HUMAN_RUN_PATH,DOMAIN
from onboarding_testbench import validate_manifest,validate_selection,draft_record,validate_authored_testbench
from test_onboarding_integration import _IntakeFixture,HOST,SECRET
from workspace import Conflict

DUT='''simulator lang=spectre
include "stages.scs"
subckt folded_stage A Z B G
Xfirst (A MID B G) gain_unit
Xsecond (MID Z B G) gain_unit
Cload (Z G) capacitor c=2p
ends folded_stage
'''
SUPPORT='''simulator lang=spectre
subckt gain_unit A Z B G
M1 (Z A G G) device_alpha w=2u l=200n
M2 (Z B B B) device_beta w=4u l=200n
M3 (A A G G) device_alpha w=1u l=200n
ends gain_unit
'''
TB='''simulator lang=spectre
include "pdk.scs"
include "dut.scs"
Vrail (vdd 0) vsource dc=1.2
Vinput (in 0) vsource dc=0.6
XU (in out vdd 0) folded_stage
tran1 tran stop=20n maxstep=20p
save in out vdd
'''

def manifest(text=TB):
    return {'schema':'ic.agent_testbench.v1','text':text,
        'interface':{'subckt':'folded_stage','instance':'XU','port_bindings':{'A':'in','Z':'out','B':'vdd','G':'0'}},
        'analyses':[{'name':'tran1','kind':'tran','parameters':{'stop':'20n','maxstep':'20p'}}],
        'stimuli':[{'name':'Vinput','description':'Explicit 0.6 V source'}],
        'objectives':['Observe the authored multi-stage DUT settling response'],
        'criteria':[{'metric':'settled_output','range_v':[0,1.2]}],
        'postprocess':{'program':'Documented authored analysis retained for review; not executed here'}}


class AgentTestbenchTests(_IntakeFixture):
    def test_helpers_bind_exact_bytes_and_cannot_shadow_source_support(self):
        state=self.imported();folder=self.runtime._folder(state['intake_id'])
        authored=manifest();authored['helper_files']={'stimulus.scs':'// exact reviewed helper\n'}
        first=draft_record(folder,state,authored,None)
        self.assertEqual(first['helper_sha256'],{'stimulus.scs':hashlib.sha256(authored['helper_files']['stimulus.scs'].encode()).hexdigest()})
        authored['helper_files']['stimulus.scs']+='// changed\n'
        self.assertNotEqual(first['draft_id'],draft_record(folder,state,authored,None)['draft_id'])
        for name in ('stages.scs','STAGES.SCS','stages.scs/child.va'):
            authored['helper_files']={name:'// conflicting bytes\n'}
            with self.assertRaises(ValueError):draft_record(folder,state,authored,None)
        self.ssh.assert_not_called()

    def imported(self):
        return self.runtime.write('netlist',{'file_name':'gain.scs','text':DUT,'mode':'agent-tb',
            'support_files':{'stages.scs':SUPPORT}},origin='test_harness')

    def draft(self,state=None,selection=None,authored=None):
        state=state or self.imported()
        return self.runtime.write('agent-tb/draft',{'intake_id':state['intake_id'],'revision':state['revision'],
            'testbench':authored or manifest(),'selection':selection},origin='test_harness')

    def agent_prepared(self):
        state=self.discover(self.probe(self.imported()))
        selection=self.prepare_args(state)
        for key in ('intake_id','revision','intent'):selection.pop(key)
        selection['host_ids']=[HOST]
        state=self.draft(state,selection)
        with patch.object(experiment_workflow.ExperimentWorkflow,'_audit',side_effect=self.local_audit):
            result=self.runtime.write('agent-tb/prepare',{'intake_id':state['intake_id'],'revision':state['revision'],
                'draft_id':state['agent_tb']['draft_id']},origin='test_harness')
        self.assertEqual(result['prepared']['state'],'prepared',result['prepared'])
        return result

    def binding(self,state):return {k:state['agent_tb_review'][k] for k in BINDING_FIELDS}

    def test_arbitrary_hierarchy_draft_before_connection_and_no_execution(self):
        state=self.draft(selection={})
        self.assertEqual(state['agent_tb']['testbench'],manifest())
        self.assertIsNone(state['agent_tb']['selection'])
        self.assertEqual(state['source']['requirements']['required_masters'],['device_alpha','device_beta'])
        self.assertEqual(self.runtime.read('agent-tb',{'intake_id':state['intake_id']}),state)
        blocked=self.runtime.write('agent-tb/prepare',{'intake_id':state['intake_id'],'revision':state['revision'],
            'draft_id':state['agent_tb']['draft_id']},origin='test_harness')
        self.assertEqual(blocked['prepared']['missing'][0]['code'],'selection_missing')
        self.process.assert_not_called();self.ssh.assert_not_called();self.doctor.assert_not_called()

    def test_bounded_source_read_preserves_hierarchy_and_detects_tampering(self):
        state=self.imported();args={'intake_id':state['intake_id']}
        read=self.runtime.read('source',args)
        self.assertEqual(read['source']['text'],DUT)
        self.assertEqual(read['support_files']['stages.scs']['text'],SUPPORT)
        self.assertEqual(read['revision'],state['revision'])
        with self.assertRaises(ValueError):self.runtime.read('source',{**args,'path':'/arbitrary'})
        (self.runtime._folder(state['intake_id'])/'support/stages.scs').write_text('changed')
        with self.assertRaises(ValueError):self.runtime.read('source',args)
        self.process.assert_not_called();self.ssh.assert_not_called();self.doctor.assert_not_called()

    def test_preparation_preserves_all_authored_bytes_and_freezes_full_review(self):
        state=self.agent_prepared();self.assertEqual(state['state'],'awaiting_human_review')
        child=self.child_for(state);plan=self.runtime._plan_row(self.runtime._load(state['intake_id']),state['prepared']['plan_id'])
        frozen=experiment_workflow.ExperimentWorkflow(child.simulation).plan(plan['plan_id'],plan['project_id'])
        root=Path(frozen['bundle_path']).parent
        self.assertEqual((root/'netlist/tb.scs').read_bytes(),TB.encode())
        self.assertEqual((root/'netlist/dut.scs').read_bytes(),DUT.encode())
        self.assertEqual((root/'netlist/stages.scs').read_bytes(),SUPPORT.encode())
        self.assertEqual(frozen['recipe']['spec']['criteria'],manifest())
        self.assertEqual(frozen['recipe']['used_models'],['device_alpha','device_beta'])
        review=self.runtime.read('agent-tb/review',{'intake_id':state['intake_id'],'review_id':state['agent_tb_review']['review_id']})
        self.assertEqual(review['snapshot']['testbench'],manifest())
        self.assertEqual(state['plans'][-1]['review_id'],review['review_id'])
        self.assertEqual(state['plans'][-1]['review_digest'],review['review_digest'])
        self.assertEqual(state['plans'][-1]['testbench_sha256'],hashlib.sha256(TB.encode()).hexdigest())
        self.assertTrue(review['snapshot']['dependency_audit']['files'])
        self.assertNotIn(SECRET,json.dumps(review))
        self.assertNotIn('key_file',json.dumps(state));self.assertNotIn('authority',json.dumps(state))
        self.ssh.assert_not_called();self.doctor.assert_not_called()

    def test_model_run_rejected_then_native_review_runs_original_once(self):
        state=self.agent_prepared();self.enable_reservation(state)
        with self.assertRaises(PermissionError):self.submit_intake(state)
        self.reserve.assert_not_called()
        with self.assertRaises(PermissionError):self.runtime.human_run(self.binding(state),origin='native_agent')
        result=self.runtime.human_run(self.binding(state),origin='native_host_form')
        self.assertEqual(result['state'],'submitted');self.assertEqual(self.reserve.call_count,1)
        again=self.runtime.human_run(self.binding(state),origin='native_host_form')
        self.assertEqual(result['job']['job_id'],again['job']['job_id']);self.assertEqual(self.reserve.call_count,1)
        self.assertEqual(len(self.executor.calls),1)

    def test_browser_form_one_use_and_denial_never_dispatches(self):
        state=self.agent_prepared();self.enable_reservation(state)
        body,_=self.runtime.reviews.browser_page(state['intake_id'],state['agent_tb_review']['review_id'])
        form=json.loads(re.search(r'const binding=(\{[^;]+\});',body.decode())[1])
        result=self.runtime.reviews.browser_decision({**form,'decision':'deny'})
        self.assertEqual(result['state'],'review_denied')
        with self.assertRaises(PermissionError):self.runtime.reviews.browser_decision({**form,'decision':'run'})
        with self.assertRaises(Conflict):self.runtime.human_run(self.binding(state),origin='native_host_form')
        self.reserve.assert_not_called()

    def test_source_support_site_and_manifest_changes_cannot_reuse_review(self):
        for kind in ('source','support','site','manifest','frozen_tb'):
            with self.subTest(kind=kind):
                state=self.agent_prepared();self.enable_reservation(state)
                folder=self.runtime._folder(state['intake_id'])
                if kind=='source':(folder/'source.scs').write_text(DUT+'// changed\n')
                elif kind=='support':(folder/'support/stages.scs').write_text(SUPPORT+'// changed\n')
                elif kind=='site':
                    row=self.runtime._plan_row(self.runtime._load(state['intake_id']),state['prepared']['plan_id'])
                    (folder/'prepared'/str(row['child_revision'])/(HOST+'.site.json')).write_text('{}')
                elif kind=='frozen_tb':
                    child=self.child_for(state)
                    frozen=experiment_workflow.ExperimentWorkflow(child.simulation).plan(state['prepared']['plan_id'],state['intake_id'])
                    (Path(frozen['bundle_path']).parent/'netlist/tb.scs').write_text(TB+'// changed\n')
                else:
                    updated=manifest();updated['criteria']=[{'metric':'new_author_intent'}]
                    self.draft(state,state['agent_tb']['selection'],updated)
                with self.assertRaises((ValueError,Conflict,PermissionError)):
                    self.runtime.human_run(self.binding(state),origin='native_host_form')
                self.reserve.assert_not_called()

    def test_unknown_submission_is_only_reconciled(self):
        state=self.agent_prepared();child=self.enable_reservation(state)
        with patch.object(child.simulation,'control',side_effect=TimeoutError('synthetic lost reply')) as control:
            with self.assertRaises(TimeoutError):self.runtime.human_run(self.binding(state),origin='native_host_form')
        self.assertEqual(control.call_count,1)
        again=self.runtime.human_run(self.binding(state),origin='native_host_form')
        self.assertEqual(again['submission']['dispatch_outcome'],'unknown')
        self.assertFalse(again['submission']['replay_permitted']);self.reserve.assert_not_called()

    def test_approved_submission_after_reload_keeps_original_job(self):
        state=self.agent_prepared();self.enable_reservation(state)
        first=self.runtime.human_run(self.binding(state),origin='native_host_form')
        self.runtime.close();self.app.onboarding=onboarding_runtime.OnboardingRuntime(self.app);self.runtime=self.app.onboarding
        current=self.runtime._load(state['intake_id']);plan=self.runtime._plan_row(current,state['prepared']['plan_id'])
        child=self.runtime._child(current,plan)
        with patch.object(child.runner,'reserve',side_effect=AssertionError('Never reserve after reload')):
            result=self.runtime.human_run(self.binding(state),origin='native_host_form')
        self.assertEqual(result['job']['job_id'],first['job']['job_id'])

    def test_historical_job_retains_original_review_after_new_draft(self):
        state=self.agent_prepared();self.enable_reservation(state)
        first=self.runtime.human_run(self.binding(state),origin='native_host_form')
        authored=manifest();authored['objectives']=['A newly authored different objective']
        newer=self.draft(first,first['agent_tb']['selection'],authored)
        original=next(p for p in newer['plans'] if p.get('job_id')==first['job']['job_id'])
        read=self.runtime.read('agent-tb/review',{'intake_id':first['intake_id'],'review_id':original['review_id']})
        self.assertEqual(read['snapshot']['testbench'],manifest())
        self.assertEqual(read['review_digest'],original['review_digest'])
        self.assertNotEqual(newer['agent_tb']['testbench'],read['snapshot']['testbench'])

    def test_actual_http_human_signature_and_browser_form_boundary(self):
        state=self.agent_prepared();self.enable_reservation(state)
        listener=server.Server(('127.0.0.1',0),server.Handler);listener.app=self.app
        thread=threading.Thread(target=lambda:listener.serve_forever(poll_interval=.01),daemon=True);thread.start()
        self.addCleanup(lambda:(listener.shutdown(),listener.server_close(),thread.join(2)))
        origin='http://127.0.0.1:'+str(listener.server_port)
        def request(path,method='GET',raw=None,extra=None):
            headers={'Origin':origin,'Content-Type':'application/json','X-Workbench-Token':self.app.token,
                'Connection':'close',**(extra or {})}
            connection=http.client.HTTPConnection('127.0.0.1',listener.server_port,timeout=5)
            try:
                connection.request(method,path,raw,headers)
                response=connection.getresponse();body=response.read()
                return response.status,body,dict(response.getheaders())
            finally:connection.close()
        review_path=state['agent_tb_review']['review_path']
        status,body,headers=request(review_path)
        self.assertEqual(status,200);self.assertIn("frame-ancestors 'none'",headers['Content-Security-Policy'])
        form=json.loads(re.search(r'const binding=(\{[^;]+\});',body.decode())[1])
        raw=json.dumps({**form,'decision':'run'}).encode()
        status,_,_=request('/agent-tb/review/confirm','POST',raw,{'Origin':'https://untrusted.invalid'})
        self.assertEqual(status,403);self.reserve.assert_not_called()
        raw=json.dumps(self.binding(state)).encode()
        status,_,_=request(HUMAN_RUN_PATH,'POST',raw)
        self.assertEqual(status,403)
        ts=str(int(time.time()));message=json.dumps([DOMAIN,'POST',HUMAN_RUN_PATH,
            hashlib.sha256(raw).hexdigest(),ts],separators=(',',':')).encode()
        proof=ts+'.'+hmac.new(self.runtime.reviews.key,message,hashlib.sha256).hexdigest()
        status,_,_=request(HUMAN_RUN_PATH,'POST',raw+b' ',{'X-IC-Human-Review':proof})
        self.assertEqual(status,403);self.reserve.assert_not_called()
        status,body,_=request(HUMAN_RUN_PATH,'POST',raw,{'X-IC-Human-Review':proof})
        self.assertEqual(status,200,body);self.assertEqual(self.reserve.call_count,1)
        status,body,_=request(HUMAN_RUN_PATH,'POST',raw,{'X-IC-Human-Review':proof})
        self.assertEqual(status,200,body);self.assertEqual(self.reserve.call_count,1)

    def test_static_interface_and_analysis_mismatch_never_prepares_or_runs(self):
        state=self.discover(self.probe(self.imported()));selection=self.prepare_args(state)
        for key in ('intake_id','revision','intent'):selection.pop(key)
        selection['host_ids']=[HOST]
        authored=manifest();authored['interface']['port_bindings']['Z']='in'
        authored['analyses'][0]['name']='different'
        state=self.draft(state,selection,authored)
        result=self.runtime.write('agent-tb/prepare',{'intake_id':state['intake_id'],'revision':state['revision'],
            'draft_id':state['agent_tb']['draft_id']},origin='test_harness')
        self.assertEqual(result['prepared']['state'],'blocked')
        self.assertTrue({'dut_binding_mismatch','analysis_manifest_mismatch'}<={row['code'] for row in result['prepared']['missing']})
        self.process.assert_not_called();self.ssh.assert_not_called();self.doctor.assert_not_called()


class ManifestAndNativeProofTests(unittest.TestCase):
    def test_named_scalar_waveform_validity_is_independent_of_scientific_pass(self):
        raw=('HEADER\n"PSF sweep points" 2\nTYPE\n"t" FLOAT DOUBLE PROP("units" "s")\n'
            '"v" FLOAT DOUBLE PROP("units" "V")\nSWEEP\n"time" "t"\nTRACE\n"out" "v"\n'
            'VALUE\n"time" 0\n"out" 3\n"time" 1e-9\n"out" 4\nEND\n').encode()
        recipe={'recipe_sha256':'a'*64,'spec':{'criteria':manifest()}}
        result=experiment_workflow.ExperimentWorkflow._measure_agent_artifacts(
            {'settle':{'name':'settle','kind':'tran','matches':1,'raw':raw}},recipe,'completed',0)
        self.assertEqual(result['data_validity'],'valid');self.assertEqual(result['specification'],'unknown')
        self.assertEqual(result['analyses'][0]['sample_count'],2)
        self.assertEqual(result['analyses'][0]['signal_names'],['time','out'])

    def test_generic_named_results_never_apply_inverter_criteria(self):
        recipe={'recipe_sha256':'a'*64,'spec':{'criteria':manifest()}}
        artifacts={'acgain':{'name':'acgain','kind':'ac','raw':b'original AC artifact','sha256':'b'*64,'matches':1},
            'settling':{'name':'settling','kind':'tran','matches':0}}
        result=experiment_workflow.ExperimentWorkflow._measure_agent_artifacts(artifacts,recipe,'completed',0)
        self.assertEqual(result['specification'],'unknown');self.assertEqual(result['data_validity'],'unknown')
        self.assertEqual(result['scientific_evaluation'],'not_evaluated')
        self.assertEqual(result['authored_criteria'],manifest()['criteria'])
        self.assertEqual([r['name'] for r in result['analyses']],['acgain','settling'])
        self.assertNotIn('raw',json.dumps(result));self.assertIsNone(result['overall_qualified_acceptance'])

    def test_finite_authored_manifest_and_selection(self):
        self.assertEqual(validate_manifest(manifest()),manifest())
        for key,value in [('postprocess',{'value':float('nan')}),('analyses',[{'name':'tran1','kind':'noise','parameters':{}}])]:
            authored=manifest();authored[key]=value
            with self.assertRaises(ValueError):validate_manifest(authored)
        with self.assertRaises(ValueError):validate_selection({'host_ids':[{}]})

    def test_human_authority_binds_exact_body_route_key_and_time(self):
        key=b'a'*32;raw=b'{"intake_id":"synthetic"}';now=1770000000;ts=str(now)
        def sign(path=HUMAN_RUN_PATH):
            message=json.dumps([DOMAIN,'POST',path,hashlib.sha256(raw).hexdigest(),ts],separators=(',',':')).encode()
            return ts+'.'+hmac.new(key,message,hashlib.sha256).hexdigest()
        verify_authorization(key,raw,sign(),now=now)
        for args in ((b'b'*32,raw,sign(),now),(key,raw+b' ',sign(),now),
                     (key,raw,sign('/other'),now),(key,raw,sign(),now+121)):
            with self.assertRaises(PermissionError):verify_authorization(*args[:3],now=args[3])


if __name__=='__main__':unittest.main()
