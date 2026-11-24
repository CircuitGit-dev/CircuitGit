# Clean-slate onboarding API, v1

This is the implementation contract for the discovery-onboarding branch. It is independent of chat subscriptions, library catalogues, old site files and prior simulation state. Discovery does not launch a simulator. A new uploaded source has an intake identity and `source_commit: null`; preparation creates its first real local Git snapshot.

All routes below are under `/api/simulation/onboarding`. Responses use the existing `{ok:true,data:...}` HTTP envelope and the complete envelope is bounded to 2 MiB UTF-8. POST uses the existing loopback Origin and mutation-token checks. The browser entry records `interactive_client`; direct backend integrations must explicitly record their own entry origin. This field is provenance, not proof of a human click or an agent authentication mechanism. Permission and stale-state errors are failures, never empty successful discoveries.

The browser injects an adapter into `modules/simulation/environment`; that module does not construct URLs. No endpoint accepts arbitrary commands, credentials, old site-file paths or a `confirmed:true` permission override.

## Methods and routes

| Adapter | Route | Input |
| --- | --- | --- |
| `inspectNetlist` | POST `/netlist` | `{file_name,text,mode?,support_files?}` |
| `listSshAliases` | GET `/ssh-hosts` | none |
| `getSession` | GET `/session?intake_id=ID` | original intake ID |
| `probeHost` | POST `/probe` | `{intake_id,revision,ssh_targets,overrides?}` |
| `discoverPdk` | POST `/discover-pdk` | `{intake_id,revision,probe_ids,search_paths?,search_directory_ids?,cds_lib_hint?,refresh?,library_selection?}` |
| `probeVerilogaHeaders` | POST `/veriloga-headers` | `{intake_id,revision,probe_id,roots}`; explicit standard-header include roots on an already observed host |
| `prepareExperiment` | POST `/prepare` | selection and intent below |
| `runPrepared` | POST `/run` | `{intake_id,revision,plan_id}` |
| `readSubmission` | GET `/submission?intake_id=ID&plan_id=PLAN` | original intake and plan IDs |
| `inspectExperiment` | POST `/inspect` | `{intake_id,job_id}` |
| `readSource` | GET `/source?intake_id=ID` | original intake ID |
| `readAgentTestbench` | GET `/agent-tb?intake_id=ID` | original intake ID |
| `saveAgentTestbench` | POST `/agent-tb/draft` | `{intake_id,revision,testbench,selection?}` |
| `prepareAgentTestbench` | POST `/agent-tb/prepare` | `{intake_id,revision,draft_id}` |
| `readAgentTestbenchReview` | GET `/agent-tb/review?intake_id=ID&review_id=REVIEW` | exact frozen review |
| `analyzeExperiment` | POST `/analysis` | `{intake_id,job_id,dataset_id?,operation,inputs,parameters,criteria?}` |

`file_name` is a display label; it is never opened as a local path. The server stores only the supplied literal text. `ssh_targets` is a nonempty bounded list of explicit aliases or user-entered SSH targets. Before that selection, no SSH occurs. `overrides` is an optional bounded object of explicit setup/tool hints, not a path to an old configuration file. Its accepted fields are reported as capabilities; unknown fields fail closed.

`connection_id` is the stable identity of the onboarding store, shared by `/api/health`, `/node/info` and every session. Clients must not substitute an origin, port or another identifier.

Each source import creates a new `intake_id`. Mutable discovery calls require the latest integer `revision` and return its successor. A changed source, host selection or discovery invalidates downstream selections/plans in that intake. Historical job receipts remain available by their original identifiers. Every state response includes `intake_id`, `revision`, `source_sha256`, `source_commit` and `state`; callers copy those exact identities instead of deriving them.

## Recommendations and finite next actions

Sessions expose `suggested_intent` as editable plain values and `intent_suggestions`
as field-level evidence. After discovery, `session.recommended_selection` and
`session.discovery.recommended_selection` hold the same draft or null when no
compatible default exists. Candidates also retain individual recommendations,
rank evidence and `recommended_tmi_candidate_id`; `candidate_groups` separates
the recommended entry, other entries and definition fragments.

A draft has schema `ic.onboarding.recommended-selection.v1`, a 64-hex
`recommendation_id`, `recommendation_revision`, source/discovery identities,
`candidate_id`, `sections`, `tmi_candidate_id`, `model_contracts`, `intent`,
`ready_for_prepare`, `missing` and `provenance`. It always has
`requires_acceptance:true`, `fresh_dependency_audit_required:true` and
`ready_to_run:false`. The recommendation revision stays at its generation
revision; it is not the current session CAS revision after preparation or run.
Source/host/discovery changes invalidate the recommendation.

