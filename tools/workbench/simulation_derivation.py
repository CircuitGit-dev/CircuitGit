"""Explicit local derivation of saved native results; never called by a GET.

SpiceOwl owns parsing and numeric algorithms. This adapter owns immutable
archive/member/dataset binding and compatibility transient CSV publication.
"""
import csv
import hashlib
import importlib
import io
import json
from pathlib import Path
import tarfile

from runner import atomic, filehash


def _saved_datasets(app, record, stream, inventory, inventory_bytes):
    """Persist independent original AC/DC datasets using the installed parser."""
    folder = app.runner.path(record['run_id'])
    candidates = []
    for member in stream.getmembers():
        if not member.isfile() or not member.name.startswith('./psf/'):
            continue
        leaf = member.name.rsplit('/', 1)[-1]
        kind = ('ac' if leaf.endswith('.ac') else 'dc_op' if leaf.endswith(('.info', '.dcop'))
                else 'dc' if leaf.endswith('.dc') else None)
        if kind:
            candidates.append((member, kind, leaf.rsplit('.', 1)[0]))
    if not candidates:
        return []
    if len(candidates) > 32:
        raise ValueError('Native dataset count exceeds the installed bound')
    module = importlib.import_module('spiceowl.integrations.spectre_results')
    parse = getattr(module, 'parse_psf_analysis', None)
    catalog = {'schema': 'ic.waveform-datasets.v1', 'run_id': record['run_id'], 'source_commit': record['source_commit'],
               'native_archive_sha256': record['collection']['sha256'], 'producer': 'spiceowl.psf-ascii', 'datasets': [], 'unsupported': []}
    hashes = {}; total = 0
    if (folder / 'datasets').is_symlink():
        raise ValueError('Dataset output must not be a symlink')
    for member, kind, name in candidates:
        try:
            if member.size > 16 * 1024**2 or record['plan'].get('simulator', {}).get('output_format') != 'psfascii' or not callable(parse):
                raise ValueError('Unsupported native dataset format or parser')
            raw = stream.extractfile(member).read()
            native = {'path': member.name, 'bytes': member.size, 'sha256': hashlib.sha256(raw).hexdigest()}
            if [row for row in inventory if row.get('path') == member.name] != [native]:
                raise ValueError('Native dataset and immutable archive inventory disagree')
            data = parse(raw, analysis_kind=kind, analysis_name=name)
            if (data.get('schema') != 'spiceowl.spectre-dataset.v1' or data.get('raw_sha256') != native['sha256']
                    or data.get('analysis', {}).get('kind') != kind or data['analysis'].get('name') != name):
                raise ValueError('Native parser returned another dataset identity')
            identity = json.dumps([record['run_id'], record['source_commit'], native['path'], native['sha256']], separators=(',', ':')).encode()
            did = 'ds_' + hashlib.sha256(identity).hexdigest()[:32]
            payload = {'schema': 'ic.saved-waveform-dataset.v1', 'run_id': record['run_id'], 'source_commit': record['source_commit'],
                       'dataset_id': did, 'native_member': native, 'native_archive_sha256': record['collection']['sha256'], 'data': data}
            encoded = json.dumps(payload, allow_nan=False).encode()
            if len(encoded) > 64 * 1024**2 or total + len(encoded) > 128 * 1024**2:
                raise ValueError('Derived dataset exceeds bounded full-data storage')
            total += len(encoded)
            path = folder / 'datasets' / (did + '.json')
            if path.is_symlink():
                raise ValueError('Dataset output must not be a symlink')
            atomic(path, payload)
            data_hash = filehash(path); hashes[did] = data_hash
            catalog['datasets'].append({'dataset_id': did, 'analysis': data['analysis'], 'native_member': native,
                'data_path': 'datasets/' + did + '.json', 'data_sha256': data_hash, 'data_format': 'native_psf_json',
                'sample_count': data['sample_count'], 'signal_count': len(data['signals']), 'device_count': len(data['operating_points']),
                'axis': {k: v for k, v in (data.get('axis') or {}).items() if k != 'values'} if data.get('axis') is not None else None})
        except (UnicodeError, ValueError) as error:
            catalog['unsupported'].append({'native_path': member.name, 'analysis_kind': kind,
                                            'reason': getattr(error, 'code', 'native_dataset_unsupported')})
    atomic(folder / 'waveform-datasets.json', catalog)
    record['local_dataset_derivation'] = {'schema': 'ic.waveform-dataset-derivation.v1', 'run_id': record['run_id'],
        'source_commit': record['source_commit'], 'native_archive_sha256': record['collection']['sha256'],
        'catalog_sha256': filehash(folder / 'waveform-datasets.json'), 'inventory_sha256': hashlib.sha256(inventory_bytes).hexdigest(),
        'dataset_sha256': hashes}
    app.runner.save(record)
    return catalog['datasets']

