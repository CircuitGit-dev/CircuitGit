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
helper_files: optional {relative_name: literal_UTF8_text}
```

This is a shape guide, not an executable example. The parser validates the
manifest against the actual source and testbench. `criteria` may be empty when
no acceptance verdict is intended; an absent criterion cannot become a pass.
The supported syntax is a finite Spectre subset with hierarchy, multiple
instances and tran/ac/dc/save statements, plus the pinned SpiceOwl scalar
Verilog-A subset. Supply DUT-side `ahdl_include` dependencies through the import's
`support_files`; place TB-only source or stimulus files in the draft's optional
`helper_files`. Their relative namespaces must not overlap, and every supplied
file must belong to its declared include closure. Original bytes and separate
source/helper hashes are frozen for review. Dynamic includes, unsupported
preprocessor/control constructs and file-writing system tasks block explicitly.
These checks do not claim a complete Verilog-A compiler or execution sandbox.

Standard `constants.vams` and `disciplines.vams` headers cannot be supplied as
helpers. After selecting a probed Spectre installation, use
`POST /veriloga-headers` with its exact `probe_id` and explicit include `roots`,
then select the returned `veriloga_header_id` in the draft's selection. The
private observation records original header paths, hashes and static transitive
includes; the public projection contains names, hashes and missing evidence.
Preparation audits that same graph again. Runner stages the exact pinned graph
on the simulator host and points the owner-parsed standard include locations at
it. The original Git source remains unchanged; staging hashes record the
controlled path substitution. Standard header contents are excluded from the
collected results archive and never become committed testbench source.

A helper attached with `--gateway-url` may not hold the existing gateway’s
private native-review key. That connection returns the exact local review-page
link before creating an unusable native approval request. The independent human
form remains available; no key is inferred or disclosed.

## Persistent PDK observations

The private host-bound LUT stores observed model metadata and dependency hashes,
not licensed model bodies in the repository. Matching uses server/account
identity and search roots. One explicit full-library scan indexes each observed
device for reuse by later circuits requesting different model combinations.
The private scan/storage transport allows at most 16 MiB; a source-bound query
and the public HTTP envelope remain bounded to 2 MiB. Existing filtered cache
receipts remain readable and do not claim full-library coverage.
The Simulation panel shows cache
hits, age and coverage. **重新扫描 PDK** sends `refresh: true`; an ordinary refresh
of the panel remains a cached read. A hit is rebound to the current source and
still requires a fresh dependency audit before execution. Cached candidate IDs
from a different discovery cannot be used as a current selection.
Missing devices require new evidence. When no single observed entry covers the
requested set, the cache returns a multi-entry combination draft with explicit
gaps; it cannot synthesize a ready-to-run single entry or skip a combined audit.

## Saved-data analysis and cell CI

The analysis panel selects an exact saved job, dataset, operation, backend and
saved signal/device IDs. Existing operations cover spectra, coherent FFT,
three-/four-parameter sine fits, calibration, reconstruction, linearity and
transient metrics. Native PSF ASCII AC/DC datasets also support explicit
`ac_metrics` and `dc_op_metrics` requests through SpiceOwl. AC returns original
Hz-axis real/imaginary data and Bode magnitude/phase; DC shows original saved
operating-point fields/units and explicit device-contract results. Region
numbers are not generic model classifications, and loop margins require a
feedback convention. Unsupported backend/options or missing dependencies are
errors. Numeric measurements and saved reports use full data; only display
samples are reduced. All results retain source/run/archive/member/data hashes.
See [analysis details](onboarding-analysis.md).

The automatic reviewed experiment acceptance path still uses its single scalar
transient export. Explicit saved-job AC/DC analysis does not alter that verdict
or automatically enable AC/DC CI acceptance. Multiple transient datasets and
multi-dimensional families can retain native archives but remain unsupported
for numerical measurement. Execution completion, measurement validity and
criterion results remain separate.

For a reusable cell experiment, ask the Agent to propose a TB bundle in the
library's **Testbench CI** tab. Review its complete diff and register it through
the local human form. The bundle versions `testbench.scs`, `analysis.py` and
`manifest.json` under `lib/<library>/<cell>/testbenches/<id>/`. A registered
manifest can analyze an exactly matching collected run; it does not authorize a
new simulation. The Python script is syntax-checked and retained for review and
reproduction. Automatic CI executes the reviewed named analysis operation, not
arbitrary Python. See [cell CI](circuit-ci.md).
Optional helpers are versioned under that bundle's `helpers/` directory. The
registered manifest, committed helper bytes and the original job's frozen review
must match exactly; a newer draft or an unrelated run cannot supply those bytes.

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
