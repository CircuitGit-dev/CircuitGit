import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/workbench'))
import connect_browser


class HelperTests(unittest.TestCase):
    def test_git_library_configures_committed_sources_and_preserves_operator_projects(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()/'repository';root.mkdir()
            (root/'.git').mkdir();(root/'config').mkdir()
            (root/'config/workbench.projects.json').write_text(json.dumps([{'id':'rc','name':'installed'}, {'id':'adc','name':'ADC'}]))
            cfg={'github_repo':'fixture/repo','seed_repo':str(root),'site_file':'owner-site','projects':[{'id':'rc','name':'custom'}]}
            result=subprocess.CompletedProcess([],0,'https://github.com/fixture/repo.git\n','')
            with patch.object(connect_browser.subprocess,'run',return_value=result):
                value=connect_browser.library_runtime_configuration(cfg,root,root/'.local/helper')
                self.assertEqual(value['source_repository'],str(root))
                self.assertEqual(value['projects'],[{'id':'rc','name':'custom'},{'id':'adc','name':'ADC'}])
                self.assertEqual(value['site_file'],'owner-site')
                self.assertNotIn('source_repository',cfg)
                self.assertEqual(connect_browser.library_runtime_configuration({**cfg,'github_repo':'other/repo'},root,root/'.local/helper')['projects'],cfg['projects'])
                self.assertNotIn('source_repository',connect_browser.library_runtime_configuration({**cfg,'seed_repo':str(root/'other')},root,root/'.local/helper'))

    def test_downloaded_zip_initializes_private_example_without_modifying_the_app(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()/'downloaded app';root.mkdir()
            shutil.copytree(ROOT/'config',root/'config',ignore=shutil.ignore_patterns('*.local.json'))
            shutil.copytree(ROOT/'projects',root/'projects')
            state=root/'.local/helper'
            with patch.object(connect_browser,'ROOT',root):
                cfg=connect_browser.configuration(state)
                self.assertFalse((root/'.git').exists())
                self.assertEqual(Path(cfg['seed_repo']),state/'example-seed')
                self.assertEqual(subprocess.check_output(['git','-C',cfg['seed_repo'],'branch','--show-current'],text=True).strip(),'main')
                source=root/'projects/rc-smoke/circuit.scs'
                self.assertEqual(source.read_bytes(),(Path(cfg['seed_repo'])/'projects/rc-smoke/circuit.scs').read_bytes())
                before=(state/'workbench.local.json').read_bytes()
                self.assertEqual(connect_browser.configuration(state),cfg)
                self.assertEqual((state/'workbench.local.json').read_bytes(),before)
                self.assertNotIn('ai_client_config',cfg)

if __name__=='__main__':unittest.main()
