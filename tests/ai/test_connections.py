"""Connection metadata is read-only, bounded and separate from inference/credentials."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'apps/codex'))
from icwb.connections import describe_connection
from icwb.host import AiRoutes
from icwb.service import Failure


class ConnectionTests(unittest.TestCase):
    def test_unconfigured_and_secrets_are_not_inferred_or_returned(self):
        value = describe_connection({'codex_bin': '/bin/codex', 'secret': 'not-for-the-browser',
                                     'gateway_token': 'hidden'})
        self.assertEqual(value['mcp']['status'], 'unconfigured')
        self.assertFalse(value['chat']['inferenceVerified'])
        self.assertNotIn('hidden', json.dumps(value))
        self.assertNotIn('not-for-the-browser', json.dumps(value))

    def test_only_existing_explicit_paths_produce_an_unverified_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = {key: str(Path(tmp) / key) for key in ('python', 'server', 'config')}
            for value in paths.values():
                Path(value).touch()
            value = describe_connection({'mcp_connection': paths})
            self.assertEqual(value['mcp']['command'], paths['python'])
            self.assertEqual(value['mcp']['args'], ['-B', paths['server'], '--config', paths['config']])
            self.assertEqual(value['mcp']['status'], 'prepared')
            self.assertFalse(value['mcp']['verified'])
            # An executable is never run just to display its path.
            self.assertEqual(Path(paths['python']).read_bytes(), b'')
            for profile in ({**paths, 'env': {'TOKEN': 'hidden'}}, {**paths, 'python': 'python'},
                            {**paths, 'server': paths['server'] + '\n'}, {**paths, 'config': '/missing/config.json'}):
                value = describe_connection({'mcp_connection': profile})
                self.assertEqual(value['mcp']['status'], 'unconfigured')
                self.assertEqual(value['mcp']['args'], [])
                self.assertNotIn('hidden', json.dumps(value))

    def test_endpoint_does_not_get_or_start_a_session(self):
        routes = object.__new__(AiRoutes)
        routes.service = Mock(config={})
        routes.sessions = Mock()
        self.assertEqual(routes.get('/api/ai/connection', {})['mcp']['status'], 'unconfigured')
        routes.sessions.get.assert_not_called()
        routes.service.call.assert_not_called()
        with self.assertRaises(Failure):
            routes.get('/api/ai/connection', {'session_id': ['default']})


if __name__ == '__main__':
    unittest.main()
