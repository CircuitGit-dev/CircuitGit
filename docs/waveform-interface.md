# Waveform interface v1 — web / AI / sole integrator

Portable backend: `portable/tools/workbench/waveforms.py`; browser: `portable/web/waveforms/{panel.js,mapping.js,api.js,panel.css}`. Inject the single shared context adapter built by web owner. No global app state is assumed.

```js
import {mountWaveformPanel} from './waveforms/panel.js';
const waveforms = mountWaveformPanel(section, {contextAdapter});
// contextAdapter.getContext(), subscribe(listener) returning unsubscribe.
// Add <link rel="stylesheet" href="/waveforms/panel.css">.
// destroy() cleans listeners, requests and ResizeObserver. setRun(runId) supported.
```

## GET-only gateway additions

Existing same-origin Host/Origin security and `{ok,data}` / `{ok:false,error}` wrappers remain.

| Route | Request | Response |
|---|---|---|
| `/api/jobs/{run}/signals` | no query | identity, analyses, signals, limits, exported_subset coverage |
| `/api/jobs/{run}/waveform-map` | no query | verified_binding manifest or unmapped reason |
| `/api/jobs/{run}/waveform` | required signal_id; analysis=tran; start/end SI seconds; limit4..10000; optional cursor_a/cursor_b SI seconds | identity, exact signal, bounded points, window, display method/counts, full-CSV cursor values and delta |

The registered run must already exist; do not call single-run status to populate catalog. Only GETs; no CSRF token needed or surfaced. Unknown/duplicate/blank query fields reject. Names are not expressions. signal_id is an opaque `s_` ID minted from `[run_id,analysis,exact_name]`; use returned IDs, never invent them. Signal requests accept no filesystem paths. Unknown ID gives404 signal_absent; unsupported analysis422; invalid window/limit400; changed identity409. No fallback to first matching name.

AI owner can call these same routes from its CLI/MCP. Reference `waveform_cli.py` is a thin GET consumer and contains no Git/submit/collect command. Suggested tool names: sim_signals(run_id), sim_waveform_map(run_id), sim_waveform(run_id,signal_id,analysis,start,end,limit,cursor_a,cursor_b). A request timeout or cancellation stops only its local read. Extraction is disabled in this initial service; no GET launches OCEAN.

## Mapping manifest

Installed gateway config `waveform_bindings: {RUN_ID: "/absolute/installed/manifest.json"}` authorizes a mapping file. HTTP callers cannot change this registry. A manifest is data only and validated against the registered run before use. The circuit owner supplies the production mapping; examples generated in tests are visibly synthetic or demo-only.

```json
{
 "schema":"ic.waveform-map.v1", "run_id":"registered-run",
 "source_commit":"exact-run-source-commit", "effective_config_sha256":"catalog-field",
 "raw_signature":"catalog-field",
 "source":{"kind":"canonical","path":"registered/source.scs","sha256":"actual-source-hash"},
 "geometry":{"bundle_commit":"40hex","manifest_sha256":"64hex","entry_id":"native-entry"},
 "objects":[{
  "selector":{"kind":"net","name":"D<0>","scope":"cell","viewer_source_path":"cell.scs","native_entry_id":"native-entry","occurrence_path":["X0","X3"],"bus_bit":0},
  "status":"available","signal_id":"catalog-id","psf_name":"exact-raw-name",
  "analysis":"tran","unit":"V","scale":1,"evidence":"named binding report/hash"
 }]
}
```

Backend checks source path/hash against materialization source hashes (or `kind:staged` against exact staged sources for legacy/test bindings), plus run source/config/raw signature, selectors, PSF ID/name/type/unit and current polarity. Production geometry identities are provided and attested by the circuit owner; this reader does not independently prove native geometry fidelity. Exact matches are required for source and geometry on each current graphical selection. Current entries use kind terminal/branch, device name, terminal_name, full parent occurrence path, polarity into_terminal/out_of_terminal, scale1/-1. Voltage entries cannot point to current data. Ground/global/bus escapes are only supported through explicit entries; no inferred ground-zero signal or string normalization.

