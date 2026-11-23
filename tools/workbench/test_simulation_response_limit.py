"""Exercise real HTTP JSON serialization without sockets or remote operations."""
import io
import json
import unittest
from unittest.mock import Mock

from server import Handler


LIMIT = 2 * 1024 * 1024


class SimulationResponseLimitTests(unittest.TestCase):
    def handler(self, path='/api/simulation/control'):
        handler = object.__new__(Handler)
        handler.path = path
        handler.wfile = io.BytesIO()
        handler.close_connection = False
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        return handler

    def envelope(self, size, *, multibyte=False):
        empty = {'ok': True, 'data': {'message': ''}}
        remaining = size - len(json.dumps(empty, ensure_ascii=False).encode('utf-8'))
        message = '波' * (remaining // 3) + 'x' * (remaining % 3) if multibyte else 'x' * remaining
        empty['data']['message'] = message
        return empty

    def assert_length(self, handler):
        values = {key.lower(): value for (key, value), _ in handler.send_header.call_args_list}
        self.assertEqual(int(values['content-length']), len(handler.wfile.getvalue()))

    def test_exact_envelope_byte_boundary_is_returned_intact(self):
        for multibyte in (False, True):
            with self.subTest(multibyte=multibyte):
                envelope = self.envelope(LIMIT, multibyte=multibyte)
                handler = self.handler()
                handler.response(envelope['data'])
                handler.send_response.assert_called_once_with(200)
                self.assertEqual(len(handler.wfile.getvalue()), LIMIT)
                self.assertEqual(json.loads(handler.wfile.getvalue()), envelope)
                self.assertFalse(handler.close_connection)
                self.assert_length(handler)

    def test_one_byte_over_limit_returns_bounded_error_instead_of_partial_data(self):
        handler = self.handler()
        handler.response(self.envelope(LIMIT + 1)['data'])
        handler.send_response.assert_called_once_with(503)
        result = json.loads(handler.wfile.getvalue())
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['code'], 'response_size_limit')
        self.assertNotIn('data', result)
        self.assertLess(len(handler.wfile.getvalue()), 512)
        self.assertTrue(handler.close_connection)
        self.assert_length(handler)

    def test_utf8_multibyte_count_is_not_unicode_character_count(self):
        envelope = {'ok': True, 'data': {'message': '波' * (LIMIT // 3 + 1)}}
        encoded = json.dumps(envelope, ensure_ascii=False)
        self.assertLess(len(encoded), LIMIT)
        self.assertGreater(len(encoded.encode('utf-8')), LIMIT)
        handler = self.handler('/api/simulation/runtime?project_id=synthetic')
        handler.send(200, envelope)
        handler.send_response.assert_called_once_with(503)
        self.assertEqual(json.loads(handler.wfile.getvalue())['error']['code'], 'response_size_limit')
        self.assert_length(handler)

    def test_preencoded_json_and_encoded_route_cannot_bypass_the_limit(self):
        raw = json.dumps(self.envelope(LIMIT + 1), ensure_ascii=False).encode('utf-8')
        handler = self.handler('/api%2Fsimulation%2Fcontrol')
        handler.send(200, raw)
        handler.send_response.assert_called_once_with(503)
        self.assertEqual(json.loads(handler.wfile.getvalue())['error']['code'], 'response_size_limit')

    def test_other_apis_and_non_json_responses_keep_existing_behavior(self):
        envelope = self.envelope(LIMIT + 1)
        for path in ['/api/jobs/run-1/results', '/api/simulation-other/runtime']:
            handler = self.handler(path)
            handler.send(200, envelope)
            handler.send_response.assert_called_once_with(200)
            self.assertEqual(json.loads(handler.wfile.getvalue()), envelope)
            self.assert_length(handler)
        handler = self.handler()
        raw = b'x' * (LIMIT + 1)
        handler.send(200, raw, ctype='application/octet-stream')
        handler.send_response.assert_called_once_with(200)
        self.assertEqual(handler.wfile.getvalue(), raw)
        self.assert_length(handler)


if __name__ == '__main__':
    unittest.main()
