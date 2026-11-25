"""Synthetic electrical fixtures, real upstream gateway/Workspace and real stdio client.
No SSH, Cadence, GitHub or existing run is invoked. Run from portable/.
"""
import copy
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / 'apps/codex'
sys.path.insert(0, str(ROOT))
UPSTREAM = Path(os.environ.get('IC_UPSTREAM', str(ROOT.parents[1])))
sys.path.insert(0, str(UPSTREAM / 'tools/workbench'))
import server
import runner
import workspace
from icwb.service import Service, Failure, sha, canonical, tools


def git(root, *args):
    return workspace.git(root, *args).stdout.decode().strip()


class Fixture:
    def __init__(self, root):
        self.root = root
        seed = root / 'seed'; seed.mkdir()
        subprocess.run(['git', 'init', '-b', 'main', str(seed)], capture_output=True, check=True)
        git(seed, 'config', 'user.name', 'Synthetic fixture')
        git(seed, 'config', 'user.email', 'fixture@localhost')
        sources = {
            'projects/demo/circuit.scs': 'simulator lang=spectre\nglobal 0\nR0 (x 0) resistor r=1k\n',
            'projects/demo/config.json': '{}\n',
            'sim/demo/netlist/input.scs': 'simulator lang=spectre\ninclude "project.scs"\ntran tran stop=1n\n',
            'sim/demo/netlist/project.scs': 'simulator lang=spectre\nR0 (x 0) resistor r=1k\n',
        }
        for name, content in sources.items():
            f = seed / name; f.parent.mkdir(parents=True, exist_ok=True); f.write_bytes(content.encode('utf-8'))
        b = {'schema': 'ic.sim.bundle.v1', 'design_id': 'demo', 'design_origin': 'text-netlist',
             'test_id': 'synthetic-tran', 'source_root': '.', 'entrypoint': 'netlist/input.scs',
             'reviewed_for_distribution': True, 'files': [{'source': 'netlist/' + n, 'destination': 'netlist/' + n,
                'sha256': runner.filehash(seed / 'sim/demo/netlist' / n)} for n in ['input.scs', 'project.scs']]}
        runner.atomic(seed / 'sim/demo/bundle.json', b)
        git(seed, 'add', '.'); git(seed, 'commit', '-m', 'SYNTHETIC fixture only')
        site = {'schema': 'ic.sim.site.v1', 'ssh_target': 'synthetic-unused',
                'remote_runs_root': '/synthetic/ic_on_github_runs', 'cadence_cshrc': '/synthetic/setup',
                'spectre_bin': '/synthetic/spectre', 'external_files': {}, 'expected_host': 'synthetic', 'expected_user': 'synthetic'}
        runner.atomic(root / 'site.json', site)
        cfg = {'github_repo': 'analog-topology-synth/IC_on_Github', 'seed_repo': str(seed),
               'runtime_root': str(root / 'runtime'), 'site_file': str(root / 'site.json'), 'base_branch': 'main',
               'runtime_branch': 'codex/ai-synthetic', 'projects': [{'id': 'demo', 'source_path': 'projects/demo/circuit.scs',
                 'configurations': [{'id': 'tran', 'configuration_path': 'projects/demo/config.json', 'bundle_template': 'sim/demo/bundle.json'}]}]}
        web = root / 'web'; web.mkdir(); (web / 'index.html').write_text('Synthetic fixture gateway')
        self.app = server.Application(cfg, web)
        self.http = server.Server(('127.0.0.1', 0), server.Handler); self.http.app = self.app
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True); self.thread.start()
        self.cfg = {'gateway_url': 'http://127.0.0.1:' + str(self.http.server_port), 'state_dir': str(root / 'client-state')}
        self.config_path = root / 'client.json'; self.config_path.write_text(canonical(self.cfg))
        self.service = Service(self.cfg)

    def close(self):
        self.http.shutdown(); self.http.server_close(); self.app.pool.shutdown(wait=True)


