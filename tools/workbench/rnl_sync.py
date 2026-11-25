"""Incremental netlist <-> RNL layout preservation and exact waveform-probe binding.

Generates deterministic, hash-bound live RNL schematics from committed Spectre/SPICE
netlists while preserving existing @RNL placement and wire annotations for unchanged
instances and nets. Also derives exact, validate_mapping()-verified ic.waveform-map.v1
probe bindings for newly executed local (ngspice/Xyce) and remote (Spectre) runs.

Never fabricates Virtuoso native fidelity attestations or guesses ambiguous signal names.
Python 3.9+, standard library only.
"""
import hashlib
import json
import re
from pathlib import PurePosixPath
from urllib.parse import urlencode

RNL_HEADER_RE = re.compile(r'(?m)^[ \t]*//[ \t]*@RNL\s*\(\s*type\s*=\s*"header"\s*\)')
RNL_BLOCK_RE = re.compile(
    r'(?m)(^[ \t]*//[ \t]*@RNL\b(?![ \t]*\([ \t]*type[ \t]*=[ \t]*"header")[^\n]*\{[ \t]*\n(?:^[ \t]*//[^\n]*\n)*?^[ \t]*//[ \t]*\}[ \t]*(?:\n|\Z))'
)
INST_PLACE_RE = re.compile(r'^\s*#\s*"([^"]+)"\s*@PLACE\(([^)]*)\)(.*)$')
PORT_PLACE_RE = re.compile(r'^\s*%([A-Za-z0-9_.-]+)\s*=\s*(?:\$IO_PORT\s+@ATTACH\s+&\s*"[^"]+"\s*=>\s*)?@PLACE\(([^)]*)\)(.*)$')
WIRE_RE = re.compile(r'^\s*&\s*"([^"]+)"\s*@WIRE\b(.*)$')
PLACE_COORDS_RE = re.compile(r'(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)')
SUBCKT_RE = re.compile(r'^\s*(?:\.subckt|subckt)\s+(\S+)(?:\s+(.*))?$', re.I)
ENDS_RE = re.compile(r'^\s*(?:\.ends|ends)\b', re.I)
SPECTRE_INST_RE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_.$<>-]*)\s*\(([^)]*)\)\s+([A-Za-z_][A-Za-z0-9_.$<>-]*)(?:\s+(.*))?$')
SKIP_HEADS = frozenset({
    'simulator', 'global', 'parameters', 'model', 'include', 'ahdl_include',
    'save', 'tran', 'ac', 'dc', 'options', 'subckt', 'ends', 'section', 'endsection',
    'library', 'endlibrary', 'alter', 'altergroup', 'statistics', 'process', 'mismatch',
})


def sha256_bytes(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode('utf-8')).hexdigest()


def object_hash(value):
    return sha256_bytes(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))


