"""Temporary circuit fixtures + fake Service; no model, network or simulator."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/ci'))
import check as ci
from spectre_request import perform, load_settings


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.config = {'parameters': {}, 'analysis': {}, 'simulator': {'profile': 'spectre-default', 'args': ['-64']}}
        self.put('projects/rc-smoke/circuit.scs', 'simulator lang=spectre\nR0 (in out) resistor r=1k\n')
        self.json('projects/rc-smoke/config.json', self.config)
        self.cell('basics', 'rc-smoke', 'projects/rc-smoke/circuit.scs', 'projects/rc-smoke/config.json')
        self.put('lib/adc/TB/netlist/top.scs', 'simulator lang=spectre\nR1 (in 0) resistor r=2k\n')
        self.json('lib/adc/TB/simulation/configuration.json', self.config)
        self.cell('adc', 'TB', 'lib/adc/TB/netlist/top.scs', 'lib/adc/TB/simulation/configuration.json')
        self.json('lib/catalog.json', {'schema': 'circuitgit.libraries.v1', 'libraries': [
            {'id': x, 'manifest': f'lib/{x}/library.json'} for x in ('basics', 'adc')]})
        self.benches = [{'id': ci.DEFAULT_TB, 'library_id': 'basics', 'cell_id': 'rc-smoke', 'configuration_path': 'projects/rc-smoke/config.json',
                         'engine': 'source-check', 'workflow_path': '.github/workflows/circuit-ci.yml'},
                        {'id': 'adc-test', 'library_id': 'adc', 'cell_id': 'TB', 'configuration_path': 'lib/adc/TB/simulation/configuration.json',
                         'engine': 'spectre', 'requires_external_models': True, 'workflow_path': '.github/workflows/circuit-spectre.yml'}]
        self.registry = self.root/'config/library-testbenches.json'; self.json('config/library-testbenches.json', {'testbenches': self.benches})

    def tearDown(self): self.temp.cleanup()
    def put(self, name, text):
        p = self.root/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text)
    def json(self, name, value): self.put(name, json.dumps(value))
    def cell(self, lid, cid, entry, config):
        self.put(f'lib/{lid}/{cid}/README.md', 'Synthetic test fixture only.')
        self.json(f'lib/{lid}/library.json', {'schema': 'circuitgit.library.v1', 'id': lid, 'cells': [
            {'id': cid, 'directory': f'lib/{lid}/{cid}', 'readme': f'lib/{lid}/{cid}/README.md', 'kind': 'testbench',
             'project_id': None, 'requires_external_models': lid == 'adc', 'views': [
                 {'id': 'netlist', 'kind': 'spectre', 'entry': entry, 'files': [entry]},
                 {'id': 'simulation', 'kind': 'json', 'entry': config, 'files': [config, entry]}]}]})
    def select(self, lid='basics', cid='rc-smoke', ids=None, enabled=True):
        self.json(f'lib/{lid}/{cid}/ci.json', {'schema': 'circuitgit.cell-ci.v1', 'library_id': lid, 'cell_id': cid,
                                           'enabled': enabled, 'testbench_ids': ids if ids is not None else [ci.DEFAULT_TB]})
    def run_ci(self, **kwargs): return ci.run(self.root, self.registry, **kwargs)
    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.DEVNULL).decode().strip()
    def commit(self):
        self.git('add', '.'); self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic change')
        return self.git('rev-parse', 'HEAD')

    def test_default_rc_source_checks_only(self):
        report = self.run_ci(); self.assertEqual(report['status'], 'passed')
        self.assertEqual([r['id'] for r in report['testbenches']], [ci.DEFAULT_TB])
        self.assertFalse(report['simulation_started']); self.assertEqual(report['testbenches'][0]['simulation_status'], 'not_run')
    def test_explicit_disable_has_no_fallback(self):
        self.select(ids=[], enabled=False); self.assertEqual(self.run_ci()['testbenches'], [])
    def test_adc_selection_reports_external_block_not_simulation_pass(self):
        self.select('adc', 'TB', ['adc-test'])
        row = next(r for r in self.run_ci()['testbenches'] if r['id'] == 'adc-test')
        self.assertEqual(row['status'], 'passed'); self.assertEqual(row['check_kind'], 'source-check')
        self.assertEqual(row['simulation_status'], 'blocked_external_models'); self.assertFalse(row['simulation_started'])
        self.assertTrue(any('historical' in text for text in row['limitations']))
    def test_unknown_cross_cell_and_empty_enabled_rejected(self):
        for ids in (['missing'], ['adc-test'], []):
            self.select(ids=ids)
            with self.assertRaises(ValueError): self.run_ci()
    def test_duplicate_and_wrong_identity_selection_rejected(self):
        self.select(ids=[ci.DEFAULT_TB, ci.DEFAULT_TB])
        with self.assertRaises(ValueError): self.run_ci()
        self.select(); p = self.root/'lib/basics/rc-smoke/ci.json'; value=json.loads(p.read_text());value['cell_id']='TB';p.write_text(json.dumps(value))
        with self.assertRaises(ValueError): self.run_ci()
    def test_configuration_schema_failure_fails_source_check(self):
        self.json('projects/rc-smoke/config.json', {'execute': 'never-run-me'})
        report = self.run_ci(); self.assertEqual(report['status'], 'failed'); self.assertEqual(report['testbenches'][0]['status'], 'failed')
    def test_missing_include_fails_and_no_shell_evaluation(self):
        self.put('projects/rc-smoke/circuit.scs', 'include "missing.scs"\n')
        report=self.run_ci();self.assertEqual(report['status'],'failed');self.assertIn('Missing include',str(report['errors']))
    def test_external_placeholder_is_reported_without_reading_it(self):
        self.put('projects/rc-smoke/circuit.scs', 'include "@EXTERNAL_PDK_MAIN@"\n')
        row=self.run_ci()['testbenches'][0];self.assertEqual(row['external_dependencies'],['@EXTERNAL_PDK_MAIN@'])
        self.assertEqual(row['simulation_status'],'blocked_external_models')
    def test_manifest_symlink_and_config_traversal_rejected(self):
        self.benches[0]['configuration_path']='projects/../private.json';self.json('config/library-testbenches.json',{'testbenches':self.benches})
        with self.assertRaises(ValueError):self.run_ci()
    def test_configuration_duplicate_keys_rejected(self):
        self.put('projects/rc-smoke/config.json','{"parameters":{},"parameters":{}}')
        self.assertEqual(self.run_ci()['status'],'failed')
    def test_changed_scope_pinned_identity_and_dirty_rejection(self):
        self.git('init','-q');base=self.commit()
        self.put('projects/rc-smoke/circuit.scs','R0 (in out) resistor r=2k\n');head=self.commit()
        report=self.run_ci(base=base,head=head);self.assertEqual(report['source_commit'],head)
        self.assertEqual(len(report['testbenches']),1)
        self.assertEqual(self.run_ci(base=head,head=head)['testbenches'],[])
        with self.assertRaises(ValueError):self.run_ci(base=base,head=base)
        self.put('projects/rc-smoke/circuit.scs','dirty')
        with self.assertRaises(ValueError):self.run_ci(base=base,head=head)
    def test_unknown_sha_and_argument_injection_rejected(self):
        with self.assertRaises(ValueError):self.run_ci(base='--help',head='a'*40)
    def test_input_hash_changes_with_source(self):
        first=self.run_ci()['testbenches'][0]['input_hashes']
        self.put('projects/rc-smoke/circuit.scs','R0 (in out) resistor r=3k\n')
        self.assertNotEqual(first,self.run_ci()['testbenches'][0]['input_hashes'])
    def test_rnl_build_uses_real_trusted_wasm_on_synthetic_source(self):
        node=os.environ.get('NODE_BINARY') or shutil.which('node')
        if not node:self.skipTest('Set NODE_BINARY to execute bundled WASM validation')
        self.put('projects/rc-smoke/circuit.scs',(ROOT/'apps/web/demo/rc.scs').read_text())
        report=self.root/'rnl-input.json';out=self.root/'rnl-output.json'
        report.write_text(json.dumps({'status':'passed','source_commit':'a'*40,'rnl_views':[{'library_id':'basics','cell_id':'rc-smoke','view_id':'synthetic',
          'entry':'projects/rc-smoke/circuit.scs','files':['projects/rc-smoke/circuit.scs']}]}))
        result=subprocess.run([node,str(ROOT/'tools/ci/rnl-check.mjs'),str(self.root),str(report),str(out)],capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr+result.stdout)
        self.assertEqual(json.loads(out.read_text())['status'],'passed');self.assertFalse(json.loads(out.read_text())['simulation_started'])
    def test_rnl_selected_level_must_exist_and_have_drawable_geometry(self):
        node=os.environ.get('NODE_BINARY') or shutil.which('node')
        if not node:self.skipTest('Set NODE_BINARY to execute bundled WASM validation')
        source='projects/rc-smoke/circuit.scs';report=self.root/'rnl-input.json';out=self.root/'rnl-output.json'
        for case,level,text,expected in [('missing','missing-level',(ROOT/'apps/web/demo/rc.scs').read_text(),'does not exist'),
                                         ('empty','@top','simulator lang=spectre\nR0 (in out) resistor r=1k\n','no drawable geometry')]:
            with self.subTest(case=case):
                self.put(source,text)
                report.write_text(json.dumps({'status':'passed','source_commit':'a'*40,'rnl_views':[{'library_id':'basics','cell_id':'rc-smoke','view_id':'schematic',
                    'entry':source,'files':[source],'level':level}]}))
                result=subprocess.run([node,str(ROOT/'tools/ci/rnl-check.mjs'),str(self.root),str(report),str(out)],capture_output=True,text=True,timeout=30)
                self.assertEqual(result.returncode,1,result.stderr+result.stdout)
                result=json.loads(out.read_text());self.assertEqual(result['status'],'failed');self.assertIn(expected,result['views'][0]['error'])

    def test_native_text_drawing_does_not_require_electrical_probe_hits(self):
        node=os.environ.get('NODE_BINARY') or shutil.which('node')
        if not node:self.skipTest('Set NODE_BINARY to execute bundled WASM validation')
        source='projects/rc-smoke/timing.scs';report=self.root/'rnl-input.json';out=self.root/'rnl-output.json'
        self.put(source,'simulator lang=spectre\n// @RNL(author="fixture") {\n// (0, 0) @TEXT("TIMING DIAGRAM", size=3);\n// }\n')
        report.write_text(json.dumps({'status':'passed','source_commit':'a'*40,'rnl_views':[{'library_id':'basics','cell_id':'rc-smoke',
          'view_id':'timing','entry':source,'files':[source],'level':'@top'}]}))
        result=subprocess.run([node,str(ROOT/'tools/ci/rnl-check.mjs'),str(self.root),str(report),str(out)],capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr+result.stdout)
        view=json.loads(out.read_text())['views'][0];self.assertEqual(view['status'],'passed');self.assertEqual(view['geometry_hits'],0)


class OperatorTests(unittest.TestCase):
    def setUp(self):
        self.settings={'testbenches':{'fixture':{'project_id':'project','configuration':'TRAN'}}};self.calls=[]
        outer=self
        class Service:
            def call(self, op, args):
                outer.calls.append((op,args))
                if op=='sim_status':return {'jobs':[{'run_id':'run1','source_commit':'a'*40,'project_id':'project','configuration':'TRAN'}]}
                return {'state':'pending_approval','request_id':'frozen-request'}
        self.service=Service()
    def test_submit_only_prepares_human_review_with_stable_key(self):
        one,code=perform(self.settings,'fixture','a'*40,'submit','','123',self.service)
        perform(self.settings,'fixture','a'*40,'submit','','123',self.service)
        self.assertEqual(code,10);self.assertEqual(one['status'],'blocked');self.assertFalse(one['automatic_approval'])
        self.assertEqual(self.calls[0],self.calls[1]);self.assertEqual(self.calls[0][0],'sim_submit')
    def test_collect_checks_run_identity_before_preparing(self):
        report,code=perform(self.settings,'fixture','a'*40,'collect','run1','123',self.service)
        self.assertEqual(code,10);self.assertEqual([c[0] for c in self.calls],['sim_status','sim_collect'])
    def test_wrong_source_and_unconfigured_tb_cannot_submit(self):
        with self.assertRaises(ValueError):perform(self.settings,'missing','a'*40,'submit','','123',self.service)
        with self.assertRaises(ValueError):perform(self.settings,'fixture','b'*40,'collect','run1','123',self.service)
        self.assertEqual([c[0] for c in self.calls],['sim_status'])
    def test_results_are_observed_not_scientific_pass(self):
        report,code=perform(self.settings,'fixture','a'*40,'results','run1','123',self.service)
        self.assertEqual(report['status'],'observed');self.assertEqual(report['simulation_status'],'not_evaluated')
        self.assertEqual(code,0);self.assertEqual([c[0] for c in self.calls],['sim_status','sim_results'])
    def test_collect_and_results_reject_other_or_missing_configuration(self):
        outer=self
        for operation in ('collect','results'):
            for configuration in ('OTHER',None):
                with self.subTest(operation=operation,configuration=configuration):
                    self.calls=[]
                    class Service:
                        def call(self,op,args):
                            outer.calls.append((op,args))
                            return {'jobs':[{'run_id':'run1','source_commit':'a'*40,'project_id':'project','configuration':configuration}]}
                    with self.assertRaisesRegex(ValueError,'configuration'):
                        perform(self.settings,'fixture','a'*40,operation,'run1','123',Service())
                    self.assertEqual([c[0] for c in self.calls],['sim_status'])
    def test_preflight_reports_nested_plan_blockers_even_when_tools_are_available(self):
        for blockers in (['review_required'],[]):
            with self.subTest(blockers=blockers):
                class Service:
                    def call(self,op,args):
                        self.op=op
                        return {'plan':{'blockers':blockers},'probe':{'all_tools_available':True,'identity_ok':True}}
                service=Service()
                report,code=perform(self.settings,'fixture','a'*40,'preflight','','123',service)
                self.assertEqual(service.op,'sim_preflight')
                self.assertEqual(report['blockers'],blockers)
                self.assertEqual(report['status'],'blocked' if blockers else 'checked')
                self.assertEqual(code,2 if blockers else 0);self.assertFalse(report['simulation_started'])


if __name__=='__main__':unittest.main(verbosity=2)
