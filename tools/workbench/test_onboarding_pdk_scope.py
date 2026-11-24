"""Cached scope adapter/context guards, using an explicitly synthetic SDK seam."""
import contextlib
import copy
import hashlib
import io
import json
import sys
import time
from types import ModuleType
import unittest
from unittest.mock import patch

from onboarding_pdk_scope import digest,load_scope_selection
from runner import atomic
from test_onboarding_integration import _IntakeFixture
from workspace import Conflict


ENTRY='1'*64
SECTION='2'*64
OTHER_SECTION='3'*64
TMI='4'*64


class CachedScopeAdapterTests(_IntakeFixture):
    def setUp(self):
        super().setUp();self.capture['private']['identity']['uid']=1000
        self.sdk=ModuleType('spiceowl.onboarding.pdk_scope');self.calls=[]
        self.sdk.library_scope_catalog=self.catalog
        self.sdk.project_library_scopes=self.project
        self.sdk.validate_scope_selection=self.validate
        self.patch(patch.dict(sys.modules,{'spiceowl.onboarding.pdk_scope':self.sdk}))

    def catalog(self,library,*,entry_id=None,offset=0,limit=64):
        self.calls.append(('catalog',entry_id,offset,limit))
        if entry_id not in (None,ENTRY):raise ValueError('synthetic unknown entry')
        rows=([{'entry_id':ENTRY,'label':'synthetic entry','entry_sha256':'5'*64,'section_count':2}] if entry_id is None else
              [{'section_id':SECTION,'section':'typical','has_include_targets':False,'observed_model_count':2,'unknown_codes':[]},
               {'section_id':OTHER_SECTION,'section':'incomplete','has_include_targets':False,'observed_model_count':0,'unknown_codes':[]}])
        return {'schema':'spiceowl.pdk-scope-catalog.v1','library_id':library['library_id'],
            'kind':'entries' if entry_id is None else 'sections','entry_id':entry_id,
            'items':rows[offset:offset+limit],'total':len(rows),
            'next_offset':offset+limit if offset+limit<len(rows) else None,
            'status':'available','missing':[],'library_complete_within_policy':False,'ready_to_run':False}

    def project(self,library,*,requirements,server_identity,entry_id,section_ids,tmi_option_id=None):
        self.calls.append(('project',entry_id,list(section_ids),tmi_option_id))
        if entry_id!=ENTRY or not set(section_ids)<={SECTION,OTHER_SECTION} or tmi_option_id not in (None,TMI):
            raise ValueError('synthetic selection is outside observed entry')
        blocked=OTHER_SECTION in section_ids
        public={'status':'blocked' if blocked else 'requires_audit','library_id':library['library_id'],
            'source_sha256':requirements['source_sha256'],'requirements_sha256':digest(requirements),
            'entry_id':entry_id,'section_ids':list(section_ids),'sections':['incomplete' if blocked else 'typical'],
            'required_model_names':requirements['required_masters'],
            'covered_model_names':[] if blocked else requirements['required_masters'],
            'missing_model_names':requirements['required_masters'] if blocked else [],
            'selected_tmi_option_id':tmi_option_id,'tmi_options':[],
            'missing':[{'code':'synthetic_missing_model'}] if blocked else [],
            'fresh_audit_required':True,'ready_to_run':False,'library_complete_within_policy':False}
        private={'server_identity':copy.deepcopy(server_identity),'requirements':copy.deepcopy(requirements),
            'roots':library['roots'],'entry_path':str(self.model_file),
            'entry_sha256':hashlib.sha256(self.model_file.read_bytes()).hexdigest(),
            'dependency_scopes':[],'expected_files':[],'master_declarations':[],
            'tmi_evidence':{},'audit_config':{'synthetic':True}}
        result={'schema':'spiceowl.pdk-scope-selection.v1','public':public,'private':private}
        public['selection_id']=digest(result)
        return result

    def validate(self,selection):
        unsigned=copy.deepcopy(selection);selection_id=unsigned['public'].pop('selection_id')
        if selection_id!=digest(unsigned):raise ValueError('synthetic receipt hash differs')
        return selection

    def discovered(self):
        from spiceowl.onboarding.pdk_discovery import build_pdk_library_script
        state=self.probe(self.new_source());output=io.StringIO()
        with contextlib.redirect_stdout(output):exec(build_pdk_library_script(roots=[str(self.models)]),{})
        library=json.loads(output.getvalue())
        with patch('onboarding_discovery.remote_discovery',return_value=library):
            state=self.runtime.write('discover-pdk',{'intake_id':state['intake_id'],'revision':state['revision'],
                'probe_ids':[state['probes'][0]['probe_id']]},origin='test_harness')
        return state,library

    def args(self,state,library):
        return {'intake_id':state['intake_id'],'revision':state['revision'],
            'probe_id':state['probes'][0]['probe_id'],'library_id':library['library_id'],
            'entry_id':ENTRY,'section_ids':[SECTION]}

    def choose(self,state,library,**changes):
        return self.runtime.write('select-pdk-scope',{**self.args(state,library),**changes},origin='test_harness')

    def test_catalog_and_selection_are_local_bound_and_private_evidence_stays_private(self):
        state,library=self.discovered();args=self.args(state,library)
        catalog=self.runtime.read('pdk-scopes',{key:args[key] for key in ('intake_id','probe_id','library_id')})
        self.assertEqual(catalog['revision'],state['revision']);self.assertEqual(catalog['catalog']['items'][0]['entry_id'],ENTRY)
        chosen=self.choose(state,library);public=chosen['pdk_scope_selection']
        self.assertEqual(chosen['revision'],state['revision']+1);self.assertEqual(chosen['state'],'models_discovered')
        self.assertEqual(public['status'],'requires_audit');self.assertFalse(public['ready_to_run'])
        self.assertNotIn(str(self.model_file),json.dumps(public));self.assertNotIn('private',public)
        saved=load_scope_selection(self.runtime._folder(state['intake_id']),self.runtime._load(state['intake_id']),public['selection_id'])
        self.assertEqual(saved['private']['entry_path'],str(self.model_file))
        self.assertEqual(set(saved),{'schema','public','private'})
        self.assertEqual(public['probe_id'],args['probe_id'])
        self.ssh.assert_not_called();self.doctor.assert_not_called()

    def test_catalog_pagination_is_bounded_and_does_not_change_state(self):
        state,library=self.discovered();args=self.args(state,library);folder=self.runtime._folder(state['intake_id'])
        before=(folder/'session.json').read_bytes()
        query={key:args[key] for key in ('intake_id','probe_id','library_id','entry_id')}
        page=self.runtime.read('pdk-scopes',{**query,'offset':'1','limit':'1'})
        self.assertEqual(page['catalog']['items'][0]['section_id'],OTHER_SECTION)
        for changes in ({'limit':129},{'offset':16385},{'limit':True},{'path':'/synthetic'},
                        {'entry_id':None},{'offset':None},{'limit':None}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.runtime.read('pdk-scopes',{**query,**changes})
        self.assertEqual((folder/'session.json').read_bytes(),before)

    def test_wrong_probe_library_scope_and_revision_stop_without_current_state_changes(self):
        state,library=self.discovered();args=self.args(state,library);folder=self.runtime._folder(state['intake_id'])
        before=(folder/'session.json').read_bytes()
        for changes in ({'probe_id':'probe_'+'f'*32},{'library_id':'f'*64},{'entry_id':'f'*64},
                        {'section_ids':[SECTION,SECTION]},{'section_ids':['f'*64]},
                        {'section_ids':['%064x'%i for i in range(65)]},{'roots':['/synthetic']},
                        {'tmi_option_id':'f'*64},{'tmi_option_id':None}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.choose(state,library,**changes)
            self.assertEqual((folder/'session.json').read_bytes(),before)
        with self.assertRaises(Conflict):self.choose(state,library,revision=state['revision']-1)
        self.assertFalse((folder/'scope-selections').exists())

    def test_projector_cannot_reorder_explicit_sections_before_cas(self):
        state,library=self.discovered();folder=self.runtime._folder(state['intake_id'])
        before=(folder/'session.json').read_bytes()
        def reordered(*args,**kwargs):
            kwargs['section_ids']=list(reversed(kwargs['section_ids']))
            return self.project(*args,**kwargs)
        with patch.object(self.sdk,'project_library_scopes',side_effect=reordered):
            with self.assertRaisesRegex(ValueError,'differs from the explicit selection'):
                self.choose(state,library,section_ids=[SECTION,OTHER_SECTION])
        self.assertEqual((folder/'session.json').read_bytes(),before)
        self.assertFalse((folder/'scope-selections').exists())

    def test_scope_change_preserves_original_draft_and_receipt_but_marks_binding_stale(self):
        state,library=self.discovered();first=self.choose(state,library);folder=self.runtime._folder(state['intake_id'])
        selection_id=first['pdk_scope_selection']['selection_id'];receipt=folder/'scope-selections'/(selection_id+'.json')
        before=receipt.read_bytes();saved=self.runtime._load(state['intake_id'])
        draft={'draft_id':'d'*64,'status':'draft','testbench':{'text':'SYNTHETIC EXACT TB\n'},
            'selection':{'scope_selection_id':selection_id},'manifest_sha256':'e'*64}
        saved['agent_tb']=copy.deepcopy(draft);atomic(folder/'session.json',saved)
        second=self.choose(saved,library,tmi_option_id=TMI)
        self.assertNotEqual(second['pdk_scope_selection']['selection_id'],selection_id)
        self.assertEqual(second['agent_tb'],{**draft,'status':'binding_stale'})
        self.assertEqual(receipt.read_bytes(),before)
        with self.assertRaises(ValueError):load_scope_selection(folder,self.runtime._load(state['intake_id']),selection_id)

    def test_reprobe_invalidates_current_selection_and_proof_without_deleting_history(self):
        state,library=self.discovered();state=self.choose(state,library);folder=self.runtime._folder(state['intake_id'])
        selection=state['pdk_scope_selection'];receipt=folder/'scope-selections'/(selection['selection_id']+'.json')
        before=receipt.read_bytes();state=self.probe(state)
        self.assertNotIn('pdk_scope_selection',state);self.assertEqual(receipt.read_bytes(),before)
        with self.assertRaises(ValueError):load_scope_selection(folder,self.runtime._load(state['intake_id']),selection['selection_id'])

    def test_new_probe_requires_explicit_reselection_but_keeps_identical_owner_receipt(self):
        state,library=self.discovered();state=self.choose(state,library);folder=self.runtime._folder(state['intake_id'])
        selection=state['pdk_scope_selection'];receipt=folder/'scope-selections'/(selection['selection_id']+'.json')
        before=receipt.read_bytes();state=self.probe(state)
        with patch('onboarding_discovery.remote_discovery',return_value=library):
            state=self.runtime.write('discover-pdk',{'intake_id':state['intake_id'],'revision':state['revision'],
                'probe_ids':[state['probes'][0]['probe_id']],'refresh':True},origin='test_harness')
        forged=self.runtime._load(state['intake_id'])
        forged['pdk_scope_selection']={**selection,'probe_id':state['probes'][0]['probe_id']}
        with self.assertRaises(ValueError):load_scope_selection(folder,forged,selection['selection_id'])
        chosen=self.choose(state,library)
        self.assertEqual(chosen['pdk_scope_selection']['selection_id'],selection['selection_id'])
        self.assertEqual(receipt.read_bytes(),before)
        self.assertEqual(len(list((folder/'scope-selections/bindings').glob('*.json'))),2)
        self.assertEqual(load_scope_selection(folder,self.runtime._load(state['intake_id']),selection['selection_id'])['public']['selection_id'],selection['selection_id'])

    def test_changed_receipt_source_or_probe_evidence_cannot_be_loaded(self):
        state,library=self.discovered();state=self.choose(state,library);folder=self.runtime._folder(state['intake_id'])
        current=self.runtime._load(state['intake_id']);selection_id=state['pdk_scope_selection']['selection_id']
        paths=[folder/'scope-selections'/(selection_id+'.json'),folder/'source.scs',
               folder/'probes'/(state['probes'][0]['probe_id']+'.json')]
        for path in paths:
            before=path.read_bytes()
            try:
                if path.suffix=='.scs':path.write_bytes(before+b'// synthetic changed bytes\n')
                else:
                    data=json.loads(before)
                    if 'public' in data and 'selection_id' in data['public']:data['private']['entry_sha256']='0'*64
                    else:data['private']['identity']['username']='synthetic-different-user'
                    atomic(path,data)
                with self.subTest(path=path.name),self.assertRaises(ValueError):load_scope_selection(folder,current,selection_id)
            finally:path.write_bytes(before)

    def test_uncertain_submission_blocks_scope_changes_before_projection_or_cas(self):
        state,library=self.discovered();folder=self.runtime._folder(state['intake_id']);saved=self.runtime._load(state['intake_id'])
        saved['plans']=[{'plan_id':'a'*64,'dispatch_outcome':'unknown'}];atomic(folder/'session.json',saved)
        self.calls.clear();before=(folder/'session.json').read_bytes()
        with self.assertRaises(Conflict):self.choose(saved,library)
        self.assertEqual(self.calls,[]);self.assertEqual((folder/'session.json').read_bytes(),before)
        self.assertFalse((folder/'scope-selections').exists())

    def test_blocked_projection_is_saved_without_becoming_ready_or_creating_a_plan(self):
        state,library=self.discovered();chosen=self.choose(state,library,section_ids=[OTHER_SECTION])
        self.assertEqual(chosen['pdk_scope_selection']['status'],'blocked')
        self.assertFalse(chosen['pdk_scope_selection']['ready_to_run']);self.assertEqual(chosen['plans'],[])
        self.assertNotIn('prepared',chosen)

    def legacy_discovery(self):
        state,library=self.discovered();folder=self.runtime._folder(state['intake_id'])
        path=folder/'discoveries'/(state['discovery']['discovery_id']+'.json')
        previous=json.loads(path.read_text())
        for row in previous['rows']:row.pop('library_binding',None)
        atomic(path,previous)
        selected={'probe_id':state['probes'][0]['probe_id'],'library_id':library['library_id'],
                  'library_candidate_id':library['entry_candidates'][0]['candidate_id']}
        args={'intake_id':state['intake_id'],'revision':state['revision'],
              'probe_ids':[selected['probe_id']],'library_selection':selected}
        return state,library,path,args

    def test_legacy_observation_requires_explicit_cache_only_rebinding_before_scope_read(self):
        state,library,old_path,args=self.legacy_discovery();before=old_path.read_bytes()
        query={key:self.args(state,library)[key] for key in ('intake_id','probe_id','library_id')}
        with self.assertRaisesRegex(ValueError,'explicit cache-only rebinding'):
            self.runtime.read('pdk-scopes',query)
        import onboarding_lut
        original=onboarding_lut.lookup_discovery
        with patch('onboarding_discovery.remote_discovery',side_effect=AssertionError('Explicit cached selection cannot scan')) as remote, \
             patch('onboarding_lut.lookup_discovery',wraps=original) as lookup:
            rebound=self.runtime.write('discover-pdk',args,origin='test_harness')
        lookup.assert_called_once();remote.assert_not_called()
        self.assertEqual(old_path.read_bytes(),before)
        self.assertEqual(rebound['revision'],state['revision']+1)
        self.assertEqual(self.runtime.read('pdk-scopes',query)['catalog']['kind'],'entries')
        self.assertEqual(self.choose(rebound,library)['pdk_scope_selection']['status'],'requires_audit')

    def test_explicit_cache_miss_or_stale_rebinding_leaves_revision_and_history_unchanged(self):
        state,library,old_path,args=self.legacy_discovery();folder=self.runtime._folder(state['intake_id'])
        before=(folder/'session.json').read_bytes();old=old_path.read_bytes()
        import onboarding_lut
        original=onboarding_lut.lookup_discovery
        def stale(*a,**kw):return original(*a,**kw,now=time.time()+90000)
        for source in (stale,lambda *a,**kw:{'public':{'status':'miss','scan_required':False},'discovery':None}):
            with patch('onboarding_lut.lookup_discovery',side_effect=source), \
                 patch('onboarding_discovery.remote_discovery',side_effect=AssertionError('No remote fallback')) as remote:
                with self.assertRaisesRegex(ValueError,'missing or stale'):
                    self.runtime.write('discover-pdk',args,origin='test_harness')
            remote.assert_not_called()
            self.assertEqual((folder/'session.json').read_bytes(),before);self.assertEqual(old_path.read_bytes(),old)

    def test_scope_entry_id_is_not_an_original_library_candidate_for_cache_rebinding(self):
        state,library,old_path,args=self.legacy_discovery();folder=self.runtime._folder(state['intake_id'])
        before=(folder/'session.json').read_bytes()
        args['library_selection']['library_candidate_id']=ENTRY
        with patch('onboarding_lut.lookup_discovery') as lookup, \
             patch('onboarding_discovery.remote_discovery') as remote:
            with self.assertRaisesRegex(ValueError,'original observed library candidate'):
                self.runtime.write('discover-pdk',args,origin='test_harness')
        lookup.assert_not_called();remote.assert_not_called()
        self.assertEqual((folder/'session.json').read_bytes(),before)

    def test_probe_tampering_before_first_selection_does_not_rebind_a_stored_library(self):
        state,library=self.discovered();folder=self.runtime._folder(state['intake_id'])
        path=folder/'probes'/(state['probes'][0]['probe_id']+'.json')
        changed=json.loads(path.read_text());changed['private']['identity']['username']='synthetic-other-user';atomic(path,changed)
        self.calls.clear()
        query={key:self.args(state,library)[key] for key in ('intake_id','probe_id','library_id')}
        with self.assertRaisesRegex(ValueError,'binding changed'):self.runtime.read('pdk-scopes',query)
        with self.assertRaisesRegex(ValueError,'binding changed'):self.choose(state,library)
        self.assertEqual(self.calls,[]);self.assertFalse((folder/'scope-selections').exists())


if __name__=='__main__':unittest.main()
