# CircuitGit visual product guide (2026-11-24)

The guide at `apps/web/workflow/index.html` centers AI-native local circuit design
and cell-scoped Git management. SpiceOwl owns a different story: Agent-assisted
simulation resource/environment management, supervision and analysis.

## Narrative and implementation evidence

- The module map connects Library, RNL, Agent, Git, Testbench CI and SpiceOwl to
  the same local circuit/source identity. The current catalog count was read
  from its four manifests: 22 + 64 + 10 + 2 = 98 cells.
- The Bridge comparison covers its online schematic-editing path. Local source
  inspection confirms Bridge's high-level Python API, batch SKILL and independent
  Spectre capabilities. No Bridge timing or remote round-trip benchmark is claimed.
- A separate local Git fixture used the real `LibraryWorkflow.read_file` and
  `execute(save, commit, restore)` to add a second stage to the public inverter,
  update its output and RNL placement/wiring, commit it, then restore baseline
  contents without resetting history. `design-demo.json` records the actual
  hashes, commits, diff, receipts and scope. No push or simulation was performed.
- `design-baseline.svg` and `design-buffer.svg` are actual output from the pinned
  bundled RNL WebAssembly renderer. Both selected levels built without errors;
  static RNL success does not qualify electrical performance.
- Agent connection and developer-mode sections follow `agent-connections.md`
  and `library-agents.md`. Developer full access is not confined to the initial
  directory; it remains separate from ordinary finite circuit tools.
- The engineering section identifies shared-source compilation, geometry,
  checkpoint/idempotency handling, model state synchronization, TB CI and host
  adapter boundaries. It avoids unsupported claims based on code-line counts.

Historical ten-stage source/contract material stays expandable and retains its
original snapshot identity. Existing Spectre plots remain a supporting example,
not the primary product story. The 1 V Bootstrap logs contain SOA warnings;
`showcase-evidence.json` separately records that check. Those results were separate
Runner reruns, not evidence that the original onboarding review completed.

All new interaction controls only change explanatory content. The resource
teaching interaction belongs to SpiceOwl; this page does not connect an Agent,
change permissions or submit an experiment. Static assets remain in the declared
web roots and are included by the existing build.
