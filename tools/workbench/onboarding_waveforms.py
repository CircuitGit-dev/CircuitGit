"""Bounded saved-waveform reads for an intake's already recorded original job.

The parent runtime supplies the binding resolver from its private intake store.
No request accepts an artifact path, a source path, a mapping manifest or a run
substitution. This adapter never observes remote status, derives data, collects,
submits, or registers a mapping. Current geometry matching is intentionally left
disabled until the UI has a separately proved exact graphical context.
"""
from dataclasses import dataclass
import json
import math
import re

from waveforms import WaveformError, WaveformService


SCHEMA = 'ic.onboarding.waveforms.v1'
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_QUERY_BYTES = 4096
MAX_WINDOW_SIGNALS = 8
MAX_POINTS = 10000
DEFAULT_POINTS = 1600
_INTAKE = re.compile(r'intake_[a-f0-9]{32}\Z')
_JOB = re.compile(r'[A-Za-z0-9_-]{1,160}\Z')
_SIGNAL = re.compile(r's_[a-f0-9]{32}\Z')
_COMMIT = re.compile(r'[a-f0-9]{40}\Z')
_HASH = re.compile(r'[a-f0-9]{64}\Z')


@dataclass(frozen=True)
class WaveformBinding:
    """Trusted backend construction, never an HTTP request field.

    The resolver must prove the original job belongs to this intake and select
    that job's own child Runner/WaveformService, not the latest prepared child.
    ``archive_sha256`` optionally pins a previously retained collection digest.
    The adapter additionally binds each read to the current original receipt.
    """
    intake_id: str
    job_id: str
    run_id: str
    source_commit: str
    service: WaveformService
    archive_sha256: str = None
    original_source_sha256: str = None
    compiled_source_sha256: str = None
    transformation: str = None
    compiled_source_path: str = None


def _error(code, message, status=400):
    raise WaveformError(code, message, status)


def _encoded(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, UnicodeError):
        _error('invalid_input', 'Waveform data must be bounded finite JSON')


def _number(value, name):
    if type(value) not in (str, int, float) or len(str(value)) > 64:
        _error('invalid_input', name + ' must be a finite number in the selected saved axis unit')
    try:
        parsed = float(value)
    except (ValueError, TypeError, OverflowError):
        _error('invalid_input', name + ' must be a finite number in the selected saved axis unit')
    if not math.isfinite(parsed):
        _error('invalid_input', name + ' must be a finite number in the selected saved axis unit')
    return parsed


def _query(operation, args):
    allowed = {'intake_id', 'job_id', 'dataset_id'}
    if operation == 'window':
        allowed |= {'signal_ids', 'start', 'stop', 'max_points'}
    elif operation not in ('catalog', 'mapping'):
        _error('not_found', 'Unknown onboarding waveform operation', 404)
    if (not isinstance(args, dict) or set(args) - allowed
            or not {'intake_id', 'job_id'} <= set(args)):
        _error('invalid_input', 'Use only the exact intake, original job and supported query fields')
    if len(_encoded(args)) > MAX_QUERY_BYTES:
        _error('query_limit', 'Waveform query exceeds its byte limit', 413)
    if not isinstance(args['intake_id'], str) or not _INTAKE.fullmatch(args['intake_id']):
        _error('invalid_intake', 'Use an exact returned intake ID')
    if not isinstance(args['job_id'], str) or not _JOB.fullmatch(args['job_id']):
        _error('invalid_job', 'Use an exact original job ID')
    query = dict(args)
    if 'dataset_id' in query and (not isinstance(query['dataset_id'], str) or not re.fullmatch(r'ds_[a-f0-9]{32}', query['dataset_id'])):
        _error('invalid_dataset', 'Use an exact dataset ID returned by this original job')
    if operation == 'window':
        ids = args.get('signal_ids')
        if isinstance(ids, str):
            ids = ids.split(',')
        if (not isinstance(ids, list) or not 1 <= len(ids) <= MAX_WINDOW_SIGNALS
                or any(not isinstance(s, str) or not _SIGNAL.fullmatch(s) for s in ids)
                or len(set(ids)) != len(ids)):
            _error('invalid_signal_ids', 'Choose one to eight distinct IDs returned by this job catalog')
        query['signal_ids'] = list(ids)
        points = args.get('max_points', DEFAULT_POINTS)
        if (type(points) not in (int, str) or not re.fullmatch(r'[0-9]{1,5}', str(points))
                or not 4 <= int(points) <= MAX_POINTS):
            _error('data_limit', 'max_points must be an integer from 4 to 10000')
        query['max_points'] = int(points)
        for key in ('start', 'stop'):
            if key in args:
                query[key] = _number(args[key], key)
        if 'start' in query and 'stop' in query and query['start'] >= query['stop']:
            _error('invalid_window', 'start must be less than stop')
    return query


