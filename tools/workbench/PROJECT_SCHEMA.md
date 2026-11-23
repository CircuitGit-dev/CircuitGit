# Exact project/materialization interface

Gateway config is installed local trusted configuration, not browser-editable. It pins seed_repo, github_repo, runtime_root, site_file and a `projects` list. Each entry is:

```json
{
  "id":"real-sar-20261106",
  "name":"Real SAR 1GS/s",
  "source_path":"projects/real-sar-20261106/circuit.scs",
  "read_paths":[],
  "configurations":[{
    "id":"PIPE_LOW",
    "name":"LOW 24 ns",
    "configuration_path":"projects/real-sar-20261106/PIPE_LOW.json",
    "bundle_template":"sim/bundles/real-sar-20261106/PIPE_LOW/bundle.json",
    "source_replacements":[{
      "source":"projects/real-sar-20261106/circuit.scs",
      "destination":"netlist/project.scs"
    }]
  }]
}
```

`ic.workbench.project.v1` can wrap this as `{schema,id,name,source_path,configurations}` in the repository for discovery. Only explicitly configured registry entries are executed; no repository scripts/hooks are loaded. PIPE_NYQUIST uses the analogous template and configuration file. Project id/source path above follow the latest schematic-status decision; alternative IDs are supported by explicit config rather than code changes.

Each scientific configuration JSON accepts only `parameters` (map of existing declared parameter names to engineering expression strings), `analysis` (existing stop/maxstep/errpreset/method/maxiters overrides), `simulator` (ic.sim.bundle.v1 profile/args/output_format), and optional description. Example: `{"parameters":{"Ain":"0.9","Fin":"62500000.0"},"simulator":{"profile":"nov6-aps2","output_format":"psfxl"}}`. An empty `{}` preserves the template settings.

The additional supported `postprocess` field explicitly defines new runs' OCEAN export. Example for real-SAR:

```json
{
  "parameters": {},
  "simulator": {"profile":"nov6-aps2","output_format":"psfxl"},
  "postprocess": {
    "signals": [
      {"name":"VINP","unit":"V"},
      {"name":"VINN","unit":"V"},
      {"name":"ROP","unit":"V"},
      {"name":"RON","unit":"V"},
      {"name":"VALID","unit":"V"}
    ],
    "start_s":0,
    "end_s":2.4e-8,
    "step_s":5e-12,
    "max_display_points":1600
  }
}
```

For RC use in/out and end_s=1.2e-8. All times are numeric SI seconds, not strings such as `24n`. Bounds: 1..32 signals, units V/A, finite increasing window, positive step, <=200000 exported points, display target100..5000. Missing postprocess keeps native raw only and reports not_configured; the backend does not guess signals from design_id. These settings are compiled into the signed bundle and stored in the run plan/source provenance. Completed older validation exports remain intact and are not rerun.

The backend reads committed template files with `git show`, substitutes the one canonical circuit, applies scientific configuration, recomputes every derived bundle file hash, and signs a materialization manifest containing the actual source commit and source SHA256 values. It does not modify archived bundles or their history hashes. The runner accepts only locally signed materializations from its configured private runtime directory. `source_commit` always refers to the user's real versioned source, not an invented commit for generated files.

HTTP uses exactly phase2-interface.md. Preview returns unified diff and validation; commit receives the same changes/base_commit/message/push. Plan/preflight/jobs accept stable string project_id/configuration and source_commit. Health returns X-Workbench-Token bootstrap; it is an ephemeral local CSRF token, never a GitHub/SSH credential.


## Library project registration

`library_id` and `cell_id` are optional strings on a configured project record. They identify a public catalog cell without replacing the stable project ID, exact source/configuration paths, source commit or hashes. For the built-in RC project they are `basics` / `rc-smoke`; its canonical `projects/rc-smoke/` files remain in place. Runtime run/supervision projections are unchanged.

Explicit editable sources, configuration files, source replacements and read-only files may use either `projects/<project>/...` or `lib/<library>/<cell>/<view>/...`. Library metadata, when present on a `lib/` source, must match its path. Paths are not normalized: absolute paths, dot/empty segments, backslashes, controls and URL/drive prefixes are rejected; existing per-file allowlists, symlink checks, clean/base-commit checks and mandatory MCP review hashes still apply. There is no directory grant, catalog auto-discovery, path derivation from IDs or fallback between projects and libraries. Every replacement source is returned in its project's file tree; registered read-only status prevails if a file is shared.

A library record can therefore look like this (illustrative only):

```json
{
  "id": "explicit-filter-project",
  "library_id": "examples",
  "cell_id": "filter",
  "source_path": "lib/examples/filter/netlist/circuit.scs",
  "read_paths": ["lib/examples/filter/README.md"],
  "configurations": [{
    "id": "TRAN",
    "configuration_path": "lib/examples/filter/simulation/TRAN.json",
    "bundle_template": "lib/examples/filter/simulation/template/bundle.json",
    "source_replacements": [{
      "source": "lib/examples/filter/netlist/circuit.scs",
      "destination": "netlist/project.scs"
    }]
  }]
}
```

The bundle template retains the existing explicit file closure and external-alias hash pins. Missing files/models block replay; project metadata never supplies or authorizes external models. Geometry, if separately registered, must retain the existing `ic.native-geometry.v1` manifest/source/hash contract. A library source may use a manifest under the same cell's `schematic/`, `native/` or `geometry/` directory. A public `library.json` or native drawing alone is not a simulator project or a substitute geometry proof.

Only electrically complete, explicitly reviewed replay projects belong in the installed runtime registry. Cells that have only a drawing, incomplete model closure, or unverified historical input association keep `project_id: null` in the public catalog. Preview/apply/submit use the original review ledger and human approval; adding library support does not approve, dispatch, recollect or republish anything.
