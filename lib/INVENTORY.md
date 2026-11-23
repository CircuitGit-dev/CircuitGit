# ADC source coverage and remaining exports

Observed 2026-11-23. This is a bounded local inventory, not a live Virtuoso survey. The 96 published ADC entries represent 74 distinct source library/cell/view identities: 86 schematic entries and 10 symbol-only entries. With the existing RC example the catalog has 97 entries in four libraries.

The native import is a partial-fidelity viewer archive. No new ADC simulation, layout export or runtime project registration is claimed. Per-file source/output hashes are recorded in each cell; the machine-readable inventory also hashes the private evidence documents without publishing their contents.

| Design or variant | Coverage | Evidence/limitation |
| --- | --- | --- |
| 1 GS/s ideal/relay-switch PIPE-TI-SAR | `native_snapshot_partial` | Historical ideal/switch variants appear in the research snapshot. Saved geometry is not a claim that every historical run or later live edit is included. |
| Earlier actual-SAR integration | `native_snapshot_partial` | Earlier topology is kept distinct from the November real-SAR version; no simulation archive is published by this import. |
| 1 GS/s real-SAR integration, November 6 | `native_snapshot_partial` | 22 canonical native views overlap source identities in the 64-entry research library. Ideal OTA and other behavioral dependencies remain; short historical functional results are not signoff. |
| Capacitor-array MDAC candidate, November 6 | `native_snapshot_partial` | Native candidate schematics are included. The historical unit-MDAC result does not establish full-ADC precision; the documented LOW test failed its predefined two-LSB functional bound. |
| Flash, buffer and amplifier research testbenches | `native_snapshot_partial` | Research exports cover the saved cells; replay-labelled testbench names alone do not supply replay configuration or measured data. |
| 4x4 10 GS/s THA | `native_geometry_not_exported` | Local OA/readbacks, netlists and behavioral models exist, but there is no reviewed RNL export in this seed. Historical 10 GS/s baseline is superseded by the separate 12 GS/s task. |
| 4x4 12 GS/s THA, compact schematic | `native_geometry_not_exported` | Library 2026_PIPETISAR_RESEARCH2 retains THA_4X4_10G / TB_THA_4X4_10G names at 12 GS/s. OA/readbacks and behavioral deck exist; no native geometry import or registered replay is supplied here. |
| User revised THA coherent-sampling testbench | `later_user_state_not_exported` | User Fs/cycle/N edits postdate the October 27 decks. Importing those older decks would not reconstruct the current user testbench; no new simulation is claimed. |
| THA voltage-sequence FFT reconstruction | `analysis_only` | Reconstruction concerns behavioral held-voltage samples, not quantized ADC output codes. It is not a separate ADC schematic or a new simulation. |
| 2024_Pipeline_Copy 3/4 GS/s Pipeline-SAR variants | `report_only_no_pinned_native_export` | Local November 20 report names TB_ADC_core and TB_ADC_core_ideal_amp plus comparator-reset and bandwidth/gain variants. Bounded local search found report/figures, not a pinned native schematic closure or complete replay archive. Private report paths and unverified performance generalizations are not copied. |
| Floating source-follower research | `research_notes_only` | Local report and research notes are not an exported ADC library, layout or executable design bundle. |
| ADC analysis/calibration utilities | `analysis_archive_not_circuit` | Archive has 83 members containing MATLAB analysis/calibration versions and an inner ZIP, not OA/schematic/layout data. Utility authorship/dependencies were not reviewed for redistribution, so the archive is not published. |

## Inactive historical simulation inputs

Three existing testbench cells expose five configuration candidates. The real-SAR pair includes sanitized electrical templates with four external model aliases and five project Verilog-A models. The MDAC three provide configuration/audit records only. No ADC runtime project is registered; no template has been replayed by this migration.

| Cell | Test | Available input |
| --- | --- | --- |
| `pipetisar-real/TB_PIPE_RS9_N06` | `PIPE_LOW` | `sanitized-template` |
| `pipetisar-real/TB_PIPE_RS9_N06` | `PIPE_NYQUIST` | `sanitized-template` |
| `pipetisar-research/TB_MDAC_CA4_N06` | `MDAC_CODES` | `configuration-audit` |
| `pipetisar-research/TB_PIPE_CA4_RS9_N06` | `PIPE_LOW` | `configuration-audit` |
| `pipetisar-research/TB_PIPE_CA4_RS9_N06` | `PIPE_NYQUIST` | `configuration-audit` |

## Exclusions

- **trans_ulvt_mac_pcell_0 standalone cell**: PDK implementation excluded; no standalone catalog entry.
- **trans_ulvt_mac.scs original implementation**: Replaced in four canonical closures by an explicitly empty viewer-only six-terminal interface. Two internal MOS instance definitions are removed; source/output hashes are recorded.
- **PDK/model cards, technology libraries and standard-cell implementations**: External dependencies, not redistributable circuit example content.
- **OA binaries/backups, layout GDS/OASIS, DRC/LVS/PEX and ADE/Maestro state**: Not imported by the reviewed text-geometry snapshot plan; complete native archive/export still required.
- **Raw source metadata/receipts, local machine paths, configuration, credentials and licenses**: Private runtime state is not public provenance. Public provenance is newly generated with relative identifiers and hashes.
- **PSF, simulator caches, raw results and performance report HTML/images**: No complete audited source/configuration/results replay bundle is published by this import.
- **Behavioral implementations missing from symbol views**: All10 native symbol entries provide icons only. The separate inactive real-SAR templates supply5 matching-name project VA files; PIPE_IdealSwitch, PIPE_Merge12, PIPE_SAR9_Timed, PIPE_ThermDAC4 and RS9_Interface behavior is not supplied by this release.

## Remaining migration work

- Current RESEARCH2 THA geometry plus updated user testbench state.
- 2024_Pipeline_Copy current, baseline and ideal-amplifier variants with explicit source/version binding.
- User-owned OA/layout archive with PDK dependencies externalized and restoration/DRC/LVS/PEX evidence.
- Separately audited electrical replay configurations and matching result provenance.

Current index entries do not prove current remote design state. No missing native view is replaced with inferred geometry or automatic routing. Source export losses (dynamic labels and unverified pin/font fidelity) remain explicit in each cell README and provenance.
