"""Synthetic PSF archives through real parser, identity adapters and algorithms.

No fake analysis metrics, simulator, SSH, model invocation, or remote host check.
"""
import copy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from onboarding_analysis import AnalysisBinding, OnboardingAnalysis, _digest
from onboarding_waveforms import WaveformBinding, OnboardingWaveforms
import test_simulation_derivation as derivation_fixture
from test_simulation_derivation import RUN, COMMIT, psf
from waveforms import WaveformError, WaveformService

INTAKE='intake_'+'b'*32
SOURCE=hashlib.sha256(b'Original synthetic testbench source').hexdigest()
SOURCES=json.loads((Path(__file__).resolve().parents[2]/'tests/fixtures/native-acdc.json').read_text())['sources']

class NativeSavedDatasetTests(unittest.TestCase):
    def setUp(self):
        self.fx=derivation_fixture.DerivationTests();self.fx.setUp();self.addCleanup(self.fx.doCleanups)
        self.fx.record['plan']['provenance']={'materialization':{'source_sha256':{'design/source.scs':SOURCE}}}
        self.fx.make_archive([('./psf/gain.ac',SOURCES['ac'].encode()),('./psf/bias.dc',SOURCES['dc'].encode()),('./psf/dcOpInfo.info',SOURCES['dc_op'].encode())])
        self.fx.derive();self.api=self.fx.viewer
        self.archive=self.fx.record['collection']['sha256']
        self.waves=OnboardingWaveforms(lambda intake,job:WaveformBinding(INTAKE,RUN,RUN,COMMIT,self.api,self.archive,SOURCE,SOURCE,'none','design/source.scs'))
        self.binding=AnalysisBinding(INTAKE,RUN,COMMIT,self.api,SOURCE,self.archive,output_root=self.fx.folder/'analysis')
        self.analysis=OnboardingAnalysis(lambda intake,job:self.binding)
        self.catalog=self.api.catalog(RUN)
        self.datasets={row['analysis']['kind']:row for row in self.catalog['datasets']}

    def native_catalog(self,kind):return self.api.catalog(RUN,dataset_id=self.datasets[kind]['dataset_id'])
    def request(self,kind):
        catalog=self.native_catalog(kind)
        if kind=='ac':
            inputs={'response':catalog['signals'][0]['id'],'reference':catalog['signals'][1]['id']}
            parameters={'backend':'spiceowl','response_kind':'transfer','return_curves':True};operation='ac_metrics'
        else:
            devices=catalog['operating_points'];inputs={'devices':[row['id'] for row in devices]}
            parameters={'backend':'spiceowl','device_contracts':{devices[0]['id']:{'polarity':'nmos','saturation_method':'region','region_map':{'2':'saturation'},'region_map_source':'Explicit original synthetic model convention'},devices[1]['id']:{'polarity':'pmos','saturation_method':'vdsat','voltage_convention':'signed_vgs_vds','vdsat_convention':'signed','require_above_threshold':True,'minimum_headroom_v':.1}}};operation='dc_op_metrics'
        return {'intake_id':INTAKE,'job_id':RUN,'dataset_id':catalog['dataset_id'],'operation':operation,'inputs':inputs,'parameters':parameters,'criteria':[]}

    def test_independent_native_datasets_preserve_zero_complex_and_unknown_fields(self):
        self.assertEqual(self.catalog['signals'],[]);self.assertEqual(len(self.datasets),3);self.assertNotIn('csv_sha256',self.catalog)
        self.assertIsNone(self.catalog['default_dataset_id']);self.assertFalse((self.fx.folder/'waveforms.csv').exists())
        ac=self.native_catalog('ac');self.assertEqual(ac['axis']['unit'],'Hz');self.assertEqual(ac['signals'][0]['representation'],'complex_real_imag')
        self.assertEqual(ac['signals'][0]['domain'],[0.0,100.0])
        op=self.native_catalog('dc_op');self.assertIsNone(op['axis']);self.assertEqual(op['operating_points'][0]['parameters']['region']['value'],2)
        self.assertIsNone(op['operating_points'][0]['parameters']['unused_diagnostic']['value'])
        self.assertNotIn('region_label',op['operating_points'][0]);self.assertEqual(op['operating_points'][0]['parameters']['gm']['unit'],'S')
        self.assertEqual(self.api.mapping(RUN,ac['dataset_id'])['schema'],'ic.waveform-map.v1')

    def test_onboarding_ac_only_availability_and_exact_dataset_echo(self):
        descriptor=self.waves.describe(INTAKE,RUN)
        self.assertTrue(descriptor['available']);self.assertTrue(descriptor['source_binding_verified']);self.assertNotIn('csv_sha256',descriptor)
        self.assertEqual(descriptor['available_signal_ids'],[]);self.assertEqual(len(descriptor['datasets']),3)
        args={'intake_id':INTAKE,'job_id':RUN,'dataset_id':self.datasets['ac']['dataset_id']}
        for operation in ('catalog','mapping'):
            result=self.waves.read(operation,args);self.assertEqual(result['dataset_id'],args['dataset_id'])
        sid=self.native_catalog('ac')['signals'][0]['id']
        window=self.waves.read('window',{**args,'signal_ids':[sid]})['series'][0]
        self.assertNotIn('points',window);self.assertEqual(window['complex_points'][0],[0.0,20.0,0.0]);self.assertEqual(window['bode']['frequency_hz'][0],0)
        self.assertEqual(window['bode']['magnitude_unit'],'dB re 1 V')

    def test_actual_ac_algorithm_reads_full_complex_pair_and_saves_full_report(self):
        args=self.request('ac')
        with patch.object(self.api,'waveform',side_effect=AssertionError('Never analyze display arrays')):
            result=self.analysis.analyze(args)
        self.assertEqual(result['result']['status'],'valid');self.assertAlmostEqual(result['result']['metrics']['dc_gain_db']['value'],20)
        self.assertEqual(result['result']['metrics']['phase_margin_deg']['status'],'undefined')
        self.assertEqual(result['result']['stability_verdict'],'not_evaluated');self.assertEqual(result['input']['sample_count'],3)
        self.assertEqual(result['input']['dataset_id'],args['dataset_id']);self.assertNotIn('csv_sha256',result['input'])
        self.assertEqual(result['input']['data_sha256'],self.datasets['ac']['data_sha256'])
        self.assertEqual(result['input']['selection']['response']['unit'],'V')
        self.assertEqual(result['result']['curves']['frequency_hz'],[0.0,10.0,100.0])
        self.assertEqual(result['result']['parameters']['effective_response_unit'],'1')
        raw=(self.fx.folder/'analysis'/(result['analysis_id']+'.json')).read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(),result['artifact']['sha256'])

    def test_dimensional_response_never_becomes_gain_without_a_saved_reference(self):
        args=self.request('ac');args['inputs'].pop('reference');result=self.analysis.analyze(args)['result']
        self.assertEqual(result['curves']['magnitude_unit'],'dB re 1 V');self.assertFalse(result['parameters']['dimensionless_gain'])
        self.assertEqual(result['metrics']['dc_gain_db']['status'],'undefined');self.assertEqual(result['metrics']['unity_gain_bandwidth_hz']['status'],'undefined')

    def test_dc_contracts_use_exact_devices_and_power_is_not_invented(self):
        result=self.analysis.analyze(self.request('dc_op'))['result']
        self.assertEqual(result['status'],'valid');self.assertEqual(result['saturation_result'],'pass')
        self.assertEqual(result['devices'][0]['region_label'],'saturation');self.assertEqual(result['devices'][1]['saturation_verdict'],'pass')
        self.assertIsNone(result['metrics']['static_power_w']['value'])
        args=self.request('dc_op');args['parameters'].pop('device_contracts')
        with self.assertRaisesRegex(ValueError,'contract'):self.analysis.analyze(args)

    def test_selectors_units_dataset_and_numeric_arrays_cannot_be_substituted(self):
        good=self.request('ac')
        cases=[{**good,'dataset_id':self.datasets['dc']['dataset_id']},{**good,'inputs':{'response':self.native_catalog('dc')['signals'][0]['id']}},
            {**good,'parameters':{**good['parameters'],'response_unit':'1'}},{**good,'parameters':{**good['parameters'],'frequency_hz':[0,1,2]}},
            {**good,'parameters':{**good['parameters'],'backend':'adctoolbox'}}]
        cases.append({k:v for k,v in good.items() if k!='dataset_id'})
        for value in cases:
            with self.subTest(value=value),self.assertRaises((ValueError,WaveformError)):self.analysis.analyze(value)
        dc=self.request('dc_op');dc['parameters']['supplies']=[{'voltage_v':1,'current_a':1}]
        with self.assertRaises(ValueError):self.analysis.analyze(dc)

    def test_loop_gain_requires_declared_feedback_and_phase_reference(self):
        args=self.request('ac');args['parameters']['response_kind']='loop_gain'
        with self.assertRaisesRegex(ValueError,'denominator'):self.analysis.analyze(args)
        args['parameters'].update(feedback_convention='denominator_1_plus_L',phase_reference_deg=0)
        result=self.analysis.analyze(args)['result'];self.assertEqual(result['status'],'valid');self.assertEqual(result['stability_verdict'],'not_evaluated')

    def test_native_member_hash_data_hash_and_receipt_are_bound(self):
        dataset=self.datasets['ac'];path=self.fx.folder/dataset['data_path'];raw=path.read_bytes();path.write_bytes(raw+b' ')
        with self.assertRaises(WaveformError):self.api.catalog(RUN,dataset_id=dataset['dataset_id'])
        path.write_bytes(raw);self.fx.record['local_dataset_derivation']['native_archive_sha256']='f'*64
        with self.assertRaises(WaveformError):self.api.catalog(RUN)

    def test_multiple_ac_names_cannot_share_signal_ids(self):
        self.fx.make_archive([('./psf/gain.ac',SOURCES['ac'].encode()),('./psf/other.ac',SOURCES['ac'].replace('"gain"','"other"').encode())]);self.fx.derive()
        rows=self.api.catalog(RUN)['datasets'];self.assertEqual(len(rows),2)
        one,two=[self.api.catalog(RUN,row['dataset_id']) for row in rows]
        self.assertNotEqual(one['signals'][0]['id'],two['signals'][0]['id'])
        with self.assertRaises(WaveformError):self.api.waveform(RUN,one['signals'][0]['id'],dataset_id=two['dataset_id'])

    def test_low_frequency_gain_never_becomes_dc_gain_when_zero_is_absent(self):
        native=SOURCES['ac'].replace('"freq" 0\n"pair" (20 0) (2 0)\n','')
        self.fx.make_archive([('./psf/gain.ac',native.encode())]);self.fx.derive()
        self.archive=self.fx.record['collection']['sha256'];self.binding=replace(self.binding,archive_sha256=self.archive)
        self.datasets={row['analysis']['kind']:row for row in self.api.catalog(RUN)['datasets']}
        result=self.analysis.analyze(self.request('ac'))['result']
        self.assertEqual(result['metrics']['dc_gain_db']['status'],'undefined')
        self.assertEqual(result['metrics']['low_frequency_hz']['value'],10.0)
        self.assertEqual(result['metrics']['low_frequency_gain_db']['status'],'valid')

    def test_complex_gaps_remain_gaps_and_do_not_remove_original_values(self):
        native=SOURCES['ac'].replace('(20 0) (2 0)','(NaN 0) (2 0)')
        self.fx.make_archive([('./psf/gain.ac',native.encode())]);self.fx.derive()
        dataset=self.api.catalog(RUN)['datasets'][0];catalog=self.api.catalog(RUN,dataset['dataset_id'])
        value=self.api.waveform(RUN,catalog['signals'][0]['id'],dataset_id=dataset['dataset_id'])
        self.assertIsNone(value['complex_points'][0][1]);self.assertNotIn('bode',value)
        self.assertEqual(value['complex_points'][0][0],0.0)

    def test_bounded_complex_window_never_exceeds_small_requested_limit(self):
        native=SOURCES['ac'];head=native[:native.index('VALUE')+len('VALUE')]
        points=''.join('\n"freq" '+str(i)+'\n"pair" ('+str((i%7)-3)+' '+str((i%5)-2)+') (2 0)' for i in range(40))
        self.fx.make_archive([('./psf/gain.ac',(head+points+'\nEND\n').encode())]);self.fx.derive()
        dataset=self.api.catalog(RUN)['datasets'][0];catalog=self.api.catalog(RUN,dataset['dataset_id'])
        for limit in (4,5,6,12):
            value=self.api.waveform(RUN,catalog['signals'][0]['id'],dataset_id=dataset['dataset_id'],limit=limit)
            self.assertLessEqual(len(value['complex_points']),limit)
            self.assertEqual(value['complex_points'][0][0],0);self.assertEqual(value['complex_points'][-1][0],39)

    def test_gets_do_not_derive_recollect_or_observe_current_schematic(self):
        before={str(p.relative_to(self.fx.folder)):p.read_bytes() for p in self.fx.folder.rglob('*') if p.is_file()}
        self.fx.runner.save.reset_mock()
        with patch.object(self.fx.runtime,'derive_results',side_effect=AssertionError('GET cannot derive')):
            self.waves.describe(INTAKE,RUN);self.native_catalog('dc');ac=self.native_catalog('ac');self.api.waveform(RUN,ac['signals'][0]['id'],dataset_id=ac['dataset_id'])
        self.assertEqual(before,{str(p.relative_to(self.fx.folder)):p.read_bytes() for p in self.fx.folder.rglob('*') if p.is_file()})
        for name in ('save','status','collect','dispatch'):getattr(self.fx.runner,name).assert_not_called()

    def test_native_and_legacy_transient_can_coexist(self):
        self.fx.make_archive([('./psf/gain.ac',SOURCES['ac'].encode()),('./psf/transient.tran',psf().encode())]);self.fx.derive()
        catalog=self.api.catalog(RUN);self.assertEqual(catalog['signals'][0]['analysis'],'tran');self.assertEqual(catalog['datasets'][0]['analysis']['kind'],'ac')
        self.assertIn('csv_sha256',catalog);self.assertEqual(len(self.api.waveform(RUN,catalog['signals'][0]['id'])['points']),3)


