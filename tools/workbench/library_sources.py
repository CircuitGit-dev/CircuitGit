"""Compile explicitly bound canonical library subcircuits into a staged netlist.

This module has no filesystem, model, gateway or simulator operations. The caller
supplies a commit-pinned ``read_blob(commit, path, overrides=None)`` function.
``compile_sources`` returns (new_out, source_hashes, report) and never mutates out.
Only the bounded Spectre subset recorded by the bindings is accepted. Interface,
instance structure and indexed-identifier changes require updated bindings.
"""
from collections import Counter
from dataclasses import dataclass
import hashlib
import json
import re

SCHEMA = 'circuitgit.library-sources.v1'
MAX_BYTES = 16 * 1024 * 1024
MAX_BLOCKS = 512
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_.$]*\Z')
IDENTIFIER = re.compile(r'"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_.$]*(?:\\?<\d+\\?>)?')
BUS = re.compile(r'([A-Za-z_][A-Za-z0-9_.$]*)\\?<([0-9]+)\\?>\Z')
INDEXED = re.compile(r'[A-Za-z_][A-Za-z0-9_.$]*_[0-9]+\Z')
SHA = re.compile(r'[a-f0-9]{64}\Z')
TOKENS = re.compile(r'"(?:\\.|[^"\\])*"|\S+')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _require(condition, message):
    if not condition:
        raise ValueError('Canonical library sources: ' + message)


def _path(value, *, repository=True):
    _require(isinstance(value, str) and value and not value.startswith('/')
             and not re.search(r'[\\:%?#\x00-\x1f\x7f]', value)
             and all(part not in ('', '.', '..') for part in value.split('/')),
             'unsafe source or destination path')
    if repository:
        _require(value.startswith(('lib/', 'projects/')), 'source must be a library/project file')
    return value


def _keys(value, names, label):
    _require(isinstance(value, dict) and set(value) == set(names), label + ' fields differ from schema')


def _strings(value, label):
    _require(isinstance(value, list) and value and len(value) <= 8192
             and all(isinstance(item, str) and item and not re.search(r'\s', item) for item in value)
             and len(value) == len(set(value)), label + ' must contain unique identifiers')


def _json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            _require(key not in value, 'duplicate JSON field ' + key)
            value[key] = item
        return value
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite JSON value')))


def _text(raw, label):
    _require(isinstance(raw, bytes) and len(raw) <= MAX_BYTES, label + ' must be bounded UTF-8 bytes')
    text = raw.decode('utf-8')
    _require('\x00' not in text, label + ' contains NUL')
    return text


def _uncomment(line):
    if line.lstrip().startswith(('*', '//')):
        return ''
    quoted = escaped = False
    for index, char in enumerate(line):
        if escaped:
            escaped = False
            continue
        if char == '\\':
            escaped = True
        elif char == '"':
            quoted = not quoted
        elif not quoted and line[index:index + 2] == '//':
            return line[:index]
        elif not quoted and line[index:index + 2] in ('/*', '*/'):
            raise ValueError('Canonical library sources: block comments are outside the supported subset')
    _require(not quoted, 'unterminated quoted string')
    return line


def _statements(text):
    offset = 0
    pending, first = '', None
    for line in text.splitlines(keepends=True):
        start, offset = offset, offset + len(line)
        code = _uncomment(line.rstrip('\r\n')).rstrip()
        if not code.strip():
            continue
        if first is None:
            first = start
        continued = code.endswith('\\')
        pending += (' ' if pending else '') + (code[:-1] if continued else code).strip()
        if not continued:
            yield first, offset, ' '.join(TOKENS.findall(pending))
            pending, first = '', None
    _require(not pending, 'unfinished continuation line')


@dataclass(frozen=True)
class Block:
    name: str
    ports: tuple
    statements: tuple
    start: int
    end: int


def electrical_blocks(raw):
    """Return parsed blocks plus offsets into the original UTF-8 text."""
    text = _text(raw, 'source')
    blocks, active, body = {}, None, []
    for start, end, statement in _statements(text):
        tokens = TOKENS.findall(statement)
        command = tokens[0].lower()
        if command == 'subckt':
            _require(active is None and len(tokens) >= 3, 'nested or malformed subcircuit')
            name = tokens[1]
            _require(NAME.fullmatch(name) and name not in blocks, 'duplicate or invalid subcircuit ' + name)
            active, body = (name, tuple(tokens[2:]), start), [statement]
        elif command == 'ends':
            _require(active is not None and len(tokens) in (1, 2), 'unmatched or malformed ends')
            _require(len(tokens) == 1 or tokens[1] == active[0], 'subcircuit end name differs')
            body.append('ends ' + active[0])
            blocks[active[0]] = Block(active[0], active[1], tuple(body), active[2], end)
            active, body = None, []
            _require(len(blocks) <= MAX_BLOCKS, 'too many subcircuit blocks')
        elif active is not None:
            body.append(statement)
    _require(active is None, 'unclosed subcircuit')
    return blocks


