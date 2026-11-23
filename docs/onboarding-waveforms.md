# Saved waveforms for an original onboarding job

`tools/workbench/onboarding_waveforms.py` wraps the existing read-only `WaveformService`. Its caller supplies a trusted binding between an intake, its original job, the corresponding child Runner, and frozen source identities. The HTTP request cannot supply paths, manifests, replacement run IDs, or a different service. No waveform read starts SSH, observes remote status, derives samples, collects, submits, or repairs a run.

The [generated example](contracts/onboarding-waveforms.example.json) contains actual responses from the current code. An original synthetic PSF ASCII archive was parsed locally by `SimulationRuntime.derive_results`; the resulting hash-bound CSV was then read by the actual `WaveformService` and onboarding adapter. No Spectre or OCEAN ran. The fixture is API/reader evidence, not a successful physical circuit experiment.

## Runtime binding

```python
from onboarding_waveforms import OnboardingWaveforms, WaveformBinding

def resolve_waveform_binding(intake_id, job_id):
    # Resolve from this intake's saved original job/plan, including after a newer
    # preparation exists. Prove project/plan/recipe/source/job membership here.
    return WaveformBinding(
        intake_id=intake_id,
        job_id=original_job_id,
        run_id=original_run_id,
        source_commit=frozen_source_commit,
        service=original_child.waveforms,
        archive_sha256=retained_archive_sha256,
        original_source_sha256=original_input_sha256,
        compiled_source_sha256=frozen_compiled_source_sha256,
        transformation=frozen_transformation,
        compiled_source_path=frozen_source_id,
    )

viewer = OnboardingWaveforms(resolve_waveform_binding)
waveform_descriptor = viewer.describe(intake_id, original_job_id)
```

`WaveformBinding` is backend construction data, not an HTTP schema. `job_id` and `run_id` must identify the same existing Runner run. `source_commit` is a full 40-character Git identity. The source hashes are required: `transformation` is `none` or `added_explicit_subcircuit_wrapper`; `none` requires equal original and compiled hashes. The compiled hash must actually occur in the catalog's source provenance. Supplying `compiled_source_path` requires an exact path/hash match and is recommended. The original hash and wrapper transformation come from the stored intake/compiler receipt, not a client assertion.

The parent runtime must first prove the intake's original saved project, plan, recipe/configuration, source and job relationship. This module additionally checks the Runner record's job/run/source commit, its archive identity, and every returned catalog/window identity. A new preparation must not substitute a new child Runner for an older job.

## Three GET operations

All routes are under `/api/simulation/onboarding/waveforms`. The gateway uses the usual `{ok:true,data:...}` success envelope and error envelope. `read(operation, args)` takes single-value arguments; `dispatch(viewer, operation, query)` accepts `parse_qs(..., keep_blank_values=True)` and rejects duplicates/blanks. The runtime owns actual HTTP route registration.

| Route | Query | Response field inside `data` |
| --- | --- | --- |
| `/catalog` | `intake_id`, `job_id`; optional `dataset_id` | `catalog`: existing `WaveformService.catalog` response |
| `/mapping` | `intake_id`, `job_id`; optional `dataset_id` | `mapping`: existing `WaveformService.mapping` response |
| `/window` | `intake_id`, `job_id`, `signal_ids`; optional `dataset_id`, `start`, `stop`, `max_points` | `series`: one existing `WaveformService.waveform` response per requested ID, in request order |

`signal_ids` is a comma-separated list of 1–8 distinct opaque `s_...` IDs previously returned by this job's catalog. Internal callers may supply the corresponding list. Names, expressions and paths are rejected. `start`/`stop` are finite values in the selected saved axis unit (seconds for transient, Hz for AC, the original unit for DC sweep); omitted endpoints use the existing signal's bounds. `start` must be less than `stop`. `max_points` is an integer from 4–10000, defaults to 1600, and applies separately to each signal. The adapter translates `stop` to the underlying service's `end`, and `max_points` to `limit`. Omitting `dataset_id` retains the legacy scalar transient path. Native AC/DC
requires an exact `ds_<32hex>` ID from the original catalog; every response
returns that same ID. A native-only run lists its datasets without automatically
selecting one. Operating-point catalog reads can expose saved devices even when
there are no scalar signal vectors.

Unknown query fields fail. Queries are bounded to 4096 UTF-8 JSON bytes, and the entire actual success envelope is bounded to 2 MiB. An oversized response fails with `response_limit`; it is not silently truncated. Use fewer signals or points. Existing artifact/row bounds remain enforced by `WaveformService`.

