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

The current `WaveformService` exposes a single scalar transient dataset. Analysis
loads its full CSV and verifies source, archive, CSV and run identity. It never
uses chart-downsampled data. Generic AC/DC, complex values and multiple transient
datasets can retain native artifacts without becoming supported analysis inputs.
No conversion, sample reconstruction or resampling is inferred.

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

Unsupported backend/option combinations fail explicitly. The local and upstream
calibrations solve different declared problems: supervised reference fitting
versus a sine-based unit-gain representation. Upstream output does not establish
absolute physical gain. Signal units must agree with saved metadata; power
requires saved V and A signals and an explicit current direction.

The frozen request digest includes operation, selectors, parameters and criteria.
When the resolver supplies a reviewed digest or criteria, changes are rejected.
Otherwise the result is labelled `exploratory`. Analysis never changes the
original simulation's verdict.

## Result contract

`ic.onboarding.analysis.v1` contains `analysis_id`, exact run/source/archive
identity, the request and digest, the input CSV/raw signature and sample count,
`evaluation_scope`, the `spiceowl.adctools.result.v1` algorithm result, and an
independent criteria evaluation. Metrics carry value, unit and validity.

`criteria` uses `{metric, op, threshold, unit}` with finite thresholds and exact
units. Invalid analyses, absent/undefined metrics and unit mismatches return
`not_evaluated`; they cannot pass. Execution completion is a separate result.

The trusted resolver may choose an output directory inside the original run to
persist a full JSON report. The response includes its opaque ID and SHA-256,
never a caller-selected path. The response spectrum is limited to 4096 bins by
retaining the maximum-power bin in each frequency bucket. Metrics and the saved
report retain full data. Upstream spectra can have `power_per_bin` and `psd` null;
`power_db` is then used for display peak selection. Null logarithmic bins remain
null. This chart operation cannot change a measurement.

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
