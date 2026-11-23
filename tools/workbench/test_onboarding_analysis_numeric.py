"""Actual algorithms over original synthetic, hash-bound saved waveform CSV."""
import importlib.metadata
import json
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

from onboarding_analysis import AnalysisBinding, OnboardingAnalysis, MAX_PLOT_BINS
import test_onboarding_waveforms as wf

try:
    import numpy as np
except ImportError:
    np = None
try:
    UPSTREAM = importlib.metadata.version('adctoolbox') == '0.9.3'
except importlib.metadata.PackageNotFoundError:
    UPSTREAM = False


@unittest.skipIf(np is None, 'optional SpiceOwl numerical extra is not installed')
class SavedAnalysisNumericTests(unittest.TestCase):
    def setUp(self):
        self.saved=wf.OnboardingWaveformsTests();self.saved.setUp()
        self.addCleanup(self.saved.doCleanups)
        self.binding=AnalysisBinding(wf.INTAKE,wf.RUN,wf.COMMIT,self.saved.service,
            wf.sha(wf.SOURCE),self.saved.record['collection']['sha256'],
            output_root=self.saved.folder/'analysis')
        self.api=OnboardingAnalysis(Mock(return_value=self.binding))

    def export(self,times,series,units):
        names=list(series)
        raw=(','.join([names[0]+' X']+[name+' Y' for name in names])+'\n'+
            ''.join(','.join(format(float(value),'.17g') for value in row)+'\n'
                    for row in zip(times,*series.values()))).encode()
        (self.saved.folder/'waveforms.csv').write_bytes(raw)
        (self.saved.folder/'waveforms.json').write_text(json.dumps({
            'run_id':wf.RUN,'source_commit':wf.COMMIT,'csv_sha256':wf.sha(raw),
            'csv_samples':len(times),'waveforms':[{'name':name,'time_unit':'s',
                'unit':units[name]} for name in names]}))
        (self.saved.folder/'archive-files.json').write_text(json.dumps([
            {'path':'./export/waveforms.csv','sha256':wf.sha(raw),'bytes':len(raw)},
            {'path':'./psf/synthetic.tran','sha256':wf.sha(b'synthetic'),'bytes':9}]))
        return dict(zip(names,self.saved.signals()))

    def request(self,operation,inputs,parameters,criteria=None):
        return {'intake_id':wf.INTAKE,'job_id':wf.RUN,'operation':operation,
            'inputs':inputs,'parameters':parameters,'criteria':criteria or []}

    def spectrum_request(self,backend='spiceowl',count=16384):
        fs=16384.;f=23*fs/count;t=np.arange(count)/fs
        y=.8*np.sin(2*np.pi*f*t)+.008*np.sin(4*np.pi*f*t)+.0008*np.sin(2*np.pi*101*fs/count*t)
        signals=self.export(t,{'out':y},{'out':'V'})
        parameters={'backend':backend,'sample_rate_hz':fs,'fundamental_hz':f,
            'window':'rectangular','bin_half_width':0,'signal_unit':'V',
            'full_scale_peak':1,'return_spectrum':True}
        if backend=='spiceowl':
            parameters.update(dc_bin_half_width=0,dc_policy='remove_mean',sfdr_mode='peak_bin')
        else:parameters.update(nf_method=3,fundamental_tolerance_bins=.5)
        return self.request('spec_analyze',{'samples':signals['out']},parameters,
            [{'metric':'sndr_db','op':'>=','threshold':35,'unit':'dB'}])

    def test_actual_fft_full_csv_measurement_and_log_only_upstream_projection(self):
        for backend in ['spiceowl']+(['adctoolbox'] if UPSTREAM else []):
            with self.subTest(backend=backend):
                args=self.spectrum_request(backend)
                with patch.object(self.saved.service,'waveform',side_effect=AssertionError('Display is not measurement')):
                    report=self.api.analyze(args)
                metrics=report['result']['metrics']
                self.assertEqual(report['result']['status'],'valid')
                self.assertAlmostEqual(metrics['sndr_db']['value'],10*math.log10(.8**2/(.008**2+.0008**2)),delta=.03)
                self.assertAlmostEqual(metrics['thd_db']['value'],-40,delta=.03)
                self.assertEqual(report['input']['sample_count'],16384)
                self.assertEqual(report['evaluation']['specification_result'],'pass')
                self.assertLessEqual(len(report['result']['spectrum']['frequency_hz']),MAX_PLOT_BINS)
                full=json.loads((self.saved.folder/'analysis'/(report['analysis_id']+'.json')).read_text())
                self.assertEqual(len(full['result']['spectrum']['frequency_hz']),8193)
                if backend=='adctoolbox':self.assertIsNone(report['result']['spectrum']['power_per_bin'])
                for method in ('status','collect','dispatch','save'):getattr(self.saved.runner,method).assert_not_called()

    def test_actual_sine_fits_preserve_units_and_explicit_frequency(self):
        t=np.arange(4096)/4096;y=.7*np.sin(2*np.pi*37*t+.2)+.3
        signals=self.export(t,{'out':y},{'out':'V'})
        for backend in ['spiceowl']+(['adctoolbox'] if UPSTREAM else []):
            args=self.request('sine_fit3',{'samples':signals['out']},
                {'backend':backend,'frequency_hz':37,'signal_unit':'V','sample_rate_hz':4096})
            report=self.api.analyze(args);metrics=report['result']['metrics']
            self.assertEqual(report['result']['status'],'valid')
            self.assertAlmostEqual(metrics['amplitude_peak']['value'],.7,places=10)
            self.assertAlmostEqual(metrics['offset']['value'],.3,places=10)
            self.assertLess(metrics['residual_rms']['value'],1e-11)
            self.assertEqual(report['evaluation']['specification_result'],'not_evaluated')

    def test_actual_transient_power_and_reference_are_bound_to_saved_signals(self):
        t=np.linspace(0,2,201);y=np.minimum(t,1)
        signals=self.export(t,{'out':y,'supply':np.ones(len(t))*2,'current':np.ones(len(t))*.1},
                            {'out':'V','supply':'V','current':'A'})
        args=self.request('tran_metrics',{'values':signals['out'],'voltage':signals['supply'],
            'current':signals['current']},{'backend':'spiceowl','initial':0,'final':1,
            'step_time_s':0,'settling_band':.1,'signal_unit':'V','min_hold_s':.5,'current_sign':'into_dut'})
        report=self.api.analyze(args);metrics=report['result']['metrics']
        for name,expected in [('settling_s',.9),('slew_rate',1),('delay_s',.5),
                              ('average_power_w',.2),('energy_j',.4)]:
            self.assertAlmostEqual(metrics[name]['value'],expected,places=10)


def write_spectrum_example(path):
    case=SavedAnalysisNumericTests()
    try:
        case.setUp();request=case.spectrum_request(count=256)
        report=case.api.analyze(request)
        payload={'schema':'ic.onboarding.analysis-examples.v1','synthetic':True,
            'producer':'tools/workbench/test_onboarding_analysis_numeric.py --write-examples',
            'evidence':{'adapter':'actual OnboardingAnalysis and WaveformService',
                'data':'original synthetic saved CSV and archive receipt',
                'algorithm':'actual SpiceOwl FFT on explicit coherent harmonic signals',
                'ssh_calls':0,'solver_invocations':0,'model_calls':0},
            'request':request,'analysis':report}
        raw=json.dumps(payload,indent=2,allow_nan=False)+'\n'
        case.assertNotIn(str(case.saved.root),raw)
    finally:case.doCleanups()
    Path(path).write_text(raw)
    return path


if __name__=='__main__':
    if sys.argv[1:]==['--write-examples']:
        print(write_spectrum_example(Path(__file__).resolve().parents[2]/'docs/contracts/onboarding-analysis.spectrum.example.json'))
    else:unittest.main()
