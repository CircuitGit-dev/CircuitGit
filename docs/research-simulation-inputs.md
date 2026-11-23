# Research simulation inputs

Three configurations in `pipetisar-research` have complete, offline-compilable local input bundles. Their explicitly bound child subcircuits compile from the same library's native electrical sources at the selected Git commit. Licensed external models and a separately configured simulation site remain prerequisites for execution. This change does not execute a simulator or establish numerical performance.

| Testbench | Configuration | Historical export | Bound canonical children | Local VA modules |
| --- | --- | --- | ---: | ---: |
| `TB_PIPE_CA4_RS9_N06` | `PIPE_LOW` | `Interactive.1` | 23 | 4 |
| `TB_PIPE_CA4_RS9_N06` | `PIPE_NYQUIST` | `Interactive.1` | 23 | 4 |
| `TB_MDAC_CA4_N06` | `MDAC_CODES` | `Interactive.2` | 5 | 2 |

The project IDs are `pipetisar-research-TB_PIPE_CA4_RS9_N06` and `pipetisar-research-TB_MDAC_CA4_N06`. Registrations live in `config/workbench.projects.json`; `config/library-testbenches.json` and the library manifest reference the corresponding configurations. Other research cells without a registered runtime project remain available for viewing only; no new testbench configurations are inferred.

## Source authority and editable scope

Each testbench's `simulation/source-bindings.json` names the unique canonical `.scs` source for each child, its port/instance contract, explicit indexed-bus renames and baseline electrical equivalence. Paths remain under `lib/pipetisar-research/<child>/schematic/research/`. Same-named cells in `pipetisar-real` are not substitutes.

The compiler replaces the bound subcircuit bodies in each configuration's `netlist/project.scs` template using those canonical files at the selected commit. Value and compatible connectivity changes to these bound MDAC, comparator and other children reach the compiled payload and its hash. Port, indexed-bus or instance-structure changes require an explicit binding update. All 23 PIPE children match the exported baseline tokens after the recorded bus renaming. Three MDAC children match tokens; `MDAC4_MOM_BIT_N06` and `MDAC4_REF_CTRL_N06` match electrical statements with statement-order differences recorded explicitly.

The testbench RNL entry used for display is **not itself dynamically compiled** by this registration. The top-level stimulus and design outside bound subcircuits come from the audited exported template. An optional `electrical_guards` binding pins all comment-stripped statements in that displayed TB file, including include directives. Electrical changes therefore fail compilation/materialization with a request to update the TB binding and input template; they cannot silently reuse an old stimulus. Geometry-only RNL comment changes and whitespace remain allowed. The exact TB source hash is recorded as a guarded input, separately from the children recompiled into the payload. Tests cover a committed TB voltage edit producing no materialized bundle and geometry edits preserving simulation bytes.

## Preserved exports and derived inputs

Original exports are under `outputs/adc/mdac_array_20261106/results/<testbench>/<history>/<configuration>/` in the operator's original export checkout. The builder checks both `input.scs` and `design_netlist.scs` against the existing audit hashes before producing derived files.

| Configuration | Original input SHA-256 |
| --- | --- |
| `PIPE_LOW` | `95acfab63f975aa9a5897f8ea02a466b84b048d50618df524596bea0a6d78f11` |
| `PIPE_NYQUIST` | `8aa1465167b6d528c771d80d746852de7bb9753731799d84f15ee61b9d77f120` |
| `MDAC_CODES` | `f58557e559be51614573e9b34ea94cbd357da28926a32e0d0ba966838b8cc09f` |

Both PIPE exports use design hash `5cc3b9e0ed571e5013b178e6073ad79c54a6f81ff77dcea4a66b22c2cb079cd3`. The MDAC design hash is `ba1f933c85e0565d98fbb206017551bd3162be8c8a2a1be085a3e40eae309b54`. Each configuration's `provenance.json` records these identities, unchanged audit/configuration hashes, local dependency hashes and removed external block hashes.

The transformation extracts MDAC's inline design into `project.scs`, changes PIPE's separate design include to that filename, replaces licensed inline definitions with external aliases and replaces absolute include paths with local files or external aliases. Parameters and transient analysis values come from the original inputs. The runtime uses `run-configuration.json`, which differs from the preserved historical `configuration.json` only in its description. Existing `audit.json`, historical configurations, native sources, prior provenance and the hash-pinned `simulation/README.md` migration notes remain unchanged. The library simulation view opens the new `simulation/RUNNING.md` for current registration instructions.

