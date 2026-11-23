"""Finite analysis reads actual saved CSV; algorithm math has separate tests."""
import copy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import spiceowl

from onboarding_analysis import (AnalysisBinding, OnboardingAnalysis, _digest,
                                  _plot_projection, evaluate_criteria, MAX_PLOT_BINS)
import test_onboarding_waveforms as waveform_fixture
from test_onboarding_waveforms import INTAKE, RUN, COMMIT, SOURCE, sha
from waveforms import WaveformError


def numeric_result():
    return {'schema':'spiceowl.adctools.result.v1','operation':'spec_analyze',
        'algorithm_version':'1.0.0','backend':'synthetic-test-seam','backend_version':'1',
        'status':'valid','metrics':{'sndr_db':{'value':65.0,'unit':'dB','status':'valid'}},
        'warnings':[],'specification_result':'not_evaluated'}


class OnboardingAnalysisTests(unittest.TestCase):
    def setUp(self):
        fixture=waveform_fixture.OnboardingWaveformsTests();fixture.setUp();self.addCleanup(fixture.doCleanups)
        self.fixture=fixture;self.calls=[]
        self.binding=AnalysisBinding(INTAKE,RUN,COMMIT,fixture.service,sha(SOURCE),
            fixture.record['collection']['sha256'],output_root=fixture.folder/'analysis')
        self.resolver=Mock(side_effect=lambda intake,job:self.binding)
        self.api=OnboardingAnalysis(self.resolver)
        def analyze(samples,*,time_s,signal_unit,backend):
            self.calls.append({'samples':samples,'time_s':time_s,'signal_unit':signal_unit})
            return numeric_result()
        self.algorithm=analyze
        self.module=SimpleNamespace(spec_analyze=analyze)
        self.module_patch=patch.dict(sys.modules,{'spiceowl.adctools':self.module})
        self.module_patch.start();self.addCleanup(self.module_patch.stop)
        self.attribute_patch=patch.object(spiceowl,'adctools',self.module,create=True)
        self.attribute_patch.start();self.addCleanup(self.attribute_patch.stop)
        self.args={'intake_id':INTAKE,'job_id':RUN,'operation':'spec_analyze',
            'inputs':{'samples':fixture.signals()[0]},'parameters':{'signal_unit':'V','backend':'spiceowl'},
            'criteria':[{'metric':'sndr_db','op':'>=','threshold':60,'unit':'dB'}]}

    def test_full_csv_and_original_identity_are_used_and_report_is_persisted(self):
        with patch.object(self.fixture.service,'waveform',side_effect=AssertionError('Never use display decimation')):
            result=self.api.analyze(self.args)
        self.assertEqual(len(self.calls),1)
        self.assertEqual(len(self.calls[0]['samples']),21)
        self.assertEqual(self.calls[0]['time_s'],[i/10 for i in range(21)])
        self.assertEqual(result['input']['sample_count'],21)
        self.assertTrue(result['input']['full_resolution'])
        self.assertFalse(result['input']['display_downsampling_used'])
        self.assertEqual(result['job_id'],RUN)
        self.assertEqual(result['source_commit'],COMMIT)
        self.assertEqual(result['archive_sha256'],self.fixture.record['collection']['sha256'])
        self.assertEqual(result['evaluation']['specification_result'],'pass')
        self.assertEqual(result['evaluation_scope'],'exploratory')
        self.assertFalse(result['changes_original_job_verdict'])
        raw=(self.fixture.folder/'analysis'/(result['analysis_id']+'.json')).read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(),result['artifact']['sha256'])
        self.assertEqual(self.api.analyze(self.args)['analysis_id'],result['analysis_id'])
        for method in ('status','collect','dispatch','save'):getattr(self.fixture.runner,method).assert_not_called()

    def test_wrong_identity_or_changed_csv_fails_before_algorithm(self):
        for changes in ({'intake_id':'intake_'+'b'*32},{'source_commit':'f'*40},
                        {'archive_sha256':'e'*64},{'original_source_sha256':'d'*64}):
            saved=self.binding;self.binding=replace(saved,**changes)
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.api.analyze(self.args)
            self.binding=saved
        (self.fixture.folder/'waveforms.csv').write_text('tampered')
        with self.assertRaises(WaveformError):self.api.analyze(self.args)
        self.assertEqual(self.calls,[])

    def test_reviewed_request_and_criteria_cannot_be_changed(self):
        request={key:self.args[key] for key in ('operation','inputs','parameters','criteria')}
        self.binding=replace(self.binding,reviewed_analysis_sha256=_digest(request),
                             reviewed_criteria=copy.deepcopy(self.args['criteria']))
        self.assertEqual(self.api.analyze(self.args)['evaluation_scope'],'reviewed')
        altered=copy.deepcopy(self.args);altered['criteria'][0]['threshold']=1
        with self.assertRaisesRegex(ValueError,'Criteria differ'):self.api.analyze(altered)
        altered=copy.deepcopy(self.args);altered['inputs']['samples']=self.fixture.signals()[1]
        with self.assertRaisesRegex(ValueError,'configuration differs'):self.api.analyze(altered)
        self.assertEqual(len(self.calls),1)

    def test_requests_cannot_supply_paths_vectors_units_or_arbitrary_operations(self):
        for extra in ({'path':'/etc/passwd'},{'operation':'exec'},
                      {'inputs':{'samples':'/etc/passwd'}},
                      {'parameters':{'samples':[1,2,3]}},{'parameters':{'signal_unit':'A'}}):
            with self.subTest(extra=extra),self.assertRaises(ValueError):self.api.analyze({**self.args,**extra})
        self.assertEqual(self.calls,[])

    def test_actual_vector_argument_names_cannot_bypass_signal_id_binding(self):
        for name in ('time_s','samples','values','reference_values','current_a','voltage_v',
                     'validation_decisions','validation_reference'):
            args=copy.deepcopy(self.args);args['parameters'][name]=[0,1,2]
            with self.subTest(name=name),self.assertRaises(ValueError):self.api.analyze(args)
        self.assertEqual(self.calls,[])

    def test_transient_signal_aliases_map_to_actual_algorithm_parameters(self):
        captured={}
        def transient(time_s,values,*,backend,initial,final,step_time_s,settling_band,signal_unit,
                      reference_values):
            captured.update(reference=reference_values,values=values)
            return numeric_result()
        self.module.tran_metrics=transient
        args={**self.args,'operation':'tran_metrics','inputs':{'values':self.fixture.signals()[0],
            'reference':self.fixture.signals()[1]},'parameters':{'backend':'spiceowl','initial':0,'final':1,
                'step_time_s':0,'settling_band':.1,'signal_unit':'V'}}
        self.api.analyze(args)
        self.assertEqual(captured['reference'],[i%2 for i in range(21)])
        self.assertEqual(captured['values'],[i%3 for i in range(21)])

    def test_invalid_undefined_and_unit_mismatch_metrics_are_not_passes(self):
        result=numeric_result();criteria=self.args['criteria']
        for replacement in ({'value':None,'unit':'dB','status':'undefined'},
                            {'value':65.0,'unit':'dBFS','status':'valid'}):
            result['metrics']['sndr_db']=replacement
            self.assertEqual(evaluate_criteria(result,criteria)['specification_result'],'not_evaluated')
        result=numeric_result();result['status']='invalid'
        self.assertEqual(evaluate_criteria(result,criteria)['specification_result'],'not_evaluated')
        self.assertEqual(evaluate_criteria(numeric_result(),[])['specification_result'],'not_evaluated')

    def test_spectrum_display_limits_preserve_peaks_and_original_full_result(self):
        n=10000;power=[0.0]*n;power[5371]=100.0
        result={**numeric_result(),'spectrum':{'frequency_hz':list(range(n)),
            'power_per_bin':power,'power_db':[None]*n,'frequency_unit':'Hz'}}
        projected=_plot_projection(result)
        self.assertLessEqual(len(projected['spectrum']['frequency_hz']),MAX_PLOT_BINS)
        self.assertIn(5371,projected['spectrum']['frequency_hz'])
        self.assertEqual(len(result['spectrum']['frequency_hz']),n)
        self.assertEqual(projected['metrics'],result['metrics'])
        self.assertTrue(projected['spectrum']['display']['measurement_uses_full_data'])

    def test_upstream_logarithmic_projection_preserves_null_linear_power(self):
        n=10000;power=[-100.0]*n;power[5371]=-3.0
        result={**numeric_result(),'spectrum':{'frequency_hz':list(range(n)),
            'power_per_bin':None,'psd':None,'power_db':power,'frequency_unit':'Hz'}}
        projected=_plot_projection(result)
        self.assertLessEqual(len(projected['spectrum']['frequency_hz']),MAX_PLOT_BINS)
        self.assertIn(5371,projected['spectrum']['frequency_hz'])
        self.assertIsNone(projected['spectrum']['power_per_bin'])
        self.assertIsNone(projected['spectrum']['psd'])
        self.assertEqual(len(result['spectrum']['power_db']),n)


def write_examples(path):
    fixture=OnboardingAnalysisTests()
    try:
        fixture.setUp()
        result=fixture.api.analyze(fixture.args)
        payload={'schema':'ic.onboarding.analysis-examples.v1','synthetic':True,
            'producer':'tools/workbench/test_onboarding_analysis.py --write-examples',
            'evidence':{'adapter':'actual OnboardingAnalysis and WaveformService',
                'data':'original synthetic saved CSV and archive receipt',
                'algorithm':'explicit test seam, metrics do not validate numerical algorithms',
                'ssh_calls':0,'solver_invocations':0,'model_calls':0},
            'request':fixture.args,'analysis':result}
        raw=json.dumps(payload,indent=2,ensure_ascii=False,allow_nan=False)+'\n'
        fixture.assertNotIn(str(fixture.fixture.root),raw)
    finally:fixture.doCleanups()
    Path(path).write_text(raw)
    return path


if __name__=='__main__':
    if sys.argv[1:]==['--write-examples']:
        print(write_examples(Path(__file__).resolve().parents[2]/'docs/contracts/onboarding-analysis.example.json'))
    else:unittest.main()
