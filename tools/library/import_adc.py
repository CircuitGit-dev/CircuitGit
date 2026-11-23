#!/usr/bin/env python3
"""Deterministic allowlisted ADC import. No network, EDA, Git or application build."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
PLAN = Path(__file__).with_name('adc-import-plan.json')
ALLOWED_SUFFIXES = {'.scs', '.rnl'}
PRIVATE = re.compile(r'/(?:Users|home|mnt|proj|data|tmp|opt|tools)/|\b(?:ssh|scp)\s|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|(?:api[_-]?key|access_token|password)\s*[:=]', re.I)
MODEL = re.compile(r'^\s*(?:model|\.model|library|section|ahdl_include)\s', re.M | re.I)
EXTERNAL_DEF = re.compile(r'^\s*subckt\s+(\S*(?:BWP|CPD|trans_ulvt_mac_pcell)\S*)', re.M | re.I)
PUBLIC_DOCS = ['lib/README.md', 'lib/INVENTORY.md', 'lib/inventory.json',
               'lib/THIRD_PARTY_NOTICES.md', 'lib/licenses/CC0-1.0.txt', 'lib/validation/native-render.json']


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def relative(value):
    if not isinstance(value, str) or not value:
        raise ValueError('Unsafe relative path')
    p = Path(value)
    if p.is_absolute() or '\\' in value or ':' in value or any(x in ('', '.', '..') for x in value.split('/')):
        raise ValueError('Unsafe relative path')
    return p


def dump(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def write(path, raw, check=False):
    if not path.resolve().is_relative_to(ROOT.resolve()) or any(
            p.is_symlink() for p in [path, *path.parents] if p != ROOT and ROOT in p.parents):
        raise ValueError('Symlink output refused')
    if check:
        if not path.is_file() or path.read_bytes() != raw:
            raise ValueError('Generated file differs: ' + str(path.relative_to(ROOT)))
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)


def stub():
    return b'''// VIEWER-ONLY external interface. PDK implementation deliberately omitted.
// This empty declaration has no electrical behavior and must not be simulated.
simulator lang=spectre
subckt trans_ulvt_mac_pcell_0 A C CB Gb Pb Y
ends trans_ulvt_mac_pcell_0
'''


def audit(raw, path, interface=False):
    text = raw.decode('utf-8')
    if PRIVATE.search(text) or MODEL.search(text):
        raise ValueError('Private configuration or model card in ' + path)
    if not interface and EXTERNAL_DEF.search(text):
        raise ValueError('External implementation in ' + path)
    return text


def includes(text):
    names = re.findall(r'^\s*include\s+"([^"\n]+)"', text, re.M)
    for declaration in re.findall(r'@USE-PACKAGE\(([^)]*)\)', text):
        path = re.search(r'\bpath="([^"]+)"', declaration)
        name = re.search(r'\bname="([^"]+)"', declaration)
        if path:
            names.append(path.group(1))
        elif name:
            names.append(name.group(1) + '.rnl')
        else:
            raise ValueError('Unrecognized native package dependency')
    return names


def extract_external(texts):
    definitions = set()
    instances = set()
    for text in texts:
        text = re.sub(r'\\\s*\n\s*', ' ', text)
        definitions.update(re.findall(r'^\s*subckt\s+(\S+)', text, re.M | re.I))
        instances.update(re.findall(r'^\s*[A-Za-z][\w<>:.-]*\s*\([^\n)]*\)\s+([A-Za-z][\w.-]*)', text, re.M))
    primitives = {'resistor', 'capacitor', 'inductor', 'vsource', 'isource', 'vcvs', 'vccs', 'ccvs', 'cccs', 'relay', 'port', 'transformer', 'switch'}
    return sorted(instances - definitions - primitives)


def import_library(seed, plan, library, only_cell, check):
    records = []
    imported = []
    selected = [c for c in library['cells'] if not only_cell or c['id'] == only_cell]
    if not selected:
        raise ValueError('No cell matched requested library')
    for cell in selected:
        folder = Path('lib') / library['id'] / cell['id']
        view_id = 'symbol' if cell['symbol_only'] else 'schematic'
        destination = folder / view_id
        rows, texts, view_files = [], [], []
        for name in cell['files']:
            info = plan['files'][name]
            source = seed / relative(plan['source_root']) / relative(name)
            if source.is_symlink() or not source.resolve().is_relative_to(seed.resolve()) or source.suffix not in ALLOWED_SUFFIXES:
                raise ValueError('Source outside the allowlist')
            raw = source.read_bytes()
            if digest(raw) != info['sha256'] or len(raw) != info['bytes']:
                raise ValueError('Source pin changed: ' + name)
            transformed = name == 'trans_ulvt_mac.scs'
            out = stub() if transformed else raw
            texts.append(audit(out, name, interface=transformed))
            target = destination / relative(name)
            write(ROOT / target, out, check)
            view_files.append(target.as_posix())
            rows.append({'source': plan['source_root'] + '/' + name, 'source_sha256': info['sha256'],
                         'path': target.as_posix(), 'sha256': digest(out), 'bytes': len(out),
                         'transformation': 'external-interface-only; implementation omitted' if transformed else 'none'})
        # Relative includes stay exactly where the native exporter placed them.
        members = set(cell['files'])
        for name, text in zip(cell['files'], texts):
            for include in includes(text):
                local = (Path(name).parent / relative(include)).as_posix()
                if local not in members:
                    raise ValueError('Incomplete native include closure: ' + name + ' -> ' + include)
        external = extract_external(texts)
        omitted = any(row['transformation'] != 'none' for row in rows)
        requirements = bool(external or omitted or cell['symbol_only'])
        source_cell = cell['source_cell']
        description = ('Native symbol snapshot; no electrical implementation.' if cell['symbol_only'] else
                       'Preserved native schematic; external device models are not included.' if requirements else
                       'Preserved native schematic using simulator primitives; no replay configuration supplied.')
        provenance = {'schema': 'circuitgit.adc-import.v1', 'source_manifest': plan['source_manifest'],
                      'source_manifest_sha256': plan['source_manifest_sha256'], 'source_cell': source_cell,
                      'native_level': cell['native_level'], 'geometry': 'native positions, wires and user symbols preserved',
                      'export_fidelity': 'partial', 'source_export_losses': plan['source_export_losses'],
                      'viewer_only': True, 'simulation_replay': ('candidate inputs attached; external closure and replay unverified'
                          if cell.get('additional_views') else 'not packaged or verified'),
                      'external_master_references': external, 'external_interface_stub': omitted, 'files': rows}
        prov_path = folder / 'docs/provenance.json'
        write(ROOT / prov_path, dump(provenance), check)
        dependency_text = ', '.join('`' + x + '`' for x in external) or 'No unresolved instance masters detected by the bounded source scan.'
        readme = f'''# {cell['name']}

{description}

This is a **viewer-only** library snapshot. `project_id` is unset. There is no bundled runnable simulation configuration or ADC performance claim.

- Role: {cell['kind']}; source library `{source_cell['library']}`, cell `{source_cell['cell']}`, saved view `{source_cell['view']}`.
- Native view entry: `{view_id}/{cell['entry']}`; display level `{cell['native_level']}`. A cell assembly can have an empty file root; select the named level rather than auto-layout.
- Evidence: the manifest-pinned native export retains original placement, wire records and user-created symbols. Circuit definitions and export snapshots are not automatically synchronized.
- Export fidelity is partial: dynamic cdsParam/cdsTerm labels were omitted; physical-pin multiplicity and exact font/style fidelity are not fully verified. Preserving this export does not recover these losses or constitute an OpenAccess backup. See the source export losses in provenance.
- Dependency requirement: {'external models / omitted behavior required' if requirements else 'simulator primitives only in this closure; replay still unverified'}.
- External master references: {dependency_text}
- PDK/standard-cell implementations, model cards, process corners, local site settings and credentials are not included.
{('- An empty external transmission-gate interface replaces a removed PDK implementation. It has no electrical behavior; do not use it for simulation.' if omitted else '')}

The Spectre text within the RNL view preserves user-authored connectivity. External master names are references, not included third-party implementations. Missing simulation models do not authorize replacing this geometry with automatic wiring. Native symbol-only entries describe the saved icon, not executable behavior.

See `docs/provenance.json` for repository-relative source identifiers and before/after hashes. {'One implementation was replaced, so the closure is not byte-identical to its source.' if omitted else 'Every copied view member is byte-identical to the pinned source.'} Drawing support package attribution is in `lib/THIRD_PARTY_NOTICES.md`.
{('Historical simulation input candidates and their missing-dependency audit are available in `simulation/README.md`. They do not make this snapshot a runnable project or prove a source/run binding.' if cell.get('additional_views') else '')}
'''
        readme_path = folder / 'README.md'
        write(ROOT / readme_path, (readme.rstrip() + '\n').encode(), check)
        views = [{'id': view_id, 'label': 'Native symbol' if cell['symbol_only'] else 'Native schematic', 'kind': 'rnl',
                  'entry': (destination / cell['entry']).as_posix(), 'level': cell['native_level'], 'files': view_files},
                 {'id': 'docs', 'label': 'Evidence and dependencies', 'kind': 'markdown', 'entry': readme_path.as_posix(),
                  'files': [readme_path.as_posix(), prov_path.as_posix(), *PUBLIC_DOCS]}]
        views.extend(cell.get('additional_views', []))
        records.append({'id': cell['id'], 'name': cell['name'], 'description': description, 'kind': cell['kind'],
                        'directory': folder.as_posix(), 'readme': readme_path.as_posix(), 'project_id': None,
                        'requires_external_models': requirements, 'views': views})
        imported += rows
    manifest_path = ROOT / 'lib' / library['id'] / 'library.json'
    if only_cell and manifest_path.is_file():
        previous = json.loads(manifest_path.read_text())
        by_id = {c['id']: c for c in previous['cells']}
        by_id.update({c['id']: c for c in records})
        manifest_cells = [by_id[c['id']] for c in library['cells'] if c['id'] in by_id]
    else:
        manifest_cells = records
    manifest = {'schema': 'circuitgit.library.v1', **{k: library[k] for k in ('id', 'name', 'description')}, 'cells': manifest_cells}
    write(manifest_path, dump(manifest), check)
    return records, imported


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed-root', type=Path, required=True)
    parser.add_argument('--library')
    parser.add_argument('--cell')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.cell and not args.library:
        parser.error('--cell requires --library')
    plan = json.loads(PLAN.read_text())
    source_manifest = args.seed_root / relative(plan['source_manifest'])
    if digest(source_manifest.read_bytes()) != plan['source_manifest_sha256']:
        raise ValueError('Seed manifest does not match reviewed import plan')
    libraries = [x for x in plan['libraries'] if not args.library or x['id'] == args.library]
    if not libraries:
        raise ValueError('Unknown library')
    summary = []
    for library in libraries:
        cells, rows = import_library(args.seed_root, plan, library, args.cell, args.check)
        summary.append({'id': library['id'], 'cells': len(cells), 'view_files': len(rows), 'bytes': sum(r['bytes'] for r in rows)})
    # Index only reviewed library manifests that exist; never discover arbitrary folders.
    catalog = {'schema': 'circuitgit.libraries.v1', 'libraries': [
        {**{k: library[k] for k in ('id', 'name', 'description')}, 'manifest': 'lib/' + library['id'] + '/library.json'}
        for library in [*plan['libraries'], *plan.get('additional_libraries', [])]
        if (ROOT / 'lib' / library['id'] / 'library.json').is_file()]}
    write(ROOT / 'lib/catalog.json', dump(catalog), args.check)
    print(json.dumps({'status': 'verified' if args.check else 'imported', 'libraries': summary, 'network_calls': 0, 'simulation_calls': 0}))


if __name__ == '__main__':
    main()