def block_tokens(block):
    return [token for statement in block.statements for token in TOKENS.findall(statement)]


def block_hash(block):
    return digest(json.dumps(block_tokens(block), ensure_ascii=False, separators=(',', ':')).encode())


def electrical_hash(raw):
    """Hash ordered source statements, ignoring drawing comments and whitespace.

    Includes and top-level statements remain significant. This does not resolve
    includes or assert equivalence to an exported simulation template.
    """
    statements = [TOKENS.findall(statement) for _, _, statement in _statements(_text(raw, 'guarded source'))]
    _require(statements, 'guarded electrical source is empty')
    return digest(json.dumps(statements, ensure_ascii=False, separators=(',', ':')).encode())


def _identifiers(block):
    return Counter(match[0] for statement in block.statements for match in IDENTIFIER.finditer(statement)
                   if not match[0].startswith('"'))


def _instances(block):
    instances = {}
    for statement in block.statements[1:-1]:
        if statement.lower().startswith('parameters '):
            _require('=' in statement, 'empty parameters statement in ' + block.name)
            continue
        match = re.fullmatch(r'([^\s()]+)\s+\(([^()]*)\)\s+([^\s()]+)(?:\s+.*)?', statement)
        _require(match is not None, 'unsupported electrical statement in ' + block.name)
        name, nodes, master = match.groups()
        _require(name not in instances and nodes.split(), 'duplicate instance or empty terminals in ' + block.name)
        _require(NAME.fullmatch(master) is not None, 'unsupported instance master in ' + block.name)
        instances[name] = {'master': master, 'terminals': len(nodes.split())}
    _require(instances, 'empty/native interface stub is not a simulation implementation: ' + block.name)
    return instances


def source_contract(block, identifiers):
    """Build the explicit interface/structure contract used by reviewed bindings."""
    counts = _identifiers(block)
    return {'body_statements': len(block.statements) - 2, 'instances': _instances(block),
            'alias_count': len(identifiers), 'identifier_counts': {name: counts[name] for name in identifiers},
            'indexed_identifiers': sorted(name for name in counts if INDEXED.fullmatch(name))}


def _rewrite(block, binding):
    aliases = binding['identifiers']
    statements = []
    for statement in block.statements:
        statements.append(IDENTIFIER.sub(lambda match: aliases.get(match[0], match[0])
                                        if not match[0].startswith('"') else match[0], statement))
    statements[0] = 'subckt ' + binding['target_subcircuit'] + ' ' + ' '.join(binding['target_ports'])
    statements[-1] = 'ends ' + binding['target_subcircuit']
    return Block(binding['target_subcircuit'], tuple(binding['target_ports']), tuple(statements), 0, 0)


def _equivalent(left, right, mode):
    if mode == 'tokens':
        return block_tokens(left) == block_tokens(right)
    return (TOKENS.findall(left.statements[0]) == TOKENS.findall(right.statements[0])
            and left.statements[-1] == right.statements[-1]
            and Counter(tuple(TOKENS.findall(line)) for line in left.statements[1:-1])
            == Counter(tuple(TOKENS.findall(line)) for line in right.statements[1:-1]))


