"""Temporary circuit fixtures + fake Service; no model, network or simulator."""
import importlib.util
import copy
import hashlib
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

    def alias_sources(self):
        entry = 'lib/adc/TB/netlist/top.scs'
        child = 'lib/adc/Child/schematic/Child.scs'
        style = 'lib/_shared/rnl/style/eda-style.rnl'
        logical = 'lib/adc/TB/netlist/child.scs'
        self.put(entry, 'simulator lang=spectre\ninclude "child.scs"\n')
        self.put(child, '// @USE-PACKAGE(name="eda-style")\nsubckt Child a b\nR1 (a b) resistor r=1k\nends Child\n')
        self.put(style, '// synthetic drawing style\n')
        return entry, child, style, {logical: child, 'lib/adc/TB/netlist/eda-style.rnl': style}

    def test_alias_closure_resolves_logical_paths_and_reads_canonical_sources_only(self):
        entry, child, style, aliases = self.alias_sources()
        files = [entry, child, style]
        self.assertEqual(ci.closure(self.root, files, aliases, entry), [])
        self.assertFalse((self.root / 'lib/adc/TB/netlist/child.scs').exists())
        self.assertFalse((self.root / 'lib/adc/Child/schematic/eda-style.rnl').exists())
        with self.assertRaisesRegex(ValueError, 'Missing include'):
            ci.closure(self.root, files)
        self.put(child, 'include "@EXTERNAL_PDK_MAIN@"\ninclude "disciplines.vams"\n')
        self.assertEqual(ci.closure(self.root, files, aliases, entry), ['@EXTERNAL_PDK_MAIN@', 'disciplines.vams'])

    def test_alias_cycle_missing_and_all_physical_members_are_checked(self):
        entry, child, style, aliases = self.alias_sources(); files = [entry, child, style]
        self.put(child, 'include "child.scs"\n')
        with self.assertRaisesRegex(ValueError, 'Cyclic'):
            ci.closure(self.root, files, aliases, entry)
        self.put(child, 'include "absent.scs"\n')
        with self.assertRaisesRegex(ValueError, 'Missing include'):
            ci.closure(self.root, files, aliases, entry)
        self.put(child, '// restored source\n')
        with self.assertRaisesRegex(ValueError, 'Missing library file'):
            ci.closure(self.root, files + ['lib/adc/TB/unreachable.scs'], aliases, entry)
        self.put(style, '// \x00 forbidden content in an unused physical file\n')
        with self.assertRaisesRegex(ValueError, 'NUL'):
            ci.closure(self.root, files, aliases, entry)

    def test_alias_maps_reject_malicious_paths_shadows_chains_and_bad_types(self):
        entry, child, style, aliases = self.alias_sources(); files = [entry, child, style]
        for mapping in ([], {entry: child}, {**aliases, child: entry}, {'lib/adc/TB/v.scs': 'lib/adc/TB/other-virtual.scs'},
                        {'lib/adc/../escape.scs': child}, {'lib/adc/TB/%2e%2e.scs': child}, {entry: []}):
            with self.subTest(mapping=mapping), self.assertRaises(ValueError):
                ci.closure(self.root, files, mapping, entry)
        for ref in ('/private/model.scs', 'https://fixture.invalid/model.scs', '$(touch sentinel).scs', 'x%2fsecret.scs'):
            self.put(child, 'include "' + ref + '"\n')
            with self.subTest(ref=ref), self.assertRaisesRegex(ValueError, 'Nonportable'):
                ci.closure(self.root, files, aliases, entry)

    def test_shared_child_changes_affect_parent_ci_and_preserve_aliases_in_rnl_report(self):
        entry, child, style, aliases = self.alias_sources()
        manifest = json.loads((self.root / 'lib/adc/library.json').read_text())
        cell = manifest['cells'][0]
        cell['views'][0].update(kind='rnl', files=[entry, child, style], aliases=aliases)
        cell['views'][1].update(files=[cell['views'][1]['entry'], entry, child, style], aliases=aliases)
        self.put('lib/adc/Child/README.md', 'Synthetic shared child.')
        manifest['cells'].append({'id': 'Child', 'directory': 'lib/adc/Child', 'readme': 'lib/adc/Child/README.md',
                                 'kind': 'circuit', 'project_id': None, 'requires_external_models': False,
                                 'views': [{'id': 'netlist', 'kind': 'spectre', 'entry': child,
                                            'files': [child, style], 'aliases': {'lib/adc/Child/schematic/eda-style.rnl': style}}]})
        self.json('lib/adc/library.json', manifest)
        self.select('adc', 'TB', ['adc-test'])
        first = next(row for row in self.run_ci()['testbenches'] if row['id'] == 'adc-test')
        self.git('init', '-q'); base = self.commit()
        self.put(child, (self.root / child).read_text().replace('r=1k', 'r=2k')); head = self.commit()
        changed = self.run_ci(base=base, head=head)
        self.assertEqual(changed['status'], 'passed', changed['errors'])
        self.assertEqual([row['cell_id'] for row in changed['rnl_views']], ['TB'])
        self.assertEqual(changed['rnl_views'][0]['aliases'], aliases)
        self.assertEqual([row['id'] for row in changed['testbenches']], ['adc-test'])
        self.assertNotEqual(changed['testbenches'][0]['input_hashes'][child], first['input_hashes'][child])
        self.assertFalse(changed['simulation_started'])

    def test_alias_entry_is_required_and_unreachable_context_does_not_invent_dependencies(self):
        entry, child, style, aliases = self.alias_sources(); files = [entry, child, style]
        with self.assertRaisesRegex(ValueError, 'physical entry'):
            ci.closure(self.root, files, aliases)
        extra = 'lib/adc/TB/unused/assembly.scs'
        self.put(extra, 'include "relative-only-in-another-context.scs"\n')
        self.assertEqual(ci.closure(self.root, files + [extra], aliases, entry), [])
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


