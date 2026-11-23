# Repository structure and host integration

One repository contains two application entrypoints and shared functionality. The existing browser application stays runnable while Codex integration is developed independently.

```text
apps/
  web/                       browser source, popup transport, layout, browser AI
    vendor/rnl-viewer/       pinned RNL renderer, fonts, WASM and local adaptations
  codex/                     plugin manifest, CLI/MCP, skills and current AI adapter
  mcp/                       optional official-SDK stdio entry and isolated dependency lock
modules/
  schematic/                 electrical index and native geometry models
  waveforms/                 panel, mapping, measurements and styles
  simulation/                configuration panel/controller/receipt actions
  workspace/                 immutable shared context store
  gateway_client/ic_gateway/ finite Python gateway client and tool schemas
contracts/                   context types, module catalog and generated MCP schema
tools/
  dev/                       offline builds and boundary checks
  workbench/                 installed gateway/compiler/runner/publisher
  ai/                        compatibility entrypoints only
  sim/, native_geometry/, …  existing reproducible EDA/export tooling
projects/, design/, sim/    authoritative sources and historical design/input snapshots
lib/                       reviewed public libraries, cell views and provenance
results/, validation/       historical results, provenance and acceptance evidence
config/                    versioned examples; private *.local.json stays ignored
web/, dist/                generated packages, excluded from Git
```

## Existing module boundaries

The waveform panel receives `contextAdapter` and an API with `jobs`, `catalog`, `mapping`, `waveform`. It does not import the browser transport. The browser wrapper creates that transport and keeps legacy `/waveforms/panel.js` usable. Popup lifecycle and `window.opener` remain in `apps/web/studio/plot`.

The simulation panel receives the existing Studio host and simulation slot. Its controller, receipt actions and stylesheet are shared. It still uses DOM and browser confirmation; a native UI adapter must implement the host requirements rather than assume a headless interface.

Schematic metadata normalization and the bounded netlist index are shared. The full RNL web shell retains document singleton/global DOM state. The Codex schematic adapter uses the same pinned RNL core inside each independent MCP App iframe with its own renderer lifecycle. It preserves exported geometry and avoids loading the web Studio/AI shell.

`modules/workspace/context.js` is the source of public context state. `apps/web/context/workbench.js` adapts browser state to it. Each future host must supply explicit project/commit/file/selection/run identity; do not route multiple tasks through a global active project.

The finite gateway client is independent of Codex/RPC and has no model startup side effect. Its tool definitions are the single source for the CLI, MCP and optional web AI bridge. `apps/codex/icwb/service.py` is a compatibility import, not another implementation.

The optional `apps/mcp/server.py` adapter uses the official MCP Python SDK and delegates tools/resources/reviews to those same implementations. `tools/dev/build.py mcp` packages it separately under `dist/ic-workbench-mcp` with the existing backend beneath it. SDK dependencies do not enter the legacy plugin runtime. See [Agent connections](agent-connections.md) for the distinction between the current web chat, portable MCP tools, and a future ACP chat adapter.

## Entrypoints and compatibility

```bash
# Reproducible local packaging: no network, model, simulation or dependency install
python3 -B tools/dev/build.py all
python3 -B tools/dev/check_structure.py

# Existing web entry; automatically builds web/ before launching
python3 -B tools/workbench/launch.py --config config/workbench.local.json

# Canonical Codex/CLI tool entry; schema works without a config or gateway
python3 -B apps/codex/ic_workbench.py --json schema
python3 -B apps/codex/ic_workbench.py --config /absolute/client.json mcp

# Self-contained package for subsequent explicit installation
python3 -B dist/ic-workbench/ic_workbench.py --json schema

# Old CLI command remains compatible
python3 -B tools/ai/ic_workbench.py --json schema
```

The web build maps `apps/web` to the static root and shared modules to `/modules/…`. It rewrites only relative references to registered assets, preserving old URLs such as `/vendor/rnl-viewer/index.html`, `/studio/plot/window.html`, `/waveforms/panel.js` and `/legacy-dashboard.html`. Source imports continue to work for Node unit tests; built imports are checked separately. No source symlinks or external static roots are introduced.