Every operation returns common fields:

```text
schema = ic.onboarding.waveforms.v1
operation, intake_id, job_id, run_id, source_commit, archive_sha256
original_source_sha256, compiled_source_sha256, compiled_source_path, transformation
read_only = true
probe = {enabled:false, reason, current_geometry_context_verified:false}
dataset_id (only for an explicitly selected native dataset)
limits = {max_response_bytes, max_query_bytes, max_window_signals, max_points_per_signal}
```

The nested catalog retains `source_hashes`, `staged_sources`, `effective_config_sha256`, `raw_signature`, `csv_sha256`, `archive_sha256`, `analyses`, `signals`, coverage and reader limits. Available signal rows include `id`, `psf_name`, `label`, `analysis`, `quantity`, `unit`, `domain`, `sample_count`, `status`, `data_basis` and name evidence. Other saved signals can explicitly require extraction; no GET extracts them.

The run overview may additionally contain `datasets`, with independent native
analysis identities, `data_sha256`, archive/member provenance and available
signal/device IDs. A selected native catalog uses `data_format: native_psf_json`
and `data_sha256` instead of fabricating `csv_sha256`. It includes original axis
metadata, complex representation labels and saved operating-point fields/units.

Native swept real data uses `[x,y]` points; complex data uses a separate
`complex_points: [[x,real,imag],...]` field. Unswept signals use `operating_value`
and a null axis. Undefined values stay null; string values remain literal text.
Display `break_before_indices` records per-component segment starts for every
omitted null gap. Renderers must honor them instead of joining finite samples
across missing data. Original global extrema take priority over local buckets;
if a tiny budget cannot retain all complex-component extrema,
`extrema_preserved=false` and `unpreserved_extrema_components` name the limitation.
For valid AC vectors, SpiceOwl supplies full-vector Bode conversion using the
saved physical unit before bounded display selection. Dimensional voltage/current
is not normalized into gain. A one-point or gapped complex vector remains
viewable in raw real/imaginary form when Bode is unavailable. DC sweep keeps its
original monotonic direction and unit. DC tables preserve raw region values;
classification requires an explicit model contract in the analysis tool.

Each window series retains its exact `signal`, `[x,y]` `points`, requested/returned/clipped `window`, display decimation/counts, measurement basis, and source/configuration/archive identities. Manual selection uses those catalog IDs directly. Multiple curves must match the same original source/configuration/raw/archive snapshot; changed identity during a read is an error, never a fallback to another curve.

## Inspect descriptor and UI opening

`viewer.describe(intake_id, job_id)` is a pure local read for the parent's inspect response, for example `job.waveforms`. The parent can use it with `openOnboardingWaveforms({intake, job:run.result})`. Descriptor fields are:

```text
schema = ic.onboarding.waveform-descriptor.v1
intake_id, job_id, run_id, source_commit, archive_sha256
original_source_sha256, compiled_source_sha256, compiled_source_path, transformation
available, source_binding_verified, available_signal_ids, read_only
probe = {enabled:false, reason, current_geometry_context_verified:false}
```

When the real existing catalog validates, the descriptor also includes `source_hashes`, `raw_signature`, `effective_config_sha256`, and a transient `csv_sha256` and/or native `datasets`. `available=true` requires readable exported signals or saved native signals/devices and verified source/archive linkage. Execution completion alone never enables the viewer. Missing exports produce `available=false`, `source_binding_verified=false`, an empty ID list and `unavailable_reason="not_extracted"`. Corrupt hashes or conflicting identities remain explicit errors.

The UI must compare its bound intake/job/plan/source with the descriptor and catalog. For an unchanged subcircuit, original and compiled source hashes coincide. For a flat source with an explicit inserted wrapper, `original_source_sha256` matches the uploaded source while `compiled_source_sha256` matches the source in the catalog. Do not require the original unwrapped hash to appear in the compiled run's source map, and do not disguise this difference as unchanged input.

Saved curves remain manually viewable without a schematic mapping. A missing manifest returns `mapping.status="unmapped"`, empty objects and a disabled probe. Even an installed `verified_binding` manifest does not prove the currently displayed source/geometry context: this adapter leaves `probe.enabled=false` with `reason="current_geometry_context_unverified"`. A future graphical probe needs exact current source and geometry matching through the existing mapping logic; a model name or same-looking schematic cannot enable it.