class OnboardingWaveforms:
    """Pure coordination of finite local reads through an installed service."""
    def __init__(self, resolve_binding):
        if not callable(resolve_binding):
            raise TypeError('A trusted intake/job binding resolver is required')
        self.resolve_binding = resolve_binding

    def _bound(self, query):
        binding = self.resolve_binding(query['intake_id'], query['job_id'])
        if (not isinstance(binding, WaveformBinding)
                or binding.intake_id != query['intake_id']
                or binding.job_id != query['job_id'] or binding.run_id != binding.job_id
                or not isinstance(binding.source_commit, str) or not _COMMIT.fullmatch(binding.source_commit)
                or not isinstance(binding.service, WaveformService)):
            _error('identity_mismatch', 'Waveform job is not bound to the requested original intake', 409)
        if (binding.archive_sha256 is not None and
                (not isinstance(binding.archive_sha256, str) or not _HASH.fullmatch(binding.archive_sha256))):
            _error('identity_mismatch', 'Invalid retained archive identity', 409)
        if (any(not isinstance(value, str) or not _HASH.fullmatch(value) for value in
                (binding.original_source_sha256, binding.compiled_source_sha256))
                or binding.transformation not in ('none', 'added_explicit_subcircuit_wrapper')
                or binding.transformation == 'none' and binding.original_source_sha256 != binding.compiled_source_sha256):
            _error('identity_mismatch', 'Original and compiled intake source identities are not fully bound', 409)
        if (binding.compiled_source_path is not None and
                (not isinstance(binding.compiled_source_path, str) or not 1 <= len(binding.compiled_source_path) <= 4096)):
            _error('identity_mismatch', 'Invalid compiled source identity label', 409)
        record = binding.service.runner.read(binding.run_id)
        if (not isinstance(record, dict) or record.get('run_id') != binding.run_id
                or record.get('job_id', binding.run_id) != binding.job_id
                or record.get('source_commit') != binding.source_commit):
            _error('identity_mismatch', 'Original run receipt and intake source disagree', 409)
        collection = record.get('collection') or {}
        if not isinstance(collection, dict):
            _error('identity_mismatch', 'Invalid original collection receipt', 409)
        archive = collection.get('sha256')
        if archive is not None and (not isinstance(archive, str) or not _HASH.fullmatch(archive)):
            _error('identity_mismatch', 'Original collection has no valid archive digest', 409)
        if binding.archive_sha256 is not None and archive != binding.archive_sha256:
            _error('identity_mismatch', 'Original job archive changed from the retained intake binding', 409)
        return binding, archive

    @staticmethod
    def _identity(value, binding, archive, baseline=None):
        if (not isinstance(value, dict) or value.get('run_id') != binding.run_id
                or value.get('source_commit') != binding.source_commit):
            _error('identity_mismatch', 'Waveform output differs from the original bound run', 409)
        if not isinstance(archive, str) or not _HASH.fullmatch(archive) or value.get('archive_sha256') != archive:
            _error('identity_mismatch', 'Waveform output differs from the original collection', 409)
        sources = value.get('source_hashes')
        if (not isinstance(sources, dict)
                or binding.compiled_source_path is not None and sources.get(binding.compiled_source_path) != binding.compiled_source_sha256
                or binding.compiled_source_path is None and binding.compiled_source_sha256 not in sources.values()):
            _error('identity_mismatch', 'Compiled intake source is not present in the original waveform provenance', 409)
        if baseline is not None:
            for key in ('effective_config_sha256', 'raw_signature', 'source_hashes', 'staged_sources'):
                if value.get(key) != baseline.get(key):
                    _error('identity_mismatch', 'Waveform source/configuration changed during this read', 409)

    def read(self, operation, args):
        query = _query(operation, args)
        binding, archive = self._bound(query)
        service, rid = binding.service, binding.run_id
        selected = {'dataset_id': query['dataset_id']} if 'dataset_id' in query else {}
        result = {'schema': SCHEMA, 'operation': operation,
                  'intake_id': binding.intake_id, 'job_id': binding.job_id,
                  'run_id': rid, 'source_commit': binding.source_commit,
                  'original_source_sha256': binding.original_source_sha256,
                  'compiled_source_sha256': binding.compiled_source_sha256,
                  'compiled_source_path': binding.compiled_source_path,
                  'transformation': binding.transformation,
                  'archive_sha256': archive, 'read_only': True,
                  'probe': {'enabled': False, 'reason': 'mapping_not_checked',
                            'current_geometry_context_verified': False},
                  'limits': {'max_response_bytes': MAX_RESPONSE_BYTES,
                             'max_query_bytes': MAX_QUERY_BYTES,
                             'max_window_signals': MAX_WINDOW_SIGNALS,
                             'max_points_per_signal': MAX_POINTS}}
        try:
            if selected:
                result.update(selected)
            if operation == 'catalog':
                value = service.catalog(rid, **selected)
                self._identity(value, binding, archive)
                if selected and value.get('dataset_id') != query['dataset_id']:
                    _error('identity_mismatch', 'Returned catalog belongs to another dataset', 409)
                result['catalog'] = value
            elif operation == 'mapping':
                value = service.mapping(rid, **selected)
                if not isinstance(value, dict) or value.get('status') not in ('unmapped', 'verified_binding'):
                    _error('mapping_invalid', 'Unknown saved waveform mapping state', 422)
                # Unmapped replies include catalog identity. Installed manifests
                # bind run/source/config/raw but need not duplicate archive keys.
                if value.get('status') == 'verified_binding':
                    catalog = service.catalog(rid, **selected)
                    self._identity(catalog, binding, archive)
                    for key in ('run_id', 'source_commit', 'effective_config_sha256', 'raw_signature'):
                        if value.get(key) != catalog.get(key):
                            _error('identity_mismatch', 'Mapping differs from the original run catalog', 409)
                    result['probe']['reason'] = 'current_geometry_context_unverified'
                else:
                    self._identity(value, binding, archive)
                    result['probe']['reason'] = 'no_source_geometry_binding'
                result['mapping'] = value
            else:
                catalog = service.catalog(rid, **selected)
                self._identity(catalog, binding, archive)
                lookup = {row['id']: row for row in catalog['signals']}
                for sid in query['signal_ids']:
                    if sid not in lookup:
                        _error('signal_absent', 'Signal ID is absent from this original job catalog', 404)
                    if lookup[sid].get('status') != 'available':
                        code = 'saved_needs_extraction' if lookup[sid].get('status') == 'saved_needs_extraction' else 'waveform_unavailable'
                        _error(code, 'Selected signal has no existing readable waveform', 409)
                result['series'] = []
                for sid in query['signal_ids']:
                    value = service.waveform(rid, sid,
                        start=query.get('start'), end=query.get('stop'), limit=query['max_points'], **selected)
                    self._identity(value, binding, archive, catalog)
                    if selected and any(value.get(key) != catalog.get(key) for key in ('dataset_id','data_sha256','data_format','analysis_id','analysis_kind','native_member_sha256')):
                        _error('identity_mismatch', 'Selected dataset changed during this read', 409)
                    if value.get('signal', {}).get('id') != sid:
                        _error('identity_mismatch', 'Waveform signal identity changed during this read', 409)
                    result['series'].append(value)
            # Check the exact public HTTP success envelope, not just its data.
            if len(_encoded({'ok': True, 'data': result})) > MAX_RESPONSE_BYTES:
                _error('response_limit', 'Waveform response exceeds 2 MiB; request fewer signals or points', 413)
            return result
        except WaveformError:
            raise
        except (OSError, ValueError, TypeError, KeyError, AttributeError, UnicodeError):
            _error('waveform_artifact_unavailable', 'The original saved waveform artifact is unavailable or invalid', 422)

    def describe(self, intake_id, job_id):
        """A read-only availability descriptor for the inspect response.

        Completed execution never supplies availability. This reads and verifies
        the existing export through the actual WaveformService. Missing exports
        return available=false; identity/hash conflicts remain explicit errors.
        """
        args = _query('catalog', {'intake_id': intake_id, 'job_id': job_id})
        binding, archive = self._bound(args)
        result = {'schema': 'ic.onboarding.waveform-descriptor.v1',
                  'intake_id': intake_id, 'job_id': job_id, 'run_id': binding.run_id,
                  'source_commit': binding.source_commit, 'archive_sha256': archive,
                  'original_source_sha256': binding.original_source_sha256,
                  'compiled_source_sha256': binding.compiled_source_sha256,
                  'compiled_source_path': binding.compiled_source_path,
                  'transformation': binding.transformation,
                  'available': False, 'source_binding_verified': False,
                  'available_signal_ids': [], 'read_only': True,
                  'probe': {'enabled': False, 'reason': 'current_geometry_context_unverified',
                            'current_geometry_context_verified': False}}
        try:
            data = self.read('catalog', args)
        except WaveformError as error:
            if error.code != 'not_extracted':
                raise
            result['unavailable_reason'] = 'not_extracted'
            return result
        catalog = data['catalog']
        result.update({key: catalog[key] for key in ('source_hashes', 'raw_signature',
                       'effective_config_sha256', 'archive_sha256')})
        if 'csv_sha256' in catalog:
            result['csv_sha256'] = catalog['csv_sha256']
        if 'datasets' in catalog:
            result['datasets'] = catalog['datasets']
        result['available_signal_ids'] = [s['id'] for s in catalog['signals'] if s.get('status') == 'available']
        result['available'] = bool(result['available_signal_ids'] or any(row.get('available_signal_ids') or row.get('available_device_ids') for row in result.get('datasets', [])))
        result['source_binding_verified'] = True
        if not result['available']:
            result['unavailable_reason'] = 'no_readable_exported_signals'
        if len(_encoded({'ok': True, 'data': result})) > MAX_RESPONSE_BYTES:
            _error('response_limit', 'Waveform descriptor exceeds the response limit', 413)
        return result


def dispatch(service, operation, query):
    """Accept ``parse_qs(..., keep_blank_values=True)`` without duplicate fields."""
    if (not isinstance(query, dict) or len(query) > 7
            or any(not isinstance(values, list) or len(values) != 1
                   or not isinstance(values[0], str) or values[0] == '' for values in query.values())):
        _error('invalid_input', 'Unknown, duplicate or blank waveform query parameter')
    return service.read(operation, {key: values[0] for key, values in query.items()})
