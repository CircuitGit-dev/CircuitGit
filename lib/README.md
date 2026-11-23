# CircuitGit circuit library

Browse `catalog.json` → library → cell → view. Each cell declares an explicit file closure and a README. Native RNL views carry `level`, copied from the exporter: a subcircuit assembly often has an empty file root, while `@top` selects a testbench. No automatic layout is used for these ADC views.

| Library | Entries | Available content |
| --- | ---: | --- |
| `pipetisar-real` | 22 | Canonical 2026-11-06 real-SAR integration native schematics |
| `pipetisar-research` | 64 | Research library: 54 schematics and 10 behavioral-cell symbols |
| `pipesar-original` | 10 | Original 9-bit SAR hierarchy native schematics |
| `basics` | 1 | Existing primitive RC netlist and simulation configuration |

The 96 ADC entries represent **74 distinct source library/cell/view identities**. The 22 canonical entries overlap the research source library, but are kept as separate historical snapshots because their exports/closures can differ. Counts are not 96 independent ADC designs. The original reviewed export contains 97 entries; the standalone PDK transmission-gate implementation is excluded.

Every ADC entry has `project_id: null` and is a **viewer snapshot**. Native coordinates, wires and user symbols from the saved export are retained. The export itself has known losses: dynamic parameter/terminal labels were omitted, and physical-pin multiplicity and exact font/style fidelity were not fully verified. This is not a complete Virtuoso/OpenAccess or layout backup.

PDK model cards, third-party standard-cell implementations, local site settings, credentials, OA locks, PSF data and simulation runtime caches are excluded. User circuit references to external masters remain references. Four canonical views depend on an **empty, non-simulatable transmission-gate interface** replacing the removed PDK implementation; the parent drawing is preserved. Each affected cell documents the transformation and original/output hashes. Do not simulate a drawing closure containing that interface.

The `basics/rc-smoke` entry references the existing `projects/rc-smoke` sources rather than duplicating editable electrical data. It has a real registered configuration; execution still needs the separately configured, licensed simulator and normal review workflow. Its demo waves do not validate an ADC.

Three ADC testbenches also have **inactive simulation input views**: real-SAR `TB_PIPE_RS9_N06` contains two sanitized historical templates and five project Verilog-A models; MDAC `TB_MDAC_CA4_N06` and `TB_PIPE_CA4_RS9_N06` contain three configuration/audit records. All require further dependency/replay review. PDK/standard-cell bodies stay external; no ADC runtime registration or performance result is added. These historical electrical templates are distinct from the native drawing closures.

See [inventory](INVENTORY.md) and [machine-readable inventory](inventory.json) for later THA and 4 GS/s design gaps, and [drawing dependency notices](THIRD_PARTY_NOTICES.md). [Native validation](validation/native-render.json) records offline rendering/source comparison; it is not a simulation report. No layout, DRC/LVS/PEX result, or new ADC performance result is supplied by this import.

Reproduce the native import using the reviewed seed checkout:

```sh
python3 -B tools/library/import_basics.py
python3 -B tools/library/inventory.py --source-root "$LLM_FOR_IC_CHECKOUT"
python3 -B tools/library/import_simulation.py --candidate-root "$REVIEWED_SIMULATION_CANDIDATES"
python3 -B tools/library/import_adc.py --seed-root "$SEED_CHECKOUT"
python3 -B tools/library/import_adc.py --seed-root "$SEED_CHECKOUT" --check
node tools/library/validate_native.mjs --seed-root "$SEED_CHECKOUT" --report lib/validation/native-render.json
python3 -B tools/dev/build_library.py
```

The three variables are operator-supplied local source roots. The native and simulation import plans pin every copied source member; `inventory.py` hashes a bounded list of private evidence without copying it. The last command validates the public file list without building a site. Public provenance contains relative source identifiers/hashes, never machine paths. Later live Virtuoso edits require a new reviewed export and updated pins; these snapshots do not synchronize automatically.
