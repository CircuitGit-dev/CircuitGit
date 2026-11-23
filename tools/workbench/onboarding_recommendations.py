"""Project new observations into reviewable choices; never run or read a site."""
import copy
import json
import re

from onboarding_discovery import digest
from workspace import Conflict


SELECTION_FIELDS = ('discovery_id', 'candidate_id', 'sections', 'tmi_candidate_id',
                    'model_contracts', 'intent')
INTENT_FIELDS = ('supply_v', 'frequency_hz', 'temperature_c', 'nominal_temperature_c',
                 'input_port', 'output_port', 'vdd_port', 'vss_port', 'cycles',
                 'load_f', 'rise_s', 'fall_s', 'points_per_period')
PRIVATE_FIELDS = {'path', 'source_path', 'entry_path', 'directory', 'resolved_path',
                  'dependency_paths', 'roots', 'source_text', 'original_text'}
# Leave room for the subsequent selection, frozen plan and response envelope.
# These are below the existing 2 MiB HTTP and 4 MiB local-record limits.
SESSION_HTTP_BUDGET = 2 * 1024 * 1024 - 128 * 1024
SESSION_RECORD_BUDGET = 4 * 1024 * 1024 - 256 * 1024


def _omit_basis(value, prefix, omitted):
    if isinstance(value, dict):
        for key, child in value.items():
            path = prefix + '.' + key if prefix else key
            if key == 'basis' and isinstance(child, list) and child:
                value[key] = []; omitted.add(path)
            elif isinstance(child, (dict, list)):
                _omit_basis(child, path, omitted)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _omit_basis(child, prefix + '[' + str(index) + ']', omitted)


def _compact_choice(choice, *, fields):
    """Only optional explanations change; the ID remains the original draft ID."""
    provenance = choice.get('provenance')
    if not isinstance(provenance, dict):
        return
    omitted = set(provenance.get('omitted', []))
    for key in ('basis', 'choice_basis'):
        if isinstance(provenance.get(key), list) and provenance[key]:
            provenance[key] = []; omitted.add(key)
    if fields:
        _omit_basis(provenance.get('fields', {}), 'fields', omitted)
    if omitted:
        provenance.update(omitted=sorted(omitted), omission_reason='session_size_budget')
        choice.update(recommendation_id_basis='complete_original_draft', public_rehash_supported=False)


def bound_session_recommendations(state, public_serializer):
    """Bound an owned future session before persistence; never remove core data.

    The exact serializers mirror Handler.send and runner.atomic. Trimming only
    duplicated optional recommendation explanations keeps all candidate/model
    source evidence, Field values and missing/ready states intact. The frozen
    recommendation ID is not recomputed from this presentation projection.
    """
    def fits():
        public = public_serializer(state)
        wire = json.dumps({'ok': True, 'data': public}, ensure_ascii=False, allow_nan=False).encode()
        stored = json.dumps(state, indent=2, allow_nan=False).encode() + b'\n'
        return len(wire) <= SESSION_HTTP_BUDGET and len(stored) <= SESSION_RECORD_BUDGET
    if fits():
        return
    discovery = state.get('discovery') or {}
    primary_ids = {row['recommendation_id'] for row in
                   (state.get('recommended_selection'), discovery.get('recommended_selection'))
                   if isinstance(row, dict) and 'recommendation_id' in row}
    candidates = discovery.get('candidates', [])
    secondary = [row for row in candidates if isinstance(row.get('recommendation'), dict)
                 and row['recommendation'].get('selection', {}).get('recommendation_id') not in primary_ids]
    for include_fields in (False, True):
        for candidate in secondary:
            recommendation = candidate['recommendation']
            if recommendation.get('rank_basis'):
                recommendation.update(rank_basis=[], omitted=['rank_basis'], omission_reason='session_size_budget')
            _compact_choice(recommendation.get('selection', {}), fields=include_fields)
        if fits():
            return
    # Keep the primary recommendation's full explanation whenever alternatives
    # alone provide enough room. Repeated primary copies may be distinct after
    # JSON readback, so compact each representation without changing identity.
    primary = [state.get('recommended_selection'), discovery.get('recommended_selection')]
    primary += [row.get('recommendation', {}).get('selection') for row in candidates
                if row.get('recommendation', {}).get('selection', {}).get('recommendation_id') in primary_ids]
    for choice in primary:
        if isinstance(choice, dict):
            _compact_choice(choice, fields=True)
    for candidate in candidates:
        recommendation = candidate.get('recommendation') or {}
        if recommendation.get('rank_basis'):
            recommendation.update(rank_basis=[], omitted=['rank_basis'], omission_reason='session_size_budget')
    suggestions = state.get('intent_suggestions')
    if isinstance(suggestions, dict):
        omitted = set(suggestions.get('omitted', []))
        _omit_basis(suggestions.get('fields', {}), 'fields', omitted)
        if omitted:
            suggestions.update(omitted=sorted(omitted), omission_reason='session_size_budget')
    if not fits():
        raise ValueError('Onboarding session core data exceeds its bounded storage or response budget; narrow the explicit discovery scope. No candidates or model contracts were discarded.')


