"""Focused, no-network tests for the coordinator-approved geometry metadata delta."""
import tempfile,unittest
from pathlib import Path
from test_views import FakeService,ViewService,Failure

class GeometrySelectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.service=FakeService(Path(self.tmp.name)/'state');self.views=ViewService(self.service)
        self.view,_=self.views.call('ic_schematic_open',{'project_id':'demo'})
        self.ref={k:self.view[k] for k in ('workspace_id','view_id')};self.ref['expected_revision']=1
        self.geometry={'viewer_source_path':'native/top.rnl','native_entry_id':'top','bundle_commit':'c'*40,'manifest_sha256':'d'*64,'source_match':True,'canonical_mapping_enabled':True,'snapshot_only':False}
    def tearDown(self):self.tmp.cleanup()
    def test_preserves_metadata_and_null_source_run(self):
        view,_=self.views.call('ic_view_select',{**self.ref,'selection':{'kind':'terminal','name':'M0','terminal':'D','geometry':self.geometry}})
        self.assertEqual(view['selection']['geometry'],self.geometry);self.assertEqual(view['selection']['verification'],'ui-metadata');self.assertIsNone(view['selection']['run_id']);self.assertNotIn('occurrence_path',view['selection'])
        workspace,_=self.views.call('ic_workspace_get',{'workspace_id':view['workspace_id']});self.assertEqual(workspace['selection']['selection']['geometry'],self.geometry)
        wave,_=self.views.call('ic_waveforms_open',{'workspace_id':view['workspace_id'],'project_id':'demo','run_id':'saved-run'});self.assertEqual(wave['identity']['run_id'],'saved-run')
        source,_=self.views.call('ic_view_get',{k:view[k] for k in ('workspace_id','view_id')});self.assertIsNone(source['identity']['run_id'])
    def test_closed_bounded_strict_fields(self):
        for change in [{'extra':True},{'source_match':1},{'snapshot_only':'false'},{'bundle_commit':'not-a-commit'},{'manifest_sha256':'0'*63},{'native_entry_id':'x'*1025}]:
            with self.subTest(change=change),self.assertRaises(Failure):self.views.call('ic_view_select',{**self.ref,'selection':{'kind':'instance','name':'M0','geometry':{**self.geometry,**change}}})
        current,_=self.views.call('ic_view_get',{k:self.view[k] for k in ('workspace_id','view_id')});self.assertEqual(current['revision'],1)
    def test_snapshot_unknowns_not_filled_or_promoted(self):
        view,_=self.views.call('ic_view_select',{**self.ref,'selection':{'kind':'instance','name':'M0','geometry':{'snapshot_only':True,'source_match':False}}})
        self.assertEqual(view['selection']['geometry'],{'snapshot_only':True,'source_match':False});self.assertNotIn('occurrence_path',view['selection']);self.assertEqual(view['selection']['verification'],'ui-metadata')
        wave,_=self.views.call('ic_waveforms_open',{'project_id':'demo','run_id':'saved-run'})
        with self.assertRaises(Failure):self.views.call('ic_view_select',{'workspace_id':wave['workspace_id'],'view_id':wave['view_id'],'expected_revision':1,'selection':{'kind':'signals','signal_ids':['sig-1'],'geometry':self.geometry}})

if __name__=='__main__':unittest.main(verbosity=2)
