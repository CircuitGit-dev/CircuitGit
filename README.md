<p align="center"><img src="docs/assets/circuitgit.svg" width="128" alt="CircuitGit: transistor and Git branches with a subtle AI backdrop"></p>

<h1 align="center">CircuitGit</h1>
<p align="center"><strong>AI-native circuit design, versioned on GitHub.</strong></p>
<p align="center"><a href="https://circuitgit-dev.github.io/CircuitGit/workflow/index.html"><strong>Explore the product showcase</strong></a> · <a href="https://circuitgit-dev.github.io/CircuitGit/">Open workbench</a> · <a href="docs/open-source-simulation.md">Local open-source simulation</a> · <a href="docs/cross-platform-testing.md">Windows / macOS &amp; Testing</a> · <a href="docs/remote-node.md">Connect your Codex node</a> · <a href="README.zh-CN.md">中文介绍</a></p>

CircuitGit is an AI-native environment for local circuit design and Git-based circuit versioning on **macOS, Windows 10/11, and Linux**. Agents read and edit circuit source directly in a local checkout, RNL renders the schematic, local `ngspice`/`Xyce` (with optional open PDKs) or remote Spectre runs simulations, and Git records reviewable design changes. Everyday source editing, schematic viewing, and local open-source simulation do not require an online Virtuoso session or commercial licenses; SpiceOwl provides tools for remote licensed simulation preparation, supervision and analysis.

## Highlights & New Capabilities

- **Native macOS, Windows 10/11 & Linux support (zero-CLI daily workflow)**: Double-click **`Start CircuitGit.bat`** on Windows or **`Start CircuitGit.command`** on macOS once to start the local helper; all subsequent design, simulation, and Git actions run in the browser. A shared zero-dependency OS layer (`platform_compat.py`) and static CI guard keep future features cross-platform automatically ([guide](docs/cross-platform-testing.md)).
- **Local open-source SPICE & open PDKs in the Web UI**: Run **`ngspice`** or **`Xyce`** locally without SSH or commercial licenses, with built-in PDK-free models (`rc-smoke`, `open-cmos-inverter` TRAN/DC/AC) or local **`SKY130` / `GF180MCU` / `IHP SG13G2`** PDK profiles—auto-detected and configurable directly in **Simulation → 环境与PDK** ([guide](docs/open-source-simulation.md)).
- **Unified workspace connection hub & bidirectional AI + SpiceOwl scheduling**: A single topbar connection hub coordinates Codex AI, remote Spectre/PDK onboarding (SpiceOwl), and local library/Git access from one pairing flow—with unified simulation run tracking, saved non-secret remote host/PDK hint presets, and cross-panel Agent assistance drafts.
- **Unified Live & Demo circuit library CRUD, Git branches & multi-cell PRs**: Both the static web demo and the Live local workbench share the same `Library → Cell → View` manager (`Library Manager`) and version control workflow—create libraries, create or clone cells, switch/create Git branches, and open single or multi-cell related Pull Requests directly in the browser or via Agent/MCP tools ([guide](docs/circuit-libraries.md)).
- **Live Netlist ↔ RNL incremental layout & restored schematic probes (remote & local)**: Editing a netlist or opening an open-source circuit (`rc-smoke`, `open-cmos-inverter`, or new library cells) renders a hash-bound Live RNL schematic (`/api/schematic/live`) that preserves existing `@RNL` placements/wires for unchanged devices and automatically derives exact SHA-256 verified probe bindings for both remote SpiceOwl/Spectre onboarding runs and local `ngspice`/`Xyce` runs—click schematic nets or device terminals to plot waveforms directly.
- **Cross-platform one-command test runner, 3-OS CI & portable Release bundles**: Run `python3 -B tools/dev/run_tests.py` (or `python -B tools/dev/run_tests.py` on Windows) locally to verify architecture/cross-platform guards, builds, browser helper, local `ngspice` simulation, library CRUD/PRs, AI/MCP, and frontend tests—matching our automated macOS / Windows / Linux [Cross-Platform CI](.github/workflows/cross-platform-ci.yml) and portable [Release packaging workflow](.github/workflows/release.yml).

## Product showcase

