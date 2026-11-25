"""Tests for the cross-platform `circuitgit://` connector installer and `/health` probe."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/workbench'))
sys.path.insert(0, str(ROOT / 'apps/codex'))

import connector_install as ci
import remote_node as rn


class FakeWinReg:
    HKEY_CURRENT_USER = 'HKCU'
    REG_SZ = 1
    KEY_SET_VALUE = 2

    def __init__(self):
        self.keys = {}

    class _Handle:
        def __init__(self, store, path):
            self.store = store
            self.path = path

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def CreateKey(self, root, subkey):
        full = f'{root}\\{subkey}'
        self.keys.setdefault(full, {})
        return self._Handle(self.keys, full)

    def OpenKey(self, root, subkey, reserved=0, access=0):
        full = f'{root}\\{subkey}'
        if full not in self.keys:
            raise FileNotFoundError(full)
        return self._Handle(self.keys, full)

    def SetValueEx(self, handle, name, reserved, kind, value):
        self.keys[handle.path][name] = (value, kind)

    def QueryValueEx(self, handle, name):
        if name not in self.keys[handle.path]:
            raise FileNotFoundError(name)
        return self.keys[handle.path][name]

    def DeleteValue(self, handle, name):
        if name not in self.keys[handle.path]:
            raise FileNotFoundError(name)
        del self.keys[handle.path][name]

    def DeleteKey(self, root, subkey):
        full = f'{root}\\{subkey}'
        if full not in self.keys:
            raise FileNotFoundError(full)
        del self.keys[full]


class ConnectorInstallTests(unittest.TestCase):
    def test_parse_connector_uri_accepts_only_finite_actions(self):
        self.assertEqual(ci.parse_connector_uri('circuitgit://start'), 'start')
        self.assertEqual(ci.parse_connector_uri('CIRCUITGIT://connect/'), 'connect')
        for bad in ('', 'http://127.0.0.1:8767', 'circuitgit://shell', 'circuitgit://start\nrm', 'circuitgit://' + 'a' * 600):
            with self.assertRaises(ValueError):
                ci.parse_connector_uri(bad)

    def test_windows_registry_install_status_and_uninstall(self):
        reg = FakeWinReg()
        res = ci.install_windows(ROOT, autostart=True, reg_module=reg)
        self.assertTrue(res['registered'])
        self.assertTrue(res['autostart'])
        self.assertIn('handle-uri', res['command'])

        st = ci.status_windows(reg_module=reg)
        self.assertTrue(st['registered'])
        self.assertTrue(st['autostart'])

        removed = ci.uninstall_windows(reg_module=reg)
        self.assertFalse(removed['registered'])
        self.assertFalse(removed['autostart'])
        self.assertFalse(ci.status_windows(reg_module=reg)['registered'])

    def test_macos_bundle_and_launchagent_install_status_uninstall(self):
        with tempfile.TemporaryDirectory(prefix='cg-mac-conn-') as tmp:
            home = Path(tmp).resolve()
            calls = []
            res = ci.install_macos(ROOT, autostart=True, home=home, run=lambda cmd, **kw: calls.append(cmd))
            self.assertTrue(res['registered'])
            self.assertTrue(res['autostart'])
            self.assertTrue((home / 'Applications/CircuitGit Connector.app/Contents/Info.plist').is_file())
            self.assertTrue((home / 'Library/LaunchAgents/dev.circuitgit.connector.plist').is_file())
            self.assertTrue(ci.status_macos(home=home)['registered'])
            self.assertTrue(ci.status_macos(home=home)['autostart'])

            ci.uninstall_macos(home=home)
            self.assertFalse(ci.status_macos(home=home)['registered'])
            self.assertFalse(ci.status_macos(home=home)['autostart'])

    def test_linux_desktop_install_status_uninstall(self):
        with tempfile.TemporaryDirectory(prefix='cg-lin-conn-') as tmp:
            home = Path(tmp).resolve()
            res = ci.install_linux(ROOT, autostart=True, home=home, run=lambda cmd, **kw: None)
            self.assertTrue(res['registered'])
            self.assertTrue(res['autostart'])
            self.assertTrue(ci.status_linux(home=home)['registered'])
            ci.uninstall_linux(home=home)
            self.assertFalse(ci.status_linux(home=home)['registered'])

    def test_handle_uri_launches_detached_bootstrap_without_passing_uri_args(self):
        with tempfile.TemporaryDirectory(prefix='cg-uri-') as tmp:
            root = Path(tmp).resolve()
            launched = []
            def fake_popen(cmd, **kwargs):
                launched.append((cmd, kwargs))
                return SimpleNamespace(pid=4242)
            out = ci.handle_uri('circuitgit://connect?evil=1', root=root, popen=fake_popen)
            self.assertEqual(out['action'], 'connect')
            self.assertEqual(out['pid'], 4242)
            self.assertEqual(len(launched), 1)
            cmd, _ = launched[0]
            self.assertIn('--from-uri', cmd)
            self.assertIn('--no-browser', cmd)
            self.assertFalse(any('evil' in str(part) for part in cmd))

    def test_remote_node_health_route_allows_trusted_origin_and_rejects_foreign_origin(self):
        node = rn.Node(
            routes=None,
            token='x' * 43,
            origins=['https://circuitgit-dev.github.io'],
            node_id='0' * 32,
            public_url='http://127.0.0.1:8767',
        )

        def call_get(path, origin_hdr):
            handler = object.__new__(rn.Handler)
            handler.server = SimpleNamespace(node=node, server_port=8767)
            handler.headers = {'Host': '127.0.0.1:8767', 'Origin': origin_hdr}
            handler.path = path
            captured = []
            handler.send = lambda status, data=None, **kw: captured.append((status, data))
            handler.do_GET()
            return captured[0]

        status, body = call_get('/health', 'https://circuitgit-dev.github.io')
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])
        self.assertTrue(body['data']['ready'])
        self.assertEqual(body['data']['protocol'], 'circuitgit')

        status, body = call_get('/health', 'https://evil.example')
        self.assertEqual(status, 403)
        self.assertFalse(body['ok'])

        status, body = call_get('/health?foo=bar', 'https://circuitgit-dev.github.io')
        self.assertEqual(status, 400)


if __name__ == '__main__':
    unittest.main(verbosity=2)
