# Deterministic experiment workflow

Registered recipes connect committed circuit source to a frozen testbench, a prelaunch model inventory, one Runner job and five separate report dimensions. The workflow is `prepare → run → inspect`; these steps do not require an LLM. An agent can call the same finite operations through `ic_sim_execute` under an installed operator grant.

Install the paired versions described in [standalone simulation setup](standalone-simulation-runtime.md) and [resource-pool configuration](spiceowl-resource-submission.md). CircuitGit owns source materialization, SSH, submission identity and collection. SpiceOwl supplies deterministic recipe compilation, dependency scanning, measurements and report construction. The gateway Python environment needs the pinned SpiceOwl package and its supported Python version.

The workbench's existing **资源与监控 / Resources and monitoring** view in the simulation panel already renders saved five-dimension reports. This workflow produces the bound report consumed by that display. Register recipes in private operator configuration; use the CLI or native finite operations to execute them. A cached runtime read refreshes stored evidence without preparing, launching or collecting a job.

## Start with explicit source and conditions

Two templates are supported:

| Template | Input and measurements |
| --- | --- |
| `inverter-tran` | Exactly two directly selected MOS instances with explicitly registered polarity and terminal order; transient logic windows and report-only propagation-delay measurements |
| `prepared-transient` | An explicitly selected cell or instance set and its supported subcircuit closure; transient data checks and optional per-signal voltage windows |

Neither template infers supply, process corner, loading, input stimulus or acceptance limits from a cell name. Source selection preserves the original instance statements and records their source ranges and hashes. Model names do not establish terminal semantics: the electrical profile explicitly maps their ordered terminals. A remote four-port declaration verifies port count, not the meaning of those four ports.

Use [the synthetic example](../config/experiment-workflow.example.json) as a configuration reference. Its `example_only` marker is documentation, its connection grant is disabled, and its all-zero `expected_main_sha256` is a placeholder. The example is not a complete gateway configuration or an executable model installation. All project names, hosts, model names and paths are fictional; no PDK, model implementation, key, license or simulation result is included.

The example selection expects this authored source at `projects/example-inverter/source.scs` in an operator-registered project:

```spectre
simulator lang=spectre
subckt ExampleGate IN OUT VDD VSS
MN (OUT IN VSS VSS) example_n w=1u l=200n nf=1 multi=1
MP (OUT IN VDD VDD) example_p w=2u l=200n nf=1 multi=1
ends ExampleGate
```

These dimensions and the example's 1 V stimulus are illustrative test conditions, not process recommendations. `example_n` and `example_p` intentionally have no model implementation here. Before using a real installation, supply your authorized source and model profile, register its project/read paths, commit the source and review the scientific conditions.

## Operator configuration

Merge the `experiment_workflow` object into the existing private gateway configuration. Preserve the installed project registry, `site_file`, `spiceowl_pool_file`, runtime directory and signing settings. Do not replace the normal configuration with the example file.

`experiment_workflow.profiles` maps a profile ID to these fields:

| Field | Meaning |
| --- | --- |
| `electrical` | `spiceowl.experiment-model-profile.v1`: explicit model kinds, MOS polarities, ordered terminals and corner-to-include mapping |
| `dependencies` | Authorized remote roots, main file, selected sections, required master names, finite scan limits and explicit library/config dependencies |
| `expected_main_sha256` | The operator-approved SHA-256 of the expected main model revision; replace the example placeholder |
| `audit_host` | One host in both the recipe's configured pool members and the current connection grant |
| `remote_python` | Absolute installed remote Python executable for the bounded read-only audit; the generated script supports Python 2.7 and 3 |

The current workflow accepts model includes through the `PDK_MAIN` alias. Every section selected by `electrical.corners` must also appear in `dependencies.sections`; `dependencies.main` is the file that becomes `PDK_MAIN`. Preparation audits only the entry sections actually included by the chosen recipe, retaining their global and transitive includes; another authorized corner cannot supply missing model declarations. `dependencies.required_masters` is supplemented with the actual masters used by the recipe. Preparation checks those masters against the audited declarations and the electrical profile.

`experiment_workflow.recipes` is a list of registered recipe objects:

