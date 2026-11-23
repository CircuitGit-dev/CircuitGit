"""Official MCP client executes library-only work on a disposable Git fixture."""
from contextlib import asynccontextmanager
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/library'))
import test_workflow as fixture
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


class LibraryStdioTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.seed = fixture.LibraryWorkflowTest()
        self.seed.setUp()
        self.addCleanup(self.seed.doCleanups)
        self.root = self.seed.workflow.root

    @asynccontextmanager
    async def client(self, access):
        config = self.root / '.local/mcp-library.json'
        config.write_text(json.dumps({'gateway_url': 'http://127.0.0.1:1', 'state_dir': str(self.root / '.local/agent'),
            'library_workspace': str(self.root), 'library_repository': 'fixture/circuits', 'library_access': access,
            'library_state_dir': str(self.seed.workflow.state)}))
        with (self.root / '.local/mcp-stderr').open('w+') as log:
            async with stdio_client(StdioServerParameters(command=sys.executable,
                    args=['-B', str(ROOT / 'apps/mcp/server.py'), '--config', str(config)]), errlog=log) as streams:
                async with ClientSession(*streams, read_timeout_seconds=10) as session:
                    await session.initialize()
                    yield session

    async def test_official_wire_catalog_save_and_original_shared_receipt(self):
        async with self.client('direct') as session:
            names = {tool.name for tool in (await session.list_tools()).tools}
            self.assertTrue({'ic_library_read', 'ic_library_execute'} <= names)
            catalog = await session.call_tool('ic_library_read', {'operation': 'catalog', 'arguments': {}})
            self.assertFalse(catalog.is_error)
            self.assertEqual(catalog.structured_content['data']['libraries'][0]['id'], 'demo')
            saved = await session.call_tool('ic_library_execute', {'operation': 'save', 'arguments': {
                'library_id': 'demo', 'cell_id': 'gain', 'path': self.seed.path,
                'base_sha256': self.seed.sha(self.seed.before), 'content': self.seed.after},
                'idempotency_key': 'official-library-save'})
            self.assertFalse(saved.is_error)
            self.assertEqual(saved.structured_content['data']['state'], 'complete')
            self.assertEqual((self.root / self.seed.path).read_text(), self.seed.after)
            receipt = await session.call_tool('ic_library_read', {'operation': 'receipt',
                'arguments': {'idempotency_key': 'official-library-save'}})
            self.assertEqual(receipt.structured_content['data'], saved.structured_content['data'])
            self.assertEqual(self.seed.workflow.receipt(idempotency_key='official-library-save'), saved.structured_content['data'])

    async def test_official_wire_readonly_profile_denies_save(self):
        async with self.client('read_only') as session:
            result = await session.call_tool('ic_library_execute', {'operation': 'save', 'arguments': {
                'library_id': 'demo', 'cell_id': 'gain', 'path': self.seed.path,
                'base_sha256': self.seed.sha(self.seed.before), 'content': self.seed.after},
                'idempotency_key': 'official-readonly-save'})
            self.assertTrue(result.is_error)
            self.assertEqual(result.structured_content['error']['code'], 'library_read_only')
            self.assertEqual((self.root / self.seed.path).read_text(), self.seed.before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
