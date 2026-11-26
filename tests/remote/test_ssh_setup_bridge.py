"""Integration test for CircuitGit's thin LocalSshSetup adapter over SpiceOwl."""
import http.client
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/workbench'))
sys.path.insert(0, str(ROOT / 'apps/codex'))
sys.path.insert(0, str(ROOT / 'modules/gateway_client'))

from browser_ssh_setup import LocalSshSetup
import remote_node


def _has_spiceowl_ssh_setup():
    try:
        import spiceowl.onboarding.ssh_setup_ui  # noqa: F401
        return True
    except ImportError:
        return False


class LocalSshSetupAdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ssh_dir = Path(self.tmp.name).resolve() / '.ssh'
        self.ssh_dir.mkdir(mode=0o700)
        self.browser_origin = 'https://circuitgit-dev.github.io'
        self.server = remote_node.Server(('127.0.0.1', 0), remote_node.Handler)
        self.node_origin = 'http://127.0.0.1:' + str(self.server.server_port)
        self.node = remote_node.Node(
            None,
            'synthetic-owner-token-' + 'a' * 32,
            [self.browser_origin],
            'node-' + 'b' * 27,
            self.node_origin,
            'Synthetic SSH Setup Node',
        )
        self.node.ssh_setup = LocalSshSetup(self.ssh_dir, self.node.pairing, self.node.url)
        self.server.node = self.node
        rid, csrf = self.node.pairing.create(self.browser_origin, 's' * 43)
        self.paired_token = self.node.pairing.decide(rid, csrf, True)['accessCode']
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()
        self.addCleanup(self._stop)

    def _stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def _request(self, method, path, *, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            hdrs = {'Connection': 'close'}
            raw = None
            if body is not None:
                raw = json.dumps(body).encode('utf-8')
                hdrs['Content-Type'] = 'application/json'
            if headers:
                hdrs.update(headers)
            conn.request(method, path, body=raw, headers=hdrs)
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), resp.read()
        finally:
            conn.close()

    def test_node_info_and_setup_request_enforce_pairing(self):
        status, _, raw = self._request('GET', '/node/info', headers={
            'Origin': self.browser_origin,
            'Authorization': 'Bearer ' + self.paired_token,
        })
        self.assertEqual(status, 200)
        info = json.loads(raw)['data']
        self.assertTrue(info['capabilities']['local_ssh_setup'])

        # Owner token without pairing cannot open local SSH setup
        status, _, _ = self._request('POST', '/api/simulation/onboarding/ssh-setup-request', body={}, headers={
            'Origin': self.browser_origin,
            'Authorization': 'Bearer ' + self.node.token,
        })
        self.assertEqual(status, 403)

        # Paired local browser receives exact loopback setup URL
        status, _, raw = self._request('POST', '/api/simulation/onboarding/ssh-setup-request', body={}, headers={
            'Origin': self.browser_origin,
            'Authorization': 'Bearer ' + self.paired_token,
        })
        self.assertEqual(status, 200, raw)
        url = json.loads(raw)['data']['url']
        self.assertTrue(url.startswith(self.node_origin + '/ssh/setup?request='))

    @unittest.skipUnless(_has_spiceowl_ssh_setup(), 'Requires updated SpiceOwl with onboarding.ssh_setup_ui')
    def test_local_wizard_page_and_spiceowl_action_roundtrip(self):
        from spiceowl.onboarding.ssh_discovery import discover_ssh_hosts

        status, _, raw = self._request('POST', '/api/simulation/onboarding/ssh-setup-request', body={}, headers={
            'Origin': self.browser_origin,
            'Authorization': 'Bearer ' + self.paired_token,
        })
        self.assertEqual(status, 200)
        url = json.loads(raw)['data']['url']
        parsed = urlsplit(url)
        rid = parse_qs(parsed.query)['request'][0]

        # GET /ssh/setup serves SpiceOwl's CSP-protected graphical wizard
        status, hdrs, page = self._request('GET', parsed.path + '?' + parsed.query)
        self.assertEqual(status, 200)
        html_text = page.decode('utf-8')
        self.assertIn('CircuitGit · SpiceOwl', html_text)
        self.assertIn("frame-ancestors 'none'", hdrs.get('Content-Security-Policy', ''))
        m = re.search(r'"csrf"\s*:\s*"([^"]+)"', html_text)
        self.assertIsNotNone(m)
        csrf = m.group(1)

        # Cross-site POST to /ssh/setup/action is rejected
        status, _, _ = self._request('POST', '/ssh/setup/action', body={
            'request_id': rid,
            'csrf': csrf,
            'action': 'state',
            'payload': {},
        }, headers={'Origin': self.browser_origin})
        self.assertEqual(status, 403)

        # Same-origin loopback POST dispatches to SpiceOwl and writes spiceowl_hosts.conf
        status, _, raw = self._request('POST', '/ssh/setup/action', body={
            'request_id': rid,
            'csrf': csrf,
            'action': 'upsert_host',
            'payload': {
                'alias': 'eda-node',
                'hostname': '10.0.0.42',
                'port': 22,
                'user': 'alice',
                'proxy_jump': 'lab-jump',
            },
        }, headers={'Origin': self.node_origin})
        self.assertEqual(status, 200, raw)
        reply = json.loads(raw)
        self.assertTrue(reply['ok'])
        self.assertTrue((self.ssh_dir / 'spiceowl_hosts.conf').is_file())
        self.assertIn('Include spiceowl_hosts.conf', (self.ssh_dir / 'config').read_text(encoding='utf-8'))

        # Verify SpiceOwl's ssh_discovery discovers the newly configured alias immediately
        discovered = discover_ssh_hosts(self.ssh_dir / 'config', user_home=self.ssh_dir.parent)
        aliases = [h['alias'] for h in discovered['hosts']]
        self.assertIn('eda-node', aliases)


if __name__ == '__main__':
    unittest.main()
