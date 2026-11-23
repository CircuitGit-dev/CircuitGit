"""Pure new-intake intent compiler. No filesystem, SSH, old state or execution."""
import copy
import hashlib
import json
import math
import re

from spiceowl.domain.common import DomainError
from spiceowl.experiments import prepare_experiment, parse_sources
from spiceowl.experiments.recipes import validate_model_profile
from spiceowl.onboarding.pdk_discovery import inspect_netlist

FIELDS = ('supply_v', 'frequency_hz', 'temperature_c', 'input_port', 'output_port',
          'vdd_port', 'vss_port', 'cycles', 'load_f', 'rise_s', 'fall_s', 'points_per_period')
IDENTIFIER = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,95}')
WRAPPER = 'Intake_DUT'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def issue(field, code, message):
    return {'field': field, 'code': code, 'message': message}


def _sections(values):
    return (isinstance(values, list) and 1 <= len(values) <= 64
            and all(v is None or isinstance(v, str) and IDENTIFIER.fullmatch(v) for v in values)
            and len(set(values)) == len(values))


def _number(value, *, positive=False, lower=-1e100, upper=1e100):
    return (type(value) in (int, float) and lower <= value <= upper and math.isfinite(value)
            and (not positive or value > 0))


def _derive(intent, nominal_temperature_c, missing):
    if not isinstance(intent, dict):
        missing.append(issue('intent', 'intent_missing', 'Provide the complete explicit experiment intent.'))
        return None
    absent = [name for name in FIELDS if name not in intent]
    missing.extend(issue('intent.' + name, 'intent_missing', 'Provide this explicit experiment condition.') for name in absent)
    if set(intent) - set(FIELDS) - {'nominal_temperature_c'}:
        missing.append(issue('intent', 'intent_unknown_field', 'Experiment intent contains unsupported fields.'))
    if absent:
        return None
    numeric = {'supply_v': (True, 0, 1000), 'frequency_hz': (True, 0, 1e100),
               'temperature_c': (False, -272.15, 1726.85), 'load_f': (True, 0, 1),
               'rise_s': (True, 0, 1e6), 'fall_s': (True, 0, 1e6)}
    valid = True
    for name, (positive, lower, upper) in numeric.items():
        if not _number(intent[name], positive=positive, lower=lower, upper=upper):
            missing.append(issue('intent.' + name, 'invalid_intent_value', 'Provide a finite numeric value in the declared unit.'))
            valid = False
    for name in ('cycles', 'points_per_period'):
        upper = 64 if name == 'cycles' else 199999
        if type(intent[name]) is not int or not 1 <= intent[name] <= upper:
            missing.append(issue('intent.' + name, 'invalid_sample_count', 'Provide a positive integer within the bounded transient grid.'))
            valid = False
    ports = [intent[name] for name in ('input_port', 'output_port', 'vdd_port', 'vss_port')]
    if any(not isinstance(port, str) or not IDENTIFIER.fullmatch(port) for port in ports) or len(set(str(p) for p in ports)) != 4:
        missing.append(issue('intent.ports', 'invalid_port_roles', 'Assign four distinct explicit Spectre-safe input, output and rail names.'))
        valid = False
    if 'nominal_temperature_c' in intent:
        declared_nominal = intent['nominal_temperature_c']
        if nominal_temperature_c is not None and declared_nominal != nominal_temperature_c:
            missing.append(issue('intent.nominal_temperature_c', 'nominal_temperature_conflict',
                'The explicit nominal-temperature declarations must agree.'))
            valid = False
        nominal_temperature_c = declared_nominal
    if nominal_temperature_c is None:
        missing.append(issue('intent.nominal_temperature_c', 'nominal_temperature_missing',
            'Declare the model nominal temperature separately from its operating temperature.'))
        valid = False
    elif not _number(nominal_temperature_c, lower=-272.15, upper=1726.85):
        missing.append(issue('intent.nominal_temperature_c', 'invalid_intent_value', 'Provide a finite model nominal temperature in degrees Celsius.'))
        valid = False
    if not valid: return None
    supply, period = float(intent['supply_v']), 1.0 / intent['frequency_hz']
    cycles, points = intent['cycles'], intent['points_per_period']
    stop, step = cycles * period, period / points
    if (not _number(period, positive=True, upper=1e6) or not _number(stop, positive=True, upper=1e6)
            or not _number(step, positive=True, upper=1e6) or cycles * points + 1 > 200000):
        missing.append(issue('intent.analysis', 'transient_grid_limit', 'The requested period, stop time or sample count exceeds the supported transient grid.'))
        return None
    rise, fall = float(intent['rise_s']), float(intent['fall_s'])
    if rise >= .5 * period or fall >= .5 * period:
        missing.append(issue('intent.transitions', 'pulse_plateau_missing', 'Rise and fall times must leave both pulse plateaus within each period.'))
        return None
    tolerance = min(period * 1e-9, step * 1e-6)
    windows = []
    for cycle in range(cycles):
        for kind, a, b in (('input_high_output_low', .25, .45), ('input_low_output_high', .75, .95)):
            begin, end = (cycle + a) * period, (cycle + b) * period
            first = math.ceil((begin - tolerance) / step - 1e-8)
            last = math.floor((end + tolerance) / step + 1e-8)
            minimum = last - first + 1
            if minimum < 2:
                missing.append(issue('intent.points_per_period', 'window_sampling_insufficient', 'The configured sampling grid gives fewer than two points in a measurement window.'))
                return None
            windows.append({'kind': kind, 'start_s': begin, 'end_s': end, 'minimum_samples': minimum})
    return {'schema': 'spiceowl.experiment-spec.v1', 'recipe': 'inverter-tran',
        'roles': {'inputs': [ports[0]], 'outputs': [ports[1]], 'vdd': ports[2], 'vss': ports[3]},
        'supply': {'positive_v': supply, 'negative_v': 0.0},
        'temperature_k': float(intent['temperature_c']) + 273.15,
        'nominal_temperature_k': float(nominal_temperature_c) + 273.15,
        'corner': 'selected', 'parameters': {},
        'stimuli': [{'port': ports[0], 'type': 'pulse', 'low_v': 0.0, 'high_v': supply,
            'delay_s': .1 * period, 'rise_s': rise, 'fall_s': fall, 'width_s': .5 * period - rise, 'period_s': period}],
        'loads': [{'port': ports[1], 'capacitance_f': float(intent['load_f'])}],
        'analysis': {'stop_s': stop, 'max_step_s': step, 'strobe_period_s': step},
        'acceptance': {'required_units': {'time': 's', **{port: 'V' for port in ports}},
            'sample_count': cycles * points + 1,
            'coverage': {'start_s': 0.0, 'end_s': stop, 'tolerance_s': tolerance},
            'max_sample_gap_s': step * 1.001, 'voltage_bounds_v': [-.05 * supply, 1.05 * supply],
            'supply_tolerance_v': supply * 1e-6,
            'logic': {'low_max_v': .1 * supply, 'high_min_v': .9 * supply, 'crossing_v': .5 * supply, 'windows': windows}}}