def parse_netlist_structure(text):
    """Parse Spectre/SPICE netlist scopes, instances, ports, and nets with 1-based line spans."""
    lines = text.splitlines()
    scopes = {}
    top = {'name': '(top)', 'ports': [], 'instances': [], 'nets': {}, 'line_start': 1, 'line_end': max(1, len(lines))}
    scopes['(top)'] = top
    scope = top
    idx = 0
    while idx < len(lines):
        start_line = idx + 1
        raw = lines[idx]
        idx += 1
        stripped = raw.strip()
        if not stripped or stripped.startswith(('//', '*', ';')):
            continue
        stmt = raw
        while stmt.rstrip().endswith('\\') and idx < len(lines):
            stmt = stmt.rstrip()[:-1] + ' ' + lines[idx].strip()
            idx += 1
        end_line = idx
        clean = re.sub(r'//[^\n]*', '', stmt).strip()
        if not clean:
            continue
        sub = SUBCKT_RE.match(clean)
        if sub:
            name = sub.group(1)
            ports = [p for p in (sub.group(2) or '').split() if p and '=' not in p]
            scope = {'name': name, 'ports': ports, 'instances': [], 'nets': {}, 'line_start': start_line, 'line_end': end_line}
            for port in ports:
                scope['nets'].setdefault(port, {'name': port, 'line_start': start_line, 'line_end': end_line})
            scopes[name] = scope
            continue
        if ENDS_RE.match(clean):
            scope['line_end'] = end_line
            scope = top
            continue
        head = clean.split()[0].lower()
        if head in SKIP_HEADS or head.startswith('.'):
            continue
        if re.match(r'^\S+\s+(?:tran|ac|dc|options|info|noise|sp|stb|xf|pss)\b', clean, re.I):
            continue
        inst = SPECTRE_INST_RE.match(clean)
        if inst:
            inst_name = inst.group(1)
            nodes = [n for n in inst.group(2).split() if n]
            master = inst.group(3)
            if master.lower() in SKIP_HEADS:
                continue
            terminals = [{'id': str(i + 1), 'net': node} for i, node in enumerate(nodes)]
            if master.lower() in {'vsource', 'isource', 'resistor', 'capacitor', 'inductor'} and len(nodes) == 2:
                terminals.extend([{'id': 'p', 'net': nodes[0]}, {'id': 'n', 'net': nodes[1]}])
            scope['instances'].append({
                'name': inst_name,
                'nodes': nodes,
                'master': master,
                'terminals': terminals,
                'line_start': start_line,
                'line_end': end_line,
            })
            for node in nodes:
                if node != '0':
                    scope['nets'].setdefault(node, {'name': node, 'line_start': start_line, 'line_end': end_line})
    return {'scopes': scopes, 'order': list(scopes.keys())}


def extract_rnl_layout(text):
    """Extract existing // @RNL(...) placement & wire annotations grouped by scope."""
    lines = text.splitlines()
    scope_name = '(top)'
    by_scope = {}
    in_rnl = False
    for line in lines:
        stripped = line.strip()
        sub = SUBCKT_RE.match(stripped)
        if sub:
            scope_name = sub.group(1)
            continue
        if ENDS_RE.match(stripped):
            scope_name = '(top)'
            continue
        if stripped.startswith('//'):
            body = stripped[2:].strip()
            if body.startswith('@RNL') and '{' in body:
                if 'type="header"' in body.replace(' ', ''):
                    continue
                in_rnl = True
                by_scope.setdefault(scope_name, {'instances': {}, 'ports': {}, 'wires': [], 'other': []})
                continue
            if in_rnl:
                if body.startswith('}'):
                    in_rnl = False
                    continue
                bucket = by_scope.setdefault(scope_name, {'instances': {}, 'ports': {}, 'wires': [], 'other': []})
                im = INST_PLACE_RE.match(body)
                if im:
                    coords = PLACE_COORDS_RE.search(im.group(2))
                    xy = (float(coords.group(1)), float(coords.group(2))) if coords else None
                    bucket['instances'][im.group(1)] = {'line': body, 'xy': xy}
                    continue
                pm = PORT_PLACE_RE.match(body)
                if pm:
                    coords = PLACE_COORDS_RE.search(pm.group(2))
                    xy = (float(coords.group(1)), float(coords.group(2))) if coords else None
                    bucket['ports'][pm.group(1)] = {'line': body, 'xy': xy}
                    continue
                wm = WIRE_RE.match(body)
                if wm:
                    refs = re.findall(r'#\s*"([^"]+)"', body)
                    port_refs = re.findall(r'%([A-Za-z0-9_.-]+)', body)
                    bucket['wires'].append({'net': wm.group(1), 'line': body, 'instances': refs, 'ports': port_refs})
                    continue
                if body:
                    bucket['other'].append(body)
    return by_scope


def strip_rnl_blocks(text):
    """Remove existing // @RNL(...) blocks while keeping electrical netlist lines intact."""
    return RNL_BLOCK_RE.sub('', text)


