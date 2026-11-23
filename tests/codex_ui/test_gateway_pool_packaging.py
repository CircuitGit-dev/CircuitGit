"""Build the isolated checkout's plugin, then import its gateway in isolated Python.

Only temporary package and fixture directories are written. No network, SSH,
simulator, local service startup, npm hooks or source-tree import fallback occurs.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSTRUCT = r'''
import importlib.abc
import json
from pathlib import Path
import sys
from unittest.mock import Mock, patch

package, fixture, mode = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
fixture.mkdir()
sys.path.insert(0, str(package / 'gateway'))
class NoExternalSpiceOwl(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'spiceowl' or fullname.startswith('spiceowl.'):
            raise AssertionError('Constructing the packaged gateway must not import optional SpiceOwl')
sys.meta_path.insert(0, NoExternalSpiceOwl())
import server
import runner
import spiceowl_pool
import ic_sim
import workspace
for module in (server, runner, spiceowl_pool, ic_sim, workspace):
    assert Path(module.__file__).resolve().is_relative_to(package.resolve()), module.__file__
site = {'schema': 'ic.sim.site.v1', 'ssh_target': 'fixture-route',
        'remote_runs_root': '/fixture/ic_on_github_runs', 'cadence_cshrc': '/fixture/setup',
        'spectre_bin': '/fixture/spectre', 'external_files': {},
        'expected_host': 'fixture-host', 'expected_user': 'fixture-user'}
site_file = fixture / 'site.json'
site_file.write_text(json.dumps(site))
config = {'runtime_root': str(fixture / 'runtime'), 'site_file': str(site_file), 'github_repo': 'fixture/project'}
if mode == 'pool':
    pool_file = fixture / 'pool.json'
    pool_file.write_text(json.dumps({'schema': 'ic.spiceowl-pool.v1',
        'spiceowl_data_dir': str(fixture / 'spiceowl'),
        'requirements': {'cpu_count': 1, 'memory_bytes': 1024**3, 'simulator': 'spectre'},
        'members': [{'host_id': 'fixture-host', 'site_file': str(site_file)}]}))
    config['spiceowl_pool_file'] = str(pool_file)
fake_workspace = Mock()
fake_workspace.frozen = fixture / 'frozen'
fake_workspace.projects = {}
with patch.object(server, 'Workspace', return_value=fake_workspace), \
     patch.object(server, 'Geometry'), patch.object(server, 'WaveformService'), \
     patch.object(server.core, 'ssh', side_effect=AssertionError('No SSH')) as ssh, \
     patch.object(server.core, 'subprocess') as processes:
    processes.run.side_effect = AssertionError('No child process during construction')
    app = server.Application(config, package / 'gateway-web')
    try:
        assert isinstance(app.runner, runner.Runner)
        if mode == 'pool':
            assert isinstance(app.resource_pool, spiceowl_pool.ResourcePool)
            assert app.runner.resource_recheck.__self__ is app.resource_pool
            assert app.resource_pool._external is None
            assert not app.resource_pool.root.exists()
        else:
            assert app.resource_pool is None
            assert app.runner.resource_recheck is None
        ssh.assert_not_called()
        processes.run.assert_not_called()
        print(json.dumps({'mode': mode, 'constructed': True, 'external_spiceowl_loaded': False}))
    finally:
        app.pool.shutdown(wait=True)
'''


class GatewayPoolPackagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / 'dist').mkdir(exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix='pool-package-test-', dir=ROOT / 'dist')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.package = cls.root / 'package'
        built = subprocess.run([sys.executable, '-B', str(ROOT / 'tools/dev/build.py'), 'codex',
                                '--output', str(cls.package)], cwd=ROOT, text=True, capture_output=True, timeout=120)
        if built.returncode:
            raise AssertionError(built.stderr + built.stdout)
        cls.report = json.loads(built.stdout)

    def construct(self, mode):
        script = self.root / ('construct-' + mode + '.py')
        script.write_text(CONSTRUCT)
        completed = subprocess.run([sys.executable, '-I', '-B', str(script), str(self.package),
                                    str(self.root / ('fixture-' + mode)), mode],
                                   cwd=self.root, text=True, capture_output=True, timeout=20)
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        return json.loads(completed.stdout)

    def test_gateway_allowlist_includes_adapter_without_packaging_local_tests(self):
        self.assertEqual(self.report['kind'], 'codex')
        self.assertTrue((self.package / 'gateway/spiceowl_pool.py').is_file())
        self.assertFalse((self.package / 'gateway/test_spiceowl_pool.py').exists())
        self.assertFalse((self.package / 'gateway/test_spiceowl_http.py').exists())

    def test_packaged_fixed_site_constructs_without_optional_spiceowl(self):
        self.assertEqual(self.construct('fixed'), {'mode': 'fixed', 'constructed': True, 'external_spiceowl_loaded': False})

    def test_packaged_pool_constructs_lazily_with_only_private_fixture_configuration(self):
        self.assertEqual(self.construct('pool'), {'mode': 'pool', 'constructed': True, 'external_spiceowl_loaded': False})


if __name__ == '__main__':
    unittest.main()