The plugin build copies `apps/codex`, the shared Python client into `lib/ic_gateway`, and the fixed gateway execution modules into `gateway/`. It does not include engineering snapshots, result archives, runtime state or local config. A minimal gateway status page is bundled; if the configured repository has a built web application, the automatically started gateway continues to serve it. The legacy diagnostic AI sidecar assets under `apps/codex/web/` remain for `serve-ai` compatibility.

`apps/codex/icwb/ai.py`, `host.py`, `rpc.py`, and `sessions.py` remain app-server/web bridge adapters. Native Codex uses `mcp.py` directly. `views.py` and `view_contracts.py` add the combined workbench and three standalone MCP App resources plus finite per-workspace data/state operations. UI uses the standard MCP Apps bridge, not a second model session. See [Codex MCP windows](codex-mcp-windows.md) for connection and validation boundaries. Arbitrary native window docking remains host-controlled.

## Engineering data policy

The optional browser `developer` permission mode creates a native Codex development thread with the server-configured `development_workspace` as its initial working directory. Operator-configured `development_access` defaults to `manual` (read-only native sandbox and individual human approvals); explicit `full` uses `danger-full-access` and `approvalPolicy: never` on that thread only. Full native access is not a filesystem restriction to the initial directory. The returned policy and working directory must match before inference starts; global Codex settings are untouched. The access level is frozen in each turn receipt. Changing access or returning to a normal circuit mode creates a fresh thread. Historical approvals are never promoted or replayed, and `ic_*` operations retain their existing Service ledger and approvals. Local frontend publication can use the ordinary checked build into `web/`; backend restarts must preserve active conversations. The development checkout and live engineering runtime remain separately identified. See [Agent connections](agent-connections.md).

Application code, editable design data, historical snapshots, and runtime state have different lifecycles. This migration moves application code only. Existing `projects`, `design`, `sim`, `results`, `validation` paths and bytes remain unchanged; archived hashes and fixed runtime commits are not recalculated to disguise differences.

Do not move PDK dependencies into shared modules. Production site credentials and remote directory identities remain in private configuration. AI turn history is runtime state and must not be added to Git to preserve a UI layout.

The public library extension uses `lib/catalog.json` and per-library manifests. The Pages publisher copies only the explicitly reviewed view inventories into `library-files/`; application/plugin builds still exclude engineering snapshots. Library browsing uses the existing RNL source/geometry loader and is independent of AI node project selection. Opening a library schematic clears the RC analytical data, and cells without a registered runtime project cannot submit a simulation. See [circuit libraries](circuit-libraries.md).

## Codex window lifecycle

Each open tool creates a view with explicit project/source/run identity. Related views share an explicit workspace ID. Selections carry native geometry pins and are independently checked against saved waveform mappings. State changes use view compare-and-swap revisions; workspace revision, request receipts and package availability are separately observed live fields. Closing a component disposes its renderer, listeners and polling without deleting engineering data or another view's state.

UI mount acknowledgement and loaded-data acknowledgement remain distinct. The standalone resources are tested in a separate-origin MCP Apps host; actual Codex display and CSP acceptance require their own host observation. Saved catalog viewing remains independent of schematic freshness. `ic_request_review` sends a correlated MCP form elicitation; only the host's accepted human response can invoke the existing receipt resolver. Unsupported hosts or cancellation leave the request unapproved.

`plugin_entry.py` starts the MCP catalog immediately using installed settings. Before workbench data tools run, `PluginRuntime` reuses a matching gateway or starts its packaged executable under a startup lock. Port conflicts and failed startup do not trigger alternate ports, process replacement or repeated launch. `ic_plugin_status` reports setup/connection without starting anything; UI resource reads also do not launch the gateway. Existing project, model and approval configuration are not rewritten by runtime startup.

Develop on a separate branch/worktree and use a different port/state directory. Shared changes are tested for the browser and CLI/MCP before integration. Release snapshots, not two permanent diverging branches, distinguish deployed versions.

## Validation commands

