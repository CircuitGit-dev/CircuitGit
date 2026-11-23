"""Mocked subprocess setup tests: no network, pip, SSH, model or solver runs."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import bootstrap_python as bootstrap


class Runtime:
    def __init__(self):
        self.observations = {}
        self.calls = []
        self.fail_install = False
        self.wrong_commit = False

    def add(self, python, version=(3, 11, 9), pin=None, global_python=False):
        python.parent.mkdir(parents=True, exist_ok=True)
        python.touch()
        prefix = python.parent.parent
        observation = {'version': list(version), 'prefix': str(prefix),
                       'base_prefix': str(prefix if global_python else Path('/base')), 'dependency': None}
        if pin:
            observation['dependency'] = self.dependency(prefix, pin)
        self.observations[str(python)] = observation
        return python

    def dependency(self, prefix, pin):
        return {'location': str(prefix / 'lib/site-packages'),
                'direct_url': {'url': pin['repository'], 'vcs_info': {
                    'vcs': 'git', 'commit_id': pin['commit'], 'requested_revision': pin['commit']}},
                'modules': {name: str(prefix / 'lib/site-packages' / (name.replace('.', '/') + '.py'))
                            for name in bootstrap.REQUIRED_MODULES}}

    def run(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if '-c' in command:
            value = self.observations.get(command[0])
            return subprocess.CompletedProcess(command, 0 if value else 1,
                                               json.dumps(value) if value else '', '')
        operation = command[command.index('-m') + 1]
        if operation == 'venv':
            root = Path(command[-1])
            self.add(root / 'bin/python', version=self.observations[command[0]]['version'])
        elif operation == 'pip':
            if self.fail_install:
                return subprocess.CompletedProcess(command, 1, '', 'Synthetic network unavailable')
            repository, commit = command[-1][4:].rsplit('@', 1)
            observation = self.observations[command[0]]
            observation['dependency'] = self.dependency(Path(observation['prefix']), {
                'repository': repository, 'commit': 'f' * 40 if self.wrong_commit else commit})
        else:
            raise AssertionError('Unexpected subprocess: ' + str(command))
        return subprocess.CompletedProcess(command, 0, '', '')

    @property
    def installs(self):
        return [command for command, _kwargs in self.calls if 'pip' in command]


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve() / 'project with spaces'
        (self.root / 'contracts').mkdir(parents=True)
        self.pin = {'repository': 'https://example.test/spiceowl.git', 'commit': 'a' * 40}
        self.write_pin()
        self.runtime = Runtime()
        self.base = self.runtime.add(self.root.parent / 'python311/bin/python3', global_python=True)
        self.progress = []
        self.git = patch.object(bootstrap.shutil, 'which', return_value='/usr/bin/git')
        self.git.start()
        self.addCleanup(self.git.stop)

    def write_pin(self):
        (self.root / 'contracts/spiceowl-integration.lock.json').write_text(json.dumps({
            'schema': 'circuitgit.spiceowl-integration.v1', 'spiceowl': self.pin}))

    def ensure(self, candidates=None):
        return bootstrap.ensure_python(self.root, run=self.runtime.run,
                                       candidates=candidates or [self.base], progress=self.progress.append)

    def test_installs_exact_pin_in_project_and_reuses_without_a_second_install(self):
        python = self.ensure()
        self.assertTrue(bootstrap.within(python, self.root / '.local/python'))
        self.assertEqual(len(self.runtime.installs), 1)
        self.assertEqual(self.runtime.installs[0][-1], 'git+' + self.pin['repository'] + '@' + self.pin['commit'])
        self.assertIn('--no-cache-dir', self.runtime.installs[0])
        self.assertEqual(self.ensure(), python)
        self.assertEqual(len(self.runtime.installs), 1)
        self.assertEqual(len(self.progress), 3)

    def test_matching_project_venv_is_preferred_and_never_modified(self):
        project = self.runtime.add(self.root / '.venv/bin/python', pin=self.pin)
        self.assertEqual(self.ensure(), project)
        self.assertEqual(self.runtime.installs, [])
        self.assertEqual(len(self.runtime.calls), 1)

    def test_pin_change_creates_separate_environment_and_keeps_previous_one(self):
        first = self.ensure()
        old_marker = (first.parent.parent / 'circuitgit-environment.json').read_bytes()
        self.pin = {**self.pin, 'commit': 'b' * 40}
        self.write_pin()
        second = self.ensure()
        self.assertNotEqual(first, second)
        self.assertEqual((first.parent.parent / 'circuitgit-environment.json').read_bytes(), old_marker)
        self.assertEqual(len(self.runtime.installs), 2)
        self.assertEqual(self.runtime.installs[-1][-1], 'git+' + self.pin['repository'] + '@' + self.pin['commit'])

    def test_old_python_is_skipped_and_only_old_python_fails_before_install(self):
        old = self.runtime.add(self.root / '.venv/bin/python', version=(3, 9, 6), pin=self.pin)
        with self.assertRaisesRegex(bootstrap.BootstrapError, 'Python 3.11'):
            self.ensure([old])
        self.assertEqual(self.runtime.installs, [])
        self.ensure([old, self.base])
        created = [command for command, _kwargs in self.runtime.calls if 'venv' in command]
        self.assertEqual(created[-1][0], str(self.base))

    def test_wrong_or_global_dependency_is_not_accepted_as_project_pin(self):
        project = self.runtime.add(self.root / '.venv/bin/python', pin=self.pin)
        self.runtime.observations[str(project)]['dependency']['modules'][bootstrap.REQUIRED_MODULES[0]] = '/global/spiceowl.py'
        result = self.ensure()
        self.assertNotEqual(result, project)
        self.assertEqual(len(self.runtime.installs), 1)
        self.assertEqual(self.runtime.observations[str(project)]['dependency']['modules'][bootstrap.REQUIRED_MODULES[0]], '/global/spiceowl.py')

    def test_install_failure_and_postinstall_pin_mismatch_stop_without_ready(self):
        self.runtime.fail_install = True
        with self.assertRaisesRegex(bootstrap.BootstrapError, '安装 SpiceOwl失败.*') as failure:
            self.ensure()
        self.assertIn('Synthetic network unavailable', str(failure.exception))
        self.assertFalse(any('已核验' in message for message in self.progress))
        self.runtime.fail_install = False
        self.runtime.wrong_commit = True
        with self.assertRaisesRegex(bootstrap.BootstrapError, '安装后校验失败'):
            self.ensure()

    def test_missing_git_or_unsafe_lock_stop_before_install(self):
        with patch.object(bootstrap.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(bootstrap.BootstrapError, '需要 Git'):
                self.ensure()
        self.pin = {**self.pin, 'repository': 'https://user:secret@example.test/spiceowl.git'}
        self.write_pin()
        with self.assertRaisesRegex(bootstrap.BootstrapError, '锁定文件无效'):
            self.ensure()
        self.assertEqual(self.runtime.installs, [])

    def test_external_local_directory_is_not_written(self):
        external = self.root.parent / 'another-project'
        external.mkdir()
        (self.root / '.local').symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(bootstrap.BootstrapError, '仓库以外'):
            self.ensure()
        self.assertEqual(list(external.iterdir()), [])

    def test_concurrent_starter_does_not_repeat_installation(self):
        with bootstrap.setup_lock(self.root/'.local/python'):
            with self.assertRaisesRegex(bootstrap.BootstrapError,'另一个 CircuitGit'):
                self.ensure()
        self.assertEqual(self.runtime.calls,[])

    def test_setup_only_never_launches_and_entry_arguments_are_preserved(self):
        python = self.root / '.local/python/verified/bin/python'
        with patch.object(bootstrap, 'ensure_python', return_value=python), \
                patch.object(bootstrap.subprocess, 'call', return_value=7) as launch, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(bootstrap.main(['--setup-only'], root=self.root), 0)
            self.assertEqual(json.loads(output.getvalue())['python'], str(python))
            launch.assert_not_called()
            arguments = ['--port', '8769', '--state-dir', '/some directory', '--no-browser']
            self.assertEqual(bootstrap.main(arguments, root=self.root), 7)
            self.assertEqual(launch.call_args.args[0],[str(python), '-E', '-s', '-B', str(self.root / 'tools/workbench/connect_browser.py'), *arguments])
            self.assertEqual(launch.call_args.kwargs['cwd'],str(self.root))
            launch.reset_mock()
            self.assertEqual(bootstrap.main(['--entry', 'launch', '--config', 'local config.json'], root=self.root), 7)
            self.assertEqual(launch.call_args.args[0][-3:], [str(self.root / 'tools/workbench/launch.py'), '--config', 'local config.json'])

    def test_setup_failure_never_launches_and_pip_settings_do_not_escape(self):
        with patch.object(bootstrap, 'ensure_python', side_effect=bootstrap.BootstrapError('Synthetic failed setup')), \
                patch.object(bootstrap.subprocess, 'call') as launch, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(bootstrap.main([], root=self.root), 1)
            launch.assert_not_called()
        with patch.dict('os.environ', {'PIP_TARGET': '/global/packages', 'PYTHONPATH': '/another/project'}):
            self.ensure()
        for _command, options in self.runtime.calls:
            self.assertNotIn('PIP_TARGET', options['env'])
            self.assertNotIn('PYTHONPATH', options['env'])
            self.assertEqual(options['env']['PIP_CONFIG_FILE'], bootstrap.os.devnull)

    def test_direct_entry_switches_once_and_same_verified_prefix_runs_in_place(self):
        python = self.root / '.local/python/verified/bin/python'
        entry = self.root / 'tools/workbench/connect_browser.py'
        with patch.object(bootstrap, 'ensure_python', return_value=python), \
                patch.object(bootstrap.subprocess, 'call', return_value=6) as launch:
            callback = lambda: 12
            self.assertEqual(bootstrap.run_entrypoint(entry, callback, argv=['--port','8769'],root=self.root),6)
            self.assertEqual(launch.call_args.args[0],[str(python),'-E','-s','-B',str(entry),'--port','8769'])
            launch.reset_mock()
            with patch.object(bootstrap.sys,'prefix',str(python.parent.parent)), \
                    patch.object(bootstrap.sys,'flags',SimpleNamespace(ignore_environment=1,no_user_site=1)), \
                    patch.dict('os.environ',bootstrap.safe_environment(),clear=True):
                self.assertEqual(bootstrap.run_entrypoint(entry, callback,argv=[],root=self.root),12)
            launch.assert_not_called()

    def test_correct_venv_reexecutes_if_caller_environment_was_not_isolated(self):
        python = self.root / '.local/python/verified/bin/python'
        with patch.object(bootstrap,'ensure_python',return_value=python), \
                patch.object(bootstrap.sys,'prefix',str(python.parent.parent)), \
                patch.object(bootstrap.sys,'flags',SimpleNamespace(ignore_environment=0,no_user_site=0)), \
                patch.dict('os.environ',{'PYTHONPATH':'/another-project','PYTHONUSERBASE':'/global-user'}), \
                patch.object(bootstrap.subprocess,'call',return_value=0) as launch:
            self.assertEqual(bootstrap.run_entrypoint(self.root/'launch.py',lambda:self.fail('Must reexec cleanly'),argv=[],root=self.root),0)
            self.assertEqual(launch.call_args.args[0][1:4],['-E','-s','-B'])
            self.assertNotIn('PYTHONPATH',launch.call_args.kwargs['env'])
            self.assertNotIn('PYTHONUSERBASE',launch.call_args.kwargs['env'])

    def test_clean_flags_still_reexec_when_environment_would_pollute_a_later_child(self):
        python = self.root / '.local/python/verified/bin/python'
        with patch.object(bootstrap,'ensure_python',return_value=python), \
                patch.object(bootstrap.sys,'prefix',str(python.parent.parent)), \
                patch.object(bootstrap.sys,'flags',SimpleNamespace(ignore_environment=1,no_user_site=1)), \
                patch.dict('os.environ',{'PYTHONPATH':'/another-project','PYTHONUSERBASE':'/global-user'}), \
                patch.object(bootstrap.subprocess,'call',return_value=0) as launch:
            original=dict(bootstrap.os.environ)
            self.assertEqual(bootstrap.run_entrypoint(self.root/'launch.py',lambda:self.fail('Must clean inherited environment'),argv=[],root=self.root),0)
            self.assertNotIn('PYTHONPATH',launch.call_args.kwargs['env'])
            self.assertNotIn('PYTHONUSERBASE',launch.call_args.kwargs['env'])
            self.assertEqual(dict(bootstrap.os.environ),original,'The caller environment is never modified')
            with patch.dict('os.environ',launch.call_args.kwargs['env'],clear=True):
                self.assertEqual(dict(bootstrap.os.environ),bootstrap.safe_environment(),'Cleaning must be idempotent')

    def test_real_nested_python_child_cannot_import_from_inherited_pythonpath(self):
        # Verify the exact failure mode: a clean-flag entry later starts plain -B
        # Python. Only package selection/prefix/flags are mocked; both downstream
        # Python processes are real and run this no-network temporary script.
        alien=self.root/'unrelated modules';alien.mkdir()
        (alien/'bootstrap_pollution.py').write_text('unrelated = True\n')
        output=self.root/'child-result.json';entry=self.root/'inherited-entry.py'
        code="import importlib.util,json,os; print(json.dumps({'pythonpath':os.environ.get('PYTHONPATH'),'polluted':importlib.util.find_spec('bootstrap_pollution') is not None}))"
        entry.write_text('import subprocess,sys\nfrom pathlib import Path\n'
                         'result=subprocess.run([sys.executable,"-B","-c",'+repr(code)+'],capture_output=True,text=True,check=True)\n'
                         'Path(sys.argv[1]).write_text(result.stdout)\n')
        python=Path(bootstrap.sys.executable)
        def application():
            reply=subprocess.run([str(python),'-B','-c',code],capture_output=True,text=True,check=True)
            output.write_text(reply.stdout)
            return 0
        with patch.object(bootstrap,'ensure_python',return_value=python), \
                patch.object(bootstrap.sys,'prefix',str(python.parent.parent)), \
                patch.object(bootstrap.sys,'flags',SimpleNamespace(ignore_environment=1,no_user_site=1)), \
                patch.dict('os.environ',{'PYTHONPATH':str(alien)}):
            original=dict(bootstrap.os.environ)
            self.assertEqual(bootstrap.run_entrypoint(entry,application,argv=[str(output)],root=self.root),0)
            self.assertEqual(dict(bootstrap.os.environ),original)
        self.assertEqual(json.loads(output.read_text()),{'pythonpath':None,'polluted':False})

    def test_direct_entry_help_and_config_only_do_not_initialize_dependencies(self):
        with patch.object(bootstrap, 'ensure_python', side_effect=AssertionError('No setup')), \
                patch.object(bootstrap.subprocess, 'call', side_effect=AssertionError('No application child')):
            for script, arguments in [('launch.py',['--help']),('connect_browser.py',['-h']),('launch.py',['--write-config-only'])]:
                self.assertEqual(bootstrap.run_entrypoint(self.root / script,lambda:23,argv=arguments,root=self.root),23)

    def test_direct_entry_setup_failure_stops_before_application(self):
        with patch.object(bootstrap,'ensure_python',side_effect=bootstrap.BootstrapError('Synthetic dependency failure')), \
                patch.object(bootstrap.subprocess,'call') as launch, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(bootstrap.run_entrypoint(self.root/'launch.py',lambda:self.fail('Application must not start'),argv=[],root=self.root),1)
            launch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
