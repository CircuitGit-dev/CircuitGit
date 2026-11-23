#!/usr/bin/env python3
"""Build a bounded evidence inventory, without copying private source documents."""
import argparse
import json
from pathlib import Path
from import_adc import ROOT, digest, dump, write

OBSERVED = '2026-11-23'
# This is a reviewed source list, not a recursive publication rule.
VARIANTS = [
    ('pipetisar-ideal-and-switch', '1 GS/s ideal/relay-switch PIPE-TI-SAR', 'native_snapshot_partial',
     ['pipetisar-research/PIPE_TOP_F4_TI2_S9', 'pipetisar-research/TB_PIPE_TOP_1G'],
     ['docs/pipetisar-validation-20261020.md', 'docs/pipetisar-switch-spectrum-20261021.md'],
     'Historical ideal/switch variants appear in the research snapshot. Saved geometry is not a claim that every historical run or later live edit is included.'),
    ('pipetisar-real-sar-oct23', 'Earlier actual-SAR integration', 'native_snapshot_partial',
     ['pipetisar-research/PIPE_TOP_F4_TI2_RS9', 'pipetisar-research/TB_PIPE_RS9_1G'],
     ['docs/pipetisar-real-sar-20261023.md', 'docs/pipetisar-sar-fft-results-20261023.md'],
     'Earlier topology is kept distinct from the November real-SAR version; no simulation archive is published by this import.'),
    ('pipetisar-real-sar-nov06', '1 GS/s real-SAR integration, November 6', 'native_snapshot_partial',
     ['pipetisar-real/TB_PIPE_RS9_N06', 'pipetisar-real/PIPE_TOP_F4_RS9_N06'],
     ['docs/pipetisar-real-sar-20261106.md'],
     '22 canonical native views overlap source identities in the 64-entry research library. Ideal OTA and other behavioral dependencies remain; short historical functional results are not signoff.'),
    ('pipetisar-cap-array-nov06', 'Capacitor-array MDAC candidate, November 6', 'native_snapshot_partial',
     ['pipetisar-research/MDAC4_ARRAY_G8_N06', 'pipetisar-research/TB_MDAC_CA4_N06', 'pipetisar-research/TB_PIPE_CA4_RS9_N06'],
     ['docs/pipetisar-mdac-array-20261106.md'],
     'Native candidate schematics are included. The historical unit-MDAC result does not establish full-ADC precision; the documented LOW test failed its predefined two-LSB functional bound.'),
    ('flash-and-buffer-research', 'Flash, buffer and amplifier research testbenches', 'native_snapshot_partial',
     ['pipetisar-research/TB_Flash4_Codes_1G', 'pipetisar-research/TB_FlashComp_NoiseReplay', 'pipetisar-research/Buffer_Main', 'pipetisar-research/Amplifier_Main'],
     ['docs/flash4-research-20261020.md', 'docs/flash-research-simulation-20261019.md'],
     'Research exports cover the saved cells; replay-labelled testbench names alone do not supply replay configuration or measured data.'),
    ('tha-10g-oct27', '4x4 10 GS/s THA', 'native_geometry_not_exported', [],
     ['docs/tha-4x4-10g-20261027.md', 'docs/tha-4x4-10g-results-20261027.md', 'outputs/adc/tha_4x4_10g_20261027/task_state.json'],
     'Local OA/readbacks, netlists and behavioral models exist, but there is no reviewed RNL export in this seed. Historical 10 GS/s baseline is superseded by the separate 12 GS/s task.'),
    ('tha-12g-oct27', '4x4 12 GS/s THA, compact schematic', 'native_geometry_not_exported', [],
     ['docs/tha-12g-compact-20261027.md', 'outputs/adc/tha_12g_compact_20261027/task_state.json', 'outputs/adc/tha_12g_compact_20261027/netlists/simulated_THA_LOW.scs', 'outputs/adc/tha_12g_compact_20261027/backup/THA_BUF_DIFF_VA/veriloga/veriloga.va'],
     'Library 2026_PIPETISAR_RESEARCH2 retains THA_4X4_10G / TB_THA_4X4_10G names at 12 GS/s. OA/readbacks and behavioral deck exist; no native geometry import or registered replay is supplied here.'),
    ('tha-user-tb-oct29', 'User revised THA coherent-sampling testbench', 'later_user_state_not_exported', [],
     ['docs/tha-user-tb-convention-20261029.md', 'outputs/adc/tha_user_update_20261029/THA_BUF_DIFF_VA.va'],
     'User Fs/cycle/N edits postdate the October 27 decks. Importing those older decks would not reconstruct the current user testbench; no new simulation is claimed.'),
    ('tha-reconstruction-oct29', 'THA voltage-sequence FFT reconstruction', 'analysis_only', [],
     ['docs/tha-interleave-fft-20261029.md'],
     'Reconstruction concerns behavioral held-voltage samples, not quantized ADC output codes. It is not a separate ADC schematic or a new simulation.'),
    ('pipeline-4g12b-nov20', '2024_Pipeline_Copy 3/4 GS/s Pipeline-SAR variants', 'report_only_no_pinned_native_export', [],
     ['outputs/ADC_4G12B_Design_and_Simulation_Report.html'],
     'Local November 20 report names TB_ADC_core and TB_ADC_core_ideal_amp plus comparator-reset and bandwidth/gain variants. Bounded local search found report/figures, not a pinned native schematic closure or complete replay archive. Private report paths and unverified performance generalizations are not copied.'),
    ('floating-sf-nov12', 'Floating source-follower research', 'research_notes_only', [],
     ['outputs/floating_sf_power_20261112.html'],
     'Local report and research notes are not an exported ADC library, layout or executable design bundle.'),
    ('matlab-adc-archive', 'ADC analysis/calibration utilities', 'analysis_archive_not_circuit', [],
     ['ADC.zip'],
     'Archive has 83 members containing MATLAB analysis/calibration versions and an inner ZIP, not OA/schematic/layout data. Utility authorship/dependencies were not reviewed for redistribution, so the archive is not published.')
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True, help='Local LLM_for_IC checkout')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    plan = json.loads((ROOT / 'tools/library/adc-import-plan.json').read_text())
    native = [c for library in plan['libraries'] for c in library['cells']]
    published = {library['id'] + '/' + c['id'] for library in plan['libraries'] for c in library['cells']}
    variants = []
    for vid, name, status, cells, sources, note in VARIANTS:
        if any(c not in published for c in cells):
            raise ValueError('Variant refers to a missing published cell')
        evidence = []
        for source in sources:
            path = args.source_root / source
            if path.is_symlink() or not path.resolve().is_relative_to(args.source_root.resolve()):
                raise ValueError('Unsafe inventory source')
            raw = path.read_bytes()
            evidence.append({'source': source, 'sha256': digest(raw), 'bytes': len(raw), 'published': False})
        variants.append({'id': vid, 'name': name, 'status': status, 'published_cells': cells, 'note': note, 'source_evidence': evidence})
    excluded = [
        {'item': 'trans_ulvt_mac_pcell_0 standalone cell', 'reason': 'PDK implementation excluded; no standalone catalog entry.'},
        {'item': 'trans_ulvt_mac.scs original implementation', 'reason': 'Replaced in four canonical closures by an explicitly empty viewer-only six-terminal interface. Two internal MOS instance definitions are removed; source/output hashes are recorded.'},
        {'item': 'PDK/model cards, technology libraries and standard-cell implementations', 'reason': 'External dependencies, not redistributable circuit example content.'},
        {'item': 'OA binaries/backups, layout GDS/OASIS, DRC/LVS/PEX and ADE/Maestro state', 'reason': 'Not imported by the reviewed text-geometry snapshot plan; complete native archive/export still required.'},
        {'item': 'Raw source metadata/receipts, local machine paths, configuration, credentials and licenses', 'reason': 'Private runtime state is not public provenance. Public provenance is newly generated with relative identifiers and hashes.'},
        {'item': 'PSF, simulator caches, raw results and performance report HTML/images', 'reason': 'No complete audited source/configuration/results replay bundle is published by this import.'},
        {'item': 'Behavioral implementations missing from symbol views', 'reason': 'All10 native symbol entries provide icons only. The separate inactive real-SAR templates supply5 matching-name project VA files; PIPE_IdealSwitch, PIPE_Merge12, PIPE_SAR9_Timed, PIPE_ThermDAC4 and RS9_Interface behavior is not supplied by this release.'}
    ]
    libraries = [{'id': l['id'], 'entries': len(l['cells']), 'schematics': sum(not c['symbol_only'] for c in l['cells']),
                  'symbols_only': sum(c['symbol_only'] for c in l['cells'])} for l in plan['libraries']]
    report = {'schema': 'circuitgit.adc-inventory.v1', 'observed_on': OBSERVED,
              'scope': 'Pinned native seed and bounded local LLM_for_IC docs, named outputs/adc tasks, newer ADC report and ADC.zip inventory; no live server inspection.',
              'native_seed_entries': 97, 'published_adc_entries': len(native),
              'distinct_source_cell_views': len({json.dumps(c['source_cell'], sort_keys=True) for c in native}),
              'catalog_entries_including_rc': len(native) + 1, 'adc_runtime_projects_registered': 0,
              'new_simulations': 0, 'libraries': libraries, 'source_export_losses': plan['source_export_losses'],
              'variants': variants, 'exclusions': excluded,
              'simulation_candidates': [{'cell': c['cell'], 'test': c['test'], 'kind': c['kind'],
                  'directory': c['destination'], 'active': False}
                  for c in json.loads((ROOT / 'tools/library/simulation-import-plan.json').read_text())['candidates']],
              'next_exports': ['Current RESEARCH2 THA geometry plus updated user testbench state',
                               '2024_Pipeline_Copy current, baseline and ideal-amplifier variants with explicit source/version binding',
                               'User-owned OA/layout archive with PDK dependencies externalized and restoration/DRC/LVS/PEX evidence',
                               'Separately audited electrical replay configurations and matching result provenance']}
    write(ROOT / 'lib/inventory.json', dump(report), args.check)
    md = ['# ADC source coverage and remaining exports', '',
          'Observed 2026-11-23. This is a bounded local inventory, not a live Virtuoso survey. The 96 published ADC entries represent 74 distinct source library/cell/view identities: 86 schematic entries and 10 symbol-only entries. With the existing RC example the catalog has 97 entries in four libraries.', '',
          'The native import is a partial-fidelity viewer archive. No new ADC simulation, layout export or runtime project registration is claimed. Per-file source/output hashes are recorded in each cell; the machine-readable inventory also hashes the private evidence documents without publishing their contents.', '',
          '| Design or variant | Coverage | Evidence/limitation |', '| --- | --- | --- |']
    md += [f"| {v['name']} | `{v['status']}` | {v['note']} |" for v in variants]
    md += ['', '## Inactive historical simulation inputs', '',
           'Three existing testbench cells expose five configuration candidates. The real-SAR pair includes sanitized electrical templates with four external model aliases and five project Verilog-A models. The MDAC three provide configuration/audit records only. No ADC runtime project is registered; no template has been replayed by this migration.', '',
           '| Cell | Test | Available input |', '| --- | --- | --- |']
    md += [f"| `{c['cell']}` | `{c['test']}` | `{c['kind']}` |" for c in report['simulation_candidates']]
    md += ['', '## Exclusions', '']
    md += [f"- **{e['item']}**: {e['reason']}" for e in excluded]
    md += ['', '## Remaining migration work', '']
    md += [f'- {s}.' for s in report['next_exports']]
    md += ['', 'Current index entries do not prove current remote design state. No missing native view is replaced with inferred geometry or automatic routing. Source export losses (dynamic labels and unverified pin/font fidelity) remain explicit in each cell README and provenance.', '']
    write(ROOT / 'lib/INVENTORY.md', '\n'.join(md).encode(), args.check)
    print(json.dumps({'variants': len(variants), 'native_entries': len(native), 'exclusions': len(excluded), 'source_documents_copied': 0}))


if __name__ == '__main__':
    main()