def public_evidence(value):
    """Recommendation explanations carry metadata, never private file addresses."""
    if isinstance(value, dict):
        return {k: public_evidence(v) for k, v in value.items()
                if k not in PRIVATE_FIELDS and not (
                    isinstance(v, str) and (v.startswith('/') or re.match(r'^[A-Za-z]:[\\/]', v)))}
    if isinstance(value, list):
        return [public_evidence(v) for v in value if not (isinstance(v, str) and v.startswith('/'))]
    return copy.deepcopy(value)


def field_value(field):
    return copy.deepcopy(field.get('value')) if isinstance(field, dict) else None


def intent_values(suggestion):
    return {name: field_value(field) for name, field in suggestion.get('fields', {}).items()
            if name in INTENT_FIELDS and field_value(field) is not None}


def source_intent(requirements):
    from spiceowl.onboarding.recommendations import suggest_intent
    explanation = public_evidence(suggest_intent(requirements))
    return intent_values(explanation), explanation


def gap(field, code, message):
    return {'field': field, 'code': code, 'message': message}


def _gaps(rows, prefix=''):
    result = []
    for row in rows or []:
        if isinstance(row, str):
            result.append(gap(prefix or 'recommendation', row, 'Resolve the reported recommendation condition.'))
        elif isinstance(row, dict):
            field = row.get('field') or prefix or 'recommendation'
            if prefix and field != prefix and not field.startswith(prefix + '.'):
                field = prefix + '.' + field
            result.append(gap(field, row.get('code', 'recommendation_input_missing'),
                              row.get('message', 'Provide this explicit experiment choice.')))
    return result


def _unique_gaps(rows):
    seen, result = set(), []
    for row in rows:
        key = (row['field'], row['code'])
        if key not in seen:
            seen.add(key); result.append(row)
    return result


def _project_choice(raw, proposal, candidate, state, discovery_id):
    models = {name: field_value(field) for name, field in proposal.get('model_contracts', {}).items()
              if field_value(field) is not None}
    sections = field_value(proposal.get('sections'))
    relative = field_value(proposal.get('tmi_relative_library'))
    platform_id = digest({'candidate_id': raw['candidate_id'], 'relative_library': relative}) if relative else None
    if platform_id and platform_id not in {p['tmi_candidate_id'] for p in candidate['tmi_candidates']}:
        raise ValueError('Recommended platform is absent from this exact discovery')
    suggestions = proposal.get('intent') or {}
    intent = intent_values(suggestions)
    missing = _gaps(proposal.get('missing')) + _gaps(suggestions.get('missing'), 'intent')
    tmi_field = copy.deepcopy(proposal.get('tmi_relative_library'))
    if isinstance(tmi_field, dict):
        tmi_field['value'] = platform_id
    fields = {'sections': proposal.get('sections'), 'tmi_candidate_id': tmi_field,
              'model_contracts': proposal.get('model_contracts', {}), 'intent': suggestions.get('fields', {})}
    for name, field in proposal.get('model_contracts', {}).items():
        missing += _gaps(field.get('missing'), 'model_contracts.' + name)
    for name in ('sections', 'tmi_relative_library'):
        missing += _gaps((proposal.get(name) or {}).get('missing'), name)
    for name in state['source']['requirements']['required_masters']:
        if name not in models:
            missing.append(gap('model_contracts.' + name, 'model_semantics_unconfirmed',
                               'No supported source-backed device contract is available.'))
    for name in INTENT_FIELDS:
        if name not in intent:
            missing.append(gap('intent.' + name, 'intent_missing', 'Provide this experiment condition.'))
    if not sections:
        missing.append(gap('sections', 'sections_missing', 'Select an observed model section combination.'))
    if candidate['tmi_candidates'] and platform_id is None:
        missing.append(gap('tmi_candidate_id', 'tmi_selection_missing', 'Select a compatible observed platform library.'))
    choice = {'schema': 'ic.onboarding.recommended-selection.v1',
              'recommendation_revision': state['revision'], 'source_sha256': state['source_sha256'],
              'discovery_id': discovery_id, 'candidate_id': candidate['candidate_id'],
              'sections': sections, 'tmi_candidate_id': platform_id, 'model_contracts': models,
              'intent': intent, 'missing': _unique_gaps(missing),
              'provenance': {'preset': suggestions.get('preset'), 'fields': public_evidence(fields),
                             'basis': public_evidence(proposal.get('rank_basis', []))},
              'requires_acceptance': True, 'fresh_dependency_audit_required': True, 'ready_to_run': False}
    choice['ready_for_prepare'] = not choice['missing']
    choice['recommendation_id'] = digest(choice)
    return choice


