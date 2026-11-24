"""Scope prepare guards use synthetic metadata and never contact a remote host."""
import copy
import contextlib
import io
import json
import sys
import types
import unittest
from unittest.mock import Mock,patch

from experiment_workflow import ExperimentWorkflow
from onboarding_testbench import validate_selection
from test_onboarding_integration import _IntakeFixture,HOST
import test_onboarding_agent_tb as authored_tb
import experiment_workflow
from pathlib import Path
from runner import atomic
from workspace import Conflict


class ScopeSelectionProtocolTests(unittest.TestCase):
    def test_scope_selection_is_an_independent_minimal_branch(self):
        selected={'scope_selection_id':'a'*64,'host_ids':['observed-node']}
        result=validate_selection(selected)
        self.assertEqual(result,selected);self.assertIsNot(result,selected)
        result['host_ids'].append('other');self.assertEqual(selected['host_ids'],['observed-node'])
        self.assertEqual(validate_selection({**selected,'veriloga_header_id':'headers_'+'b'*64})['scope_selection_id'],'a'*64)
        for extra in ('discovery_id','candidate_id','sections','tmi_candidate_id','model_contracts'):
            with self.subTest(extra=extra),self.assertRaises(ValueError):
                validate_selection({**selected,extra:None})

    def test_scope_id_hosts_and_header_require_exact_observed_identity_shapes(self):
        valid={'scope_selection_id':'a'*64,'host_ids':['observed-node']}
        for key,value in [('scope_selection_id','a'*63),('scope_selection_id','A'*64),
                          ('scope_selection_id',None),('host_ids',[]),('host_ids',['same','same']),
                          ('host_ids',['node;command']),('veriloga_header_id','/private/path')]:
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):
                validate_selection({**valid,key:value})


class ScopeProfileBindingTests(unittest.TestCase):
    """The owner SDK validates scope science; CG binds its result to compilation."""
    def setUp(self):
        self.audit_config={'main':'/synthetic/pdk/main.scs','sections':['MOS_TT','CAP_TT'],
            'required_masters':['device_n','device_c']}
        self.public={'status':'requires_audit','selection_id':'a'*64,'library_id':'b'*64,
            'source_sha256':'c'*64,'sections':['MOS_TT','CAP_TT'],
            'required_model_names':['device_n','device_c'],'selected_tmi_option_id':'d'*64}
        self.private={'entry_path':'/synthetic/pdk/main.scs','entry_sha256':'e'*64,
            'audit_config':copy.deepcopy(self.audit_config)}
        self.scope={'schema':'spiceowl.pdk-scope-selection.v1','public':self.public,'private':self.private}
        self.binding={'scope_selection_id':'a'*64,'library_id':'b'*64,'sections':['MOS_TT','CAP_TT'],
            'model_names':['device_n','device_c'],'entry_sha256':'e'*64,'pdk_sha256':'f'*64,'tmi_option_id':'d'*64}
        self.profile={'scope_selection':self.scope,'expected_main_sha256':'e'*64}
        self.recipe={'recipe':'agent-testbench','used_models':['device_c','device_n'],
            'external_includes':[{'alias':'PDK_MAIN','section':'MOS_TT'},{'alias':'PDK_MAIN','section':'CAP_TT'}],
            'agent_tb_manifest':{'source_sha256':'c'*64,'pdk_binding':self.binding}}
        # Only the owner validation seam is mocked; binding enforcement is real.
        module=types.ModuleType('spiceowl.onboarding.pdk_scope')
        module.validate_scope_selection=Mock(side_effect=lambda selection:selection)
        self.validator=module.validate_scope_selection
        patcher=patch.dict(sys.modules,{'spiceowl.onboarding.pdk_scope':module})
        patcher.start();self.addCleanup(patcher.stop)

    def verify(self,profile=None,recipe=None,config=None):
        return ExperimentWorkflow._scope_profile(self.profile if profile is None else profile,
            self.recipe if recipe is None else recipe,self.audit_config if config is None else config)

    def test_exact_same_entry_scope_reaches_audit_without_candidate_aliases(self):
        result=self.verify()
        self.assertEqual(result,self.scope);self.assertIsNot(result,self.scope)
        self.validator.assert_called_once_with(self.scope)
        self.assertNotIn('candidate_id',self.binding);self.assertNotIn('discovery_id',self.binding)

    def test_scope_binding_cannot_fall_back_to_a_legacy_profile(self):
        with self.assertRaises((ValueError,TypeError)):self.verify(profile={})
        self.assertIsNone(ExperimentWorkflow._scope_profile({}, {'recipe':'legacy'},{}))

    def test_source_sections_models_entry_and_tmi_must_match_before_remote_audit(self):
        mutations=[('source',lambda r:r['agent_tb_manifest'].update(source_sha256='0'*64)),
            ('sections',lambda r:r['external_includes'].reverse()),
            ('alias',lambda r:r['external_includes'][0].update(alias='OTHER_ENTRY')),
            ('model',lambda r:r['used_models'].append('unselected')),
            ('entry',lambda r:r['agent_tb_manifest']['pdk_binding'].update(entry_sha256='0'*64)),
            ('tmi',lambda r:r['agent_tb_manifest']['pdk_binding'].update(tmi_option_id='0'*64)),
            ('legacy',lambda r:r['agent_tb_manifest']['pdk_binding'].update(candidate_id='fake')),
            ('selection',lambda r:r['agent_tb_manifest']['pdk_binding'].update(scope_selection_id='0'*64))]
        for label,change in mutations:
            recipe=copy.deepcopy(self.recipe);change(recipe)
            with self.subTest(label=label),self.assertRaises(ValueError):self.verify(recipe=recipe)
        for change in ({'sections':['MOS_TT']},{'main':'/synthetic/pdk/other.scs'},
                       {'required_masters':['device_n']},{'roots':['/broader']}):
            with self.subTest(change=change),self.assertRaises(ValueError):
                self.verify(config={**self.audit_config,**change})


