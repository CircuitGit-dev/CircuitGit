"""Deterministic Spectre-subset to SPICE (ngspice / Xyce) netlist transpiler.

Converts the bounded Spectre netlist subset used by CircuitGit into a
self-contained SPICE deck for ngspice or Xyce, preserving source provenance and
failing closed on unsupported or shell-like directives. Python 3.9+ stdlib only.
"""
import hashlib
import posixpath
import re
from pathlib import PurePosixPath

SCHEMA = 'ic.spice-transpile.v1'

FORBIDDEN = re.compile(r'(?im)^\s*(?:\.?shell|system|exec)\b|\$system\s*\(')
SPECTRE_HEADER = re.compile(r'(?i)^simulator\s+lang\s*=\s*(\S+)$')
ASSIGN_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"\n]*"|\[[^\]\n]*\]|[^\s]+)')
SAFE_NAME = re.compile(r'^[A-Za-z0-9_.$:<>\\+-]+$')


def _strip_spectre_comment(line):
    """Strip // line comments while ignoring // inside quoted strings."""
    return re.sub(r'("[^"\n]*")|//[^\n]*', lambda m: m[1] or '', line).strip()


def _logical_lines(text):
    """Join backslash continuations and return list of (line_no, cleaned_line, raw)."""
    lines = text.splitlines()
    out = []
    idx = 0
    while idx < len(lines):
        start = idx + 1
        buf = [lines[idx]]
        while buf[-1].rstrip().endswith('\\') and idx + 1 < len(lines):
            buf[-1] = buf[-1].rstrip()[:-1]
            idx += 1
            buf.append(lines[idx])
        raw = ' '.join(part.strip() for part in buf)
        cleaned = _strip_spectre_comment(raw)
        out.append((start, cleaned, raw))
        idx += 1
    return out


def _parse_params(text):
    return {k: v for k, v in ASSIGN_RE.findall(text)}


def _format_params(params, skip=()):
    skip_set = set(skip)
    parts = []
    for key, val in params.items():
        if key in skip_set:
            continue
        parts.append(f'{key}={val}')
    return ' '.join(parts)


def _spice_source_spec(params):
    """Translate Spectre vsource/isource parameters to SPICE syntax."""
    stype = params.get('type', 'dc').strip('"').lower()
    parts = []
    if stype == 'dc':
        dc_val = params.get('dc', '0')
        parts.append(f'DC {dc_val}')
        if 'mag' in params:
            phase = params.get('phase', '0')
            parts.append(f'AC {params["mag"]} {phase}')
        return ' '.join(parts)
    if stype == 'pulse':
        v0 = params.get('val0', '0')
        v1 = params.get('val1', '1')
        td = params.get('delay', '0')
        tr = params.get('rise', '1p')
        tf = params.get('fall', '1p')
        pw = params.get('width', '1n')
        per = params.get('period', '2n')
        if 'dc' in params:
            parts.append(f'DC {params["dc"]}')
        parts.append(f'PULSE({v0} {v1} {td} {tr} {tf} {pw} {per})')
        return ' '.join(parts)
    if stype in ('sine', 'sin'):
        vo = params.get('sinedc', params.get('dc', '0'))
        va = params.get('ampl', '1')
        freq = params.get('freq', '1Meg')
        td = params.get('delay', '0')
        theta = params.get('damp', '0')
        parts.append(f'SIN({vo} {va} {freq} {td} {theta})')
        if 'mag' in params:
            parts.append(f'AC {params["mag"]} {params.get("phase", "0")}')
        return ' '.join(parts)
    raise ValueError(f'Unsupported Spectre source type for open-source SPICE translation: {stype}')


def _prefix(name, letter):
    return name if name[0].upper() == letter else f'{letter}_{name}'


