# Native geometry contract v1 — implemented portable interface

Date: 2026-11-09. This describes the backend delivery under `portable/`; only circuit owner integrates it into development Git. Synthetic evidence does not prove native geometry fidelity.

## Installed project registry

Add `geometry_manifest: "projects/<project>/native/manifest.json"` (or `geometry/manifest.json`) to the existing trusted project entry. The manifest must be under the canonical source file's project directory. Geometry is not added to editable/read source paths or simulation materialization. Additional bound electrical source files must already be explicitly registered in `read_paths`.

## Committed manifest: ic.native-geometry.v1

The executable generator is `tests/fixtures.py:build(source_commit, source_bytes)`. A complete generated example is written by tests to `evidence/synthetic-manifest.example.json`. It is clearly labeled synthetic and its commit is an isolated test repository identity. Do not reuse its hashes or claims for native data.

Required structure:

- `schema`, `id` (1–64 letters/digits/underscore/dot/hyphen), `project_id`.
- `source: {path, commit, sha256, files?: [{path,commit,sha256}]}`. Use the actual export-time canonical electrical commit and SHA256. The backend independently reads that regular Git blob. A source commit may be unrelated to the bundle history if its contents match exactly. `bundle_commit` is supplied by the API, never embedded into the committing manifest.
- `root_cell`, `entrypoint`, `cells: [{id,cell_view:{library,cell,view},entrypoint,level}]`. Every cell is independently selectable. `level` for a Spectre subcircuit must equal a definition in its entry; explicit top-level decks use `@top`.
- `files: [{path,kind,bytes,sha256,dependencies:[]}]`. Paths are relative to the manifest directory. Kinds: `native-netlist` (.scs), `native-assembly` (.scs, include-only), `rnl` (.rnl), `source-map`, `validation-report`, `provenance` (.json). All files are committed UTF-8 regular blobs. No scripts, executable assets, electrical model bodies, remote imports, filesystem URLs or unlisted paths.
- Direct `dependencies` contain actual package providers, included files, referenced hierarchy cells, and any owner-confirmed semantic symbol dependencies. The backend computes each entry's transitive closure and emits dependency-first `pool` containing that closure minus its entry. It never emits the whole catalog for every cell. Cycles, unreachable viewer files, missing package versions, mismatched package paths, unresolved declared targets, and imports outside direct dependencies fail.

The supported literal import subset matches the observed native fixture: `@PACKAGE(name="…",version="…")`, `@USE-PACKAGE(name="…",version="…",path="…")` with optional path, across RNL/Spectre/SPICE comment lines; literal `include`, `.include`, `.inc`. Package versions are exact. Unsupported import grammar fails explicitly. The scanner checks closure, not electrical equivalence or RNL layout semantics. The official parser remains authoritative for rendering.

Limits: 1 MiB manifest, 300 catalog files/cells, 2 MiB per file, 20 MiB per cell closure. This first version bounds the catalog itself to 300; expansion requires an explicit decision. File sizes are checked with Git `cat-file -s` before blob reads. No silent truncation. Only the selected closure's content is loaded; cell metadata is checked for all cells.

## Fidelity fields and fail-closed defaults

`native_export` records actual origin, exporter version, snapshot/configuration hashes and native report identity. `coordinate_system` records actual `units` and a documented `transform` (including exporter scale). Missing coordinate information is unknown.

`coverage: {status:"complete"|"partial"|"unknown",counts:{instances:{expected,exported},ports:{…},wires:{…},symbols:{…},labels:{…}}`. Never fabricate native baseline counts from output counts. Cell-specific coverage/losses/fidelity override the global fields.

`losses` is null/absent when unknown. Each known loss records a reason and an explicit boolean `blocking`; error/blocking severity prevents readiness. An empty list is an owner's affirmative no-known-loss statement, not a default.

`fidelity: {status:"unverified"|"partial"|"verified",report?:"validation.json"}`. Verified requires a listed validation report with schema `ic.native-geometry.validation.v1`, matching project/source SHA256, named verifier, and per-cell `cells[id]` containing all six true checks (`placement`, `orientation`, `wire_routes`, `pins`, `symbols`, `labels`) plus `geometry_files` mapping every closure path to its exact SHA256. This is a committed owner attestation. Backend integrity checks do not independently establish native fidelity.

## Read-only HTTP APIs

