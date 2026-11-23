"""Local PDK cache adapter selected by the gateway, never by a request path.

The cache contains previous remote observations. A hit can prepare a new
source-bound discovery receipt, but cannot attest current remote file contents
or skip the execution workflow's fresh dependency audit.
"""
import copy
from pathlib import Path, PurePosixPath
import re


SCHEMA = 'ic.onboarding.pdk-lut.v1'
HASH = re.compile(r'[a-f0-9]{64}\Z')


def _cache_path(root):
    root = Path(root).expanduser().absolute()
    if root.is_symlink() or root.exists() and not root.is_dir():
        raise ValueError('The gateway must select a regular private cache directory')
    return root / 'pdk-lut.sqlite3'


def _scope(capture, roots=None):
    private = capture.get('private') if isinstance(capture, dict) else None
    identity = private.get('identity', {}) if isinstance(private, dict) else {}
    gaps = []
    if (type(identity.get('uid')) is not int or not 0 <= identity['uid'] <= 2**32
            or any(not isinstance(identity.get(key), str) or not 1 <= len(identity[key]) <= 256
                   or any(ord(char) < 32 for char in identity[key])
                   for key in ('hostname', 'username'))):
        gaps.append({'field':'environment.identity','code':'cache_identity_unavailable',
                     'message':'An observed server account identity is required for cache matching.'})
    if roots is None:
        roots = [row.get('path') for row in (private or {}).get('pdk_candidates', [])
                 if isinstance(row, dict) and row.get('exists') is True]
    if (not isinstance(roots, list) or not 1 <= len(roots) <= 32
            or any(not isinstance(path, str) or not 1 <= len(path) <= 4096
                   or not path.startswith('/') or '..' in PurePosixPath(path).parts
                   or any(ord(char) < 32 for char in path) for path in roots)):
        gaps.append({'field':'roots','code':'cache_roots_unavailable',
                     'message':'Use PDK roots from the selected probe or an explicit search selection.'})
    if gaps:
        return None, None, gaps
    observed = {key:identity[key] for key in ('hostname','username','uid')}
    for key in ('host_key_sha256','machine_id_sha256'):
        if key in identity:
            if not isinstance(identity[key], str) or not HASH.fullmatch(identity[key]):
                raise ValueError('Invalid optional observed server identity digest')
            observed[key] = identity[key]
    return observed, sorted(set(str(PurePosixPath(path)) for path in roots)), []


def _public(status, record=None, missing=()):
    record = record or {}
    result = {'schema':SCHEMA,'status':status,'cache_id':record.get('cache_id'),
              'library_id':record.get('library_id'),
              'content_fingerprint':record.get('content_fingerprint'),
              'original_discovery_id':record.get('original_discovery_id'),
              'original_source_sha256':record.get('original_source_sha256'),
              'observed_at':record.get('observed_at'),
              'staleness':copy.deepcopy(record.get('staleness')),
              'missing':copy.deepcopy(list(missing)),
              'scan_required':status in ('miss','stale','refresh_required'),
              'fresh_dependency_audit_required':True,'remote_freshness_verified':False,
              'ready_to_run':False,'network_operations':0}
    coverage = record.get('coverage') or {}
    result['coverage'] = {key:copy.deepcopy(coverage[key]) for key in (
        'kind','required_masters','covered_model_names','whole_pdk_inventory',
        'search_complete','results_omitted','unknown_count','candidate_count',
        'complete_within_policy','whole_pdk_qualified','file_count','model_count') if key in coverage}
    if 'indexed_model_names' in coverage:
        result['coverage']['indexed_model_count']=len(coverage['indexed_model_names'])
    return result


def store_library(cache_root,capture,library,*,observed_at=None):
    """Store an explicit full-library observation, preserving filtered history."""
    identity,roots,gaps=_scope(capture,library.get('roots') if isinstance(library,dict) else None)
    if gaps:return _public('not_stored',missing=gaps)
    from spiceowl.onboarding.pdk_lut import PdkLut
    with PdkLut(_cache_path(cache_root)) as cache:
        record=cache.put_library(library,server_identity=identity,observed_at=observed_at)
    return _public('stored',record)


def _library_result(result,requirements):
    public=_public(result['status'],result.get('record'),result.get('missing',[]))
    public['scan_required']=result['scan_required']
    discovery=result.get('discovery')
    if discovery:
        public.update(rebound_source_sha256=requirements['source_sha256'],
                      rebound_discovery_id=discovery['discovery_id'],binding_mode='per_device_library_query')
    combination=result.get('combination')
    if combination:
        public['combination']={'requires_explicit_selection':True,'combination_verified':False,
            'entry_count':len(combination['entries']),'covered_model_names':combination['covered_model_names'],
            'missing':[{key:value for key,value in row.items() if key in ('code','model_names','candidate_id','message')}
                       for row in combination['missing']],'ready_to_run':False}
    if result.get('entry_choices'):
        public['entry_choices']=[{'library_candidate_id':row['library_candidate_id'],
            'label':PurePosixPath(row['entry_path']).name,'section_candidates':row['section_candidates'],
            'covered_model_count':row['covered_model_count']} for row in result['entry_choices']]
    return {'public':public,'discovery':discovery}