| Field | Meaning |
| --- | --- |
| `id`, `project_id`, `model_profile` | Exact recipe identity, registered project and selected profile |
| `host_ids` | Optional subset of the configured resource pool; all candidates still require authorization |
| `source_paths` | Explicit committed paths already allowlisted by that project's source/read/replacement registry |
| `selection` | Source ID and subcircuit, plus exact instance names and boundary ports for `mode: "instances"`; `mode: "cell"` selects the supported cell closure |
| `spec` | Explicit port roles, supply, temperatures in kelvin, corner, numeric parameters, DC/pulse stimuli, capacitive loads, transient sampling and acceptance windows in SI units |
| `qualification_checks` | Optional frozen subset of `soa_voltage`, `soa_current`, `model_parameter_range`, `model_bin`, `scale_override` |

Missing or unsupported scientific inputs produce a structured blocked plan with `missing` entries. They are not filled with guessed defaults. Changing source, corner, stimulus or acceptance defines a new prepared experiment; preserve the prior run and its evidence.

## Authorization for the three steps

Enable only the private connection scope the operator intends. For this workflow, grant:

| Operation | Additional grant required | Effects |
| --- | --- | --- |
| `prepare` | None beyond its registered project/host scope | Read committed source, perform a bounded remote model audit and save a signed frozen plan; no solver launch |
| `run` | `watch` | Check candidate hosts, select an eligible target, reserve/launch one native Runner job and arm observation |
| `inspect` | `collect` | Observe the original job; for a terminal run, collect and validate native artifacts once, then serve the saved result |
| `runtime` | None | Read cached resources, capabilities, job state and stored reports |

