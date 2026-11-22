#!/usr/bin/env python3
"""Package the built IC Workbench plugin as a local Codex marketplace.

This is an offline build. It does not install plugins, edit Codex settings,
connect to a gateway, or include private client configuration.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MARKER = '.ic-marketplace-build.json'
NAME = 'ic-workbench-local'


def package(output=None):
    source = ROOT / 'dist/ic-workbench'
    for filename in ('plugin.json', 'mcp.json', 'ic_workbench.py',
                     'ui/schematic.html', 'ui/waveforms.html', 'ui/simulation.html', 'ui/workbench.html'):
        if not (source / filename).is_file():
            raise ValueError('Build the complete plugin first; missing ' + filename)
    if not (source / '.ic-build.json').is_file():
        raise ValueError('Expected a generated plugin package')
    resources = json.loads((source / 'ui/manifest.json').read_text())['files']
    if {row['kind'] for row in resources} != {'schematic', 'waveforms', 'simulation', 'workbench'}:
        raise ValueError('Expected workbench and three standalone MCP App resources')
    for row in resources:
        if row.get('entry_present') is not True:
            raise ValueError('Incomplete component package: ' + row['kind'])
        if hashlib.sha256((source / row['path']).read_bytes()).hexdigest() != row['sha256']:
            raise ValueError('Resource differs from the build manifest: ' + row['kind'])
    output = Path(output).resolve() if output else ROOT / 'dist/codex-marketplace'
    if output == ROOT or output in ROOT.parents or output == source or source in output.parents:
        raise ValueError('Unsafe marketplace destination')
    if output.exists() and not (output / MARKER).is_file():
        raise ValueError('Refusing to overwrite an unmanaged directory: ' + str(output))
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.codex-marketplace-', dir=output.parent))
    backup = None
    try:
        destination = stage / 'plugins/ic-workbench'
        shutil.copytree(source, destination, symlinks=True)
        hashes = {}
        for path in sorted(destination.rglob('*')):
            if path.is_symlink():
                raise ValueError('Plugin cannot contain symlinks: ' + str(path))
            if not path.is_file():
                continue
            rel = path.relative_to(destination).as_posix()
            if path.name.endswith('.local.json') or path.name in ('config.json', '.env') or any(
                part in {'runs', '.local', 'private', 'ai-state'} for part in path.relative_to(destination).parts
            ):
                raise ValueError('Private runtime file found in generated package: ' + rel)
            hashes[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
        catalog = {
            'name': NAME,
            'interface': {'displayName': 'IC Workbench Local'},
            'plugins': [{
                'name': 'ic-workbench',
                'source': {'source': 'local', 'path': './plugins/ic-workbench'},
                'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'},
                'category': 'Productivity',
            }],
        }
        catalog_path = stage / '.agents/plugins/marketplace.json'
        catalog_path.parent.mkdir(parents=True)
        catalog_path.write_text(json.dumps(catalog, indent=2) + '\n')
        manifest = {'schema': 'ic.marketplace.build.v1', 'marketplace': NAME,
                    'plugin': 'ic-workbench', 'files': hashes}
        (stage / MARKER).write_text(json.dumps(manifest, indent=2) + '\n')
        if output.exists():
            backup = Path(tempfile.mkdtemp(prefix='.codex-marketplace-old-', dir=output.parent))
            backup.rmdir()
            output.rename(backup)
        try:
            stage.rename(output)
        except Exception:
            if backup:
                backup.rename(output)
                backup = None
            raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
        if backup and backup.exists():
            shutil.rmtree(backup)
    return {'marketplace': NAME, 'plugin': 'ic-workbench', 'output': str(output),
            'files': len(hashes), 'installed': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    print(json.dumps(package(args.output)))
