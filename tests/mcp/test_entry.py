"""Portable package path and zero-dependency compatibility tests; no live gateway."""
import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/mcp'))
from mcp import ClientSession,StdioServerParameters
from mcp.client.stdio import stdio_client
from smoke import probe
from icwb.service import tools as core_tools
from icwb.view_contracts import tools as view_tools
from icwb.elicitation import tools as review_tools


def expected_tools():
    return core_tools({})+view_tools()+review_tools()


class EntryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()

    def config(self):
        path=self.root/'client.json'
        path.write_text(json.dumps({'gateway_url':'http://127.0.0.1:1','state_dir':str(self.root/'state')}))
        return path

    async def test_packaged_backend_imports_and_resources_using_official_client(self):
        package=self.root/'package';package.mkdir()
        shutil.copy2(ROOT/'apps/mcp/server.py',package/'server.py')
        shutil.copy2(ROOT/'apps/mcp/strict_input.py',package/'strict_input.py')
        shutil.copytree(ROOT/'apps/codex/icwb',package/'backend/icwb',ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copytree(ROOT/'modules/gateway_client/ic_gateway',package/'backend/lib/ic_gateway',ignore=shutil.ignore_patterns('__pycache__'))
        ui=package/'backend/ui';ui.mkdir()
        for name in ['workbench','schematic','waveforms','simulation']:
            (ui/(name+'.html')).write_text('<!doctype html>SYNTHETIC packaged '+name)
        with (self.root/'stderr').open('w+') as log:
            async with stdio_client(StdioServerParameters(command=sys.executable,args=['-B',str(package/'server.py'),'--config',str(self.config())]),errlog=log) as streams:
                async with ClientSession(*streams,read_timeout_seconds=5) as session:
                    await session.initialize()
                    tools=await session.list_tools()
                    self.assertEqual([tool.model_dump(by_alias=True,exclude_none=True,exclude_unset=True) for tool in tools.tools],expected_tools())
                    self.assertFalse({'ic_library_read','ic_library_execute'} & {tool.name for tool in tools.tools})
                    resources=await session.list_resources();self.assertEqual(len(resources.resources),4)
                    for resource in resources.resources:
                        result=await session.read_resource(resource.uri)
                        self.assertIn('SYNTHETIC packaged',result.contents[0].text)

    async def test_smoke_function_is_callable_against_actual_entry(self):
        report=await probe(ROOT/'apps/mcp/server.py',config=self.config())
        self.assertEqual(report['tools'],[tool['name'] for tool in expected_tools()])
        self.assertEqual(report['tool_count'],len(expected_tools()))
        self.assertFalse({'ic_library_read','ic_library_execute'} & set(report['tools']))
        self.assertFalse(report['writes_requested'])
        self.assertFalse(report['model_started'])

    async def test_invalid_path_and_transport_fail_before_serving(self):
        for args in [[],['--config','relative.json'],['--config',str(self.config()),'--transport','http']]:
            result=await asyncio.to_thread(subprocess.run,[sys.executable,'-B',str(ROOT/'apps/mcp/server.py'),*args],capture_output=True,text=True,timeout=5)
            self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,'')
        invalid=self.root/'invalid-client.json'
        invalid.write_text(json.dumps({'gateway_url':'http://example.invalid:8766','state_dir':str(self.root/'unused')}))
        result=await asyncio.to_thread(subprocess.run,[sys.executable,'-B',str(ROOT/'apps/mcp/server.py'),'--config',str(invalid)],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,2);self.assertEqual(result.stdout,'')
        self.assertIn('Portable MCP startup failed',result.stderr);self.assertNotIn('Traceback',result.stderr)

    async def test_python39_legacy_zero_site_packages_schema_still_works(self):
        python=shutil.which('python3')
        result=await asyncio.to_thread(subprocess.run,[python,'-S','-B',str(ROOT/'apps/codex/ic_workbench.py'),'--json','schema'],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('ic_projects',result.stdout)
        json.loads(result.stdout)
        version=subprocess.check_output([python,'--version'],text=True).strip()
        self.assertTrue(version.startswith('Python 3.'),version)


if __name__=='__main__':unittest.main(verbosity=2)
