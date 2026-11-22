This is the canonical plugin and CLI source. Build the installable folder with `python3 -B tools/dev/build.py codex`; do not distribute this source folder alone. The installed plugin starts through `plugin_entry.py`, connects or starts its local gateway lazily, and serves three MCP App resources. Native Codex does not launch the optional web AI bridge. See the [plugin guide](../../docs/plugin.md).

# IC Workbench Codex / CLI adapters

Python 3.9+ CLI, stdio MCP, Codex plugin and browser AI component share one finite gateway client. The installed IC gateway remains the only Git/Spectre/OCEAN/publishing executor. No pip dependencies. Existing Codex login/model/provider settings are used unchanged. End users use the plugin and host confirmation; the CLI examples below remain developer/compatibility interfaces.

## Run without installing

Copy `config.example.json` to a local private config outside versioned design sources. Set `gateway_url` to the installed `http://127.0.0.1:PORT` and `state_dir` to a durable user-owned directory. The example is configuration, not credentials. No SSH/GitHub/API token is needed in this file.

```bash
python3 -B ic_workbench.py --json schema
python3 -B ic_workbench.py --config /absolute/client.json --json projects
python3 -B ic_workbench.py --config /absolute/client.json --json read --project-id rc-smoke
python3 -B ic_workbench.py --config /absolute/client.json --json sim-status
python3 -B ic_workbench.py --config /absolute/client.json --json doctor
python3 -B ic_workbench.py --config /absolute/client.json mcp
```

Choose actual IDs returned by `projects`; the RC name above is an example. `doctor` reads account/config status through official app-server APIs and emits only nonsecret fields. Effective approval settings are taken from `thread/start`, since unset config values are not effective settings. Unsupported protocol/model/manual approval mode fails explicitly, without switching provider or changing approval policy.

## Review and execute

`changes.json` is an array of `{path,content,sha256}`. Content is a full replacement of an editable authoritative file; SHA256 is the previously read exact bytes. A missing hash is rejected. The `diff` command runs the actual gateway compiler validation and returns a real unified diff plus a local frozen `review_id`.

```bash
python3 -B ic_workbench.py --config /absolute/client.json diff --project-id PROJECT --base-commit FULL_COMMIT --changes changes.json
python3 -B ic_workbench.py --config /absolute/client.json --json apply --review-id REVIEW_HASH --message 'Adjust resistor' --idempotency-key UNIQUE_STABLE_KEY
# A HUMAN reviews the returned diff/request/fingerprint, then runs ONE of:
python3 -B ic_workbench.py --config /absolute/client.json --json approve --request-id REQUEST_HASH --fingerprint EXACT_FINGERPRINT
python3 -B ic_workbench.py --config /absolute/client.json --json deny --request-id REQUEST_HASH --fingerprint EXACT_FINGERPRINT
```

`apply`, `sim-submit`, `sim-collect`, `sim-archive` prepare durable requests and return exit 10 while awaiting approval. They do not execute until the human resolves the exact request. No approve tool is offered to the model. `apply` never pushes. `sim-archive` means private GitHub `/publish`, including result-branch writes and Release upload; it is not a local read.

```bash
python3 -B ic_workbench.py --config /absolute/client.json --json sim-plan --project-id PROJECT --configuration CONFIG --source-commit COMMIT
python3 -B ic_workbench.py --config /absolute/client.json --json sim-submit --project-id PROJECT --configuration CONFIG --source-commit COMMIT --idempotency-key UNIQUE_STABLE_KEY
python3 -B ic_workbench.py --config /absolute/client.json --json sim-status --run-id RUN_ID
python3 -B ic_workbench.py --config /absolute/client.json --json sim-results --run-id RUN_ID
python3 -B ic_workbench.py --config /absolute/client.json --json sim-collect --run-id RUN_ID --idempotency-key UNIQUE_COLLECT_KEY
python3 -B ic_workbench.py --config /absolute/client.json --json sim-archive --run-id RUN_ID --idempotency-key UNIQUE_ARCHIVE_KEY
```

`collect` may run remote OCEAN. Single-run status may SSH and persist observations; status without run ID and results are persisted reads. A submit 202 is only acceptance. Timeout/crash/unknown response retains `dispatching`/`uncertain` with exit 75. Never rekey/replay it: inspect `request-status --request-id ...`, persisted jobs and original run receipt. Repeat approval of an accepted or uncertain request cannot send again. Accepted async collect/publish requests require status/results observation; completion is not inferred.

Exit codes: `0` success/accepted, `2` invalid input/config, `3` conflict/stale, `4` forbidden/denied/rejected, `10` pending human approval, `75` unknown outcome/timeout. Use `--json` before the subcommand for a stable `{schema,ok,operation,data}` or `{schema,ok,error}` envelope. No arbitrary commands or URL arguments are accepted.

## Codex plugin / MCP

The root `plugin.json`, `mcp.json`, and `skills/ic-workbench/SKILL.md` are the current Agent Plugins portable format. Verified by installed Codex `0.167.0-alpha.3.2` `plugin/read`: manifest, Skill and MCP server recognized, `installed:false`. The same installed Codex's actual `mcpServer/tool/call` successfully read the formal RC source through stdio. See `docs/install.md` for dry-run/install/uninstall. Installation is deliberately a separate user action.

## Browser AI

```bash
python3 -B ic_workbench.py --config /absolute/client.json serve-ai --port 8767
```

The optional sidecar is an isolated browser test host; production integration uses the same `AiRoutes` behind the existing gateway guard. It launches ordinary official `codex app-server --listen stdio://`, uses experimental `dynamicTools`, streams SSE progress, returns actual tool results/diffs, binds human decisions to pending RPC/turn/request IDs, and supports interruption. It creates ephemeral scratch conversations only, inherits the model/provider and requires effective manual approvals. Thread-scoped permissions are read-only and unrelated connectors/shell/browser/native editing are disabled. Native/unknown approval forms are displayed and suspended or explicitly declined, never guessed/auto-approved.

The web model bridge does not expose credentials, arbitrary RPC or approval as a tool. A 20-second lost-browser heartbeat suspends the turn. SSE reconnect replays events only. Saved turn/request keys prevent restart replay. A failed approval delivery preserves the actual accepted/uncertain receipt; it never dispatches downstream again. Interrupting AI does not cancel an already submitted simulation, since the gateway has no cancellation API.

Use UI owner's single `getContext/subscribe/readSelection` adapter for both AI and waveform components. `mountAI(element,{contextAdapter})` only consumes it. No closure-local app state/global is assumed. See `docs/interface.md` and `docs/integration.md`. This package does not implement the waveform component or claim unsaved/native geometry synchronization.

## Verification

```bash
IC_UPSTREAM=/absolute/IC_on_Github python3 -B tests/test_service.py
IC_UPSTREAM=/absolute/IC_on_Github python3 -B tests/test_ai.py
```

Tests create local **synthetic** resistor repositories and actual upstream gateway/compiler/runner reservation; remote dispatch is explicitly mocked. They do not invoke Cadence or GitHub. Actual model+gateway and Chrome evidence is shipped separately from code. Real new Spectre submission/collection/publication remains subject to coordinator slot and normal human approval; three existing successful runs were only read.

Runtime state includes private source diff/provenance. Keep it local/private and out of Git. This is a trusted single-user loopback client, not a public service or general process sandbox. Native runtime/model protocol changes need revalidation; failure is explicit.