def attach_recommendations(public, rows, state):
    """Bind inert SpiceOwl suggestions to this intake/probe's public identities."""
    from spiceowl.onboarding.recommendations import recommend_onboarding
    discovery_id = public['discovery_id']
    by_id = {c['candidate_id']: c for c in public['candidates']}
    eligible, engine_missing = [], []
    for row in rows:
        data = row.get('result')
        if not data or not data.get('entry_candidates'):
            continue
        recommendation = recommend_onboarding(data, state['source']['requirements'], row.get('platform'))
        raw_by_id = {c['candidate_id']: c for c in data['entry_candidates']}
        engine_missing += _gaps(recommendation.get('missing'))
        for proposal in recommendation.get('candidates', []):
            raw = raw_by_id[proposal['candidate_id']]
            public_id = digest({'probe_id': row['probe_id'], 'candidate_id': raw['candidate_id']})
            candidate = by_id[public_id]
            choice = _project_choice(raw, proposal, candidate, state, discovery_id)
            candidate['recommended_tmi_candidate_id'] = choice['tmi_candidate_id']
            candidate['recommendation'] = {'rank': proposal.get('rank'), 'score': proposal.get('score'),
                                           'rank_basis': public_evidence(proposal.get('rank_basis', [])),
                                           'selection': choice}
            if recommendation.get('recommended_candidate_id') == raw['candidate_id']:
                choice['provenance'].update(selection_confidence=recommendation.get('selection_confidence'),
                    choice_basis=public_evidence(recommendation.get('choice_basis', [])),
                    equivalence_not_proven=recommendation.get('equivalence_not_proven', False),
                    alternative_candidate_ids=[digest({'probe_id': row['probe_id'], 'candidate_id': identifier})
                        for identifier in recommendation.get('alternatives', [])])
                choice['recommendation_id'] = digest({k: v for k, v in choice.items() if k != 'recommendation_id'})
                # Equivalent observations on selected hosts need one UI choice;
                # execution still checks every allowed host at submission time.
                signature = digest({'entry_sha256': raw['entry_sha256'], 'sections': choice['sections'],
                                    'models': choice['model_contracts'], 'intent': choice['intent'],
                                    'tmi_relative_library': field_value(proposal.get('tmi_relative_library'))})
                eligible.append((signature, choice))
    signatures = {signature for signature, _ in eligible}
    selected = eligible[0][1] if len(signatures) == 1 else None
    if len(signatures) > 1:
        engine_missing.append(gap('candidate_id', 'cross_host_recommendation_ambiguous',
                                  'Selected hosts expose different recommended model definitions; choose an entry.'))
    public['recommended_selection'] = selected
    public['recommendation_missing'] = _unique_gaps(engine_missing)
    public['candidate_groups'] = [
        {'kind': 'recommended_entry', 'candidate_ids': [selected['candidate_id']] if selected else []},
        {'kind': 'other_entries', 'candidate_ids': [c['candidate_id'] for c in public['candidates']
            if c['entry_role'] != 'definition_only' and (not selected or c['candidate_id'] != selected['candidate_id'])]},
        {'kind': 'definition_fragments', 'candidate_ids': [c['candidate_id'] for c in public['candidates']
            if c['entry_role'] == 'definition_only' and (not selected or c['candidate_id'] != selected['candidate_id'])]},
    ]
    return public


def resolve_preparation(state, args):
    """Accept the current recommendation by default, preserving explicit overrides."""
    allowed = {'intake_id', 'revision', 'accept_recommendation', 'recommendation_id',
               'recommendation_revision', *SELECTION_FIELDS}
    if set(args) - allowed or not {'intake_id', 'revision'} <= set(args):
        raise ValueError('Use bounded intake preparation fields')
    if 'accept_recommendation' in args and type(args['accept_recommendation']) is not bool:
        raise ValueError('accept_recommendation must be a boolean')
    discovery = state.get('discovery') or {}
    recommendation = state.get('recommended_selection') or discovery.get('recommended_selection')
    # An explicitly selected alternative may have its own complete recommendation.
    if args.get('candidate_id') and (not recommendation or args['candidate_id'] != recommendation['candidate_id']):
        candidate = next((c for c in discovery.get('candidates', []) if c['candidate_id'] == args['candidate_id']), None)
        recommendation = ((candidate or {}).get('recommendation') or {}).get('selection')
    for field in ('recommendation_id', 'recommendation_revision'):
        if field in args and (not recommendation or type(args[field]) is not type(recommendation[field])
                              or args[field] != recommendation[field]):
            raise Conflict('The displayed recommendation changed; read this intake before preparing')
    complete_legacy = all(field in args for field in SELECTION_FIELDS)
    use_recommendation = args.get('accept_recommendation') is not False and (
        not complete_legacy or args.get('accept_recommendation') is True
        or 'recommendation_id' in args or 'recommendation_revision' in args)
    if not use_recommendation and not complete_legacy:
        raise ValueError('Provide the complete explicit selection when recommendation acceptance is disabled')
    if use_recommendation and recommendation is None:
        return None, [gap('candidate_id', 'recommendation_unavailable',
                          'Choose an observed entry or resolve the reported recommendation gaps.')], {
                              'mode': 'recommendation_default', 'recommendation_id': None, 'overrides': []}
    resolved = {field: copy.deepcopy(recommendation[field]) for field in SELECTION_FIELDS} if use_recommendation else {}
    overrides = []
    for field in SELECTION_FIELDS:
        if field not in args:
            continue
        value = args[field]
        if field in ('intent', 'model_contracts') and use_recommendation:
            if not isinstance(value, dict):
                raise ValueError(field + ' overrides must be an object')
            merged = dict(resolved[field]); merged.update(copy.deepcopy(value)); resolved[field] = merged
            overrides += [field + '.' + key for key in value]
        else:
            resolved[field] = copy.deepcopy(value); overrides.append(field)
    resolved.update(intake_id=args['intake_id'], revision=args['revision'])
    if resolved['discovery_id'] != discovery.get('discovery_id'):
        raise Conflict('Select the current discovery for this intake')
    provenance = {'mode': 'recommendation_default' if use_recommendation else 'explicit_selection',
                  'recommendation_id': recommendation['recommendation_id'] if use_recommendation else None,
                  'recommendation_revision': recommendation['recommendation_revision'] if use_recommendation else None,
                  'overrides': overrides, 'scientific_intent_discovered': False}
    remaining = []
    if use_recommendation:
        for item in recommendation.get('missing', []):
            field = item['field']
            if field in INTENT_FIELDS:
                field = 'intent.' + field
            if field == 'tmi_relative_library':
                field = 'tmi_candidate_id'
            supplied = any(field == override or field.startswith(override + '.') for override in overrides)
            if field in {'ports', 'intent.ports'}:
                supplied = all('intent.' + name in overrides for name in
                    ('input_port', 'output_port', 'vdd_port', 'vss_port'))
            if not supplied:
                remaining.append(item)
    return resolved, remaining, provenance
