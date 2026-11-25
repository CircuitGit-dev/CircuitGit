"""Cross-platform compatibility tests for macOS, Linux, and native Windows."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/workbench'))
sys.path.insert(0, str(REPO / 'tools/dev'))
sys.path.insert(0, str(REPO / 'apps/codex'))
sys.path.insert(0, str(REPO / 'modules/gateway_client'))

import check_structure
import local_sim
import open_pdk
import platform_compat
from icwb.images import SessionImages
from icwb.mcp import TIMED_OUT, _Lines


class CrossPlatformCompatTests(unittest.TestCase):
    def test_structure_cross_platform_guard_and_launchers(self):
        checked = check_structure.check_cross_platform()
        self.assertGreater(checked, 20)
        bat = (REPO / 'Start CircuitGit.bat').read_text(encoding='utf-8')
        self.assertIn('bootstrap_python.py', bat)
        self.assertIn('.venv\\Scripts\\python.exe', bat)

    def test_safe_local_abs_paths_accept_posix_and_windows(self):
        for good in (
            '/opt/homebrew/bin/ngspice',
            '/Users/alice/My Projects/sky130A',
            'C:\\Program Files\\ngspice\\bin\\ngspice_con.exe',
            'C:\\Program Files (x86)\\ngspice\\bin\\ngspice_con.exe',
            'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ic_on_github_runs',
            'C:/Users/alice/pdk/sky130A',
            'D:\\work\\ic_on_github_runs',
        ):
            self.assertTrue(platform_compat.is_safe_local_abs_path(good), good)
        for bad in (
            'relative/path',
            '/tmp/../etc/passwd',
            'C:\\pdk\\..\\secret',
            'C:\\pdk\\sky130A;whoami',
            'C:\\pdk\\sky130A`id`',
            '/tmp/bad$(id)',
            '',
            None,
        ):
            self.assertFalse(platform_compat.is_safe_local_abs_path(bad), str(bad))

    def test_windows_site_and_open_pdk_validation(self):
        site = local_sim.validate_local_site({
            'schema': 'ic.sim.local-site.v1',
            'transport': 'local',
            'engine': 'ngspice',
            'simulator_bin': 'C:\\Program Files\\ngspice\\bin\\ngspice_con.exe',
            'runs_root': 'C:\\Users\\alice\\circuitgit\\ic_on_github_runs',
            'open_pdk': {'pdk': 'sky130', 'root': 'C:\\pdk\\sky130A', 'corner': 'tt'},
            'external_files': {},
        })
        self.assertEqual(site['engine'], 'ngspice')
        self.assertEqual(site['open_pdk']['root'], 'C:\\pdk\\sky130A')
        self.assertEqual(platform_compat.path_basename(site['runs_root']), 'ic_on_github_runs')

        cfg = open_pdk.validate_open_pdk_config({'pdk': 'gf180mcu', 'root': 'D:/pdks/gf180mcuD', 'corner': 'typical'})
        self.assertEqual(cfg['root'], 'D:/pdks/gf180mcuD')

    def test_venv_and_git_credential_helpers(self):
        root = Path('/tmp/fake-env')
        self.assertTrue(platform_compat.venv_python_path(root, windows=False).as_posix().endswith('bin/python'))
        self.assertTrue(platform_compat.venv_python_path(root, windows=True).as_posix().endswith('Scripts/python.exe'))
        helper = platform_compat.git_credential_helper('C:\\Program Files\\GitHub CLI\\gh.exe', windows=True)
        self.assertNotIn('\\', helper)
        self.assertIn('C:/Program Files/GitHub CLI/gh.exe', helper)
        self.assertTrue(helper.startswith('!'))

    def test_file_lock_nonblocking_contends_across_processes(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / 'helper.lock'
            with platform_compat.file_lock(lock_path, nonblocking=True):
                probe = subprocess.run(
                    [
                        sys.executable,
                        '-B',
                        '-c',
                        (
                            'import sys; sys.path.insert(0, sys.argv[1]); '
                            'import platform_compat; '
                            'f = open(sys.argv[2], "a+b"); '
                            'platform_compat.lock_file(f, nonblocking=True)'
                        ),
                        str(REPO / 'tools/workbench'),
                        str(lock_path),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                self.assertNotEqual(probe.returncode, 0)
                self.assertIn('BlockingIOError', probe.stderr)

    def test_threaded_bounded_pipes_matches_windows_behavior(self):
        proc = subprocess.Popen(
            [sys.executable, '-B', '-c', 'import sys; sys.stdout.write("hello world"); sys.stdout.flush()'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            out = platform_compat.read_bounded_pipes(
                proc,
                time.monotonic() + 5.0,
                stdout_limit=1024,
                stderr_limit=1024,
                on_timeout=lambda: TimeoutError('timeout'),
                on_limit=lambda: ValueError('limit'),
                use_threads=True,
            )
            proc.wait(timeout=5)
            self.assertEqual(out, b'hello world')
        finally:
            proc.stdout.close()
            proc.stderr.close()

        big = subprocess.Popen(
            [sys.executable, '-B', '-c', 'import sys; sys.stdout.buffer.write(b"x" * 2048); sys.stdout.buffer.flush()'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            with self.assertRaises(ValueError):
                platform_compat.read_bounded_pipes(
                    big,
                    time.monotonic() + 5.0,
                    stdout_limit=64,
                    stderr_limit=1024,
                    on_timeout=lambda: TimeoutError('timeout'),
                    on_limit=lambda: ValueError('limit'),
                    use_threads=True,
                )
            big.wait(timeout=5)
        finally:
            big.stdout.close()
            big.stderr.close()

    def test_mcp_threaded_line_reader_supports_timeout_and_lines(self):
        r_fd, w_fd = os.pipe()
        reader_stream = os.fdopen(r_fd, 'rb', buffering=0)
        try:
            lines = _Lines(reader_stream, use_threads=True)
            self.assertIs(lines.readline(timeout=0.05), TIMED_OUT)

            def writer():
                time.sleep(0.02)
                os.write(w_fd, b'{"id":1}\n{"id":2}\n')
                os.close(w_fd)

            t = threading.Thread(target=writer, daemon=True)
            t.start()
            self.assertEqual(lines.readline(timeout=2.0), b'{"id":1}\n')
            self.assertEqual(lines.readline(timeout=2.0), b'{"id":2}\n')
            self.assertEqual(lines.readline(timeout=2.0), b'')
            t.join(timeout=2.0)
        finally:
            reader_stream.close()

    def test_session_images_windows_fallback_without_dir_fd(self):
        png_bytes = b'\x89PNG\r\n\x1a\n' + b'\x00' * 32
        img_id = hashlib.sha256(png_bytes).hexdigest()
        desc = {
            'image_id': img_id,
            'name': 'probe.png',
            'mime_type': 'image/png',
            'bytes': len(png_bytes),
            'width': 16,
            'height': 16,
        }
        with tempfile.TemporaryDirectory() as tmp:
            store = SessionImages(tmp)
            with patch.object(SessionImages, '_supports_dir_fd', return_value=False):
                stored = store.store([(desc, png_bytes)])
                self.assertEqual(len(stored), 1)
                fetched = store.get(img_id, [{'role': 'user', 'images': [desc]}], 'sess-1')
                self.assertTrue(fetched['data_url'].startswith('data:image/png;base64,'))

    def test_local_sim_python_supervisor_runs_without_bin_sh(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / 'run-001'
            (run_dir / 'netlist').mkdir(parents=True)
            (run_dir / 'netlist' / 'input.cir').write_text('* mock netlist\n', encoding='utf-8')
            fake_sim = Path(tmp) / 'fake_sim.py'
            fake_sim.write_text(
                'from pathlib import Path\n'
                'Path("../raw/results.raw").write_text("Title: mock\\n", encoding="utf-8")\n',
                encoding='utf-8',
            )
            (run_dir / 'job.json').write_text(
                json.dumps({
                    'schema': 'ic.sim.local-job.v1',
                    'engine': 'ngspice',
                    'simulator_bin': sys.executable,
                    'entry_name': 'input.cir',
                    'sim_args': [str(fake_sim)],
                    'log_file': 'raw/ngspice.out',
                }),
                encoding='utf-8',
            )
            # Verify supervise_local_run creates raw/, executes binary, writes exit_code & state atomically.
            # Note: ngspice command puts -b before sim_args; invoke directly with a tiny wrapper script via python -c
            (run_dir / 'job.json').write_text(
                json.dumps({
                    'schema': 'ic.sim.local-job.v1',
                    'engine': 'xyce',
                    'simulator_bin': sys.executable,
                    'entry_name': 'input.cir',
                    'sim_args': ['-c', 'from pathlib import Path; Path("../raw/results.raw").write_text("ok")'],
                    'log_file': 'raw/xyce.log',
                }),
                encoding='utf-8',
            )
            rc = local_sim.supervise_local_run(run_dir)
            self.assertEqual(rc, 0)
            self.assertEqual((run_dir / 'state').read_text().strip(), 'simulator_complete_pending_measurements')
            self.assertEqual((run_dir / 'exit_code').read_text().strip(), '0')
            self.assertEqual((run_dir / 'raw' / 'results.raw').read_text(), 'ok')


if __name__ == '__main__':
    unittest.main(verbosity=2)
