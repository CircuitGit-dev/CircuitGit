# Historical simulation input candidates — inactive

These files describe historical inputs; this public cell remains `project_id: null`. No simulation was executed during migration. Original input hashes identify historical evidence; redacted templates have different bytes and have not been replayed. They are not automatically bound to the native viewer snapshot.

Two real-SAR templates retain the project Verilog-A sources, saved-signal list and analysis/solver configuration. PDK and standard-cell implementations are externalized as four pinned aliases: `PDK_MAIN`, `PDK_TRANS_ULVT_PCELL`, `STDCELL_SVT_LVT`, `ULVT_ND2D0`. The empty interface in the schematic view is not a simulation model and must never be substituted for these dependencies. `reviewed_for_distribution: false` remains the bundle gate: publishing this sanitized reference does not approve runtime distribution or execution. Complete authorized model bindings and a separate replay review are still required.

- `PIPE_LOW`: `PIPE_LOW/configuration.json` and `PIPE_LOW/provenance.json`.
- `PIPE_NYQUIST`: `PIPE_NYQUIST/configuration.json` and `PIPE_NYQUIST/provenance.json`.

Use the original history and source hashes in each audit when preparing a future complete replay; preserve external model licenses and site settings outside this public library. No old performance result is newly verified here.
