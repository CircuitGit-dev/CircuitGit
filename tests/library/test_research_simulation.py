"""Research bundles compiled from exact temporary Git inputs; no remote access."""
import copy
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/workbench'))
import ic_sim
import library_sources
import local_inputs
import workspace
from test_projects import registered_inputs


class ResearchSimulationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog=json.loads((ROOT/'config/workbench.projects.json').read_text())
        cls.projects=[p for p in cls.catalog if p.get('library_id')=='pipetisar-research']
        cls.temp=tempfile.TemporaryDirectory(prefix='research-inputs-');cls.seed=Path(cls.temp.name)/'seed';cls.seed.mkdir()
        for name in registered_inputs(ROOT,cls.catalog):
            dest=cls.seed/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,dest)
        # Byte-exact copies and clones, as under core.autocrlf=false; source hashes are compared.
        (cls.seed/'.gitattributes').write_bytes(b'* -text\n')
        subprocess.run(['git','init','-b','main',str(cls.seed)],check=True,capture_output=True)
        workspace.git(cls.seed,'add','.')
        workspace.git(cls.seed,'-c','user.name=Research fixture','-c','user.email=fixture@localhost','commit','-m','Pinned research inputs')
        cls.commit=workspace.git(cls.seed,'rev-parse','HEAD').stdout.decode().strip()
        cls.ws=workspace.Workspace.__new__(workspace.Workspace);cls.ws.root=cls.seed;cls.ws.source_repository=cls.seed
        cls.ws.projects={p['id']:p for p in cls.catalog}
        cls.no_remote=patch.object(ic_sim,'ssh',side_effect=AssertionError('Remote call prohibited'))
        cls.no_remote.start()

    @classmethod
    def tearDownClass(cls):cls.no_remote.stop();cls.temp.cleanup()

    def cases(self):
        for project in self.projects:
            for config in project['configurations']:yield project,config

    def test_registry_and_manifest_coverage_is_three_real_configurations(self):
        actual={(p['cell_id'],c['id']) for p,c in self.cases()}
        self.assertEqual(actual,{('TB_PIPE_CA4_RS9_N06','PIPE_LOW'),('TB_PIPE_CA4_RS9_N06','PIPE_NYQUIST'),('TB_MDAC_CA4_N06','MDAC_CODES')})
        manifest=json.loads((ROOT/'lib/pipetisar-research/library.json').read_text());cells={c['id']:c for c in manifest['cells']}
        registry=json.loads((ROOT/'config/library-testbenches.json').read_text())['testbenches']
        for p,c in self.cases():
            self.assertEqual(cells[p['cell_id']]['project_id'],p['id'])
            files={f for v in cells[p['cell_id']]['views'] for f in v['files']}
            for name in [c['bundle_template'],c['configuration_path'],c['canonical_bindings_path']]:self.assertIn(name,files)
            row=next(r for r in registry if r['configuration_path']==c['configuration_path']);self.assertTrue(row['available'])

    def test_all_registered_configurations_compile_without_models_or_site(self):
        for p in self.catalog:
            for c in p['configurations']:
                with self.subTest(project=p['id'],configuration=c['id']):
                    bundle,files,sources=self.ws.compile_inputs(p,c,self.commit)
                    result=local_inputs.validate(bundle,files)
                    self.assertTrue(result['source_closure_valid']);self.assertFalse(result['simulation_started'])
                    self.assertEqual(result['unpinned_remote_aliases'],[])
                    for name in sources:self.assertEqual(sources[name],ic_sim.sha(workspace.git(self.seed,'show',self.commit+':'+name).stdout))

    def test_provenance_audits_parameters_va_and_removed_models_are_honest(self):
        for p,c in self.cases():
            folder=(ROOT/c['bundle_template']).parent
            original=json.loads((folder/'configuration.json').read_text());runtime=json.loads((ROOT/c['configuration_path']).read_text())
            self.assertEqual({k:v for k,v in original.items() if k!='description'},{k:v for k,v in runtime.items() if k!='description'})
            provenance=json.loads((folder/'provenance.json').read_text());audit=json.loads((folder/'audit.json').read_text())
            self.assertEqual(provenance['source_sha256'],audit['source_sha256']);self.assertEqual(provenance['design_sha256'],audit['design_sha256'])
            self.assertEqual(provenance['configuration_sha256'],ic_sim.sha((folder/'configuration.json').read_bytes()))
            self.assertEqual(provenance['audit_sha256'],ic_sim.sha((folder/'audit.json').read_bytes()))
            self.assertFalse(provenance['simulation_executed']);self.assertFalse(provenance['published_bytes_are_original'])
            bundle,files,sources=self.ws.compile_inputs(p,c,self.commit)
            self.assertEqual(bundle['configuration']['effective_parameters'],audit['parameters_observed'])
            self.assertEqual({row['module'] for row in provenance['veriloga']},set(audit['project_veriloga_dependencies']))
            for row in provenance['veriloga']:
                self.assertEqual(ic_sim.sha(files['netlist/models/'+row['module']+'.va']),row['sha256'])
                self.assertFalse(row['historical_run_revision_verified'])
            self.assertEqual({Path(row['source']).name for row in provenance['local_dependencies']},
                             {p['cell_id']+'_save.scs','numerical_options.scs'})
            for row in provenance['local_dependencies']:
                self.assertEqual(ic_sim.sha(files['netlist/'+Path(row['source']).name]),row['sha256'])
                self.assertEqual(row['revision_basis'],'selected-local-snapshot')
                self.assertFalse(row['historical_run_revision_verified'])
            self.assertEqual(sources[p['source_path']],ic_sim.sha((self.seed/p['source_path']).read_bytes()))
            self.assertNotIn(p['source_path'],provenance['canonical_sources'])
            for raw in files.values():
                self.assertNotRegex(raw.decode(),r'/(?:home|Users|server_local_ssd)/')
                self.assertNotRegex(raw.decode(),r'(?mi)^\s*subckt\s+\S*(?:BWP|trans_ulvt_mac_pcell)')
            expected=23 if p['cell_id'].startswith('TB_PIPE') else 5
            report=bundle['configuration']['canonical_sources'];self.assertEqual(len(report['subcircuits']),expected)
            self.assertTrue(all(r['baseline_equivalent'] for r in report['subcircuits']))
            self.assertEqual(len(report['electrical_guards']),1)
            self.assertEqual(report['electrical_guards'][0]['source'],p['source_path'])
            self.assertTrue(report['electrical_guards'][0]['electrical_unchanged'])

    def test_testbench_electrical_edits_fail_instead_of_silently_using_old_template(self):
        for p,c in self.cases():
            raw=(self.seed/p['source_path']).read_bytes()
            changed,count=re.subn(rb'(vsource\s+[^\n]*?dc=)([^\s]+)',rb'\g<1>0.98765',raw,count=1)
            self.assertEqual(count,1)
            with self.subTest(configuration=c['id']),self.assertRaisesRegex(ValueError,'testbench electrical source changed.*update explicit TB binding and input template'):
                self.ws.compile_inputs(p,c,self.commit,{p['source_path']:changed})

    def test_testbench_drawing_edits_record_source_without_changing_simulation(self):
        for p,c in self.cases():
            _,before,_=self.ws.compile_inputs(p,c,self.commit)
            raw=(self.seed/p['source_path']).read_bytes()
            changed,count=re.subn(rb'(//[^\n]*@PLACE\()[-0-9.]+',rb'\g<1>123.456',raw,count=1)
            self.assertEqual(count,1)
            bundle,after,sources=self.ws.compile_inputs(p,c,self.commit,{p['source_path']:changed})
            self.assertEqual(before,after);self.assertEqual(sources[p['source_path']],ic_sim.sha(changed))
            self.assertTrue(bundle['configuration']['canonical_sources']['electrical_guards'][0]['non_electrical_modified'])

    def test_committed_testbench_change_cannot_materialize_a_stale_bundle(self):
        with tempfile.TemporaryDirectory(prefix='research-guard-') as tmp:
            repo=Path(tmp)/'source'
            subprocess.run(['git','clone','--local','--no-hardlinks',str(self.seed),str(repo)],check=True,capture_output=True)
            for p in self.projects:
                path=repo/p['source_path'];raw=path.read_bytes()
                changed,count=re.subn(rb'(vsource\s+[^\n]*?dc=)([^\s]+)',rb'\g<1>0.98765',raw,count=1)
                self.assertEqual(count,1);path.write_bytes(changed)
            workspace.git(repo,'add','lib')
            workspace.git(repo,'-c','user.name=Guard fixture','-c','user.email=fixture@localhost','commit','-m','Change testbench voltage')
            commit=workspace.git(repo,'rev-parse','HEAD').stdout.decode().strip()
            ws=workspace.Workspace.__new__(workspace.Workspace);ws.root=repo;ws.source_repository=repo;ws.projects=self.ws.projects
            ws.runtime=Path(tmp)/'runtime';ws.runtime.mkdir();ws.frozen=Path(tmp)/'frozen';ws.frozen.mkdir();ws.key=b'guard fixture'
            for p,c in self.cases():
                with self.subTest(configuration=c['id']),self.assertRaisesRegex(ValueError,'testbench electrical source changed'):
                    ws.materialize(p['id'],c['id'],commit)
            self.assertEqual(list(ws.frozen.iterdir()),[])

    def test_every_bound_child_changes_the_compiled_hash_in_each_configuration(self):
        for p,c in self.cases():
            _,initial,_=self.ws.compile_inputs(p,c,self.commit)
            bindings=json.loads((ROOT/c['canonical_bindings_path']).read_text())
            for row in bindings['subcircuits']:
                with self.subTest(configuration=c['id'],child=row['source_subcircuit']):
                    self.assertTrue(row['source'].startswith('lib/pipetisar-research/'))
                    raw=(self.seed/row['source']).read_bytes();text=raw.decode();block=library_sources.electrical_blocks(raw)[row['source_subcircuit']]
                    segment=text[block.start:block.end]
                    assignment=re.search(r'\b[A-Za-z_][A-Za-z0-9_]*=([^\s\\]+)','\n'.join(block.statements[1:-1]))
                    if assignment:segment=segment.replace(assignment[0],assignment[0]+'*1.01',1)
                    else:
                        line=next(line for line in block.statements[1:-1] if '(' in line);name=line.split()[0]
                        m=re.search(r'(?m)^(\s*'+re.escape(name)+r'\s*\()([^)]*)(\))',segment)
                        nodes=re.sub(r'\\\s*\n\s*',' ',m[2]).split();other=next(i for i,v in enumerate(nodes) if v!=nodes[0]);nodes[0],nodes[other]=nodes[other],nodes[0]
                        segment=segment[:m.start(2)]+' '.join(nodes)+segment[m.end(2):]
                    changed=(text[:block.start]+segment+text[block.end:]).encode()
                    _,compiled,sources=self.ws.compile_inputs(p,c,self.commit,{row['source']:changed})
                    self.assertNotEqual(ic_sim.sha(compiled['netlist/project.scs']),ic_sim.sha(initial['netlist/project.scs']))
                    self.assertEqual(sources[row['source']],ic_sim.sha(changed))

    def test_wrong_library_binding_is_rejected_without_fallback(self):
        for p,c in self.cases():
            bindings=json.loads((ROOT/c['canonical_bindings_path']).read_text());bindings=copy.deepcopy(bindings)
            row=bindings['subcircuits'][0];row['source']=row['source'].replace('/pipetisar-research/','/pipetisar-real/')
            with self.assertRaisesRegex(ValueError,'native library'):
                self.ws.compile_inputs(p,c,self.commit,{c['canonical_bindings_path']:json.dumps(bindings).encode()})


if __name__=='__main__':unittest.main()
