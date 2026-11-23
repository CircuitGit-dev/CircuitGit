# Circuit testbench CI

CircuitGit records circuit versions as Git commits. Saving a cell CI selection writes its reviewed `lib/<library>/<cell>/ci.json`; committing and opening/updating a PR attaches the checks to that exact source commit. A local save alone does not run GitHub Actions or establish a new successful simulation.

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
{"schema":"circuitgit.spectre-ci.v1","client_config":"/private/workbench-client.local.json","testbenches":{"your-registered-tb-id":{"project_id":"your-runnable-project","configuration":"TRAN"}}}
```

4. Ensure the existing gateway has the exact requested circuit commit and a real runnable project/configuration binding with verified external dependencies. Public ADC archives are not automatically registered as runnable.

Dispatch with the explicit TB, full commit SHA and operation. `plan` materializes inputs; `preflight` performs the existing explicit remote tool/dependency checks. Neither means simulation success. `submit` and `collect` call the existing controlled Service and return a frozen human-review request. The workflow exits blocked while approval is pending, never executes CLI approval commands, and never replaces the engineering approval with GitHub environment approval. Review the request in IC Workbench, then observe its original run. `collect` requires the explicit matching existing run; `results` only reads already stored evidence and does not claim scientific acceptance.

The GitHub run ID creates a stable request key: rerunning the same workflow run retains it. Unknown/denied operations are not rekeyed or automatically replayed. A separate dispatch is a new explicit operator request. Artifacts expose only bounded request/identity observations, not raw licensed inputs, SSH targets, credentials or full results archives. Existing IC Workbench collection/publication remains responsible for those artifacts.

This first CI release delivers executable source/configuration/RNL checks and a protected adapter to the existing licensed simulation approval workflow. It does not claim that the published ADC candidates have been rerun, and it does not introduce a second approval engine.

GitHub reference: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions and https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments .
