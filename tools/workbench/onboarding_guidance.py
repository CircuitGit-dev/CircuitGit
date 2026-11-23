"""Finite next-step guidance computed only from the selected intake snapshot."""
import copy


TOOLS = {'ssh-hosts': 'ssh_hosts', 'session': 'session', 'probe': 'probe',
         'discover-pdk': 'discover_pdk', 'prepare': 'prepare', 'run': 'run',
         'submission': 'submission', 'inspect': 'inspect',
         'waveforms/catalog': 'waveforms_catalog', 'waveforms/mapping': 'waveforms_mapping',
         'waveforms/window': 'waveforms_window'}


def action(operation, arguments, *, ready=True, missing=(), reason, description):
    read = operation in {'ssh-hosts', 'session', 'submission', 'waveforms/catalog',
                         'waveforms/mapping', 'waveforms/window'}
    return {'id': operation, 'tool': 'ic_onboarding_' + TOOLS[operation], 'operation': operation,
            'kind': 'read' if read else 'execution' if operation in {'run', 'inspect'} else 'configuration',
            'ready': ready, 'arguments': copy.deepcopy(arguments), 'missing': copy.deepcopy(list(missing)),
            'reason_code': reason, 'description': description}


def missing(field, code, message):
    return {'field': field, 'code': code, 'message': message}


