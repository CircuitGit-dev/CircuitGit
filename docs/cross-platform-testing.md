# Cross-Platform Compatibility & Testing Guide (macOS, Windows, Linux)

CircuitGit runs natively on **macOS**, **Windows 10/11**, and **Linux** from a single shared codebase. Users interact through the browser UI without typing terminal commands, while contributors and operators share one automated test matrix across all three operating systems.

---

## 1. For Users: One-Click Local Helper by OS

You only need to double-click the launcher once per computer session; all subsequent design, version control, AI, and simulation actions happen inside the browser:

| OS | Double-Click Launcher | Prerequisites |
|---|---|---|
| **Windows 10/11** | **`Start CircuitGit.bat`** | Python **3.11+** (with *Add Python to PATH*), Git, optional `ngspice` / Codex |
| **macOS** | **`Start CircuitGit.command`** | Python **3.11+**, Git, optional `ngspice` (`brew install ngspice`) / Codex |
| **Linux** | `python3 -B tools/workbench/connect_browser.py` | Python **3.11+**, Git, optional `ngspice` (`apt install ngspice`) / Codex |

The web panel automatically detects your operating system and prompts for the matching launcher (`Start CircuitGit.bat` on Windows, `Start CircuitGit.command` on macOS). Local open-source PDK paths accept both POSIX (`/path/to/pdk/sky130A`) and Windows (`C:\pdk\sky130A`) absolute paths.

---

## 2. For Developers & Testers: One-Command Test Runner

Use **`tools/dev/run_tests.py`** on macOS, Windows, or Linux to run the exact same test matrix as GitHub Actions:

```bash
# macOS / Linux — full cross-platform test suite
python3 -B tools/dev/run_tests.py

# Windows (PowerShell / cmd) — full cross-platform test suite
python -B tools/dev/run_tests.py
```

### Common modes

```bash
# Fast smoke check across every subsystem (~20-30s)
python3 -B tools/dev/run_tests.py --quick

# Run specific suites only
python3 -B tools/dev/run_tests.py --suite architecture,remote,simulation

# Inspect the exact test plan without executing
python3 -B tools/dev/run_tests.py --list

# Strict CI mode (fail if Node.js or ngspice is missing) + JSON report
python3 -B tools/dev/run_tests.py --require-node --require-ngspice --json-report reports/local.json
```

### What the test matrix covers

| Suite | Coverage |
|---|---|
| `architecture` | Cross-platform static AST/regex guard (`check_structure.py`), contract drift check, `build.py all`, `build_pages.py`, docs link audit (`check_links.py`), packaging, and OS-primitive tests (`tests/architecture/test_cross_platform.py`) |
| `remote` | Isolated Python bootstrap, browser helper, pairing/origin authorization, remote node, local developer mode, and onboarding launcher |
| `simulation` | Local open-source SPICE (`ngspice`/Xyce) pure-Python supervisor, real RC & CMOS inverter TRAN/DC/AC waveforms, open-PDK profiles (`SKY130` / `GF180MCU` / `IHP SG13G2`), Web API backend switching, runner receipts, monitoring, and waveform derivation |
| `library` | Circuit library CRUD (`create_library`, `create_cell`, `clone_cell`), branch create/switch, multi-cell related PRs, checkpoints, restore, deduplication, history build, and Studio version control |
| `ai` | Codex runtime discovery (macOS & Windows), session/turn recovery, approvals, private image storage (with and without `dir_fd`), MCP stdio transport (POSIX `select` and Windows threaded reader), and plugin runtime |
| `frontend` | Node.js 22+ unit tests across demo, remote pairing/client, libraries, waveforms, RNL viewer, Studio dockview/simulation panels, and AI panel |
| `spiceowl` | Automatically enabled when the repository-pinned `spiceowl` package is installed (also verified in CI on macOS, Windows and Linux via `bootstrap_python.py --setup-only`) |

---

## 3. GitHub Actions Cross-Platform CI

[`.github/workflows/cross-platform-ci.yml`](../.github/workflows/cross-platform-ci.yml) runs automatically on pushes, pull requests, and manual **Actions → Cross-Platform CI → Run workflow** triggers:

1. **`cross-platform-tests` matrix**: executes on **`macos-latest`**, **`windows-latest`**, and **`ubuntu-latest`** with Python 3.12, Node 22, and `ngspice`, running `tools/dev/run_tests.py` and uploading JSON reports as artifacts.
2. **`spiceowl-bootstrap-matrix`**: verifies isolated virtual environment creation and pinned `spiceowl` + `adctoolbox==0.9.3` installation on **`macos-latest`**, **`windows-latest`** and **`ubuntu-latest`**, then runs the `spiceowl` integration suite.

---

## 4. Maintaining Cross-Platform Compatibility in Future Features

All local host Python code (`apps/`, `modules/`, `tools/`) shares one OS abstraction layer instead of branching ad hoc or duplicating platforms:

- Workbench/launcher/CI modules import from [`tools/workbench/platform_compat.py`](../tools/workbench/platform_compat.py).
- Gateway/Codex/MCP modules import from [`modules/gateway_client/ic_gateway/platform_compat.py`](../modules/gateway_client/ic_gateway/platform_compat.py).

### Mandatory rules (enforced automatically by `tools/dev/check_structure.py`)

1. **No bare `import fcntl`**: always use `file_lock` / `lock_file` / `unlock_file`.
2. **No bare `os.getuid()` / `os.geteuid()` or `st_mode & 0o077`**: use `is_owner_private_file` / `is_owner_private_dir` and `chmod_private`.
3. **No bare `os.O_NOFOLLOW` / `os.O_DIRECTORY` / `dir_fd=`**: use `open_nofollow` or capability guards.
4. **No `selectors.DefaultSelector()` or `select.select()` on pipes/stdin**: use `read_bounded_pipes` (or threaded queue fallback on Windows).
5. **No bare `start_new_session=True` or `os.kill(pid, 0)`**: use `detached_popen_kwargs` / `isolated_popen_kwargs` and `pid_alive`.
6. **No hardcoded POSIX paths for local host execution**: never hardcode `/usr/bin/ssh`, `/bin/sh` local launchers, `bin/python`, or `core.hooksPath=/dev/null` — use `find_ssh_binary()`, pure-Python workers, `venv_python_path()` / `find_venv_python()`, `os.devnull`, and `is_safe_local_abs_path()`.
7. **Keep both launchers in sync**: any change to startup arguments in `Start CircuitGit.command` must be mirrored in `Start CircuitGit.bat`.
