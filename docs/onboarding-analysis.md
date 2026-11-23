# Saved-run analysis and PDK lookup

These adapters keep numeric work and cached observations separate from remote
execution. `onboarding_analysis.py` and `onboarding_lut.py` are called by the
trusted gateway; neither launches SSH, a model, a simulator or an installer.
The gateway owns HTTP/MCP routing, review and the original-run resolver.

## Installation and supported data

Install the exact SpiceOwl revision from the paired dependency lock with its
`adctools` extra for numeric analysis. The extra uses NumPy, SciPy and actual
`adctoolbox==0.9.3`. Missing dependencies return an error; there is no substitute
backend. See SpiceOwl `docs/adctools.md` for algorithm definitions and provenance.

`WaveformService` preserves the existing scalar transient CSV path and exposes
independent native PSF ASCII AC, DC sweep and unswept DC operating-point datasets.
An explicit local derivation verifies the original archive/member inventory,
uses SpiceOwl's real parser, and saves `waveform-datasets.json` plus per-dataset
JSON. GET never derives data or observes a remote host. The original source,
archive, member and data hashes remain bound to the original run.

AC/DC selection requires the exact returned `dataset_id`; no "latest" analysis
is inferred, and an AC-only run has no default transient dataset. AC uses the
native frequency axis in Hz and distinct real/imaginary vectors. DC retains its
saved axis/units or unswept fields, including string/complex values and undefined
nulls. No AC response is reconstructed from transient samples. Multiple transient
analyses and multi-dimensional corner/Monte Carlo families remain unsupported.

## Request contract

The server constructs `AnalysisBinding` with the exact intake/job, source commit,
source/archive digests and existing `WaveformService`. The request cannot choose
filesystem paths or a different service. `OnboardingAnalysis.analyze` accepts:

```json
{
  "intake_id": "intake_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "job_id": "synthetic-original-run",
  "operation": "sine_fit3",
  "inputs": {"samples": "<exact signal ID returned by this run's catalog>"},
  "parameters": {
    "backend": "spiceowl", "frequency_hz": 37,
    "sample_rate_hz": 4096, "signal_unit": "V"
  },
  "criteria": [{"metric": "residual_rms", "op": "<=", "threshold": 0.001, "unit": "V"}]
}
```

The example signal placeholder must be replaced using a catalog read. Every
request chooses `spiceowl` or `adctoolbox` explicitly. Numeric vectors come only
from saved signal selectors, never from `parameters`. The saved time axis is
bound automatically for spectrum, fits, transient measurements and upstream
calibration; an explicit time selector must be `"@time"`.

| Operation | Saved input selectors | Explicit measurement options |
| --- | --- | --- |
| `spec_analyze` | `samples`, optional `time_s` | Rate, fundamental, window, side bins, signal unit; local DC/SFDR conventions or upstream full scale/noise method/frequency tolerance |
| `coherent_fft` | Same | Same backend-specific options except a fixed rectangular window; integer record cycles required |
| `sine_fit3` | `samples`, optional `time_s` | Supplied frequency and signal unit; optional rate checked against timestamps |
| `sine_fit4` | Same | Frequency guess, bounds and signal unit; optional rate |
| `weight_calibrate` | `decisions` list; local `reference`, optional validation selectors; upstream optional `time_s` | Local reference unit/offset fit/condition limit; upstream rate/fundamental/nominal weights/harmonic order |
| `reconstruct_codes` | Ordered `decisions` list | Local backend, weights, reference unit and additive offset |
| `histogram_linearity` | `codes` | Local backend, bits, stimulus distribution and its parameters, endpoint policy, signal unit; optional occupancy threshold/details |
| `tran_metrics` | `values`; optional `reference`, `voltage`, `current`, `time_s` | Local backend, initial/final levels, step time, absolute settling band/unit; optional hold, crossing fractions, reference levels, current direction and power window |
| `ac_metrics` | `response`, optional `reference`: exact complex IDs in selected AC dataset | `spiceowl`; explicit `response_kind`, optional loop feedback/phase convention; `return_curves` |
| `dc_op_metrics` | `devices`: exact `d_<32hex>` IDs in selected unswept DC dataset | `spiceowl`; explicit `device_contracts` keyed by the selected device IDs |

Unsupported backend/option combinations fail explicitly. The local and upstream
calibrations solve different declared problems: supervised reference fitting
versus a sine-based unit-gain representation. Upstream output does not establish
absolute physical gain. Signal units must agree with saved metadata; power
requires saved V and A signals and an explicit current direction.

AC/DC requests add top-level `dataset_id` and use the same value in waveform
catalog/mapping/window queries. AC response and optional reference must share
that exact dataset and frequency axis. Units are injected from saved metadata;
caller-supplied units or vectors are rejected. A same-unit response/reference
ratio is dimensionless. An unnormalized voltage/current retains dimensional
magnitude (for example `dB re 1 V`); it is not silently relabelled as gain.
`dc_gain_db` requires actual saved 0 Hz data; low-frequency gain is reported at
its own frequency. Bode plots retain 0 Hz using an explicitly labelled linear
frequency axis. Strictly positive datasets use logarithmic frequency.

`loop_gain` requires an explicit characteristic denominator
`denominator_1_plus_L` or `denominator_1_minus_T` and `phase_reference_deg`.
All returned unity/phase crossings remain visible. Ambiguous crossings never
become a scalar stability claim; `stability_verdict` stays `not_evaluated`.