class StaleScopeDraftTests(_IntakeFixture):
    imported=authored_tb.AgentTestbenchTests.imported
    draft=authored_tb.AgentTestbenchTests.draft

    def test_stale_scope_draft_preserves_text_but_cannot_prepare_even_with_same_id(self):
        state=self.draft(selection={'scope_selection_id':'a'*64,'host_ids':[HOST]})
        private=self.runtime._load(state['intake_id']);original=copy.deepcopy(private['agent_tb'])
        private['agent_tb']['status']='binding_stale'
        atomic(self.runtime._folder(state['intake_id'])/'session.json',private)
        with patch('onboarding_testbench.compile_agent_selection') as compile_selection, \
             patch('onboarding_prepare.create_child_config') as create:
            with self.assertRaises(Conflict):
                self.runtime.write('agent-tb/prepare',{'intake_id':state['intake_id'],
                    'revision':state['revision'],'draft_id':state['agent_tb']['draft_id']},origin='test_harness')
        compile_selection.assert_not_called();create.assert_not_called()
        stored=self.runtime._load(state['intake_id'])['agent_tb']
        self.assertEqual(stored,{**original,'status':'binding_stale'})
        self.ssh.assert_not_called();self.doctor.assert_not_called();self.process.assert_not_called()


class ScopePrepareIntegrationTests(_IntakeFixture):
    """Real SDK scan/projection/compilation with mocked remote audit transport."""
    imported=authored_tb.AgentTestbenchTests.imported
    draft=authored_tb.AgentTestbenchTests.draft
    binding=authored_tb.AgentTestbenchTests.binding

    def setUp(self):
        super().setUp();self.capture['private']['identity']['uid']=1000
        self.model_file.write_text('simulator lang=spectre\n'
            'section MOS_TT\ninclude "alpha.scs"\nendsection MOS_TT\n'
            'section CAP_TT\ninclude "beta.scs"\nendsection CAP_TT\n')
        (self.models/'alpha.scs').write_text('model core_n bsim4 type=n\n'
            'subckt device_alpha d g s b\nM0 (d g s b) core_n\nends device_alpha\n')
        (self.models/'beta.scs').write_text('model core_p bsim4 type=p\n'
            'subckt device_beta d g s b\nM0 (d g s b) core_p\nends device_beta\n')

    def scope_selected(self,*,with_tmi=False,probe_targets=None):
        from spiceowl.onboarding.pdk_discovery import build_pdk_library_script
        if with_tmi:
            self.model_file.write_text(self.model_file.read_text().replace('section MOS_TT\n','section MOS_TT\n.option tmipath="tmi"\n',1))
            self.tmi_binary=self.models/'tmi'/'Synthetic64'/'libTMImodel.so'
            self.tmi_binary.parent.mkdir(parents=True)
            self.tmi_binary.write_bytes(b'newly authored synthetic TMI identity fixture')
        state=self.probe(self.imported(),targets=probe_targets);output=io.StringIO()
        with contextlib.redirect_stdout(output):exec(build_pdk_library_script(roots=[str(self.models)]),{})
        library=json.loads(output.getvalue())
        with patch('onboarding_discovery.remote_discovery',return_value=library):
            state=self.runtime.write('discover-pdk',{'intake_id':state['intake_id'],'revision':state['revision'],
                'probe_ids':[state['probes'][0]['probe_id']]},origin='test_harness')
        query={'intake_id':state['intake_id'],'probe_id':state['probes'][0]['probe_id'],'library_id':library['library_id']}
        entries=self.runtime.read('pdk-scopes',query)['catalog']['items']
        entry=next(row for row in entries if row['label']=='entry.scs')
        sections=self.runtime.read('pdk-scopes',{**query,'entry_id':entry['entry_id']})['catalog']['items']
        section_ids=[next(row['section_id'] for row in sections if row['section']==name) for name in ('MOS_TT','CAP_TT')]
        args={**query,'entry_id':entry['entry_id'],'section_ids':section_ids}
        state=self.runtime.write('select-pdk-scope',{**args,'revision':state['revision']},origin='test_harness')
        if with_tmi:
            self.assertEqual(state['pdk_scope_selection']['status'],'blocked')
            options=state['pdk_scope_selection']['tmi_options'];self.assertEqual(len(options),1)
            state=self.runtime.write('select-pdk-scope',{**args,'revision':state['revision'],
                'tmi_option_id':options[0]['tmi_option_id']},origin='test_harness')
        self.assertEqual(state['pdk_scope_selection']['status'],'requires_audit',state['pdk_scope_selection'])
        return state

    def scoped_draft(self,**kwargs):
        state=self.scope_selected(**kwargs)
        return self.draft(state,{'scope_selection_id':state['pdk_scope_selection']['selection_id'],'host_ids':[HOST]})

    def prepare_scope(self,state,*,audit=None):
        with patch.object(ExperimentWorkflow,'_audit',side_effect=audit or self.local_audit) as remote, \
             patch('onboarding_prepare.selected_candidate',side_effect=AssertionError('Scope must not resolve a legacy candidate')):
            result=self.runtime.write('agent-tb/prepare',{'intake_id':state['intake_id'],'revision':state['revision'],
                'draft_id':state['agent_tb']['draft_id']},origin='test_harness')
        self.scope_audit_call=remote
        return result

    def test_union_scope_prepares_exact_wrapper_and_review_without_legacy_candidate(self):
        state=self.prepare_scope(self.scoped_draft())
        self.assertEqual(state['state'],'awaiting_human_review',state.get('prepared'))
        self.assertEqual(state['prepared']['state'],'prepared')
        child=self.child_for(state)
        frozen=ExperimentWorkflow(child.simulation).plan(state['prepared']['plan_id'],state['intake_id'])
        binding=frozen['recipe']['agent_tb_manifest']['pdk_binding']
        self.assertEqual(binding['scope_selection_id'],state['pdk_scope_selection']['selection_id'])
        self.assertNotIn('candidate_id',binding);self.assertNotIn('discovery_id',binding)
        self.assertEqual(binding['sections'],['MOS_TT','CAP_TT'])
        self.assertEqual((Path(frozen['bundle_path']).parent/'netlist/pdk.scs').read_text(),
            'simulator lang=spectre\ninclude "@EXTERNAL_PDK_MAIN@" section=MOS_TT\ninclude "@EXTERNAL_PDK_MAIN@" section=CAP_TT\n')
        self.assertEqual({row['kind'] for row in frozen['recipe']['model_profile']['models'].values()},{'external'})
        self.assertEqual(frozen['pdk_scope_audit_verification']['status'],'matched')
        review=self.runtime.reviews.read(state['intake_id'],state['agent_tb_review']['review_id'])
        self.assertEqual(review['state'],'pending')
        self.assertEqual(review['snapshot']['pdk_scope_selection'],frozen['pdk_scope_selection'])
        self.assertEqual(review['snapshot']['pdk_scope_audit_verification'],frozen['pdk_scope_audit_verification'])
        self.assertEqual(review['snapshot']['testbench'],authored_tb.manifest())
        self.assertNotIn(str(self.models),json.dumps(state['prepared']))
        with self.assertRaises(PermissionError):self.runtime.human_run(self.binding(state),origin='native_agent')
        self.assertEqual(self.scope_audit_call.call_count,1);self.ssh.assert_not_called();self.doctor.assert_not_called()

    def test_changed_dependency_bytes_block_before_plan_freeze(self):
        state=self.scoped_draft()
        dependency=self.models/'beta.scs';dependency.write_text(dependency.read_text()+'// changed after selection\n')
        with patch('workspace.Workspace.freeze_experiment',side_effect=AssertionError('Mismatching scope cannot freeze')):
            blocked=self.prepare_scope(state)
        self.assertEqual(blocked['prepared']['state'],'blocked');self.assertFalse(blocked['plans'])
        self.assertEqual(blocked['prepared']['missing'][0]['code'],'pdk_scope_audit_mismatch')
        self.assertNotIn('agent_tb_review',blocked);self.ssh.assert_not_called()

    def test_observed_tmi_is_pinned_and_changed_binary_cannot_freeze(self):
        state=self.scoped_draft(with_tmi=True)
        from onboarding_testbench import compile_agent_selection
        compiled=compile_agent_selection(self.runtime._folder(state['intake_id']),self.runtime._load(state['intake_id']))
        binding=compiled['compiled']['spec']['pdk_binding']
        self.assertEqual(binding['tmi_option_id'],state['pdk_scope_selection']['selected_tmi_option_id'])
        self.assertNotIn('tmi_candidate_id',binding)
        self.tmi_binary.write_bytes(b'changed synthetic platform binary')
        with patch('workspace.Workspace.freeze_experiment',side_effect=AssertionError('Changed TMI cannot freeze')):
            blocked=self.prepare_scope(state)
        self.assertEqual(blocked['prepared']['state'],'blocked');self.assertFalse(blocked['plans'])
        self.assertIn(blocked['prepared']['missing'][0]['code'],('pdk_scope_audit_mismatch','dependency_audit_incomplete'))
        self.ssh.assert_not_called()

    def changed_audit(self,kind):
        state=self.scoped_draft()
        def changed(site,config,python):
            audit=self.local_audit(site,config,python)
            if kind=='section':audit['files'][0]['selected_sections']=['UNSELECTED']
            else:
                row=next(row for row in audit['master_declarations'] if row['name']=='device_beta')
                row['ports']=['g','d','s','b']
            return audit
        with patch('workspace.Workspace.freeze_experiment',side_effect=AssertionError('Do not freeze')):
            blocked=self.prepare_scope(state,audit=changed)
        self.assertEqual(blocked['prepared']['missing'][0]['code'],'pdk_scope_audit_mismatch')
        self.assertFalse(blocked['plans']);self.ssh.assert_not_called()

    def test_fresh_audit_sections_must_match_cached_selection(self):self.changed_audit('section')

    def test_fresh_audit_ordered_ports_must_match_cached_selection(self):self.changed_audit('declaration')

    def test_comparison_from_another_selection_cannot_freeze_or_create_review(self):
        state=self.scoped_draft()
        from spiceowl.onboarding.pdk_scope import verify_scope_selection_audit
        def wrong_identity(*args,**kwargs):
            return {**verify_scope_selection_audit(*args,**kwargs),'selection_id':'0'*64}
        with patch('spiceowl.onboarding.pdk_scope.verify_scope_selection_audit',side_effect=wrong_identity), \
             patch('workspace.Workspace.freeze_experiment',side_effect=AssertionError('Foreign proof cannot freeze')):
            blocked=self.prepare_scope(state)
        self.assertEqual(blocked['prepared']['missing'][0]['code'],'pdk_scope_audit_mismatch')
        self.assertFalse(blocked['plans']);self.assertNotIn('agent_tb_review',blocked)
        self.ssh.assert_not_called()

    def test_unobserved_host_never_begins_operation_and_draft_can_be_corrected(self):
        state=self.scoped_draft()
        wrong=self.draft(state,{**state['agent_tb']['selection'],'host_ids':['not-observed']})
        with patch.object(self.runtime,'_begin',wraps=self.runtime._begin) as begin, \
             patch('onboarding_prepare.create_child_config') as create:
            with self.assertRaises(ValueError):
                self.runtime.write('agent-tb/prepare',{'intake_id':wrong['intake_id'],
                    'revision':wrong['revision'],'draft_id':wrong['agent_tb']['draft_id']},origin='test_harness')
        begin.assert_not_called();create.assert_not_called()
        current=self.runtime.read('session',{'intake_id':wrong['intake_id']})
        self.assertEqual(current['revision'],wrong['revision'])
        self.assertEqual(current['state'],'testbench_drafted')
        self.assertEqual(current['agent_tb'],wrong['agent_tb'])
        corrected=self.draft(current,{**current['agent_tb']['selection'],'host_ids':[HOST]})
        self.assertEqual(corrected['agent_tb']['testbench'],wrong['agent_tb']['testbench'])
        prepared=self.prepare_scope(corrected)
        self.assertEqual(prepared['state'],'awaiting_human_review',prepared.get('prepared'))
        self.ssh.assert_not_called();self.doctor.assert_not_called()

    def test_excluding_observed_audit_host_rejects_before_begin(self):
        state=self.scoped_draft(probe_targets=[HOST,'second-observed'])
        wrong=self.draft(state,{**state['agent_tb']['selection'],'host_ids':['second-observed']})
        with patch.object(self.runtime,'_begin',wraps=self.runtime._begin) as begin, \
             patch('onboarding_prepare.create_child_config') as create:
            with self.assertRaisesRegex(ValueError,'Include the observed host'):
                self.runtime.write('agent-tb/prepare',{'intake_id':wrong['intake_id'],
                    'revision':wrong['revision'],'draft_id':wrong['agent_tb']['draft_id']},origin='test_harness')
        begin.assert_not_called();create.assert_not_called()
        current=self.runtime.read('session',{'intake_id':wrong['intake_id']})
        self.assertEqual(current['revision'],wrong['revision']);self.assertEqual(current['state'],'testbench_drafted')
        self.ssh.assert_not_called();self.doctor.assert_not_called()


if __name__=='__main__':unittest.main()
