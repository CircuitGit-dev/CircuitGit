# Shared contracts

- `ic-tools.v1.json` is generated from `modules/gateway_client/ic_gateway/contracts.py`. CLI, MCP and web AI use this same executable schema. Run `python3 -B tools/dev/export_contracts.py` after intentional changes; `--check` detects drift. Never edit the JSON alone.
- `modules.v1.json` identifies canonical implementations and host requirements. It describes existing code, not unimplemented Codex window capabilities.
- `workspace.d.ts` documents the public version-1 context consumed by panels. Runtime behavior remains in `modules/workspace/context.js`; private source bytes, tokens and site configuration are not part of this context.

Versioned operation protocols continue to use their existing names: `ic.sim.bundle.v1`, `ic.sim.run.v2`, `ic.native-geometry.v1`, `ic.waveform-map.v1`, and `ic.rnl.plot.v1`. This reorganization does not reinterpret their identities or rewrite historical manifests.

Protocol references:

- [Native geometry](../docs/native-geometry-interface.md)
- [Waveforms](../docs/waveform-interface.md)
- [Simulation bundles/site/receipts](../tools/sim/INTERFACE.md)
- [CLI/MCP](../apps/codex/docs/interface.md)
- [AI sessions](../docs/ai-sessions.md)

A historical run may have an original `project_id` different from the currently registered project. Use the gateway's verified association for routing and preserve the original receipt. Exact source/geometry mapping is required for schematic probing; independently viewing that run's saved waveform catalog does not require current schematic equivalence.
