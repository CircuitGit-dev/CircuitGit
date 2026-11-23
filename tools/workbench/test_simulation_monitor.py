"""CircuitGit uses one optional shared SpiceOwl implementation, with no eager import."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

import simulation_monitor


class MonitorWiringTests(unittest.TestCase):
    def test_module_import_does_not_require_spiceowl(self):
        spec = importlib.util.spec_from_file_location('monitor_import_fixture', Path(simulation_monitor.__file__))
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'spiceowl': None}):
            spec.loader.exec_module(module)
        self.assertTrue(callable(module.RuntimeMonitor))

    def test_missing_optional_package_gives_actionable_error(self):
        with patch.dict(sys.modules, {'spiceowl.monitoring.remote': None}):
            with self.assertRaisesRegex(ValueError, 'pinned SpiceOwl'):
                simulation_monitor.RuntimeMonitor(object())

    def test_factory_forwards_the_exact_runner_and_intervals(self):
        module = types.ModuleType('spiceowl.monitoring.remote')
        module.RuntimeMonitor = Mock()
        runner = object()
        with patch.dict(sys.modules, {'spiceowl.monitoring.remote': module}):
            result = simulation_monitor.RuntimeMonitor(runner, interval_seconds=15, max_backoff_seconds=120)
        module.RuntimeMonitor.assert_called_once_with(runner, interval_seconds=15, max_backoff_seconds=120)
        self.assertIs(result, module.RuntimeMonitor.return_value)


if __name__ == '__main__':
    unittest.main(verbosity=2)