For DC operating points the selected device IDs define the required scope.
`device_contracts` keys must be selected IDs; the server maps them to exact saved
names. Each contract explicitly declares polarity and either a model-specific
region mapping plus its evidence source, or Vdsat voltage/sign/threshold
conditions. Raw region codes have no generic mapping. Missing contracts reject
analysis; missing measured evidence or unmapped codes produce unknown results.
This adapter does not accept arbitrary supply numbers: DC static power remains
undefined until a saved voltage/current selector contract is implemented.

The frozen request digest includes operation, selectors, parameters, criteria
and the explicit native `dataset_id` when selected.
When the resolver supplies a reviewed digest or criteria, changes are rejected.
Otherwise the result is labelled `exploratory`. Analysis never changes the
original simulation's verdict.

## Result contract

`ic.onboarding.analysis.v1` contains `analysis_id`, exact run/source/archive
identity, the request and digest, the input raw signature and sample count,
`evaluation_scope`, the `spiceowl.adctools.result.v1` algorithm result, and an
independent criteria evaluation. Transient inputs retain `csv_sha256`; native
inputs instead carry `data_sha256`, `data_format: native_psf_json`, `dataset_id`,
original `analysis_id`/`analysis_kind` and `native_member_sha256`. Native JSON is
never assigned a fabricated CSV digest. Metrics carry value, unit and validity.

`criteria` uses `{metric, op, threshold, unit}` with finite thresholds and exact
units. Invalid analyses, absent/undefined metrics and unit mismatches return
`not_evaluated`; they cannot pass. Execution completion is a separate result.

The trusted resolver may choose an output directory inside the original run to
persist a full JSON report. The response includes its opaque ID and SHA-256,
never a caller-selected path. The response spectrum is limited to 4096 bins by
retaining the maximum-power bin in each frequency bucket. Metrics and the saved
report retain full data. Upstream spectra can have `power_per_bin` and `psd` null;
`power_db` is then used for display peak selection. Null logarithmic bins remain
null. AC display curves retain bounded actual magnitude/phase extrema and gaps;
per-component segment-start metadata prevents lines across omitted null gaps.
Metrics and persisted reports always use full original real/imaginary vectors.
These chart operations cannot change a measurement.

Explicit saved-job AC/DC analysis is separate from automatic experiment
acceptance. The existing reviewed Agent-TB automatic measurement path still
supports its single scalar transient export; AC/DC analyses here do not qualify
a PDK, alter the archived job verdict, or silently replace that CI path.

The adapters bound requests, reports and response size. An oversized response
requires a new summary request; it does not trigger a new simulation.

## Persistent model observations

`store_discovery` saves a completed scanner observation under a server-selected
private cache directory. `lookup_discovery` matches observed server account
identity, roots and the exact required-model set, applies TTL, then explicitly
rebinds the cached observation to the current source hash. Misses, stale entries
and refresh requests do not scan in this adapter.

`lookup_model_bindings` uses a precomputed bounded ranking index. Its candidate
IDs belong to the original cached observation; the public response marks
`requires_source_rebinding`. Do not combine those IDs with IDs from a rebound
discovery. Its private recommendation may contain remote paths and must not be
serialized directly as a public response.

A cache hit preserves original observation time and bounded coverage. It never
verifies current remote contents, qualifies the process or makes a job ready to
run. A fresh dependency audit remains mandatory before execution.

## Reproducible checks and UI fixtures

From the paired development checkouts:

```bash
PYTHONPATH=../spiceowl/src:tools/workbench ../spiceowl/.venv/bin/python -m unittest test_onboarding_lut test_onboarding_analysis test_onboarding_analysis_numeric
PYTHONPATH=../spiceowl/src:tools/workbench ../spiceowl/.venv/bin/python tools/workbench/test_onboarding_analysis.py --write-examples
PYTHONPATH=../spiceowl/src:tools/workbench ../spiceowl/.venv/bin/python tools/workbench/test_onboarding_analysis_numeric.py --write-examples
```

The [summary fixture](contracts/onboarding-analysis.example.json) uses the actual
adapter and CSV service with an explicitly labelled algorithm seam. The
[spectrum fixture](contracts/onboarding-analysis.spectrum.example.json) runs the
actual SpiceOwl FFT over an original synthetic coherent signal. Numeric tests
also call the pinned upstream implementation when installed, verify known
harmonic powers, sine fits, transient timing and power, and check full-resolution
report preservation. These fixtures establish software behavior over synthetic
data; they contain no real remote simulation evidence.

The [AC/DC fixture](contracts/onboarding-acdc.example.json) runs actual native
PSF parsing, hash-bound dataset publication, full-resolution AC/DC numerical
APIs, and report persistence over original synthetic data. Reproduce with:

```bash
SPICEOWL_SOURCE_DIR=../spiceowl/src PYTHONPATH=../spiceowl/src:tools/workbench ../spiceowl/.venv/bin/python -B -m unittest test_native_datasets
SPICEOWL_SOURCE_DIR=../spiceowl/src PYTHONPATH=../spiceowl/src:tools/workbench ../spiceowl/.venv/bin/python -B tools/workbench/test_native_datasets.py --write-examples
node --test tests/studio/native-datasets.test.mjs tests/remote/native-datasets.test.mjs
node tests/studio/native-datasets.browser.mjs
```

The browser fixture uses the actual viewer, analysis form and algorithm results;
it verifies zero-frequency/dimensional Bode charts, responsive resizing,
independent DC sweep and native operating-point tables, and exact selector
plumbing. It does not run a simulator or establish a scientific qualification.
