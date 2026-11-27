"""Regression tests for onboarding prepare, audit transport and dispatch logs."""
import inspect
import subprocess
import unittest
from unittest.mock import patch

try:
    import onboarding_prepare
except ModuleNotFoundError as error:
    if error.name != 'spiceowl':
        raise
    onboarding_prepare = None

import experiment_workflow
import onboarding_runtime


@unittest.skipIf(onboarding_prepare is None, 'SpiceOwl is not installed')
class PrepareImportTests(unittest.TestCase):
    def test_prepare_binds_os_for_git_devnull(self):
        self.assertTrue(hasattr(onboarding_prepare, 'os'))
        source = inspect.getsource(onboarding_prepare.create_child_config)
        self.assertIn('os.devnull', source)


class AuditTransportTests(unittest.TestCase):
    def test_large_generated_script_uses_ssh_stdin(self):
        site = {'ssh_target': 'synthetic-node'}
        script = 'set -eu\n' + '#' * (40 * 1024) + '\necho ok\n'
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=b'{}', stderr=b'')
        with patch.object(experiment_workflow.subprocess, 'run', return_value=completed) as run:
            result = experiment_workflow._ssh_script(site, script, timeout=7)
        self.assertIs(result, completed)
        command = run.call_args.args[0]
        self.assertEqual(command[-1], '/bin/sh -s')
        self.assertTrue(all(len(part) < 1024 for part in command))
        self.assertEqual(run.call_args.kwargs['input'], script.encode('utf-8'))
        self.assertEqual(run.call_args.kwargs['timeout'], 7)
        self.assertTrue(run.call_args.kwargs['capture_output'])


class DispatchLogTests(unittest.TestCase):
    def test_failure_line_prefers_bounded_single_line_cause(self):
        outer = ValueError('outer')
        outer.__cause__ = RuntimeError('inner\nreason' + 'x' * 2000)
        line = onboarding_runtime._failure_line(outer)
        self.assertTrue(line.startswith('RuntimeError: inner reason'))
        self.assertNotIn('\n', line)
        self.assertLessEqual(len(line), 800)

    def test_failure_line_falls_back_to_outer_error(self):
        self.assertEqual(onboarding_runtime._failure_line(ValueError('plain')), 'ValueError: plain')


if __name__ == '__main__':
    unittest.main()