Each configuration includes `bundle.json`, `run-configuration.json`, `provenance.json`, the input/design template, saved-signal and numerical-options includes, and local project Verilog-A files. The two binding files bring the reproducible generated inventory to 33 files. Bundles enumerate their files and expected hashes; actual compilation records the selected canonical sources and compiled hashes separately.

## Dependency revisions and execution boundary

The project VA modules come from the explicitly selected archive `outputs/adc/real_sar_20261106/model_snapshot.json` and its matching `model_snapshot/*.va` files. The builder verifies the manifest hashes and logical module identities. PIPE includes `PIPE_RailClamp`, `PIPE_Clock250_250_500`, `RS9_IO_N06` and `RS9_Merge_N06`; MDAC includes the first two. These are pinned archived project revisions. Their equality to the exact VA revision used by the historical research simulator is **not established**.

Similarly, the saved-signal and `numerical_options.scs` files are **this preparation's selected, hash-pinned local versions** from `outputs/adc/mdac_array_20261106/`. Original input/design hashes verify the references, not the bytes of dependencies loaded during a historical run. Every `local_dependencies` record therefore declares `revision_basis: selected-local-snapshot` and `historical_run_revision_verified: false`. The tests verify these declared hashes against the actual compiled include payloads. Reproducing the prepared inputs does not prove reproduction of historical dependency revisions or results.

The two global expected pins, `PDK_MAIN` and `STDCELL_SVT_LVT`, are inherited from the existing declared operator model revision in the real-library PIPE bundle. They are not newly measured model hashes for the research history. Additional expected pins come from the removed original inline definition bytes:

| Alias | PIPE pair | MDAC | Removed definition SHA-256 |
| --- | --- | --- | --- |
| `RESEARCH_ULVT_ND2D4` | Required | Required | `771565bcf6ed2152670995cfe7e6317bb9b3d7f3d70bb9a64a0cd0330c8fd844` |
| `RESEARCH_ULVT_ND2D0` | Required | — | `31383ef35bfa2d20832b06241921dc59ac802b9698c2e4929e6aae6338cc93f4` |
| `PDK_TRANS_ULVT_PCELL` | Required | — | `e8d98b0603b4989ca6f8550737993b26f7abe83030bd3c957f1d522bf682922c` |

The research ND2D0 bytes differ from the existing real-library pin, so a separate research alias prevents silent substitution. Operators must supply authorized matching external files through the existing site configuration and validate them before execution. PDK implementations, license files, credentials and site paths are excluded. This preparation neither changes runtime grants nor starts SSH, a remote preflight, a model session or a simulation.

## Reproduction and verification

Run from the repository root with the original export checkout supplied explicitly:

```sh
python3 -B tools/library/prepare_research_simulation.py --seed-root /path/to/original-export-checkout
python3 -B tools/library/prepare_research_simulation.py --seed-root /path/to/original-export-checkout --check
python3 -B tests/library/test_research_simulation.py
python3 -B tools/library/test_import.py
python3 -B tools/workbench/test_projects.py
python3 -B tools/dev/build.py all
python3 -B tools/dev/check_structure.py
```

The builder requires the preserved original inputs/designs, selected local includes, pinned VA snapshot and original native TB baseline. It checks that baseline against the existing native import provenance before creating its guard, so rerunning preparation cannot silently bless an edited TB. It does not download missing data. `--check` compares every derived byte with the checked-in version.

The research tests construct an isolated temporary Git snapshot and use the existing Workspace compiler with SSH forbidden. They compile all six registered configurations (one RC, two real-library PIPE and these three research cases), validate source closure and pinned aliases, and test 51 individual child edits across the research cases (23 × 2 + 5). Each edit must change `project.scs` and record the exact changed source hash. Wrong-library bindings must fail without fallback. Tests also exercise optional guard schema validation, backward compatibility with existing guard-free bindings, TB electrical changes, permitted drawing changes and rejected materialization after a committed voltage edit. The generic catalog test includes explicit binding dependencies in its fixture; synthetic external alias paths are only fixture inputs for offline planning and provide no model availability evidence.