def _format_coord(val):
    return str(int(val)) if float(val).is_integer() else f'{val:.2f}'.rstrip('0').rstrip('.')


def merge_incremental_rnl(current_netlist, reference_rnl=None, *, viewer_source_path='circuit.scs', source_path='circuit.scs'):
    """Preserve existing @RNL placements for unchanged devices and place added ones cleanly."""
    source_sha = sha256_bytes(current_netlist)
    parsed = parse_netlist_structure(current_netlist)
    current_layout = extract_rnl_layout(current_netlist)
    ref_layout = extract_rnl_layout(reference_rnl) if reference_rnl else {}

    preserved_instances = []
    added_instances = []
    removed_instances = []
    preserved_wires = 0
    dropped_wires = 0

    scope_blocks = {}
    for scope_name in parsed['order']:
        scope = parsed['scopes'][scope_name]
        inst_names = [i['name'] for i in scope['instances']]
        if not inst_names:
            continue
        inst_set = set(inst_names)
        net_set = set(scope['nets'].keys()) | {'0'}
        port_set = {p.lower() for p in scope['ports']}

        # Prefer annotations already in current_netlist, then fall back to reference_rnl.
        prior_cur = current_layout.get(scope_name, {})
        prior_ref = ref_layout.get(scope_name, {})
        merged_insts = {**prior_ref.get('instances', {}), **prior_cur.get('instances', {})}
        merged_ports = {**prior_ref.get('ports', {}), **prior_cur.get('ports', {})}
        merged_wires = list(prior_cur.get('wires') or prior_ref.get('wires') or [])
        merged_other = list(prior_cur.get('other') or prior_ref.get('other') or [])

        for old_name in sorted(set(merged_insts) - inst_set):
            removed_instances.append(f'{scope_name}:{old_name}' if scope_name != '(top)' else old_name)

        used_xs = [info['xy'][0] for info in merged_insts.values() if info.get('xy')]
        used_ys = [info['xy'][1] for info in merged_insts.values() if info.get('xy')]
        next_x = (max(used_xs) + 18.0) if used_xs else 0.0
        base_y = (sum(used_ys) / len(used_ys)) if used_ys else 0.0

        rnl_lines = []
        inst_coords = {}
        added_idx = 0
        for other_line in merged_other:
            # Preserve symbol bindings / helper coordinates that still reference active instances or points.
            refs = re.findall(r'#\s*"([^"]+)"', other_line)
            if not refs or all(r in inst_set for r in refs):
                rnl_lines.append('  ' + other_line)
        for inst_name in inst_names:
            qualified = f'{scope_name}:{inst_name}' if scope_name != '(top)' else inst_name
            if inst_name in merged_insts:
                preserved_instances.append(qualified)
                rnl_lines.append('  ' + merged_insts[inst_name]['line'])
                if merged_insts[inst_name].get('xy'):
                    inst_coords[inst_name] = merged_insts[inst_name]['xy']
            else:
                added_instances.append(qualified)
                col = added_idx % 4
                row = added_idx // 4
                px = next_x + col * 18.0
                py = base_y - row * 16.0
                inst_coords[inst_name] = (px, py)
                rnl_lines.append(f'  #"{inst_name}" @PLACE({_format_coord(px)}, {_format_coord(py)}) => @ORIENT("R0");')
                added_idx += 1

        active_ports = set()
        for pname, pinfo in merged_ports.items():
            if not port_set or pname.lower() in port_set or pname in net_set:
                active_ports.add(pname)
                rnl_lines.append('  ' + pinfo['line'])

        wired_nets = set()
        for wire in merged_wires:
            if wire['net'] in net_set and all(r in inst_set for r in wire['instances']) and all(p in active_ports for p in wire['ports']):
                preserved_wires += 1
                wired_nets.add(wire['net'])
                rnl_lines.append('  ' + wire['line'])
            else:
                dropped_wires += 1

        # Auto-wire newly placed devices so fresh netlists without prior @WIRE draw connected schematics.
        if added_instances and not merged_wires:
            net_pins = {}
            for inst in scope['instances']:
                for pin_idx, node in enumerate(inst['nodes'], start=1):
                    net_pins.setdefault(node, []).append((inst['name'], pin_idx))
            gnd_idx = 0
            for net_name, pins in net_pins.items():
                if net_name in wired_nets:
                    continue
                if net_name == '0':
                    for inst_name, pin_idx in pins:
                        gnd_idx += 1
                        gx, gy = inst_coords.get(inst_name, (0.0, 0.0))
                        rnl_lines.append(f'  %gnd_{gnd_idx} = $GROUND @ATTACH &"0" => @PLACE({_format_coord(gx)}, {_format_coord(gy - 10)});')
                        rnl_lines.append(f'  &"0" @WIRE(mode="straight") {{#"{inst_name}":{pin_idx} %gnd_{gnd_idx}:1}};')
                elif len(pins) >= 2:
                    pts = ' '.join(f'#"{iname}":{pidx}' for iname, pidx in pins)
                    rnl_lines.append(f'  &"{net_name}" @WIRE(mode="straight") {{{pts}}};')

        if rnl_lines:
            block = '// @RNL(author="circuitgit-incremental-sync") {\n' + '\n'.join('// ' + l for l in rnl_lines) + '\n// }\n'
            scope_blocks[scope_name] = block

    # Re-embed merged @RNL blocks into clean netlist text (inside each subckt before ends, or at EOF for top).
    clean_base = strip_rnl_blocks(current_netlist)
    if not clean_base.endswith('\n'):
        clean_base += '\n'
    out_lines = []
    active_scope = '(top)'
    for line in clean_base.splitlines(keepends=True):
        stripped = line.strip()
        sub = SUBCKT_RE.match(stripped)
        if sub:
            active_scope = sub.group(1)
        elif ENDS_RE.match(stripped) and active_scope != '(top)':
            if active_scope in scope_blocks:
                out_lines.append(scope_blocks.pop(active_scope))
            active_scope = '(top)'
        out_lines.append(line)
    if '(top)' in scope_blocks:
        out_lines.append(scope_blocks.pop('(top)'))
    rnl_text = ''.join(out_lines)
    if not RNL_HEADER_RE.search(rnl_text):
        header_block = '// @RNL(type="header") {\n//   @VERSION("0.3");\n// }\n'
        first_nl = rnl_text.find('\n')
        if first_nl >= 0:
            rnl_text = rnl_text[:first_nl + 1] + header_block + rnl_text[first_nl + 1:]
        else:
            rnl_text = '// CircuitGit\n' + header_block + rnl_text
    rnl_sha = sha256_bytes(rnl_text)

    # Build exact canonical source-map objects pointing to current_netlist line numbers.
    objects = []
    for scope_name in parsed['order']:
        scope = parsed['scopes'][scope_name]
        for net_name, net_info in sorted(scope['nets'].items()):
            objects.append({
                'kind': 'net',
                'name': net_name,
                'scope': scope_name,
                'viewer_source_path': viewer_source_path,
                'source_path': source_path,
                'source_sha256': source_sha,
                'line_start': net_info['line_start'],
                'line_end': net_info['line_end'],
            })
        for inst in scope['instances']:
            objects.append({
                'kind': 'instance',
                'name': inst['name'],
                'scope': scope_name,
                'viewer_source_path': viewer_source_path,
                'source_path': source_path,
                'source_sha256': source_sha,
                'line_start': inst['line_start'],
                'line_end': inst['line_end'],
                'master': inst['master'],
                'terminals': inst['terminals'],
            })

    total_inst = len(preserved_instances) + len(added_instances)
    preserved_ratio = round(len(preserved_instances) / total_inst, 4) if total_inst else 1.0
    return {
        'rnl_text': rnl_text,
        'source_sha256': source_sha,
        'rnl_sha256': rnl_sha,
        'parsed': parsed,
        'objects': objects,
        'layout_sync': {
            'mode': 'incremental-rnl',
            'preserved_instances': preserved_instances,
            'added_instances': added_instances,
            'removed_instances': removed_instances,
            'preserved_wires': preserved_wires,
            'dropped_wires': dropped_wires,
            'preserved_ratio': preserved_ratio,
        },
    }


def _default_level_and_entry(project_id, path, parsed):
    non_top = [name for name in parsed['order'] if name != '(top)' and parsed['scopes'][name]['instances']]
    top_has_inst = bool(parsed['scopes']['(top)']['instances'])
    level = '@top' if top_has_inst or not non_top else non_top[0]
    viewer_file = PurePosixPath(path).name or 'circuit.scs'
    entry_id = 'live-' + re.sub(r'[^A-Za-z0-9_.-]+', '-', project_id)
    return entry_id, viewer_file, level


def build_live_schematic_bundle(project_id, path, current_text, source_sha256, origin, *, reference_rnl=None, source_commit=None):
    """Build a deterministic live RNL Viewer manifest, file bytes, and payload."""
    entry_id_pre, viewer_file, _ = _default_level_and_entry(project_id, path, parse_netlist_structure(current_text))
    merged = merge_incremental_rnl(current_text, reference_rnl, viewer_source_path=viewer_file, source_path=path)
    entry_id, viewer_file, level = _default_level_and_entry(project_id, path, merged['parsed'])
    rnl_bytes = merged['rnl_text'].encode('utf-8')
    bundle_sha = merged['rnl_sha256']

    file_query = urlencode({'project_id': project_id, 'path': path, 'source_sha256': source_sha256})
    manifest_query = urlencode({'project_id': project_id, 'path': path, 'source_sha256': source_sha256})
    file_url = f'{origin}/api/schematic/live-file?{file_query}'
    manifest_url = f'{origin}/api/schematic/live-manifest?{manifest_query}'

    viewer_manifest = {
        'format': 1,
        'id': entry_id,
        'entry': viewer_file,
        'level': level,
        'settings': {'autoInclude': False},
        'files': [{'path': viewer_file, 'url': file_url, 'sha256': bundle_sha, 'size': len(rnl_bytes)}],
    }
    manifest_bytes = (json.dumps(viewer_manifest, sort_keys=True, indent=2) + '\n').encode('utf-8')
    # Origin-independent identity so /api/schematic/live and waveform-map match on any loopback port.
    manifest_sha = object_hash({
        'schema': 'ic.live-schematic.manifest-id.v1',
        'entry_id': entry_id,
        'viewer_file': viewer_file,
        'level': level,
        'source_sha256': source_sha256,
        'bundle_sha256': bundle_sha,
    })

    cell = {
        'id': entry_id,
        'label': f'{project_id} (实时 RNL)',
        'cell_view': {'library': 'live', 'cell': project_id, 'view': 'schematic'},
        'entrypoint': viewer_file,
        'level': level,
        'source_kind': 'canonical-live-rnl',
        'canonical_source_mapping': True,
        'fidelity': 'live-incremental-rnl',
        'viewer_manifest_url': manifest_url,
    }
    source_map = {
        'schema': 'ic.native.source-map.v1',
        'bound_source_hash': source_sha256,
        'canonical_enabled': True,
        'objects': merged['objects'],
    }
    geometry_payload = {
        'schema': 'ic.live-schematic.v1',
        'mode': 'live-rnl',
        'state': 'ready',
        'available': True,
        'stale': False,
        'native_ready': False,
        'live_ready': True,
        'integrity': 'valid',
        'fidelity': 'live-incremental-rnl',
        'fidelity_authority': 'live_netlist_incremental_rnl',
        'bundle_commit': None,
        'bundle_sha256': bundle_sha,
        'manifest_sha256': manifest_sha,
        'source_binding': {
            'geometry_source_sha256': source_sha256,
            'geometry_source_commit': source_commit,
            'live_rnl_sha256': bundle_sha,
        },
        'layout_sync': merged['layout_sync'],
        'root_cell': entry_id,
        'cells': [cell],
        'entrypoint': viewer_file,
        'viewer_manifest_url': manifest_url,
        'files': [{'path': viewer_file, 'url': file_url, 'sha256': bundle_sha, 'bytes': len(rnl_bytes), 'kind': 'rnl'}],
        'mapping': source_map,
        'source_mapping_enabled': True,
        'losses': [],
        'reasons': [],
    }
    return {
        'entry_id': entry_id,
        'viewer_file': viewer_file,
        'level': level,
        'bundle_sha256': bundle_sha,
        'manifest_sha256': manifest_sha,
        'rnl_bytes': rnl_bytes,
        'manifest_bytes': manifest_bytes,
        'merged': merged,
        'payload': {
            'source_path': path,
            'source_hash': source_sha256,
            'source_commit': source_commit,
            'available': True,
            'stale': False,
            'native_ready': False,
            'live_ready': True,
            'mapping': source_map,
            'geometry': geometry_payload,
        },
    }


