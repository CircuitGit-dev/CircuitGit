"""Focused actual compiler/preview/commit/plan tests. No SSH or simulator calls."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2]
REPO=ROOT
sys.path.insert(0,str(REPO/'tools/workbench'))
import configuration as cfg
import ic_sim
import runner
import workspace

BASE='3e104409ed07fe4db3105bb827f838369cfe0a72'

class ConfigurationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog=json.loads((REPO/'config/workbench.projects.json').read_text())
        cls.ws=workspace.Workspace.__new__(workspace.Workspace)
        cls.ws.root=REPO
        cls.ws.projects={p['id']:p for p in cls.catalog}
        cls.no_ssh=patch.object(ic_sim,'ssh',side_effect=AssertionError('SSH is forbidden in configuration tests'))
        cls.no_ssh.start()
    @classmethod
    def tearDownClass(cls):cls.no_ssh.stop()
    def compile(self,conf=None,pid='real-sar-20261106',cid='PIPE_LOW',extra=None):
        p,c=self.ws.select(pid,cid)
        overrides=dict(extra or {})
        if conf is not None:overrides[c['configuration_path']]=json.dumps(conf).encode()
        return self.ws.compile_inputs(p,c,BASE,overrides)
    def conf(self,pid='real-sar-20261106',cid='PIPE_LOW'):
        p,c=self.ws.select(pid,cid)
        return json.loads(self.ws.blob(BASE,c['configuration_path']))
    def test_inherited_three_configs_keep_every_original_staged_byte(self):
        for p in self.catalog:
            for c in p['configurations']:
                with self.subTest(c=c['id']):
                    b,files,_=self.ws.compile_inputs(p,c,BASE)
                    template=json.loads(self.ws.blob(BASE,c['bundle_template']))
                    prefix=str(Path(c['bundle_template']).parent/Path(template['source_root']))
                    expected={row['destination']:self.ws.blob(BASE,str(Path(prefix)/row['source'])) for row in template['files']}
                    for row in c['source_replacements']:expected[row['destination']]=self.ws.blob(BASE,row['source'])
                    self.assertEqual(files,expected)
                    self.assertEqual(b['configuration']['effective']['raw_save']['mode'],'inherit')
    def test_actual_defaults_and_resolved_time(self):
        b,files,_=self.compile();e=b['configuration']['effective'];idx=cfg.scan(files,b['entrypoint'])
        self.assertEqual(len(e['raw_save']['effective']['signals']),125)
        self.assertAlmostEqual(e['tran']['values_si']['stop'],24e-9)
        self.assertAlmostEqual(e['tran']['values_si']['maxstep'],2e-12)
        self.assertEqual(idx['instances']['VDD0']['master'],'vsource')
        self.assertIn('XDUT.XSARA.EOC',idx['nets'])
        self.assertFalse(e['raw_save']['effective']['unresolved_directives'])
    def test_append_is_actual_derived_save_and_keeps_defaults(self):
        conf=self.conf();conf['save']={'mode':'append','signals':[{'kind':'voltage','path':'VDD'}]}
        b,files,_=self.compile(conf)
        self.assertIn(b'save VDD\n',files[cfg.SAVE_FILE])
        self.assertIn(b'include "icwb-save.scs"',files[b['entrypoint']])
        self.assertEqual(len(b['configuration']['effective']['raw_save']['effective']['signals']),126)
        self.assertEqual(b['postprocess'],conf['postprocess'])
    def test_replace_voltage_and_explicit_current(self):
        conf=self.conf();conf['save']={'mode':'replace','signals':[{'kind':'voltage','path':'VINP'},{'kind':'current','instance':'VDD0','terminal':'p'}]}
        conf['postprocess']['signals']=[{'name':'VINP','unit':'V'},{'name':'VDD0:p','unit':'A'}]
        b,files,_=self.compile(conf)
        self.assertEqual({s['spectre'] for s in b['configuration']['effective']['raw_save']['effective']['signals']},{'VINP','VDD0:p'})
        self.assertIn(b'save=selected',files[cfg.SAVE_FILE])
        self.assertNotIn(b'save XDUT.',files[b['entrypoint']])
        self.assertEqual(len(b['configuration']['effective']['raw_save']['inherited']['signals']),125)
    def test_replace_rejects_postprocess_not_saved(self):
        conf=self.conf();conf['save']={'mode':'replace','signals':[{'kind':'voltage','path':'VINP'}]}
        with self.assertRaisesRegex(ValueError,'postprocess signals'):self.compile(conf)
    def test_current_only_replace_rejected(self):
        conf=self.conf();conf['save']={'mode':'replace','signals':[{'kind':'current','instance':'VDD0','terminal':'p'}]}
        with self.assertRaisesRegex(ValueError,'voltage'):self.compile(conf)
    def test_invalid_identities_and_code_cannot_be_saved(self):
        for target in [{'kind':'voltage','path':'VINP\nshell x'}, {'kind':'voltage','path':'*'}, {'kind':'voltage','path':'research.VINP'}, {'kind':'current','instance':'VDD0','terminal':'d'}, {'kind':'current','instance':'VDD0'}, {'kind':'voltage','path':'VINP','code':'save all'}]:
            with self.subTest(target=target):
                conf=self.conf();conf['save']={'mode':'append','signals':[target]}
                with self.assertRaises(ValueError):self.compile(conf)
    def test_duplicate_alias_and_selection_limit(self):
        conf=self.conf();conf['save']={'mode':'append','signals':[{'kind':'current','instance':'VDD0','terminal':t} for t in ['p','1']]}
        with self.assertRaisesRegex(ValueError,'duplicate'):self.compile(conf)
        conf['save']['signals']=[{'kind':'voltage','path':'VINP'}]*257
        with self.assertRaisesRegex(ValueError,'1..256'):self.compile(conf)
    def test_bus_is_encoded_from_actual_source_token(self):
        conf=self.conf();conf['save']={'mode':'append','signals':[{'kind':'voltage','path':'CODE<0>'}]}
        _,files,_=self.compile(conf)
        self.assertIn(b'save CODE\\<0\\>',files[cfg.SAVE_FILE])
    def test_unknown_and_duplicate_config_fields_fail_without_loss(self):
        for raw in [b'{"future":1}',b'{"parameters":{},"parameters":{}}',b'{"save":null}',b'{"simulator":{"future":1}}',b'{"analysis":{"stop":true}}',b'{"parameters":{"N":NaN}}']:
            with self.subTest(raw=raw),self.assertRaises(ValueError):cfg.load_configuration(raw)
    def test_unresolved_legacy_save_is_visible_and_blocks_replace(self):
        p,c=self.ws.select('rc-smoke','TRAN')
        original=self.ws.blob(BASE,p['source_path'])+b'\nsave out*\n'
        b,_,_=self.compile(pid=p['id'],cid=c['id'],extra={p['source_path']:original})
        self.assertTrue(b['configuration']['effective']['raw_save']['effective']['unresolved_directives'])
        conf=self.conf(p['id'],c['id']);conf['save']={'mode':'replace','signals':[{'kind':'voltage','path':'out'}]};conf['postprocess']=None
        with self.assertRaisesRegex(ValueError,'replace cannot'):self.compile(conf,p['id'],c['id'],{p['source_path']:original})
    def test_arithmetic_is_display_only_and_cannot_execute_code(self):
        self.assertAlmostEqual(cfg.numeric('4n+(16+4)*1n',{}),24e-9)
        self.assertIsNone(cfg.numeric('__import__("os").system("x")',{}))
        self.assertIsNone(cfg.numeric('A',{'A':'B','B':'A'}))
    def test_preview_commit_plan_share_actual_compiled_hashes(self):
        with tempfile.TemporaryDirectory(prefix='config-workflow-') as tmp:
            tmp=Path(tmp).resolve()
            # Data checkout is isolated; imported compiler is the candidate.
            import subprocess
            subprocess.run(['git','clone','--shared',str(REPO),str(tmp/'workspace')],check=True,capture_output=True)
            w=workspace.Workspace.__new__(workspace.Workspace);w.root=tmp/'workspace';w.runtime=tmp;w.frozen=tmp/'frozen';w.frozen.mkdir();w.projects={p['id']:p for p in self.catalog};w.key=b'configuration-test';w.site=ic_sim.site_load(REPO/'config/site.example.json');w.branch='codex/config-test'
            w.allowed={v for p in self.catalog for v in [p['source_path'],*p.get('read_paths',[]),*[c['configuration_path'] for c in p['configurations']]]}
            p,c=w.select('real-sar-20261106','PIPE_LOW');raw=w.file(c['configuration_path']);conf=json.loads(raw['content'])
            conf['parameters']['N']=32;conf['analysis']['maxstep']='4p';conf['save']={'mode':'append','signals':[{'kind':'voltage','path':'VDD'}]}
            body={'base_commit':w.head(),'changes':[{'path':raw['path'],'sha256':raw['sha256'],'content':json.dumps(conf,indent=2)+'\n'}]}
            preview=w.preview(body['base_commit'],body['changes']);before=next(x['effective'] for x in preview['configuration_previews'] if x['project_id']==p['id'] and x['configuration']==c['id'])
            self.assertAlmostEqual(before['tran']['values_si']['stop'],40e-9)
            saved=w.commit(body['base_commit'],body['changes'],message='Isolated configuration workflow',push=False)
            desc=w.configuration_description(p['id'],c['id'],saved['source_commit'])
            frozen=w.materialize(p['id'],c['id'],saved['source_commit']);r=runner.Runner(tmp/'runs',w.site,w.frozen,w.key);plan=r.plan(frozen,saved['source_commit'])
            self.assertEqual(before,desc['effective']);self.assertEqual(before,plan['configuration']['effective']);self.assertEqual(plan['blockers'],[])
            self.assertFalse(r.list())
            with self.assertRaises(workspace.Conflict):w.configuration_description(p['id'],c['id'],body['base_commit'])
            evidence=tmp/'evidence';evidence.mkdir(exist_ok=True)
            (evidence/'compiled-workflow.json').write_text(json.dumps({'schema':'ic.sim.configuration-test.v1','status':'passed','configuration':conf,'preview_compiled_inputs_sha256':before['compiled_inputs_sha256'],'plan_compiled_inputs_sha256':plan['configuration']['effective']['compiled_inputs_sha256'],'postprocess':plan['postprocess'],'effective':before,'fixture_source_commit':saved['source_commit'],'remote_calls':0,'runs_created':0},indent=2)+'\n')

if __name__=='__main__':unittest.main(verbosity=2)
