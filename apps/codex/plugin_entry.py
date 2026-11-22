#!/usr/bin/env python3
"""Plugin-owned stdio entry. Codex starts this process; no user terminal required."""
import argparse
import os
from pathlib import Path
from icwb.plugin_runtime import PluginRuntime
from icwb.mcp import run


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings',type=Path)
    args=parser.parse_args()
    path=args.settings
    if path is None:
        data=os.environ.get('PLUGIN_DATA') or os.environ.get('CLAUDE_PLUGIN_DATA')
        if not data:parser.error('Host plugin data directory is unavailable; configure the plugin installation')
        path=Path(data)/'settings.json'
    runtime=PluginRuntime(path)
    return run(runtime.service,lifecycle=runtime)


if __name__=='__main__':raise SystemExit(main())
