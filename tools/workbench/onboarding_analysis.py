"""Finite local analysis over full-resolution, hash-bound saved run data.

Requests select signal IDs and named numeric algorithms. They cannot supply a
filesystem path, executable source, import name or installation command.
"""
from dataclasses import dataclass
import copy
import hashlib
import inspect
import json
import math
from pathlib import Path
import re

from runner import atomic
from waveforms import WaveformService, native_breaks


SCHEMA = 'ic.onboarding.analysis.v1'
MAX_QUERY_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_REPORT_BYTES = 32 * 1024 * 1024
MAX_PLOT_BINS = 4096
HASH = re.compile(r'[a-f0-9]{64}\Z')
COMMIT = re.compile(r'[a-f0-9]{40}\Z')
OPERATIONS = {
    'spec_analyze': {'samples','time_s'},
    'coherent_fft': {'samples','time_s'},
    'sine_fit3': {'samples','time_s'},
    'sine_fit4': {'samples','time_s'},
    'weight_calibrate': {'decisions','reference','validation_decisions','validation_reference','time_s'},
    'reconstruct_codes': {'decisions'},
    'histogram_linearity': {'codes'},
    'tran_metrics': {'time_s','values','reference','current','voltage'},
    'ac_metrics': {'response','reference'},
    'dc_op_metrics': {'devices'},
}
PARAMETERS = {
    'ac_metrics': {'backend','response_kind','feedback_convention','phase_reference_deg','return_curves'},
    'dc_op_metrics': {'backend','device_contracts'},
    'spec_analyze': {'backend','sample_rate_hz','fundamental_hz','window','bin_half_width',
        'dc_bin_half_width','dc_policy','sfdr_mode','signal_unit','harmonic_orders','band_hz',
        'full_scale_peak','return_spectrum','nf_method','fundamental_tolerance_bins'},
    'coherent_fft': {'backend','sample_rate_hz','fundamental_hz','bin_half_width',
        'dc_bin_half_width','dc_policy','sfdr_mode','signal_unit','harmonic_orders','band_hz',
        'full_scale_peak','return_spectrum','nf_method','fundamental_tolerance_bins'},
    'sine_fit3': {'backend','frequency_hz','signal_unit','sample_rate_hz'},
    'sine_fit4': {'backend','frequency_guess_hz','frequency_bounds_hz','signal_unit','sample_rate_hz'},
    'weight_calibrate': {'backend','reference_unit','fit_offset','condition_limit',
        'sample_rate_hz','fundamental_hz','nominal_weights','harmonic_order','return_reconstruction'},
    'reconstruct_codes': {'backend','weights','reference_unit','offset'},
    'histogram_linearity': {'backend','bits','distribution','endpoint_policy','signal_unit',
        'stimulus_low','stimulus_high','sine_amplitude','sine_offset','min_expected_hits','return_details'},
    'tran_metrics': {'backend','initial','final','step_time_s','settling_band','signal_unit',
        'min_hold_s','slew_fractions','delay_fraction','delay_reference','reference_initial',
        'reference_final','current_sign','power_window_s'},
}
COMPARISONS = {'<':lambda a,b:a<b,'<=':lambda a,b:a<=b,
               '>':lambda a,b:a>b,'>=':lambda a,b:a>=b,'==':lambda a,b:a==b}


@dataclass(frozen=True)
class AnalysisBinding:
    """Constructed by the trusted gateway resolver for one original run."""
    intake_id: str
    job_id: str
    source_commit: str
    service: WaveformService
    original_source_sha256: str
    archive_sha256: str
    compiled_source_sha256: str = None
    output_root: Path = None
    reviewed_analysis_sha256: str = None
    reviewed_criteria: list = None


def _json(value):
    try:
        return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
    except (ValueError,TypeError,UnicodeError,RecursionError):
        raise ValueError('Analysis inputs and results must be finite bounded JSON') from None


def _digest(value):
    return hashlib.sha256(_json(value)).hexdigest()


def _criteria(value):
    if not isinstance(value,list) or len(value)>128:
        raise ValueError('Supply at most 128 explicit measurement criteria')
    for row in value:
        if (not isinstance(row,dict) or set(row)!={'metric','op','threshold','unit'}
                or not isinstance(row['metric'],str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,127}',row['metric'])
                or row['op'] not in COMPARISONS or type(row['threshold']) not in (int,float)
                or not math.isfinite(row['threshold']) or not isinstance(row['unit'],str)
                or not 1<=len(row['unit'])<=64):
            raise ValueError('A criterion requires metric, comparison, finite threshold and exact unit')
    return copy.deepcopy(value)


