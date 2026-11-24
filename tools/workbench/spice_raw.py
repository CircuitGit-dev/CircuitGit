"""SPICE3 / ngspice / Xyce ASCII rawfile parser and hash-bound waveform derivation.

Parses real and complex multi-plot ASCII rawfiles using Python 3.9+ stdlib only.
Emits hash-bound waveforms.csv/waveforms.json (transient) and
waveform-datasets.json + datasets/ds_*.json (AC, DC sweep, DC operating point)
compatible with CircuitGit's WaveformService.
"""
import csv
import hashlib
import io
import json
import math
import re
from pathlib import Path

MAX_RAW_BYTES = 64 * 1024 * 1024
MAX_PLOTS = 32
MAX_POINTS = 200000
MAX_VARS = 256


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _normalize_var_name(raw_name, vtype):
    """Map SPICE rawfile variable names like v(out) / i(v0) to clean signal names."""
    name = raw_name.strip()
    low = name.lower()
    if low == 'time':
        return 'time', 's', 'time'
    if low == 'frequency':
        return 'frequency', 'Hz', 'frequency'
    m = re.fullmatch(r'v\(([^)]+)\)', name, re.I)
    if m:
        return m.group(1), 'V', 'voltage'
    m = re.fullmatch(r'i\(([^)]+)\)', name, re.I)
    if m:
        return m.group(1) + ':p', 'A', 'current'
    unit_map = {
        'voltage': ('V', 'voltage'),
        'current': ('A', 'current'),
        'time': ('s', 'time'),
        'frequency': ('Hz', 'frequency'),
    }
    unit, qty = unit_map.get(vtype.lower(), (None, None))
    return name, unit, qty


def _classify_plot(plotname, axis_name, axis_type, npoints, is_complex):
    low = plotname.lower()
    alow = (axis_name or '').lower()
    tlow = (axis_type or '').lower()
    if 'transient' in low or alow == 'time' or tlow == 'time':
        return 'tran'
    if is_complex or alow == 'frequency' or tlow == 'frequency' or re.search(r'\bac\b', low):
        return 'ac'
    if 'operating point' in low or (npoints == 1 and re.search(r'\bdc\b', low) and 'transfer' not in low):
        return 'dc_op'
    if re.search(r'\bdc\b', low) or 'transfer' in low:
        return 'dc' if npoints > 1 else 'dc_op'
    return 'dc_op' if npoints == 1 else 'dc'


def parse_ascii_rawfile(raw_bytes):
    """Parse one SPICE3/ngspice/Xyce ASCII rawfile into structured plots."""
    if isinstance(raw_bytes, str):
        raw_bytes = raw_bytes.encode('utf-8')
    if len(raw_bytes) > MAX_RAW_BYTES:
        raise ValueError('SPICE rawfile exceeds 64 MiB limit')
    raw_sha = _sha256(raw_bytes)
    lines = raw_bytes.decode('utf-8', errors='strict').splitlines()
    plots = []
    idx = 0
    total_lines = len(lines)

    while idx < total_lines:
        while idx < total_lines and not lines[idx].strip():
            idx += 1
        if idx >= total_lines:
            break
        if len(plots) >= MAX_PLOTS:
            raise ValueError('Rawfile exceeds maximum plot count')

        headers = {}
        variables = []
        while idx < total_lines:
            line = lines[idx]
            idx += 1
            if line.strip() == 'Variables:':
                break
            if ':' in line:
                key, value = line.split(':', 1)
                headers[key.strip().lower()] = value.strip()
        else:
            if not headers:
                break
            raise ValueError('Unexpected EOF before Variables section in rawfile')

        nvars = int(headers.get('no. variables', '0'))
        npoints = int(headers.get('no. points', '0'))
        if not 1 <= nvars <= MAX_VARS:
            raise ValueError(f'Unsupported variable count in rawfile: {nvars}')
        if not 1 <= npoints <= MAX_POINTS:
            raise ValueError(f'Unsupported point count in rawfile: {npoints}')
        flags = {f.strip().lower() for f in headers.get('flags', '').split() if f.strip()}
        is_complex = 'complex' in flags
        plotname = headers.get('plotname', f'plot_{len(plots)+1}')

        while idx < total_lines:
            line = lines[idx]
            idx += 1
            stripped = line.strip()
            if stripped == 'Values:':
                break
            if not stripped:
                continue
            parts = stripped.split()
            if len(parts) < 3:
                raise ValueError('Malformed variable row in rawfile: ' + line)
            vidx = int(parts[0])
            vname = parts[1]
            vtype = parts[2]
            variables.append({'index': vidx, 'raw_name': vname, 'type': vtype})

        if len(variables) != nvars:
            raise ValueError(f'Rawfile variable header mismatch: expected {nvars}, got {len(variables)}')

        data = [[] for _ in range(nvars)]
        points_read = 0
        while points_read < npoints and idx < total_lines:
            # First value line starts with "<point_index>\t<value>"
            while idx < total_lines and not lines[idx].strip():
                idx += 1
            if idx >= total_lines:
                break
            first = lines[idx].strip()
            idx += 1
            parts = first.split()
            if len(parts) < 2:
                raise ValueError('Malformed rawfile point header: ' + first)
            pidx = int(parts[0])
            if pidx != points_read:
                raise ValueError(f'Out-of-order rawfile point index: expected {points_read}, got {pidx}')
            row_tokens = [parts[1]]
            for _ in range(1, nvars):
                while idx < total_lines and not lines[idx].strip():
                    idx += 1
                if idx >= total_lines:
                    raise ValueError('Truncated point data in rawfile')
                row_tokens.append(lines[idx].strip())
                idx += 1

            for v_i, token in enumerate(row_tokens):
                if is_complex:
                    if ',' not in token:
                        raise ValueError('Expected complex re,im token in rawfile: ' + token)
                    re_s, im_s = token.split(',', 1)
                    re_v, im_v = float(re_s), float(im_s)
                    if not (math.isfinite(re_v) and math.isfinite(im_v)):
                        raise ValueError('Non-finite complex sample in rawfile')
                    data[v_i].append((re_v, im_v))
                else:
                    val = float(token)
                    if not math.isfinite(val):
                        raise ValueError('Non-finite sample in rawfile')
                    data[v_i].append(val)
            points_read += 1

        if points_read != npoints:
            raise ValueError(f'Rawfile point count mismatch: expected {npoints}, got {points_read}')

        axis_var = variables[0]
        kind = _classify_plot(plotname, axis_var['raw_name'], axis_var['type'], npoints, is_complex)
        plots.append({
            'title': headers.get('title', ''),
            'plotname': plotname,
            'kind': kind,
            'complex': is_complex,
            'point_count': npoints,
            'variables': variables,
            'data': data,
            'raw_sha256': raw_sha,
        })

    if not plots:
        raise ValueError('No plots found in SPICE ASCII rawfile')
    return {'schema': 'ic.spice-raw.v1', 'raw_sha256': raw_sha, 'plots': plots}


def _match_requested_signals(available_names, requested):
    if not requested:
        return list(available_names)
    lookup = {name.lower(): name for name in available_names}
    selected = []
    for req in requested:
        hit = lookup.get(req.lower())
        if hit and hit not in selected:
            selected.append(hit)
    return selected


def _build_native_dataset(plot, member, analysis_name):
    """Build a spiceowl.spectre-dataset.v1-compatible dict from an AC/DC/OP plot."""
    kind = plot['kind']
    npoints = plot['point_count']
    is_complex = plot['complex']
    variables = plot['variables']
    data = plot['data']

    if kind == 'dc_op':
        axis = None
        start_var = 0
    else:
        axis_raw = variables[0]
        ax_name, ax_unit, _ = _normalize_var_name(axis_raw['raw_name'], axis_raw['type'])
        if kind == 'ac':
            ax_unit = 'Hz'
            ax_vals = [float(pt[0]) if is_complex else float(pt) for pt in data[0]]
        else:
            ax_vals = [float(pt[0]) if is_complex else float(pt) for pt in data[0]]
        axis = {'name': ax_name, 'unit': ax_unit or 'V', 'values': ax_vals}
        start_var = 1

    signals = []
    seen = set()
    for i in range(start_var, len(variables)):
        var = variables[i]
        name, unit, _ = _normalize_var_name(var['raw_name'], var['type'])
        if name in seen:
            continue
        seen.add(name)
        if is_complex:
            signals.append({
                'name': name,
                'unit': unit or 'V',
                'value_kind': 'complex',
                'real': [pt[0] for pt in data[i]],
                'imag': [pt[1] for pt in data[i]],
            })
        else:
            signals.append({
                'name': name,
                'unit': unit or 'V',
                'value_kind': 'real',
                'values': list(data[i]),
            })

    return {
        'schema': 'spiceowl.spectre-dataset.v1',
        'raw_sha256': member['sha256'],
        'analysis': {'name': analysis_name, 'kind': kind},
        'sample_count': npoints,
        'axis': axis,
        'signals': signals,
        'operating_points': [],
        'warnings': [],
    }


