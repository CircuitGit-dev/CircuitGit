# Shared interface v1

Machine truth: `python3 ic_workbench.py --json schema`. Every schema has `additionalProperties:false`. Values are JSON data, not executable commands. Installed config controls gateway URL and timeouts; model input cannot change those or site/SSH/model credentials.

| Tool / CLI | Gateway | Effects |
|---|---|---|
| ic_projects / projects | GET /api/project | persisted read |
| ic_read / read | GET tree/file/schematic | authoritative content + commit/hash + geometry provenance |
| ic_diff, ic_validate | POST changes/preview | local review/compiler writes, no source commit |
| ic_apply / apply | POST changes/commit after human approval | runtime Git commit only; push:false |
| ic_sim_plan / sim-plan | POST plan | local signed materialization |
| ic_sim_preflight | POST preflight | remote SSH read/check |
| ic_sim_submit | POST jobs after human approval | remote dispatch; caller key persisted first |
| ic_sim_status | GET jobs or jobs/ID | list persisted; single ID may SSH and persist observation |
| ic_sim_results | GET jobs/ID/results | persisted result metadata/waveforms/artifact URLs |
| ic_sim_collect | POST jobs/ID/collect after human approval | OCEAN, raw collection/archive |
| ic_sim_archive | POST jobs/ID/publish after human approval | private Git index/Release upload |
| ic_request_status | local durable receipt | read only |

`read` carries project_id, optional registered path, and optional cell/scope label. Cell/scope labels are explicit user context, not a claim that a whole file is that cell. Geometry metadata remains as reported by upstream; baseline viewer availability does not count as native geometry fidelity. Source SHA is supplied to phase3 schematic API. No native file endpoint is editable.

`diff` requires project_id/base_commit and 1..20 `{path,content,sha256}` entries. Only editable paths in that project's actual tree are accepted. The local review ID binds the gateway, project, exact body and actual diff. `apply` requires that review ID, message and stable caller key; the frozen bytes are previewed again before a request is created. Approval binds the request fingerprint. The existing gateway atomically rechecks base/source hashes and clean state before committing.

Human control plane: CLI `approve/deny` or POST `/api/ai/approval`. These operations never appear in MCP/dynamic tool definitions. CLI users approve a displayed fingerprint; browser approval binds the currently pending app-server request+thread+turn. One durable request record is fsynced before sending. Dispatching/unknown receipt is not replayable. The same key with changed input conflicts. No timeout triggers token refresh/retry or new key generation for a mutation.

## Web endpoints behind existing guard

- GET `/api/ai/catalog`, `/api/ai/context?project_id=...`: sidecar convenience metadata only. Integrated production panel uses the UI-owned adapter.
- GET `/api/ai/events?after=N`: JSON event cursor, or SSE with `Accept:text/event-stream`; reconnect uses Last-Event-ID and only replays events. Gaps are explicit.
- POST `/api/ai/doctor`: normal app-server nonsecret login/model/config status; no model turn.
- POST `/api/ai/turn`: `{message,context,idempotency_key}`. Full source is read only through the allowlisted tool; browser context is untrusted metadata. Runtime re-fetches exact file/base/hash and rejects dirty/stale context.
- POST `/api/ai/approval`: `{approval_id,decision:'approve'|'deny'}`. Human only. Unsupported native requests are retained and cannot be accepted through this surface; denial uses exact installed Codex schemas.
- POST `/api/ai/interrupt`: suspend turn/pending decisions and send actual `turn/interrupt`. Does not cancel remote simulation.

The gateway's exact Host/Origin/Content-Type/CSRF guard and 2 MiB body bound must run before dispatch. No CORS, arbitrary RPC forwarding or cross-origin credential transport.

## One context adapter, separate components

UI phase4-context actual code now publishes frozen `window.ICWorkbenchContext` with exactly `getContext`, `subscribe`, `readSelection`. Consumed interface version: 1. `web/integrated.js` imports the app module first, then passes that public object to mountAI; no closure state is accessed. The same public object is available to the waveform owner:

```js
const contextAdapter = { getContext, subscribe, readSelection };
mountAI(document.querySelector('#ai-panel'), {contextAdapter});
// Waveform owner receives the same contextAdapter at its separate mount.
```

getContext returns an immutable `{version:1,revision,project,file,selection,geometry,run}` matching UI's ai-context-interface. subscribe returns unsubscribe. This component does not implement/reach into UI's closure-local state, viewer DOM or editor. readSelection is reserved for an explicitly authorized bounded range and is not currently used by the full-file read tool.

Preserve null/unknown reasons for occurrencePath, terminalName/terminal, netName, busBit and waveform channel mapping. A scope definition is not a unique instance occurrence. No waveform or current mapping is inferred. Future signal tools must call the waveform owner's installed allowlisted signal API, with saved-channel/source/run checks. No waveform component is duplicated here.