`GET /api/schematic?project_id=P&path=CANONICAL&source_hash=EDITOR_SHA256` retains `{ok:true,data:...}`. Existing source fields plus `base_commit`, `available`, `stale`, `native_ready`, `geometry` are returned. `source_commit` is null for dirty source. Geometry uses `ic.native-geometry.payload.v1`, `mode:native`, `state:missing|invalid|stale|partial|ready`, source binding, immutable bundle/manifest identities, cell/view table, root file closure, coverage/losses/fidelity, and `viewer_manifest_url` on the root and every cell. Other cell content is validated when its pinned manifest is requested; `validation_scope` states this explicitly.

`GET /api/geometry/viewer-manifest?project_id=P&bundle_commit=C&manifest_sha256=M&entry=CELL_ID` returns raw official JSON (no wrapper): `{format:1,id,entry,level,pool,files:[{path,url,sha256,size}],settings:{autoInclude:false}}`. The URLs are absolute same-origin loopback URLs generated from the server port, never a supplied Host or Origin. Official files use `size`, not `bytes`.

`GET /api/geometry/file?project_id=P&bundle_commit=C&manifest_sha256=M&path=RELATIVE` returns original bytes. Only the project's registered manifest at an exact ancestor/current commit can authorize file membership. All calls validate immutable binding and member size/hash. Text data uses text/plain, metadata uses application/json without re-encoding; Content-Length, ETag, bundle/manifest/source identity headers are supplied. Pinned files remain readable after canonical source changes, while metadata remains no-store. No fetch, compilation, export, shell script or simulator is triggered by reading geometry.

Invalid input →400; unknown project/member/entry →404; substituted manifest hash or bundle commit outside current history →409; invalid committed geometry →422. Schematic metadata returns200 with explicit missing/invalid/stale/partial states. Existing Host/Origin/CSRF guards and rejected-POST connection close remain intact.

## Mapping and freshness

Optional `mapping` names a listed source-map JSON: `{schema:"ic.native.source-map.v1",bound_source_hash,objects:[...]}`. Object keys include kind/name/scope/viewer_source_path and canonical source path/hash/line, or `source_kind:"export",readonly:true` for native export lines. API embeds `geometry.mapping`. It removes canonical mappings on stale responses and returns `source_mapping_enabled:false`; historical raw file contents are never rewritten. UI must require exact matching kind/name/scope/viewer file and refuse ambiguous jumps.

Dirty working-tree/index source, changed committed source, changed additional bound source, or editor SHA mismatch makes stale=true and native_ready=false. Equal content after unrelated commits can be current; the export-time `geometry_source_commit` is never replaced. UI must invalidate native source mapping immediately on unsaved edits and compare the current editor hash again before applying asynchronous loads. Stale geometry remains explicitly viewable. Missing geometry has no automatic derived placement/wiring fallback.

## Owner handoff

Required portable files: `geometry.py` and patched `server.py`. `workspace.py` is unchanged baseline for reference. Existing runner/publisher/compiler/launcher are unchanged. Register the actual geometry manifest in the installed project config and commit native files plus truthful source binding/coverage/losses/report through the sole Git integrator. Actual SAR-core bytes can validate parser/closure compatibility before that commit, but cannot prove canonical electrical binding or native fidelity.

## Actual fixture alignment: include-only display assembly

The actual exporter writes separate native `.scs` definitions without electrical include statements between them. With `autoInclude:false`, loading them into `pool` alone does not make every hierarchy level part of the selected document. Every individual cell remains independently viewable through its own endpoint. The owner has now supplied `viewer-entry.scs`, which explicitly includes all unchanged fragments once.

An additive file kind `native-assembly` supports this actual owner artifact. It permits only comments, blank lines, `simulator lang=spectre` and literal `include "file.scs"` statements; no annotations, instances, models, wires, placement, scripts or inferred geometry. Its declared dependencies must cover every include. Its selected `level` must exist in the transitive explicit includes. A cell may therefore use an assembly entrypoint while retaining its actual library/cell/view identity. Per-cell minimal assemblies can preserve hierarchy navigation without including the whole library in every cell's pool; generating those remains the owner's task. Actual `native-netlist` files keep their original bytes.

An object mapping must name a listed native viewer source and either an exact bound canonical source path/SHA256 or a read-only listed export target. Line ranges are bounded by the actual committed target's line count. Unknown or inconsistent mapping fields fail closed. `native_export` readiness requires origin/version and actual snapshot/config SHA256; absent evidence remains partial.