def load_bindings(raw):
    value = _json(_text(raw, 'bindings').encode('utf-8'))
    _keys(value, ['schema', 'library_id', 'cell_id', 'targets', 'subcircuits']
          + (['electrical_guards'] if isinstance(value, dict) and 'electrical_guards' in value else []), 'bindings')
    _require(value['schema'] == SCHEMA, 'unknown bindings schema')
    _require(all(isinstance(value[key], str) and re.fullmatch(r'[A-Za-z0-9_-]+', value[key])
                 for key in ('library_id', 'cell_id')), 'invalid library/cell identity')
    if 'electrical_guards' in value:
        guards = value['electrical_guards']
        _require(isinstance(guards, list) and 1 <= len(guards) <= 32, 'invalid electrical guards')
        guarded = set()
        for guard in guards:
            _keys(guard, ['source', 'source_sha256', 'electrical_sha256'], 'electrical guard')
            path = _path(guard['source'])
            _require(path.startswith('lib/' + value['library_id'] + '/' + value['cell_id'] + '/')
                     and '/simulation/' not in path and path.endswith('.scs'), 'guard must belong to this native testbench')
            _require(path not in guarded, 'duplicate electrical guard source')
            guarded.add(path)
            _require(all(isinstance(guard[key], str) and SHA.fullmatch(guard[key])
                         for key in ('source_sha256', 'electrical_sha256')), 'invalid electrical guard hash')
    _require(isinstance(value['targets'], dict) and 1 <= len(value['targets']) <= 32, 'invalid targets')
    for name, target in value['targets'].items():
        _require(isinstance(name, str) and NAME.fullmatch(name), 'invalid configuration identity')
        _keys(target, ['template_source', 'template_sha256', 'destination'], 'target')
        _path(target['template_source']); _path(target['destination'], repository=False)
        _require(isinstance(target['template_sha256'], str) and SHA.fullmatch(target['template_sha256']), 'invalid template hash')
    rows = value['subcircuits']
    _require(isinstance(rows, list) and 1 <= len(rows) <= MAX_BLOCKS, 'invalid subcircuit bindings')
    targets, sources = set(), set()
    for row in rows:
        _keys(row, ['target_subcircuit', 'source', 'source_subcircuit', 'source_ports', 'target_ports',
                    'identifiers', 'contract', 'baseline'], 'subcircuit binding')
        _path(row['source'])
        _require(row['source'].startswith('lib/' + value['library_id'] + '/')
                 and '/simulation/' not in row['source'], 'canonical source must belong to this native library')
        for name in ('target_subcircuit', 'source_subcircuit'):
            _require(isinstance(row[name], str) and NAME.fullmatch(row[name]), 'invalid subcircuit name')
        _require(row['source_subcircuit'] == row['target_subcircuit'], 'v1 does not rename subcircuits or implicit child-master references')
        identity = row['source'], row['source_subcircuit']
        _require(row['target_subcircuit'] not in targets and identity not in sources, 'duplicate binding identity')
        targets.add(row['target_subcircuit']); sources.add(identity)
        _strings(row['source_ports'], 'source ports'); _strings(row['target_ports'], 'target ports')
        aliases = row['identifiers']
        _require(isinstance(aliases, dict) and len(aliases) <= 8192, 'invalid identifier map')
        _require(all(isinstance(native, str) and isinstance(compiled, str) for native, compiled in aliases.items()), 'identifier map must contain strings')
        _require(len(set(aliases.values())) == len(aliases), 'identifier map must be bijective')
        for native, compiled in aliases.items():
            _require(isinstance(native, str) and isinstance(compiled, str), 'identifier map must contain strings')
            bus = BUS.fullmatch(compiled)
            _require(bus and native == bus[1] + '_' + bus[2], 'identifier map is not an explicitly named bus mapping')
        _require([aliases.get(port, port) for port in row['source_ports']] == row['target_ports'], 'bound port mapping/order differs')
        contract = row['contract']
        _keys(contract, ['body_statements', 'instances', 'alias_count', 'identifier_counts', 'indexed_identifiers'], 'source contract')
        _require(type(contract['body_statements']) is int and 0 < contract['body_statements'] <= 100000
                 and type(contract['alias_count']) is int and contract['alias_count'] == len(aliases), 'body or alias count differs')
        _require(isinstance(contract['identifier_counts'], dict) and set(contract['identifier_counts']) == set(aliases)
                 and all(type(count) is int and count > 0 for count in contract['identifier_counts'].values()), 'invalid alias occurrence contract')
        _require(isinstance(contract['indexed_identifiers'], list)
                 and all(isinstance(name, str) and INDEXED.fullmatch(name) for name in contract['indexed_identifiers'])
                 and len(contract['indexed_identifiers']) <= 8192
                 and len(contract['indexed_identifiers']) == len(set(contract['indexed_identifiers'])), 'invalid indexed identifier inventory')
        _require(isinstance(contract['instances'], dict) and contract['instances'], 'missing instance contract')
        for signature in contract['instances'].values():
            _keys(signature, ['master', 'terminals'], 'instance contract')
            _require(isinstance(signature['master'], str) and NAME.fullmatch(signature['master'])
                     and type(signature['terminals']) is int and 0 < signature['terminals'] <= 8192, 'invalid instance contract')
        baseline = row['baseline']
        _keys(baseline, ['source_sha256', 'electrical_sha256', 'template_electrical_sha256', 'equivalence'], 'baseline')
        _require(all(isinstance(baseline[name], str) and SHA.fullmatch(baseline[name])
                     for name in ('source_sha256', 'electrical_sha256', 'template_electrical_sha256'))
                 and baseline['equivalence'] in ('tokens', 'statements'), 'invalid baseline evidence')
    return value


