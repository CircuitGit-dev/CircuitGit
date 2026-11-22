# Public release scope

CircuitGit starts from application snapshot `58fa137a66724b2b7aa97e36ff8dfcc59e2a4c25` of the IC on GitHub development project. The new repository preserves its own initial commit and MIT license; private repository history is not imported.

Included: browser source and vendored dependencies, shared modules, CLI/MCP/plugin code, generic gateway/export/simulation tools, contracts, application tests and architecture documentation, a PDK-free RC source/configuration/bundle, and CircuitGit branding. A static adapter reuses the RNL viewer, Dockview layout and waveform renderer for GitHub Pages.

Not copied: prior `design/`, production `projects/`, `sim/`, `results/` and `validation/` data, native archives, private server configuration, runtime chat/approval state, or any Cadence/PDK installation. These remain in the original engineering repository. The RC project is the explicit redistributable exception.

Several retained tests and older notes describe the original PIPETISAR engineering integration. Those references are historical context, not included datasets or a claim that the public clone passed those private-data integrations. The public CI checks build/module contracts and self-contained reference tests; browser acceptance covers the static demo. Generic tools such as `tools/check_project.py` still require their original engineering inputs when invoked.

The demo's fixed RNL geometry was authored for this public RC example. It is not an export from Virtuoso. Waveform values are mathematical reference data calculated in-browser, with current defined as entering R0 terminal 1. AI inference, real Spectre jobs, local accounts and Git mutations are absent from the hosted demo.
