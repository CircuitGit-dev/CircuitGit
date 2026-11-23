# Fresh simulation intake

This optional entry starts a simulation-only local service. It does not load an
old site profile, a library catalogue, a chat subscription or a previous circuit
workspace. Its first source is the literal netlist imported through the form.
Install the SpiceOwl version in `contracts/spiceowl-integration.lock.json` into
the Python environment running the helper.

From the repository root, choose an empty private state directory:

```sh
python3 -B tools/workbench/connect_browser.py --fresh-onboarding \
  --state-dir /absolute/path/to/new-intake-state \
  --port 18885 --gateway-port 18884 \
  --allow-origin http://127.0.0.1:18886 --no-browser
```

Use `--resume-onboarding` with that same directory and ports to reopen it. The
connection ID persists. A fresh command refuses a nonempty directory; resume
refuses unrelated, redirected or altered storage. Occupied ports and a second
process using the same state are rejected without stopping an existing service.
The existing `Start CircuitGit.command` remains the legacy chat/helper entry;
this development entry is selected explicitly.

## What an operator supplies

1. A small Spectre netlist, supplied as text or file contents.
2. One or more SSH aliases selected from the local SSH configuration.
3. A discovered environment setup, when the noninteractive environment lacks
   Spectre. Its filename is shown; the backend retains its observed hash.
4. A model entry, its actual sections and any required TMI platform. The tool
   reports missing polarity or terminal contracts instead of deriving them from
   a model name.
5. Experiment conditions: port roles, voltage, frequency, operating and model
   nominal temperatures, transitions, load, cycles and sample density.

The current recipe supports a directly supplied two-device inverter. Explicit
W/L remain in the source. Omitted `nf` or `multi` are left omitted; this does not
claim a foundry minimum or establish the model's defaults. Flat source can gain
an explicit subcircuit wrapper, with the inserted bytes and both hashes recorded.

Discovery is bounded. When a broad scan cannot complete, the tool reports its
coverage and offers actually observed directories for a narrower search. An
optional absolute search-directory or `cds.lib` hint is also supported. Such a
hint is recorded as input, never claimed as an automatically discovered fact.
License configuration presence does not establish successful checkout.

## What the algorithms establish

| Stage | Mechanism | Result |
| --- | --- | --- |
| Source | Bounded parser and source digest | Device names, connectivity and literal dimensions |
| SSH | Explicit selected-target probe | Current account, tool and resource observations |
| Models | Bounded files/sections/include graph | Candidate contracts and exact coverage gaps |
| Prepare | Recipe validation, fresh dependency audit, local Git snapshot | Frozen conditions, source/dependency pins and plan ID |
| Run | Compatibility check, fresh resource ranking, existing Runner | One original submission key and selected server |
| Inspect | Original-run status, explicit collection and native parsing | Five separate assessment dimensions |
| Waveforms | Same-run archive/CSV/source/config checks | Bounded manual signal windows |

An LLM can select the next finite operation and explain a missing field. It does
not decide that an unobserved dependency exists, turn a transport failure into
a solver failure, or change acceptance conditions to make a result pass.

The client retains the intake and plan before sending run. After a lost reply it
reads the original submission key. A missing mapping remains unresolved and is
not permission to send another job. Refresh and waveform GETs never probe,
collect, derive, or launch. Explicit inspect may observe and collect.

The report separates execution, measurement validity, functional performance,
operating qualification and dependency provenance. A completed workflow is not
an overall scientific pass. Waveform availability is separately verified;
unproved schematic geometry keeps graphical probes disabled while manual
signals from the original run remain available.

## Integration and test evidence

See [the API](onboarding-api.md), [waveform reads](onboarding-waveforms.md),
[session examples](contracts/onboarding-session.example.json) and
[waveform examples](contracts/onboarding-waveforms.example.json).
These committed examples are produced from original synthetic fixtures. The
session fixture uses the real local Git/Workspace/Runner reservation code with
remote transport mocked and dispatch deferred. The waveform fixture uses actual
native-ASCII parsing of synthetic data. Neither is evidence of a real solver run.

Actual server probes and runs belong in the selected private state directory.
Retain input origin (`interactive_client`, `native_agent`, `test_harness`) and
the distinction between entered settings, observed facts and suggestions. An
automated browser test is not evidence that a human clicked a control.
