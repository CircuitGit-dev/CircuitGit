"""Passive, bounded projections of IC run records for external supervision UIs."""
import json
import math
import re
from datetime import datetime
from pathlib import Path
from runner import stamp
from workspace import Conflict

MAX_RECORD = 1024 * 1024
ARTIFACTS = ('full-results.tar.gz', 'result-summary.json', 'archive-files.json',
             'latest-status.log', 'waveforms.csv', 'waveforms.json', 'waveforms.png')

def text(value, limit=240):
    return ''.join(c for c in value if ord(c) >= 32 and ord(c) != 127)[:limit] if isinstance(value, str) else None

def hash_value(value, size=64):
    return value if isinstance(value, str) and re.fullmatch('[a-f0-9]{%d}' % size, value) else None

def finite_number(value):
    try: return value if type(value) in (int, float) and math.isfinite(value) else None
    except (OverflowError, ValueError): return None

def library_context(record):
    """Use this run's saved evidence only, never today's project registry."""
    plan = record.get('plan') or {}
    materialization = (plan.get('provenance') or {}).get('materialization') or {}
    if not isinstance(materialization, dict): raise ValueError('Invalid saved materialization')
    if any(k in materialization for k in ('library_id', 'cell_id')):
        if materialization.get('project_id') != record.get('project_id') or materialization.get('source_commit') != record.get('source_commit'):
            raise ValueError('Stored library context has inconsistent run identity')
    result = {}
    for source in (materialization, record):
        for key in ('library_id', 'cell_id'):
            if key not in source: continue
            value = source[key]
            if value is not None and (not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}', value)):
                raise ValueError('Invalid stored library/cell identity')
            if result.get(key) is not None and value is not None and result[key] != value:
                raise ValueError('Conflicting stored library/cell identity')
            if key not in result or value is not None: result[key] = value
    return result

def execution_target(record):
    """Bounded target metadata; private site configuration never leaves the runner."""
    context = record.get('execution_context')
    if context is None:
        return ({'mode': 'fixed_site', 'host_id': None, 'plan_id': None,
                 'resource_observed_at': None, 'resource_reservation': False}
                if record.get('execution_site') is not None else None)
    if not isinstance(context, dict) or context.get('schema') != 'ic.execution.context.v1':
        raise ValueError('Invalid stored execution context')
    selection = context.get('resource_selection')
    if selection is None and 'resource_selection' in context:
        return {'mode': 'fixed_site', 'host_id': None, 'plan_id': None,
                'resource_observed_at': None, 'resource_reservation': False}
    if not isinstance(selection, dict): raise ValueError('Invalid stored resource selection')
    host_id, plan_id = selection.get('host_id'), context.get('plan_id')
    if not isinstance(host_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}', host_id) or not isinstance(plan_id, str) or not re.fullmatch('[a-f0-9]{64}', plan_id):
        raise ValueError('Invalid stored execution target')
    members = (selection.get('recommendation') or {}).get('candidates') or []
    observed = next((item.get('resource_observed_at') for item in members if isinstance(item, dict) and item.get('host_id') == host_id), None)
    if observed is not None:
        if not isinstance(observed, str) or len(observed) > 64 or not re.fullmatch(
            r'[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T'
            r'(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?'
            r'(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])', observed):
            raise ValueError('Invalid stored resource observation timestamp')
        try:
            if datetime.fromisoformat(observed).utcoffset() is None: raise ValueError()
        except (ValueError, OverflowError):
            raise ValueError('Invalid stored resource observation timestamp') from None
    return {'mode': 'resource_pool', 'host_id': host_id, 'plan_id': plan_id,
            'resource_observed_at': observed, 'resource_reservation': False}

def read_json(path, limit=MAX_RECORD):
    if path.is_symlink() or path.parent.is_symlink(): raise ValueError('Stored record must be a regular local file')
    with path.open('rb') as stream: raw = stream.read(limit + 1)
    if len(raw) > limit: raise ValueError('Stored record exceeds read limit')
    value = json.loads(raw)
    if not isinstance(value, dict): raise ValueError('Stored record must be an object')
    return value

