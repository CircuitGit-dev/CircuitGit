# Native MCP App host and offline resources

`host.js` implements the MCP Apps **2026-01-26** JSON-RPC bridge. Each UI resource is its own iframe/document and binds exactly one `ic.view.v1` view/workspace/kind/pinned identity. It does not instantiate the browser Studio, AI chat, gateway client token, or model session.

Component entrypoints are `schematic/index.js`, `waveforms/index.js`, and `simulation/index.js`. Each exports `mount(root,host)` returning `{dispose()}` (async accepted). The component directories are owned by their respective teams; this host/build change does not include them.

## Host API

| API | Behavior |
| --- | --- |
| `initial` | Immutable first view descriptor |
| `view` | Latest accepted descriptor; no global active project |
| `call(name,args)` | Standard `tools/call`; caller supplies finite schema and explicit view/workspace/CAS; checks success then prefers `_meta.icWorkbench.data` over model summary |
| `onResult(fn)` | Subscribes to subsequent host `ui/notifications/tool-result` descriptor updates; returns unsubscribe. Responses to caller's own `call()` update host.view but are returned directly, not re-notified |
| `onInput(fn)`, `toolInput` | Complete `ui/notifications/tool-input`; partial arguments never authorize operations |
| `updateModelContext(value)` | Bounded32KiB structured context with this view/workspace/revision; capability-gated, no chat send/sampling |
| `requestDisplayMode(mode)` | Only advertised inline/fullscreen; returns actual mode or `{supported:false,mode}` |
| `readResource(uri)` | Capability-gated `resources/read`, restricted `ui://ic-workbench/`, verifies returned URI |
| `capabilities`, `hostContext`, `onHostContext(fn)` | Negotiated read-only host state and updates |
| `notify(text,{kind})` | Local status, no model message |
| `assetBytes(path)` / `assetText(path)` / `assetURL(path)` | Registered embedded build assets only; bytes are Uint8Array; URL is local blob, never a gateway URL |

Older view revisions, cross-view messages and pinned identity changes are rejected. A narrow exception accepts simulation `run_id:null` → nonempty run only from the correlated successful `ic_view_bind_run` call with matching view/workspace/expected_revision/request_id, increased response revision, and otherwise identical identity. Server validates that request's accepted submit receipt; host cannot manufacture it. Ordinary notifications and other methods never get this exception. A workspace revision/live request summary can change while the view CAS revision stays the same.

Within one view revision, CAS fields (selection, draft/review/plan, display/visibility, readiness, pinned identity and receipt membership/identity) must remain equal. Object key order is immaterial. `workspace_revision` may only increase; `ui.available` is live build availability. Receipt state follows the existing Service transitions: pending approval → dispatching or an observed terminal outcome; dispatching → accepted/rejected/uncertain. Accepted, denied, rejected and uncertain are not reopened or relabeled. Skipped polling states are allowed, but older workspace/receipt responses are rejected atomically without replacing the current descriptor. No server schema or approval behavior changes are introduced.

## Bridge security and lifecycle

The small classic bootstrap sends `ui/initialize` before parsing the inert base64 package, then sends `ui/notifications/initialized` immediately after negotiation. Component imports, WASM and business data wait for complete tool input/result. This avoids blocking the installed host's approximately5s initialize timeout on the large schematic bundle.

The receiver requires `event.source === window.parent`, JSON-RPC2.0, expected request IDs/methods and view binding. Known parent origins are fixed. Opaque/no-referrer sandbox initialization uses the official transport's direct-parent `targetOrigin:'*'` fallback, learns origin only from the correlated response of that exact WindowProxy, and pins a nonopaque origin afterward. Sibling frames and incorrect origins/IDs are ignored. This is not a broadcast to arbitrary windows.

`ui/resource-teardown` disposes the component, revokes local blob URLs, rejects pending calls and acknowledges the host. Each resource has separate request IDs/listeners/state. Timeouts/host refusals surface errors and are never automatically retried. No approval-policy bypass, `ui/message`, sampling, or model-callable approval path exists here.

## Build

```sh
python3 -B tools/dev/build.py all
python3 -B tools/dev/check_structure.py
```

The existing `web/` build is unchanged. The plugin at `dist/ic-workbench/` adds exactly:

- `ui/schematic.html`
- `ui/waveforms.html`
- `ui/simulation.html`
- `ui/manifest.json`

No `ui/resources/` alias exists. AI MCP resource registration reads these exact paths. `tools/dev/mcp_ui.py` bundles relative ESM into an import map of local blob modules, including cyclic imports. Stylesheets/assets become embedded package bytes/data references. Static `new URL('./asset', import.meta.url)` references are rewritten; module workers get a closed data-URI graph. Unsupported bare/nonregistered imports and source symlinks fail the build. Browser-only Node fallback imports remain unreachable.

Assets come from `apps/codex/ui`, registered `modules` assets and pinned `apps/web/vendor/rnl-viewer`; no engineering project/design/sim/results/config/runtime paths are packaged. Schematic includes core WASM, packages module, fonts and internal renderer data; `loadCore(host.assetBytes('apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm'))` runs in its existing MCP iframe. No extra renderer resource/nested iframe required.

Partial owner checkouts may lack one or more component index.js files. Such generated resources explicitly display “component is not installed”; `ui/manifest.json` records `entry_present:false`. The final integrated build must require all three entries present. Bundles with all three actual owner snapshots have also been generated under the owner evidence directory, with dependency hashes.

## Host requirements and limits

The host sandbox must permit inline bootstrap, blob/data module assets, and for schematic WebAssembly compilation (`wasm-unsafe-eval`). Generated manifest `requires` declares asset schemes and WASM use. There are no external network domains; resource reads/tool calls travel through the bridge. A native host that disallows local blob modules/import maps or WASM cannot run that resource; a browser harness does not prove native policy acceptance. Server metadata and actual host CSP need integration verification.

Only standard inline/fullscreen is declared. Sidebar/thread entrypoints are registered through the server's supported OpenAI extension metadata; this code does not invent a “sidepanel” display mode or native window chrome. Actual installation and visible mounting remain integrator checks.

## Targeted validation

```sh
node --test tests/codex_ui/host.test.mjs
python3 -B tests/codex_ui/test_packaging.py
python3 -B tests/architecture/test_structure.py
node tests/codex_ui/browser.mjs
```

The browser test uses explicit synthetic view tools/components, separate host/resource origins, strict CSP, and the actual pinned RNL WASM (one resistor core build). It proves early handshake, three independently mounted/disposed resources, tools/call, private result data, model context, display capability and rejection of a sibling's message. It creates no model, simulator, source commit, approval or external request. Its report calls itself a harness, never a native Codex mount.

Protocol references used:

- Official MCP Apps stable specification: `https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx`
- Protocol types/version: `https://github.com/modelcontextprotocol/ext-apps/blob/main/src/spec.types.ts`
- Opaque-origin transport: `https://github.com/modelcontextprotocol/ext-apps/blob/main/src/message-transport.ts`
- OpenAI MCP UI guidance: `https://developers.openai.com/plugins/build/chatgpt-ui`
- OpenAI display modes/entrypoints: `https://github.com/openai/mcp-extensions/blob/main/docs/spec.md`
