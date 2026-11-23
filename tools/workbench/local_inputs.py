"""Validate a compiled source closure without resolving remote model paths."""
import posixpath
import re

import ic_sim as core


def validate(bundle, files):
    if not isinstance(bundle, dict) or bundle.get('schema') != 'ic.sim.bundle.v1':
        raise ValueError('Wrong compiled bundle schema')
    if not isinstance(files, dict) or not 1 <= len(files) <= 4096:
        raise ValueError('Invalid compiled source inventory')
    entry = core.relpath(bundle['entrypoint'])
    inventory = {}
    for row in bundle['files']:
        name = core.relpath(row['destination'])
        if name in inventory or row.get('source') != name:
            raise ValueError('Compiled files require unique staged source names')
        inventory[name] = row['sha256']
    if set(inventory) != set(files) or entry not in files:
        raise ValueError('Compiled source inventory or entrypoint mismatch')
    pins = core.external_pins(bundle)
    if any(not re.fullmatch(r'[A-Z0-9_]+', name) or not isinstance(value, str)
           or not re.fullmatch(r'[a-f0-9]{64}', value) for name, value in pins.items()):
        raise ValueError('Invalid external model hash pin')
    aliases, edges, total = set(), {}, 0
    for name, raw in files.items():
        core.relpath(name)
        if not isinstance(raw, bytes) or core.sha(raw) != inventory[name]:
            raise ValueError('Compiled source hash mismatch: ' + name)
        total += len(raw)
        if len(raw) > 2 * 1024 * 1024 or total > 100 * 1024 * 1024:
            raise ValueError('Compiled source exceeds limits')
        text = raw.decode('utf-8')
        if '\x00' in text or '@EXTERNAL_' in core.TOKEN.sub('', text):
            raise ValueError('Invalid compiled source or external placeholder: ' + name)
        aliases.update(core.TOKEN.findall(text))
        for ref in re.findall(r'^\s*(?:include|ahdl_include|`include)\s+"([^"\n]+)"', text, re.M):
            if core.TOKEN.fullmatch(ref) or ref in ('constants.vams', 'disciplines.vams'):
                continue
            # Keep the runner's portable include subset; no PDK path is invented.
            relative = core.relpath(ref)
            if ref.startswith('/'):
                raise ValueError('Use an explicit remote model alias: ' + name)
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), relative))
            if target not in files:
                raise ValueError('Unstaged include in ' + name + ': ' + ref)
            edges.setdefault(name, []).append(target)
    done = set()
    def visit(name, active):
        if name in active or len(active) >= 64:
            raise ValueError('Cyclic or excessive compiled include hierarchy')
        if name in done:
            return
        for target in edges.get(name, []):
            visit(target, active | {name})
        done.add(name)
    for name in files:
        visit(name, set())
    return {'check_kind': 'source-check', 'source_closure_valid': True,
            'simulation_started': False, 'remote_models_checked': False,
            'required_remote_aliases': sorted(aliases),
            'unpinned_remote_aliases': sorted(aliases - set(pins))}