def compile_sources(bindings_path, configuration, commit, read_blob, out, overrides=None):
    """Derive one staged target from committed canonical sources without I/O writes.

    Values and compatible scalar connections may change in canonical sources.
    Port order, indexed aliases, instance names/masters/pin counts and statement
    counts are explicit contracts; edits to them fail until bindings are updated.
    Baseline electrical equality is verified whenever original source bytes are
    compiled. Changed sources are never silently replaced by historical content.
    Optional testbench guards reject electrical edits to an uncompiled top level;
    drawing/comment edits remain allowed and their source hashes are recorded.
    """
    _path(bindings_path)
    _require(isinstance(commit, str) and re.fullmatch(r'[a-f0-9]{40}', commit), 'source commit must be pinned')
    _require(isinstance(out, dict), 'staged outputs must be a mapping')
    raw_bindings = read_blob(commit, bindings_path, overrides)
    bindings = load_bindings(raw_bindings)
    _require(configuration in bindings['targets'], 'configuration has no explicit canonical bindings')
    target = bindings['targets'][configuration]
    template = read_blob(commit, target['template_source'], None)
    _require(digest(template) == target['template_sha256'], 'historical template hash differs')
    destination = target['destination']
    _require(destination in out and out[destination] == template, 'staged template differs; canonical source authority cannot be bypassed')
    text = _text(template, 'template')
    original = electrical_blocks(template)
    _require(set(original) == {row['target_subcircuit'] for row in bindings['subcircuits']}, 'template/binding subcircuit coverage differs')
    sources = {bindings_path: digest(raw_bindings), target['template_source']: digest(template)}
    inputs, replacements, reports, guard_reports = {}, [], [], []
    for guard in bindings.get('electrical_guards', []):
        path = guard['source']
        inputs[path] = read_blob(commit, path, overrides)
        sources[path] = digest(inputs[path])
        observed = electrical_hash(inputs[path])
        _require(observed == guard['electrical_sha256'],
                 'testbench electrical source changed: ' + path
                 + '; update explicit TB binding and input template before materializing')
        guard_reports.append({'source': path, 'source_sha256': sources[path],
                              'electrical_sha256': observed, 'electrical_unchanged': True,
                              'non_electrical_modified': sources[path] != guard['source_sha256']})
    bound_ports = {row['source_subcircuit']: len(row['source_ports']) for row in bindings['subcircuits']}
    for row in bindings['subcircuits']:
        path = row['source']
        if path not in inputs:
            inputs[path] = read_blob(commit, path, overrides)
            sources[path] = digest(inputs[path])
        parsed = electrical_blocks(inputs[path])
        _require(row['source_subcircuit'] in parsed, 'canonical subcircuit is missing: ' + row['source_subcircuit'])
        block = parsed[row['source_subcircuit']]
        _require(list(block.ports) == row['source_ports'], 'source port count/order changed: ' + block.name)
        contract = source_contract(block, row['identifiers'])
        _require(contract == row['contract'], 'body/instance/indexed-alias contract changed: ' + block.name + '; update explicit source bindings')
        counts = _identifiers(block)
        _require(not any(BUS.fullmatch(name) for name in counts), 'undeclared native bus spelling: ' + block.name)
        for signature in contract['instances'].values():
            master = signature['master']
            _require(master not in bound_ports or signature['terminals'] == bound_ports[master], 'child subcircuit terminal count differs: ' + master)
        compiled = _rewrite(block, row)
        before = original[row['target_subcircuit']]
        _require(list(before.ports) == row['target_ports'] and block_hash(before) == row['baseline']['template_electrical_sha256'], 'template electrical block differs: ' + before.name)
        baseline = sources[path] == row['baseline']['source_sha256']
        if baseline:
            _require(block_hash(block) == row['baseline']['electrical_sha256']
                     and _equivalent(compiled, before, row['baseline']['equivalence']), 'initial canonical/template electrical comparison failed: ' + block.name)
        replacement = '\n'.join(compiled.statements) + '\n'
        replacements.append((before.start, before.end, replacement))
        reports.append({'subcircuit': before.name, 'source': path, 'source_sha256': sources[path],
                        'electrical_sha256': block_hash(compiled), 'baseline_equivalent': True if baseline else None,
                        'canonical_modified': not baseline, 'aliases': len(row['identifiers'])})
    for first, last, replacement in sorted(replacements, reverse=True):
        text = text[:first] + replacement + text[last:]
    compiled_bytes = text.encode('utf-8')
    compiled_blocks = electrical_blocks(compiled_bytes)
    _require(set(compiled_blocks) == set(original), 'compiled block coverage differs')
    new_out = dict(out)
    new_out[destination] = compiled_bytes
    report = {'schema': 'circuitgit.library-source-compilation.v1', 'configuration': configuration,
              'bindings_path': bindings_path, 'bindings_sha256': digest(raw_bindings),
              'destination': destination, 'compiled_sha256': digest(compiled_bytes),
              'source_commit': commit, 'subcircuits': reports, 'simulation_started': False}
    if 'electrical_guards' in bindings:
        report['electrical_guards'] = guard_reports
    return new_out, sources, report