class NativeDisplayBoundaryTests(unittest.TestCase):
    """Pure display-boundary seams; no parser/solver evidence is claimed here."""
    def window(self,values,limit=1600,imag=None):
        service=WaveformService(None);complex_data=imag is not None
        native={'name':'out','unit':'V','value_kind':'complex' if complex_data else 'real',
                **({'real':values,'imag':imag} if complex_data else {'values':values})}
        signal={'id':'s','label':'out','representation':'complex_real_imag' if complex_data else 'real'}
        data={'sample_count':len(values),'axis':{'name':'sweep','unit':'V','values':list(range(len(values)))},'signals':[native]}
        service._dataset=lambda run,dataset:({},{'analysis_kind':'dc'},[signal],data,'synthetic display seam')
        return service.dataset_waveform('run','s','ds',limit=limit)

    def assert_gap_boundaries(self,points,values,breaks):
        for i in range(1,len(points)):
            a,b=int(points[i-1][0]),int(points[i][0])
            if any(v is None for v in values[a+1:b+1]):self.assertIn(i,breaks)

    def test_default_sampling_preserves_every_omitted_gap_as_a_segment_break(self):
        values=[0.0]*10000;values[1]=None;values[8]=-1.;values[9]=None;values[15]=1.
        result=self.window(values)
        self.assert_gap_boundaries(result['points'],values,result['display']['break_before_indices']['values'])
        self.assertIn([8,-1.],result['points']);self.assertIn([15,1.],result['points'])
        self.assertTrue(result['display']['extrema_preserved'])

    def test_four_point_budget_keeps_global_extrema_without_spending_budget_on_gaps(self):
        values=[0,None,1,5,None,10,3,8,4,2];result=self.window(values,4)
        self.assertLessEqual(len(result['points']),4);self.assertIn([5,10],result['points']);self.assertIn([0,0],result['points'])
        self.assert_gap_boundaries(result['points'],values,result['display']['break_before_indices']['values'])

    def test_complex_components_keep_independent_gap_boundaries_and_explicit_small_budget_limit(self):
        values=[0,1,-10,None,20,2,3,4,5,0];imag=[0,None,1,2,3,-50,0,None,60,0]
        result=self.window(values,4,imag);points=result['complex_points']
        self.assertLessEqual(len(points),4);self.assertFalse(result['display']['extrema_preserved'])
        self.assertIn('imag',result['display']['unpreserved_extrema_components'])
        self.assert_gap_boundaries(points,values,result['display']['break_before_indices']['real'])
        self.assert_gap_boundaries(points,imag,result['display']['break_before_indices']['imag'])

