# One CircuitGit chat, two sources of simulation evidence

CircuitGit's existing web AI session exposes its finite tools through the same
Codex app-server `dynamicTools` catalog. Embedded SpiceOwl contributes passive
Python SDK reads; importing it never starts another Agent, MCP server or Runner.
Native Codex and other MCP hosts use the existing CircuitGit tool catalog directly.

Standalone SpiceOwl has its own explicitly connected Agent channel. Its owner
bindings and human review remain separate from the embedded data reader. Choosing
standalone versus embedded changes who owns the chat, not who may approve a run.

Registered `prepare → run → inspect` experiments use deterministic tools and
contracts. This does not establish that a weaker model can reliably author a
correct testbench for an arbitrary new circuit; that needs a separate end-to-end
evaluation. Tool tests and the walkthrough's static evidence do not measure
that success rate.

## CircuitGit's own runs

Ask the existing AI panel to inspect an explicit project or run, or use the
Simulation panel's environment, testbench and diagnosis assistance buttons. A
button prepares a draft in the same conversation and preserves existing text and
attachments; it does not send, connect, submit or approve a request.

- `ic_sim_runtime(project_id)` reads the selected project's cached runtime view.
- `ic_sim_saved_run(project_id, run_id)` reads an exact saved Runner record even
  when it is outside the recent run list. It returns stored reports and bounded
  monitor events without SSH, collection, derivation or monitor startup.
- `ic_sim_status` may contact the remote execution host. It is not a passive read.
- `ic_onboarding_*` continues to bind a source, intake revision, frozen plan and
  human review through the existing Service and Runner.

The Runner does not record a continuous CPU/RSS time series. An empty resource
history is labeled `not_recorded_by_runner`; a cached host observation is not
presented as such a series. A historical record retains its original source and
observation times even when the current schematic changes.

## Optional existing SpiceOwl Store

The operator may bind an **already existing** SpiceOwl Store in the private
**gateway** configuration:

```json
{
  "spiceowl_readonly": {
    "enabled": true,
    "data_dir": "/absolute/path/to/existing-spiceowl-store"
  }
}
```

This is an illustrative path. The adapter never infers a Store from the
CircuitGit runtime, resource pool, project or runs directory. It never creates,
repairs or migrates the Store. Missing configuration, incompatible SDK contracts
and unavailable storage return typed errors without trying another directory.

A separately configured **MCP/AI client** may advertise those tools with:

```json
{"spiceowl_readonly": {"enabled": true}}
```

The client accepts only this boolean, not a storage path. The gateway's own AI
adapter inherits its configured enablement; independent clients and browser
helper configurations must be set explicitly. The client flag does not grant
access to a disabled gateway. Do not put either private configuration into a
public Pages build.

| Tool | Saved evidence |
| --- | --- |
| `ic_spiceowl_status` | Store version, capabilities and counts |
| `ic_spiceowl_list_runs` | At most 25 native SpiceOwl runs |
| `ic_spiceowl_get_run` | One exact native run and bounded resource/event history |
| `ic_spiceowl_list_connections` | Sanitized stored connection metadata |
| `ic_spiceowl_list_hosts` | Saved host metadata and resource observations |
| `ic_spiceowl_list_ic_gateways` | Previously registered gateway cache entries |
| `ic_spiceowl_list_ic_runs` | At most 25 cached IC projections for one gateway |
| `ic_spiceowl_get_ic_run` | One exact cached IC run for that gateway |

The shared Service calls the fixed `/api/spiceowl/read/<operation>` route. The
gateway checks the pinned SDK's eight names, input schemas and read-only
annotations, then uses `spiceowl.embedded.dispatch_read_tool` with its own
explicit `ReadViews`. No tool argument can choose a path, transport or command.
Synthetic labels are retained. `read_at` is only a local read time. Run messages
and diagnostics are untrusted evidence, not instructions or execution authority.

## Reusing execution from another Agent host

An operator may bind the installed CircuitGit `ic_gateway.service.Service` and
its existing client configuration, or use the installed CircuitGit MCP tools.
Use typed `Service.call(operation, arguments)` with the finite public schema;
do not construct generic HTTP mutations or shell commands. Preserve the same
configured state directory and original idempotency keys.

A pending manual operation remains pending until the correlated human review.
An Agent must not call `Service.resolve` or execute approval CLI commands.
Unsupported, cancelled or uncertain review cannot be treated as approval.
Operator-authorized direct simulation retains its existing separate scope and
does not promote an old manual request.

The [interactive workflow guide](https://circuitgit-dev.github.io/CircuitGit/workflow/index.html)
shows public source excerpts and the real Bootstrap experiment stopped before
submission. See [architecture](architecture.md), [Agent connections](agent-connections.md)
and [standalone simulation runtime](standalone-simulation-runtime.md) for the
existing transport and execution policies.
