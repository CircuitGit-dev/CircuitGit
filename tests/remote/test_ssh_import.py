"""Unit tests for bounded read-only SSH remote netlist browse & import."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/workbench'))

import onboarding_ssh_import as ssh_import


def _local_shell_runner(argv, *, input, capture_output, timeout):
    """Execute the generated /bin/sh -s script locally to test the remote Python payload safely."""
    assert argv[-1] == '/bin/sh -s'
    assert '-o' in argv and 'BatchMode=yes' in argv
    return subprocess.run(
        ['/bin/sh', '-s'],
        input=input,
        capture_output=capture_output,
        timeout=timeout,
    )


class SshImportValidationTests(unittest.TestCase):
    def test_validate_ssh_target_rejects_options_and_metachars(self):
        for ok in ('eda-server', 'alice@10.0.0.12', 'sim_host.internal', 'user@box:22'):
            self.assertEqual(ssh_import.validate_ssh_target(ok), ok)
        for bad in ('', ' ', '-oProxyCommand=id', 'host;id', 'host name', 'host\nid', 'a' * 241, None):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ssh_import.validate_ssh_target(bad)

    def test_validate_remote_path_rejects_traversal_and_sensitive_paths(self):
        self.assertEqual(ssh_import.validate_remote_path('', allow_empty=True), '')
        self.assertEqual(ssh_import.validate_remote_path('~', allow_empty=True), '~')
        self.assertEqual(ssh_import.validate_remote_path('~/designs/adc'), '~/designs/adc')
        self.assertEqual(ssh_import.validate_remote_path('/home/user/tb.scs', require_circuit_ext=True), '/home/user/tb.scs')
        for bad in (
            'relative/tb.scs',
            '/home/user/../etc/passwd',
            '/home/user/.ssh/id_rsa',
            '/home/user/.env',
            '/home/user/my_secret.scs',
            '/home/user/server.key',
            '/home/user/license.lic',
            '/home/user/tb.scs\nrm -rf /',
        ):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ssh_import.validate_remote_path(bad, require_circuit_ext=False)
        with self.assertRaises(ValueError):
            ssh_import.validate_remote_path('/home/user/photo.png', require_circuit_ext=True)


def _framed_reply(argv, *, input, capture_output, timeout, payload_obj):
    """Build a valid framed SSH stdout reply matching the nonce in the generated shell script."""
    import json
    import re
    text = input.decode('utf-8')
    m_begin = re.search(r"'(IC_SSH_IMPORT_[0-9a-f]+_BEGIN)'", text)
    m_end = re.search(r"'(IC_SSH_IMPORT_[0-9a-f]+_END)'", text)
    assert m_begin and m_end
    out = f"\n{m_begin.group(1)}\n{json.dumps(payload_obj)}\n{m_end.group(1)}\n".encode('utf-8')
    return subprocess.CompletedProcess(argv, 0, stdout=out, stderr=b'')


class SshImportCrossPlatformTests(unittest.TestCase):
    """Runs on Linux, macOS, and native Windows without requiring /bin/sh."""

    def test_browse_and_import_protocol_and_runtime_routing(self):
        import onboarding_runtime
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            cfg_file = root / 'ssh_config'
            cfg_file.write_text('Host eda-box\n  HostName 127.0.0.1\n')
            seen_argvs = []

            def fake_runner(argv, *, input, capture_output, timeout):
                seen_argvs.append(argv)
                if len(seen_argvs) == 1:
                    return _framed_reply(argv, input=input, capture_output=capture_output, timeout=timeout, payload_obj={
                        'ok': True,
                        'cwd': '/home/alice/adc',
                        'parent': '/home/alice',
                        'entries': [
                            {'name': 'sub', 'path': '/home/alice/adc/sub', 'kind': 'dir', 'size': None},
                            {'name': 'tb_sar.scs', 'path': '/home/alice/adc/tb_sar.scs', 'kind': 'file', 'size': 128},
                        ],
                        'total': 2,
                        'truncated': False,
                    })
                return _framed_reply(argv, input=input, capture_output=capture_output, timeout=timeout, payload_obj={
                    'ok': True,
                    'remote_path': '/home/alice/adc/tb_sar.scs',
                    'remote_dir': '/home/alice/adc',
                    'file_name': 'tb_sar.scs',
                    'text': 'simulator lang=spectre\ninclude "sub/comp.scs"\n',
                    'support_files': {'sub/comp.scs': 'subckt COMP a b\nends COMP\n'},
                    'skipped': [],
                })

            cfg = onboarding_runtime.create_onboarding_config(root / 'ob-store')
            cfg['onboarding']['ssh_config'] = str(cfg_file)
            runtime = onboarding_runtime.OnboardingRuntime(SimpleNamespace(cfg=cfg))
            with patch.object(ssh_import.subprocess, 'run', side_effect=fake_runner):
                browsed = runtime.write('ssh-browse', {'ssh_target': 'eda-box', 'path': '~/adc'}, origin='interactive_client')
                self.assertEqual(browsed['schema'], ssh_import.BROWSE_SCHEMA)
                self.assertEqual(browsed['cwd'], '/home/alice/adc')
                self.assertEqual(len(browsed['entries']), 2)
                imported = runtime.write('ssh-import', {'ssh_target': 'eda-box', 'path': '/home/alice/adc/tb_sar.scs'}, origin='interactive_client')
                self.assertEqual(imported['schema'], ssh_import.IMPORT_SCHEMA)
                self.assertEqual(imported['file_name'], 'tb_sar.scs')
                self.assertIn('sub/comp.scs', imported['support_files'])
            self.assertIn('-F', seen_argvs[0])
            self.assertEqual(seen_argvs[0][seen_argvs[0].index('-F') + 1], str(cfg_file))


@unittest.skipIf(os.name == 'nt', 'Remote EDA host execution fixture uses POSIX paths and /bin/sh')
class SshImportExecutionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.proj = self.root / 'sar_adc'
        (self.proj / 'sub').mkdir(parents=True)
        (self.proj / '.ssh').mkdir()
        (self.proj / '.ssh' / 'id_rsa').write_text('PRIVATE KEY')
        (self.proj / '.env').write_text('API_KEY=nope')
        (self.proj / 'my_secret.scs').write_text('// secret')
        (self.proj / 'notes.txt').write_text('readme')
        (self.proj / 'diagram.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        (self.root / 'outside.scs').write_text('// outside project dir\n')
        (self.proj / 'sub' / 'comp.scs').write_text(
            'subckt COMP inp inn out\nR0 (inp out) resistor r=1k\nends COMP\n'
        )
        (self.proj / 'tb_sar.scs').write_text(
            'simulator lang=spectre\n'
            'include "sub/comp.scs"\n'
            'include "../outside.scs"\n'
            'include "/opt/pdk/models.scs"\n'
            'include "my_secret.scs"\n'
            'X0 (in gnd out) COMP\n'
        )

    def test_browse_lists_dirs_and_circuit_files_excluding_sensitive(self):
        res = ssh_import.browse_remote_netlists(
            'eda-box',
            None,
            str(self.proj),
            runner=_local_shell_runner,
        )
        self.assertEqual(res['schema'], ssh_import.BROWSE_SCHEMA)
        self.assertEqual(res['ssh_target'], 'eda-box')
        self.assertEqual(Path(res['cwd']).resolve(), self.proj)
        self.assertEqual(Path(res['parent']).resolve(), self.root)
        names = [(e['kind'], e['name']) for e in res['entries']]
        self.assertEqual(names, [('dir', 'sub'), ('file', 'tb_sar.scs'), ('file', 'notes.txt')])

    def test_import_fetches_entry_and_bounded_relative_includes_only(self):
        res = ssh_import.fetch_remote_netlist(
            'eda-box',
            None,
            str(self.proj / 'tb_sar.scs'),
            include_dependencies=True,
            runner=_local_shell_runner,
        )
        self.assertEqual(res['schema'], ssh_import.IMPORT_SCHEMA)
        self.assertEqual(res['file_name'], 'tb_sar.scs')
        self.assertIn('X0 (in gnd out) COMP', res['text'])
        self.assertEqual(list(res['support_files'].keys()), ['sub/comp.scs'])
        self.assertIn('subckt COMP', res['support_files']['sub/comp.scs'])
        skipped_reasons = {row['ref']: row['reason'] for row in res['skipped']}
        self.assertEqual(skipped_reasons.get('../outside.scs'), 'outside_project_dir')
        self.assertEqual(skipped_reasons.get('my_secret.scs'), 'sensitive_path')
        self.assertNotIn('/opt/pdk/models.scs', res['support_files'])

    def test_import_without_dependencies_skips_support_files(self):
        res = ssh_import.fetch_remote_netlist(
            'eda-box',
            None,
            str(self.proj / 'tb_sar.scs'),
            include_dependencies=False,
            runner=_local_shell_runner,
        )
        self.assertEqual(res['support_files'], {})

    def test_ssh_config_is_passed_via_dash_F_when_present(self):
        cfg = self.root / 'ssh_config'
        cfg.write_text('Host eda-box\n  HostName 127.0.0.1\n')
        seen = {}
        def fake_runner(argv, **kwargs):
            seen['argv'] = argv
            return _local_shell_runner(argv, **kwargs)
        ssh_import.browse_remote_netlists('eda-box', str(cfg), str(self.proj), runner=fake_runner)
        self.assertIn('-F', seen['argv'])
        self.assertEqual(seen['argv'][seen['argv'].index('-F') + 1], str(cfg))

    def test_onboarding_runtime_routes_ssh_browse_and_import_without_intake_id(self):
        import onboarding_runtime
        from types import SimpleNamespace
        cfg = onboarding_runtime.create_onboarding_config(self.root / 'ob-store')
        runtime = onboarding_runtime.OnboardingRuntime(SimpleNamespace(cfg=cfg))
        real_run = subprocess.run
        def local_runner(argv, *, input, capture_output, timeout):
            return real_run(['/bin/sh', '-s'], input=input, capture_output=capture_output, timeout=timeout)
        with patch.object(ssh_import.subprocess, 'run', side_effect=local_runner):
            browsed = runtime.write('ssh-browse', {'ssh_target': 'eda-box', 'path': str(self.proj)}, origin='interactive_client')
            self.assertEqual(browsed['schema'], ssh_import.BROWSE_SCHEMA)
            imported = runtime.write('ssh-import', {'ssh_target': 'eda-box', 'path': str(self.proj / 'tb_sar.scs')}, origin='interactive_client')
            self.assertEqual(imported['schema'], ssh_import.IMPORT_SCHEMA)
            self.assertEqual(imported['file_name'], 'tb_sar.scs')
            self.assertIn('sub/comp.scs', imported['support_files'])


if __name__ == '__main__':
    unittest.main()
