#!/usr/bin/env python3
"""Read-only official ClientSession smoke; never opens review or submits simulation."""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys

from server import require_sdk


async def probe(server_path, *, config=None, settings=None, project_id=None, run_id=None, timeout=45.0):
    """Return a compact report. Starts only the supplied MCP stdio entrypoint.

    Config mode does not start a gateway; settings mode preserves the existing
    PluginRuntime lazy startup policy when an actual data tool is called.
    No elicitation callback is provided. Existing simulation results are read;
    this helper never prepares or resolves mutations or creates UI views.
    """
    require_sdk()
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    if (config is None) == (settings is None):
        raise ValueError('Provide exactly one of config or settings')
    if run_id and not project_id:
        raise ValueError('An explicit project_id is required with run_id')
    source = Path(config if config is not None else settings)
    server_path = Path(server_path)
    if not source.is_absolute() or not server_path.is_absolute():
        raise ValueError('Server and config/settings paths must be absolute')
    command = StdioServerParameters(command=sys.executable,
        args=['-B', str(server_path), '--config' if config is not None else '--settings', str(source)])
    async with stdio_client(command) as streams:
        async with ClientSession(*streams, read_timeout_seconds=timeout) as client:
            init = await client.initialize()
            tools = await client.list_tools()
            resources = await client.list_resources()
            report = {'transport': 'stdio', 'protocol_version': init.protocol_version,
                      'server': init.server_info.name, 'tool_count': len(tools.tools),
                      'tools': [tool.name for tool in tools.tools],
                      'resources': [str(resource.uri) for resource in resources.resources],
                      'native_mount_verified': False, 'model_started': False, 'writes_requested': False}

            async def call(name, args):
                result = await client.call_tool(name, args)
                value = result.structured_content
                if result.is_error or not value or value.get('ok') is not True:
                    raise RuntimeError(name + ' failed: ' + json.dumps(value, ensure_ascii=False))
                return value['data']

            if 'ic_plugin_status' in report['tools']:
                report['plugin_status'] = await call('ic_plugin_status', {})
            if project_id:
                registry = await call('ic_projects', {})
                selected = next((p for p in registry['projects'] if p['id'] == project_id), None)
                if selected is None:
                    raise ValueError('Project is not in the explicit registry')
                report['project'] = selected
                report['current_source_commit'] = registry.get('source_commit')
            if run_id:
                # Listing persisted jobs has no active run SSH query.
                jobs = await call('ic_sim_status', {})
                selected = next((j for j in jobs.get('jobs', []) if (j.get('run_id') or j.get('job_id')) == run_id
                                 and (j.get('associated_project_id') or j.get('project_id')) == project_id), None)
                if selected is None:
                    raise ValueError('Run is not associated with the explicit project')
                report['run'] = selected
                report['saved_results'] = await call('ic_sim_results', {'run_id': run_id})
            return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--config', type=Path)
    source.add_argument('--settings', type=Path)
    parser.add_argument('--server', type=Path, default=Path(__file__).resolve().with_name('server.py'))
    parser.add_argument('--project', dest='project_id')
    parser.add_argument('--run', dest='run_id')
    args = parser.parse_args(argv)
    result = asyncio.run(probe(args.server, config=args.config, settings=args.settings,
                               project_id=args.project_id, run_id=args.run_id))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__': main()
