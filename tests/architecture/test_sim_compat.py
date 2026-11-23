"""Compatibility runner tests: local plan only, without model/SSH/simulation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CANONICAL = ROOT / 'tools/workbench/ic_sim.py'
COMPAT = ROOT / 'tools/sim/ic_sim.py'


class RunnerCompatibilityTests(unittest.TestCase):
    def test_file_spec_caller_retains_functions_and_canonical_provenance(self):
        # tools/check_project.py does not register its module before exec_module.
        name = 'isolated_spec_legacy_runner'
        self.addCleanup(sys.modules.pop, name, None)
        spec = importlib.util.spec_from_file_location(name, COMPAT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(Path(module.__file__), CANONICAL)
        self.assertEqual(module.HERE, CANONICAL.parent)
        self.assertEqual(Path(module.prepare.__globals__['__file__']), CANONICAL)
        _, _, proof = module.prepare(ROOT / 'tools/sim/fixtures/bundle.json',
                                     module.site_load(ROOT / 'config/site.example.json'))
        self.assertEqual(proof['runner_sha256'], hashlib.sha256(CANONICAL.read_bytes()).hexdigest())
        self.assertNotEqual(proof['runner_sha256'], hashlib.sha256(COMPAT.read_bytes()).hexdigest())

    def test_cli_plan_and_failure_match_canonical_from_another_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            for args in [
                ['--site', str(ROOT / 'config/site.example.json'), 'plan', '--bundle', str(ROOT / 'tools/sim/fixtures/bundle.json')],
                ['--site', str(Path(temp) / 'absent-site.json'), 'plan', '--bundle', str(ROOT / 'tools/sim/fixtures/bundle.json')],
            ]:
                outputs = [subprocess.run([sys.executable, '-B', str(entry), *args], cwd=temp,
                                          capture_output=True, text=True, timeout=10) for entry in (CANONICAL, COMPAT)]
                self.assertEqual(outputs[0].returncode, outputs[1].returncode)
                self.assertEqual(outputs[0].stderr, outputs[1].stderr)
                if outputs[0].returncode == 0:
                    plans = [json.loads(output.stdout) for output in outputs]
                    for plan in plans:
                        self.assertFalse(plan['simulation_started'])
                        run_id = plan.pop('run_id')
                        self.assertTrue(plan['remote_directory'].endswith('/' + run_id))
                        plan['remote_directory'] = plan['remote_directory'][:-len(run_id)] + '<run-id>'
                    self.assertEqual(plans[0], plans[1])
                else:
                    self.assertEqual(outputs[0].stdout, outputs[1].stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
