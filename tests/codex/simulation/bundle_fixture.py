"""Build a local simulation resource against the integrated or explicit UI-owner host."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile

repo, host_root, output = map(lambda value: Path(value).resolve(), sys.argv[1:])
output.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('simulation_test_packager', host_root / 'tools/dev/mcp_ui.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)
with tempfile.TemporaryDirectory(prefix='simulation-bundle-', dir=output) as temporary:
    root = Path(temporary)
    for relative in ('apps/codex/ui/simulation', 'modules/simulation'):
        shutil.copytree(repo / relative, root / relative)
    for name in ('host.js', 'bootstrap.js', 'shell.css'):
        shutil.copy2(host_root / 'apps/codex/ui' / name, root / 'apps/codex/ui' / name)
    html, manifest = packager.render_document(root, 'simulation')
    (output / 'simulation.html').write_bytes(html)
    (output / 'bundle-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest))
