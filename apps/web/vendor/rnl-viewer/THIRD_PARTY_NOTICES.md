# RNL Viewer

Upstream rich-netlist/rnl @ a240fe6bd952a28d0b7497c5c394b6c04d1f6d9c. UI 0.5.1, core @rich-netlist/runtime 0.5.3.
Copyright 2026 many-question. Code MIT; standard packages CC0-1.0; Noto font metrics copyright 2014-2021 Adobe under OFL-1.1.
Local changes: additive ic-selection-bridge.js and index script tag; two inline startup scripts externalized for strict CSP; system-font fallback; no external package catalog; build metadata.
This interface is the upstream RNL Viewer, not a recreation. Selection adapter is project-specific and not an upstream API guarantee.

CircuitGit adds an explicit `demo=1` bootstrap alongside the local live Studio. The demo adapter lives outside the vendored renderer, under `apps/web/demo/`.

CircuitGit's independent `apps/web/studio/index.html` mounts inert renderer markup and initializes the required document UI through its own adapter. Saved Studio URLs redirect before the standalone viewer starts. Renderer-relative library/catalog URLs and detached-window routing support this host entry; the pinned parser, geometry and selection algorithms are unchanged.
