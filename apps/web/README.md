# Browser application source

Edit this directory for the web host: layout, menus, browser AI, popup transport and RNL rendering. Reusable functionality is under `modules/`; small re-export files preserve old module URLs.

From the repository root:

```bash
python3 -B tools/dev/build.py web
python3 -B tools/workbench/launch.py --config config/workbench.local.json
```

`web/` at repository root is generated. Do not edit it directly. `python3 -m http.server … --directory web` serves the built files only and has no gateway API. The private application keeps its existing root URL and `/vendor/rnl-viewer/index.html?studio=1&native=1` entry.

[Architecture](../../docs/architecture.md) · [Studio usage](../../docs/rnl-studio.md) · [AI sessions](../../docs/ai-sessions.md) · [Waveforms](../../docs/waveform-viewer.md)