def write_examples():
    fx=NativeSavedDatasetTests()
    try:
        fx.setUp();catalogs={kind:fx.native_catalog(kind) for kind in ('ac','dc','dc_op')}
        windows={kind:fx.api.waveform(RUN,value['signals'][0]['id'],dataset_id=value['dataset_id']) for kind,value in catalogs.items() if value['signals']}
        requests={kind:fx.request(kind) for kind in ('ac','dc_op')};results={kind:fx.analysis.analyze(request) for kind,request in requests.items()}
        payload={'schema':'ic.onboarding.acdc-examples.v1','synthetic':True,'evidence':'Synthetic PSF archive through actual SpiceOwl parser and numerical algorithms; no solver/SSH/model call.',
            'intake_id':INTAKE,'run_id':RUN,'source_commit':COMMIT,'source_sha256':SOURCE,'overview':fx.catalog,'descriptor':fx.waves.describe(INTAKE,RUN),
            'catalogs':catalogs,'windows':windows,'requests':requests,'results':results}
        path=Path(__file__).resolve().parents[2]/'docs/contracts/onboarding-acdc.example.json';path.write_text(json.dumps(payload,indent=2,allow_nan=False)+'\n');print(path)
    finally:fx.doCleanups()

if __name__=='__main__':
    if sys.argv[1:]==['--write-examples']:write_examples()
    else:unittest.main()
