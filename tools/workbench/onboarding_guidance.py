"""Finite next-step guidance computed only from the selected intake snapshot."""
import copy


TOOLS = {'ssh-hosts': 'ssh_hosts', 'source':'source', 'session': 'session', 'probe': 'probe',
         'discover-pdk': 'discover_pdk', 'prepare': 'prepare', 'run': 'run',
         'submission': 'submission', 'inspect': 'inspect',
         'waveforms/catalog': 'waveforms_catalog', 'waveforms/mapping': 'waveforms_mapping',
         'waveforms/window': 'waveforms_window', 'agent-tb':'agent_tb',
         'agent-tb/draft':'agent_tb_draft','agent-tb/prepare':'agent_tb_prepare'}


def action(operation, arguments, *, ready=True, missing=(), reason, description):
    read = operation in {'ssh-hosts', 'session', 'submission', 'waveforms/catalog',
                         'waveforms/mapping', 'waveforms/window', 'agent-tb', 'source'}
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
    if state.get('state') in {'probe', 'discover-pdk', 'select-pdk-scope', 'prepare', 'agent-tb/draft', 'agent-tb/prepare', 'submitting'}:
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
    agent_mode = state.get('mode') == 'agent-tb'
    draft = state.get('agent_tb') or {}
    discovery = state.get('discovery') or {}
    binding_gaps=[];binding_probes=set()
    for lut in discovery.get('lut',[]):
        from onboarding_discovery import pending_library_binding
        binding=pending_library_binding(lut)
        if binding is not None:
            binding_probes.add(lut['probe_id'])
            binding_gaps.extend({**gap,'probe_id':lut['probe_id']} for gap in binding['missing'])
    if agent_mode and not draft:
        return [action('source', identity, reason='exact_source_required', description='Read the literal DUT and every supplied support source before authoring its testbench.'),
                action('agent-tb/draft', current, ready=False,
                       missing=[missing('testbench', 'agent_authored_testbench_required',
                           'Discuss objectives and criteria with the user, then provide the complete authored testbench manifest.'),*binding_gaps],
                       reason='agent_testbench_draft_required',
                       description='Author the testbench, port bindings, stimuli, analyses and acceptance criteria for this exact circuit. No inverter topology or scientific intent is inferred.'),
                action('ssh-hosts', {}, reason='ssh_alias_inventory_needed',
                       description='List local SSH aliases without contacting a server.')]
    if agent_mode and draft.get('status') == 'binding_stale':
        return [action('agent-tb/draft', current, ready=False,
            missing=[missing('selection','testbench_binding_stale',
                'Preserve the authored testbench and save a new draft with the current explicit PDK scope.')],
            reason='agent_testbench_binding_stale',
            description='Model or probe selection changed. The previous draft remains preserved; explicitly rebind and save it before preparation.')]
    prepared = state.get('prepared') or {}
    if prepared.get('state') == 'prepared' and prepared.get('plan_id'):
        plan = next((p for p in plans if p['plan_id'] == prepared['plan_id']), {})
        if agent_mode and plan.get('dispatch_outcome') not in {'recorded','attempting','unknown','pre_dispatch_rejected'}:
            item = action('run', {**current, 'plan_id': prepared['plan_id']}, reason='human_testbench_review_required',
                description='Request host-human review of this exact frozen source, testbench, PDK and criteria. The agent cannot approve or dispatch it. In the browser use the Simulation review window.')
            item.update(kind='human_review', requires_human_review=True)
            return [item]
        if agent_mode and plan.get('dispatch_outcome') == 'pre_dispatch_rejected':
            return [action('agent-tb/prepare', {**current, 'draft_id': draft['draft_id']}, ready=False,
                missing=[missing('preflight','preflight_condition_unresolved','Resolve the recorded condition before preparing and reviewing a new plan.')],
                reason='previous_request_rejected_before_reservation', description='Preserve the rejected plan and deliberately prepare a new human review after resolving its condition.')]
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
    if agent_mode and discovery:
        selection = draft.get('selection') or {}
        if 'scope_selection_id' in selection:
            scope = state.get('pdk_scope_selection') or {}
            gaps = list(scope.get('missing') or [])
            hosts = selection.get('host_ids') or []
            observed = {row['ssh_target']:row['probe_id'] for row in state.get('probes', [])}
            if not hosts or set(hosts)-set(observed):
                gaps.append(missing('host_ids','host_scope_not_observed',
                    'Select only hosts from the current intake probe observations, then save the draft again.'))
            if scope.get('probe_id') not in [observed[host] for host in hosts if host in observed]:
                gaps.append(missing('host_ids','audit_host_outside_scope',
                    'The selected host range must include the host that observed this exact PDK scope.'))
            if scope.get('selection_id') != selection['scope_selection_id'] or scope.get('status') != 'requires_audit':
                gaps.append(missing('scope_selection_id','pdk_scope_not_auditable',
                    'Select an observed same-entry scope, resolve its missing evidence, and save the exact draft binding.'))
            if prepared.get('state') == 'blocked':
                gaps.extend(prepared.get('missing') or [])
            return [action('agent-tb/prepare', {**current, 'draft_id': draft['draft_id']}, ready=not gaps,
                missing=gaps, reason='agent_testbench_scope_audit_required',
                description='Freshly audit the exact cached PDK scope and freeze this authored testbench for human review. No simulation is launched.')]
        selected=next((row for row in discovery.get('candidates',[])
                       if row['candidate_id']==selection.get('candidate_id')),None)
        pending=binding_gaps if selected is None else [gap for gap in binding_gaps
            if gap['probe_id']==selected['probe_id']]
        gaps = list(state.get('missing') or [])+pending
        if not selection:
            gaps.append(missing('selection','explicit_pdk_selection_required','Choose the observed PDK entry, sections and host range, then save the complete draft again.'))
            return [action('agent-tb/draft', current, ready=False, missing=gaps,
                reason='agent_testbench_selection_required', description='Use observed LUT/discovery evidence to bind this draft; do not infer inverter ports or stimulus.')]
        return [action('agent-tb/prepare', {**current, 'draft_id': draft['draft_id']}, ready=not gaps, missing=gaps,
            reason='agent_testbench_prepare_required', description='Validate the literal agent-authored testbench and selected dependencies, then freeze them for human review. No simulation is launched.')]
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
        if binding_gaps:
            gaps=binding_gaps+[gap for gap in discovery.get('missing',[])
                if gap.get('probe_id') not in binding_probes]
            return [action('session', identity, reason='cached_library_binding_pending',
                           description='The library index is available. Inspect its cached binding gaps; no new discovery is needed for this index.'),
                    action('prepare', current, ready=False, missing=gaps,
                           reason='cached_library_binding_pending',
                           description='Resolve the explicit cached entry and section combination and its dependency audit before preparation.')]
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
        if len(valid)>2:
            return [action('discover-pdk', current, ready=False,
                           missing=[missing('probe_ids','discovery_batch_selection_needed',
                                            'Select one or two observed hosts for this full-library discovery batch.')],
                           reason='bounded_discovery_batch_needed',
                           description='Keep the observed hosts and select an explicit batch of at most two for model discovery.')]
        return [action('discover-pdk', {**current, 'probe_ids': [p['probe_id'] for p in valid]},
                       reason='selected_environments_observed', description='Discover model candidates using only these new environment observations.')]
    return [action('ssh-hosts', {}, reason='ssh_alias_inventory_needed',
                   description='List local SSH aliases without contacting a server.'),
            action('probe', current, ready=False,
                   missing=[missing('ssh_targets', 'host_selection_needed', 'Choose the allowed SSH targets from the returned inventory.')],
                   reason='explicit_host_selection_needed', description='Probe the explicitly selected hosts for this intake.')]
