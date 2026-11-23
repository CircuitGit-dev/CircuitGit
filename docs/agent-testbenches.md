# Agent-authored testbenches

CircuitGit can prepare a testbench supplied by a user or Agent for a general
Spectre subcircuit. The Agent declares the experiment; the application does not
infer that every imported circuit should be tested as an inverter. The existing
inverter smoke workflow remains an explicitly selected compatibility mode.

## From source to a reviewed run

1. Import the literal DUT source with `mode: "agent-tb"`. Supply relative include
   files as `support_files: {"relative.scs": "literal source"}`. Import stores
   only these bytes; it does not read a caller-supplied local path.
2. Read `ic_onboarding_source` and write a complete `ic.agent_testbench.v1`
   manifest through `ic_onboarding_agent_tb_draft`. Declare exact DUT port
   bindings, stimuli, analyses, objectives, acceptance criteria and
   postprocessing. The UI shows the full Spectre code and manifest for editing.
   A draft can be saved before a PDK is selected.
3. Select allowed SSH hosts, inspect their setup and select an observed model
   entry/section. Preparation checks the selected dependency closure again and
   freezes source/support bytes, TB, model hashes, execution scope and criteria
   into one review. Missing or ambiguous dependencies block preparation.
4. Read the complete review. In the browser, **审阅通过并运行仿真** opens the
   independent local review page; its human confirmation performs the one run
   request. In native MCP, `ic_onboarding_run` creates a pending request and
   `ic_request_review` asks the host for the human decision. No Agent-facing
   approval flag, approval tool or review signing key is provided. Full developer
   access does not promote this request to automatic approval.
5. Inspect that exact job and collect its native results. View supported saved
   waveforms and run named analyses over the full-resolution data. A new source,
   TB, PDK selection or criterion requires a new preparation and review.

The manifest has these required fields:

```text
schema: ic.agent_testbench.v1
text: full literal Spectre TB
interface: {subckt, instance, port_bindings}
analyses: [{name, kind: tran|ac|dc, parameters}]
stimuli: explicit sources and conditions
objectives: declared scientific questions
criteria: [{metric, op, threshold, unit}]
postprocess: {operation, inputs, parameters}
```

This is a shape guide, not an executable example. The parser validates the
manifest against the actual source and testbench. `criteria` may be empty when
no acceptance verdict is intended; an absent criterion cannot become a pass.
The supported syntax is a finite Spectre subset with hierarchy, multiple
instances and tran/ac/dc/save statements. Dynamic/external includes, AHDL and
unsupported control constructs block explicitly. General topology support does
not imply support for all Cadence languages or analysis formats.

A helper attached with `--gateway-url` may not hold the existing gateway’s
private native-review key. That connection returns the exact local review-page
link before creating an unusable native approval request. The independent human
form remains available; no key is inferred or disclosed.

## Persistent PDK observations

The private host-bound LUT stores observed model metadata and dependency hashes,
not licensed model bodies in the repository. Matching uses server/account
identity, search roots and required models. The Simulation panel shows cache
hits, age and coverage. **重新扫描 PDK** sends `refresh: true`; an ordinary refresh
of the panel remains a cached read. A hit is rebound to the current source and
still requires a fresh dependency audit before execution. Cached candidate IDs
from a different discovery cannot be used as a current selection.

## Saved-data analysis and cell CI

The analysis panel selects an exact saved job, named operation, backend and
signals. Supported operations include spectra, coherent FFT, three- and
four-parameter sine fits, weight calibration, code reconstruction, histogram
linearity and transient metrics. Backend/operation combinations are validated;
unsupported combinations and missing dependencies are errors. Choose
`spiceowl` or actual `adctoolbox==0.9.3` explicitly. FFT plots show bounded display
bins while metrics and saved reports use the full input CSV. Reports retain the
algorithm, actual numerical dependency versions and source/run/archive hashes.
See [analysis details](onboarding-analysis.md).

Current automatic waveform derivation supports one scalar transient dataset.
AC/DC, complex values and multiple transient analyses can preserve native
artifacts without a derived waveform or automatic numerical verdict. Execution
completion, measurement validity and criterion results remain separate.

For a reusable cell experiment, ask the Agent to propose a TB bundle in the
library's **Testbench CI** tab. Review its complete diff and register it through
the local human form. The bundle versions `testbench.scs`, `analysis.py` and
`manifest.json` under `lib/<library>/<cell>/testbenches/<id>/`. A registered
manifest can analyze an exactly matching collected run; it does not authorize a
new simulation. The Python script is syntax-checked and retained for review and
reproduction. Automatic CI executes the reviewed named analysis operation, not
arbitrary Python. See [cell CI](circuit-ci.md).

## Interrupted operations

Keep the original intake, plan, review and submission identities after a timeout.
A lost run reply is reconciled with `ic_onboarding_submission`; an unknown lookup
never permits replay with a new key. If a saved probe, discovery or preparation
outlives its owning process, the UI reports that recovery is required rather
than continuing an endless loading indicator. A read does not rerun remote work.

## Installation and verification

Use Python 3.11+. The launcher installs the exact SpiceOwl revision from
`contracts/spiceowl-integration.lock.json` with its `adctools` extra into a local
virtual environment. The extra includes NumPy, SciPy and pinned ADCToolbox 0.9.3;
no global Python environment is modified. Real remote tools, models and licenses
remain operator-provided.

The automated tests use original synthetic circuits, loopback HTTP and saved
synthetic CSV data, including actual numerical library calls. Browser checks
exercise the built UI, review handoff, stale drafts and plots. These checks do
not establish a new licensed Spectre result or qualify a fabrication process.