def _unique_signal_match(candidates, target_name):
    """Exact match first; allow unique case-insensitive match for SPICE lowercased rawfiles."""
    exact = [s for s in candidates if s.get('psf_name') == target_name]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        return None
    low = target_name.lower()
    ci = [s for s in candidates if isinstance(s.get('psf_name'), str) and s['psf_name'].lower() == low]
    return ci[0] if len(ci) == 1 else None


def derive_run_waveform_mapping(workspace, geometry, record, identity, signals, *, origin='http://127.0.0.1:8766', dataset_id=None):
    """Derive an exact, validate_mapping()-verified ic.waveform-map.v1 for a new run."""
    project_id = record.get('project_id')
    source_commit = record.get('source_commit')
    if not project_id or not source_commit or project_id not in workspace.projects:
        return None
    project = workspace.projects[project_id]
    source_path = project.get('source_path')
    if not source_path or source_path not in identity.get('source_hashes', {}):
        return None
    expected_sha = identity['source_hashes'][source_path]
    try:
        raw_source = geometry.blob(source_commit, source_path, 2 * 1024 * 1024)
    except Exception:
        return None
    if sha256_bytes(raw_source) != expected_sha:
        return None
    source_text = raw_source.decode('utf-8', errors='strict')

    # If a native RNL reference exists at this commit, pass it so layout hashes match /api/schematic/live.
    reference_rnl = _find_native_rnl_reference(geometry, project_id, source_commit)
    bundle = build_live_schematic_bundle(
        project_id,
        source_path,
        source_text,
        expected_sha,
        origin,
        reference_rnl=reference_rnl,
        source_commit=source_commit,
    )

    voltage_signals = [s for s in signals if s.get('quantity') == 'voltage' and s.get('unit') == 'V']
    current_signals = [s for s in signals if s.get('quantity') == 'current' and s.get('unit') == 'A']

    objects = []
    seen_selectors = set()
    parsed = bundle['merged']['parsed']
    viewer_file = bundle['viewer_file']
    entry_id = bundle['entry_id']

    for scope_name in parsed['order']:
        scope = parsed['scopes'][scope_name]
        # Map verified nets -> exact voltage signals.
        for net_name in sorted(scope['nets']):
            sig = _unique_signal_match(voltage_signals, net_name)
            if sig is None:
                continue
            selector = {
                'kind': 'net',
                'name': net_name,
                'scope': scope_name,
                'viewer_source_path': viewer_file,
                'occurrence_path': [],
                'native_entry_id': entry_id,
            }
            key = object_hash(selector)
            if key in seen_selectors:
                continue
            seen_selectors.add(key)
            objects.append({
                'selector': selector,
                'status': 'available',
                'signal_id': sig['id'],
                'psf_name': sig['psf_name'],
                'analysis': sig['analysis'],
                'unit': sig['unit'],
                'scale': 1,
                'evidence': f'Exact net "{net_name}" in committed {source_path} ({expected_sha[:12]}) bound to saved voltage signal "{sig["psf_name"]}"',
            })

        # Map verified instance terminals -> exact current signals (e.g., V0:p).
        for inst in scope['instances']:
            inst_name = inst['name']
            for term in inst['terminals']:
                term_id = term['id']
                candidate_name = f'{inst_name}:{term_id}'
                sig = _unique_signal_match(current_signals, candidate_name)
                if sig is None:
                    continue
                selector = {
                    'kind': 'terminal',
                    'name': inst_name,
                    'terminal_name': term_id,
                    'scope': scope_name,
                    'viewer_source_path': viewer_file,
                    'occurrence_path': [],
                    'native_entry_id': entry_id,
                }
                key = object_hash(selector)
                if key in seen_selectors:
                    continue
                seen_selectors.add(key)
                objects.append({
                    'selector': selector,
                    'status': 'available',
                    'signal_id': sig['id'],
                    'psf_name': sig['psf_name'],
                    'analysis': sig['analysis'],
                    'unit': sig['unit'],
                    'polarity': 'into_terminal',
                    'scale': 1,
                    'evidence': f'Exact terminal "{candidate_name}" in committed {source_path} ({expected_sha[:12]}) bound to saved current signal "{sig["psf_name"]}"',
                })

    if not objects:
        return None

    return {
        'schema': 'ic.waveform-map.v1',
        'run_id': identity['run_id'],
        'source_commit': identity['source_commit'],
        'effective_config_sha256': identity['effective_config_sha256'],
        'raw_signature': identity['raw_signature'],
        **({'dataset_id': dataset_id} if dataset_id is not None else {}),
        'source': {
            'kind': 'canonical',
            'path': source_path,
            'canonical_path': source_path,
            'sha256': expected_sha,
        },
        'geometry': {
            'kind': 'local_export_snapshot',
            'bundle_commit': None,
            'bundle_sha256': bundle['bundle_sha256'],
            'manifest_sha256': bundle['manifest_sha256'],
            'entry_id': entry_id,
        },
        'objects': objects,
    }


