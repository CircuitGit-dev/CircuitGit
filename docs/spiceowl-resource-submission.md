# Resource-aware simulation submission

The optional SpiceOwl adapter selects from an explicit server pool before the existing CircuitGit Runner submits a simulation. With no `spiceowl_pool_file`, the gateway retains fixed-site operation. The local simulation controller and IC Service carry the frozen plan through their existing confirmation/review flow. An explicitly configured [standalone runtime](standalone-simulation-runtime.md) also supports direct calls under the operator's installed grant. This does not automatically enable the full submission panel on GitHub Pages or update an already-running helper.

## One submission, six steps

1. **Preview locally.** Compile/materialize the selected project, source commit and configuration. `/api/plan` returns `state: needs_remote_preflight` and `resource_selection_required: true` for pool mode. This previews the materialized configuration without a remote scan or default-site model substitution; only the selected host's later preflight creates an executable plan. Inputs must be clean, tracked and approved for distribution, or covered by the existing signed materialization proof.
2. **Scan and preflight.** Explicit `/api/preflight` scans the configured 1–32 registered hosts through the external SpiceOwl API. Check CPU activity, 1/5-minute load, available memory, home disk space, host/user identity and Spectre version. Select an eligible candidate and run the normal site preflight. A simulator version check does not check out a license.
3. **Freeze the target.** The gateway signs the chosen site, resource observations, bundle digest/path, project/source/configuration identity and preflight result using its existing private signing key. The returned `execution_plan_id` is the SHA-256 of that complete record. The browser and IC Service include the same target in the existing human review. No new approval endpoint or ledger is introduced.
4. **Reserve and recheck.** Submit with the existing idempotency key and that exact plan ID. The gateway resolves the signed record without selecting again. Runner records the native run ID, frozen site and context, then scans only the selected host before any staging. It rejects changed host/profile/version or inadequate current resources.
5. **Launch once.** Runner uses its existing isolated staging directory and permanent remote launch claim. Lost stage/launch responses remain uncertain. Query the same submission key/run; do not create a replacement key to bypass uncertainty.
6. **Read and collect from the same host.** Status, native result collection and optional OCEAN postprocessing use the run's saved site even if the gateway's default site changes. Evaluate execution, waveform validity and specification separately. A successful process exit alone is not scientific acceptance.

The default policy retains 20% CPU and memory headroom after the request, rejects CPU busy above 80%, requires resource observations no older than 120 seconds, and checks at least 1 GiB free on the home filesystem. Ranking maximizes remaining bottleneck slack, then memory slack, then freshness. Home free space does not establish free space or quota in another run filesystem.

There is no resource reservation or operating-system memory limit in this adapter. Memory is the operator's planning estimate. Multiple gateways can observe the same free capacity. The optional standalone runtime provides persistent status monitoring with reconnect backoff; distributed scheduling, Slurm/LSF admission, automatic OOM recovery and numerical-option repairs remain separate work.

## Private operator configuration

Install the exact external SpiceOwl commit in [the integration lock](../contracts/spiceowl-integration.lock.json) into the Python environment that starts the gateway. Keep the external implementation in its own repository. The gateway lazily imports `spiceowl.integrations.circuitgit_pool` when a preflight is requested; startup does not probe hosts.

Add one optional field to your private existing `workbench.local.json`:

```json
{"spiceowl_pool_file": "/absolute/private/spiceowl-pool.json"}
```

Retain the normal `site_file`, project registry, runtime directory and existing approval policy. Use this shape for the private pool file:

```json
{
  "schema": "ic.spiceowl-pool.v1",
  "spiceowl_data_dir": "/absolute/private/spiceowl-state",
  "requirements": {
    "cpu_count": 2,
    "memory_bytes": 4294967296,
    "simulator": "spectre"
  },
  "members": [
    {"host_id": "compute-a", "site_file": "/absolute/private/site-a.json"},
    {"host_id": "compute-b", "site_file": "/absolute/private/site-b.json"}
  ]
}
```

Host IDs must already exist in SpiceOwl's private registry; arbitrary LAN discovery does not create execution authority. Each site uses CircuitGit's existing `ic.sim.site.v1` shape:

```json
{
  "schema": "ic.sim.site.v1",
  "ssh_target": "compute-a",
  "expected_host": "compute-a",
  "expected_user": "researcher",
  "remote_runs_root": "/home/researcher/ic_on_github_runs",
  "cadence_cshrc": "/opt/site/cadence-setup.csh",
  "spectre_bin": "/opt/cadence/tools/bin/spectre",
  "external_files": {}
}
```

These are fictional paths. Use explicit operator-controlled aliases with working SSH identity, jump-host and host-key settings. Resource probing and execution may use different routes, but `expected_host`, `expected_user` and `spectre_bin` must match the selected registered profile. In particular, a SpiceOwl v2 `ssh_hostname` override is not automatically understood by CircuitGit's v1 site transport: provide a matching working SSH alias. Keep credentials, PDKs, license configuration, frozen plans and real receipts outside Git.

The serial `spectre-default` profile with `args: ["-64"]` requests one CPU. Other accepted local profiles require exactly one explicit `+mt=N`, with `N <= cpu_count`. The pool adapter currently permits `-64`, `+aps`/`++aps`, `+mt=N`, and numeric `+lqtimeout`, `-maxw`, `-maxn` options. Automatic/distributed/unknown threading profiles are rejected before scanning. These checks compare the plan to the pool budget; they do not reserve cores or estimate memory from a netlist. Use a pool budget appropriate for the configured analyses.

## Failure and historical behavior

| Event | Saved result | Next action |
| --- | --- | --- |
| No eligible host or selected-site preflight fails | No executable plan or launched run | Inspect the returned failure and observations; explicitly preflight again when conditions/configuration change |
| Wrong/missing/tampered plan ID, changed bundle or identity | Submission rejected before reserve/dispatch | Use the correct frozen plan; changes need a new review |
| Selected host loses capacity before staging | `preflight_failed`, zero launch attempts, rejected `prelaunch_resources` | Keep the failed run; a deliberate new attempt uses a new plan/key and review |
| SSH response lost after stage or launch | Original uncertain run/key retained | Query/reconcile that run; never automatically relaunch or move it |
| Default site later changes | Existing run still uses its frozen site | Status/collection remain bound to the original run |
| Legacy run lacks a frozen site | Old default-site behavior only when saved SSH target matches | A mismatch blocks remote access; do not infer a new target |
| Process completes without valid expected waveforms | Execution evidence remains separate | Preserve native files and report invalid/incomplete measurements |

Saved run projection may include `execution_target` with opaque host ID, plan ID and original resource observation time. It never includes the private site or routing profile. Snapshot `single_site: false` means the gateway is configured for a pool; it does not establish that multiple hosts have executed runs. Reading a supervision snapshot or SpiceOwl MCP cache never scans, dispatches, collects or monitors.

Signed materialization library/cell metadata is carried with the historical run. Never classify old runs using today's selected library. The existing CI operator still checks project, source commit and configuration for collection/results and prepares normal human review for submissions. Pool mode does not bypass that contract.

## Paired changes and checks

A simulation integration feature is one deliverable across CircuitGit and SpiceOwl. Update both adapters, byte-identical supervision schemas, tests, documentation and this repository's exact-commit lock together, then hand off both PRs. The user does not need a separate synchronization task. Keep unrelated changes and live gateway restarts under their existing owners.

From this CircuitGit checkout, with Python 3.11+ and the compatible external environment:

```bash
python3 -B tools/workbench/check_spiceowl_contract.py --spiceowl-root /absolute/spiceowl
PYTHONPATH=tools/sim:tools/workbench python3 -B -m unittest discover -s tools/workbench -p 'test_spiceowl*.py'
python3 -B tools/workbench/test_runner_execution_binding.py
python3 -B tests/ai/test_resource_pool_submit.py
node --test tests/studio/simulation-resource-plan.test.mjs tests/studio/supervision.test.mjs
```

From the pinned SpiceOwl checkout:

```bash
CIRCUITGIT_ROOT=/absolute/CircuitGit PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_circuitgit_supervision_contract.py'
```

These checks use synthetic data, local Git fixtures and loopback HTTP. They do not launch Spectre. A real trial needs its own authorized environment, original or distributable committed input, exact selection/launch receipts, and native waveform validation. Build/import tests prove packaging; they do not prove that the running helper or public demo has loaded the update.