For unavailable rows signal_id must be null. status `not_saved` or `saved_needs_extraction` requires `catalog_evidence_sha256`; include a human-readable `evidence` and optional `save_proposal` for review. Never infer either state merely from missing CSV. UI supports explicit choices for missing occurrence, bus bit or instance terminal. Choices are rejected if context changed since presentation.

## Context extension required from web owner

Use existing camelCase v1 context. Selection adds `occurrencePath: string[]|null`, `terminalName: string|null`, `busBit: number|string|null`, `nativeEntryId`, `viewerSourcePath`, exact `kind/name/scope`. The path is the ordered parent-instance occurrence, with selected device in `name`; [] is verified top level, null is unknown/independent cell. Never derive it from cell name or hierarchy tree visit alone. `file.currentTextSha256`, `file.dirty`, `project.sourceCommit`, `geometry.sourceMatch/state/bundleCommit/manifestSha256` are mandatory for live synchronization. Missing/stale fields leave catalog/history usable but prohibit click-to-current-run mapping.

## Final frozen context V2 and historical source rules

Use web-owner `phase4-context/frozen-v2` (archive SHA256 a6d38e36bf61bf29a97f64935a592296c2bf842632f12e8a3ae39080af42d052). It publishes `window.ICWorkbenchContext`; the integration helper is `install.js:installWaveforms(window.ICWorkbenchContext)`. It expects the hook already present. occurrencePath is the PARENT path for every selection, including instance; do not strip its last segment. Context V2 resolves exact entry-relative paths and rejects old frame events. Only this producer owns app state.

The tested electrical source is canonical blob at c17c525, SHA25612d9cfed2933bb2e4627e01e64662fadf58b8bf33ac38cd4a12e926ae37c89eb. It equals the SAR run receipt's `provenance.files` pre-staging `source_sha256` for destination netlist/project.scs. This is represented by `source.kind:before_staging`, `source.path:netlist/project.scs`, plus `source.canonical_path:projects/real-sar-20261106/circuit.scs`. The staged SHA differs because existing runner materialized an external include alias. No string stripping is used in mapping resolution.

The actual native browser test uses circuit-owner committed bundle641ddd4a2ee8be95e0f784d2164765e9cb412ceb and manifest SHA256ea4be1b99591ba45026da0f6ee5625ebc2856252ea7dc0bc14639fac76ce60b2. Root display closure is copied verbatim from that commit, including its reviewed compatibility modifications, and retains partial fidelity. This supersedes the initial uncommitted raw-export test plan. Failed raw-export/core compatibility attempts are retained as diagnostics, not accepted evidence.

`project.sourceCommit` can differ from run.source_commit only when exact current file path/hash, geometry sourceMatch and exact pinned geometry bundle/manifest match the installed mapping. The UI then says HISTORICAL RUN WITH IDENTICAL SOURCE BYTES; it does not claim latest configuration or fresh simulation. Any source change, including comments, invalidates synchronization. The later canonical comment-preservation hash e179641… is different and remains blocked by the delivered mapping. Updating bundle_commit alone never reactivates it. A future rebinding requires separately reviewed source evidence and a new manifest; no automatic comment normalization is implemented.

## Separately registered native current

Trusted installed config gains `waveform_derivatives: {RUN_ID: ["/absolute/derived/native-current-v1"]}`. Directory contains current.csv, catalog.sexp and provenance.json. No request can choose this path. The service validates run/source/archive/raw-signature/config, CSV/catalog hashes, native time axis/count/unit, before/after raw proof and cache_key. Cache key hashes run/source/raw signature/analysis/exact signal/window/extractor version+script hash/data basis. There is no extraction-on-GET.

Catalog125 contains six available curves: five OCEAN-resampled voltages and VDD0:p native current. The other119 exact raw names return saved_needs_extraction and unknown quantity/unit until a future authorized extraction. The current uses scale+1, polarity into_terminal; negative values mean flow out of p under this convention, not failed data. No conversion to positive power-supply consumption is made. A opposite-direction mapping, if explicitly authored, must pair scale−1 with out_of_terminal.

The complete current catalog was independently audited by coordinator; its report is external to this package at `LLM_for_IC/work/ic_on_github_coordination_20261109/wave-current-independent-audit.json`. Original archives/Release are untouched. Derived current remains a new unpublished artifact.
