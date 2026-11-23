# Getting started with CircuitGit

## Hosted demo

Open **https://joshuazeng713.github.io/CircuitGit/**. The static entry loads the existing RNL Viewer, Dockview layout, and shared waveform panel with a public RC reference adapter. Assets are addressed relative to the project path, including the module worker and WASM file.

Drag tabs to rearrange panels. Use ↗ to float a panel and ↙ to return it. The Window menu restores closed panels or the default layout. In Plot, select a voltage probe and click `in`/`out`, or select a current probe and click `R0`. In the waveform panel use F to fit, Z to select a zoom region, A/B for cursors, M for measurements, and ? for shortcuts.

Simulation controls update the RC analytical reference or export `TRAN.json` and `circuit.scs`. The reference is the closed-form first-order response over piecewise-linear input segments, sampled every 5 ps. It is not a Cadence execution, a PSF export, or evidence of a remote job.

The AI panel's default **连接本机 Codex** button opens a local authorization window. Start the local helper once (macOS: double-click `Start CircuitGit.command` with Python 3.10+, Git and Codex installed), approve the connection, then select an engineering project. Codex's official login page is offered if sign-in is required. No account requests run before confirmation. Server URL/code entry remains under Advanced; follow [connection setup](remote-node.md). The sample canvas remains separate from the AI's real project.

## Local application

1. Install Python 3.10+ and Git; clone the repository.
2. Run `python3 -B tools/workbench/launch.py`.
3. Open `http://127.0.0.1:8766/`.
4. Edit `config/site.local.json` with your authorized site's SSH alias, run directory, setup script, Spectre executable and OCEAN executable. Examples contain placeholders, not a usable shared server.
5. Review your project's configuration and plan, run preflight, and explicitly submit a job when ready.

The startup command builds assets and uses a separate local runtime checkout. It does not submit a simulation. The RC project uses built-in components and needs no PDK. Other projects may require operator-supplied licensed models. Source and configuration commits, run identity, collection and publication are separate stages.

The configured remote run directory must be absolute and end in `ic_on_github_runs`, as required by the existing runner's dedicated-directory guard. Choose an operator-owned directory with that final component; do not point it at a general home or project directory.

The local RC example contains a basic text netlist. To explore its prearranged schematic without setting up a gateway, use the static demo. Full native geometry import is available through the exporter workflow and a local project's geometry manifest.

## AI and MCP

See [agent connections](agent-connections.md), [plugin installation](plugin.md), and [MCP windows](codex-mcp-windows.md). The optional web chat uses a local agent adapter; MCP exposes circuit tools to compatible hosts. An MCP connection does not itself provide model inference or subscription access.

```bash
python3 -B apps/codex/ic_workbench.py --json schema
python3 -B tools/dev/build.py codex
```

Normal circuit writes and submissions retain the application's human-review flow. Developer mode is an explicit local-session setting; it is not enabled by the hosted demo.

## GitHub Pages deployment

`.github/workflows/pages.yml` builds the site from `apps/web/` and `modules/`, uploads only static output, and deploys on pushes to `main`. In Settings → Pages, the build source is **GitHub Actions**. `tools/dev/build_pages.py` generates an embedded snapshot of recent public commits for the demo's version panel.

```bash
python3 -B tools/dev/build_pages.py
python3 -m http.server 8765 --bind 127.0.0.1 --directory site
```

Keep `*.local.json`, `.env`, `.local/`, `runs/`, PDKs and private engineering projects outside the public release.
