"""Read-only waveform consumer. No subprocess, SSH, simulation, collect or publication.

Runner.read/path are used only for registered persisted runs. Bindings are installed
by the integrator, never supplied by an HTTP caller. Python 3.9+, standard library.
"""
import bisect
import csv
import hashlib
import io
import json
import math
import re
from pathlib import Path

VERSION = 'ic.waveforms.v1'
MAX_ROWS = 200000
MAX_BYTES = 64 * 1024 * 1024
MAX_SIGNALS = 32
MAX_DISPLAY = 10000


class WaveformError(ValueError):
    def __init__(self, code, message, status=400):
        self.code, self.status = code, status
        super().__init__(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def object_hash(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())


def signal_id(run_id, analysis, name):
    return 's_' + object_hash([run_id, analysis, name])[:32]


def derived_cache_key(p):
    return object_hash({k:p.get(k) for k in ('run_id','source_commit','raw_signature','analysis','psf_name','window_s','extractor_version','extractor_sha256','data_basis')})


def bounded_file(path, limit=MAX_BYTES):
    path = Path(path)
    if path.is_symlink() or any(p.is_symlink() for p in path.parents):
        raise WaveformError('invalid_artifact', 'Symlink waveform artifact rejected', 422)
    if not path.is_file():
        raise WaveformError('not_extracted', 'Registered artifact is not available', 404)
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise WaveformError('data_limit', 'Artifact exceeds installed byte limit', 413)
    return data


def interpolate(xs, ys, x):
    if x < xs[0] or x > xs[-1]:
        return None
    i = bisect.bisect_left(xs, x)
    if i < len(xs) and xs[i] == x:
        return {'x': x, 'y': ys[i], 'method': 'exported_csv_sample'}
    y = ys[i-1] + (ys[i]-ys[i-1]) * ((x-xs[i-1])/(xs[i]-xs[i-1]))
    return {'x': x, 'y': y, 'method': 'linear_interpolation_of_exported_csv'}


def envelope(points, limit):
    """Each contiguous bucket retains its minimum and maximum; output is ordered."""
    if len(points) <= limit:
        return points
    buckets = (limit - 2) // 2
    selected = {0, len(points)-1}
    for b in range(buckets):
        lo = 1 + (len(points)-2)*b//buckets
        hi = 1 + (len(points)-2)*(b+1)//buckets
        if lo < hi:
            selected.add(min(range(lo, hi), key=lambda i: points[i][1]))
            selected.add(max(range(lo, hi), key=lambda i: points[i][1]))
    return [points[i] for i in sorted(selected)]


def finite(value, name):
    if isinstance(value, bool):
        raise WaveformError('invalid_input', name + ' must be finite')
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise WaveformError('invalid_input', name + ' must be finite')
    if not math.isfinite(value):
        raise WaveformError('invalid_input', name + ' must be finite')
    return value


class WaveformService:
    def __init__(self, runner, bindings=None, derivatives=None, source_reader=None):
        self.runner = runner
        self.source_reader = source_reader
        self.bindings = dict(bindings or {})
        self.derivatives = dict(derivatives or {})

    def _record(self, rid):
        if not isinstance(rid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', rid):
            raise WaveformError('invalid_run', 'Invalid run ID')
        record = self.runner.read(rid)  # intentionally NOT runner.status
        if record.get('run_id') != rid:
            raise WaveformError('identity_mismatch', 'Run receipt identity mismatch', 409)
        return record

    def _load(self, rid):
        record = self._record(rid)
        root = self.runner.path(rid)
        metadata_bytes=bounded_file(root/'waveforms.json', 16*1024*1024)
        meta = json.loads(metadata_bytes)
        if meta.get('run_id') != rid or meta.get('source_commit') != record.get('source_commit'):
            raise WaveformError('identity_mismatch', 'CSV metadata and run source disagree', 409)
        raw = bounded_file(root/'waveforms.csv')
        csv_hash = digest(raw)
        if csv_hash != meta.get('csv_sha256'):
            raise WaveformError('hash_mismatch', 'CSV SHA256 does not match export receipt', 409)
        waves = meta.get('waveforms', [])
        if not 1 <= len(waves) <= MAX_SIGNALS:
            raise WaveformError('data_limit', 'Expected 1..32 explicitly exported signals', 413)
        if len({w['name'] for w in waves}) != len(waves):
            raise WaveformError('ambiguous_signal', 'Duplicate exported name', 422)
        for wave in waves:
            if wave.get('time_unit', wave.get('x_unit')) != 's' or wave.get('unit') not in ('V', 'A'):
                raise WaveformError('analysis_unsupported', 'Only real transient V/A exports are supported', 422)
            if wave.get('analysis', 'tran') != 'tran' or wave.get('family'):
                raise WaveformError('analysis_unsupported', 'AC, complex and family waveforms need a separate reader', 422)
        reader = csv.reader(io.StringIO(raw.decode('utf-8-sig')))
        header = next(reader, [])
        # Explicitly support the observed awvSaveToCSV merged-X format only.
        def expected_header(name, suffix, text):
            return bool(re.fullmatch(re.escape(name)+r'(?: \(interpolated wth step=[^()]+\))? '+suffix, text))
        if len(header) != len(waves)+1 or not expected_header(waves[0]['name'], 'X', header[0]):
            raise WaveformError('csv_schema', 'Unsupported CSV axis/header format', 422)
        if any(not expected_header(w['name'], 'Y', header[i+1]) for i, w in enumerate(waves)):
            raise WaveformError('csv_schema', 'CSV columns do not match the export signal order', 422)
        rows = []
        for row in reader:
            if not row:
                continue
            if len(rows) >= MAX_ROWS:
                raise WaveformError('data_limit', 'CSV exceeds 200000 rows', 413)
            if len(row) != len(header):
                raise WaveformError('csv_schema', 'Ragged CSV row', 422)
            values = [finite(v, 'sample') for v in row]
            if rows and values[0] <= rows[-1][0]:
                raise WaveformError('analysis_unsupported', 'Nonmonotonic/family axis is unsupported', 422)
            rows.append(values)
        if not rows or len(rows) != meta.get('csv_samples'):
            raise WaveformError('csv_schema', 'CSV row count disagrees with export receipt', 422)
        inventory_bytes = bounded_file(root/'archive-files.json', 8*1024*1024)
        index = json.loads(inventory_bytes)
        if meta.get('producer') == 'spiceowl.psf-ascii':
            # Local PSF derivations retain the native archive; never invent a
            # remote archive member for the locally generated display CSV.
            expected = {'producer':'spiceowl.psf-ascii','run_id':rid,'source_commit':record.get('source_commit'),
                        'native_archive_sha256':(record.get('collection') or {}).get('sha256'),'csv_sha256':csv_hash,
                        'metadata_sha256':digest(metadata_bytes),'inventory_sha256':digest(inventory_bytes)}
            if (record.get('local_derivation') != expected or meta.get('native_archive_sha256') != expected['native_archive_sha256']
                    or not isinstance(expected['native_archive_sha256'],str) or not re.fullmatch('[a-f0-9]{64}',expected['native_archive_sha256'])):
                raise WaveformError('hash_mismatch','Local waveform derivation is not bound to this native archive',409)
        elif not any(i.get('path', '').endswith('/waveforms.csv') and i.get('sha256') == csv_hash for i in index):
            raise WaveformError('hash_mismatch', 'CSV absent from immutable archive inventory', 409)
        raw_members = sorted(({'path':i['path'],'sha256':i['sha256'],'bytes':i['bytes']} for i in index if i['path'].startswith('./psf/')), key=lambda i:i['path'])
        plan = record.get('plan', {})
        provenance = plan.get('provenance', {})
        identity = {
            'run_id': rid, 'source_commit': record.get('source_commit'),
            'source_hashes': provenance.get('materialization', {}).get('source_sha256', {}),
            'staged_sources': [{k:f.get(k) for k in ('destination','source_sha256','staged_sha256')} for f in provenance.get('files', [])],
            'effective_config_sha256': object_hash({'configuration':plan.get('configuration'), 'postprocess':plan.get('postprocess')}),
            'archive_sha256': (record.get('collection') or {}).get('sha256'),
            'raw_signature': object_hash(raw_members), 'raw_signature_basis': 'sorted archive inventory of ./psf/ members',
            'csv_sha256': csv_hash,
        }
        basis = 'local_PSF_ASCII_derivation' if meta.get('producer')=='spiceowl.psf-ascii' else ('OCEAN_resampled_CSV' if 'interpolated wth step=' in header[0] else 'OCEAN_exported_CSV')
        signals = [{'id':signal_id(rid, 'tran', w['name']), 'psf_name':w['name'], 'label':w['name'],
                    'analysis':'tran', 'quantity':'voltage' if w['unit']=='V' else 'current',
                    'unit':w['unit'], 'polarity':None, 'status':'available', 'sample_count':len(rows),
                    'domain':[rows[0][0],rows[-1][0]], 'x_unit':'s', 'data_basis':basis,
                    'name_evidence':('exact name in same-run native PSF ASCII and hash-bound local CSV' if meta.get('producer')=='spiceowl.psf-ascii' else 'exact name in same-run OCEAN export receipt and matching CSV header')} for w in waves]
        return record, identity, signals, rows, basis

    def _derived(self, rid, identity):
        """Consume separately installed, hash-bound native CSV. Never extract on GET."""
        directories = self.derivatives.get(rid, [])
        if not isinstance(directories, list) or len(directories)>4:
            raise WaveformError('data_limit','At most four installed derived artifacts',413)
        found=[]
        for directory in directories:
            root=Path(directory)
            p=json.loads(bounded_file(root/'provenance.json',2*1024*1024))
            if p.get('schema')!='ic.waveform-derived.v1':
                raise WaveformError('derived_invalid','Unknown derived schema',422)
            for key in ('run_id','source_commit','archive_sha256','raw_signature','effective_config_sha256'):
                if not p.get(key) or p[key]!=identity.get(key):
                    raise WaveformError('identity_mismatch','Derived artifact mismatch: '+key,409)
            if p.get('analysis')!='tran' or p.get('unit') not in ('V','A') or p.get('x_unit')!='s' or p.get('data_basis')!='PSFXL_native_samples':
                raise WaveformError('analysis_unsupported','Derived artifact must be native scalar transient',422)
            if not re.fullmatch(r'[0-9a-f]{64}',p.get('extractor_sha256','')) or p.get('raw_before_after_verified') is not True:
                raise WaveformError('derived_invalid','Extractor/raw verification receipt required',422)
            if p.get('cache_key')!=derived_cache_key(p):
                raise WaveformError('derived_invalid','Derived cache identity does not match raw/signal/window/extractor',422)
            raw=bounded_file(root/'current.csv')
            if digest(raw)!=p.get('csv_sha256') or digest(bounded_file(root/'catalog.sexp',2*1024*1024))!=p.get('catalog_sha256'):
                raise WaveformError('hash_mismatch','Derived CSV/catalog changed',409)
            name=p['psf_name'];names=p.get('catalog_names',[])
            if not isinstance(names,list) or len(names)>4096 or name not in names or len(set(names))!=len(names):
                raise WaveformError('derived_invalid','Invalid saved signal catalog',422)
            reader=csv.reader(io.StringIO(raw.decode('utf-8')))
            if next(reader,[])!=[name+' X',name+' Y']:
                raise WaveformError('csv_schema','Derived header does not match exact PSF identity',422)
            rows=[]
            for row in reader:
                if len(rows)>=MAX_ROWS or len(row)!=2:
                    raise WaveformError('data_limit','Derived sample limit/schema invalid',413)
                xy=[finite(v,'sample') for v in row]
                if rows and xy[0]<=rows[-1][0]:
                    raise WaveformError('analysis_unsupported','Derived axis must strictly increase',422)
                rows.append(xy)
            if not rows or len(rows)!=p.get('sample_count') or [rows[0][0],rows[-1][0]]!=p.get('window_s'):
                raise WaveformError('csv_schema','Derived sample count/window receipt mismatch',422)
            signal={'id':signal_id(rid,'tran',name),'psf_name':name,'label':name,'analysis':'tran',
                    'quantity':'current' if p['unit']=='A' else 'voltage','unit':p['unit'],'x_unit':'s',
                    'polarity':p.get('polarity'),'status':'available','sample_count':len(rows),
                    'domain':p['window_s'],'data_basis':p['data_basis'],'csv_sha256':p['csv_sha256'],
                    'name_evidence':'same-run outputs catalog and independent native-vector OCEAN export'}
            found.append((signal,rows,p))
        return found

    def catalog(self, rid):
        _, identity, signals, _, basis = self._load(rid)
        derived=self._derived(rid,identity)
        complete=False
        catalogs=[]
        for signal,_,p in derived:
            if any(s['id']==signal['id'] for s in signals):
                raise WaveformError('ambiguous_signal','Duplicate base/derived signal ID',422)
            signals.append(signal)
            complete=complete or p.get('raw_catalog_complete') is True
            catalogs.append(p)
        if complete:
            known={s['psf_name'] for s in signals}
            for p in catalogs:
                for name in p['catalog_names']:
                    if name in known:continue
                    known.add(name)
                    signals.append({'id':signal_id(rid,'tran',name),'psf_name':name,'label':name,'analysis':'tran',
                                    'quantity':None,'unit':None,'status':'saved_needs_extraction',
                                    'type_status':'not_yet_read','catalog_evidence_sha256':p['catalog_sha256']})
        return {'schema':VERSION, **identity, 'analyses':[{'id':'tran','kind':'transient','x_unit':'s','family':False}],
                'signals':signals, 'coverage':'saved_catalog_with_exported_subset' if complete else 'exported_subset', 'raw_catalog_complete':complete,
                'unexported_status':'saved_needs_extraction' if complete else 'saved_state_unknown', 'data_basis':basis,
                'limits':{'max_display_points':MAX_DISPLAY,'max_csv_rows':MAX_ROWS,'max_signals':MAX_SIGNALS},
                'unsupported':['ac','complex','dc_sweep','corner_family','monte_carlo_family'],
                'extraction':{'enabled':False,'state':'requires_coordinator_slot'}}

    def mapping(self, rid):
        identity=self.catalog(rid);signals=identity['signals']
        configured = self.bindings.get(rid)
        if not configured:
            return {'schema':'ic.waveform-map.v1', **identity, 'status':'unmapped', 'objects':[],
                    'reason':'No installed source/geometry-bound mapping; catalog remains independently viewable'}
        manifest = json.loads(bounded_file(Path(configured), 4*1024*1024))
        validate_mapping(manifest, identity, signals)
        result = {**manifest, 'status':'verified_binding', 'manifest_sha256':object_hash(manifest)}
        if 'display_source' in manifest:
            def reject(message):
                raise WaveformError('mapping_invalid', 'Display source proof: '+message, 422)
            def commit(value):
                if not isinstance(value,str) or not re.fullmatch(r'[0-9a-f]{40}',value):
                    reject('full Git commit required')
                return value
            def checksum(value):
                if not isinstance(value,str) or not re.fullmatch(r'[0-9a-f]{64}',value):
                    reject('SHA256 required')
                return value
            def relative(value):
                if (not isinstance(value,str) or not value or value.startswith(('/', '-')) or
                        any(ord(c)<32 for c in value) or '\\' in value or ':' in value or
                        any(p in ('', '.', '..', '.git') for p in value.split('/'))):
                    reject('safe repository-relative path required')
                return value
            def read(ref,path,limit):
                data=self.source_reader(commit(ref),relative(path),limit)
                if not isinstance(data,bytes) or len(data)>limit:
                    reject('invalid or oversized Git blob')
                return data
            display=manifest['display_source']
            if not isinstance(display,dict) or not self.source_reader or display.get('method')!='exact-prefix-comment-append':
                reject('unavailable reconciliation method')
            display=dict(display)
            display.pop('verified',None)  # input verdicts never authorize a display hash
            path=relative(manifest['source'].get('canonical_path',manifest['source']['path']))
            if display.get('path')!=path:
                reject('display path differs from registered run source path')
            reference=display.get('proof')
            if not isinstance(reference,dict) or set(reference)!={'commit','path','sha256'}:
                reject('installed proof commit/path/SHA256 reference required')
            expected_proof_hash=checksum(reference['sha256'])
            proof_raw=read(reference['commit'],reference['path'],64*1024)
            if digest(proof_raw)!=expected_proof_hash:
                reject('actual proof bytes do not match registered SHA256')
            try:
                proof=json.loads(proof_raw)
            except (ValueError,UnicodeError):
                reject('proof must be valid JSON')
            if not isinstance(proof,dict) or proof.get('schema')!='ic.exact-comment-suffix-proof.v1' or proof.get('source_path')!=path:
                reject('proof schema/source path mismatch')
            base,view,suffix=(proof.get(k) for k in ('base','view','suffix'))
            if not all(isinstance(x,dict) for x in (base,view,suffix)):
                reject('base/view/suffix descriptors required')
            for descriptor in (base,view):
                commit(descriptor.get('commit'))
                checksum(descriptor.get('sha256'))
                if type(descriptor.get('bytes')) is not int or not 0<descriptor['bytes']<=2*1024*1024:
                    reject('bounded source byte count required')
            if (commit(display.get('base_commit'))!=base['commit'] or commit(display.get('commit'))!=view['commit'] or
                    base['sha256']!=manifest['source']['sha256'] or view['sha256']!=checksum(display.get('sha256'))):
                reject('proof source identities disagree with run or explicit display identities')
            if not isinstance(suffix.get('utf8'),str):
                reject('exact suffix UTF-8 text required')
            try:
                expected_suffix=suffix['utf8'].encode('utf-8')
            except UnicodeError:
                reject('invalid suffix UTF-8')
            if (type(suffix.get('bytes')) is not int or not 0<len(expected_suffix)<=32*1024 or
                    suffix['bytes']!=len(expected_suffix) or digest(expected_suffix)!=checksum(suffix.get('sha256')) or
                    b'\x00' in expected_suffix or not expected_suffix.endswith(b'\n') or
                    any(line.strip(b' \t\r') and not line.lstrip(b' \t\r').startswith(b'//') for line in expected_suffix.split(b'\n'))):
                reject('proof suffix must be exact bounded complete blank/comment lines')
            old=read(base['commit'],path,2*1024*1024)
            new=read(view['commit'],path,2*1024*1024)
            if (len(old)!=base['bytes'] or len(new)!=view['bytes'] or digest(old)!=base['sha256'] or digest(new)!=view['sha256'] or
                    not old.endswith(b'\n') or old.rstrip().endswith(b'\\') or new!=old+expected_suffix):
                reject('actual source bytes or line/continuation boundary do not match exact proof')
            result['display_source']={**display,'verified':True,'run_source_sha256':digest(old),
                'view_source_sha256':digest(new),'run_source_bytes':len(old),'view_source_bytes':len(new),
                'suffix_bytes':len(expected_suffix),'suffix_sha256':digest(expected_suffix),'proof_sha256':digest(proof_raw)}
        return result

    def waveform(self, rid, sid, analysis='tran', start=None, end=None, limit=1600, cursor_a=None, cursor_b=None):
        if analysis != 'tran':
            raise WaveformError('analysis_unsupported', 'Only scalar transient is implemented', 422)
        if isinstance(limit, bool) or not re.fullmatch(r'\d+', str(limit)) or not 4 <= int(limit) <= MAX_DISPLAY:
            raise WaveformError('data_limit', 'limit must be 4..10000')
        limit = int(limit)
        _, identity, signals, rows, basis = self._load(rid)
        column = next((i+1 for i,s in enumerate(signals) if s['id']==sid), None)
        selected_derived=None
        derived=self._derived(rid,identity)
        if column is None:
            selected_derived=next((d for d in derived if d[0]['id']==sid),None)
            if selected_derived:
                signal,rows,provenance=selected_derived;column=1;basis=signal['data_basis']
                identity={**identity,'csv_sha256':provenance['csv_sha256'],'derived_extractor_sha256':provenance['extractor_sha256']}
        if column is None:
            if any(signal_id(rid,'tran',name)==sid for _,_,p in derived for name in p['catalog_names']):
                raise WaveformError('saved_needs_extraction','Signal exists in raw catalog; derived data is not yet extracted',409)
            raise WaveformError('signal_absent', 'Signal ID is not in this run catalog; raw saved state is unknown', 404)
        if selected_derived is None:signal = signals[column-1]
        xs, ys = [r[0] for r in rows], [r[column] for r in rows]
        start = xs[0] if start is None else finite(start, 'start')
        end = xs[-1] if end is None else finite(end, 'end')
        if start >= end:
            raise WaveformError('invalid_window', 'start must be less than end')
        lo, hi = max(start,xs[0]), min(end,xs[-1])
        points = []
        if lo <= hi:
            points = [[lo,interpolate(xs,ys,lo)['y']]]
            points += [[xs[i],ys[i]] for i in range(bisect.bisect_right(xs,lo),bisect.bisect_left(xs,hi))]
            if hi > lo:
                points.append([hi,interpolate(xs,ys,hi)['y']])
        display = envelope(points,limit)
        cursors = {key:interpolate(xs,ys,finite(value,key)) for key,value in [('a',cursor_a),('b',cursor_b)] if value is not None}
        if selected_derived:
            for cursor in cursors.values():
                if cursor:cursor['method']='native_psfxl_sample' if cursor['method']=='exported_csv_sample' else 'linear_interpolation_of_native_psfxl_samples'
        delta = None
        if cursors.get('a') and cursors.get('b'):
            delta = {'dt':cursors['b']['x']-cursors['a']['x'],'dy':cursors['b']['y']-cursors['a']['y'],'x_unit':'s','y_unit':signal['unit']}
        return {'schema':VERSION, **identity, 'signal':signal, 'points':display,
                'window':{'requested':[start,end],'returned':[lo,hi] if points else None,'clipped':lo!=start or hi!=end},
                'display':{'method':'min_max_envelope' if len(display)<len(points) else 'all_window_points',
                           'decimated':len(display)<len(points),'input_points':len(points),'returned_points':len(display),'limit':limit},
                'measurement':{'basis':basis,'cursors':cursors,'delta':delta,'uses_display_samples':False,
                               'note':'Native PSFXL samples exported losslessly; off-grid cursors linearly interpolate native samples.' if selected_derived else 'CSV may already be OCEAN-resampled; off-grid cursors interpolate CSV, never the display envelope.'}}


def validate_mapping(m, identity, signals):
    def reject(message):
        raise WaveformError('mapping_invalid', message, 422)
    if m.get('schema') != 'ic.waveform-map.v1':
        reject('Unknown mapping schema')
    for key in ('run_id','source_commit','effective_config_sha256','raw_signature'):
        if m.get(key) != identity.get(key) or not m.get(key):
            reject('Mapping identity mismatch: '+key)
    source = m.get('source', {})
    sha = source.get('sha256')
    known = identity.get('source_hashes', {})
    staged = {x['destination']:x['staged_sha256'] for x in identity.get('staged_sources', [])}
    original = {x['destination']:x.get('source_sha256') for x in identity.get('staged_sources', [])}
    identities = known if source.get('kind')=='canonical' else original if source.get('kind')=='before_staging' else staged
    if source.get('kind') not in ('canonical','before_staging','staged') or not sha or sha != identities.get(source.get('path')):
        reject('Mapping source path/hash not bound to run provenance')
    geo = m.get('geometry', {})
    if not all(isinstance(geo.get(k),str) and geo[k] for k in ('manifest_sha256','entry_id')):
        reject('Missing geometry identity')
    local = geo.get('kind')=='local_export_snapshot' and geo.get('bundle_commit') is None and re.fullmatch(r'[0-9a-f]{64}',geo.get('bundle_sha256',''))
    if (not local and not re.fullmatch(r'[0-9a-f]{40}',geo.get('bundle_commit','') or '')) or not re.fullmatch(r'[0-9a-f]{64}',geo['manifest_sha256']):
        reject('Invalid geometry hashes')
    lookup = {s['id']:s for s in signals}
    seen = set()
    if not isinstance(m.get('objects'),list) or len(m['objects'])>20000:
        reject('Mapping objects exceed bound')
    for obj in m['objects']:
        sel = obj.get('selector', {})
        if sel.get('kind') not in ('net','terminal','branch'):
            reject('Map nets to voltage; explicit terminal/branch to current')
        if not all(isinstance(sel.get(k),str) and sel[k] for k in ('name','scope','viewer_source_path')):
            reject('Exact name, scope and viewer source path required')
        if not isinstance(sel.get('occurrence_path'),list) or len(sel['occurrence_path'])>64 or any(not isinstance(x,str) or not x for x in sel['occurrence_path']):
            reject('Full occurrence path is required')
        if sel['kind'] in ('terminal','branch') and not sel.get('terminal_name'):
            reject('Current requires an explicit terminal and polarity')
        key = object_hash(sel)
        if key in seen:
            reject('Duplicate/ambiguous selector')
        seen.add(key)
        if not isinstance(obj.get('evidence'),str) or not obj['evidence']:
            reject('Mapping evidence required')
        if obj.get('status','available') != 'available':
            if obj.get('status') not in ('saved_state_unknown','saved_needs_extraction','not_saved','extraction_failed','analysis_unsupported'):
                reject('Unknown missing-data state')
            if obj.get('signal_id') is not None:
                reject('Unavailable mapping must not provide a usable signal ID')
            if obj['status'] in ('not_saved','saved_needs_extraction') and not obj.get('catalog_evidence_sha256'):
                reject('Saved/unsaved claim requires catalog evidence')
            continue
        target = lookup.get(obj.get('signal_id'))
        if target is None or obj.get('psf_name') != target['psf_name'] or obj.get('analysis') != target['analysis'] or obj.get('unit') != target['unit']:
            reject('Signal identity/type/unit not in run catalog')
        if (sel['kind']=='net') != (target['quantity']=='voltage'):
            reject('Node voltage/terminal current mismatch')
        if target['quantity']=='current' and obj.get('polarity') not in ('into_terminal','out_of_terminal'):
            reject('Current polarity required')
        if obj.get('scale',1) not in (1,-1):
            reject('Only explicit polarity inversion is supported')
        if target['quantity']=='current' and obj.get('scale',1)!=(1 if obj['polarity']=='into_terminal' else -1):
            reject('Current polarity and numeric scale disagree')
        if target['quantity']=='voltage' and obj.get('scale',1)!=1:
            reject('Voltage mapping must preserve native sign')


def dispatch(service, rid, operation, query):
    """HTTP/CLI shared query validation; values use parse_qs(...,keep_blank_values=True)."""
    allowed = {'signal_id','analysis','start','end','limit','cursor_a','cursor_b'} if operation=='waveform' else set()
    if set(query)-allowed or any(len(v)!=1 or v[0]=='' for v in query.values()):
        raise WaveformError('invalid_input','Unknown, duplicate or blank query parameter')
    q = {k:v[0] for k,v in query.items()}
    if operation=='signals':
        return service.catalog(rid)
    if operation=='waveform-map':
        return service.mapping(rid)
    if operation=='waveform':
        if not q.get('signal_id'):
            raise WaveformError('invalid_input','signal_id is required')
        return service.waveform(rid,q.pop('signal_id'),**q)
    raise WaveformError('not_found','Unknown operation',404)