def store_discovery(cache_root, capture, discovery, *, observed_at=None):
    """Store one complete scan in server-owned local storage; no remote IO.

    ``cache_root`` and ``capture`` are trusted gateway constructions, never
    fields accepted directly from an MCP or HTTP request.
    """
    identity, roots, gaps = _scope(capture, discovery.get('roots') if isinstance(discovery, dict) else None)
    if gaps:
        return _public('not_stored', missing=gaps)
    from spiceowl.onboarding.pdk_lut import PdkLut
    with PdkLut(_cache_path(cache_root)) as cache:
        record = cache.put(discovery, server_identity=identity, observed_at=observed_at)
    return _public('stored', record)


def lookup_discovery(cache_root, capture, requirements, *, roots=None,
                     max_age_s=86400, refresh=False, now=None, content_fingerprint=None,
                     library_id=None,library_candidate_id=None):
    """Return public cache status and a private, explicitly rebound discovery.

    A miss/expiry never starts a scan here. The runtime can choose its existing
    bounded discovery operation. A hit retains the original observation's age,
    coverage and receipt identity in the rebound receipt's cache provenance.
    """
    if (not isinstance(requirements, dict) or not isinstance(requirements.get('source_sha256'), str)
            or not HASH.fullmatch(requirements['source_sha256'])
            or not isinstance(requirements.get('required_masters'), list)):
        raise ValueError('Use requirements bound to the exact current source')
    if not requirements['required_masters']:
        return {'public':_public('not_required'),'discovery':None}
    identity, selected_roots, gaps = _scope(capture, roots)
    if gaps:
        return {'public':_public('miss', missing=gaps),'discovery':None}
    cache_path = _cache_path(cache_root)
    if refresh:
        return {'public':_public('refresh_required'),'discovery':None}
    if not cache_path.exists():
        return {'public':_public('miss'),'discovery':None}
    from spiceowl.onboarding.pdk_lut import PdkLut, rebind_discovery
    with PdkLut(cache_path, read_only=True) as cache:
        library=cache.lookup_library_models(server_identity=identity,roots=selected_roots,
            required_masters=requirements['required_masters'],requirements=requirements,
            remote_platform=capture['private'].get('platform'),max_age_s=max_age_s,now=now,
            content_fingerprint=content_fingerprint,library_id=library_id,library_candidate_id=library_candidate_id)
        if library_id is not None or library_candidate_id is not None:
            library['scan_required']=False  # A pinned query can never substitute a new observation.
            return _library_result(library,requirements)
        # A known inventory's gaps/age cannot be hidden by older filtered data.
        if library.get('record') is not None:return _library_result(library,requirements)
        result = cache.lookup(server_identity=identity, roots=selected_roots,
            required_masters=requirements['required_masters'], max_age_s=max_age_s,
            refresh=refresh, now=now, content_fingerprint=content_fingerprint)
    public = _public(result['status'], result.get('record'))
    if result['status'] != 'hit':
        return {'public':public,'discovery':None}
    rebound = rebind_discovery(result['record'], requirements)
    public['rebound_source_sha256'] = requirements['source_sha256']
    public['rebound_discovery_id'] = rebound['discovery_id']
    return {'public':public,'discovery':rebound}


def lookup_model_bindings(cache_root, capture, requirements, *, roots=None,
                          max_age_s=86400, refresh=False, now=None, limit=8):
    """Fast ranked model index, explicitly retaining original cached identities.

    ``recommendation`` is private backend data and can contain remote paths.
    Only ``public`` is a public status projection. Preparing a new netlist must
    use ``lookup_discovery`` to obtain the new source-bound candidate IDs.
    """
    if not isinstance(requirements,dict) or not isinstance(requirements.get('required_masters'),list):
        raise ValueError('Use the current source model requirements')
    if not requirements['required_masters']:
        return {'public':_public('not_required'),'recommendation':None}
    identity, selected_roots, gaps = _scope(capture,roots)
    path = _cache_path(cache_root)
    if gaps or refresh or not path.exists():
        return {'public':_public('refresh_required' if refresh else 'miss',missing=gaps),'recommendation':None}
    private=capture['private']
    from spiceowl.onboarding.pdk_lut import PdkLut
    with PdkLut(path,read_only=True) as cache:
        library=cache.lookup_library_models(server_identity=identity,roots=selected_roots,
            required_masters=requirements['required_masters'],max_age_s=max_age_s,now=now,
            remote_platform=private.get('platform'))
        if library.get('record') is not None:
            public=_library_result(library,requirements)['public']
            recommendation=library.get('recommendation')
            if recommendation:
                public['binding']={key:copy.deepcopy(recommendation.get(key)) for key in
                    ('recommended_candidate_id','selection_confidence','status','complete_binding_available','missing')}
                public['binding'].update(source_identity='cached_library_observation',requires_source_rebinding=True)
            return {'public':public,'recommendation':recommendation}
        result=cache.query_best_bindings(server_identity=identity,roots=selected_roots,
            required_masters=requirements['required_masters'],max_age_s=max_age_s,now=now,
            limit=limit,remote_platform=private.get('platform'))
    public=_public(result['status'],result.get('record'))
    recommendation=result.get('recommendation')
    if isinstance(recommendation,dict):
        public['binding']={key:copy.deepcopy(recommendation.get(key)) for key in
            ('recommended_candidate_id','selection_confidence','status','complete_binding_available','missing')}
        public['binding']['source_identity']='original_cached_observation'
        public['binding']['requires_source_rebinding']=True
    return {'public':public,'recommendation':recommendation}