def derive_results(app, rid):
    """Derive display data locally from a verified native archive; no OCEAN."""
    record = app.runner.read(rid)
    collection = record.get('collection') or {}
    archive = Path(collection.get('archive', ''))
    if not archive.is_file() or archive.is_symlink():
        raise ValueError('A collected native archive is required')
    from runner import filehash
    if filehash(archive) != collection.get('sha256'):
        raise ValueError('Native result archive digest changed')
    folder = app.runner.path(rid)
    inventory_path = folder / 'archive-files.json'
    if not inventory_path.is_file() or inventory_path.is_symlink() or inventory_path.stat().st_size > 8*1024**2:
        raise ValueError('A bounded collected archive inventory is required')
    inventory_bytes = inventory_path.read_bytes()
    inventory = json.loads(inventory_bytes)
    with tarfile.open(archive, 'r:gz') as stream:
        # Keep source logs private; only diagnostic redactions leave the API.
        logs = []
        entries = []
        for member in stream:
            if not member.isfile():
                continue
            if member.name in ('./psf/spectre.out', './console.log') and member.size <= 1024**2:
                logs.append(stream.extractfile(member).read().decode(errors='replace'))
            if member.name.startswith('./psf/') and member.name.endswith('.tran'):
                entries.append(member)
        log = '\n'.join(logs)
        target = folder/'spectre-diagnostics.log'
        target.write_text(log); target.chmod(0o600)
        datasets = _saved_datasets(app, record, stream, inventory, inventory_bytes)
        if len(entries) != 1 or entries[0].size > 16*1024**2 or record['plan'].get('simulator',{}).get('output_format') != 'psfascii':
            atomic(folder/'waveform-validity.json', {'data_validity':'valid' if datasets else 'unknown','specification':'unknown',
                'reason':'independent_saved_datasets' if datasets else 'native_format_not_supported','run_id':rid,'source_commit':record['source_commit'],
                'native_archive_sha256':collection['sha256'], 'dataset_ids':[row['dataset_id'] for row in datasets]})
            return
        try:
            raw_native = stream.extractfile(entries[0]).read()
            member = entries[0]
            expected_entry = {'path': member.name, 'bytes': member.size,
                              'sha256': hashlib.sha256(raw_native).hexdigest()}
            if [row for row in inventory if row.get('path') == member.name] != [expected_entry]:
                raise ValueError('Native waveform and collected inventory disagree')
            native = raw_native.decode()
            module = importlib.import_module('spiceowl.integrations.spectre_results')
            required = [row['name'] for row in (record['plan'].get('postprocess') or {}).get('signals',[])]
            summary = module.summarize_psf_ascii(native, required_signals=required)
            atomic(folder/'waveform-validity.json', {**summary,'run_id':rid,'source_commit':record['source_commit'],'native_archive_sha256':collection['sha256']})
            if summary['data_validity'] != 'valid':
                return
            wave = module.parse_psf_ascii(native)
            if wave['units'].get('time') != 's':
                atomic(folder/'waveform-validity.json',{**summary,'data_validity':'unknown','specification':'unknown','reason':'unsupported_time_unit','run_id':rid,'source_commit':record['source_commit']})
                return
        except (UnicodeError, ValueError):
            atomic(folder/'waveform-validity.json', {'data_validity':'invalid','specification':'unknown','reason':'native_waveform_parse_failed','run_id':rid,'source_commit':record['source_commit']})
            return
    names = [name for name in wave['values'] if name != 'time' and wave['units'].get(name) in ('V','A')]
    if required: names = [name for name in names if name in required]
    if not 1 <= len(names) <= 32:
        return
    times = wave['values']['time']; output = io.StringIO(newline=''); writer = csv.writer(output)
    writer.writerow([names[0]+' X']+[name+' Y' for name in names])
    for index,t in enumerate(times):
        writer.writerow([format(t,'.17g')]+[format(wave['values'][name][index],'.17g') for name in names])
    raw = output.getvalue().encode(); path = folder/'waveforms.csv'; path.write_bytes(raw); path.chmod(0o600)
    step=max(1,(len(times)+1599)//1600);indices=list(range(0,len(times),step))
    if indices[-1] != len(times)-1:indices.append(len(times)-1)
    metadata={'run_id':rid,'source_commit':record['source_commit'],'csv_sha256':hashlib.sha256(raw).hexdigest(),
              'native_archive_sha256':collection['sha256'],'csv_samples':len(times),'producer':'spiceowl.psf-ascii','waveforms':[{'name':name,'unit':wave['units'][name],'time_unit':'s','analysis':'tran','points':[[times[i],wave['values'][name][i]] for i in indices]} for name in names]}
    atomic(folder/'waveforms.json', metadata)
    record['postprocess_csv_sha256']=metadata['csv_sha256'];record['postprocess_phase']='complete';record['local_derivation']={'producer':'spiceowl.psf-ascii','run_id':rid,'source_commit':record['source_commit'],'native_archive_sha256':collection['sha256'],'csv_sha256':metadata['csv_sha256'],'metadata_sha256':filehash(folder/'waveforms.json'),'inventory_sha256':hashlib.sha256(inventory_bytes).hexdigest()}
    app.runner.save(record)