def derive_spice_results(run_folder, record, archive_path, inventory, inventory_bytes, engine='ngspice'):
    """Derive waveforms.csv/json (tran) and waveform-datasets.json (AC/DC/OP) from a local SPICE rawfile."""
    from runner import atomic, filehash
    import tarfile

    folder = Path(run_folder)
    rid = record['run_id']
    commit = record['source_commit']
    archive_sha = record['collection']['sha256']
    producer = f'circuitgit.{engine}-raw'

    raw_members = []
    with tarfile.open(archive_path, 'r:gz') as tf:
        for member in tf.getmembers():
            if member.isfile() and member.name.startswith('./raw/') and member.name.endswith('.raw'):
                raw_bytes = tf.extractfile(member).read()
                raw_members.append((member, raw_bytes))

    if not raw_members:
        atomic(folder / 'waveform-validity.json', {
            'data_validity': 'unknown',
            'specification': 'unknown',
            'reason': 'no_spice_rawfile_found',
            'run_id': rid,
            'source_commit': commit,
            'native_archive_sha256': archive_sha,
        })
        return {'tran_derived': False, 'datasets': []}

    tran_plots = []
    other_plots = []
    for member, raw_bytes in raw_members:
        expected_entry = {'path': member.name, 'bytes': member.size, 'sha256': _sha256(raw_bytes)}
        if [row for row in inventory if row.get('path') == member.name] != [expected_entry]:
            raise ValueError('Native SPICE rawfile disagrees with immutable archive inventory')
        parsed = parse_ascii_rawfile(raw_bytes)
        for plot_idx, plot in enumerate(parsed['plots']):
            if plot['kind'] == 'tran':
                tran_plots.append((expected_entry, plot))
            elif plot['kind'] in ('ac', 'dc', 'dc_op'):
                other_plots.append((expected_entry, plot, plot_idx))

    datasets_meta = []
    dataset_hashes = {}
    if other_plots:
        catalog = {
            'schema': 'ic.waveform-datasets.v1',
            'run_id': rid,
            'source_commit': commit,
            'native_archive_sha256': archive_sha,
            'producer': producer,
            'datasets': [],
            'unsupported': [],
        }
        for member_info, plot, plot_idx in other_plots:
            kind = plot['kind']
            aname = f'{kind}_{plot_idx + 1}'
            dataset_data = _build_native_dataset(plot, member_info, aname)
            identity_bytes = json.dumps([rid, commit, member_info['path'], member_info['sha256']], separators=(',', ':')).encode()
            if len(other_plots) > 1:
                identity_bytes = json.dumps([rid, commit, member_info['path'], member_info['sha256'], plot_idx], separators=(',', ':')).encode()
            did = 'ds_' + hashlib.sha256(identity_bytes).hexdigest()[:32]
            payload = {
                'schema': 'ic.saved-waveform-dataset.v1',
                'run_id': rid,
                'source_commit': commit,
                'dataset_id': did,
                'native_member': member_info,
                'native_archive_sha256': archive_sha,
                'data': dataset_data,
            }
            path = folder / 'datasets' / (did + '.json')
            atomic(path, payload)
            data_hash = filehash(path)
            dataset_hashes[did] = data_hash
            row = {
                'dataset_id': did,
                'analysis': dataset_data['analysis'],
                'native_member': member_info,
                'data_path': 'datasets/' + did + '.json',
                'data_sha256': data_hash,
                'data_format': 'native_psf_json',
                'sample_count': dataset_data['sample_count'],
                'signal_count': len(dataset_data['signals']),
                'device_count': len(dataset_data['operating_points']),
                'axis': {k: v for k, v in (dataset_data.get('axis') or {}).items() if k != 'values'} if dataset_data.get('axis') is not None else None,
            }
            catalog['datasets'].append(row)
            datasets_meta.append(row)
        atomic(folder / 'waveform-datasets.json', catalog)
        record['local_dataset_derivation'] = {
            'schema': 'ic.waveform-dataset-derivation.v1',
            'run_id': rid,
            'source_commit': commit,
            'native_archive_sha256': archive_sha,
            'catalog_sha256': filehash(folder / 'waveform-datasets.json'),
            'inventory_sha256': _sha256(inventory_bytes),
            'dataset_sha256': dataset_hashes,
        }

    tran_derived = False
    if len(tran_plots) == 1:
        _, plot = tran_plots[0]
        variables = plot['variables']
        data = plot['data']
        times = data[0]
        # Ensure strictly increasing timestamps (ngspice occasionally emits duplicate timepoints at breakpoints).
        keep_indices = []
        for i, t in enumerate(times):
            if not keep_indices or t > times[keep_indices[-1]]:
                keep_indices.append(i)
        if len(keep_indices) >= 2:
            norm_vars = []
            for i in range(1, len(variables)):
                name, unit, _ = _normalize_var_name(variables[i]['raw_name'], variables[i]['type'])
                if unit in ('V', 'A'):
                    norm_vars.append((name, unit, data[i]))
            requested = [row['name'] for row in (record['plan'].get('postprocess') or {}).get('signals', [])]
            chosen_names = _match_requested_signals([v[0] for v in norm_vars], requested)
            if not chosen_names:
                chosen_names = [v[0] for v in norm_vars][:32]
            var_by_name = {v[0]: v for v in norm_vars}
            chosen = [var_by_name[n] for n in chosen_names[:32]]

            if chosen:
                output = io.StringIO(newline='')
                writer = csv.writer(output)
                writer.writerow([chosen[0][0] + ' X'] + [item[0] + ' Y' for item in chosen])
                for idx in keep_indices:
                    writer.writerow([format(times[idx], '.17g')] + [format(item[2][idx], '.17g') for item in chosen])
                csv_bytes = output.getvalue().encode('utf-8')
                csv_path = folder / 'waveforms.csv'
                csv_path.write_bytes(csv_bytes)
                csv_path.chmod(0o600)
                csv_sha = _sha256(csv_bytes)

                n_kept = len(keep_indices)
                step = max(1, (n_kept + 1599) // 1600)
                disp_idx = list(range(0, n_kept, step))
                if disp_idx[-1] != n_kept - 1:
                    disp_idx.append(n_kept - 1)
                waves = [
                    {
                        'name': name,
                        'unit': unit,
                        'time_unit': 's',
                        'analysis': 'tran',
                        'points': [[times[keep_indices[j]], vals[keep_indices[j]]] for j in disp_idx],
                    }
                    for name, unit, vals in chosen
                ]
                metadata = {
                    'run_id': rid,
                    'source_commit': commit,
                    'csv_sha256': csv_sha,
                    'native_archive_sha256': archive_sha,
                    'csv_samples': n_kept,
                    'producer': producer,
                    'waveforms': waves,
                }
                atomic(folder / 'waveforms.json', metadata)
                record['postprocess_csv_sha256'] = csv_sha
                record['postprocess_phase'] = 'complete'
                record['local_derivation'] = {
                    'producer': producer,
                    'run_id': rid,
                    'source_commit': commit,
                    'native_archive_sha256': archive_sha,
                    'csv_sha256': csv_sha,
                    'metadata_sha256': filehash(folder / 'waveforms.json'),
                    'inventory_sha256': _sha256(inventory_bytes),
                }
                tran_derived = True

    atomic(folder / 'waveform-validity.json', {
        'data_validity': 'valid' if (tran_derived or datasets_meta) else 'unknown',
        'specification': 'unknown',
        'reason': 'local_spice_raw_derivation' if (tran_derived or datasets_meta) else 'no_supported_plots',
        'run_id': rid,
        'source_commit': commit,
        'native_archive_sha256': archive_sha,
        'producer': producer,
        'dataset_ids': [row['dataset_id'] for row in datasets_meta],
    })
    return {'tran_derived': tran_derived, 'datasets': datasets_meta}
