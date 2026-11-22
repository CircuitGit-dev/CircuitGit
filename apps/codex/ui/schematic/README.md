# Native schematic MCP window

`index.js` exports `mount(root, host)`, returning `{dispose()}`. This module uses the frozen MCP view and host contracts. It runs inside the MCP resource's own document; there is no second iframe, browser popup, nested model session, or global active project.

The component loads the pinned entry catalog through `ic_view_data` (`schematic`), then its finite manifest and base64 file chunks (`geometry_manifest`, `geometry_file`). It validates entry identity, offsets, lengths and SHA-256 before passing the unchanged closure to the pinned RNL WASM core. No gateway URL is fetched by this component. Auto-include is disabled and no layout solver is invoked.

The catalog, coordinates, wires and symbols come from the existing native export. The main testbench has 711 instances and 23 renderer levels. All 97 catalog entrypoints and all registered member byte hashes are checked by the Node test. The browser test renders the main testbench in two independent documents; it does not claim to have visually reviewed every entry.

## User flow

Invoke `ic_schematic_open` with an actual project ID, optionally the returned workspace ID of related windows. The shared host loads this component when it receives the descriptor.

1. Choose or filter an original native entry. Zoom/pan uses the existing RNL viewport module.
2. Click an instance or net. If geometry overlaps, choose the intended object from the explicit list.
3. For a subcircuit device, choose a terminal offered by the actual rendered symbol. The UI never infers a terminal name from a pin coordinate alone.
4. “发送选择到工作区” stores the selection using the current revision and updates model context. Context includes view/workspace/source/entry/object identity and the exact run field, including `null` when unbound.
5. “进入选中器件” and “上一级” follow actual Document instance hierarchy. Choosing an arbitrary level resets occurrence evidence; it cannot invent a testbench occurrence.

Source mismatch blocks selection and hides the drawing by default. The user may explicitly display a stale historical drawing, while publishing remains disabled. Independent library exports are labeled as snapshots and do not gain canonical mapping from the main testbench. Rendering warnings and unplaced-object counts remain visible.

Published selections include a closed `geometry` record with `viewer_source_path`, `native_entry_id`, `bundle_commit`, `manifest_sha256`, `source_match`, `canonical_mapping_enabled` and `snapshot_only`. These refer to the displayed export even when `source_path` maps to a canonical source span. Missing geometry pins stop publication. Unresolved or snapshot occurrence paths stay absent; only a resolved top-level occurrence is `[]`. The record remains untrusted `ui-metadata`. A waveform window in the same explicit workspace can read it through `ic_workspace_get`, then independently validate its own run and saved mapping; a schematic run binding is not required.

## Assets and integration

Shared bundler entry: `apps/codex/ui/schematic/index.js`. It must follow the static import graph into `modules/schematic` and the pinned RNL renderer helpers, without importing the web Studio entrypoint.

Additional registered assets:

- `apps/codex/ui/schematic/style.css`, read with `host.assetText`.
- `apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm`, read with `host.assetBytes` and passed directly to `loadCore`.

There are no Workers or dynamic module URLs. `core/packages.js` remains the pinned static import. The existing export's renderer font configuration uses system fallbacks; this component does not download fonts. Shared host packaging, CSP and native installation are owned by the coordinator/UI owner. A browser harness result cannot prove Codex native mounting.

## Limits

- Up to 300 files / 20 MiB closure and 2 MiB per file; chunks are 256 KiB. No unbounded asset retrieval or arbitrary file path.
- The core builds synchronously within the MCP iframe; loading a large entry may briefly block that iframe. Host initialization completes before mount/load.
- Primitive instances without a Document symbol-pin catalog offer no invented terminal list. Net selection and whole-device selection remain available.
- The current schematic-open contract has no run argument. `run_id` is `null`; published selections are `ui-metadata`, not verified signal mappings or waveform commands. The waveform component must independently validate a compatible run/mapping.
- Selection publishing is an explicit UI action. It cannot edit electrical source, OA, PDK or simulation state. CAS conflicts are shown without automatic mutation retry.
- Native desktop mount and host fullscreen support require separate coordinator verification. The local tests use synthetic view-state/CAS replies, with actual versioned native geometry.

## Checks

From repository root:

```sh
node --test tests/codex/schematic/data.test.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/codex/schematic/browser.mjs
python3 -B tools/dev/build.py all
python3 -B tools/dev/check_structure.py
```

The browser test starts only its own ephemeral loopback fixture server and Chrome, and closes both. It never contacts production, a model or an EDA host. `EVIDENCE_DIR` optionally chooses the report/screenshot directory. Shared MCP bundler integration should be tested separately after all owner commits are assembled.