`provenance.fields` distinguishes observed values, source-based inference and
the visible inverter smoke preset. A default among compatible tied drafts is
labelled `policy_default`, retains alternatives and explicitly does not prove
model equivalence. Nominal supply suggestions are not foundry qualifications.
Absolute remote paths and model bodies remain private.

Before saving a session, the gateway checks both the 2 MiB HTTP envelope and
the 4 MiB local-record budget, with headroom for subsequent steps. If needed,
it first removes repeated optional explanation arrays from alternative drafts.
`provenance.omitted` and `omission_reason:"session_size_budget"` identify those
omissions; omitted arrays keep their original type. Candidate choices, model
source evidence, Field values/confidence/missing conditions and selection IDs
are retained. A projected draft with omitted evidence reports
`recommendation_id_basis:"complete_original_draft"` and
`public_rehash_supported:false`: its original ID stays valid, but the shortened
presentation is not the complete hash input. The main recommendation keeps its
full explanation when the remaining budget permits. Private discovery records
use compact JSON that preserves every observed value. Data that still exceeds
the core budget is rejected before replacing the last readable record.

Every session includes `next_actions`, an array of
`{id,tool,operation,kind,ready,arguments,missing,reason_code,description}`. `tool`
is an exact `ic_onboarding_*` name and arguments carry current intake/revision
bindings. Guidance does not authorize operations. Missing inputs disable the
corresponding action; uncertain submission permits original-plan lookup only.
Completed jobs expose saved waveform reads. GET does not execute these actions.
Automatic directory narrowing skips previously searched scopes using a stable
source/probe/path fingerprint and stops after eight discovery rounds per probe
generation. A new discovery ID cannot restart the same scope. The public
directory rows report `search_scope_id`, `search_attempted`,
`automatic_search_allowed` and `automatic_search_blocked_reason`; paths remain
private. `discovery.automatic_search` reports the round count and limit. Explicit
manual search hints remain supported after the automatic limit. A fresh probe
invalidates its old search history. When reactivating selected hosts, guidance
preserves every already selected setup ID and rechecks its current source hash.

The eighteen generated MCP tools mirror the routes above and waveform routes:
`ic_onboarding_netlist`, `ic_onboarding_ssh_hosts`, `ic_onboarding_session`,
`ic_onboarding_probe`, `ic_onboarding_discover_pdk`, `ic_onboarding_prepare`,
`ic_onboarding_run`, `ic_onboarding_submission`, `ic_onboarding_inspect`,
`ic_onboarding_waveforms_catalog`, `ic_onboarding_waveforms_mapping`, and
`ic_onboarding_waveforms_window`, `ic_onboarding_source`, `ic_onboarding_agent_tb`,
`ic_onboarding_agent_tb_draft`, `ic_onboarding_agent_tb_prepare`,
`ic_onboarding_agent_tb_review`, and `ic_onboarding_analysis`. Their `structuredContent` remains
`{ok:true,data:result}`; session results retain all binding fields and guidance.
The Service records `native_agent` using a fixed transport header, verifies the
gateway connection identity and capability, and keeps the original run journal.
The header is provenance, not an authorization mechanism or a human approval.

The [smart fixture](contracts/onboarding-smart.example.json) comes from actual
runtime serialization with original synthetic models and mocked remote seams.
Its controller uses returned actions without an LLM; dispatch remains deferred.
`tools/workbench/test_onboarding_tool_driver.py` also exercises the complete
source-import, SSH-inventory, setup-selection, discovery, preparation,
reservation and original-job inspection chain. The only initial external choice
is the allowed host range. Subsequent calls copy the returned action arguments;
the controller stops if an action is not ready or reports missing inputs. The
fixture runs the local compiler, Git and Runner reservation, with no LLM, SSH or
solver invocation. This verifies orchestration, not a new physical simulation
or a benchmark of a particular language model.

## Source, environment and candidate responses

`inspectNetlist` returns `schema: "ic.onboarding.session.v1"`, initial `state: "source_inspected"`, and `source: {file_name,source_sha256,source_commit:null,requirements}`. Requirements include `instances: [{name,master,ordered_nets,dimensions}]`, `interfaces: [{name,ports}]`, `required_masters`, `issues` and `confirmation_required`. Dimensions retain their source literal; metres are supplied only where parsing is unambiguous. Model spelling does not establish a process, polarity or terminal semantics.

`listSshAliases` returns `{schema,hosts:[{alias,source_count}],complete,warnings,network_operations:0}`. It reads the configured local SSH configuration and bounded Include files, never private keys or old app profiles.

`probeHost` returns a session with `probes: [{probe_id,ssh_target,observed_at,environment}]`. The environment contains observed tool presence/version, license **configuration presence** with checkout not attempted, CPU/memory observations, missing items, warnings and bounded coverage. Raw license values and private environment/script paths stay in private state. Unexecuted declarations are discovery hints, not proof of a working environment.

`discoverPdk` returns the **nested** `session.discovery` object containing `discovery_id`, `candidates`, `ambiguities`, `missing` and `coverage`; these fields are not flattened onto the session. Each candidate has `candidate_id`, `probe_id`, `label`, `entry_role`, `available_sections`, `section_candidates`, `master_coverage`, `model_contracts`, `tmi_candidates`, `evidence` and `missing`. Identifiers are opaque. Definitions and usable include entrypoints are distinguished. Candidate lists and section names come from scanned source, not a built-in foundry table. An incomplete or timed-out search remains incomplete; a match is not an automatic selection.

## Preparing and running

`prepareExperiment` accepts a complete explicit selection as below. Alternatively,
only `{intake_id,revision}` accepts the current recommendation. Optional
`recommendation_id` and `recommendation_revision` bind a displayed draft;
stale bindings fail before preparation. Partial `intent` and `model_contracts`
objects merge over the draft, and other selection fields replace their draft
values. `accept_recommendation:false` requires the complete explicit selection.
Unresolved recommendation gaps stay blocked unless the relevant field is
explicitly supplied. Final adopted settings, including inferred model contracts,
are echoed in `session.selection`; input provenance retains the supplied overrides.

Complete explicit input:

```json
{
  "intake_id": "RETURNED_ID",
  "revision": 3,
  "discovery_id": "RETURNED_DISCOVERY_ID",
  "candidate_id": "RETURNED_CANDIDATE_ID",
  "sections": ["A_SECTION_OBSERVED_IN_THIS_CANDIDATE"],
  "tmi_candidate_id": null,
  "model_contracts": {},
  "intent": {
    "supply_v": 0.9,
    "frequency_hz": 1000000000,
    "temperature_c": 27,
    "nominal_temperature_c": 27,
    "input_port": "IN",
    "output_port": "OUT",
    "vdd_port": "VDD",
    "vss_port": "VSS",
    "cycles": 5,
    "load_f": 2e-15,
    "rise_s": 1e-11,
    "fall_s": 1e-11,
    "points_per_period": 1000
  }
}
```

These are illustrative conditions, not defaults for every device. The form must show the conditions it submits, including advanced stimulus/load/sample settings. Port suggestions come from the new netlist and remain editable. Verified model contracts can be copied from the selected candidate; otherwise the form collects the missing polarity and ordered terminal roles. A contract is `{polarity:"n"|"p",terminals:["d","g","s","b"]}` keyed by the exact model name. TMI selection is required only when discovery reports a choice that cannot be determined from the observed simulator platform.

Preparation validates **the actual selected section closure**, performs fresh dependency hashing, creates the real isolated source snapshot, and calls the existing deterministic recipe compiler. Its session response contains `prepared`, a standard `ic.experiment.plan.v1` object, and `execution_scope: {selected_ssh_targets,candidate_host_ids,selection_mode:"automatic_within_selected_hosts",resource_check_at_run:true}`. `prepared.state` is `prepared` or `blocked`; blocked plans have null `plan_id` and explicit `missing`. `prepared.source_commit` is a real new Git SHA. `prepared.submission_key` is `experiment-PLAN_ID`.

The host list is the user's **allowed candidate range**, not a resource reservation or a guarantee that all those hosts remain eligible. `runPrepared` checks dependencies and current resources, chooses one eligible host within that range, and returns the standard `ic.experiment.job.v1` job as `job`, plus intake identity. The job's `execution_target` is the selected host ID. Selection never expands the approved host range.

The client retains `{intake_id,revision,plan_id,submission_key}` before sending run. A lost reply is reconciled through `readSubmission`, which returns `{found,run_id,submission_key,dispatch_outcome,replay_permitted:false,job}`. Missing mapping does not authorize replay. Neither refresh nor a new chat may generate a replacement key. Server receipts are durable before dispatch; the existing Runner remains the only execution ledger.

Both `runPrepared` and `inspectExperiment` return the complete `ic.onboarding.session.v1` envelope, including `source.requirements`; their standard job result is nested in `session.job`.