class DirectOperatorTests(unittest.TestCase):
    class Failure(Exception):
        def __init__(self, code, details=None):
            super().__init__('Synthetic private runtime diagnostic')
            self.code, self.details = code, details or {}

    def setUp(self):
        self.settings = {'execution_mode': 'direct', 'testbenches': {'fixture': {'project_id': 'project', 'configuration': 'TRAN'}}}
        outer = self
        class Service:
            def __init__(self):
                self.config = {'simulation_direct': {'enabled': True, 'callers': ['native-agent'], 'projects': ['project'], 'operations': ['submit', 'collect']}}
                self.calls, self.direct_calls, self.receipts = [], [], {}
                self.dispatches = 0
                self.result = {'state': 'accepted', 'result': {'state': 'submitted', 'run_id': 'run1'}, 'authorization_basis': 'installed_connection_grant'}
                self.failure = None
                self.interrupt_after_dispatch = False
            def call(self, operation, arguments):
                self.calls.append((operation, copy.deepcopy(arguments)))
                if operation == 'sim_status': return {'jobs': [{'run_id': 'run1', 'source_commit': 'a'*40, 'project_id': 'project', 'configuration': 'TRAN'}]}
                if operation == 'sim_results': return {'state': 'not_collected'}
                if operation == 'sim_plan': return {'blockers': []}
                if operation == 'sim_preflight': return {'plan': {'blockers': []}, 'probe': {'all_tools_available': True}}
                raise AssertionError('Direct mode must not prepare manual requests or resolve approvals')
            def execute_simulation(self, operation, arguments, key, *, caller_id):
                self.direct_calls.append((operation, copy.deepcopy(arguments), key, caller_id))
                grant = self.config['simulation_direct']
                if not (grant['enabled'] is True and caller_id in grant['callers'] and arguments['project_id'] in grant['projects'] and operation in grant['operations']):
                    raise outer.Failure('forbidden')
                if self.failure: raise self.failure
                if key in self.receipts: return self.receipts[key]
                self.dispatches += 1
                result = {**copy.deepcopy(self.result), 'request_id': 'request-' + key[-12:], 'fingerprint': 'f'*64, 'automatic_retry': False}
                self.receipts[key] = result
                if self.interrupt_after_dispatch:
                    result['state'] = 'authorized_dispatching'
                    raise RuntimeError('Synthetic interruption after the durable dispatch claim')
                return result
        self.service = Service()

    def perform(self, operation='submit', run_id='', invocation='123'):
        return perform(self.settings, 'fixture', 'a'*40, operation, run_id, invocation, self.service)

    def test_direct_submit_uses_existing_service_grant_and_original_stable_key(self):
        first, code = self.perform(); second, second_code = self.perform()
        self.assertEqual((code, second_code), (0, 0))
        self.assertEqual(first, second)
        expected = 'github-ci-' + hashlib.sha256(json.dumps(['123', 'fixture', 'a'*40, 'submit', '']).encode()).hexdigest()
        self.assertEqual(self.service.direct_calls[0], ('submit', {'project_id': 'project', 'configuration': 'TRAN', 'source_commit': 'a'*40}, expected, 'native-agent'))
        self.assertEqual(self.service.dispatches, 1)
        self.assertEqual(self.service.calls, [])
        self.assertEqual(first['status'], 'accepted')
        self.assertEqual(first['idempotency_key'], expected)
        self.assertEqual(first['simulation_status'], 'not_evaluated')
        self.assertIsNone(first['simulation_started'])
        self.assertFalse(first['automatic_approval']); self.assertFalse(first['automatic_retry'])

    def test_collect_passes_full_run_identity_to_the_direct_service(self):
        self.service.result['result'] = {'state': 'collecting', 'run_id': 'run1'}
        report, code = self.perform('collect', 'run1')
        self.assertEqual(code, 0)
        self.assertEqual(self.service.direct_calls[0][1], {'project_id': 'project', 'configuration': 'TRAN', 'source_commit': 'a'*40, 'run_id': 'run1'})
        self.assertEqual(self.service.calls, [])
        self.assertEqual(report['result_state'], 'collecting')
        self.assertEqual(report['simulation_status'], 'not_evaluated')
        self.assertEqual(report['run_id'], 'run1')
        with self.assertRaises(ValueError): self.perform('collect', '')

    def test_disabled_or_mismatched_service_scope_blocks_without_config_changes_or_fallback(self):
        original = copy.deepcopy(self.service.config['simulation_direct'])
        for field, value in (('enabled', False), ('callers', ['paired-helper']), ('projects', ['other']), ('operations', ['status'])):
            self.service.config['simulation_direct'] = {**copy.deepcopy(original), field: value}
            before = copy.deepcopy(self.service.config)
            report, code = self.perform()
            self.assertEqual((report['status'], report['state'], code), ('blocked', 'rejected', 2))
            self.assertEqual(self.service.config, before)
            self.assertEqual(self.service.dispatches, 0)
            self.assertEqual(self.service.calls, [])

    def test_pending_unknown_partial_and_rejected_receipts_preserve_identity_without_replay(self):
        for index, state in enumerate(('unknown', 'uncertain', 'partial', 'authorized_dispatching', 'pending_approval', 'rejected')):
            self.service.result = {'state': state}
            report, code = self.perform(invocation=str(200 + index))
            repeated, again = self.perform(invocation=str(200 + index))
            self.assertEqual((code, again), (10, 10))
            self.assertEqual(report, repeated)
            self.assertEqual(report['state'], state)
            self.assertEqual(report['status'], 'blocked')
            self.assertIsNotNone(report['request_id'])
            self.assertFalse(report['automatic_retry'])
        self.assertEqual(self.service.dispatches, 6)
        self.assertEqual(self.service.calls, [])

    def test_nested_unknown_partial_or_identity_mismatch_override_transport_acceptance(self):
        values = [{'state': 'partial'}, {'state': 'launch_outcome_unknown'}, {'state': 'reconcile_required'},
                  {'state': 'complete', 'status': 'uncertain'}, {'state': 'complete', 'source_commit': 'b'*40},
                  {'state': 'complete', 'configuration_id': 'OTHER'}, {'state': {}}, {'state': 'complete', 'status': {}}, {'ok': False}]
        for index, result in enumerate(values):
            self.service.result = {'state': 'accepted', 'result': result}
            report, code = self.perform(invocation=str(300 + index))
            self.assertEqual((report['status'], code), ('blocked', 10), result)
            self.assertEqual(report['state'], 'accepted')
        self.service.result = {'state': 'accepted', 'result': {'state': 'complete', 'run_id': 'wrong-run'}}
        self.assertEqual(self.perform('collect', 'run1')[1], 10)

    def test_only_explicit_service_success_states_report_request_accepted(self):
        for index, state in enumerate(('complete', 'succeeded', 'accepted')):
            self.service.result = {'state': state, 'result': {'state': 'complete'}}
            report, code = self.perform(invocation=str(400 + index))
            self.assertEqual((report['status'], code), ('accepted', 0))
            self.assertEqual(report['simulation_status'], 'not_evaluated')
        self.service.result = {'state': 'submitted'}
        self.assertEqual(self.perform()[1], 10)

    def test_interruption_retains_key_and_reconciliation_reads_original_durable_claim(self):
        self.service.interrupt_after_dispatch = True
        first, code = self.perform()
        self.assertEqual((first['status'], first['state'], code), ('blocked', 'unknown', 10))
        self.assertIsNone(first['simulation_started'])
        second, code = self.perform()
        self.assertEqual(second['idempotency_key'], first['idempotency_key'])
        self.assertEqual((second['state'], code), ('authorized_dispatching', 10))
        self.assertEqual(self.service.dispatches, 1)
        self.assertEqual(self.service.calls, [])

    def test_prior_request_and_safe_receipt_projection_do_not_expose_private_runtime_data(self):
        self.service.failure = self.Failure('unresolved_prior_request', {'request_id': 'original-request', 'private_path': '/home/fixture/private'})
        report, code = self.perform()
        self.assertEqual((report['request_id'], code), ('original-request', 10))
        self.assertNotIn('/home/fixture', json.dumps(report))
        self.service.failure = None
        self.service.result.update(gateway='http://private-gateway.invalid', result={'state': 'submitted', 'ssh_target': 'secret-host', 'private_path': '/private/license'})
        report, code = self.perform()
        self.assertEqual(code, 0)
        for secret in ('private-gateway', 'secret-host', '/private/license'): self.assertNotIn(secret, json.dumps(report))
        self.assertEqual(report['fingerprint'], 'f'*64)

    def test_missing_direct_capability_blocks_without_using_manual_request(self):
        self.service.execute_simulation = None
        report, code = self.perform()
        self.assertEqual((report['state'], code), ('unavailable', 2))
        self.assertEqual(self.service.calls, [])
        self.assertFalse(report['simulation_started'])

    def test_read_operations_keep_existing_flows_in_direct_mode(self):
        for operation in ('plan', 'preflight'):
            report, code = self.perform(operation)
            self.assertEqual((report['status'], code), ('checked', 0))
        report, code = self.perform('results', 'run1')
        self.assertEqual((report['status'], code), ('observed', 0))
        self.assertEqual([call[0] for call in self.service.calls], ['sim_plan', 'sim_preflight', 'sim_status', 'sim_results'])
        self.assertEqual(self.service.direct_calls, [])

    def test_trusted_settings_accept_explicit_mode_and_reject_unknown_or_writable_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'ci.local.json'
            settings = {'schema': 'circuitgit.spectre-ci.v1', 'client_config': str(Path(tmp) / 'client.local.json'),
                        'testbenches': self.settings['testbenches']}
            path.write_text(json.dumps(settings)); path.chmod(0o600)
            self.assertNotIn('execution_mode', load_settings(path))
            settings['execution_mode'] = 'direct'; path.write_text(json.dumps(settings))
            self.assertEqual(load_settings(path)['execution_mode'], 'direct')
            settings['execution_mode'] = 'auto-approve'; path.write_text(json.dumps(settings))
            with self.assertRaises(ValueError): load_settings(path)
            if os.name != 'nt':
                settings['execution_mode'] = 'direct'; path.write_text(json.dumps(settings)); path.chmod(0o666)
                with self.assertRaises(ValueError): load_settings(path)


if __name__=='__main__':unittest.main(verbosity=2)
