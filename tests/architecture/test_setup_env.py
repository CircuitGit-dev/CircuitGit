"""Synthetic subprocesses: no network, installer, build, model or solver runs."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/dev'))
import setup_env


class SetupTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        self.root=Path(folder.name).resolve()/'project with spaces';(self.root/'contracts').mkdir(parents=True)
        self.pin={'repository':'https://example.test/spiceowl.git','commit':'a'*40}
        (self.root/'contracts/spiceowl-integration.lock.json').write_text(json.dumps({'schema':'circuitgit.spiceowl-integration.v1','spiceowl':self.pin}))
        self.calls=[];self.ensures=[];self.failure_stage=None
    def ensure(self,root,**options):
        self.ensures.append(options)
        return root/'.local/python/synthetic/bin/python'
    def run_command(self,command,**options):
        self.calls.append((command,options))
        if self.failure_stage and self.failure_stage in command:return subprocess.CompletedProcess(command,2,'','Synthetic failure')
        if 'tools/dev/build.py' in command:
            for relative,kind,entry in [('web','web','studio/index.html'),('dist/ic-workbench','codex','ic_workbench.py')]:self.artifact(relative,kind,entry)
        if 'tools/dev/build_pages.py' in command:self.artifact('site','web','index.html')
        return subprocess.CompletedProcess(command,0,'{"status":"passed"}','')
    def artifact(self,relative,kind,entry):
        folder=self.root/relative;folder.mkdir(parents=True,exist_ok=True)
        (folder/'.ic-build.json').write_text(json.dumps({'schema':'ic.build.v1','kind':kind,'files':3}))
        target=folder/entry;target.parent.mkdir(parents=True,exist_ok=True);target.write_text('synthetic')
    def setup(self):return setup_env.setup(self.root,run=self.run_command,ensure=self.ensure,progress=lambda _:None)
    def test_one_command_orders_install_build_pages_and_offline_health_without_launch(self):
        result=self.setup()
        self.assertEqual(self.ensures[0]['extras'],('adctools','mcp'))
        self.assertEqual([row['stage'] for row in result['checks']],['dependencies','build','pages','structure','links'])
        self.assertEqual(result['spiceowl'],self.pin);self.assertFalse(result['services_started']);self.assertFalse(result['external_links_checked'])
        self.assertEqual(result,json.loads((self.root/'.local/developer-setup.json').read_text()))
        for command,options in self.calls:
            self.assertEqual(command[0],result['python']);self.assertEqual(options['cwd'],str(self.root))
            self.assertFalse(any('launch.py' in value or 'connect_browser.py' in value or value in ('ssh','npm') for value in command))
    def test_repeat_setup_reuses_environment_and_refreshes_managed_outputs(self):
        first=self.setup();second=self.setup()
        self.assertEqual(first['python'],second['python']);self.assertEqual(first['artifacts'],second['artifacts']);self.assertEqual(len(self.ensures),2)
    def test_install_or_build_failure_stops_dependent_work_and_preserves_old_receipt(self):
        self.setup();receipt=(self.root/'.local/developer-setup.json').read_bytes();self.calls=[];self.failure_stage='tools/dev/build.py'
        with self.assertRaisesRegex(setup_env.bootstrap.BootstrapError,'build.*失败'):self.setup()
        self.assertEqual(len(self.calls),2);self.assertEqual((self.root/'.local/developer-setup.json').read_bytes(),receipt)
        self.calls=[]
        with self.assertRaisesRegex(setup_env.bootstrap.BootstrapError,'offline'):
            setup_env.setup(self.root,run=self.run_command,ensure=lambda *a,**k:(_ for _ in ()).throw(setup_env.bootstrap.BootstrapError('offline')),progress=lambda _:None)
        self.assertEqual(self.calls,[])
    def test_plan_does_not_install_build_or_write(self):
        with patch.object(setup_env,'setup',side_effect=AssertionError('No setup')),contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup_env.main(['--plan'],root=self.root),0)
        self.assertFalse((self.root/'.local').exists());self.assertEqual(json.loads(output.getvalue())['adctoolbox_version'],'0.9.3')
    def test_missing_artifact_fails_health_and_never_writes_ready_receipt(self):
        with self.assertRaisesRegex(setup_env.bootstrap.BootstrapError,'产物核验'):
            setup_env.setup(self.root,run=lambda cmd,**kw:subprocess.CompletedProcess(cmd,0,'',''),ensure=self.ensure,progress=lambda _:None)
        self.assertFalse((self.root/'.local/developer-setup.json').exists())
    def test_external_local_symlink_is_not_modified(self):
        outside=self.root.parent/'external';outside.mkdir();(self.root/'.local').symlink_to(outside,target_is_directory=True)
        with self.assertRaises(setup_env.bootstrap.BootstrapError):self.setup()
        self.assertEqual(list(outside.iterdir()),[]);self.assertEqual(self.calls,[])
    def test_explicit_python_is_only_a_creation_candidate_and_environment_is_clean(self):
        with patch.dict('os.environ',{'PIP_TARGET':'/global','PYTHONPATH':'/foreign'}):
            result=setup_env.setup(self.root,python='/synthetic/python3.11',run=self.run_command,ensure=self.ensure,progress=lambda _:None)
        self.assertEqual(self.ensures[0]['candidates'],[Path('/synthetic/python3.11')])
        self.assertNotEqual(result['python'],'/synthetic/python3.11')
        for _,options in self.calls:self.assertNotIn('PIP_TARGET',options['env']);self.assertNotIn('PYTHONPATH',options['env'])


if __name__=='__main__':unittest.main()
