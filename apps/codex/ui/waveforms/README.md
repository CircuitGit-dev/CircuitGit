# Independent MCP saved-waveform view

`index.js` exports `mount(root, host) → {ready, dispose()}`. The shared host mounts it for `ic_waveforms_open` / `ui://ic-workbench/waveforms.html`. `ready` is an optional data-load promise; callers only need `dispose` per the frozen contract.

Open with explicit identities:

```json
{"project_id":"real-sar-20261106","run_id":"20261109T054442Z-1d9279ef0b-014b97a6","workspace_id":"<returned workspace_id>"}
```

Omit workspace_id only when intentionally creating a new workspace. Each view remains pinned to its returned project/run/source; a different run needs another render-tool view. There is no global active project, browser popup, opener, legacy app selector, direct gateway fetch or nested model.

## Shared component and transport

This adapter imports the existing `modules/waveforms/panel.js` and style.css without modifying them. Rendering, min/max display envelope, full-data cursor interpolation, exact mapping/proof rules and current polarity remain shared. `host.assetURL` supplies packaged CSS; a standalone source fixture may preload that stylesheet itself.

All reads use `host.call('ic_view_data', {workspace_id,view_id,revision,query})` with only `runs`, `signals`, `mapping`, or bounded `waveform` queries. The host first unwraps `_meta.icWorkbench.data`; this adapter then validates its `{view,kind,payload}` wrapper before using payload. The adapter verifies exact run/source/signal/unit/checksum and rejects malformed sample/measurement responses. Calls are serialized with revision/abort checks so state writes cannot race queued reads. No single-run status/SSH endpoint is used.

The catalog and all-six action work independently of current schematic freshness. This view's historical descriptor has no authoritative current geometry, so its injected panel context deliberately cannot authorize schematic probes. Missing mapping is explicit and does not prevent saved catalog viewing; permission/conflict/protocol failures are not disguised as missing mapping.

Signal selection is saved by `ic_view_select` using expected_revision, validated by the server against the run catalog. Then `host.updateModelContext` receives only compact view/workspace/run/source identities, at most16 selected signals with units/polarity/count/checksum, time window, cursors and their measurement basis. It never receives curve arrays, full catalog/source text, token/config or arbitrary URLs. Ordinary style/layout changes do not start models or create chats.

A state write conflict or unknown outcome stops automatic context synchronization; the user can explicitly refresh the same pinned view. There is no blind retry. Foreign-view, old-revision or rebound-source notifications are rejected/ignored. Client readiness uses `ic_view_state(client_state='loaded')`; native host mounting is always described as unverified. Unsupported fullscreen is reported from the host response without claiming a new window.

## Usage

Select individual saved signal buttons, or **绘制已导出波形** for all six available curves. Use legend buttons to hide/remove; enter A=`1e-8`, B=`1.1e-8`, then **读取游标** for1ns separation. VDD0:p is158252 nativePSFXL samples, positive into p, original sign preserved. Selection and cursor context update automatically after reads complete. **更新模型上下文** explicitly resends the current compact selection; **刷新本视图** reconciles the same view after a conflict.

## Tests and remaining host work

- `node --test tests/codex/waveforms/*.test.mjs`:15 adapter/summary/exact-link tests.
- `tests/codex/waveforms/browser.mjs`:9 browser checks through an explicitly labelled host-contract fixture; real local gateway GETs for existing historical data, in-memory fixtures for view writes. Tests verify six curves, native full-source1ns cursors, bounded context, independent views, stale mapping, unsupported display mode, CAS conflict without retry, narrow layout and teardown. No native Codex mount claim.
- `tests/codex/waveforms/package.py --host-code <UI-owner-clone> --output <test-output>` creates a self-contained HTML with a read-only snapshot of the shared UI packager/host. This is an isolated build check, not shared source integration or installation.
- Existing architecture/build and waveform mapping tests remain passing. No modules/, backend contract, engineering data, production settings or approvals changed.

Root integrator merges the shared host/build/server owners, verifies exact resource install paths, and installs/tests actual Codex native mounting. Cross-window linking is implemented through `ic_workspace_get({workspace_id})`: **读取原理图选择** explicitly reads the latest published schematic selection, or the user can enable a stoppable2s follow timer. The schematic's run_id may be null; this wave view's own fixed run stays authoritative. The approved closed7-field selection.geometry, descriptor project/source SHA, canonical/export path, scope, occurrence and explicit terminal are compared to the real saved mapping and exact source proof. Missing/stale/library/ambiguous objects fail closed; catalog plotting remains usable. Current links preserve scale+1 and original signal polarity; reverse-sign mappings are explicitly unsupported rather than silently flipped. Device selections show only verified mapped terminal choices; choosing p rechecks the source view revision before adding. A completed match updates this wave view by CAS and includes bounded linked-source evidence in model context. The initial empty waveform view never clears another view's latest workspace selection. No peer messaging or Esc-to-open popup is introduced.

`tests/codex/waveforms/cross-browser.mjs` exercises two **actual packaged MCP resources and the shared JSON-RPC host bridge** in independent iframe documents with the same workspace. It physically clicks VINP/ROP/VDD0 in the real native renderer, publishes the schematic selection, selects mapped p explicitly, loads real historical waveforms/cursors, checks unknown VDD and follows/stops polling. Server workspace/CAS state is an in-memory fixture; data is read-only from8766 and hash-verified local native files. This proves the protocol/resource integration in a browser harness, not actual desktop mounting.
