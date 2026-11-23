"""Synthetic authored VA, observed headers and local staging; no remote solver."""
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import experiment_workflow
from onboarding_veriloga import header_binding,STAGING_ROOT
from test_onboarding_integration import _IntakeFixture,HOST
from test_onboarding_agent_tb import DUT,SUPPORT,TB,manifest,AgentTestbenchTests

CELL='`include "disciplines.vams"\nmodule behavior(p,n);\ninout p,n; electrical p,n;\nanalog I(p,n) <+ V(p,n)/1e12;\nendmodule\n'
HELPER='`include "disciplines.vams"\nmodule source_wave(p,n);\ninout p,n; electrical p,n;\nanalog V(p,n) <+ 0.6;\nendmodule\n'
VA_DUT=DUT.replace('include "stages.scs"','include "stages.scs"\nahdl_include "models/cell.va"').replace('Cload (Z G)', 'Xbehavior (Z G) behavior\nCload (Z G)')
VA_TB=TB.replace('include "dut.scs"','include "dut.scs"\nahdl_include "stimuli/source.va"').replace('Vinput (in 0) vsource dc=0.6','Vinput (in 0) source_wave')


class VerilogAOnboardingTests(_IntakeFixture):
    draft=AgentTestbenchTests.draft

    def observation(self):
        from spiceowl.onboarding.veriloga_headers import build_veriloga_header_probe_script
        self.headers=self.root/'explicit-header-root';self.headers.mkdir(exist_ok=True)
        (self.headers/'types').mkdir(exist_ok=True)
        (self.headers/'constants.vams').write_text('// newly authored synthetic constants fixture\n')
        (self.headers/'disciplines.vams').write_text('`include "types/electrical.vams"\n')
        (self.headers/'types/electrical.vams').write_text('// newly authored synthetic electrical fixture\n')
        output=io.StringIO()
        with contextlib.redirect_stdout(output):exec(build_veriloga_header_probe_script(roots=[str(self.headers)]),{})
        return json.loads(output.getvalue())

    def imported(self):
        return self.runtime.write('netlist',{'file_name':'original.scs','text':VA_DUT,'mode':'agent-tb',
            'support_files':{'stages.scs':SUPPORT,'models/cell.va':CELL}},origin='test_harness')

    def observed(self):
        state=self.discover(self.probe(self.imported()));observation=self.observation()
        with patch('onboarding_veriloga.remote_headers',return_value=observation):
            state=self.runtime.write('veriloga-headers',{'intake_id':state['intake_id'],'revision':state['revision'],
                'probe_id':state['probes'][0]['probe_id'],'roots':[str(self.headers)]},origin='test_harness')
        return state,observation

    def selected(self,state,include_header=True):
        selection=self.prepare_args(state)
        for key in ('intake_id','revision','intent'):selection.pop(key)
        selection['host_ids']=[HOST]
        if include_header:selection['veriloga_header_id']=state['veriloga_headers'][0]['id']
        authored=manifest(VA_TB);authored['helper_files']={'stimuli/source.va':HELPER}
        return self.draft(state,selection,authored)

    def prepare(self,state,observed):
        with patch.object(experiment_workflow.ExperimentWorkflow,'_audit',side_effect=self.local_audit), \
             patch.object(experiment_workflow.ExperimentWorkflow,'_audit_headers',return_value=observed):
            return self.runtime.write('agent-tb/prepare',{'intake_id':state['intake_id'],'revision':state['revision'],
                'draft_id':state['agent_tb']['draft_id']},origin='test_harness')

    def test_va_support_helpers_and_headers_have_exact_frozen_roles_before_review(self):
        state,observed=self.observed();public=state['veriloga_headers'][0]
        self.assertNotIn(str(self.headers),json.dumps(public));self.assertFalse(public['ready_to_run'])
        state=self.prepare(self.selected(state),observed)
        self.assertEqual(state['state'],'awaiting_human_review',state.get('prepared'))
        review=self.runtime.reviews.read(state['intake_id'],state['agent_tb_review']['review_id'])
        snapshot=review['snapshot'];base='projects/'+state['intake_id']+'/'
        self.assertEqual(snapshot['files'][base+'dut.scs']['text'],VA_DUT)
        self.assertEqual(snapshot['files'][base+'support/models/cell.va']['text'],CELL)
        self.assertEqual(snapshot['files'][base+'helpers/stimuli/source.va']['text'],HELPER)
        self.assertFalse(any(name.endswith('disciplines.vams') for name in snapshot['files']))
        self.assertEqual(snapshot['veriloga_header_audit']['observation_id'],observed['observation_id'])
        owner=snapshot['recipe']['agent_tb_manifest']
        self.assertEqual(owner['authored_helper_paths'],['stimuli/source.va'])
        self.assertIn('models/cell.va',owner['dut_support_paths'])
        self.assertEqual(review['state'],'pending');self.ssh.assert_not_called()

    def test_runner_prepares_fixed_header_graph_without_reading_or_packaging_header_bytes(self):
        state,observed=self.observed();state=self.prepare(self.selected(state),observed)
        child=self.child_for(state)
        plan=experiment_workflow.ExperimentWorkflow(child.simulation).plan(state['prepared']['plan_id'],state['intake_id'])
        bundle,payload,proof=child.runner.prepare(Path(plan['bundle_path']),site=plan['sites'][HOST])
        self.assertIn(b'../__ic_va_headers__/disciplines.vams',payload['netlist/models/cell.va'])
        self.assertIn(b'../__ic_va_headers__/disciplines.vams',payload['netlist/stimuli/source.va'])
        self.assertFalse(any(name.startswith(STAGING_ROOT+'/') for name in payload))
        self.assertIn(b'veriloga-staged-checksums.log',payload['veriloga-stage.sh'])
        row=next(row for row in proof['files'] if row['destination']=='netlist/models/cell.va')
        self.assertEqual(row['source_sha256'],hashlib.sha256(CELL.encode()).hexdigest())
        self.assertNotEqual(row['source_sha256'],row['staged_sha256'])
        broken=copy.deepcopy(plan['sites'][HOST])
        alias=bundle['veriloga_header_staging']['binding']['veriloga_header_closure']['files'][0]['alias']
        broken['external_files'].pop(alias)
        with self.assertRaises(ValueError):child.runner.prepare(Path(plan['bundle_path']),site=broken)
        self.ssh.assert_not_called();self.doctor.assert_not_called()

    def test_missing_header_selection_blocks_and_changed_audit_never_freezes_a_plan(self):
        state,observed=self.observed();draft=self.selected(state,False)
        blocked=self.prepare(draft,observed)
        self.assertEqual(blocked['prepared']['state'],'blocked');self.assertIsNone(blocked['prepared']['plan_id'])
        self.assertIn('veriloga_standard_include_binding_missing',{row['code'] for row in blocked['prepared']['missing']})
        draft=self.selected(blocked)
        with patch.object(experiment_workflow.ExperimentWorkflow,'_audit',side_effect=self.local_audit), \
             patch.object(experiment_workflow.ExperimentWorkflow,'_audit_headers',side_effect=ValueError('synthetic changed header')):
            result=self.runtime.write('agent-tb/prepare',{'intake_id':draft['intake_id'],'revision':draft['revision'],
                'draft_id':draft['agent_tb']['draft_id']},origin='test_harness')
        self.assertEqual(result['state'],'needs_input')
        self.assertEqual(result['prepared']['missing'][0]['code'],'standard_header_audit_unverified')
        self.assertFalse(result['plans']);self.ssh.assert_not_called()

    def test_header_probe_errors_finish_observation_and_invalid_roots_leave_revision_intact(self):
        state=self.probe(self.imported());args={'intake_id':state['intake_id'],'revision':state['revision'],
            'probe_id':state['probes'][0]['probe_id'],'roots':['/']}
        with self.assertRaises(ValueError):self.runtime.write('veriloga-headers',args,origin='test_harness')
        self.assertEqual(self.runtime.read('session',{'intake_id':state['intake_id']})['revision'],state['revision'])
        args['roots']=['/synthetic/explicit-headers']
        with patch('onboarding_veriloga.remote_headers',side_effect=TimeoutError('synthetic probe timeout')):
            failed=self.runtime.write('veriloga-headers',args,origin='test_harness')
        self.assertEqual(failed['state'],'needs_input')
        self.assertEqual(failed['operation']['status'],'completed')
        self.assertNotIn('recovery',self.runtime.read('session',{'intake_id':state['intake_id']}))

    def test_header_projection_prunes_unused_entry_and_keeps_transitive_pins(self):
        observed=self.observation();binding,aliases=header_binding(observed,{'disciplines.vams'})
        self.assertEqual([row['name'] for row in binding['veriloga_standard_includes']],['disciplines.vams'])
        self.assertEqual({row['name'] for row in binding['veriloga_header_closure']['files']},
                         {'disciplines.vams','types/electrical.vams'})
        self.assertEqual(len(aliases),2)
        changed=copy.deepcopy(observed);changed['files'][0]['sha256']='0'*64
        with self.assertRaises(ValueError):header_binding(changed,{'disciplines.vams'})


if __name__=='__main__':unittest.main()