```bash
python3 -B tests/architecture/test_structure.py
node --test tests/context/*.test.mjs tests/waveforms/mapping.test.mjs tests/studio/*.test.mjs
python3 -B tests/ai/test_service.py
python3 -B tests/ai/test_ai.py
python3 -B tests/ai/test_sessions.py
```

The optional `tests/architecture/browser.mjs` uses a temporary web server and read-only access to the existing loopback gateway (`IC_GATEWAY_URL`). AI data is explicitly stubbed. Set `PLAYWRIGHT_MODULE` if Playwright is supplied by a local runtime, and `EVIDENCE_DIR` to retain reports. It opens only its own browser, checks actual saved waveforms, and does not submit model/EDA tasks.

The combined workbench uses scoped component hosts over one MCP connection. Its layout tree persists on the parent view; child snapshots preserve UI text and display state with separate view revisions. Drags and tab switches retain DOM instances; close saves first and disposes only that component. See [Docking workbench](docking-workbench.md).

## Browser simulation and engineering history

The shared simulation panel groups analysis/parameters/signals, submission steps, and saved run data into three views. Draft configuration JSON, compiled identity and operation receipts stay available in advanced details. The visual editor uses the same transient compiler and explicit preview/save/plan/preflight/submit operations; hiding a panel does not discard drafts.

`apps/web/studio/versions` adds an optional Dockview tab via Git → 版本管理 and the Window menu, with a closable dialog in the legacy layout. Existing saved layouts and the four-panel default remain intact. The view reads only the selected runtime project's allowlisted files from `/api/version-control` and `/api/version-control/commit`. History and clean/dirty are project-scoped; upstream ahead/behind uses the entire runtime branch's local tracking cache and does not establish current remote state. Source editing/review/commit/push and confirmed fast-forward synchronization reuse the existing host workflows. Querying history never fetches, checks out, commits or launches a simulation.

The browser requests `scope=design`: editable circuit sources, hierarchy replacements and simulation configuration paths. Read-only provenance and application paths are excluded. Standalone comments, blank lines and JSON formatting can be hidden by conservative comparison; the checkbox retains access to those commits and the response reports the bounded scan coverage. Real Git subjects and message bodies are preserved. Restoring a historical version prepares a current-base diff and makes a new commit only after explicit confirmation; it never resets or rewrites history.

Source, simulation and restore workflows share `modules/workspace/commit-message.js`. The gateway verifies the saved review against the current source hashes and project scope before `POST /api/changes/summary` can start an independent, tool-free app-server worker. `GET /api/changes/summary?summary_id=…` only reads its receipt. A review identifies one cached generation; unknown completion is not replayed. Title/body remain editable and become the normal Git message (300 characters maximum); generation never commits or approves anything. The worker inherits the local runtime default model/provider, independently of the current web chat selection; provider/model fallback is disabled. It does not occupy a user chat and its running count is included in `/api/health` for restart checks.

## Stored supervision integration

`contracts/spiceowl-supervision.v1.json` defines passive `GET /api/supervision?project_id=…` and `GET /api/submissions/<encoded-key>`. The projection in `tools/workbench/supervision.py` reads bounded local run records and artifact metadata, preserving original observations and source commits. Legacy aliases retain `original_project_id` while a separately justified registered association becomes `project_id`. Missing historical compiled hashes remain null. Reading a snapshot or missing key never starts SSH, status polling, collection, submission, or a new workspace revision.

SpiceOwl adapters should reuse the installed IC MCP `ic_sim_submit`, `ic_request_status`, and human `ic_request_review` flow. They must use the same configured Service state directory as the reviewing MCP host; browser chat and installed MCP settings currently may use distinct directories. No second approval ledger, machine approval HTTP route, multi-host scheduler, or replacement execution backend is introduced by this passive integration.

`modules/simulation/supervision.js` is mounted once in the simulation panel's run page. Parent rerenders and hiding the panel retain its DOM and controller; destroying the panel unsubscribes it. It reads once per project and on explicit refresh, without background polling. A failed same-project refresh labels the retained snapshot as old and disables waveform opening. The waveform action checks the selected run's project, original source commit, and recorded waveform binding again when clicked; it does not select a different run or infer current schematic freshness.
