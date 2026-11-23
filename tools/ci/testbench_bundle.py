"""Execute a reviewed cell recipe through named analysis; never execute Python/shell.

The caller supplies an independently verified same-cell runtime binding and an
installed OnboardingAnalysis adapter. No binding, source, catalog or archive is
inferred from the latest run. Registration is not solver authorization.
"""
import hashlib
import json
import math
import operator
import re

OPS = frozenset({'spec_analyze', 'coherent_fft', 'sine_fit3', 'sine_fit4', 'weight_calibrate',
                 'reconstruct_codes', 'histogram_linearity', 'tran_metrics'})
INPUTS = {'spec_analyze': {'samples', 'time_s'}, 'coherent_fft': {'samples', 'time_s'},
          'sine_fit3': {'samples', 'time_s'}, 'sine_fit4': {'samples', 'time_s'},
          'weight_calibrate': {'decisions', 'reference', 'validation_decisions', 'validation_reference', 'time_s'},
          'reconstruct_codes': {'decisions'}, 'histogram_linearity': {'codes'},
          'tran_metrics': {'time_s', 'values', 'reference', 'current', 'voltage'}}
HASH = re.compile(r'[a-f0-9]{64}\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else
                          json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def criteria_rows(value):
    require(isinstance(value, list) and 1 <= len(value) <= 128, 'CI needs explicit finite numerical criteria')
    for row in value:
        require(isinstance(row, dict) and set(row) == {'metric', 'op', 'threshold', 'unit'}
                and isinstance(row['metric'], str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,127}', row['metric'])
                and row['op'] in {'<', '<=', '>', '>=', '=='}
                and type(row['threshold']) in (int, float) and math.isfinite(row['threshold'])
                and isinstance(row['unit'], str) and 0 < len(row['unit']) <= 64,
                'CI criteria must declare metric, comparison, finite threshold and unit')
    require(len({(r['metric'], r['op']) for r in value}) == len(value), 'Duplicate CI criteria')
    return value


def bind_inputs(inputs, catalog, job_id):
    require(isinstance(inputs, dict) and 1 <= len(inputs) <= 64, 'Named analysis needs bounded signal inputs')
    require(isinstance(catalog, dict) and catalog.get('job_id') == job_id
            and isinstance(catalog.get('signals'), list), 'An explicit same-run signal catalog is required')
    signals = catalog['signals']
    require(len(signals) <= 4096 and all(isinstance(s, dict) and isinstance(s.get('id'), str) for s in signals), 'Invalid signal catalog')
    require(len({s['id'] for s in signals}) == len(signals), 'Ambiguous same-run signal IDs')
    bound = {}
    for role, selection in inputs.items():
        require(isinstance(role, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', role), 'Invalid named input role')
        if role in {'decisions', 'validation_decisions'}:
            require(isinstance(selection, list) and 1 <= len(selection) <= 32, 'Decision inputs need a bounded ordered signal list')
            ids = [bind_inputs({'sample': item}, catalog, job_id)['sample'] for item in selection]
            require(len(set(ids)) == len(ids) and '@time' not in ids, 'Decision signals must be distinct same-run signals')
            bound[role] = ids
            continue
        if selection == '@time':
            require(role == 'time_s', 'The saved time axis is only valid for time_s')
            bound[role] = selection
            continue
        if isinstance(selection, str):
            matches = [s for s in signals if s['id'] == selection]
        else:
            require(isinstance(selection, dict) and 'name' in selection and set(selection) <= {'name', 'analysis', 'quantity', 'unit'}
                    and all(isinstance(v, str) and v for v in selection.values()), 'Use an exact signal name selector or current-run signal ID')
            matches = [s for s in signals if s.get('psf_name') == selection['name']
                       and all(s.get(k) == v for k, v in selection.items() if k != 'name')]
        require(len(matches) == 1 and matches[0].get('status') == 'available', 'Signal selection is missing, unavailable or ambiguous in this run')
        bound[role] = matches[0]['id']
    return bound


def parse_result(value, request, binding):
    require(isinstance(value, dict) and value.get('schema') == 'ic.onboarding.analysis.v1', 'Missing bound analysis result')
    for field in ('intake_id', 'job_id', 'source_commit', 'original_source_sha256', 'archive_sha256'):
        require(value.get(field) == binding[field], 'Analysis result identity differs: ' + field)
    require(value.get('run_id') == binding['job_id'], 'Analysis returned a different run')
    requested = {key: request[key] for key in ('operation', 'inputs', 'parameters', 'criteria')}
    require(value.get('request') == requested and value.get('request_sha256') == digest(requested), 'Analysis request digest differs')
    require(isinstance(value.get('analysis_id'), str) and HASH.fullmatch(value['analysis_id']), 'Missing stable analysis identity')
    original = value.get('input')
    require(isinstance(original, dict) and original.get('archive_sha256') == binding['archive_sha256']
            and original.get('full_resolution') is True and original.get('display_downsampling_used') is False
            and type(original.get('sample_count')) is int and original['sample_count'] > 0,
            'CI requires original full-resolution data from the bound archive')
    for field in ('csv_sha256', 'raw_signature', 'effective_config_sha256'):
        require(isinstance(original.get(field), str) and HASH.fullmatch(original[field]), 'Missing original data provenance: ' + field)
    require(isinstance(original.get('source_hashes'), dict) and original['source_hashes'], 'Missing archived source evidence')
    if 'archive_source_hashes' in binding:
        require(original['source_hashes'] == binding['archive_source_hashes'], 'Archived source inventory differs')
    selected = original.get('selection')
    require(isinstance(selected, dict), 'Missing exact analyzed signal selection')
    for role, signal in request['inputs'].items():
        if isinstance(signal, list):
            require(isinstance(selected.get(role), list) and [row.get('id') for row in selected[role] if isinstance(row, dict)] == signal,
                    'Analyzed decision signals differ from the reviewed ordered selectors')
            continue
        require(isinstance(selected.get(role), dict), 'Missing selected analysis input')
        require(selected[role].get('axis') == 'time' if signal == '@time' else selected[role].get('id') == signal,
                'Analyzed signal differs from the reviewed selector')
    result, evaluation = value.get('result'), value.get('evaluation')
    require(isinstance(result, dict) and result.get('schema') == 'spiceowl.adctools.result.v1'
            and result.get('operation') == request['operation'] and result.get('status') in {'valid', 'invalid'}
            and isinstance(result.get('algorithm_version'), str) and bool(result['algorithm_version'])
            and result.get('backend') in {'spiceowl', 'adctoolbox'} and result.get('backend') == request['parameters'].get('backend')
            and isinstance(result.get('backend_version'), str) and bool(result['backend_version'])
            and result.get('specification_result') == 'not_evaluated', 'Unrecognized named algorithm result')
    require(isinstance(evaluation, dict) and evaluation.get('specification_result') in {'pass', 'fail', 'invalid', 'not_evaluated'}
            and isinstance(evaluation.get('criteria'), list) and len(evaluation['criteria']) == len(request['criteria']), 'Missing complete CI criterion evaluation')
    for wanted, observed in zip(request['criteria'], evaluation['criteria']):
        require(isinstance(observed, dict) and all(observed.get(k) == v for k, v in wanted.items()), 'Evaluated criteria differ from registered criteria')
        require(observed.get('verdict') in {'pass', 'fail', 'invalid', 'not_evaluated'}, 'Unknown criterion verdict')
        if observed.get('verdict') == 'pass':
            metric = result.get('metrics', {}).get(wanted['metric'])
            require(isinstance(metric, dict) and metric.get('status') == 'valid' and metric.get('unit') == wanted['unit']
                    and type(metric.get('value')) in (int, float) and math.isfinite(metric['value'])
                    and observed.get('value') == metric['value'], 'Passing criterion lacks a valid metric')
            comparisons = {'<': operator.lt, '<=': operator.le, '>': operator.gt, '>=': operator.ge, '==': operator.eq}
            require(comparisons[wanted['op']](metric['value'], wanted['threshold']), 'Metric does not satisfy the reported passing criterion')
    verdict = evaluation['specification_result']
    passed = result['status'] == 'valid' and verdict == 'pass' and all(c.get('verdict') == 'pass' for c in evaluation['criteria'])
    require(verdict != 'pass' or passed, 'Inconsistent passing CI result')
    return {'status': 'passed' if passed else 'failed' if verdict == 'fail' else 'invalid',
            'synthetic': value.get('synthetic') is True,
            'analysis_id': value['analysis_id'], 'input': original, 'result': result, 'evaluation': evaluation,
            'evaluation_scope': 'registered_testbench_ci', 'original_evaluation_scope': value.get('evaluation_scope'),
            'artifact': value.get('artifact'), 'request_sha256': value['request_sha256']}


def run_registered_analysis(workflow, library_id, cell_id, testbench_id, registration_commit, runtime_binding, analyzer):
    """Finite, non-solver CI dispatch; only the trusted host may supply binding."""
    require(isinstance(registration_commit, str) and SHA.fullmatch(registration_commit), 'An exact registered version is required')
    with workflow._locked():
        inventory = workflow.get_testbenches(library_id, cell_id)
        matches = [row for row in inventory['bundles'] if row['id'] == testbench_id]
        require(len(matches) == 1, 'Testbench is not registered for this exact cell')
        bundle = matches[0]
        require(bundle['registration_commit'] == registration_commit and bundle['source_matches'] and bundle['enabled'],
                'Registered version or source changed; review the Testbench CI again')
        authorization = workflow.testbench_registration(library_id, cell_id, testbench_id, registration_commit, bundle['binding'])
        scope = workflow._scope(library_id, cell_id)
        raw = workflow._blob(scope['head'], bundle['manifest_path'])
        record = json.loads(raw)
        binding = runtime_binding
        require(isinstance(binding, dict), 'A trusted runtime binding is required')
        for field, expected in (('library_id', library_id), ('cell_id', cell_id), ('testbench_id', testbench_id),
                                ('registration_commit', registration_commit), ('source_sha256', bundle['binding']['source_sha256']),
                                ('testbench_sha256', bundle['binding']['testbench_sha256']),
                                ('source_files', record['source']['files'])):
            require(binding.get(field) == expected, 'Runtime is not bound to this reviewed cell: ' + field)
        require(isinstance(binding.get('source_commit'), str) and SHA.fullmatch(binding['source_commit']), 'Missing exact runtime source commit')
        require(binding.get('original_source_sha256') in record['source']['files'].values(), 'Runtime primary source is outside this registered cell')
        require(isinstance(binding.get('archive_sha256'), str) and HASH.fullmatch(binding['archive_sha256']), 'Missing collected archive digest')
        require(all(isinstance(binding.get(k), str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,180}', binding[k]) for k in ('intake_id', 'job_id')), 'Missing exact intake/job identity')
        recipe = record['agent_manifest']['postprocess']
        require(isinstance(recipe, dict) and set(recipe) == {'operation', 'inputs', 'parameters'}
                and recipe.get('operation') in OPS and isinstance(recipe.get('parameters'), dict), 'This reviewed recipe has no supported named-algorithm execution')
        require(recipe['parameters'].get('backend') in {'spiceowl', 'adctoolbox'}, 'Choose the explicit algorithm backend in the reviewed recipe')
        require(isinstance(recipe['inputs'], dict) and set(recipe['inputs']) <= INPUTS[recipe['operation']], 'Unsupported input role for the named algorithm')
        criteria = criteria_rows(record['agent_manifest']['criteria'])
        inputs = bind_inputs(recipe['inputs'], binding.get('signal_catalog'), binding['job_id'])
        request = {'intake_id': binding['intake_id'], 'job_id': binding['job_id'], 'operation': recipe['operation'],
                   'inputs': inputs, 'parameters': recipe['parameters'], 'criteria': criteria}
        frozen = {'schema': 'ic.testbench_ci_run.v1', 'library_id': library_id, 'cell_id': cell_id, 'testbench_id': testbench_id,
                  'registration_commit': registration_commit, 'registration_review': authorization,
                  'binding': bundle['binding'], 'runtime_binding': binding, 'request': request}
        key = digest(frozen)
        folder = workflow.state / 'testbench-runs' / key
        if (folder / 'request.json').exists():
            require(workflow._record(folder / 'request.json') == frozen, 'CI dispatch identity collision')
            if (folder / 'complete.json').exists():
                receipt = workflow._record(folder / 'complete.json')
                return workflow.get_testbench_result(library_id, cell_id, testbench_id, receipt['result_id'])
            return {'schema': 'ic.testbench_ci_result.v1', 'status': 'unknown', 'run_key': key, 'automatic_retry': False,
                    'note': 'The original analysis dispatch needs reconciliation; it was not repeated.'}
        workflow._append(folder / 'request.json', frozen)
    # Adapter may create an analysis artifact. Record intent before the call and
    # never replay an uncertain dispatch, even though this path starts no solver.
    try:
        output = analyzer.analyze(request)
        parsed = parse_result(output, request, binding)
        value = {'schema': 'ic.testbench_ci_result.v1', 'library_id': library_id, 'cell_id': cell_id,
                 'testbench_id': testbench_id, 'registration_commit': registration_commit, 'binding': bundle['binding'],
                 'registration_review': authorization,
                 'source_commit': binding['source_commit'], 'original_source_sha256': binding['original_source_sha256'],
                 'intake_id': binding['intake_id'], 'job_id': binding['job_id'], 'archive_sha256': binding['archive_sha256'],
                 'run_key': key, 'request': request, 'simulation_started': False, 'script_executed': False,
                 'automatic_retry': False, **parsed}
        result_id = digest(value)
        with workflow._locked():
            workflow._append(workflow.state / 'testbench-results' / (result_id + '.json'), value)
            workflow._append(folder / 'complete.json', {'result_id': result_id})
        return {**value, 'result_id': result_id}
    except Exception:
        workflow._append(folder / 'unknown.json', {'status': 'unknown', 'automatic_retry': False})
        raise