def next_actions(state):
    """Guidance is not authority and never performs a scan, retry or submission."""
    identity = {'intake_id': state['intake_id']}
    current = {**identity, 'revision': state['revision']}
    plans = state.get('plans', [])
    unresolved = [p for p in plans if p.get('dispatch_outcome') in {'attempting', 'unknown'}]
    if unresolved:
        return [action('submission', {**identity, 'plan_id': p['plan_id']}, reason='original_submission_unresolved',
                       description='Read the original submission receipt. Do not create another plan or replay run.')
                for p in unresolved]
    if state.get('state') in {'probe', 'discover-pdk', 'prepare', 'submitting'}:
        return [action('session', identity, reason='operation_in_progress',
                       description='Read this intake after the current operation finishes; do not start another mutation.')]
    job = state.get('job')
    if job:
        bound = {**identity, 'job_id': job['job_id']}
        if job.get('inspection_state') == 'uncertain':
            return [action('session', identity, reason='original_job_requires_reconciliation',
                           description='Keep the original job. Inspect its saved evidence before requesting any new execution.')]
        if job.get('inspection_state') == 'complete':
            if (job.get('waveforms') or {}).get('available') is True:
                return [action('waveforms/catalog', bound, reason='original_waveforms_available',
                               description='Read this job’s saved signal catalog; no SSH or extraction is started.'),
                        action('waveforms/mapping', bound, reason='original_mapping_available',
                               description='Read the source and signal mapping for this original job.')]
            return [action('session', identity, reason='inspection_complete_without_verified_waveforms',
                           description='Read the completed report and its explicit waveform availability limitation.')]
        return [action('inspect', bound, reason='original_job_pending',
                       description='Observe the original job and collect its terminal results. This does not submit another job.')]
    prepared = state.get('prepared') or {}
    if prepared.get('state') == 'prepared' and prepared.get('plan_id'):
        plan = next((p for p in plans if p['plan_id'] == prepared['plan_id']), {})
        if plan.get('dispatch_outcome') == 'pre_dispatch_rejected':
            return [action('prepare', {**current, 'accept_recommendation': True},
                           ready=False, missing=[missing('preflight', 'preflight_condition_unresolved',
                               'Resolve the recorded resource or dependency condition before deliberately preparing again.')],
                           reason='previous_request_rejected_before_reservation',
                           description='After resolving the preflight condition, deliberately prepare a new plan. Do not replay the rejected request.')]
        if plan.get('dispatch_outcome') in {'recorded', 'attempting', 'unknown'}:
            return [action('submission', {**identity, 'plan_id': prepared['plan_id']},
                           reason='original_submission_receipt_required',
                           description='Recover the existing job by its original plan identity.')]
        return [action('run', {**current, 'plan_id': prepared['plan_id']}, reason='frozen_plan_ready',
                       description='Submit this exact frozen plan once after checking resources in the selected host range.')]
    discovery = state.get('discovery')
    if discovery:
        recommended = state.get('recommended_selection') or discovery.get('recommended_selection')
        if recommended:
            args = {**current, 'accept_recommendation': True,
                    'recommendation_id': recommended['recommendation_id'],
                    'recommendation_revision': recommended['recommendation_revision']}
            gaps = recommended.get('missing', [])
            # A previous preparation may have found more recent audit failures.
            if prepared.get('state') == 'blocked':
                gaps = prepared.get('missing') or gaps
            return [action('prepare', args, ready=not gaps, missing=gaps,
                           reason='recommendation_ready' if not gaps else 'recommendation_needs_input',
                           description='Accept the displayed recommendation or provide field overrides, then validate the final dependency closure.')]
        candidates = discovery.get('candidates', [])
        if candidates:
            return [action('prepare', current, ready=False,
                           missing=discovery.get('recommendation_missing') or [missing('candidate_id', 'entry_choice_needed',
                               'Select one ranked entry; its remaining supported fields can be prefilled.')],
                           reason='model_entry_choice_needed', description='Choose an observed ranked model entry before preparing.')]
        directories = [row for row in discovery.get('search_directories', [])
                       if row.get('automatic_search_allowed') is True]
        if directories:
            def priority(row):
                label = row.get('label', '').lower()
                return (0 if 'spectre' in label or '/models' in label else 1,
                        0 if 'contains_candidate_model_files' in row.get('basis', []) else 1,
                        label, row['directory_id'])
            chosen = sorted(directories, key=priority)[:1]
            return [action('discover-pdk', {**current, 'probe_ids': [chosen[0]['probe_id']],
                                           'search_directory_ids': [chosen[0]['directory_id']]},
                           reason='narrow_observed_search',
                           description='Search this actually observed directory under the existing limits; its name does not qualify its models.')]
        if discovery.get('search_directories'):
            return [action('discover-pdk', current, ready=False,
                           missing=[missing('search_paths', 'automatic_search_exhausted',
                               'Observed scopes were already searched or the automatic search budget is exhausted. Provide a narrower explicit hint or inspect the discovery gaps.')],
                           reason='automatic_search_requires_input',
                           description='Stop automatic discovery here; a new discovery ID does not make an already searched scope new.')]
        return [action('discover-pdk', current, ready=False,
                       missing=discovery.get('missing') or [missing('search_paths', 'model_location_needed',
                           'Provide a model directory hint or resolve the environment observation.')],
                       reason='model_discovery_needs_input', description='Resolve the discovery gaps before preparing a simulation.')]
    probes = state.get('probes', [])
    valid = [p for p in probes if p.get('probe_id')]
    if valid:
        setups = {}; needs_setup = []; needs_activation = False
        for probe in valid:
            environment = probe.get('environment') or {}
            selected = (environment.get('activation') or {}).get('selected_source_id')
            if selected:
                # A probe refreshes every selected host. Preserve each prior
                # explicit choice so its freshly captured environment is also
                # reactivated after the runtime rechecks the source bytes.
                setups[probe['ssh_target']] = selected
                continue
            needs_activation = True
            supported = [row for row in environment.get('setup_candidates', []) if row.get('activation_supported')]
            if len(supported) == 1:
                setups[probe['ssh_target']] = supported[0]['source_id']
            else:
                needs_setup.append(missing('overrides.setup_source_ids.' + probe['ssh_target'], 'setup_choice_needed',
                                           'Choose an observed supported setup script for this host.'))
        if needs_activation:
            args = {**current, 'ssh_targets': [p['ssh_target'] for p in valid]}
            if setups: args['overrides'] = {'setup_source_ids': setups}
            return [action('probe', args, ready=not needs_setup, missing=needs_setup,
                           reason='observed_setup_selection', description='Activate the observed setup choice and recheck this selected environment.')]
        return [action('discover-pdk', {**current, 'probe_ids': [p['probe_id'] for p in valid]},
                       reason='selected_environments_observed', description='Discover model candidates using only these new environment observations.')]
    return [action('ssh-hosts', {}, reason='ssh_alias_inventory_needed',
                   description='List local SSH aliases without contacting a server.'),
            action('probe', current, ready=False,
                   missing=[missing('ssh_targets', 'host_selection_needed', 'Choose the allowed SSH targets from the returned inventory.')],
                   reason='explicit_host_selection_needed', description='Probe the explicitly selected hosts for this intake.')]