def build_intake_recipe(source_text, requirements, candidate_models, selected_sections, intent,
                        explicit_model_contracts=None, *, source_id, candidate_sections=None,
                        nominal_temperature_c=None):
    """Return reviewable compiler inputs or specific missing conditions.

    ``candidate_sections`` is the exact entry candidate's original section list,
    not all sections found in a file. A changed scope requires explicit contracts
    for every uncovered model. Section order is retained in generated includes.
    ``nominal_temperature_c`` is explicit; it is not inferred from operating T.
    It may be supplied in intent or as a keyword; duplicate declarations must
    agree. No suggested nominal temperature is claimed as model evidence.
    """
    missing = []
    result = {'schema': 'ic.onboarding.recipe.v1', 'status': 'missing', 'missing': missing,
        'selection': None, 'spec': None, 'electrical': None, 'wrapper': None, 'source': None,
        'provenance': {'fresh_dependency_audit_required': True}, 'ready_to_run': False}
    try:
        if not isinstance(source_id, str) or re.fullmatch(r'projects/[A-Za-z0-9_-]{1,96}/input\.scs', source_id) is None:
            missing.append(issue('source_id', 'invalid_source_identity', 'Use the explicit new intake path projects/INTAKE/input.scs.'))
            return result
        raw = source_text.encode('utf-8') if isinstance(source_text, str) else source_text
        if not isinstance(raw, bytes) or not 0 < len(raw) <= 1024 * 1024:
            missing.append(issue('source', 'invalid_source', 'Provide the new bounded source bytes or UTF-8 text.'))
            return result
        original_sha = hashlib.sha256(raw).hexdigest()
        if not isinstance(requirements, dict) or requirements.get('source_sha256') != original_sha:
            missing.append(issue('requirements', 'source_requirements_mismatch', 'Requirements must belong to these exact newly supplied source bytes.'))
            return result
        observed = inspect_netlist(raw, source_id=requirements.get('source_id', source_id))
        for field in ('schema', 'instances', 'interfaces', 'required_masters', 'issues'):
            if requirements.get(field) != observed[field]:
                missing.append(issue('requirements', 'source_requirements_mismatch', 'Requirements differ from a fresh inspection of the supplied source.'))
                return result
        result['provenance'].update(original_source_sha256=original_sha,
            requirements_sha256=digest(requirements), selected_sections=copy.deepcopy(selected_sections),
            candidate_sections=copy.deepcopy(candidate_sections))
        spec = _derive(intent, nominal_temperature_c, missing); result['spec'] = spec
        if not _sections(selected_sections):
            missing.append(issue('selected_sections', 'sections_missing', 'Select distinct exact sections or the explicit global scope.'))
        scope_matches = _sections(candidate_sections) and _sections(selected_sections) and set(candidate_sections) == set(selected_sections)
        if not isinstance(candidate_models, list) or len(candidate_models) > 128:
            missing.append(issue('candidate_models', 'model_evidence_missing', 'Supply the selected candidate model evidence list.'))
            return result
        explicit = {} if explicit_model_contracts is None else explicit_model_contracts
        if not isinstance(explicit, dict) or set(explicit) - set(observed['required_masters']):
            missing.append(issue('model_contracts', 'invalid_model_contract', 'Explicit model contracts must refer only to required source masters.'))
            return result
        models, provenance = {}, {}
        for name in observed['required_masters']:
            rows = [row for row in candidate_models if isinstance(row, dict) and row.get('name') == name]
            if name in explicit:
                contract = explicit[name]
                if not isinstance(contract, dict) or set(contract) != {'polarity', 'terminals'}:
                    missing.append(issue('model_contracts.' + name, 'invalid_model_contract', 'Declare exactly polarity and the ordered terminal roles.')); continue
                models[name] = copy.deepcopy(contract)
                provenance[name] = {'basis': 'explicit_intake_contract', 'candidate_scope_matches': bool(scope_matches)}
            elif scope_matches and len(rows) == 1 and rows[0].get('confidence') == 'verified' and rows[0].get('needs_confirmation') is False:
                models[name] = {'polarity': rows[0].get('polarity'), 'terminals': copy.deepcopy(rows[0].get('ordered_terminal_roles'))}
                provenance[name] = {'basis': 'verified_candidate_scope', 'candidate_scope_matches': True}
            else:
                missing.append(issue('model_contracts.' + name, 'model_semantics_unconfirmed',
                    'Model polarity and ordered terminals require verified evidence for exactly the selected section scope or an explicit contract.'))
        result['provenance']['model_contracts'] = provenance
        if missing or spec is None: return result
        profile = {'schema': 'spiceowl.experiment-model-profile.v1', 'id': 'intake-model',
            'models': models, 'corners': {'selected': [{'alias': 'PDK_MAIN', 'section': section} for section in selected_sections]}}
        validate_model_profile(profile); result['electrical'] = profile
        if len(observed['instances']) != 2:
            missing.append(issue('source.instances', 'inverter_instance_count', 'This intake recipe requires exactly two directly supplied MOS instances.'))
            return result
        interfaces = observed['interfaces']; transformed = raw; insertions = []
        if len(interfaces) == 1:
            cell = interfaces[0]['name']
            wrapper = {'added': False, 'subcircuit': cell, 'transformation': 'none', 'insertions': []}
        elif not interfaces:
            # Insertion, rather than reserialization, preserves every original
            # byte. Headers/comments stay in place before the first instance.
            line = min(row['line'] for row in observed['instances'])
            offset = sum(len(part) for part in raw.splitlines(keepends=True)[:line-1])
            ports = [intent[k] for k in ('input_port', 'output_port', 'vdd_port', 'vss_port')]
            header = ('subckt ' + WRAPPER + ' ' + ' '.join(ports) + '\n').encode()
            footer = (b'' if raw.endswith(b'\n') else b'\n') + ('ends ' + WRAPPER + '\n').encode()
            transformed = raw[:offset] + header + raw[offset:] + footer
            insertions = [{'original_byte_offset': offset, 'text': header.decode()},
                          {'original_byte_offset': len(raw), 'text': footer.decode()}]
            cell = WRAPPER
            wrapper = {'added': True, 'subcircuit': cell, 'transformation': 'added_explicit_subcircuit_wrapper',
                       'insertions': insertions, 'original_bytes_preserved': True,
                       'scope': 'new isolated inverter experiment; original source had no subcircuit wrapper'}
        else:
            missing.append(issue('source.interfaces', 'ambiguous_source_cell', 'Provide one explicit source cell or a flat two-device fragment.'))
            return result
        parse_sources({source_id: transformed})
        selection = {'mode': 'cell', 'source_id': source_id, 'subcircuit': cell}
        result.update(source={'source_id': source_id, 'text': transformed.decode(),
                              'sha256': hashlib.sha256(transformed).hexdigest(), 'original_sha256': original_sha},
                      selection=selection, wrapper=wrapper)
        prepared = prepare_experiment({source_id: transformed}, selection, spec, profile)
        if prepared['status'] != 'ready':
            missing.extend(prepared['missing']); return result
        result['provenance'].update(intent_sha256=digest(intent),
            nominal_temperature_k=spec['nominal_temperature_k'],
            prepared_source_sha256=result['source']['sha256'], compiler_recipe_sha256=prepared['recipe']['recipe_sha256'],
            transformation=wrapper['transformation'], source_commit=None, scientific_criteria_review_required=True)
        result['status'] = 'ready'
        return result
    except DomainError as error:
        missing.append(issue(getattr(error, 'field', 'recipe'), error.code, str(error)))
    except (ValueError, TypeError, KeyError, OverflowError, UnicodeError, RecursionError):
        missing.append(issue('recipe', 'unsupported_intake_input', 'The supplied source, intent or model evidence is outside the bounded recipe format.'))
    return result
