# Git circuit libraries through Agent tools

The web AI bridge, the zero-dependency CLI/MCP plugin, and the optional official-SDK MCP entry use the same installed library workflow. A library cell can be read and edited without a PDK, Virtuoso, a simulation gateway, or registration as a runtime simulation project. The application loads its packaged workflow code; it does not execute Python from the circuit checkout.

## Operator configuration

Add these fields to the local client or plugin settings. Paths are examples; use the same checkout and state directory as the paired browser helper to share checkpoints and operation receipts.

```json
{
  "library_workspace": "/absolute/circuit-checkout",
  "library_repository": "owner/repository",
  "library_access": "direct",
  "library_state_dir": "/absolute/circuit-checkout/.local/browser-helper/library",
  "library_base_branch": "main",
  "library_testbench_registry": "/absolute/trusted/config/library-testbenches.json"
}
```

Keep the entrypoint's existing `gateway_url` and `state_dir` fields. Library calls bypass gateway startup. `library_workspace` is required to advertise the two library tools. Access defaults to `read_only`; `direct` permits finite cell-scoped library writes. An explicit read-only web AI turn still denies writes. Testbench registrations default to the installed application's registry when the override is omitted. The library state directory must be under the checkout's ignored `.local/` directory.

Models cannot select another checkout, change operator access, or pass approval flags. The manifest committed at the current Git HEAD defines each cell's allowed files. Owned electrical source and RNL geometry can be edited; shared dependencies, imported provenance and historical validation evidence remain read-only. Declaring a cell in the library does not register a runnable simulation project.

Shared sources are stored once. A view's `aliases` map preserves its historical relative include/package paths while resolving to declared physical source files. Read and edit the physical file reported by the owning cell's `describe`; do not recreate copies at virtual alias paths. Changing a dependency in its owning cell can affect multiple views, which need a new refresh/check. Historical provenance retains the original imported names and hashes.

## Tool flow

`ic_library_read` takes `{operation, arguments}`. Begin with `capability` and `catalog` using empty arguments. The catalog contains compact cell/view identities; use `describe` for the selected cell's complete file scope, followed by `read_file` for current text, SHA-256 and Git base commit. Other read operations are `branches`, `current`, `history`, `commit_detail`, `checkpoints`, `get_ci`, `receipt`, and `pr_status`. The last operation explicitly queries GitHub and needs the operator's existing GitHub connection.

`ic_library_execute` takes `{operation, arguments, idempotency_key}`. Operations are `save`, `save_files`, `commit`, `restore`, `pr`, `ci`, `create_library`, `create_cell`, `clone_cell`, `create_branch`, and `switch_branch`. Operator-authorized direct library work has no additional workflow approval popup. Native host tool policy can still require human permission. Existing simulation request/review rules are unchanged. `pr` accepts optional `related_cells` (`[{library_id, cell_id}, ...]`) for coordinated multi-cell changes, while continuing to reject edits outside the declared cell set.

For coordinated electrical and schematic edits, read both current files and send one `save_files` operation:

```json
{
  "operation": "save_files",
  "arguments": {
    "library_id": "demo",
    "cell_id": "gain",
    "files": [
      {"path": "lib/demo/gain/spectre/input.scs", "base_sha256": "<returned SHA-256>", "content": "<complete edited netlist>"},
      {"path": "lib/demo/gain/schematic/circuit.rnl", "base_sha256": "<returned SHA-256>", "content": "<complete edited RNL>"}
    ]
  },
  "idempotency_key": "one-stable-key-for-this-edit"
}
```

Use exact paths and hashes returned by `describe`/`read_file`, not these example names. Group saves use checked original hashes, local checkpoints and a durable receipt. Only `state: complete` establishes completion. `partial`, `rolled_back`, `unknown`, or any incomplete state stops dependent work. Keep the original idempotency key and inspect `ic_library_read` with `operation: receipt` and that key; reconnecting does not authorize replay under another key.

After a successful edit, read `current` and the changed files again, then ask the viewer to refresh its current local source. A successful write does not establish successful rendering, automatic layout/routing, or simulator verification. Placement/wire changes must be present in the owned RNL data; a netlist-only edit does not regenerate Virtuoso geometry. Historical import hashes remain historical.

`commit` records the selected cell's current changes locally using an exact base commit and a meaningful message. `restore` from a commit or either side of a checkpoint makes a new working change and checkpoint; it does not reset the branch or remove later history. `pr` explicitly publishes the selected cell's bounded commit and creates/updates its PR through the existing GitHub login; it does not merge. `ci` saves a selection of operator-registered testbenches. Saving CI configuration does not start a simulation or prove that a check passed.

## Runtime binding and exact source compilation

The public catalog contains 98 cells. Source/RNL checking is independent of PDK availability. The registered `pipetisar-real/TB_PIPE_RS9_N06` testbench has two ADC input compilation configurations, `PIPE_LOW` and `PIPE_NYQUIST`. Configuration presence and successful compilation do not establish a new Spectre result.

The source context's `project.runtimeProjectId` comes from the cell's committed manifest `project_id`, read at the same Git HEAD as its source identity. A null value remains unbound. `/api/ai/catalog` also exposes `runtime_project_id`; it marks `runtime_available` only after that exact ID appears in the actual runtime catalog with consistent cell metadata. `can_simulate` additionally requires returned configurations and runner capability. `simulation_readiness: requires_preflight` still requires remote dependency checks; it is not proof of working model aliases or licenses.

Use `ic_projects` to discover the actual runtime/configuration IDs. If the host advertises `ic_sim_runtime`, use its declared schema for additional runtime observations; a host without that tool must not be given an invented call. First save and commit the intended circuit/configuration changes, then read the library's exact HEAD and pass it as `source_commit` for the observed project/configuration. Do not substitute the runtime checkout's older HEAD.

With operator `source_repository` configured, the compiler reads source blobs directly from that library Git snapshot. The configuration's `canonical_bindings_path` identifies the source binding data used to assemble the shared electrical inputs. It does not checkout/reset the runtime workspace or copy model files. Missing or mismatched external model aliases, model hashes, licensed tools or runtime configuration block submission explicitly. PDK and licensed Spectre live at the authorized remote site; library edits and source CI need neither Virtuoso nor OA.

## CLI and web context

The CLI accepts operation arguments from a JSON file, avoiding shell quoting of source text:

```bash
python3 -B apps/codex/ic_workbench.py --config /absolute/client.json --json library-read --operation catalog --arguments /absolute/empty-object.json
python3 -B apps/codex/ic_workbench.py --config /absolute/client.json --json library-execute --operation save_files --arguments /absolute/edit-arguments.json --idempotency-key one-stable-key-for-this-edit
python3 -B apps/codex/ic_workbench.py --config /absolute/client.json --json schema
```

The first file contains `{}`; the second contains only the inner `arguments` object shown above. Default `schema` retains the core tool catalog. A configured schema adds the optional library tools without starting services.

The web bridge exposes configured library cells as `library:<library_id>/<cell_id>` in `/api/ai/catalog`. Bound cells inherit configurations only from the observed runtime catalog; other cells remain editable without simulation registration. `/api/ai/context?project_id=library:demo/gain` supplies the current local source identity, bounded `library` context and manifest-observed runtime hint. The AI turn freezes the operator binding. Changing the checkout/access binding starts a fresh model thread; an in-flight binding mismatch suspends dependent tool work. Explicit file selection may add the exact `path` query field.

Native MCP hosts call these tools directly. They do not need to open the web AI bridge or start a second model session.