def evaluate_criteria(result, criteria):
    """Do not turn undefined metrics, invalid analyses or unit mismatches into passes."""
    rows=[]
    for criterion in _criteria(criteria):
        metric=(result.get('metrics') or {}).get(criterion['metric'])
        reason=None
        if result.get('status')!='valid':reason='analysis_invalid'
        elif not isinstance(metric,dict):reason='metric_absent'
        elif metric.get('status')!='valid' or type(metric.get('value')) not in (int,float):reason='metric_undefined'
        elif not math.isfinite(metric['value']):reason='metric_nonfinite'
        elif metric.get('unit')!=criterion['unit']:reason='unit_mismatch'
        verdict='not_evaluated' if reason else ('pass' if COMPARISONS[criterion['op']](metric['value'],criterion['threshold']) else 'fail')
        rows.append({**criterion,'value':metric.get('value') if isinstance(metric,dict) else None,
                     'verdict':verdict,'reason':reason})
    verdict=('not_evaluated' if not rows or any(row['verdict']=='not_evaluated' for row in rows)
             else 'fail' if any(row['verdict']=='fail' for row in rows) else 'pass')
    return {'specification_result':verdict,'criteria':rows}


def _plot_projection(result):
    """Only shrink the display; algorithms and saved reports use all input samples."""
    value=copy.deepcopy(result)
    curves=value.get('curves')
    if isinstance(curves,dict):
        xs=curves.get('frequency_hz'); ys=curves.get('magnitude_db'); phase=curves.get('phase_deg')
        if not all(isinstance(v,list) for v in (xs,ys,phase)) or len(xs)!=len(ys) or len(xs)!=len(phase):
            raise ValueError('AC frequency/magnitude/phase arrays disagree')
        if len(xs)>MAX_PLOT_BINS:
            count=len(xs); indices={0,count-1}; buckets=(MAX_PLOT_BINS-2)//6
            for b in range(buckets):
                window=range(1+(count-2)*b//buckets,1+(count-2)*(b+1)//buckets)
                for vector in (ys,phase):
                    numeric=[i for i in window if type(vector[i]) in (int,float)]
                    if numeric:indices.update((min(numeric,key=lambda i:vector[i]),max(numeric,key=lambda i:vector[i])))
                    gap=next((i for i in window if vector[i] is None),None)
                    if gap is not None:indices.add(gap)
            selected=sorted(indices)
            breaks={key:native_breaks(curves[key],selected) for key in ('magnitude_db','phase_deg')}
            for key in ('frequency_hz','magnitude_db','phase_deg'):curves[key]=[curves[key][i] for i in selected]
            curves['display']={'method':'actual_magnitude_phase_extrema_and_gaps','original_bins':count,
                'returned_bins':len(selected),'decimated':True,'measurement_uses_full_data':True,'break_before_indices':breaks}
    spectrum=value.get('spectrum')
    if not isinstance(spectrum,dict):return value
    frequency=spectrum.get('frequency_hz')
    if not isinstance(frequency,list) or len(frequency)<=MAX_PLOT_BINS:return value
    count=len(frequency)
    power=spectrum.get('power_per_bin')
    # Upstream exposes logarithmic power only; keep its absent linear
    # power/PSD fields null while selecting actual peak bins for display.
    if power is None:power=spectrum.get('power_db')
    if not isinstance(power,list) or len(power)!=count:
        raise ValueError('Spectrum frequency and power arrays disagree')
    indices={0,count-1}
    bucket_count=MAX_PLOT_BINS-2
    for index in range(bucket_count):
        start=index*count//bucket_count;stop=(index+1)*count//bucket_count
        selected=max(range(start,stop),key=lambda i:power[i] if type(power[i]) in (int,float) else -math.inf)
        indices.add(selected)
    selected=sorted(indices)
    breaks={'power_db':native_breaks(spectrum['power_db'],selected)} if isinstance(spectrum.get('power_db'),list) else {}
    for key,series in list(spectrum.items()):
        if isinstance(series,list) and len(series)==count:
            spectrum[key]=[series[index] for index in selected]
    spectrum['display']={'method':'maximum_power_bin_per_frequency_bucket',
        'original_bins':count,'returned_bins':len(selected),'decimated':True,
        'measurement_uses_full_data':True,'break_before_indices':breaks}
    return value


def _native_inputs(service, job_id, dataset_id, operation, selectors, parameters):
    if not isinstance(dataset_id,str) or not re.fullmatch(r'ds_[a-f0-9]{32}',dataset_id):
        raise ValueError('AC/DC analysis requires an explicit original dataset ID')
    record,identity,signals,data,basis=service._dataset(job_id,dataset_id)
    kind=data['analysis']['kind']; count=data['sample_count']; inputs={}; bindings={}
    if parameters.get('backend')!='spiceowl':raise ValueError('Saved AC/DC analysis currently requires the spiceowl backend')
    if operation=='ac_metrics':
        if kind!='ac' or set(selectors) not in ({'response'},{'response','reference'}):
            raise ValueError('Select a response and optional reference from an original AC dataset')
        axis=data.get('axis')
        if not isinstance(axis,dict) or axis.get('unit')!='Hz':raise ValueError('AC requires the saved frequency axis in Hz')
        inputs['frequency_hz']=axis['values']; bindings['frequency_hz']={'axis':axis['name'],'unit':'Hz','dataset_id':dataset_id}
        by_id={row['id']:i for i,row in enumerate(signals)}
        for role,sid in selectors.items():
            if not isinstance(sid,str) or sid not in by_id:raise ValueError('AC signal does not belong to the selected dataset')
            index=by_id[sid]; native=data['signals'][index]
            if native['value_kind']!='complex' or not isinstance(native.get('unit'),str) or not native['unit']:
                raise ValueError('AC response/reference requires saved complex real/imag vectors and explicit units')
            inputs[role+'_real']=native['real'];inputs[role+'_imag']=native['imag'];inputs[role+'_unit']=native['unit']
            bindings[role]=copy.deepcopy(signals[index])
    elif operation=='dc_op_metrics':
        selected=selectors.get('devices')
        if kind not in ('dc','dc_op') or data.get('axis') is not None or set(selectors)!={'devices'}:
            raise ValueError('Operating-point metrics require an unswept saved DC dataset')
        catalog=service.dataset_catalog(job_id,dataset_id); by_id={row['id']:row for row in catalog['operating_points']}
        if (not isinstance(selected,list) or not 1<=len(selected)<=128 or len(set(selected))!=len(selected)
                or any(not isinstance(sid,str) or sid not in by_id for sid in selected)):
            raise ValueError('Choose one to 128 exact saved operating-point device IDs')
        contracts=parameters.get('device_contracts',{})
        if not isinstance(contracts,dict) or set(contracts)-set(selected) or any(not isinstance(v,dict) for v in contracts.values()):
            raise ValueError('Device contracts must be keyed by selected saved device IDs')
        native_by_name={row['name']:row for row in data['operating_points']}
        inputs['devices']=[copy.deepcopy(native_by_name[by_id[sid]['name']]) for sid in selected]
        inputs['required_devices']=[by_id[sid]['name'] for sid in selected]
        inputs['device_contracts']={by_id[sid]['name']:copy.deepcopy(contract) for sid,contract in contracts.items()}
        bindings['devices']=[{'id':sid,'name':by_id[sid]['name'],'dataset_id':dataset_id} for sid in selected]
    else:raise ValueError('A native AC/DC dataset cannot be used as transient samples')
    return record,identity,signals,data,basis,inputs,bindings,count


class OnboardingAnalysis:
    def __init__(self,resolve_binding):
        if not callable(resolve_binding):raise TypeError('A trusted original-run resolver is required')
        self.resolve_binding=resolve_binding

    def analyze(self,args):
        allowed={'intake_id','job_id','operation','inputs','parameters','criteria','dataset_id'}
        if (not isinstance(args,dict) or set(args)-allowed
                or not {'intake_id','job_id','operation','inputs','parameters'}<=set(args)
                or not isinstance(args['intake_id'],str) or not re.fullmatch(r'intake_[a-f0-9]{32}',args['intake_id'])
                or not isinstance(args['job_id'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',args['job_id'])
                or args['operation'] not in OPERATIONS or not isinstance(args['inputs'],dict)
                or set(args['inputs'])-OPERATIONS[args['operation']] or not isinstance(args['parameters'],dict)
                or len(_json(args))>MAX_QUERY_BYTES):
            raise ValueError('Use an exact intake/job and bounded named algorithm arguments')
        binding=self.resolve_binding(args['intake_id'],args['job_id'])
        if (not isinstance(binding,AnalysisBinding) or binding.intake_id!=args['intake_id']
                or binding.job_id!=args['job_id'] or not isinstance(binding.service,WaveformService)
                or not isinstance(binding.source_commit,str) or not COMMIT.fullmatch(binding.source_commit)
                or any(not isinstance(v,str) or not HASH.fullmatch(v) for v in
                       (binding.original_source_sha256,binding.archive_sha256))):
            raise ValueError('Analysis is not bound to the requested original run')
        native='dataset_id' in args or args['operation'] in ('ac_metrics','dc_op_metrics')
        parameters=copy.deepcopy(args['parameters'])
        if set(parameters)-PARAMETERS[args['operation']]:
            raise ValueError('Only finite named algorithm options are accepted; signal vectors must use bound inputs')
        if native:
            record,identity,signals,rows,data_basis,inputs,bindings,sample_count=_native_inputs(
                binding.service,binding.job_id,args.get('dataset_id'),args['operation'],args['inputs'],parameters)
        else:
            record,identity,signals,rows,data_basis=binding.service._load(binding.job_id)
            sample_count=len(rows)
            indices={signal['id']:index+1 for index,signal in enumerate(signals)}
            if len(indices)!=len(signals):raise ValueError('Saved signal identities are ambiguous')
            inputs={};bindings={}
            for name,selector in args['inputs'].items():
                if name=='time_s':
                    if selector!='@time':raise ValueError('Time must use the saved dataset @time axis')
                    inputs[name]=[row[0] for row in rows];bindings[name]={'axis':'time','unit':'s'}
                elif name in ('decisions','validation_decisions'):
                    if (not isinstance(selector,list) or not 1<=len(selector)<=32
                            or any(not isinstance(sid,str) or sid not in indices for sid in selector)
                            or len(set(selector))!=len(selector)):
                        raise ValueError('Select one to 32 distinct saved decision signal IDs')
                    inputs[name]=[[row[indices[sid]] for sid in selector] for row in rows]
                    bindings[name]=[copy.deepcopy(signals[indices[sid]-1]) for sid in selector]
                else:
                    if not isinstance(selector,str) or selector not in indices:
                        raise ValueError('Select signal IDs from this original run catalog')
                    inputs[name]=[row[indices[selector]] for row in rows]
                    bindings[name]=copy.deepcopy(signals[indices[selector]-1])
        if (record.get('run_id')!=binding.job_id or identity.get('run_id')!=binding.job_id
                or record.get('source_commit')!=binding.source_commit or identity.get('source_commit')!=binding.source_commit
                or identity.get('archive_sha256')!=binding.archive_sha256
                or (binding.compiled_source_sha256 or binding.original_source_sha256) not in
                   (identity.get('source_hashes') or {}).values()):
            raise ValueError('Saved data source/archive identity differs from the retained run')
        parameters=copy.deepcopy(args['parameters'])
        # Numeric data can only come from the bound dataset, never from kwargs.
        if set(parameters)-PARAMETERS[args['operation']]:
            raise ValueError('Only finite named algorithm options are accepted; signal vectors must use bound inputs')
        if parameters.get('backend') not in ('spiceowl','adctoolbox'):
            raise ValueError('Choose the explicit spiceowl or adctoolbox algorithm backend')
        for key in ('samples','values'):
            if key in bindings and 'signal_unit' in parameters and parameters['signal_unit']!=bindings[key].get('unit'):
                raise ValueError('Declared signal unit differs from saved sample metadata')
        for key,unit in (('current','A'),('voltage','V')):
            if key in bindings and bindings[key].get('unit')!=unit:
                raise ValueError('Power analysis requires saved current in A and voltage in V')
        if 'reference' in bindings and 'reference_unit' in parameters and parameters['reference_unit']!=bindings['reference'].get('unit'):
            raise ValueError('Calibration reference unit differs from saved data')
        if not native and args['operation'] in ('spec_analyze','coherent_fft','sine_fit3','sine_fit4','tran_metrics'):
            inputs.setdefault('time_s',[row[0] for row in rows])
            bindings.setdefault('time_s',{'axis':'time','unit':'s'})
        if not native and args['operation']=='weight_calibrate' and parameters['backend']=='adctoolbox':
            inputs.setdefault('time_s',[row[0] for row in rows])
            bindings.setdefault('time_s',{'axis':'time','unit':'s'})
        criteria=_criteria(args.get('criteria',binding.reviewed_criteria or []))
        if binding.reviewed_criteria is not None and criteria!=_criteria(binding.reviewed_criteria):
            raise ValueError('Criteria differ from the reviewed experiment criteria')
        request={'operation':args['operation'],'inputs':args['inputs'],'parameters':parameters,'criteria':criteria}
        if native:request['dataset_id']=args['dataset_id']
        request_hash=_digest(request)
        if binding.reviewed_analysis_sha256 is not None and request_hash!=binding.reviewed_analysis_sha256:
            raise ValueError('Analysis configuration differs from the reviewed request digest')
        import spiceowl.adctools as adctools
        function=getattr(adctools,args['operation'])
        if args['operation']=='tran_metrics':
            for selector,argument in (('reference','reference_values'),('current','current_a'),('voltage','voltage_v')):
                if selector in inputs:inputs[argument]=inputs.pop(selector)
        call_parameters={key:value for key,value in parameters.items() if not (args['operation']=='dc_op_metrics' and key=='device_contracts')}
        try:inspect.signature(function).bind(**inputs,**call_parameters)
        except TypeError as exc:raise ValueError('Named algorithm arguments are incomplete or unsupported: '+str(exc)) from None
        try:analysis=function(**inputs,**call_parameters)
        except TypeError as exc:raise ValueError('Named algorithm arguments are incomplete or unsupported: '+str(exc)) from None
        if not isinstance(analysis,dict) or analysis.get('schema')!='spiceowl.adctools.result.v1':
            raise ValueError('Algorithm returned an unsupported result schema')
        evaluation=evaluate_criteria(analysis,criteria)
        identity_keys=('raw_signature','archive_sha256','source_hashes','effective_config_sha256')
        identity_keys+=('dataset_id','analysis_id','analysis_kind','data_sha256','data_format','native_member_sha256') if native else ('csv_sha256',)
        input_identity={key:copy.deepcopy(identity.get(key)) for key in identity_keys}
        input_identity.update(sample_count=sample_count,data_basis=data_basis,
                              selection=bindings,full_resolution=True,display_downsampling_used=False)
        payload={'schema':SCHEMA,'intake_id':binding.intake_id,'job_id':binding.job_id,
            'run_id':binding.job_id,'source_commit':binding.source_commit,
            'original_source_sha256':binding.original_source_sha256,'archive_sha256':binding.archive_sha256,
            'input':input_identity,'request':request,'request_sha256':request_hash,
            'evaluation_scope':'reviewed' if binding.reviewed_analysis_sha256 is not None else 'exploratory',
            'result':analysis,'evaluation':evaluation,'network_operations':0,'solver_invocations':0,
            'changes_original_job_verdict':False}
        payload['analysis_id']=_digest(payload)
        artifact=None
        if binding.output_root is not None:
            root=Path(binding.output_root).absolute()
            run_root=binding.service.runner.path(binding.job_id).resolve()
            if root.is_symlink() or not root.resolve().is_relative_to(run_root):
                raise ValueError('Analysis output must remain in this original run directory')
            raw=json.dumps(payload,indent=2,allow_nan=False).encode()+b'\n'
            if len(raw)>MAX_REPORT_BYTES:raise ValueError('Full analysis report exceeds its local artifact budget')
            path=root/(payload['analysis_id']+'.json')
            if path.is_symlink():raise ValueError('Analysis artifacts cannot redirect to another file')
            atomic(path,payload)
            artifact={'id':payload['analysis_id'],'sha256':hashlib.sha256(raw).hexdigest(),
                      'format':'application/json','bytes':len(raw),'full_result':True}
        payload['result']=_plot_projection(analysis)
        payload['artifact']=artifact
        if len(_json({'ok':True,'data':payload}))>MAX_RESPONSE_BYTES:
            raise ValueError('Analysis response exceeds its budget; request summary metrics without array outputs')
        return payload
