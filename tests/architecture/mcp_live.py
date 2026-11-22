"""Official MCP SDK client -> packaged server -> existing loopback saved data.

No model, approval, solver or publication calls. All new view state is temporary.
Run with the optional MCP environment after `tools/dev/build.py mcp`.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'test-results/portable-mcp-live.json'


async def main():
    report = {'scope': 'official SDK client and packaged stdio server; existing saved data only',
              'calls': [], 'model_turns': 0, 'engineering_writes': 0}
    try:
        with tempfile.TemporaryDirectory(prefix='ic-mcp-live-') as folder:
            path = Path(folder)
            config = path / 'client.json'
            config.write_text(json.dumps({'gateway_url': os.environ.get('IC_GATEWAY_URL', 'http://127.0.0.1:8766'),
                                          'state_dir': str(path / 'state'),
                                          'disabled_operations': ['apply', 'sim_submit', 'sim_collect', 'sim_archive', 'sim_preflight']}))
            params = StdioServerParameters(command=sys.executable, args=['-B',
                str(ROOT / 'dist/ic-workbench-mcp/server.py'), '--config', str(config)])
            with (path / 'server.log').open('w') as log:
                async with stdio_client(params, errlog=log) as streams:
                    async with ClientSession(*streams, read_timeout_seconds=30) as client:
                        initialized = await client.initialize()
                        report['server'] = initialized.server_info.name
                        report['protocol'] = initialized.protocol_version
                        tools = await client.list_tools()
                        report['tools'] = len(tools.tools)
                        assert not any(t.name in ('ic_approve', 'ic_resolve') for t in tools.tools)
                        resources = await client.list_resources()
                        report['resources'] = [str(r.uri) for r in resources.resources]
                        ui = await client.read_resource('ui://ic-workbench/waveforms.html')
                        assert ui.contents[0].mime_type == 'text/html;profile=mcp-app'
                        assert 'html' in ui.contents[0].text

                        async def call(name, args):
                            assert name in ('ic_projects', 'ic_read', 'ic_waveforms_open', 'ic_view_data')
                            result = await client.call_tool(name, args)
                            report['calls'].append(name)
                            assert not result.is_error, result.structured_content
                            wire = result.model_dump(by_alias=True, exclude_none=True)
                            return result.structured_content['data'], wire.get('_meta', {}).get('icWorkbench', {}).get('data')

                        projects, _ = await call('ic_projects', {})
                        project = os.environ.get('IC_TEST_PROJECT', 'real-sar-20261106')
                        assert any(p['id'] == project for p in projects['projects'])
                        source, _ = await call('ic_read', {'project_id': project})
                        assert hashlib.sha256(source['file']['content'].encode()).hexdigest() == source['file']['sha256']
                        report['source_sha256'] = source['file']['sha256']
                        run = os.environ.get('IC_TEST_RUN', '20261109T054442Z-1d9279ef0b-014b97a6')
                        view, _ = await call('ic_waveforms_open', {'project_id': project, 'run_id': run})
                        identity = {k: view[k] for k in ('workspace_id', 'view_id', 'revision')}
                        _, data = await call('ic_view_data', {**identity, 'query': {'kind': 'signals'}})
                        catalog = data['payload']
                        available = [s for s in catalog['signals'] if s['status'] == 'available']
                        signal = next(s for s in available if s['quantity'] == 'current' and s['unit'] == 'A')
                        _, data = await call('ic_view_data', {**identity, 'query': {'kind': 'waveform',
                            'signal_id': signal['id'], 'analysis': 'tran', 'limit': 512,
                            'cursor_a': 1e-8, 'cursor_b': 1.1e-8}})
                        waveform = data['payload']
                        assert 0 < len(waveform['points']) <= 512
                        assert waveform['measurement']['basis'] == 'PSFXL_native_samples'
                        assert abs(waveform['measurement']['delta']['dt'] - 1e-9) < 1e-22
                        assert waveform['measurement']['cursors']['a']['y'] == -0.06527818549049032
                        report['run_id'] = run
                        report['available_signals'] = len(available)
                        report['waveform'] = {'label': signal['label'], 'display_points': len(waveform['points']),
                                              'source_points': waveform['display']['input_points'],
                                              'measurement_basis': waveform['measurement']['basis']}
                        report['status'] = 'passed'
    except BaseException as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))


if __name__ == '__main__':
    asyncio.run(main())
