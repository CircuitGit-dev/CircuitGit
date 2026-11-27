"""Compile the shipped project configurations without SSH or a simulator."""
import json, pathlib, shutil, subprocess, tempfile, unittest
import ic_sim, runner, workspace

def registered_inputs(repo,catalog):
    inputs=set()
    for project in catalog:
        inputs.update([project['source_path'],*project.get('read_paths',[])])
        for config in project['configurations']:
            inputs.update([config['configuration_path'],config['bundle_template']])
            inputs.update(row['source'] for row in config.get('source_replacements',[]))
            template=repo/config['bundle_template'];bundle=json.loads(template.read_text())
            for row in bundle['files']:
                path=(template.parent/bundle['source_root']/row['source']).resolve()
                if not path.is_relative_to(repo):raise ValueError('Fixture input escapes repository')
                inputs.add(str(path.relative_to(repo)))
            if config.get('canonical_bindings_path'):
                inputs.add(config['canonical_bindings_path'])
                bindings=json.loads((repo/config['canonical_bindings_path']).read_text())
                inputs.update(row['source'] for row in bindings['subcircuits'])
                inputs.update(row['source'] for row in bindings.get('electrical_guards',[]))
                inputs.update(row['template_source'] for row in bindings['targets'].values())
    return inputs

class ProjectCompilationTests(unittest.TestCase):
    def test_all_shipped_sources_configs_and_postprocess_are_pinned(self):
        repo=pathlib.Path(__file__).resolve().parents[2]
        catalog=json.loads((repo/'config/workbench.projects.json').read_text())
        site=ic_sim.site_load(repo/'config/site.example.json')
        with tempfile.TemporaryDirectory() as tmp:
            tmp=pathlib.Path(tmp);seed=tmp/'seed';seed.mkdir()
            # Copy only explicitly registered inputs; public builds may omit legacy sim/.
            inputs=registered_inputs(repo,catalog)
            # Placeholder paths exercise planning only; no model file or remote
            # server is accessed by this isolated fixture.
            for project in catalog:
                for config in project['configurations']:
                    template=json.loads((repo/config['bundle_template']).read_text())
                    for alias in ic_sim.external_pins(template):site['external_files'][alias]='/fixture/external/'+alias+'.scs'
            for relative in sorted(inputs):
                source=repo/relative
                self.assertFalse(source.is_symlink())
                target=seed/relative;target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copy2(source,target)
            # Byte-exact seed and runtime clone, as under core.autocrlf=false; source hashes are compared.
            (seed/'.gitattributes').write_bytes(b'* -text\n')
            subprocess.run(['git','init','-b','main',str(seed)],check=True,capture_output=True)
            workspace.git(seed,'add','.')
            workspace.git(seed,'-c','user.name=Project Test','-c','user.email=test@localhost','commit','-m','project fixtures')
            cfg={'github_repo':'example/private-circuits','seed_repo':str(seed),'runtime_root':str(tmp/'runtime'),'base_branch':'main','runtime_branch':'codex/test-projects','projects':catalog}
            key=b'project compilation test';ws=workspace.Workspace(cfg,site,key)
            run=runner.Runner(tmp/'runs',site,ws.frozen,key)
            for p in catalog:
                for c in p['configurations']:
                    with self.subTest(project=p['id'],configuration=c['id']):
                        source=ws.file(p['source_path'])
                        bundle=ws.materialize(p['id'],c['id'],ws.head())
                        plan=run.plan(bundle,ws.head());self.assertEqual(plan['blockers'],[])
                        config=json.loads(ws.file(c['configuration_path'])['content'])
                        self.assertEqual(plan['postprocess'],config['postprocess'])
                        binding=json.loads((bundle.parent/'materialization.json').read_text())['data']
                        if c.get('canonical_bindings_path'):
                            bindings=json.loads((seed/c['canonical_bindings_path']).read_text())
                            for path in [c['canonical_bindings_path'],*(row['source'] for row in bindings['subcircuits']),*(row['source'] for row in bindings.get('electrical_guards',[]))]:
                                self.assertEqual(binding['source_sha256'][path],ic_sim.sha((seed/path).read_bytes()))
                        else:self.assertEqual(binding['source_sha256'][source['path']],source['sha256'])
                        self.assertEqual(binding['source_sha256'][c['configuration_path']],ws.file(c['configuration_path'])['sha256'])
                        for replacement in c['source_replacements']:
                            self.assertEqual((bundle.parent/replacement['destination']).read_bytes(),(seed/replacement['source']).read_bytes())
            self.assertTrue(ws.clean())

if __name__=='__main__':unittest.main(verbosity=2)
