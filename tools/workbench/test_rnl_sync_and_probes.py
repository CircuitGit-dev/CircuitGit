"""Tests for Step 3: incremental netlist <-> RNL sync and live waveform probe bindings."""
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/workbench'))

import local_sim
import rnl_sync
import server
import waveforms


def _git(cwd, *args):
    subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True)


class IncrementalRnlSyncTests(unittest.TestCase):
    def test_preserves_existing_placements_and_wires_while_placing_new_devices(self):
        before = (
            'simulator lang=spectre\n'
            'global 0\n'
            'V0 (in 0) vsource type=pulse val0=0 val1=1.2\n'
            'R0 (in out) resistor r=1k\n'
            'C0 (out 0) capacitor c=1p\n'
            '// @RNL(author="engineer") {\n'
            '//   #"V0" @PLACE(0, 0) => @ORIENT("R0");\n'
            '//   #"R0" @PLACE(20, 0) => @ORIENT("R0");\n'
            '//   #"C0" @PLACE(40, -10) => @ORIENT("R0");\n'
            '//   &"in" @WIRE(#"V0":1, #"R0":1);\n'
            '//   &"out" @WIRE(#"R0":2, #"C0":1);\n'
            '// }\n'
        )
        # Edit resistor value, add R1 + C1, and remove C0.
        after = (
            'simulator lang=spectre\n'
            'global 0\n'
            'V0 (in 0) vsource type=pulse val0=0 val1=1.2\n'
            'R0 (in out) resistor r=2k\n'
            'R1 (out mid) resistor r=500\n'
            'C1 (mid 0) capacitor c=2p\n'
        )
        merged = rnl_sync.merge_incremental_rnl(after, reference_rnl=before, viewer_source_path='circuit.scs', source_path='projects/rc/circuit.scs')
        sync = merged['layout_sync']
        self.assertEqual(sync['preserved_instances'], ['V0', 'R0'])
        self.assertEqual(sync['added_instances'], ['R1', 'C1'])
        self.assertEqual(sync['removed_instances'], ['C0'])
        self.assertEqual(sync['preserved_wires'], 1)   # "in" wire kept
        self.assertEqual(sync['dropped_wires'], 1)     # "out" wire referencing removed C0 dropped
        self.assertAlmostEqual(sync['preserved_ratio'], 0.5)

        # Preserved placements keep exact prior coordinates; new devices placed outside preserved max X (40 + 18 = 58).
        rnl = merged['rnl_text']
        self.assertIn('#"V0" @PLACE(0, 0) => @ORIENT("R0");', rnl)
        self.assertIn('#"R0" @PLACE(20, 0) => @ORIENT("R0");', rnl)
        self.assertIn('#"R1" @PLACE(58,', rnl)
        self.assertIn('#"C1" @PLACE(76,', rnl)
        self.assertNotIn('#"C0"', rnl)

        # Canonical source map points to exact line numbers of the edited netlist.
        inst_map = {o['name']: o for o in merged['objects'] if o['kind'] == 'instance'}
        self.assertEqual(inst_map['R0']['line_start'], 4)
        self.assertEqual(inst_map['R1']['line_start'], 5)
        self.assertEqual(inst_map['C1']['line_start'], 6)

    def test_live_bundle_manifest_is_deterministic_and_origin_independent(self):
        src = (ROOT / 'projects/open-cmos-inverter/circuit.scs').read_text(encoding='utf-8')
        sha = rnl_sync.sha256_bytes(src)
        b1 = rnl_sync.build_live_schematic_bundle('open-cmos-inverter', 'projects/open-cmos-inverter/circuit.scs', src, sha, 'http://127.0.0.1:8766')
        b2 = rnl_sync.build_live_schematic_bundle('open-cmos-inverter', 'projects/open-cmos-inverter/circuit.scs', src, sha, 'http://127.0.0.1:59999')
        self.assertEqual(b1['manifest_sha256'], b2['manifest_sha256'])
        self.assertEqual(b1['bundle_sha256'], b2['bundle_sha256'])
        manifest = json.loads(b1['manifest_bytes'])
        self.assertEqual(manifest['format'], 1)
        self.assertEqual(manifest['settings']['autoInclude'], False)
        self.assertEqual(manifest['files'][0]['size'], len(b1['rnl_bytes']))
        self.assertEqual(manifest['files'][0]['sha256'], b1['bundle_sha256'])
        self.assertFalse(b1['payload']['native_ready'])
        self.assertTrue(b1['payload']['live_ready'])
        self.assertEqual(b1['payload']['geometry']['mode'], 'live-rnl')


class LiveSchematicAndProbeHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ic-step3-live-')
        self.base = Path(self.tmp.name).resolve()
        self.seed = self.base / 'seed'
        self.seed.mkdir()
        _git(self.seed, 'init', '-b', 'main')
        _git(self.seed, 'config', 'user.name', 'Test Engineer')
        _git(self.seed, 'config', 'user.email', 'test@circuitgit.invalid')

        for rel in ('projects/rc-smoke', 'projects/open-cmos-inverter'):
            shutil.copytree(ROOT / rel, self.seed / rel)
        _git(self.seed, 'add', '.')
        _git(self.seed, 'commit', '-m', 'Initial open circuits')

        ngspice = local_sim.detect_local_simulator('ngspice')
        self.has_ngspice = bool(ngspice)
        site_path = self.base / 'local-site.json'
        if ngspice:
            site = local_sim.validate_local_site({
                'schema': 'ic.sim.local-site.v1',
                'transport': 'local',
                'engine': 'ngspice',
                'simulator_bin': ngspice,
                'runs_root': str(self.base / 'ic_on_github_runs'),
                'open_pdk': {'pdk': 'builtin', 'corner': 'typical'},
                'external_files': {},
            })
        else:
            site = {
                'schema': 'ic.sim.site.v1',
                'ssh_target': 'unused',
                'remote_runs_root': '/unused/ic_on_github_runs',
                'cadence_cshrc': '/unused/setup',
                'spectre_bin': '/unused/spectre',
                'external_files': {},
            }
        site_path.write_bytes((json.dumps(site, indent=2) + '\n').encode('utf-8'))

        web_dir = self.base / 'web'
        web_dir.mkdir()
        (web_dir / 'index.html').write_text('ok', encoding='utf-8')
        cfg = {
            'github_repo': 'fixture/open-circuits',
            'seed_repo': str(self.seed),
            'runtime_root': str(self.base / 'runtime'),
            'site_file': str(site_path),
            'base_branch': 'main',
            'runtime_branch': 'codex/step3-test',
            'projects': [
                {
                    'id': 'rc-smoke',
                    'name': 'RC Smoke',
                    'source_path': 'projects/rc-smoke/circuit.scs',
                    'configurations': [
                        {
                            'id': 'TRAN_NGSPICE',
                            'configuration_path': 'projects/rc-smoke/configurations/TRAN_NGSPICE.json',
                            'bundle_template': 'projects/rc-smoke/template/bundle.json',
                            'source_replacements': [{'source': 'projects/rc-smoke/circuit.scs', 'destination': 'netlist/input.scs'}],
                        }
                    ],
                },
                {
                    'id': 'open-cmos-inverter',
                    'name': 'Open CMOS Inverter',
                    'source_path': 'projects/open-cmos-inverter/circuit.scs',
                    'configurations': [
                        {
                            'id': 'TRAN_NGSPICE',
                            'configuration_path': 'projects/open-cmos-inverter/configurations/TRAN_NGSPICE.json',
                            'bundle_template': 'projects/open-cmos-inverter/template/tran/bundle.json',
                            'source_replacements': [{'source': 'projects/open-cmos-inverter/circuit.scs', 'destination': 'netlist/project.scs'}],
                        }
                    ],
                },
            ],
        }
        self.app = server.Application(cfg, web_dir)
        self.httpd = server.Server(('127.0.0.1', 0), server.Handler)
        self.httpd.app = self.app
        self.port = self.httpd.server_port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.app.onboarding.close()
        self.app.simulation.close()
        self.app.pool.shutdown(wait=False)
        self.tmp.cleanup()

    def get(self, path):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            conn.request('GET', path, headers={'Host': f'127.0.0.1:{self.port}'})
            resp = conn.getresponse()
            raw = resp.read()
            return resp.status, resp.getheader('Content-Type', ''), raw
        finally:
            conn.close()

    def test_live_schematic_endpoints_and_hash_mismatch_fail_closed(self):
        src_path = 'projects/open-cmos-inverter/circuit.scs'
        file_rec = self.app.workspace.file(src_path)
        sha = file_rec['sha256']

        code, _, raw = self.get('/api/schematic/live?' + urlencode({'project_id': 'open-cmos-inverter', 'path': src_path, 'source_hash': sha}))
        self.assertEqual(code, 200, raw)
        body = json.loads(raw)['data']
        self.assertEqual(body['geometry']['mode'], 'live-rnl')
        self.assertEqual(body['source_hash'], sha)
        self.assertGreater(len(body['geometry']['layout_sync']['preserved_instances']), 0)
        self.assertFalse(body['native_ready'])

        # Fetch manifest and RNL file via the returned same-origin URLs and verify digests.
        manifest_url = body['geometry']['cells'][0]['viewer_manifest_url']
        m_parts = urlsplit(manifest_url)
        code, _, m_raw = self.get(m_parts.path + '?' + m_parts.query)
        self.assertEqual(code, 200, m_raw)
        manifest = json.loads(m_raw)
        self.assertEqual(manifest['format'], 1)
        f_entry = manifest['files'][0]
        f_parts = urlsplit(f_entry['url'])
        code, _, rnl_raw = self.get(f_parts.path + '?' + f_parts.query)
        self.assertEqual(code, 200)
        self.assertEqual(len(rnl_raw), f_entry['size'])
        self.assertEqual(rnl_sync.sha256_bytes(rnl_raw), f_entry['sha256'])

        # Mismatched source hash fails closed with 404.
        bad_code, _, _ = self.get('/api/schematic/live?' + urlencode({'project_id': 'open-cmos-inverter', 'path': src_path, 'source_hash': '0' * 64}))
        self.assertEqual(bad_code, 404)

    def test_end_to_end_local_ngspice_run_produces_verified_probe_mapping(self):
        if not self.has_ngspice:
            self.skipTest('ngspice not installed in this environment')
        for project_id, config_id, expected_net in (
            ('rc-smoke', 'TRAN_NGSPICE', 'out'),
            ('open-cmos-inverter', 'TRAN_NGSPICE', 'OUT'),
        ):
            with self.subTest(project=project_id):
                head = self.app.workspace.head()
                bundle = self.app.workspace.materialize(project_id, config_id, head)
                rec, _ = self.app.runner.reserve(bundle, f'step3-probe-{project_id}', head, project_id, config_id)
                rid = rec['run_id']
                self.app.runner.dispatch(rid)
                deadline = time.monotonic() + 30
                status = self.app.runner.status(rid)
                while status.get('remote_state') in (None, 'staged', 'running', 'submitted', 'queued') and time.monotonic() < deadline:
                    time.sleep(0.1)
                    status = self.app.runner.status(rid)
                self.assertIn(status.get('remote_state'), ('succeeded', 'simulator_complete_pending_measurements', 'completed'), status)
                self.app.collect_with_postprocess(rid)

                # Fetch live schematic and waveform-map over HTTP and confirm exact identity match!
                src_path = self.app.workspace.projects[project_id]['source_path']
                sha = self.app.workspace.file(src_path)['sha256']
                live_code, _, live_raw = self.get('/api/schematic/live?' + urlencode({'project_id': project_id, 'path': src_path, 'source_hash': sha}))
                self.assertEqual(live_code, 200, live_raw)
                live_geo = json.loads(live_raw)['data']['geometry']

                map_code, _, map_raw = self.get(f'/api/jobs/{rid}/waveform-map')
                self.assertEqual(map_code, 200, map_raw)
                wmap = json.loads(map_raw)['data']
                self.assertEqual(wmap['status'], 'verified_binding')
                self.assertEqual(wmap['geometry']['kind'], 'local_export_snapshot')
                self.assertIsNone(wmap['geometry']['bundle_commit'])
                self.assertEqual(wmap['geometry']['manifest_sha256'], live_geo['manifest_sha256'])
                self.assertEqual(wmap['geometry']['bundle_sha256'], live_geo['bundle_sha256'])
                self.assertEqual(wmap['geometry']['entry_id'], live_geo['root_cell'])

                # Verify exact net probe target exists and can fetch real waveform points.
                net_objs = [o for o in wmap['objects'] if o['selector']['kind'] == 'net' and o['selector']['name'] == expected_net]
                self.assertEqual(len(net_objs), 1)
                sig_id = net_objs[0]['signal_id']
                w_code, _, w_raw = self.get(f'/api/jobs/{rid}/waveform?' + urlencode({'signal_id': sig_id}))
                self.assertEqual(w_code, 200, w_raw)
                w_data = json.loads(w_raw)['data']
                self.assertGreater(len(w_data['points']), 5)

                # Independent saved catalog remains readable even after editing the workspace netlist.
                edited_text = self.app.workspace.file(src_path)['content'] + '// post-run comment\n'
                self.app.workspace.commit(head, [{'path': src_path, 'content': edited_text}], 'Post-run edit', False)
                cat_code, _, cat_raw = self.get(f'/api/jobs/{rid}/signals')
                self.assertEqual(cat_code, 200, cat_raw)
                self.assertGreater(len(json.loads(cat_raw)['data']['signals']), 0)

                # And the new live schematic hash differs from the old run's mapping (probes fail closed on stale source).
                new_sha = self.app.workspace.file(src_path)['sha256']
                new_live_code, _, new_live_raw = self.get('/api/schematic/live?' + urlencode({'project_id': project_id, 'path': src_path, 'source_hash': new_sha}))
                self.assertEqual(new_live_code, 200)
                new_live_geo = json.loads(new_live_raw)['data']['geometry']
                self.assertNotEqual(new_live_geo['manifest_sha256'], wmap['geometry']['manifest_sha256'])


if __name__ == '__main__':
    unittest.main()
