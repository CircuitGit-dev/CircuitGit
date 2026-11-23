#!/usr/bin/env python3
"""Register the existing RC example without making another electrical source copy."""
import argparse
import json
from import_adc import ROOT, PUBLIC_DOCS, audit, digest, dump, write


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    source = 'projects/rc-smoke/circuit.scs'
    configuration = 'projects/rc-smoke/configurations/TRAN.json'
    template = 'projects/rc-smoke/template/bundle.json'
    project = 'projects/rc-smoke/project.json'
    input_file = 'projects/rc-smoke/template/netlist/input.scs'
    files = [source, configuration, template, project, input_file]
    rows = []
    for name in files:
        path = ROOT / name
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
            raise ValueError('RC source must be a regular repository file')
        raw = path.read_bytes()
        audit(raw, name)
        rows.append({'path': name, 'sha256': digest(raw), 'bytes': len(raw)})
    bundle = json.loads((ROOT / template).read_text())
    if bundle['files'][0]['sha256'] != digest((ROOT / input_file).read_bytes()):
        raise ValueError('RC template pin mismatch')
    directory = 'lib/basics/rc-smoke'
    readme = directory + '/README.md'
    provenance = directory + '/docs/provenance.json'
    write(ROOT / readme, b'''# R/C Spectre smoke

Primitive-only 1 kohm / 1 pF transient example. The source and TRAN configuration remain in `projects/rc-smoke`; this catalog does not create a second editable netlist.

The registered project is `rc-smoke`. A licensed, configured Spectre environment and the normal submission review are still required to execute it. No simulation is performed by the library importer, and RC analytical demo waveforms are not ADC results.

Available views are source text, simulation inputs and documentation. This RC entry has no imported native Virtuoso drawing or layout. `docs/provenance.json` hashes the referenced repository sources at inventory generation time; changes require refreshing this inventory.
''', args.check)
    write(ROOT / provenance, dump({'schema': 'circuitgit.reference-inventory.v1', 'project_id': 'rc-smoke',
          'electrical_sources_duplicated': False, 'simulation_performed': False, 'files': rows}), args.check)
    cell = {'id': 'rc-smoke', 'name': 'RC smoke', 'description': 'Primitive RC transient example; existing source and TRAN configuration.',
            'kind': 'testbench', 'directory': directory, 'readme': readme, 'project_id': 'rc-smoke',
            'requires_external_models': False, 'views': [
                {'id': 'netlist', 'label': 'Spectre source', 'kind': 'spectre', 'entry': source, 'files': [source]},
                {'id': 'simulation', 'label': 'TRAN configuration', 'kind': 'json', 'entry': configuration, 'files': files},
                {'id': 'docs', 'label': 'Evidence and dependencies', 'kind': 'markdown', 'entry': readme,
                 'files': [readme, provenance, *PUBLIC_DOCS]}]}
    plan = json.loads((ROOT / 'tools/library/adc-import-plan.json').read_text())
    info = next(x for x in plan['additional_libraries'] if x['id'] == 'basics')
    write(ROOT / 'lib/basics/library.json', dump({'schema': 'circuitgit.library.v1', **info, 'cells': [cell]}), args.check)
    print(json.dumps({'status': 'verified' if args.check else 'registered', 'library': 'basics', 'cells': 1,
                      'referenced_files': len(files), 'network_calls': 0, 'simulation_calls': 0}))


if __name__ == '__main__':
    main()
