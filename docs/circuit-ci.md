# Circuit testbench CI

## Agent-authored cell testbenches

An Agent may propose a complete testbench for any catalog-owned library/cell using
`ic_library_propose_testbench`. The proposal includes literal Spectre text,
`analysis.py`, a complete `ic.agent_testbench.v1` manifest, a title/body, and the
exact current source commit. The manifest's `text` must equal the submitted
testbench. A proposal freezes local review data without changing engineering
files or submitting a simulation.

The library **Testbench CI** tab shows every file diff and separate SHA-256
identities for the cell source closure, testbench, Python script, experiment
manifest and acceptance criteria. **打开完整审阅** opens the existing paired
browser review form. Only the correlated human confirmation registers the bundle;
there is no Agent `approve` or direct `register_testbench` execution operation.
Changes to the source, branch, inventory, staging or reviewed bytes invalidate
the frozen request.

Confirmation checkpoints and versions these files in one scoped Git commit:

```text
lib/<library>/<cell>/testbenches/<id>/testbench.scs
lib/<library>/<cell>/testbenches/<id>/analysis.py
lib/<library>/<cell>/testbenches/<id>/manifest.json
lib/<library>/<cell>/testbenches/index.json
```

`manifest.json` is an `ic.testbench_ci.v1` envelope containing the authored
manifest and exact content bindings. The index records its digest. Unrelated
staging and the original circuit files stay intact. Updating a registered bundle
requires another complete review and creates a new commit; existing history is
never reset. Ordinary source-save operations cannot edit reviewed bundle files.
Registration does not push, submit a solver or report CI success.

Executable postprocessing currently uses the manifest's finite recipe:

```json
{
  "postprocess": {
    "operation": "spec_analyze",
    "inputs": {"samples": {"name": "out", "analysis": "tran", "quantity": "voltage"}},
    "parameters": {"backend": "spiceowl", "signal_unit": "V"}
  },
  "criteria": [{"metric": "sndr_db", "op": ">=", "threshold": 60, "unit": "dB"}]
}
```

This is an excerpt, not a complete Agent manifest. Supported named operations are
`spec_analyze`, `coherent_fft`, `sine_fit3`, `sine_fit4`, `weight_calibrate`,
`reconstruct_codes`, `histogram_linearity`, and `tran_metrics`. Backends are
explicitly `spiceowl` or `adctoolbox`; the installed algorithm adapter verifies
availability and numerical options. Input names resolve uniquely against the
exact collected run's `psf_name` and optional analysis/quantity/unit. Exact current
signal IDs are also supported; time uses `time_s: "@time"`. Decision inputs use
ordered lists of selectors. Missing or ambiguous mappings block dispatch.

The trusted host calls `tools/ci/testbench_bundle.py::run_registered_analysis`
with the exact registration commit and an independently verified runtime binding:
cell identity, primary and supporting sources, testbench digest, intake/job,
runtime commit, archive digest and same-run signal catalog. Callers cannot supply
their own trusted binding through the Agent tool. A Git manifest alone is not
execution authority: this host must retain the completed human-registration
receipt for that exact version. Remote simulation remains separately authorized
by its original review/grant; the analysis entry starts no SSH or solver.

The source binding also includes the cell inventory/alias digest. Runtime binding
matches only the primary source's actual electrical include closure, using
committed logical aliases and exact supporting-file hashes; README, provenance
and drawing files remain version-bound but are not imported as simulator inputs.
The installed bounded Spectre statement parser handles quoted strings, line
comments and continuations. Computed includes, includes escaping the intake root,
unsupported include languages (including the current `ahdl_include` path), and
block comments outside that parser's subset explicitly block this binding. No
source text is rewritten to conceal an unsupported dependency.

CI runs `OnboardingAnalysis.analyze` over full-resolution saved data. It validates
the returned source/run/archive, CSV and raw-data hashes, selected signals,
request digest, algorithm version/backend and every numerical acceptance
criterion before saving an `ic.testbench_ci_result.v1` record. Undefined metrics,
unit mismatches, downsampled input and inconsistent reported passes cannot become
passing results. `get_testbench_result` reads one exact result ID. An uncertain
dispatch preserves its original key and is never automatically repeated.

**Python execution boundary:** `analysis.py` is syntax-checked and versioned for
human review and reproducibility. This CI entry does not execute arbitrary
Python; it executes only the reviewed manifest's named recipe. Results explicitly
record `script_executed:false`. A matching reproducible `spec_analyze` script is
provided in [the reference analysis.py](examples/testbench-spectrum-analysis.py).
Run that script manually only in the separately installed pinned SpiceOwl
environment with a full CSV and its verified hash. Numerical script output alone
does not establish complete run provenance or CI acceptance.

GitHub's ordinary source-check workflow now also verifies registered bundle
identities and all source/TB/script/criteria digests. Its report labels these as
`reviewed-bundle-source-check` with `analysis_status:not_run`; it never runs a
candidate Python file or turns source-check success into electrical validation.

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
