"""Tests for local open-source SPICE backend (ngspice/Xyce + open PDKs).

Covers offline unit checks (PDK validation/discovery, Spectre->SPICE
transpilation, ASCII rawfile parsing) plus real end-to-end ngspice execution
when ngspice is installed on the host.
"""
import hashlib
import http.client
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

import ic_sim
import local_sim
import open_pdk
import runner
import server
import spice_netlist
import spice_raw
import waveforms
import workspace

REPO = Path(__file__).resolve().parents[2]


def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _wait_terminal(r, rid, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        obs = r.status(rid)
        if obs.get('remote_state') in runner.TERMINAL:
            return obs
        time.sleep(0.1)
    raise AssertionError('Local simulation did not finish before timeout: ' + json.dumps(r.read(rid)))


class OpenPdkTests(unittest.TestCase):
    def test_validate_profiles_and_reject_invalid_corner(self):
        cfg = open_pdk.validate_open_pdk_config({'pdk': 'builtin'})
        self.assertEqual(cfg, {'pdk': 'builtin', 'corner': 'typical'})
        with self.assertRaises(ValueError):
            open_pdk.validate_open_pdk_config({'pdk': 'sky130', 'root': '/opt/pdk/sky130A', 'corner': 'bad_corner'})
        with self.assertRaises(ValueError):
            open_pdk.validate_open_pdk_config({'pdk': 'sky130', 'corner': 'tt'})
        with self.assertRaises(ValueError):
            open_pdk.validate_open_pdk_config({'pdk': 'unknown_pdk', 'root': '/tmp/pdk'})

    def test_synthetic_sky130_gf180_ihp_resolution_and_discovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            sky = base / 'sky130A' / 'libs.tech' / 'ngspice' / 'sky130.lib.spice'
            sky.parent.mkdir(parents=True)
            sky.write_text('* synthetic sky130 lib\n.lib tt\n.endl tt\n')

            gf = base / 'gf180mcuD' / 'libs.tech' / 'ngspice' / 'sm141064.ngspice'
            gf.parent.mkdir(parents=True)
            gf.write_text('* synthetic gf180 lib\n.lib typical\n.endl typical\n')

            ihp = base / 'ihp-sg13g2' / 'libs.tech' / 'ngspice' / 'models' / 'cornerMOSlv.lib'
            ihp.parent.mkdir(parents=True)
            ihp.write_text('* synthetic ihp lib\n.lib mos_tt\n.endl mos_tt\n')

            res_sky = open_pdk.resolve_open_pdk({'pdk': 'sky130', 'root': str(base / 'sky130A'), 'corner': 'tt'}, engine='ngspice')
            self.assertEqual(res_sky['entry_files'][0]['sha256'], _sha256(sky))
            self.assertIn('.option ngbehavior=hsa', res_sky['directives'])
            self.assertIn(f'.lib "{sky.resolve()}" tt', res_sky['directives'])

            res_gf = open_pdk.resolve_open_pdk({'pdk': 'gf180mcu', 'root': str(base / 'gf180mcuD'), 'corner': 'ss'}, engine='ngspice')
            self.assertEqual(res_gf['corner'], 'ss')
            self.assertEqual(res_gf['entry_files'][0]['sha256'], _sha256(gf))

            res_ihp = open_pdk.resolve_open_pdk({'pdk': 'ihp-sg13g2', 'root': str(base / 'ihp-sg13g2'), 'corner': 'mos_ff'}, engine='xyce')
            self.assertEqual(res_ihp['entry_files'][0]['sha256'], _sha256(ihp))
            self.assertNotIn('.option ngbehavior=hsa', res_ihp['directives'])

            found = open_pdk.discover_open_pdks([base])
            self.assertEqual({item['pdk'] for item in found['discovered']}, {'sky130', 'gf180mcu', 'ihp-sg13g2'})

    def test_symlink_escape_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            outside = base / 'secret.lib'
            outside.write_text('* outside\n')
            root = base / 'sky130A'
            entry_dir = root / 'libs.tech' / 'ngspice'
            entry_dir.mkdir(parents=True)
            (entry_dir / 'sky130.lib.spice').symlink_to(outside)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                open_pdk.resolve_open_pdk({'pdk': 'sky130', 'root': str(root), 'corner': 'tt'})


class TranspilerAndRawParserTests(unittest.TestCase):
    def test_spectre_rc_and_mos_transpilation(self):
        rc_text = (REPO / 'projects/rc-smoke/circuit.scs').read_text()
        compiled, entry, manifest = spice_netlist.compile_payload_to_spice(
            {'netlist/input.scs': rc_text.encode()}, 'netlist/input.scs', engine='ngspice'
        )
        self.assertEqual(entry, 'netlist/input.cir')
        deck = compiled[entry].decode()
        self.assertIn('.options filetype=ascii numdgt=12', deck)
        self.assertIn('V0 in 0 PULSE(0 1 1n 10p 10p 5n 10n)', deck)
        self.assertIn('R0 in out 1k', deck)
        self.assertIn('C0 out 0 1p', deck)
        self.assertIn('.tran 50p 12n 0 50p', deck)
        self.assertIn('.save v(in) v(out)', deck)
        self.assertEqual(manifest['analyses'][0]['kind'], 'tran')

    def test_rejects_shell_directives(self):
        with self.assertRaisesRegex(ValueError, 'Forbidden'):
            spice_netlist.transpile_spectre_file('simulator lang=spectre\nshell rm -rf /\n')

    def test_parse_real_and_complex_ascii_rawfiles(self):
        raw_tran = (
            'Title: RC Smoke\n'
            'Date: Tue Nov 24 2026\n'
            'Plotname: Transient Analysis\n'
            'Flags: real\n'
            'No. Variables: 3\n'
            'No. Points: 2\n'
            'Variables:\n'
            '\t0\ttime\ttime\n'
            '\t1\tv(in)\tvoltage\n'
            '\t2\tv(out)\tvoltage\n'
            'Values:\n'
            '0\t0.000000000000000e+00\n'
            '\t0.000000000000000e+00\n'
            '\t0.000000000000000e+00\n'
            '1\t1.000000000000000e-09\n'
            '\t1.000000000000000e+00\n'
            '\t6.321205588285577e-01\n'
        )
        parsed = spice_raw.parse_ascii_rawfile(raw_tran)
        self.assertEqual(len(parsed['plots']), 1)
        self.assertEqual(parsed['plots'][0]['kind'], 'tran')
        self.assertAlmostEqual(parsed['plots'][0]['data'][2][1], 0.6321205588, places=6)

        raw_ac = (
            'Title: AC Bode\n'
            'Plotname: AC Analysis\n'
            'Flags: complex\n'
            'No. Variables: 2\n'
            'No. Points: 2\n'
            'Variables:\n'
            '\t0\tfrequency\tfrequency\n'
            '\t1\tv(out)\tvoltage\n'
            'Values:\n'
            '0\t1.000000000000000e+03,0.000000000000000e+00\n'
            '\t-1.000000000000000e+01,5.000000000000000e-01\n'
            '1\t1.000000000000000e+06,0.000000000000000e+00\n'
            '\t-8.000000000000000e+00,2.000000000000000e+00\n'
        )
        parsed_ac = spice_raw.parse_ascii_rawfile(raw_ac)
        self.assertEqual(parsed_ac['plots'][0]['kind'], 'ac')
        self.assertTrue(parsed_ac['plots'][0]['complex'])
        self.assertEqual(parsed_ac['plots'][0]['data'][1][0], (-10.0, 0.5))


class LocalSiteValidationTests(unittest.TestCase):
    def test_site_load_validates_local_site(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'site.json'
            p.write_text(json.dumps({
                'schema': 'ic.sim.local-site.v1',
                'transport': 'local',
                'engine': 'ngspice',
                'simulator_bin': '/opt/homebrew/bin/ngspice',
                'runs_root': '/tmp/ic_on_github_runs',
                'open_pdk': {'pdk': 'builtin'},
                'external_files': {},
            }))
            site = ic_sim.site_load(p)
            self.assertTrue(ic_sim.is_local_site(site))
            self.assertEqual(site['ssh_target'], 'local')
            self.assertEqual(site['remote_runs_root'], '/tmp/ic_on_github_runs')

            # Reject bad runs_root directory name.
            p.write_text(json.dumps({
                'schema': 'ic.sim.local-site.v1',
                'engine': 'ngspice',
                'simulator_bin': '/opt/homebrew/bin/ngspice',
                'runs_root': '/tmp/not_dedicated',
            }))
            with self.assertRaisesRegex(ValueError, 'ic_on_github_runs'):
                ic_sim.site_load(p)


class RealNgspiceEndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ngspice_bin = local_sim.detect_local_simulator('ngspice')

    def setUp(self):
        if not self.ngspice_bin:
            self.skipTest('ngspice binary is not installed locally')
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.runs_root = self.root / 'ic_on_github_runs'
        self.site_path = self.root / 'site.local.json'
        self.site = local_sim.validate_local_site({
            'schema': 'ic.sim.local-site.v1',
            'transport': 'local',
            'engine': 'ngspice',
            'simulator_bin': self.ngspice_bin,
            'runs_root': str(self.runs_root),
            'open_pdk': {'pdk': 'builtin'},
            'external_files': {},
        })
        runner.atomic(self.site_path, self.site)

        # Create a self-contained Git seed repo containing rc-smoke and open-cmos-inverter.
        self.seed = self.root / 'seed'
        self.seed.mkdir()
        subprocess.run(['git', 'init', '-b', 'main', str(self.seed)], capture_output=True, check=True)
        workspace.git(self.seed, 'config', 'user.name', 'Test')
        workspace.git(self.seed, 'config', 'user.email', 'test@localhost')
        shutil.copytree(REPO / 'projects/rc-smoke', self.seed / 'projects/rc-smoke')
        shutil.copytree(REPO / 'projects/open-cmos-inverter', self.seed / 'projects/open-cmos-inverter')
        workspace.git(self.seed, 'add', '.')
        workspace.git(self.seed, 'commit', '-m', 'seed open-source projects')

        catalog = [
            p for p in json.loads((REPO / 'config/workbench.projects.json').read_text())
            if p['id'] in ('rc-smoke', 'open-cmos-inverter')
        ]
        self.cfg = {
            'local_only': True,
            'seed_repo': str(self.seed),
            'runtime_root': str(self.root / 'runtime'),
            'site_file': str(self.site_path),
            'base_branch': 'main',
            'runtime_branch': 'codex/ngspice-test',
            'projects': catalog,
        }
        web = self.root / 'web'
        web.mkdir()
        (web / 'index.html').write_text('<p>open-sim</p>')
        self.app = server.Application(self.cfg, web)
        self.http = server.Server(('127.0.0.1', 0), server.Handler)
        self.http.app = self.app
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.http.server_port}'

    def tearDown(self):
        if hasattr(self, 'http'):
            self.http.shutdown()
            self.http.server_close()
            self.app.pool.shutdown(wait=True)
        if hasattr(self, 'tmp'):
            self.tmp.cleanup()

    def _request(self, path, method='GET', data=None):
        headers = {'Origin': self.origin, 'X-Workbench-Token': self.app.token, 'Content-Type': 'application/json'}
        conn = http.client.HTTPConnection('127.0.0.1', self.http.server_port)
        conn.request(method, path, body=json.dumps(data) if data is not None else None, headers=headers)
        resp = conn.getresponse()
        body = json.loads(resp.read())
        status = resp.status
        conn.close()
        return status, body

    def test_real_ngspice_rc_step_matches_analytical_response(self):
        status, health = self._request('/api/health')
        self.assertEqual(status, 200)
        backend = health['data']['capabilities']['simulation_backend']
        self.assertEqual(backend['transport'], 'local')
        self.assertEqual(backend['engine'], 'ngspice')
        self.assertFalse(backend['license_required'])

        head = self.app.workspace.head()
        status, pre = self._request('/api/preflight', 'POST', {
            'project_id': 'rc-smoke', 'configuration': 'TRAN_NGSPICE', 'source_commit': head,
        })
        self.assertEqual(status, 200, pre)
        self.assertEqual(pre['data']['probe']['engine'], 'ngspice')
        self.assertEqual(pre['data']['probe']['license_checkout'], 'not_required')

        status, job = self._request('/api/jobs', 'POST', {
            'project_id': 'rc-smoke', 'configuration': 'TRAN_NGSPICE',
            'source_commit': head, 'idempotency_key': 'ngspice-rc-e2e-001',
        })
        self.assertEqual(status, 202, job)
        rid = job['data']['run_id']
        obs = _wait_terminal(self.app.runner, rid)
        self.assertEqual(obs['remote_state'], 'simulator_complete_pending_measurements', obs)
        self.assertEqual(obs['simulator_exit_code'], 0)

        collected = self.app.collect_with_postprocess(rid)
        self.assertEqual(collected['collection_phase'], 'complete')
        self.assertEqual(collected['postprocess_phase'], 'complete')

        # Read through WaveformService & HTTP API and check physical RC accuracy (tau = 1 ns).
        status, cat = self._request(f'/api/jobs/{rid}/signals')
        self.assertEqual(status, 200, cat)
        self.assertEqual(cat['data']['data_basis'], 'local_SPICE_RAW_derivation')
        out_sig = next(s for s in cat['data']['signals'] if s['psf_name'] == 'out')
        status, wf = self._request(f'/api/jobs/{rid}/waveform?signal_id={out_sig["id"]}')
        self.assertEqual(status, 200, wf)
        points = wf['data']['points']
        self.assertGreater(len(points), 50)
        # At t = 2.0 ns (1 ns after step at 1.0 ns, with 10 ps rise), V(out) ≈ 1 - e^-1 ≈ 0.6321 V.
        nearest = min(points, key=lambda pt: abs(pt[0] - 2.0e-9))
        expected = 1.0 - math.exp(-(nearest[0] - 1.005e-9) / 1.0e-9)
        self.assertLess(abs(nearest[1] - expected), 0.015, f'RC response error too large: got {nearest}, expected {expected}')

        # Tampering with derived CSV must fail closed with hash_mismatch.
        csv_path = self.app.runner.path(rid) / 'waveforms.csv'
        csv_path.write_text(csv_path.read_text() + '\n')
        status, tampered = self._request(f'/api/jobs/{rid}/signals')
        self.assertEqual(status, 409)
        self.assertEqual(tampered['error']['code'], 'hash_mismatch')

    def test_web_api_simulation_backend_inspect_and_configure(self):
        status, info = self._request('/api/simulation/backend')
        self.assertEqual(status, 200, info)
        self.assertEqual(info['data']['current']['transport'], 'local')
        self.assertEqual(info['data']['current']['engine'], 'ngspice')
        self.assertTrue(info['data']['can_configure_local'])
        self.assertIn('sky130', info['data']['open_pdk_profiles'])
        self.assertIn('gf180mcu', info['data']['open_pdk_profiles'])
        self.assertIn('ihp-sg13g2', info['data']['open_pdk_profiles'])

        # Configure local ngspice with a synthetic SKY130 PDK directly via Web API (zero CLI).
        sky = self.root / 'pdk' / 'sky130A' / 'libs.tech' / 'ngspice' / 'sky130.lib.spice'
        sky.parent.mkdir(parents=True)
        sky.write_text('* synthetic sky130\n.lib tt\n.endl tt\n')
        status, updated = self._request('/api/simulation/backend', 'POST', {
            'mode': 'local',
            'engine': 'ngspice',
            'open_pdk': {'pdk': 'sky130', 'root': str(self.root / 'pdk' / 'sky130A'), 'corner': 'tt'},
        })
        self.assertEqual(status, 200, updated)
        self.assertTrue(updated['data']['persisted'])
        self.assertEqual(updated['data']['backend']['open_pdk']['pdk'], 'sky130')
        self.assertEqual(updated['data']['probe']['open_pdk']['entry_sha256'], [_sha256(sky)])

        # Unknown fields or invalid mode must fail closed.
        status, bad = self._request('/api/simulation/backend', 'POST', {'mode': 'local', 'engine': 'ngspice', 'ssh_target': 'evil'})
        self.assertEqual(status, 400)

        # Switch cleanly back to builtin so subsequent runs work without SKY130 devices.
        status, reset = self._request('/api/simulation/backend', 'POST', {
            'mode': 'local', 'engine': 'ngspice', 'open_pdk': {'pdk': 'builtin', 'corner': 'typical'},
        })
        self.assertEqual(status, 200, reset)
        self.assertEqual(reset['data']['backend']['open_pdk']['pdk'], 'builtin')

    def test_real_ngspice_cmos_inverter_tran_dc_ac(self):
        head = self.app.workspace.head()

        # 1. Transient switching check.
        bundle_t = self.app.workspace.materialize('open-cmos-inverter', 'TRAN_NGSPICE', head)
        rec_t, _ = self.app.runner.reserve(bundle_t, 'ngspice-inv-tran-001', head, 'open-cmos-inverter', 'TRAN_NGSPICE')
        self.app.runner.dispatch(rec_t['run_id'])
        obs_t = _wait_terminal(self.app.runner, rec_t['run_id'])
        self.assertEqual(obs_t['remote_state'], 'simulator_complete_pending_measurements', obs_t)
        self.app.collect_with_postprocess(rec_t['run_id'])
        cat_t = self.app.waveforms.catalog(rec_t['run_id'])
        out_t = next(s for s in cat_t['signals'] if s['psf_name'] == 'out')
        wf_t = self.app.waveforms.waveform(rec_t['run_id'], out_t['id'])
        ys = [pt[1] for pt in wf_t['points']]
        self.assertGreater(max(ys), 1.7)
        self.assertLess(min(ys), 0.1)

        # 2. DC transfer curve (VTC) native dataset check.
        bundle_d = self.app.workspace.materialize('open-cmos-inverter', 'DC_NGSPICE', head)
        rec_d, _ = self.app.runner.reserve(bundle_d, 'ngspice-inv-dc-001', head, 'open-cmos-inverter', 'DC_NGSPICE')
        self.app.runner.dispatch(rec_d['run_id'])
        obs_d = _wait_terminal(self.app.runner, rec_d['run_id'])
        self.assertEqual(obs_d['remote_state'], 'simulator_complete_pending_measurements', obs_d)
        self.app.collect_with_postprocess(rec_d['run_id'])
        cat_d = self.app.waveforms.catalog(rec_d['run_id'])
        self.assertEqual(len(cat_d['datasets']), 1)
        ds_dc = cat_d['datasets'][0]
        self.assertEqual(ds_dc['analysis']['kind'], 'dc')
        dc_detail = self.app.waveforms.catalog(rec_d['run_id'], dataset_id=ds_dc['dataset_id'])
        out_dc = next(s for s in dc_detail['signals'] if s['psf_name'] == 'out')
        wf_dc = self.app.waveforms.waveform(rec_d['run_id'], out_dc['id'], dataset_id=ds_dc['dataset_id'])
        self.assertGreater(wf_dc['points'][0][1], 1.75)
        self.assertLess(wf_dc['points'][-1][1], 0.05)

        # 3. AC small-signal Bode native complex dataset check.
        bundle_a = self.app.workspace.materialize('open-cmos-inverter', 'AC_NGSPICE', head)
        rec_a, _ = self.app.runner.reserve(bundle_a, 'ngspice-inv-ac-001', head, 'open-cmos-inverter', 'AC_NGSPICE')
        self.app.runner.dispatch(rec_a['run_id'])
        obs_a = _wait_terminal(self.app.runner, rec_a['run_id'])
        self.assertEqual(obs_a['remote_state'], 'simulator_complete_pending_measurements', obs_a)
        self.app.collect_with_postprocess(rec_a['run_id'])
        cat_a = self.app.waveforms.catalog(rec_a['run_id'])
        self.assertEqual(len(cat_a['datasets']), 1)
        ds_ac = cat_a['datasets'][0]
        self.assertEqual(ds_ac['analysis']['kind'], 'ac')
        ac_detail = self.app.waveforms.catalog(rec_a['run_id'], dataset_id=ds_ac['dataset_id'])
        out_ac = next(s for s in ac_detail['signals'] if s['psf_name'] == 'out')
        self.assertEqual(out_ac['value_kind'], 'complex')
        wf_ac = self.app.waveforms.waveform(rec_a['run_id'], out_ac['id'], dataset_id=ds_ac['dataset_id'])
        # Low-frequency small-signal gain magnitude |V(out)/V(in)| > 5 (inverting gain > 14 dB).
        low_f = wf_ac['complex_points'][0]
        gain_mag = math.hypot(low_f[1], low_f[2])
        self.assertGreater(gain_mag, 5.0, f'Expected inverting gain > 5, got {gain_mag}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