def _translate_spectre_model(line):
    """Translate Spectre `model <name> <type> k=v ...` to SPICE `.model`."""
    parts = line.split(None, 3)
    if len(parts) < 3:
        raise ValueError('Malformed Spectre model statement: ' + line)
    _, name, mtype = parts[:3]
    rest = parts[3] if len(parts) > 3 else ''
    params = _parse_params(rest)
    mtype_lower = mtype.lower()
    if mtype_lower in ('bsim4', 'bsim3v3', 'mos1', 'mos2', 'mos3', 'ekv'):
        polarity = params.pop('type', 'n').strip('"').lower()
        spice_type = 'nmos' if polarity.startswith('n') else 'pmos'
        level_map = {'mos1': '1', 'mos2': '2', 'mos3': '3', 'bsim3v3': '8', 'bsim4': '14', 'ekv': '44'}
        params.setdefault('level', level_map[mtype_lower])
    elif mtype_lower in ('nmos', 'pmos', 'npn', 'pnp', 'd', 'diode', 'r', 'c'):
        spice_type = 'd' if mtype_lower == 'diode' else mtype_lower
    else:
        raise ValueError(f'Unsupported Spectre model type: {mtype}')
    param_str = _format_params(params)
    return f'.model {name} {spice_type}' + (f' ({param_str})' if param_str else '')


def _translate_spectre_analysis(line, engine):
    """Translate Spectre tran/ac/dc analysis statements."""
    tokens = line.split()
    if len(tokens) < 2:
        raise ValueError('Malformed Spectre analysis: ' + line)
    aname, akind = tokens[0], tokens[1].lower()
    params = _parse_params(line.split(None, 2)[2] if len(tokens) > 2 else '')
    if akind == 'tran':
        stop = params.get('stop')
        if not stop:
            raise ValueError('Spectre tran analysis requires stop=<time>')
        step = params.get('maxstep') or params.get('step')
        start = params.get('start', '0')
        if step:
            stmt = f'.tran {step} {stop} {start} {step}'
        else:
            # Conservative default step = stop/200 when maxstep omitted.
            stmt = f'.tran {{{stop}/200}} {stop} {start}'
        return ('tran', aname, stmt)
    if akind == 'ac':
        start = params.get('start')
        stop = params.get('stop')
        if not start or not stop:
            raise ValueError('Spectre ac analysis requires start and stop frequencies')
        if 'dec' in params:
            stmt = f'.ac dec {params["dec"]} {start} {stop}'
        elif 'lin' in params:
            stmt = f'.ac lin {params["lin"]} {start} {stop}'
        elif 'oct' in params:
            stmt = f'.ac oct {params["oct"]} {start} {stop}'
        else:
            stmt = f'.ac dec 20 {start} {stop}'
        return ('ac', aname, stmt)
    if akind == 'dc':
        if 'dev' in params and 'start' in params and 'stop' in params:
            dev = params['dev']
            step = params.get('step', f'({params["stop"]}-{params["start"]})/100')
            stmt = f'.dc {dev} {params["start"]} {params["stop"]} {step}'
            return ('dc', aname, stmt)
        return ('dc_op', aname, '.op')
    raise ValueError(f'Unsupported Spectre analysis kind: {akind}')


def _translate_save_token(token, instance_map):
    token = token.strip()
    if not token or token == '0':
        return None
    if ':' in token:
        inst, _term = token.rsplit(':', 1)
        mapped = instance_map.get(inst, inst)
        if mapped.upper().startswith('V'):
            return f'i({mapped})'
        # ngspice branch current syntax for resistors/MOS requires explicit device probe or @dev[i].
        return f'@{mapped.lower()}[i]'
    return f'v({token})'


def _is_spectre_source(text):
    for _, line, _ in _logical_lines(text):
        if not line:
            continue
        if SPECTRE_HEADER.fullmatch(line):
            return 'spectre' in line.lower()
        if line.startswith('.'):
            return False
    return False