class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        scratch = ROOT / '.test-state'; scratch.mkdir(exist_ok=True)
        cls.tmp = tempfile.TemporaryDirectory(dir=scratch)
        cls.fixture = Fixture(Path(cls.tmp.name)); cls.s = cls.fixture.service

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close(); cls.tmp.cleanup()

    def draft(self, value):
        f = self.s.call('read', {'project_id': 'demo'})['file']
        return {'project_id': 'demo', 'base_commit': f['base_commit'], 'changes': [
            {'path': f['path'], 'sha256': f['sha256'], 'content': f['content'].replace('r=1k', 'r=' + value)}]}

    def test_01_read_has_identity(self):
        d = self.s.call('read', {'project_id': 'demo', 'cell': 'demo', 'scope': '@top'})
        self.assertEqual(d['file']['sha256'], sha(d['file']['content']))
        if 'native_ready' in d['geometry']:
            self.assertFalse(d['geometry']['native_ready'])
            self.assertEqual(d['geometry']['geometry']['state'], 'missing')
        else:
            self.assertEqual(d['geometry_provenance_status'], 'native_contract_unavailable')
        self.assertEqual(d['scope'], '@top')

    def test_02_cli_and_stdio_real_protocol(self):
        run = subprocess.run([sys.executable, '-B', str(ROOT / 'ic_workbench.py'), '--config', str(self.fixture.config_path), '--json', 'projects'], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout)['data']['projects'][0]['id'], 'demo')
        p = subprocess.Popen([sys.executable, '-B', str(ROOT / 'ic_workbench.py'), '--config', str(self.fixture.config_path), 'mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        transcript = []
        def call(msg):
            p.stdin.write(canonical(msg) + '\n'); p.stdin.flush()
            if 'id' not in msg: return
            self.assertTrue(select.select([p.stdout], [], [], 10)[0], 'stdio response timeout')
            response = json.loads(p.stdout.readline()); transcript.append({'request': msg, 'response': response}); return response
        try:
            init = call({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'icwb-protocol-test', 'version': '1'}}})
            self.assertEqual(init['result']['protocolVersion'], '2025-06-18')
            call({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
            definitions = call({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'})['result']['tools']
            self.assertFalse(any('approve' in t['name'] for t in definitions))
            res = call({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'ic_read', 'arguments': {'project_id': 'demo'}}})
            self.assertFalse(res['result']['isError']); self.assertIn('r=1k', res['result']['structuredContent']['data']['file']['content'])
            res = call({'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'ic_approve', 'arguments': {}}})
            self.assertTrue(res['result']['isError'])
            evidence = ROOT.parents[1] / 'test-results/ai'; evidence.mkdir(parents=True,exist_ok=True)
            (evidence / 'mcp-synthetic-transcript.json').write_text(json.dumps({'fixture': 'synthetic', 'transport': 'actual subprocess stdio', 'transcript': transcript}, indent=2))
        finally:
            p.stdin.close(); p.wait(timeout=10); p.stdout.close(); p.stderr.close()

    def test_03_invalid_changes_and_hashes_fail(self):
        for content in ('system "touch BAD"\n', 'include "missing.scs"\n'):
            a = self.draft('2k'); a['changes'][0]['content'] += content
            with self.assertRaises(Failure): self.s.call('diff', a)
        a = self.draft('2k'); a['changes'][0]['sha256'] = '0' * 64
        with self.assertRaises(Failure): self.s.call('diff', a)
        a = self.draft('2k'); del a['changes'][0]['sha256']
        with self.assertRaises(Failure): self.s.call('diff', a)
        with self.assertRaises(Failure): self.s.call('read', {'project_id': 'demo', 'path': 'projects/../secret'})
        with self.assertRaises(Failure): self.s.call('projects', {'command': 'echo injected'})

    def test_04_denial_no_commit(self):
        d = self.s.call('diff', self.draft('2k')); self.assertIn('-R0', d['diff'])
        head = self.fixture.app.workspace.head()
        r = self.s.call('apply', {'review_id': d['review_id'], 'message': 'Synthetic denial', 'idempotency_key': 'deny-test-0001'})
        self.assertEqual(r['state'], 'pending_approval')
        r = self.s.resolve(r['request_id'], 'deny', r['fingerprint'])
        self.assertEqual(r['state'], 'denied'); self.assertEqual(head, self.fixture.app.workspace.head())
        self.s.resolve(r['request_id'], 'approve', r['fingerprint'])
        self.assertEqual(head, self.fixture.app.workspace.head())

    def test_05_uncertain_no_replay(self):
        d = self.s.call('diff', self.draft('2k'))
        r = self.s.call('apply', {'review_id': d['review_id'], 'message': 'Uncertain synthetic', 'idempotency_key': 'uncertain-test-001'})
        with patch.object(self.s.gateway, 'request', side_effect=Failure('transport_unknown', 'Synthetic disconnect', 75)) as send:
            r = self.s.resolve(r['request_id'], 'approve', r['fingerprint'])
            self.assertEqual(r['state'], 'uncertain')
            self.s.resolve(r['request_id'], 'approve', r['fingerprint']); self.assertEqual(send.call_count, 1)
        recreated = Service(self.fixture.cfg)
        with patch.object(recreated.gateway, 'request', side_effect=AssertionError('must not replay')):
            self.assertEqual(recreated.resolve(r['request_id'], 'approve', r['fingerprint'])['state'], 'uncertain')

    def test_06_edit_plan_and_idempotent_synthetic_submit(self):
        before = self.fixture.app.workspace.head()
        d = self.s.call('diff', self.draft('2k'))
        r = self.s.call('apply', {'review_id': d['review_id'], 'message': 'SYNTHETIC R 2k', 'idempotency_key': 'synthetic-edit-001'})
        r = self.s.resolve(r['request_id'], 'approve', r['fingerprint'])
        self.assertEqual(r['state'], 'accepted')
        commit = r['result']['source_commit']; self.assertNotEqual(before, commit)
        identity = {'project_id': 'demo', 'configuration': 'tran', 'source_commit': commit}
        plan = self.s.call('sim_plan', identity)
        self.assertEqual(plan['source_commit'], commit)
        a = {**identity, 'idempotency_key': 'synthetic-submit-001'}
        job = self.s.call('sim_submit', a)
        with patch.object(self.fixture.app.runner, 'dispatch', return_value=None) as dispatch:
            accepted = self.s.resolve(job['request_id'], 'approve', job['fingerprint'])
            self.assertEqual(accepted['state'], 'accepted')
            self.s.resolve(job['request_id'], 'approve', job['fingerprint'])
            self.assertEqual(self.s.call('sim_submit', a)['request_id'], job['request_id'])
            # Pool dispatch is synthetic; reserve + signed materialization + receipt are actual upstream code.
            self.fixture.app.operations[accepted['result']['run_id']].result(timeout=3)
            self.assertEqual(dispatch.call_count, 1)
        bad = {**a, 'configuration': 'different'}
        with self.assertRaises(Failure): self.s.call('sim_submit', bad)
        results = self.s.call('sim_results', {'run_id': accepted['result']['run_id']})
        self.assertEqual(results['state'], 'not_collected')
        evidence = {'fixture': 'synthetic', 'remote_dispatch': 'explicitly mocked; no Spectre run',
                    'before': before, 'diff': d, 'commit': r, 'plan': plan, 'submission': accepted, 'results': results}
        (ROOT.parents[1] / 'test-results/ai/synthetic-chain.json').write_text(json.dumps(evidence, indent=2))

    def test_07_annotations(self):
        by = {x['name']: x['annotations'] for x in tools()}
        for op in ('ic_apply', 'ic_sim_submit', 'ic_sim_collect', 'ic_sim_archive', 'ic_sim_status', 'ic_sim_plan'):
            self.assertFalse(by[op]['readOnlyHint'])

    def test_08_uncertain_key_cannot_be_replaced(self):
        identity = {'project_id': 'demo', 'configuration': 'tran', 'source_commit': self.fixture.app.workspace.head()}
        r = self.s.call('sim_submit', {**identity, 'idempotency_key': 'never-rekey-original'})
        with patch.object(self.s.gateway, 'request', side_effect=Failure('transport_unknown', 'Synthetic timeout', 75)):
            r = self.s.resolve(r['request_id'], 'approve', r['fingerprint'])
        self.assertEqual(r['state'], 'uncertain')
        with self.assertRaises(Failure) as caught:
            self.s.call('sim_submit', {**identity, 'idempotency_key': 'never-rekey-replacement'})
        self.assertEqual(caught.exception.code, 'unresolved_prior_request')


if __name__ == '__main__': unittest.main(verbosity=2)