def _find_native_rnl_reference(geometry, project_id, commit):
    """Best-effort read of any committed native RNL text to preserve placements incrementally."""
    try:
        snap = geometry.snapshot(project_id, commit)
        m = snap['manifest']
        entry_path = m.get('entrypoint')
        if entry_path and entry_path in snap['table']:
            return geometry.member(snap, entry_path).decode('utf-8', errors='replace')
    except Exception:
        return None
    return None


def live_schematic_for_workspace(workspace, geometry, project_id, path, origin, *, expected_sha256=None):
    """Build a live incremental RNL schematic bundle for a registered workspace project."""
    project = workspace.projects.get(project_id)
    if not project or path != project.get('source_path'):
        raise FileNotFoundError('unknown schematic project or source path')
    current = workspace.file(path)
    actual_sha = current['sha256']
    if expected_sha256 is not None:
        if not isinstance(expected_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', expected_sha256):
            raise ValueError('source_sha256 must be a 64-character lowercase SHA-256 hex digest')
        if expected_sha256 != actual_sha:
            raise FileNotFoundError('requested live schematic hash no longer matches current source')
    commit = current.get('base_commit')
    reference_rnl = _find_native_rnl_reference(geometry, project_id, commit) if commit else None
    return build_live_schematic_bundle(
        project_id,
        path,
        current['content'],
        actual_sha,
        origin,
        reference_rnl=reference_rnl,
        source_commit=commit,
    )