`inspectExperiment` observes the original `job_id`, may collect terminal native artifacts, and returns the standard job with `inspection_state`, five-dimensional `report` and `measurements`. `complete` means the workflow finished, not universal scientific qualification. Unknown results preserve the original job and are never automatically relaunched. Returned waveform/artifact descriptors are bound to that same run and archive.

## Resuming the new session

`getSession` reads this onboarding store only. It returns cached source/probe/discovery/selection/prepared identities and a saved run receipt when present. It does not scan SSH, read historical configuration, fetch a PDK or submit a job. The browser restores only an intake selected in this fresh helper connection; it cannot attach an unrelated session by choosing a project title.

Connection selection is ordinary configuration, not a second approval system. Entry points record `interactive_client`, `native_agent` or `test_harness` provenance without claiming proof of human identity. A reproducibility test must label fixture choices as simulated user inputs; it must not call them automatically discovered or pretend the user clicked them.

## Explicit setup observation

`probeHost.overrides` accepts only `{setup_source_ids:{"SELECTED_SSH_TARGET":"OBSERVED_SOURCE_ID"}}`. The source must have been discovered in this intake on that same host. The backend refreshes and checks its path/hash, evaluates the selected csh setup, then observes the resulting environment. Other shell types remain explicit missing capabilities. The probe itself never invokes a simulator or checks out a license; setup-script side effects are not audited. This selection is recorded with its actual entry origin.

Saved waveform routes and availability descriptors are specified in [onboarding-waveforms.md](onboarding-waveforms.md). Only `session.job.waveforms.available` after verified catalog reading enables the manual waveform action.

When a broad search is incomplete, `session.discovery.search_directories` contains only actually observed choices: `{directory_id,probe_id,label,basis,scanned,qualified:false}`. Select up to eight of their IDs via `search_directory_ids`, instead of `search_paths`. IDs must come from the current discovery and cover each requested probe. The backend resolves them within that observation; the caller cannot supply a file-fetch address. Directory names and incomplete metadata do not establish a compatible PDK.

## Authoritative rejection before reservation

A typed `PreDispatchRejected` originates only within the existing workflow's resource/dependency preflight block, which ends before `Runner.reserve`. It produces a complete session with `state: "pre_dispatch_rejected"`, `job: null`, and `submission: {intake_id,plan_id,found:false,run_id:null,submission_key,dispatch_outcome:"pre_dispatch_rejected",replay_permitted:false,job:null,rejection}`. The rejection is `{schema:"ic.experiment.pre-dispatch-rejection.v1",plan_id,project_id,source_commit,submission_key,phase:"before_runner_reserve",code:"resource_or_dependency_preflight_rejected",launch_attempted:false,recorded_at}`. Original-key lookup retains this receipt. A client may clear its pending request only after checking these exact bindings, then permit a deliberate new prepare. It never resends the rejected key. Ordinary exceptions or a missing run mapping do not produce this proof.

A successful original-key lookup restores the current session's standard job only when its prepared plan still matches. Old-plan lookups cannot overwrite a newer active job. Active `inspect` for a noncurrent plan returns 409 Conflict before remote observation; v1 has no historical active-inspection session projection. Saved waveform GETs still accept the original historical job and remain independently bound.


## General authored TB and human review

`mode:"agent-tb"` selects the general source parser. `support_files` maps bounded
relative include names to literal source text. Omitted mode retains the legacy
inverter compatibility flow. Source reads return `ic.onboarding.source.v1` with
verified complete source/support bytes and hashes, subject to the same response
budget. A draft uses the full `ic.agent_testbench.v1` manifest; see
[the workflow](agent-testbenches.md) for fields and current syntax limits.

Draft saving can precede PDK selection. Preparation freezes all inputs and returns
`state:"awaiting_human_review"` with a summary in `agent_tb_review`. The exact
review GET returns `ic.agent-tb.review.v1` including its complete `snapshot`.
Its digest covers source/support files, TB, PDK and host scope, analyses and
criteria. Any changed input invalidates it.

The independent local `/agent-tb/review` page uses a one-use form ticket and CSRF
value. Its `/agent-tb/review/confirm` receives only that human form's decision.
The native `ic_onboarding_run` instead returns a standard pending Service
receipt; the existing MCP host review resolves it. Only that trusted resolver
signs the exact `/api/simulation/onboarding/agent-tb/human-run` request. These
human endpoints are absent from the model tool catalog and browser proxy.
The signature key remains in the private onboarding store. Neither entry mode,
developer permissions nor `approved:true` grants authority.

