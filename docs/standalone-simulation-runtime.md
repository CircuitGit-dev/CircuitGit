# Standalone Spectre runtime

CircuitGit's optional simulation runtime uses the separately installed, pinned SpiceOwl package for host probes, monitoring, Spectre diagnostics and PSF ASCII parsing. CircuitGit's existing Runner remains the only executor and native run ledger. The browser panel, paired helper, native agent and SpiceOwl CLI/Web reach this same runtime.

This path runs the remote Spectre executable without starting Virtuoso, ADE or OCEAN. Model files, license setup and external aliases remain on the execution server. Local source editing and configuration preview do not require local PDK files. A real launch still requires a registered source bundle, exact source commit, selected site's alias mappings, model pins and successful remote preflight. A testbench lacking a source bundle is not runnable merely because its schematic is visible.

## Configure one authorized connection

First configure the [explicit resource pool](spiceowl-resource-submission.md) and install the exact SpiceOwl commit in [the integration lock](../contracts/spiceowl-integration.lock.json) in the gateway's Python environment. Add this object to the private gateway configuration, substituting registered project and host IDs:

```json
{
  "simulation_direct": {
    "enabled": true,
    "projects": ["inverter"],
    "hosts": ["compute-a", "compute-b"],
    "callers": ["local-studio", "paired-helper", "native-agent", "spiceowl-local"],
    "operations": ["runtime", "resources_scan", "submit", "status", "watch", "unwatch", "collect"],
    "authority_key_file": "/absolute/private/simulation-authority.key",
    "resume_monitors": false
  }
}
```

Use only the callers and operations the operator authorizes. The private key is a regular owner-private file (0600) containing 32–128 bytes. Both the Service client and gateway use the same key; an operator can explicitly reference the existing gateway signing key. Never send the key, its path, SSH credentials or a caller selector to browser JavaScript or model tools. Requests bind caller, method, path, raw body and timestamp with HMAC; the gateway also retains its loopback, Origin and CSRF checks. Authorization is checked against project, operation and original execution host.

For paired helper/native agent calls, the private Service configuration also needs `simulation_direct` with its allowed projects, callers, operations and `authority_key_file`. The paired helper supplies `caller_id="paired-helper"` only after its pairing token and Origin checks. The trusted method is:

```python
service.execute_simulation(operation, arguments, idempotency_key=None,
                           caller_id="paired-helper")
```

The user-authorized direct path creates ordinary durable Service receipts with `authorization_basis: installed_connection_grant`. It never resolves or promotes pending manual requests. Without the explicit grant, existing manual simulation tools and review behavior remain available.

## Steps and interfaces

1. Select the registered project, configuration and full source commit. Local pool preview returns `needs_remote_preflight`; it never prepares a dummy/default model site.
2. Submit once with a stable action key. The resource pool checks fresh observations for allowed hosts, validates the CPU budget and chosen site's remote models/tools, and freezes the selection.
3. Runner reserves one native ID, rechecks that same host and stages an isolated run directory. An uncertain stage or launch is retained under its original key; it is never automatically moved or launched again.
4. When `watch` is included in the connection grant, the direct submission arms observation after dispatch. Otherwise arm a specific existing run explicitly.
5. After a terminal status observation, call `collect` for that exact run/project/configuration/source identity with its own stable key. An early call is rejected before claiming collection. The native archive is checked before shared PSF parsing; local CSV, units, metadata and archive inventory are bound to that run.
6. Read execution outcome, data validity and specification separately. Numerical completion does not imply that design requirements passed.

| Interface | Purpose |
| --- | --- |
| `GET /api/simulation/runtime?project_id=…` | Cached resources, monitor observations, diagnoses and caller capabilities |
| `POST /api/simulation/resources/scan` | Explicit scan with `{project_id}` |
| `POST /api/simulation/control` | `{operation, arguments, idempotency_key?}` |
| `GET /api/submissions/<encoded-original-key>` | Read the original submission mapping; never retry |
| `ic_sim_runtime` | Native agent reads the cached runtime |
| `ic_sim_execute` | Native agent uses the installed finite operation grant |

`runtime` and `resources_scan` accept only `project_id`. `submit` requires `project_id`, `configuration`, `source_commit`. `status`, `watch`, `unwatch` and `collect` additionally require the original `run_id`. Submit/collect require a stable key. Shell commands, model output, browser-selected caller IDs and approval flags are not accepted.

The [runtime schema](../contracts/spiceowl-runtime.v1.json) is separately versioned from [passive supervision](../contracts/spiceowl-supervision.v1.json). Five-second visible-panel refresh reads stored evidence; it does not scan servers. A resource scan is an explicit operation, and submission performs its own fresh selection and same-host recheck. Cached resource timestamps are displayed as observations, not reservations.

SpiceOwl has an independent entrypoint after its private `spiceowl.live-client.v1` configuration points to the gateway:

```bash
spiceowl live --client-config /absolute/private/live-client.json runtime
spiceowl live --client-config /absolute/private/live-client.json scan
spiceowl serve --live-client-config /absolute/private/live-client.json
```

Its live client fixes the caller to `spiceowl-local` and keeps uncertain submit/collect keys across restarts. Its ordinary unconfigured demo remains synthetic. A static GitHub Pages deployment cannot run SSH or host the gateway; a configured local connection is required for real operations.

## Monitoring and results

The shared monitor polls an explicitly watched run every 30 seconds, increasing disconnected retries up to 300 seconds. A failed SSH observation preserves the previous remote execution state and timestamp. Reconnection updates observation evidence without restarting the solver. Closing a browser or SpiceOwl client does not kill the job; the gateway process must remain running to observe it.

Watch registration and receipts persist. By default, after restarting the gateway, explicitly call `watch` to start its worker again. Setting `resume_monitors: true` authorizes process startup to resume existing watches whose original caller, project, configuration, source and host still pass current policy. Every subsequent monitor status call rechecks that grant. Construction and runtime GET never start a worker; stopped workers display paused observations. Monitoring does not automatically collect or call OCEAN, cancel, requeue or change scientific inputs.

The packaged diagnoser recognizes model/include, syntax, convergence, license and memory evidence. Exit 137 or SIGKILL alone is only suspected OOM. Redacted log excerpts and suggested actions are advisory data. They neither authorize shell execution nor automatically repair circuits or tolerances.

Native collection is at most one direct attempt per run. If its receipt is uncertain, inspect the saved run and collection evidence before any further action; there is no automatic collection replay. Locally derived display waveforms currently support one bounded PSF ASCII scalar transient with seconds as its time axis. Binary PSF, multiple transient files and unsupported axes remain preserved with unknown/unsupported display status. The original native archive is never rewritten to pretend the local CSV was produced remotely. Specification stays unknown until separately supplied, frozen acceptance criteria are actually evaluated.

## Validation and rollout

Both repositories deliver paired changes, shared schema bytes and an exact dependency commit. Run `tools/workbench/check_spiceowl_contract.py --spiceowl-root /absolute/spiceowl`, the affected Runner/runtime/Service tests, browser tests and package checks before installation. Tests use offline fixtures unless explicitly described as a real remote trial.

Building or pushing a branch does not upgrade an already running helper. Install/restart the gateway only under its service owner's lifecycle procedure, preserving active tasks and receipts. Never label an old runtime source snapshot as the newly edited library commit.
