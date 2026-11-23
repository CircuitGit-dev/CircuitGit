#!/usr/bin/env python3
"""Finite circuit source checks. This program never invokes a simulator."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import sys

TRUSTED = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(TRUSTED / 'tools/dev'))
sys.path.insert(0, str(TRUSTED / 'tools/workbench'))
from build_library import collect, path_at
from configuration import load_configuration

ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')
DEFAULT_TB = 'rc-smoke-tran-source'


def require(value, message):
    if not value: raise ValueError(message)


def read_json(path, limit=1024 * 1024):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit, 'Missing/unsafe/oversized JSON: ' + path.name)
    def unique(pairs):
        out = {}
        for key, value in pairs:
            require(key not in out, 'Duplicate JSON key: ' + key); out[key] = value
        return out
    return json.loads(path.read_text(), object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


def registry(path):
    data = read_json(path)
    require(isinstance(data, dict) and isinstance(data.get('testbenches'), list) and len(data['testbenches']) <= 1000, 'Invalid testbench registry')
    result = {}
    for row in data['testbenches']:
        require(isinstance(row, dict) and all(isinstance(row.get(k), str) and ID.fullmatch(row[k]) for k in ('id', 'library_id', 'cell_id')), 'Invalid testbench identity')
        require(row['id'] not in result and row.get('engine') in ('source-check', 'spectre'), 'Duplicate or unsupported testbench')
        require(isinstance(row.get('workflow_path'), str) and re.fullmatch(r'\.github/workflows/[A-Za-z0-9_-]+\.ya?ml', row['workflow_path']), 'Invalid workflow path')
        require(isinstance(row.get('configuration_path'), str), 'Missing configuration path')
        result[row['id']] = row
    return result


def changed_paths(root, base, head):
    require(not base or head, '--base requires --head')
    if not head: return None
    require(SHA.fullmatch(head) and (not base or SHA.fullmatch(base)), 'Base/head must be full lowercase commit SHAs')
    def git(*args):
        p = subprocess.run(['git', '-C', str(root), *args], capture_output=True, check=False, timeout=30)
        require(p.returncode == 0 and len(p.stdout) <= 2 * 1024 * 1024, 'Git source identity/diff check failed')
        return p.stdout
    require(git('rev-parse', '--verify', 'HEAD').decode().strip() == head, 'Checked-out HEAD differs from requested head')
    require(not git('status', '--porcelain', '--untracked-files=all', '--', 'lib', 'projects', 'config/library-testbenches.json'), 'Circuit input checkout has uncommitted changes')
    if not base or base == '0' * 40: return None
    return set(git('diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, head, '--').decode().split('\0')) - {''}


def cell_index(root):
    catalog = read_json(root / 'lib/catalog.json')
    return {(library['id'], cell['id']): cell for library in catalog['libraries']
            for cell in read_json(path_at(root, library['manifest']))['cells']}


def selections(root, cells, benches):
    selected, states = [], []
    for identity, cell in cells.items():
        name = cell['directory'] + '/ci.json'; path = root / name
        if path.exists() or path.is_symlink():
            path_at(root, name); cfg = read_json(path)
            require(isinstance(cfg, dict) and set(cfg) == {'schema', 'library_id', 'cell_id', 'enabled', 'testbench_ids'}
                    and cfg['schema'] == 'circuitgit.cell-ci.v1' and (cfg['library_id'], cfg['cell_id']) == identity
                    and type(cfg['enabled']) is bool and isinstance(cfg['testbench_ids'], list)
                    and len(cfg['testbench_ids']) <= 32 and all(isinstance(x, str) for x in cfg['testbench_ids'])
                    and len(set(cfg['testbench_ids'])) == len(cfg['testbench_ids']), 'Invalid cell CI selection: ' + name)
            require(not cfg['enabled'] or cfg['testbench_ids'], 'Enabled cell CI needs a testbench: ' + name)
            require(all(tid in benches and (benches[tid]['library_id'], benches[tid]['cell_id']) == identity
                        for tid in cfg['testbench_ids']), 'Unknown or cross-cell testbench: ' + name)
            tids = cfg['testbench_ids'] if cfg['enabled'] else []
            states.append({'library_id': identity[0], 'cell_id': identity[1], 'path': name, 'enabled': cfg['enabled'], 'testbench_ids': tids,
                           'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'selection_source': 'cell_ci'})
        else:
            tids = [DEFAULT_TB] if identity == ('basics', 'rc-smoke') and DEFAULT_TB in benches else []
            states.append({'library_id': identity[0], 'cell_id': identity[1], 'enabled': bool(tids), 'testbench_ids': tids,
                           'selection_source': 'rc_source_default' if tids else 'not_configured'})
        selected.extend(tids)
    return selected, states


def closure(root, files):
    allowed = set(files); external = set(); edges = {}
    for name in allowed:
        path = path_at(root, name)
        if path.suffix not in ('.scs', '.va', '.v', '.rnl'): continue
        text = path.read_text(); require('\x00' not in text, 'NUL in circuit source: ' + name)
        refs = re.findall(r'^\s*(?:include|ahdl_include|`include)\s+"([^"\n]+)"', text, re.M)
        refs += re.findall(r'@USE-PACKAGE\([^\n]*?\bpath\s*=\s*"([^"\n]+)"', text)
        for ref in refs:
            if re.fullmatch(r'@EXTERNAL_[A-Z0-9_]+@', ref) or ref in ('constants.vams', 'disciplines.vams'):
                external.add(ref); continue
            require(not ref.startswith('/') and not any(c in ref for c in '\\:$%'), 'Nonportable include in ' + name)
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), ref))
            require(target in allowed, 'Missing include/package from declared view closure: ' + name + ' -> ' + ref)
            edges.setdefault(name, []).append(target)
    def visit(name, active, done):
        require(name not in active and len(active) < 64, 'Cyclic/excessive include hierarchy: ' + name)
        if name in done: return
        for target in edges.get(name, []): visit(target, active | {name}, done)
        done.add(name)
    done = set()
    for name in edges: visit(name, set(), done)
    return sorted(external)


def run(root, registry_path=None, base=None, head=None):
    root = Path(root).resolve(); paths = changed_paths(root, base, head)
    inventory = collect(root)
    require(inventory['libraries'] > 0, 'Library catalog is missing')
    cells = cell_index(root); benches = registry(Path(registry_path or TRUSTED / 'config/library-testbenches.json'))
    for row in benches.values():
        identity = (row['library_id'], row['cell_id'])
        require(identity in cells, 'Registered testbench has no library cell: ' + row['id'])
        path_at(root, row['configuration_path'])
        allowed = {name for view in cells[identity]['views'] for name in view['files']}
        require(row['configuration_path'] in allowed, 'Testbench configuration not declared in its cell: ' + row['id'])
    chosen, states = selections(root, cells, benches)
    global_change = paths is None or any(p in ('lib/catalog.json', 'config/library-testbenches.json') or p.endswith('/library.json')
                                        or p.startswith(('tools/ci/', '.github/workflows/circuit-')) for p in paths)
    affected = {identity for identity, cell in cells.items() if global_change or
                any(p.startswith(cell['directory'] + '/') or p in {name for v in cell['views'] for name in v['files']} for p in paths)}
    report = {'schema': 'circuitgit.circuit-ci.v1', 'check_kind': 'source-check', 'status': 'passed',
              'source_commit': head, 'base_commit': base, 'simulation_started': False,
              'changed_paths': sorted(paths) if paths is not None else None, 'libraries': inventory['libraries'],
              'cells': inventory['cells'], 'selections': states, 'testbenches': [], 'rnl_views': [], 'errors': []}
    for identity in sorted(affected):
        cell = cells[identity]
        for view in cell['views']:
            if view['kind'] not in ('rnl', 'spectre'): continue
            try:
                closure(root, view['files'])
                if view['kind'] == 'rnl': report['rnl_views'].append({'library_id': identity[0], 'cell_id': identity[1], 'view_id': view['id'],
                    'entry': view['entry'], 'level': view.get('level'), 'files': view['files']})
            except ValueError as error: report['errors'].append(str(error))
    for tid in chosen:
        row = benches[tid]; identity = (row['library_id'], row['cell_id'])
        if identity not in affected: continue
        result = {'id': tid, 'engine': row['engine'], 'library_id': identity[0], 'cell_id': identity[1], 'status': 'passed',
                  'configuration_path': row['configuration_path'], 'check_kind': 'source-check', 'simulation_started': False,
                  'simulation_status': 'not_run', 'external_dependencies': [], 'limitations': []}
        try:
            raw = path_at(root, row['configuration_path']).read_bytes(); conf = load_configuration(raw)
            require(isinstance(conf.get('simulator'), dict) and isinstance(conf['simulator'].get('profile'), str), 'Simulator profile required')
            require(isinstance(conf['simulator'].get('args', []), list) and all(isinstance(x, str) for x in conf['simulator'].get('args', [])), 'Simulator args must be strings')
            result['configuration_sha256'] = hashlib.sha256(raw).hexdigest()
            views = [v for v in cells[identity]['views'] if row['configuration_path'] in v['files']]
            files = sorted({p for v in views for p in v['files']})
            result['external_dependencies'] = closure(root, files)
            result['input_hashes'] = {p: hashlib.sha256(path_at(root, p).read_bytes()).hexdigest() for p in files}
            if row.get('requires_external_models') or result['external_dependencies']:
                result['simulation_status'] = 'blocked_external_models'
                result['limitations'].append('Licensed external models are not included; source-check success is not a simulation result.')
            if row['engine'] == 'spectre':
                result['limitations'].append('Spectre execution requires the separate protected manual workflow and engineering approval.')
                if not any(PurePosixPath(p).name == 'bundle.json' for p in files):
                    result['limitations'].append('Only historical settings are published; no replayable bundle is registered.')
        except (ValueError, OSError, KeyError) as error:
            result['status'] = 'failed'; result['error'] = str(error)
        report['testbenches'].append(result)
    if report['errors'] or any(t['status'] == 'failed' for t in report['testbenches']): report['status'] = 'failed'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True); parser.add_argument('--registry', type=Path)
    parser.add_argument('--base'); parser.add_argument('--head'); parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    try: report = run(args.root, args.registry, args.base, args.head)
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        report = {'schema': 'circuitgit.circuit-ci.v1', 'check_kind': 'source-check', 'status': 'failed',
                  'source_commit': args.head, 'simulation_started': False, 'errors': [str(error)], 'testbenches': [], 'rnl_views': []}
    args.report.parent.mkdir(parents=True, exist_ok=True); args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'check_kind': 'source-check', 'testbenches': len(report['testbenches']), 'simulation_started': False}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__': raise SystemExit(main())