Run identity remains stable across reloads. A repeated native request returns its
existing receipt; an uncertain dispatch is reconciled against the original
submission. No lookup grants permission to resend an unknown run.

## Cached model lookup and analysis

`discover-pdk` may reuse a matching private host-bound LUT observation and rebind
it to the new source. A full-library observation indexes individual devices and
serves different required-model combinations from the same server/root identity.
One discovery request accepts one or two explicit probe IDs, processed concurrently.
Each remote full-library scan has a 240-second deadline and its SSH transport a
270-second deadline. Gateway/helper requests share a 300-second monotonic budget
across their internal health read, operation and response; the browser allows
310 seconds. This is one bounded batch, not an eight-host queue under the
same deadline. Host probing still accepts up to eight hosts; choose one or two
observed probes explicitly for each discovery. Larger discovery batches are rejected
before the intake revision changes or any remote work starts. A timeout retains
the failed observation and does not automatically retry or identify the slow phase.
The native Service also reads connection health before that request; its configured
timeout is 30 seconds by default and may be at most 120 seconds. The local plugin
installer uses a 480-second tool deadline for new installations, covering that
initial read and the 300-second discovery request. Existing plugin upgrades
preserve the operator's timeout policy; an older 180-second host setting can still
end the MCP call early. Update that plugin-specific host deadline before using full
discovery through that host, or use the browser/CLI path with the same intake.
After a host timeout, read the intake first; an interrupted client is not proof that
the original remote operation stopped.
Only its private remote transport and storage use a separate 16 MiB bound;
source-bound queries and public sessions retain the 2 MiB HTTP envelope. Older
filtered receipts retain their exact model scope. A multi-entry combination stays
an explicit unaudited draft and cannot be promoted to a fabricated single entry.
`refresh:true` requests an explicit new scan. Public LUT
status retains observation age/coverage and the need for source rebinding and
fresh preflight. Raw private recommendations are not HTTP responses.

A stored library can still return `partial` with `scan_required:false` when the
current device set needs an explicit entry/section combination. The effective
post-scan state is `lut.projection` when present; the outer LUT record retains
the earlier lookup/refresh provenance. Public coverage then reports
`phase:library_binding_pending`, keeps unknown coverage unknown, and lists binding
and combined-audit gaps. Empty prepared candidates do not mean the index or host
is unavailable. The UI and next actions do not recommend rescanning that index;
the explicit advanced refresh action remains available. No combination is promoted
to a single observed candidate or a runnable plan by this status projection.

If a query is too large, `discovery.lut[]` (or that row's `projection` after a
scan) contains `library_id` and bounded `entry_choices`. Send one returned
`library_selection:{probe_id,library_id,library_candidate_id}` with that sole
`probe_ids` entry. This preserves the original observed roots and library; it
cannot be combined with new scan hints or `refresh:true`, and never starts SSH.

`veriloga-headers` is an explicit bounded read of the named installation's header
roots, never a compiler invocation. Select its returned `headers_<sha256>` ID
through optional `selection.veriloga_header_id`. The selected PDK and headers
must belong to the same current probe. The full original observation remains
private; the draft/review binds standard names, aliases, hashes and reachable
include layout. Missing, ambiguous or changed headers block preparation. A
failed header observation returns `needs_input`; an invalid request leaves the
existing revision intact.

Analysis selectors are exact saved signal IDs (or transient `@time`) and DC
operating-point device IDs, never paths, numeric vectors or commands. Native
AC/DC requests explicitly select the original returned `dataset_id`; the same
optional selector is accepted by waveform catalog/mapping/window reads. AC
`inputs.response` and optional `inputs.reference` select complex data in that
same frequency dataset. DC `inputs.devices` selects exact saved devices;
`parameters.device_contracts` is keyed by those IDs. No dataset is chosen by
"latest" or inferred from the current schematic.

The resolver binds original job/source/archive/member/full-data identities.
Transient input retains `csv_sha256`; native data uses `data_sha256` and
`data_format: native_psf_json`. Units come from the saved data. Backends/options
are explicit; AC/DC use `spiceowl`. Results use `ic.onboarding.analysis.v1`, with
independent measurement/criterion status, optional spectrum or Bode curves,
DC device results and a persisted report identity. Actual 0 Hz is required for
DC gain, loop margin requires explicit feedback conventions, and region codes
remain unknown without model-specific evidence. These explicit saved-job
analyses do not change automatic Agent-TB acceptance, which still uses its
single scalar transient measurement path. See
[the complete analysis contract](onboarding-analysis.md).
