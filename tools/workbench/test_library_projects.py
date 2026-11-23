"""Explicit library project compatibility. Isolated Git fixtures; no server or remote work."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'modules/gateway_client'))
import ic_sim
import runner
import workspace
import geometry
from ic_gateway.service import Service, Failure, relative, SCHEMAS

CELL = 'lib/ExampleLibrary/Filter'
SOURCE = CELL + '/netlist/circuit.scs'
AUX = CELL + '/netlist/resistor.scs'
CONFIG = CELL + '/simulation/TRAN.json'
TEMPLATE = CELL + '/simulation/template/bundle.json'
DOC = CELL + '/README.md'
OTHER = 'lib/ExampleLibrary/Other/netlist/circuit.scs'


class InProcessGateway:
    """Exercises the real Workspace with a closed local route list, without an HTTP socket."""
    origin = 'http://127.0.0.1:19991'

    def __init__(self, ws, run):
        self.ws, self.run, self.calls = ws, run, []
        self.override_file = None

    def request(self, url, body=None):
        self.calls.append((url, copy.deepcopy(body)))
        route = urlsplit(url); query = parse_qs(route.query)
        if route.path == '/api/project': return self.ws.describe()
        if route.path == '/api/tree': return self.ws.tree(query['project_id'][0])
        if route.path == '/api/file':
            value = self.ws.file(query['path'][0])
            return self.override_file(value) if self.override_file else value
        if route.path == '/api/schematic':
            self.assert_source(query)
            return {'source_hash': query['source_hash'][0], 'native_ready': False}
        if route.path == '/api/changes/preview': return self.ws.preview(body['base_commit'], body['changes'])
        if route.path == '/api/plan':
            bundle = self.ws.materialize(body['project_id'], body['configuration'], body['source_commit'])
            return self.run.plan(bundle, body['source_commit'])
        raise AssertionError('execution/unknown route forbidden in fixture: ' + route.path)

    def assert_source(self, query):
        p = self.ws.projects[query['project_id'][0]]
        assert query['path'] == [p['source_path']]
        assert query['source_hash'] == [self.ws.file(p['source_path'])['sha256']]


class LibraryProjectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='library-project-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve(); seed = self.root / 'seed'; seed.mkdir()
        shutil.copytree(ROOT / 'projects/rc-smoke', seed / 'projects/rc-smoke')
        self.files = {
            SOURCE: 'simulator lang=spectre\ninclude "resistor.scs"\nV0 (in 0) vsource dc=1\nX0 (in out) FilterR\nC0 (out 0) capacitor c=1p\n',
            AUX: 'simulator lang=spectre\nsubckt FilterR p n\nR0 (p n) resistor r=1k\nends FilterR\n',
            CONFIG: '{"analysis":{},"parameters":{}}\n', DOC: '# Explicitly read-only fixture\n',
            OTHER: 'R0 (x 0) resistor r=9k\n',
            'lib/ExampleLibrary/Snapshot/schematic/view.scs': '// viewer-only; never registered for execution\n',
            CELL + '/netlist/unregistered.scs': '// outside the explicit file list\n',
            CELL + '/simulation/template/netlist/input.scs': 'simulator lang=spectre\ninclude "project.scs"\ntran tran stop=12n maxstep=50p\nsave out\n',
            CELL + '/simulation/template/netlist/project.scs': '// replaced by explicit canonical source\n',
            CELL + '/simulation/template/netlist/resistor.scs': '// replaced by explicit canonical child\n',
        }
        for path, text in self.files.items():
            target = seed / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(text)
        template = {'schema': 'ic.sim.bundle.v1', 'design_id': 'library-filter', 'design_origin': 'text-netlist',
                    'test_id': 'library-filter-tran', 'source_root': '.', 'entrypoint': 'netlist/input.scs',
                    'reviewed_for_distribution': True, 'files': []}
        for name in ('input.scs', 'project.scs', 'resistor.scs'):
            rel = 'netlist/' + name
            template['files'].append({'source': rel, 'destination': rel,
                                      'sha256': runner.filehash(seed / Path(TEMPLATE).parent / rel)})
        (seed / TEMPLATE).write_text(json.dumps(template))
        subprocess.run(['git', 'init', '-b', 'main', str(seed)], check=True, capture_output=True)
        workspace.git(seed, 'add', '.')
        workspace.git(seed, '-c', 'user.name=Library fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Synthetic library fixture')
        rc = copy.deepcopy(json.loads((ROOT / 'config/workbench.projects.json').read_text())[0])
        self.project = {'id': 'library-filter', 'library_id': 'ExampleLibrary', 'cell_id': 'Filter',
                        'source_path': SOURCE, 'read_paths': [DOC], 'configurations': [{
                            'id': 'TRAN', 'configuration_path': CONFIG, 'bundle_template': TEMPLATE,
                            'source_replacements': [{'source': SOURCE, 'destination': 'netlist/project.scs'},
                                                    {'source': AUX, 'destination': 'netlist/resistor.scs'}]}]}
        self.cfg = {'github_repo': 'fixture/library', 'runtime_root': str(self.root / 'runtime'), 'seed_repo': str(seed),
                    'runtime_branch': 'codex/library-fixture', 'projects': [rc, self.project,
                       {'id': 'other', 'source_path': OTHER, 'configurations': []}]}
        self.site = ic_sim.site_load(ROOT / 'config/site.example.json')
        self.no_ssh = patch.object(ic_sim, 'ssh', side_effect=AssertionError('remote access prohibited'))
        self.no_ssh.start(); self.addCleanup(self.no_ssh.stop)
        self.ws = workspace.Workspace(self.cfg, self.site, b'library-fixture-key')
        self.run = runner.Runner(self.root / 'runs', self.site, self.ws.frozen, b'library-fixture-key')
        self.s = Service({'gateway_url': InProcessGateway.origin, 'state_dir': str(self.root / 'requests')})
        self.gateway = InProcessGateway(self.ws, self.run); self.s.gateway = self.gateway

    def test_registry_metadata_and_exact_paths_preserve_rc_and_do_not_discover_snapshot(self):
        catalog = self.ws.describe(); ids = {p['id'] for p in catalog['projects']}
        self.assertEqual(ids, {'rc-smoke', 'library-filter', 'other'})
        project = next(p for p in catalog['projects'] if p['id'] == 'library-filter')
        self.assertEqual((project['library_id'], project['cell_id'], project['source_path']), ('ExampleLibrary', 'Filter', SOURCE))
        self.assertEqual(self.s.call('read', {'project_id': 'rc-smoke'})['file']['path'], 'projects/rc-smoke/circuit.scs')
        for pid in ('Filter', CELL, 'ExampleLibrary/Filter', 'Snapshot'):
            with self.subTest(pid=pid), self.assertRaises(Failure): self.s.call('read', {'project_id': pid})

    def test_library_read_tree_and_per_project_edit_scope(self):
        result = self.s.call('read', {'project_id': 'library-filter', 'path': AUX})
        self.assertEqual(result['project']['library_id'], 'ExampleLibrary')
        self.assertEqual(result['file']['path'], AUX)
        tree = {f['path']: f['editable'] for f in self.ws.tree('library-filter')['files']}
        self.assertEqual(tree, {SOURCE: True, AUX: True, CONFIG: True, DOC: False})
        for path in (OTHER, CELL+'/netlist/unregistered.scs', 'lib/ExampleLibrary/Snapshot/schematic/view.scs'):
            with self.subTest(path=path), self.assertRaises(Failure): self.s.call('read', {'project_id': 'library-filter', 'path': path})

    def test_noncanonical_path_spellings_never_normalized(self):
        invalid = [None, '', '/'+SOURCE, SOURCE+'/', 'lib//ExampleLibrary/Filter/a', 'lib/ExampleLibrary/./Filter/a',
                   'lib/ExampleLibrary/Filter/../a', 'lib/ExampleLibrary/Filter/.private/a', 'lib/ExampleLibrary/Filter/a\\b',
                   'lib/ExampleLibrary/Filter/a\nb', 'lib/ExampleLibrary/Filter/a\x00b', 'lib/ExampleLibrary/Filter/a\x7fb',
                   'https://example.org/x', 'lib://ExampleLibrary/Filter/a', 'lib/ExampleLibrary/Filter', 'lib/catalog.json',
                   'projects//demo/a', 'projects/rc-smoke/./circuit.scs', 'projects/rc-smoke/../x']
        for path in invalid:
            with self.subTest(path=path):
                with self.assertRaises(ValueError): workspace.project_path(path)
                with self.assertRaises(Failure): relative(path)
        for path in (SOURCE, AUX, CONFIG, DOC, 'projects/rc-smoke/circuit.scs'):
            self.assertEqual(workspace.project_path(path), path); self.assertEqual(relative(path), path)

    def test_bad_metadata_or_duplicate_ids_rejected_without_identity_inference(self):
        for fields in ({'library_id':'Elsewhere'}, {'cell_id':'Other'}, {'library_id':'../escape'}, {'cell_id':None}):
            with self.subTest(fields=fields), self.assertRaises(ValueError): workspace.project_metadata({**self.project, **fields})
        self.assertEqual(workspace.project_metadata({k:v for k,v in self.project.items() if k not in ('library_id','cell_id')}), {})
        cfg = copy.deepcopy(self.cfg); cfg['projects'].append(copy.deepcopy(self.project))
        with self.assertRaisesRegex(ValueError, 'duplicate project'): workspace.Workspace(cfg, self.site, b'key')

    def test_symlink_file_and_parent_never_read(self):
        (self.ws.root / AUX).unlink(); (self.ws.root / AUX).symlink_to(self.ws.root / OTHER)
        with self.assertRaisesRegex(ValueError, 'symlink'): self.ws.file(AUX)
        (self.ws.root / AUX).unlink(); (self.ws.root / AUX).write_text(self.files[AUX])
        folder = self.ws.root / CELL / 'netlist'; folder.rename(folder.with_name('original'))
        folder.symlink_to(folder.with_name('original'), target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'): self.ws.file(SOURCE)

    def test_signed_library_materialization_and_descriptor_keep_source_identity(self):
        base = self.ws.head(); bundle = self.ws.materialize('library-filter', 'TRAN', base)
        plan = self.run.plan(bundle, base); data = plan['provenance']['materialization']
        self.assertEqual((data['source_commit'], data['project_id'], data['library_id'], data['cell_id']), (base, 'library-filter', 'ExampleLibrary', 'Filter'))
        for path, target in ((SOURCE, 'netlist/project.scs'), (AUX, 'netlist/resistor.scs')):
            self.assertEqual((bundle.parent/target).read_text(), self.files[path])
            self.assertEqual(data['source_sha256'][path], runner.filehash(self.ws.root/path))
        description = self.ws.configuration_description('library-filter', 'TRAN', base)
        self.assertEqual(description['configuration_path'], CONFIG)
        self.assertEqual((description['library_id'], description['cell_id'], description['source_commit']), ('ExampleLibrary', 'Filter', base))
        self.assertEqual(plan['blockers'], []); self.assertTrue(self.ws.clean())
        with self.assertRaises(workspace.Conflict): self.ws.materialize('library-filter', 'TRAN', 'f'*40)
        with self.assertRaises(FileNotFoundError): self.ws.materialize('library-filter', 'other', base)

    def test_source_replacement_review_is_pending_and_never_dispatches(self):
        source = self.ws.file(AUX); base = self.ws.head()
        draft = {'project_id':'library-filter', 'base_commit':base,
                 'changes':[{'path':AUX, 'sha256':source['sha256'], 'content':source['content'].replace('1k','2k')}]}
        review = self.s.call('diff', draft)
        self.assertIn('a/'+AUX, review['diff'])
        receipt = self.s.call('apply', {'review_id':review['review_id'], 'message':'Synthetic library edit', 'idempotency_key':'library-apply-key'})
        self.assertEqual(receipt['state'], 'pending_approval'); self.assertFalse(receipt['automatic_retry'])
        self.assertEqual(self.ws.file(AUX), source); self.assertEqual(self.ws.head(), base)
        self.assertEqual(self.s.call('request_status', {'request_id':receipt['request_id']})['fingerprint'], receipt['fingerprint'])
        self.assertFalse(any('/commit' in path or path=='/api/jobs' for path,_ in self.gateway.calls))
        self.assertNotIn('approve', SCHEMAS); self.assertNotIn('resolve', SCHEMAS)
        with self.assertRaises(Failure): self.s.call('apply', {**receipt['arguments'],'approved':True})

    def test_cross_project_readonly_and_wrong_hash_or_commit_review_fail(self):
        for path in (OTHER, DOC):
            current = self.ws.file(path)
            with self.subTest(path=path), self.assertRaises(Failure): self.s.call('diff', {
                'project_id':'library-filter','base_commit':self.ws.head(),
                'changes':[{'path':path,'sha256':current['sha256'],'content':current['content']+'// edit\n'}]})
        current = self.ws.file(SOURCE)
        for base, digest in (('f'*40,current['sha256']), (self.ws.head(),'f'*64)):
            with self.assertRaises(Failure): self.s.call('diff', {'project_id':'library-filter','base_commit':base,
                'changes':[{'path':SOURCE,'sha256':digest,'content':current['content']+'// edit\n'}]})

    def test_lib_submission_remains_pinned_manual_and_cannot_rekey_pending(self):
        args = {'project_id':'library-filter','configuration':'TRAN','source_commit':self.ws.head(),'idempotency_key':'library-submit-key'}
        receipt = self.s.call('sim_submit', args)
        self.assertEqual(receipt['state'], 'pending_approval'); self.assertEqual(receipt['arguments'], args)
        self.assertEqual(self.s.call('sim_submit', args)['request_id'], receipt['request_id'])
        with self.assertRaisesRegex(Failure, 'changing its key'): self.s.call('sim_submit', {**args,'idempotency_key':'different-submit-key'})
        self.assertEqual(self.run.list(), []); self.assertFalse(any(path=='/api/jobs' for path,_ in self.gateway.calls))

    def test_wrong_gateway_path_or_content_hash_is_rejected(self):
        for update in ({'path':OTHER}, {'content':'forged bytes'}):
            self.gateway.override_file = lambda value: {**value, **update}
            with self.subTest(update=update), self.assertRaises(Failure): self.s.call('read', {'project_id':'library-filter'})

    def test_missing_include_blocks_edit_but_models_are_checked_at_remote_execution(self):
        current = self.ws.file(SOURCE)
        for include in ('missing.scs','@EXTERNAL_BAD!@'):
            with self.subTest(include=include), self.assertRaises((ValueError, KeyError)):
                self.ws.preview(self.ws.head(), [{'path':SOURCE,'sha256':current['sha256'],'content':current['content']+'include "'+include+'"\n'}])
        source=current['content']+'include "@EXTERNAL_PDK_MAIN@"\n'
        preview=self.ws.preview(self.ws.head(), [{'path':SOURCE,'sha256':current['sha256'],'content':source}])
        self.assertTrue(preview['review_id'])
        project,config=self.ws.select('library-filter','TRAN')
        bundle,files,_=self.ws.compile_inputs(project,config,self.ws.head(),{SOURCE:source.encode()})
        proof=self.ws.validate_compiled(bundle,files)
        self.assertEqual(proof['required_remote_aliases'],['PDK_MAIN'])
        self.assertFalse(proof['remote_models_checked'])
        self.assertFalse(proof['simulation_started'])
        self.assertTrue(self.ws.clean())

    def test_library_version_history_excludes_other_cell_and_unlisted_files(self):
        paths = set(self.ws._version_paths('library-filter','design'))
        self.assertEqual(paths, {SOURCE, AUX, CONFIG})
        detail = self.ws.version_control_commit('library-filter', self.ws.head(), 'design')
        self.assertEqual({f['path'] for f in detail['files']}, paths)
        self.assertNotIn(OTHER, detail['diff']); self.assertNotIn('Snapshot', detail['diff'])
        self.assertFalse(workspace.version_public_path(CELL+'/netlist/pdk/model.scs'))
        self.assertFalse(workspace.version_public_path(CELL+'/simulation/settings.local.json'))

    def test_geometry_registration_allows_same_cell_schematic_only_with_existing_proof_contract(self):
        self.project['geometry_manifest']=CELL+'/schematic/manifest.json'
        g = geometry.Geometry(self.ws)
        self.assertEqual(g.registration('library-filter')[1], self.project['geometry_manifest'])
        self.project['geometry_manifest']='lib/ExampleLibrary/Other/schematic/manifest.json'
        with self.assertRaisesRegex(ValueError,'registered manifest'): g.registration('library-filter')
        self.project['geometry_manifest']=CELL+'/simulation/template/bundle.json'
        with self.assertRaises(ValueError): g.registration('library-filter')
        # A library index is not an ic.native-geometry manifest and is never imported here.
        self.project.pop('geometry_manifest')
        with self.assertRaises(FileNotFoundError): g.registration('library-filter')


if __name__ == '__main__': unittest.main(verbosity=2)
