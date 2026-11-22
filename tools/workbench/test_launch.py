"""Launch configuration is local, separate from source, and never overwritten."""
import json, pathlib, shutil, subprocess, sys, tempfile, unittest

class LaunchTests(unittest.TestCase):
    def test_configuration_creation_and_preservation(self):
        root=pathlib.Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as temp:
            repo=(pathlib.Path(temp)/'source with spaces').resolve()
            (repo/'tools/workbench').mkdir(parents=True)
            (repo/'config').mkdir()
            script=repo/'tools/workbench/launch.py'
            shutil.copyfile(root/'tools/workbench/launch.py',script)
            for name in ['workbench.example.json','workbench.projects.json']:
                shutil.copyfile(root/'config'/name,repo/'config'/name)
            (repo/'config/site.example.json').write_text('{}')
            def run(*args):
                return subprocess.run([sys.executable,'-B',str(script),'--write-config-only',*args],capture_output=True,text=True)
            denied=run('--runtime-root',str(repo))
            self.assertNotEqual(denied.returncode,0)
            self.assertFalse((repo/'config/workbench.local.json').exists())
            first=run();self.assertEqual(first.returncode,0,first.stderr)
            config=repo/'config/workbench.local.json';original=config.read_bytes()
            data=json.loads(original)
            self.assertEqual(data['seed_repo'],str(repo))
            self.assertEqual(data['runtime_root'],str(repo/'.local/workbench'))
            self.assertNotEqual(pathlib.Path(data['runtime_root'])/'workspace',repo)
            self.assertEqual(config.stat().st_mode & 0o777,0o600)
            self.assertEqual(run().returncode,0)
            self.assertEqual(config.read_bytes(),original)
            self.assertNotEqual(run('--runtime-root',str(repo/'.local/other')).returncode,0)
            self.assertEqual(config.read_bytes(),original)

if __name__=='__main__':unittest.main()
