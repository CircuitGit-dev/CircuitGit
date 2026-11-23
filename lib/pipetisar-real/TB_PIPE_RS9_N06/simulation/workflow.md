# Versioned simulation inputs

The registered project is `pipetisar-real-TB_PIPE_RS9_N06`, with `PIPE_LOW` and `PIPE_NYQUIST` configurations. The local companion compiles an explicit committed library revision. `source-bindings.json` maps the 21 subcircuits in the historical template to their canonical cell sources, including the recorded bus-name mappings. Editing a bound child cell therefore changes both its parent schematic and the next compiled simulation inputs. Interface or indexed-identifier changes require an explicit binding update.

The original templates, Verilog-A sources, save lists and provenance hashes remain unchanged. Compiled inputs are separate signed snapshots with the selected Git commit and actual input hashes. No simulation was executed as part of this source migration, and historical performance is not revalidated by compilation.

PDK and standard-cell implementations remain remote dependencies under four pinned aliases: `PDK_MAIN`, `PDK_TRANS_ULVT_PCELL`, `STDCELL_SVT_LVT`, `ULVT_ND2D0`. Local editing and compilation do not require model paths. Submission requires an operator-configured execution site with matching remote model hashes. The empty drawing interface is never used as a simulation model. A paired browser or configured Agent can use the direct workflow within that operator scope; old pending manual requests remain pending.

- `PIPE_LOW`: `PIPE_LOW/configuration.json` and `PIPE_LOW/provenance.json`.
- `PIPE_NYQUIST`: `PIPE_NYQUIST/configuration.json` and `PIPE_NYQUIST/provenance.json`.

Keep site settings, credentials and licensed model implementations outside this public library. Source CI checks portable inputs and RNL rendering; a successful source check does not establish a successful Spectre run.