def transpile_spectre_file(text, engine='ngspice', subckt_names=None, is_entrypoint=True):
    """Transpile one Spectre file into SPICE statements.

    Returns (spice_text, metadata_dict).
    """
    if engine not in ('ngspice', 'xyce'):
        raise ValueError('Unsupported open-source SPICE engine: ' + str(engine))
    if FORBIDDEN.search(text):
        raise ValueError('Forbidden shell/system directive in netlist')

    known_subckts = set(subckt_names or ())
    logical = _logical_lines(text)
    # First pass: collect locally defined subcircuits so instances get X prefix.
    for _, line, _ in logical:
        m = re.match(r'(?i)^subckt\s+([A-Za-z_][A-Za-z0-9_$]*)\b', line)
        if m:
            known_subckts.add(m.group(1))

    out = []
    analyses = []
    saves = []
    notes = []
    instance_map = {}
    includes = []

    for lineno, line, _raw in logical:
        if not line:
            continue
        low = line.lower()
        if SPECTRE_HEADER.fullmatch(line):
            if 'spectre' not in low:
                raise ValueError(f'Line {lineno}: unsupported simulator language: {line}')
            continue
        if re.match(r'(?i)^global\s+', line):
            # Node 0 is implicitly global in SPICE; preserve other global nodes if any.
            globals_list = [g for g in line.split()[1:] if g != '0']
            if globals_list:
                out.append('.global ' + ' '.join(globals_list))
            continue
        if re.match(r'(?i)^parameters\s+', line):
            params = _parse_params(line.split(None, 1)[1])
            if not params:
                raise ValueError(f'Line {lineno}: empty parameters declaration')
            out.append('.param ' + _format_params(params))
            continue
        if re.match(r'(?i)^include\s+"([^"]+)"', line):
            m = re.fullmatch(r'(?i)include\s+"([^"]+)"(?:\s+section=(\S+))?', line)
            if not m:
                raise ValueError(f'Line {lineno}: unsupported include syntax: {line}')
            target, section = m.group(1), m.group(2)
            includes.append({'target': target, 'section': section})
            if section:
                out.append(f'.lib "{target}" {section}')
            else:
                out.append(f'.include "{target}"')
            continue
        if re.match(r'(?i)^subckt\s+', line):
            parts = line.split()
            if len(parts) < 3:
                raise ValueError(f'Line {lineno}: malformed subckt: {line}')
            out.append('.subckt ' + ' '.join(parts[1:]))
            continue
        if re.match(r'(?i)^ends(?:\s|$)', line):
            parts = line.split()
            out.append('.ends' + (' ' + parts[1] if len(parts) > 1 else ''))
            continue
        if re.match(r'(?i)^model\s+', line):
            out.append(_translate_spectre_model(line))
            continue
        if re.match(r'(?i)^save(?:\s|$)', line):
            for tok in line.split()[1:]:
                saves.append(tok)
            continue
        if re.match(r'(?i)^\S+\s+options(?:\s|$)', line):
            notes.append(f'Line {lineno}: Spectre options statement preserved as comment ({line.split()[0]})')
            out.append('* ' + line)
            continue
        if re.match(r'(?i)^[A-Za-z_][A-Za-z0-9_]*\s+(?:tran|ac|dc)(?:\s|$)', line):
            kind, aname, stmt = _translate_spectre_analysis(line, engine)
            analyses.append({'name': aname, 'kind': kind, 'statement': stmt})
            out.append(stmt)
            continue

        inst = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_$]*)\s*\(([^)]+)\)\s+([A-Za-z_][A-Za-z0-9_$]*)(?:\s+(.*))?', line)
        if inst:
            name, node_str, master, rest = inst.groups()
            nodes = node_str.split()
            params = _parse_params(rest or '')
            ml = master.lower()
            if ml == 'resistor':
                if len(nodes) != 2 or 'r' not in params:
                    raise ValueError(f'Line {lineno}: resistor requires 2 nodes and r=<val>')
                sname = _prefix(name, 'R')
                instance_map[name] = sname
                extra = _format_params(params, skip=('r',))
                out.append(f'{sname} {nodes[0]} {nodes[1]} {params["r"]}' + (f' {extra}' if extra else ''))
            elif ml == 'capacitor':
                if len(nodes) != 2 or 'c' not in params:
                    raise ValueError(f'Line {lineno}: capacitor requires 2 nodes and c=<val>')
                sname = _prefix(name, 'C')
                instance_map[name] = sname
                extra = _format_params(params, skip=('c',))
                out.append(f'{sname} {nodes[0]} {nodes[1]} {params["c"]}' + (f' {extra}' if extra else ''))
            elif ml == 'inductor':
                if len(nodes) != 2 or 'l' not in params:
                    raise ValueError(f'Line {lineno}: inductor requires 2 nodes and l=<val>')
                sname = _prefix(name, 'L')
                instance_map[name] = sname
                extra = _format_params(params, skip=('l',))
                out.append(f'{sname} {nodes[0]} {nodes[1]} {params["l"]}' + (f' {extra}' if extra else ''))
            elif ml in ('vsource', 'isource'):
                if len(nodes) != 2:
                    raise ValueError(f'Line {lineno}: {ml} requires 2 nodes')
                letter = 'V' if ml == 'vsource' else 'I'
                sname = _prefix(name, letter)
                instance_map[name] = sname
                out.append(f'{sname} {nodes[0]} {nodes[1]} {_spice_source_spec(params)}')
            elif master in known_subckts:
                sname = _prefix(name, 'X')
                instance_map[name] = sname
                extra = _format_params(params)
                out.append(f'{sname} {" ".join(nodes)} {master}' + (f' {extra}' if extra else ''))
            elif name[0].upper() == 'M' or len(nodes) == 4:
                # 4-terminal MOS device (either built-in model or open PDK subckt/model).
                # Sky130/IHP/GF180 subckt-wrapped FETs use X prefix when master starts with sky130_fd_pr__ or sg13_.
                if master.startswith(('sky130_fd_pr__', 'sg13_')):
                    sname = _prefix(name, 'X')
                else:
                    sname = _prefix(name, 'M')
                instance_map[name] = sname
                # Map Spectre `multi` to SPICE `m` if present.
                if 'multi' in params and 'm' not in params:
                    params['m'] = params.pop('multi')
                extra = _format_params(params)
                out.append(f'{sname} {" ".join(nodes)} {master}' + (f' {extra}' if extra else ''))
            else:
                sname = _prefix(name, 'X')
                instance_map[name] = sname
                extra = _format_params(params)
                out.append(f'{sname} {" ".join(nodes)} {master}' + (f' {extra}' if extra else ''))
            continue

        raise ValueError(f'Line {lineno}: unsupported Spectre statement for open-source SPICE translation: {line}')

    if is_entrypoint and saves:
        translated_saves = []
        for tok in saves:
            mapped = _translate_save_token(tok, instance_map)
            if mapped and mapped not in translated_saves:
                translated_saves.append(mapped)
        if translated_saves and engine == 'ngspice':
            out.append('.save ' + ' '.join(translated_saves))

    return '\n'.join(out) + '\n', {
        'subckts': sorted(known_subckts),
        'analyses': analyses,
        'saves': saves,
        'instance_map': instance_map,
        'includes': includes,
        'notes': notes,
    }


