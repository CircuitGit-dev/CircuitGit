"""Launcher lifetime and legacy health compatibility, without sockets or SSH."""
import contextlib
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import onboarding_server
import server


class OnboardingLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'fresh-state'

    def test_one_state_has_one_owner_independently_of_ports(self):
        with onboarding_server.onboarding_state_lock(self.state):
            self.assertFalse(self.state.exists(), 'A lease must not make a fresh store nonempty')
            with patch('onboarding_server._serve_onboarding') as serve:
                with self.assertRaisesRegex(ValueError, 'already in use'):
                    onboarding_server.serve_onboarding(self.state, root=self.root,
                        node_port=31001, gateway_port=31002, resume=True, no_browser=True)
                serve.assert_not_called()
            with onboarding_server.onboarding_state_lock(self.root / 'another-state'):
                pass
        with onboarding_server.onboarding_state_lock(self.state):
            pass

    def test_canonical_parent_alias_cannot_get_a_second_lease(self):
        real = self.root / 'real-parent'
        real.mkdir()
        alias = self.root / 'alias-parent'
        alias.symlink_to(real, target_is_directory=True)
        with onboarding_server.onboarding_state_lock(real / 'state'):
            with self.assertRaisesRegex(ValueError, 'already in use'):
                with onboarding_server.onboarding_state_lock(alias / 'state'):
                    self.fail('A parent alias must share the same store lease')

    def test_lease_releases_after_startup_error_without_removing_lock_inode(self):
        with self.assertRaisesRegex(RuntimeError, 'synthetic startup failure'):
            with onboarding_server.onboarding_state_lock(self.state):
                raise RuntimeError('synthetic startup failure')
        locks = list(self.root.glob('.onboarding-*.lock'))
        self.assertEqual(len(locks), 1)
        inode = locks[0].stat().st_ino
        with onboarding_server.onboarding_state_lock(self.state):
            self.assertEqual(locks[0].stat().st_ino, inode)

    @contextlib.contextmanager
    def fake_launcher(self):
        app = Mock()
        browser = Mock(server_port=31001)
        gateway = Mock(server_port=31002)
        thread = Mock()
        with (patch('server.Server', return_value=gateway),
              patch('remote_node.Server', return_value=browser),
              patch('server.Application', return_value=app),
              patch('remote_node.Node'),
              patch('remote_node.node_identity', return_value=('synthetic-token', 'synthetic-node', None)) as identity,
              patch('onboarding_server.threading.Thread', return_value=thread),
              patch('onboarding_server.signal.signal', return_value=0),
              patch('onboarding_server.webbrowser.open') as open_browser,
              contextlib.redirect_stdout(io.StringIO())):
            yield SimpleNamespace(app=app, browser=browser, gateway=gateway, thread=thread,
                                  identity=identity, open_browser=open_browser)

    def launch(self):
        return onboarding_server.serve_onboarding(self.state, root=self.root,
            node_port=31001, gateway_port=31002, no_browser=True)

    def test_failure_after_app_creation_does_not_shutdown_an_unstarted_server(self):
        with self.fake_launcher() as fake:
            fake.identity.side_effect = ValueError('synthetic node initialization failed')
            with self.assertRaisesRegex(ValueError, 'synthetic node'):
                self.launch()
            fake.thread.start.assert_not_called()
            fake.gateway.shutdown.assert_not_called()
            fake.gateway.server_close.assert_called_once()
            fake.browser.server_close.assert_called_once()
            fake.app.onboarding.close.assert_called_once()
            fake.app.simulation.close.assert_called_once()
            fake.app.pool.shutdown.assert_called_once_with(wait=False)
        with onboarding_server.onboarding_state_lock(self.state):
            pass

    def test_thread_start_failure_does_not_shutdown_an_unstarted_server(self):
        with self.fake_launcher() as fake:
            fake.thread.start.side_effect = RuntimeError('synthetic thread start failed')
            with self.assertRaisesRegex(RuntimeError, 'synthetic thread'):
                self.launch()
            fake.gateway.shutdown.assert_not_called()
            fake.gateway.server_close.assert_called_once()
            fake.app.pool.shutdown.assert_called_once_with(wait=False)

    def test_started_gateway_is_stopped_before_application_teardown(self):
        with self.fake_launcher() as fake:
            events = []
            fake.browser.serve_forever.side_effect = KeyboardInterrupt()
            fake.gateway.shutdown.side_effect = lambda: events.append('gateway-stopped')
            fake.app.onboarding.close.side_effect = lambda: events.append('app-closed')
            self.launch()
            fake.thread.start.assert_called_once()
            fake.gateway.shutdown.assert_called_once()
            fake.thread.join.assert_called_once_with(timeout=5)
            fake.gateway.server_close.assert_called_once()
            fake.browser.server_close.assert_called_once()
            fake.open_browser.assert_not_called()
            self.assertEqual(events, ['gateway-stopped', 'app-closed'])


class LegacyHealthTests(unittest.TestCase):
    def health(self, app):
        handler = object.__new__(server.Handler)
        handler.server = SimpleNamespace(app=app)
        handler.path = '/api/health'
        handler.guard = Mock()
        handler.response = Mock()
        handler.error = Mock(side_effect=AssertionError('Health must not fail'))
        handler.do_GET()
        handler.error.assert_not_called()
        return handler.response.call_args.args[0]

    def test_old_fake_app_without_onboarding_or_cfg_remains_healthy(self):
        with tempfile.TemporaryDirectory() as root:
            data = self.health(SimpleNamespace(token='synthetic-token', ai=None, web=Path(root)))
        self.assertIsNone(data['connection_id'])
        self.assertTrue(data['capabilities']['git'])
        self.assertTrue(data['capabilities']['publish'])
        self.assertFalse(data['capabilities']['simulation_onboarding'])
        self.assertIsNone(data['capabilities']['simulation_onboarding_api_version'])

    def test_fresh_app_health_keeps_local_onboarding_capabilities(self):
        with tempfile.TemporaryDirectory() as root:
            data = self.health(SimpleNamespace(token='synthetic-token', ai=None, web=Path(root),
                cfg={'onboarding_only': True, 'local_only': True},
                onboarding=SimpleNamespace(connection_id='a'*32, enabled=True)))
        self.assertEqual(data['connection_id'], 'a'*32)
        self.assertFalse(data['capabilities']['git'])
        self.assertFalse(data['capabilities']['publish'])
        self.assertTrue(data['capabilities']['simulation_onboarding'])
        self.assertEqual(data['capabilities']['simulation_onboarding_api_version'], '1')


if __name__ == '__main__':
    unittest.main()