**[Explore CircuitGit: local AI design and Git circuit management](https://circuitgit-dev.github.io/CircuitGit/workflow/index.html)**

- Explore the six-part architecture connecting libraries, RNL, Agent, Git, testbench CI and SpiceOwl.
- Inspect a real inverter-to-buffer topology edit, native RNL rendering, and recorded Git save, commit and restore operations.
- Compare the local design workflow with Virtuoso Bridge, configure an Agent, and see how developer mode lets the web chat develop CircuitGit itself.

The guide uses diagrams, circuits and saved simulation results to explain the benefits and engineering behind the workbench. The Bridge comparison describes workflows; it is not a timed benchmark.

**Related project:** [SpiceOwl — independent simulation management for engineers and Agents](https://spiceowl-dev.github.io/spiceowl/workflow.html). Use its own console, CLI and SDK for server capacity, PDK setup, run supervision and result diagnosis, or integrate its tools into CircuitGit.

## Simulation integration

The optional [SpiceOwl simulation runtime](docs/standalone-simulation-runtime.md) selects an eligible registered server, runs standalone Spectre through the existing Runner, monitors disconnections, and derives supported waveforms from collected native results. CLI, local web and native-agent operations share an explicit operator grant. Install the paired pinned packages to use this path; the public static demo does not execute remote simulations.

[Deterministic experiments](docs/deterministic-experiments.md) add registered prepare → run → inspect recipes: freeze the source, conditions and model dependencies before launch, then read five separate evidence dimensions in the existing report view. The guide includes a disabled synthetic configuration example for operators.

[Agent-authored testbenches](docs/agent-testbenches.md) add general DUT/TB imports, full human review before execution, host-bound PDK lookup and saved-data FFT/ADC analysis. Reviewed cell bundles can be versioned under `lib/<library>/<cell>/testbenches/` and evaluated against an exactly matching run. Automatic experiment acceptance uses a single scalar transient export. Separately selected native AC and unswept DC datasets support saved-data Bode and operating-point analysis; they do not automatically enable AC/DC CI acceptance.

The interface builds on [Rich Netlist](https://github.com/rich-netlist/rnl), with movable, closable Dockview panels for schematics, simulation, waveforms, AI, and version history.

## Try it

**[circuitgit-dev.github.io/CircuitGit](https://circuitgit-dev.github.io/CircuitGit/)**

The GitHub Pages demo runs entirely in your browser. Drag panel tabs, float and return windows, inspect a fixed-layout RC schematic, select voltage/current probes, pan and zoom waveforms, and export a simulation configuration with its netlist.

The demo waveforms are explicitly labeled **analytical RC references**, calculated in the browser. Opening the website does not contact your local machine or start an AI model or Spectre job.

The [product showcase](https://circuitgit-dev.github.io/CircuitGit/workflow/index.html) also includes saved native Spectre waveforms and independently recomputed metrics from separate Bootstrap and inverter runs. The earlier ten-stage onboarding snapshot remains available as a historical reference; those later runs do not complete its pending review.

Open **Libraries / 电路库** to browse library → cell → view. The published ADC snapshots preserve the exported Virtuoso component positions, wires and symbols. Their documentation identifies missing device models and replay inputs; browsing a snapshot does not register it as a runnable project. Selecting an ADC view clears the RC reference waveforms. See the [circuit library guide](docs/circuit-libraries.md) and [library catalog](lib/README.md).

For real AI conversations, choose **连接本机 Codex** in the AI panel and approve the local connection window. The connector checks Codex's existing login and reports the account/plan only when Codex supplies it. If Codex requires sign-in, a separate button opens the official login URL returned by Codex. No address or access code is needed in this flow.

Start the local helper once per computer session: double-click **Start CircuitGit.bat** on Windows or **Start CircuitGit.command** on macOS in the downloaded repository (requires Python 3.11+, Git, and optional `ngspice` / Codex). On first use, the launcher installs the repository-pinned SpiceOwl dependency with its `adctools` extra (NumPy, SciPy and ADCToolbox 0.9.3) into a project-local Python environment; it does not change your global Python packages. The helper stays on your computer while you use the lightweight website, with zero terminal commands needed for everyday work. Self-hosted server URL/code entry remains under **Advanced**. See [connection setup](docs/remote-node.md) and [cross-platform compatibility & testing](docs/cross-platform-testing.md).

Connection, account, project and model controls are grouped in the chat's **settings gear**. Choose **当前网表** to share the imported source and simulation intake with AI; results refresh that exact intake in the Simulation panel. Other selected node projects retain their own identities. This release does not import desktop windows, offer public subscription OAuth, or grant model access independently of the node. Existing circuit and manual simulation requests retain their human-review workflow; the optional standalone runtime requires a separately installed connection grant.

![CircuitGit workbench](docs/assets/workbench.png)

## What is included

| Capability | Implementation |
|---|---|
| Circuit viewing | RNL Viewer and its WebAssembly renderer; preserved schematic positions and wiring when exported geometry is supplied |
| Local open-source simulation | Zero-license local `ngspice` / `Xyce` with pure-Python cross-platform supervisor, Web UI configuration, and `builtin` / `SKY130` / `GF180MCU` / `IHP SG13G2` PDK profiles |
| Remote commercial simulation | Versioned configuration → reviewed changes → plan/preflight → Spectre submission via SSH/SpiceOwl → result collection → GitHub archive |
| Waveform analysis | Saved TRAN/DC/AC voltage & current signals, exact probe mappings, cursors, smooth pan/zoom, and display decimation |
| Circuit version control | Library/cell CRUD (`create_library`, `create_cell`, `clone_cell`), Git branch create/switch, source diffs, checkpoints, scoped commits, single/multi-cell PRs, TB CI, and restore |
| Cross-platform runtime & CI | Native macOS (`Start CircuitGit.command`), Windows (`Start CircuitGit.bat`), and Linux support with unified `platform_compat.py`, static guards, local `run_tests.py`, and 3-OS GitHub Actions matrix |
| AI integration | MCP tools and interactive resources; web chat through an explicitly authorized owner node, with models, settings, images and sessions |
| Workspace | Rearrangeable, closable, floating panels with layout persistence |

## Run locally

Requires Python **3.11+** and Git. The basic web/gateway build uses Python's standard library; Node **22+** is used for JavaScript tests. Simulation onboarding uses the exact SpiceOwl commit recorded in the integration lock. The optional SDK MCP adapter has its own dependency file.

```bash
git clone https://github.com/CircuitGit-dev/CircuitGit.git
cd CircuitGit
python3 -B tools/workbench/launch.py
```

Open **http://127.0.0.1:8766/**. A PDK-free RC project is included. Configure `config/site.local.json` with your own SSH/Cadence installation before requesting a simulation. Licensed Cadence tools, PDKs, AI access, and accounts are supplied by the operator.

To preview the static demo without a gateway:

```bash
python3 -B tools/dev/build_pages.py
python3 -m http.server 8765 --bind 127.0.0.1 --directory site
```

Open **http://127.0.0.1:8765/**. See [setup and deployment](docs/getting-started.md) for agent connections, configuration, and operating boundaries.

## Repository map

```text
apps/web/       browser workbench, public demo, pinned RNL/Dockview assets
apps/codex/     CLI, plugin, MCP tools/resources, optional web AI bridge
apps/mcp/       optional official-SDK MCP transport
modules/        shared schematic, simulation, waveform and workspace logic
contracts/      public tool and context contracts
submodules/     official RNL and SpiceOwl source at their exact integration pins
tools/          local gateway, runners, exporters, builds and checks
projects/       redistributable circuit examples (RC)
lib/            indexed circuit libraries: cells, native views and provenance
config/         portable configuration examples; local overrides are ignored
docs/           architecture, usage, branding and third-party provenance
tests/          unit, browser and integration tests
```

Application source was extracted from the working IC on GitHub project. Reviewed, user-authored ADC exports are now published under `lib/` with source hashes and dependency notes. Site-specific configuration, PDK/model implementations, runtime conversations, and unreviewed historical simulation archives remain excluded. Some retained integration tests and engineering notes describe the earlier checkout; see [release scope](docs/public-release.md).

## Development & Cross-Platform Testing

CircuitGit natively supports **macOS, Windows 10/11, and Linux** through a shared zero-dependency OS compatibility layer (`platform_compat.py`) enforced by `tools/dev/check_structure.py` and verified by [Cross-Platform CI](.github/workflows/cross-platform-ci.yml).

On macOS or Linux, prepare the project Python environment, build the web/plugin and Pages packages, and run offline health checks with one command:

```bash
python3 -B tools/dev/setup_env.py
```

Setup synchronizes the official RNL and SpiceOwl submodules, then installs the exact SpiceOwl commit in `contracts/spiceowl-integration.lock.json` with its `mcp,adctools` extras and **ADCToolbox 0.9.3**. A verified local SpiceOwl source archive avoids a second Git download by pip. Matching project environments are reused; global Python packages and active services are unchanged. Browser and Pages builds use the checked-in RNL JavaScript/Wasm and do not require Rust or initialized submodules. Node, browsers, Cadence and PDKs are not installed. Use `--plan` to inspect the steps without running them. See the [developer environment guide](docs/dev-environment.md) for interpreter selection, recovery and optional external-link audits.

Run the unified cross-platform test suite locally on macOS, Windows, or Linux (covers architecture/cross-platform guards, packaging, browser helper, local `ngspice`/open-PDK simulation, library CRUD/branches/PRs, AI/MCP, and Node.js frontend tests):

```bash
# Full matrix (use `python` on Windows)
python3 -B tools/dev/run_tests.py

# Fast smoke pass across every subsystem
python3 -B tools/dev/run_tests.py --quick
```

See the [Cross-Platform Compatibility & Testing Guide](docs/cross-platform-testing.md) for Windows/macOS user setup, developer portability rules, and GitHub Actions workflow usage. Individual checks also remain available:

```bash
python3 -B tools/dev/build.py all
python3 -B tools/dev/check_structure.py
python3 -B tools/dev/check_links.py
node --test tests/demo/*.test.mjs tests/context/*.test.mjs tests/waveforms/*.test.mjs
node --test tests/remote/*.test.mjs
python3 -B tests/remote/test_node.py
```

Edit source under `apps/` and `modules/`; `web/`, `site/`, and `dist/` are generated. Pushing `main` rebuilds and deploys the Pages demo using [GitHub Actions](.github/workflows/pages.yml).

## Credits and license

CircuitGit is MIT licensed. Third-party components retain their original licenses and attribution, including **Rich Netlist**, **Dockview**, and bundled fonts. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). CircuitGit is an independent project and is not affiliated with Cadence, GitHub, or OpenAI.
