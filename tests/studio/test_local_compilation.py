"""Exact library commits compile locally, without remote models or checkout writes."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/workbench'))
import ic_sim
import local_inputs
from workspace import Workspace, Conflict


class LocalCompilationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'source'; self.root.mkdir()
        self.git('init', '-q', '--initial-branch=main')
        self.git('remote', 'add', 'origin', 'https://github.com/fixture/circuits.git')
        self.source = 'projects/test/circuit.scs'
        self.configuration = 'projects/test/config.json'
        text = 'simulator lang=spectre\ninclude "@EXTERNAL_MODEL@"\nparameters r=1k\nR0 (in 0) resistor r=r\ntran tran stop=1n\n'
        self.put(self.source, text)
        self.put(self.configuration, json.dumps({'parameters': {}, 'analysis': {}}))
        self.bundle = {'schema': 'ic.sim.bundle.v1', 'source_root': '..', 'entrypoint': 'netlist/input.scs',
                       'design_origin': 'text-netlist', 'external_dependencies': [{'alias': 'MODEL', 'sha256': 'a'*64}],
                       'files': [{'source': 'circuit.scs', 'destination': 'netlist/input.scs',
                                  'sha256': hashlib.sha256(text.encode()).hexdigest()}]}
        self.put('projects/test/template/bundle.json', json.dumps(self.bundle))
        self.first = self.commit()
        self.cfg = {'github_repo': 'fixture/circuits', 'seed_repo': str(self.root),
                    'source_repository': str(self.root), 'runtime_root': str(Path(self.temp.name)/'runtime'),
                    'projects': [{'id': 'test', 'source_path': self.source, 'configurations': [
                        {'id': 'TRAN', 'configuration_path': self.configuration,
                         'bundle_template': 'projects/test/template/bundle.json',
                         'source_replacements': [{'source': self.source, 'destination': 'netlist/input.scs'}]}]}]}
        self.ws = Workspace(self.cfg, {'external_files': {}}, b'k'*32)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.DEVNULL).decode().strip()

    def put(self, path, text):
        file = self.root/path; file.parent.mkdir(parents=True, exist_ok=True); file.write_text(text)

    def commit(self):
        self.git('add', '.'); self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Circuit fixture')
        return self.git('rev-parse', 'HEAD')

    def test_exact_new_library_commit_without_mutating_runtime_or_resolving_models(self):
        before_runtime = self.ws.head()
        self.put(self.source, (self.root/self.source).read_text().replace('r=1k', 'r=2k'))
        head = self.commit()
        with patch.object(ic_sim, 'prepare', side_effect=AssertionError('Local compilation must not resolve PDK')):
            path = self.ws.materialize('test', 'TRAN', head)
            description = self.ws.configuration_description('test', 'TRAN', head)
        self.assertEqual(self.ws.head(), before_runtime)
        self.assertNotEqual(head, before_runtime)
        self.assertEqual(self.git('rev-parse', 'HEAD'), head)
        self.assertEqual(self.git('status', '--porcelain'), '')
        self.assertIn('r=2k', (path.parent/'netlist/input.scs').read_text())
        data = json.loads((path.parent/'materialization.json').read_text())['data']
        self.assertEqual(data['source_commit'], head)
        self.assertEqual(data['source_sha256'][self.source], hashlib.sha256((self.root/self.source).read_bytes()).hexdigest())
        self.assertEqual(description['source_commit'], head)
        self.assertEqual(self.ws.materialize('test', 'TRAN', head), path)

    def test_dirty_or_stale_library_inputs_do_not_materialize(self):
        self.put(self.source, (self.root/self.source).read_text().replace('r=1k', 'r=2k'))
        with self.assertRaisesRegex(Conflict, 'commit circuit'):
            self.ws.materialize('test', 'TRAN', self.first)
        head = self.commit()
        with self.assertRaisesRegex(Conflict, 'source_commit changed'):
            self.ws.materialize('test', 'TRAN', self.first)
        self.assertEqual(list(self.ws.frozen.iterdir()), [])

    def test_wrong_source_repository_cannot_be_bound(self):
        self.git('remote', 'set-url', 'origin', 'https://github.com/fixture/other.git')
        with self.assertRaisesRegex(ValueError, 'source repository'):
            Workspace(self.cfg, {'external_files': {}}, b'k'*32)

    def test_compiled_closure_reports_models_without_inventing_remote_evidence(self):
        p,c = self.ws.select('test', 'TRAN'); bundle, files, _ = self.ws.compile_inputs(p,c,self.first)
        report = local_inputs.validate(bundle, files)
        self.assertEqual(report['required_remote_aliases'], ['MODEL'])
        self.assertFalse(report['remote_models_checked']); self.assertFalse(report['simulation_started'])
        bundle['external_dependencies'] = []
        self.assertEqual(local_inputs.validate(bundle,files)['unpinned_remote_aliases'], ['MODEL'])
        bundle['external_dependencies'] = [{'alias': 'MODEL', 'sha256': 'unknown'}]
        with self.assertRaisesRegex(ValueError, 'hash pin'): local_inputs.validate(bundle,files)

    def test_hash_missing_include_cycle_and_bad_placeholder_are_rejected(self):
        for text in ('include "missing.scs"\n', 'include "input.scs"\n', 'include "@EXTERNAL_BAD!@"\n', 'include "/private/model.scs"\n'):
            with self.subTest(text=text):
                raw=text.encode(); bundle={'schema':'ic.sim.bundle.v1','entrypoint':'netlist/input.scs',
                    'files':[{'source':'netlist/input.scs','destination':'netlist/input.scs','sha256':ic_sim.sha(raw)}]}
                with self.assertRaises(ValueError): local_inputs.validate(bundle, {'netlist/input.scs':raw})
        bundle['files'][0]['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'hash mismatch'): local_inputs.validate(bundle,{'netlist/input.scs':b'R0 (in 0) resistor r=1k'})


if __name__ == '__main__': unittest.main()
