# Circuit testbench CI

CircuitGit records circuit versions as Git commits. Saving an authorized cell CI selection writes `lib/<library>/<cell>/ci.json`; committing and opening/updating a PR attaches the checks to that exact source commit. A local save alone does not run GitHub Actions or establish a new successful simulation.

## Select checks

The trusted `config/library-testbenches.json` registry contains one RC source check and five historical ADC Spectre configuration candidates. Selection uses this exact shape:

```json
{"schema":"circuitgit.cell-ci.v1","library_id":"basics","cell_id":"rc-smoke","enabled":true,"testbench_ids":["rc-smoke-tran-source"]}
```

Only IDs registered to the current cell are accepted. Explicit `enabled:false` disables its selected TB checks. If a cell has no CI file, RC uses the `rc-smoke-tran-source` default; ADC cells have no implicitly selected simulation. `available:true` in the registry means selectable, not that a licensed runtime or complete external models are installed.

## Automatic PR source checks

`.github/workflows/circuit-ci.yml` runs on hosted Ubuntu for library/project changes. It uses checker code from the PR base and candidate data from the exact head SHA. It validates the full public manifest inventory, affected source/include/package closures, selected configuration schemas and hashes, and builds affected RNL Documents using the trusted bundled WASM. It neither compiles application output nor starts a model, SSH connection or simulator. The read-only token is not persisted in the checkout.

Reports are uploaded as `circuit-source.json` and `rnl-build.json`. Each selected TB is identified separately with its configuration hash, input hashes, source-check status and independent simulation status. A successful source check means structurally valid input for the implemented checks. It is not electrical validation, Spectre convergence, ADC accuracy, noise/PVT signoff or measured performance. Missing external models remain explicit blockers for simulation. Historical settings without a bundle are reported as such.

Run the same finite checks locally with a clean candidate checkout:

```bash
python3 -B tools/ci/check.py --root /path/to/candidate --base BASE_40_CHAR_SHA --head HEAD_40_CHAR_SHA --report /tmp/circuit-source.json
node tools/ci/rnl-check.mjs /path/to/candidate /tmp/circuit-source.json /tmp/rnl-build.json
```

Omit both commits for a working-tree source audit; its `source_commit` is null. `--head` alone audits all cells at that exact clean checkout. Checks never infer simulation results from structural success. Hashes bind the report to the inspected inputs; a subsequent save requires a new check.

## Opt-in licensed Spectre workflow

`.github/workflows/circuit-spectre.yml` is manual only and can be dispatched only from `main`. It fails explicitly as **BLOCKED** until the repository owner sets `CIRCUITGIT_SPECTRE_ENABLED=true`. Before enabling:

1. Configure a restricted `circuitgit-spectre` environment with required human reviewers, prevention of self-review where available, and a main-only deployment branch rule. GitHub environment protections depend on repository/plan support; do not enable this path without the protections.
2. Dedicate a self-hosted runner labelled `circuitgit-spectre`, restrict its repository access, and install a reviewed copy of the application/tools at `/opt/circuitgit-ci`. Do not checkout PR branches or run PR-modified scripts on that runner. Updating this installed copy is an operator task.
3. Create `/etc/circuitgit/ci.local.json` as an operator-owned, non-group/world-writable file. Keep credentials, PDK paths, model files and licensing settings in the private workbench configuration. Example:

```json
{"schema":"circuitgit.spectre-ci.v1","execution_mode":"manual","client_config":"/private/workbench-client.local.json","testbenches":{"your-registered-tb-id":{"project_id":"your-runnable-project","configuration":"TRAN"}}}
```

4. Ensure the existing gateway has the exact requested circuit commit and a real runnable project/configuration binding with verified external dependencies. Public ADC archives are not automatically registered as runnable.

Dispatch with the explicit TB, full commit SHA and operation. `plan` materializes inputs; `preflight` performs the existing explicit remote tool/dependency checks. Neither means simulation success. Omitted `execution_mode` defaults to `manual`: `submit` and `collect` return the existing frozen human-review request. The workflow exits blocked while that approval is pending and never executes CLI approval commands. Review the request in IC Workbench, then observe its original run. An existing manual request is never promoted to direct authorization. `collect` requires an explicit matching existing run; `results` only reads already stored evidence and does not claim scientific acceptance.

### Direct execution with an installed connection grant

An operator can select the direct adapter in that same trusted settings file:

```json
{"schema":"circuitgit.spectre-ci.v1","execution_mode":"direct","client_config":"/private/workbench-client.local.json","testbenches":{"your-registered-tb-id":{"project_id":"your-runnable-project","configuration":"TRAN"}}}
```

This setting selects the execution route; it does not grant access. The installed Service must already have `simulation_direct.enabled:true` and explicitly allow the `native-agent` caller, requested operation and exact project. The gateway independently checks its installed project, caller, operation and host scope, plus the pinned circuit/run identity and configured resource pool. The adapter cannot enable these grants, alter their configuration, choose a replacement host, or fall back to the manual route. A missing direct-capable Service or a rejected grant blocks the request.

For `submit`, the adapter calls `Service.execute_simulation` with the registered project/configuration and full source commit. For `collect`, it also passes the explicit `run_id`; the Service and gateway validate that bound run. The caller is fixed to `native-agent`, and the stable key is passed separately. This route executes within the existing grant without creating a second IC Workbench approval popup. GitHub workflow enablement and the environment's configured access rules still apply. `plan`, `preflight` and `results` keep their existing read/check flows in both modes.

The direct Service owns the durable execution ledger. Only its explicit `accepted`, `complete` or `succeeded` receipt can produce a CI report with `status:accepted`, and a nested unknown, partial, failed or mismatched result still blocks that report. Acceptance identifies the request, not a successful solver exit or completed scientific check. A collection receipt can be `collecting`; the report preserves that state and continues to label simulation acceptance `not_evaluated`.

Reports retain the original action key, bounded request ID/fingerprint and returned state so an operator can reconcile the existing Service receipt. Unknown, partially completed and interrupted requests remain blocked with `automatic_retry:false`; the adapter never loops, replaces the key or opens a manual approval as a fallback. It omits raw nested receipts that may contain private gateway or runtime details; the complete original receipt stays in the installed Service ledger. An accepted request exits `0`, a receipt needing reconciliation exits `10`, and an unsupported direct Service or local authorization rejection exits `2`.

The GitHub run ID, TB, source commit, operation and explicit run ID create the same stable key in either mode; the GitHub retry attempt number is not part of it. Rerunning the same workflow run therefore returns the original Service receipt rather than creating another dispatch. Unknown/denied operations are not rekeyed or automatically replayed. A separate dispatch is a new explicit operator request, still subject to unresolved-prior-request guards. Artifacts expose only bounded request/identity observations, not raw licensed inputs, SSH targets, credentials or full results archives. Existing IC Workbench collection/publication remains responsible for those artifacts.

The CI integration provides source/configuration/RNL checks and adapters to the existing manual or directly authorized simulation Service. It does not claim that the published ADC candidates have been rerun, and it does not introduce a second approval engine.

GitHub reference: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions and https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments .
