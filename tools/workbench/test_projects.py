"""Compile the shipped project configurations without SSH or a simulator."""
import json, pathlib, shutil, subprocess, tempfile, unittest
import ic_sim, runner, workspace

class ProjectCompilationTests(unittest.TestCase):
    def test_all_shipped_sources_configs_and_postprocess_are_pinned(self):
        repo=pathlib.Path(__file__).resolve().parents[2]
        catalog=json.loads((repo/'config/workbench.projects.json').read_text())
        site=ic_sim.site_load(repo/'config/site.example.json')
        with tempfile.TemporaryDirectory() as tmp:
            tmp=pathlib.Path(tmp);seed=tmp/'seed';seed.mkdir()
            shutil.copytree(repo/'projects',seed/'projects')
            shutil.copytree(repo/'sim/bundles',seed/'sim/bundles')
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
                        self.assertEqual(binding['source_sha256'][source['path']],source['sha256'])
                        self.assertEqual(binding['source_sha256'][c['configuration_path']],ws.file(c['configuration_path'])['sha256'])
                        for replacement in c['source_replacements']:
                            self.assertEqual((bundle.parent/replacement['destination']).read_bytes(),(seed/replacement['source']).read_bytes())
            self.assertTrue(ws.clean())

if __name__=='__main__':unittest.main(verbosity=2)