def compile_payload_to_spice(payload, entrypoint, engine='ngspice', pdk_directives=None):
    """Compile staged payload files (Spectre or native SPICE) into a runnable deck.

    Returns (compiled_files_dict, entry_spice_path, manifest_dict).
    """
    if engine not in ('ngspice', 'xyce'):
        raise ValueError('Unsupported engine: ' + str(engine))
    if entrypoint not in payload:
        raise ValueError('Entrypoint absent from payload: ' + entrypoint)

    # Collect subcircuit names across all Spectre files first.
    global_subckts = set()
    spectre_files = {}
    for name, raw in sorted(payload.items()):
        text = raw.decode('utf-8')
        if FORBIDDEN.search(text):
            raise ValueError('Forbidden shell/system directive in ' + name)
        if name.endswith('.scs') or _is_spectre_source(text):
            spectre_files[name] = text
            for _, line, _ in _logical_lines(text):
                m = re.match(r'(?i)^subckt\s+([A-Za-z_][A-Za-z0-9_$]*)\b', line)
                if m:
                    global_subckts.add(m.group(1))

    compiled = {}
    file_reports = []
    entry_meta = None

    # Map Spectre filenames to .cir when translating so .include references match cleanly.
    rename_map = {}
    for name in spectre_files:
        p = PurePosixPath(name)
        rename_map[name] = str(p.with_suffix('.cir')) if p.suffix == '.scs' else name + '.cir'

    for name, raw in sorted(payload.items()):
        if name in spectre_files:
            body, meta = transpile_spectre_file(
                spectre_files[name],
                engine=engine,
                subckt_names=global_subckts,
                is_entrypoint=(name == entrypoint),
            )
            # Rewrite relative local includes pointing to translated Spectre files.
            base_dir = posixpath.dirname(name)
            for inc in meta['includes']:
                target = inc['target']
                if target.startswith('/'):
                    continue
                resolved = posixpath.normpath(posixpath.join(base_dir, target))
                if resolved in rename_map:
                    rel_new = posixpath.relpath(rename_map[resolved], base_dir or '.')
                    body = body.replace(f'"{target}"', f'"{rel_new}"')
            dest = rename_map[name]
            if name == entrypoint:
                header_lines = [
                    f'* CircuitGit generated {engine} deck from {name}',
                    '.options filetype=ascii numdgt=12' if engine == 'ngspice' else '',
                    *(pdk_directives or []),
                ]
                header = '\n'.join(line for line in header_lines if line) + '\n'
                full_text = header + body + '.end\n'
                entry_meta = meta
            else:
                full_text = f'* CircuitGit translated include from {name}\n' + body
            encoded = full_text.encode('utf-8')
            compiled[dest] = encoded
            file_reports.append({
                'source': name,
                'compiled': dest,
                'mode': 'spectre_to_spice',
                'source_sha256': hashlib.sha256(raw).hexdigest(),
                'compiled_sha256': hashlib.sha256(encoded).hexdigest(),
                'notes': meta['notes'],
            })
        else:
            # Native SPICE deck or supporting file.
            text = raw.decode('utf-8')
            if name == entrypoint:
                prefix_lines = [
                    f'* CircuitGit {engine} wrapper for native SPICE {name}',
                    '.options filetype=ascii numdgt=12' if engine == 'ngspice' and 'filetype=' not in text.lower() else '',
                    *(pdk_directives or []),
                ]
                lines = text.splitlines()
                title = lines[0] if lines else '* CircuitGit native SPICE'
                rest = '\n'.join(lines[1:]) if len(lines) > 1 else ''
                body = title + '\n' + '\n'.join(l for l in prefix_lines if l) + '\n' + rest
                if not re.search(r'(?im)^\s*\.end\s*$', body):
                    body = body.rstrip() + '\n.end\n'
                encoded = body.encode('utf-8')
                compiled[name] = encoded
                entry_meta = {'analyses': _detect_native_spice_analyses(text), 'saves': [], 'notes': []}
            else:
                compiled[name] = raw
            file_reports.append({
                'source': name,
                'compiled': name,
                'mode': 'native_spice',
                'source_sha256': hashlib.sha256(raw).hexdigest(),
                'compiled_sha256': hashlib.sha256(compiled[name]).hexdigest(),
                'notes': [],
            })

    entry_spice = rename_map.get(entrypoint, entrypoint)
    manifest = {
        'schema': SCHEMA,
        'engine': engine,
        'source_entrypoint': entrypoint,
        'compiled_entrypoint': entry_spice,
        'analyses': (entry_meta or {}).get('analyses', []),
        'files': file_reports,
    }
    return compiled, entry_spice, manifest


def _detect_native_spice_analyses(text):
    analyses = []
    for idx, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        low = s.lower()
        if low.startswith('.tran'):
            analyses.append({'name': f'tran_{idx}', 'kind': 'tran', 'statement': s})
        elif low.startswith('.ac'):
            analyses.append({'name': f'ac_{idx}', 'kind': 'ac', 'statement': s})
        elif low.startswith('.dc'):
            analyses.append({'name': f'dc_{idx}', 'kind': 'dc', 'statement': s})
        elif low.startswith('.op'):
            analyses.append({'name': f'op_{idx}', 'kind': 'dc_op', 'statement': s})
    return analyses
