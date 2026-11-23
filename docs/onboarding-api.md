# Clean-slate onboarding API, v1

This is the implementation contract for the discovery-onboarding branch. It is independent of chat subscriptions, library catalogues, old site files and prior simulation state. Discovery does not launch a simulator. A new uploaded source has an intake identity and `source_commit: null`; preparation creates its first real local Git snapshot.

All routes below are under `/api/simulation/onboarding`. Responses use the existing `{ok:true,data:...}` HTTP envelope and the complete envelope is bounded to 2 MiB UTF-8. POST uses the existing loopback Origin and mutation-token checks. Signed agent callers use the onboarding connection's own key, not a historical simulation grant. Permission and stale-state errors are failures, never empty successful discoveries.

The browser injects an adapter into `modules/simulation/environment`; that module does not construct URLs. No endpoint accepts arbitrary commands, credentials, old site-file paths or a `confirmed:true` permission override.

## Methods and routes

| Adapter | Route | Input |
| --- | --- | --- |
| `inspectNetlist` | POST `/netlist` | `{file_name,text}` |
| `listSshAliases` | GET `/ssh-hosts` | none |
| `getSession` | GET `/session?intake_id=ID` | original intake ID |
| `probeHost` | POST `/probe` | `{intake_id,revision,ssh_targets,overrides?}` |
| `discoverPdk` | POST `/discover-pdk` | `{intake_id,revision,probe_ids,search_paths?,cds_lib_hint?}` |
| `prepareExperiment` | POST `/prepare` | selection and intent below |
| `runPrepared` | POST `/run` | `{intake_id,revision,plan_id}` |
| `readSubmission` | GET `/submission?intake_id=ID&plan_id=PLAN` | original intake and plan IDs |
| `inspectExperiment` | POST `/inspect` | `{intake_id,job_id}` |

`file_name` is a display label; it is never opened as a local path. The server stores only the supplied literal text. `ssh_targets` is a nonempty bounded list of explicit aliases or user-entered SSH targets. Before that selection, no SSH occurs. `overrides` is an optional bounded object of explicit setup/tool hints, not a path to an old configuration file. Its accepted fields are reported as capabilities; unknown fields fail closed.

Each source import creates a new `intake_id`. Mutable discovery calls require the latest integer `revision` and return its successor. A changed source, host selection or discovery invalidates downstream selections/plans in that intake. Historical job receipts remain available by their original identifiers. Every state response includes `intake_id`, `revision`, `source_sha256`, `source_commit` and `state`; callers copy those exact identities instead of deriving them.

## Source, environment and candidate responses

`inspectNetlist` returns `schema: "ic.onboarding.session.v1"`, initial `state: "source_inspected"`, and `source: {file_name,source_sha256,source_commit:null,requirements}`. Requirements include `instances: [{name,master,ordered_nets,dimensions}]`, `interfaces: [{name,ports}]`, `required_masters`, `issues` and `confirmation_required`. Dimensions retain their source literal; metres are supplied only where parsing is unambiguous. Model spelling does not establish a process, polarity or terminal semantics.

`listSshAliases` returns `{schema,hosts:[{alias,source_count}],complete,warnings,network_operations:0}`. It reads the configured local SSH configuration and bounded Include files, never private keys or old app profiles.

`probeHost` returns a session with `probes: [{probe_id,ssh_target,observed_at,environment}]`. The environment contains observed tool presence/version, license **configuration presence** with checkout not attempted, CPU/memory observations, missing items, warnings and bounded coverage. Raw license values and private environment/script paths stay in private state. Unexecuted declarations are discovery hints, not proof of a working environment.

`discoverPdk` returns `discovery_id`, `candidates`, `ambiguities`, `missing` and `coverage` in the session. Each candidate has `candidate_id`, `probe_id`, `label`, `entry_role`, `available_sections`, `section_candidates`, `master_coverage`, `model_contracts`, `tmi_candidates`, `evidence` and `missing`. Identifiers are opaque. Definitions and usable include entrypoints are distinguished. Candidate lists and section names come from scanned source, not a built-in foundry table. An incomplete or timed-out search remains incomplete; a match is not an automatic selection.

## Preparing and running

`prepareExperiment` takes exactly the current discovery identities and explicit choices:

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

`inspectExperiment` observes the original `job_id`, may collect terminal native artifacts, and returns the standard job with `inspection_state`, five-dimensional `report` and `measurements`. `complete` means the workflow finished, not universal scientific qualification. Unknown results preserve the original job and are never automatically relaunched. Returned waveform/artifact descriptors are bound to that same run and archive.

## Resuming the new session

`getSession` reads this onboarding store only. It returns cached source/probe/discovery/selection/prepared identities and a saved run receipt when present. It does not scan SSH, read historical configuration, fetch a PDK or submit a job. The browser restores only an intake selected in this fresh helper connection; it cannot attach an unrelated session by choosing a project title.

Connection selection is ordinary configuration, not a second approval system. Entry points record `interactive_client`, `native_agent` or `test_harness` provenance without claiming proof of human identity. A reproducibility test must label fixture choices as simulated user inputs; it must not call them automatically discovered or pretend the user clicked them.