class Supervision:
    def __init__(self, runner, projects):
        self.runner, self.projects = runner, projects

    def _read(self, run_id):
        if not isinstance(run_id, str) or not re.fullmatch('[A-Za-z0-9_-]{1,180}', run_id):
            raise ValueError('Invalid stored run identity')
        record = read_json(self.runner.path(run_id) / 'run.json')
        if record.get('run_id') != run_id: raise ValueError('Stored run identity mismatch')
        return record

    def _association(self, record):
        original = record.get('project_id')
        if isinstance(original, str) and original in self.projects:
            return original, 'recorded_project_id'
        design = (record.get('plan') or {}).get('design_id')
        if isinstance(design, str) and design in self.projects:
            return design, 'recorded_plan_design_id'
        return None, 'unregistered'

    def _project(self, record):
        run_id = record['run_id']; project, association = self._association(record)
        plan = record.get('plan') or {}; config = plan.get('configuration') or {}
        effective = config.get('effective') or {}; collection = record.get('collection') or {}
        publication = record.get('publication') or {}
        observed = text(record.get('observed_at'))
        raw_state = text(record.get('remote_state') or record.get('state'))
        exit_code = record.get('simulator_exit_code')
        exit_code = exit_code if type(exit_code) is int else None
        if exit_code == 0 and raw_state == 'simulator_complete_pending_measurements': execution = 'succeeded'
        elif exit_code is not None and exit_code != 0 or raw_state in ('simulator_failed', 'input_hash_failure', 'job_setup_failed', 'preflight_failed'): execution = 'failed'
        elif raw_state in ('running', 'running_observed'): execution = 'running'
        elif raw_state in ('queued', 'preflight'): execution = 'queued'
        else: execution = 'unknown'
        if record.get('collection_phase') == 'complete': data = 'collected'
        elif record.get('operation') == 'collecting' or record.get('collection_phase') in ('preparing', 'downloading'): data = 'collecting'
        elif record.get('collection_phase') == 'failed': data = 'failed'
        elif collection: data = 'unknown'
        else: data = 'not_collected'
        state = text(record.get('state'))
        if publication.get('status') == 'complete': state = 'archived'
        elif record.get('operation') in ('collecting', 'archiving'): state = record['operation']
        elif data == 'collected': state = 'collected'
        metrics = []
        for metric in (record.get('scientific_metrics') or [])[:16]:
            if not isinstance(metric, dict) or not isinstance(metric.get('name'), str): continue
            value = metric.get('value')
            metrics.append({'name': text(metric['name'], 160),
                'value': finite_number(value),
                'unit': text(metric.get('unit')), 'passed': metric.get('passed') if type(metric.get('passed')) is bool else None,
                'scope': text(metric.get('scope'))})
        digests = {'full-results.tar.gz': collection.get('sha256'), 'waveforms.csv': record.get('postprocess_csv_sha256')}
        artifacts = []; folder = self.runner.path(run_id)
        for name in ARTIFACTS:
            path = folder / name
            if path.is_symlink() or not path.is_file(): continue
            size = path.stat().st_size; digest = hash_value(digests.get(name))
            artifacts.append({'name': name, 'bytes': size, 'sha256': digest,
                'url': '/api/jobs/' + run_id + '/artifacts/' + name,
                'digest_source': 'stored_record' if digest else 'unavailable'})
        waveform_id = None; source = hash_value(record.get('source_commit'), 40)
        try:
            waveform = read_json(folder / 'waveforms.json', 2 * MAX_RECORD)
            if waveform.get('run_id') == run_id and source is not None and waveform.get('source_commit') == source:
                waveform_id = run_id
        except (OSError, ValueError, TypeError): pass
        compiled = hash_value(effective.get('compiled_inputs_sha256'))
        issues = []
        if not observed: issues.append({'code': 'observation_missing', 'message': 'No saved remote observation is available.'})
        if not compiled: issues.append({'code': 'compiled_hash_missing', 'message': 'This historical record has no compiled input hash.'})
        if project is None: issues.append({'code': 'project_unregistered', 'message': 'The recorded project is not associated with the current registry.'})
        for key in ('error', 'status_error', 'operation_error', 'postprocess_error'):
            if record.get(key): issues.append({'code': key, 'message': 'The saved run records an error; inspect its existing logs.'})
        if record.get('synthetic') is True or record.get('fixture') is True:
            issues.append({'code': 'synthetic_fixture', 'message': 'Synthetic fixture; not evidence of real simulation.'})
        target = execution_target(record)
        return {**library_context(record), **({'execution_target': target} if target is not None else {}),
            'run_id': run_id, 'project_id': project, 'original_project_id': text(record.get('project_id')),
            'association_basis': association, 'source_commit': source, 'configuration': text(record.get('configuration_id')),
            'compiled_inputs_sha256': compiled, 'state': state,
            'execution': {'state': execution, 'raw_state': raw_state, 'exit_code': exit_code, 'observed_at': observed},
            'observation': {'state': 'recorded' if observed else 'missing', 'observed_at': observed},
            'data': {'state': data, 'raw_retained': collection.get('contains_full_raw') if type(collection.get('contains_full_raw')) is bool else None},
            'specification': {'state': 'reported' if metrics else 'not_evaluated', 'metrics': metrics},
            'latest_observed_at': observed, 'record_updated_at': text(record.get('updated_at')),
            'issues': issues[:8], 'waveform_run_id': waveform_id, 'artifacts': artifacts}

    def snapshot(self, project_id):
        if not isinstance(project_id, str) or project_id not in self.projects: raise FileNotFoundError('Unknown project')
        records = sorted(self.runner.root.glob('*/run.json'), key=lambda p: p.parent.name, reverse=True)
        runs = []; scanned = unavailable = 0; overflow = False
        for path in records[:200]:
            scanned += 1
            try:
                record = self._read(path.parent.name)
                if self._association(record)[0] != project_id: continue
                projected = self._project(record)
            except (OSError, ValueError, TypeError, AttributeError):
                unavailable += 1; continue
            if len(runs) == 25: overflow = True; break
            runs.append(projected)
        return {'schema': 'ic.supervision.snapshot.v1', 'project_id': project_id, 'read_at': stamp(),
            'source': 'stored_observations', 'runs': runs, 'scanned_records': scanned,
            'unavailable_records': unavailable, 'truncated': len(records) > scanned or overflow,
            'single_site': getattr(self.runner, 'resource_recheck', None) is None}

    def submission(self, key):
        run_id = self.runner.lookup_submission(key)
        try: run = self._project(self._read(run_id)) if run_id is not None else None
        except (OSError, ValueError, TypeError, AttributeError) as error:
            raise Conflict('Submission mapping exists but its saved run cannot be read; reconcile the original request, do not resubmit') from error
        return {'schema': 'ic.submission.lookup.v1', 'submission_key': key, 'read_at': stamp(),
            'found': run is not None, 'run_id': run_id, 'run': run}