The example names only caller `spiceowl-local`. Add `native-agent`, `paired-helper` or `local-studio` only for the interfaces being installed, using their matching private Service configuration where required. The [standalone guide](standalone-simulation-runtime.md#configure-one-authorized-connection) describes signing keys and the existing grant. This workflow does not approve pending manual IC Service requests.

`inspect` is an active control operation, even when it eventually returns an already saved report. Background watches observe existing jobs; they do not collect artifacts by themselves. `resources_scan` is optional for an explicit console scan, and does not replace the run-time checks.

## Pin dependencies before running

Preparation scans the selected model sections on the authorized audit host. The scanner follows supported `section`/`.section`, `.LIB` and include syntax, recognizes inline subcircuit declarations, and streams file hashes without returning model bodies. File count, bytes, section visits, edges, physical lines and logical continuation lines are bounded. The example explicitly budgets 2 MiB per logical statement; exceeding a bound remains unknown, with location metadata.

Known tool libraries and configuration files belong in `dependencies.profile_dependencies`. They are merged with source-discovered files. The supported `.option tmipath` and `.option etmiUsrInput` directory references use an explicitly selected `tmi_relative_library`, such as `RH_64/libTMImodel.so`, to locate and hash the platform library before launch. That suffix must match the actual simulator installation; it is not inferred from the client computer. Directories are typed references and never receive a file SHA-256.

Missing files, paths escaping the authorized roots (including symlinks), opaque protected content, unresolved conditionals and unsupported dependency references keep the audit unknown and block preparation. Static declarations of `geoshrink` and `scalefactor` retain their original option names. Duplicate/conflicting literals are metadata; the scanner does not evaluate their effective value or treat every `scale` spelling as equivalent.

The main-file hash must match the approved revision. The resulting complete supported-syntax inventory is frozen into the plan and the candidate site mappings. Before resource ranking, `run` excludes nodes whose model/tool files do not match the frozen pins. The existing pool and Runner then perform their selection and same-host checks. A CPU/memory snapshot is not a reservation or an enforced memory limit; see [pool limitations](spiceowl-resource-submission.md).

After collection, the workflow compares all recognized `Reading file` and `Loading` records with frozen model/tool pins and verified native input hashes. A hash obtained after the run cannot retroactively become a prelaunch pin. This is evidence for the declared, observed dependency scope, not a complete operating-system dynamic-loader trace.

## CLI and native calls

Point a private `spiceowl.live-client.v1` configuration at the authorized gateway, as described in [standalone setup](standalone-simulation-runtime.md). Replace the uppercase placeholders with the exact returned identities:

```bash
spiceowl workflow --client-config /absolute/private/live-client.json prepare \
  --recipe example_inverter_tran --source-commit FULL_40_CHARACTER_GIT_SHA

spiceowl workflow --client-config /absolute/private/live-client.json run \
  --plan-id RETURNED_64_CHARACTER_PLAN_ID

spiceowl workflow --client-config /absolute/private/live-client.json inspect \
  --job-id ORIGINAL_JOB_ID
```

For bounded foreground waiting, `execute` composes these same operations:

```bash
spiceowl workflow --client-config /absolute/private/live-client.json execute \
  --recipe example_inverter_tran --source-commit FULL_40_CHARACTER_GIT_SHA \
  --timeout 3600 --poll-seconds 10
```

The timeout bounds client waiting. It does not impose a solver wall-time limit or cancel a remote job. Preserve the returned plan, job and submission key when it expires, then inspect the original job. A gateway that stays available can continue its registered watch after the CLI exits.

Native `ic_sim_execute` and the signed `POST /api/simulation/control` use these exact argument shapes:

```json
{"operation":"prepare","arguments":{"project_id":"example-inverter","recipe_id":"example_inverter_tran","source_commit":"FULL_40_CHARACTER_GIT_SHA"}}
{"operation":"run","arguments":{"project_id":"example-inverter","plan_id":"RETURNED_64_CHARACTER_PLAN_ID"}}
{"operation":"inspect","arguments":{"project_id":"example-inverter","job_id":"ORIGINAL_JOB_ID"}}
```

These are three separate requests. Clients send identities, not model paths, credentials, shell commands or caller-selected authority.

## Preserve uncertainty and identity

The Runner submission key is fixed as `experiment-<plan_id>`. A repeated request for the same prepared plan resolves that same job. The shared client persists uncertain requests and will not resend an unknown launch under a different key.

Use `workflow lookup --key ORIGINAL_SUBMISSION_KEY` to read the original submission mapping, or inspect the bound job when its ID is known. A missing mapping does not prove that a remote launch never happened, and lookup does not clear an uncertain client request. Keep the original journals and Runner receipts for operator reconciliation. Re-preparing, deleting receipts or changing a key is not a recovery operation.

Inspection states include `pending`, `working`, `collecting`, `complete` and `uncertain`. An uncertain collection is not automatically repeated. A complete inspection means its collected result and report are available, not that the circuit passed its requirements.

## Read the five report dimensions

| Dimension | What its result covers |
| --- | --- |
| `execution_status` | Saved execution/completion evidence; interrupted observation is distinct from solver failure |
| `measurement_validity` | Frozen signals and units, finite/aligned values, sample count, full coverage, sample gaps, supply checks and requested windows |
| `functional_performance` | Evaluated logic or per-signal window criteria under this recipe; a valid failure remains a useful result |
| `operating_qualification` | Explicitly frozen operating checks and complete diagnostic evidence; violations, suppression and missing evidence are preserved |
| `dependency_provenance` | Run-bound verification of prelaunch file pins and registered directory references within the declared observed inventory |

There is no overall pass flag. Delay measurements in the inverter recipe are report-only and do not silently add or change a specification target. A successful isolated gate test does not qualify a complete converter, process release or untested operating point. Undeclared qualification scope, incomplete warning bodies or suppressed diagnostics cannot establish a positive operating qualification.

Current measurements support a bounded scalar transient PSF ASCII artifact. Binary/complex/multidimensional results, unregistered analyses, automatic parameter repair and solver relocation require separate implementations and authorization. Source/header inspection alone establishes neither legal process dimensions nor PDK operating limits.

## Offline checks and rollout

The configuration example can be parsed locally without accessing its fictional paths. Recipe preparation can be checked against the authored source above using SpiceOwl's pure `prepare_experiment` API. Neither action establishes a working simulator or model installation.

Before installing a paired release, run the [integration lock checker](../tools/workbench/check_spiceowl_contract.py), affected workflow/client tests and the [report contract checks](../contracts/spiceowl-simulation-report.v1.json). Runtime 1.1.0 embeds the same strict report schema and preserves the optional registered-experiment descriptor.

Keep real profiles, model metadata, frozen plans, signing keys and run artifacts private. Building a package does not update an already running gateway. Follow its service owner's installation/restart procedure and preserve active jobs, watches and uncertain receipts.
