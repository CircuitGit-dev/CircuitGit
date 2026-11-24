# Local open-source simulation (ngspice / Xyce + open PDKs)

CircuitGit can run local SPICE simulations using **ngspice** or **Xyce** without SSH, Cadence licenses, or an online Virtuoso session. Local runs keep the same provenance rules as remote Spectre runs: committed source snapshots, SHA-256 input verification, atomic run directories, immutable `full-results.tar.gz` archives, and hash-bound waveform derivation.

## How open-source SPICE fits into the CircuitGit workflow

CircuitGit treats local open-source simulation and remote licensed foundry simulation as **two explicit execution tiers**, never silently substituting one for the other:

1. **Tier 1 — Local open-source loop (`ngspice` / `Xyce` + `builtin` or open PDK)**:
   - On first launch (`python3 -B tools/workbench/launch.py`), if `config/site.local.json` does not yet exist and `ngspice` or `Xyce` is installed locally, `launch.py` automatically creates a working `ic.sim.local-site.v1` configuration (pass `--site-mode spectre` to keep a remote Spectre template instead).
   - Ideal for zero-cloud local topology exploration, PDK-free behavioral circuits, and open-PDK designs (SKY130, GF180MCU, IHP SG13G2). `/api/health` and `/api/project` report `simulation_backend: {transport: "local", engine: "ngspice", license_required: false}`.
2. **Tier 2 — Remote licensed foundry loop (`Spectre` via SSH + SpiceOwl + Foundry PDK)**:
   - Used whenever commercial PDK models, foundry corners, or licensed Spectre signoff are required.
   - **No silent fallback**: if a Spectre configuration references commercial external model pins (`@EXTERNAL_*@`) that are absent on a local open-source site, preflight fails closed explicitly rather than substituting generic models.

## Quick start (zero PDK)

Install `ngspice` (for example `brew install ngspice` on macOS or `apt install ngspice` on Ubuntu/Debian), then launch CircuitGit:

```bash
python3 -B tools/workbench/launch.py
# Or explicitly select engine / open PDK:
python3 -B tools/workbench/launch.py --local-sim ngspice
```

This creates a local `ic.sim.local-site.v1` configuration in `config/site.local.json` (git-ignored) pointing to your detected `ngspice` binary and an isolated `ic_on_github_runs` directory under `.local/workbench/`. Open `http://127.0.0.1:8766/` and run:

- **`rc-smoke` / `TRAN_NGSPICE`**: built-in RC transient step response (`1 kΩ`, `1 pF`).
- **`open-cmos-inverter` / `TRAN_NGSPICE`**, **`DC_NGSPICE`**, **`AC_NGSPICE`**: PDK-free CMOS inverter with built-in Level-1 MOS models (`nch_open`, `pch_open`), transient switching, DC VTC sweep, and AC small-signal Bode response.

## Open-source PDK profiles (SKY130, GF180MCU, IHP SG13G2)

Local sites support explicit open-source PDK profiles in `config/site.local.json` (see `config/site.sky130-ngspice.example.json`):

| Profile | Typical root | Supported corners | Entry library candidates |
|---|---|---|---|
| `builtin` | *(none)* | `typical` | Built-in models in netlist |
| `sky130` | `/path/to/pdk/sky130A` | `tt`, `ff`, `ss`, `sf`, `fs`, `tt_mm`, `mc` | `libs.tech/ngspice/sky130.lib.spice`, `libs.tech/combined/sky130.lib.spice` |
| `gf180mcu` | `/path/to/pdk/gf180mcuD` | `typical`, `ff`, `ss`, `sf`, `fs` | `libs.tech/ngspice/sm141064.ngspice`, `libs.tech/ngspice/design.ngspice` |
| `ihp-sg13g2` | `/path/to/pdk/ihp-sg13g2` | `mos_tt`, `mos_ff`, `mos_ss`, `mos_sf`, `mos_fs` | `libs.tech/ngspice/models/cornerMOSlv.lib`, `libs.tech/ngspice/models/cornerMOShv.lib` |

Launch directly with an installed open PDK:

```bash
python3 -B tools/workbench/launch.py --local-sim ngspice --open-pdk sky130 --pdk-root /abs/path/to/sky130A --pdk-corner tt
```

Preflight (`ic_sim.py preflight`) hashes the simulator binary and resolved PDK entry library, verifies readability without fabricating missing files, and pins their SHA-256 digests in the run receipt.

## Supported Spectre-to-SPICE subset & boundaries

`tools/workbench/spice_netlist.py` deterministically translates CircuitGit's bounded Spectre subset (`.scs`) into SPICE (`.cir`) for `ngspice` or `Xyce`, while passing native SPICE decks through:

- Supported statements: `parameters`, `subckt`/`ends`, `include` (with optional `section=`), `model`, `resistor`, `capacitor`, `inductor`, `vsource`/`isource` (`dc`, `pulse`, `sine`, `ac`), 4-terminal MOS and subcircuit instances, `tran`, `ac`, `dc` (sweep and operating point), and `save`.
- `tools/workbench/spice_raw.py` parses SPICE3 ASCII rawfiles (`Tran`, `AC` complex real/imag, `DC` sweep, `DC OP`) into hash-bound `waveforms.csv` / `waveforms.json` and `waveform-datasets.json` consumed by `WaveformService`.
- **Explicit boundaries**:
  - Unsupported Spectre constructs (Verilog-A `ahdl_include`, `pss`/`pnoise`/`stb`, Monte Carlo/altergroups, custom behavioural functions) fail closed during translation rather than silently altering circuit behavior.
  - Binary rawfiles and commercial binary PSF/PSFXL are not parsed by `spice_raw.py`; local runs explicitly request ASCII rawfiles (`.options filetype=ascii`).
  - Xyce support uses the same site schema (`"engine": "xyce"`) and deck emitter; real Xyce execution requires an operator-installed `Xyce` binary.

## Verification

```bash
PYTHONPATH=tools/workbench python3 -B -m unittest tools/workbench/test_local_opensource_sim.py
```
