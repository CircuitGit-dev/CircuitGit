"""Organization migration regression; local Git and loopback policy only."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/workbench'))
from connect_browser import PUBLIC_URL, library_configuration
from library_workflow import LibraryWorkflow, WorkflowError
from remote_node import Node


class OrganizationMigrationTests(unittest.TestCase):
    def test_public_repository_and_pages_metadata_agree(self):
        self.assertEqual(PUBLIC_URL,'https://circuitgit-dev.github.io/CircuitGit/')
        self.assertEqual(json.loads((ROOT/'package.json').read_text())['repository']['url'],
                         'https://github.com/CircuitGit-dev/CircuitGit.git')
        for name,key in [('config/workbench.example.json','github_repo'),('apps/web/assets/provenance.json','repository')]:
            self.assertEqual(json.loads((ROOT/name).read_text())[key],'CircuitGit-dev/CircuitGit')
        self.assertEqual(json.loads((ROOT/'contracts/spiceowl-integration.lock.json').read_text())['spiceowl']['repository'],
                         'https://github.com/spiceowl-dev/spiceowl.git')
        for name in ('connect_browser.py','onboarding_server.py'):
            text=(ROOT/'tools/workbench'/name).read_text()
            self.assertIn("'https://circuitgit-dev.github.io'",text)
            self.assertNotIn('https://joshuazeng713.github.io',text)

    def test_supported_remote_spellings_bind_only_exact_new_repository(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve()
            def git(*args):return subprocess.run(['git','-C',str(root),*args],check=True,capture_output=True)
            git('init','--initial-branch=main')
            for prefix in ('https://github.com/','git@github.com:','ssh://git@github.com/'):
                for suffix in ('','.git'):
                    with self.subTest(prefix=prefix,suffix=suffix):
                        git('config','remote.origin.url',prefix+'CircuitGit-dev/CircuitGit'+suffix)
                        config=library_configuration(root,root/'.local/helper')
                        self.assertEqual(config['library_repository'],'CircuitGit-dev/CircuitGit')
                        workflow=LibraryWorkflow(root,'CircuitGit-dev/CircuitGit')
                        self.assertEqual(workflow.repository,'CircuitGit-dev/CircuitGit')
            git('config','remote.origin.url','https://github.com/unrelated/CircuitGit.git')
            with self.assertRaises(WorkflowError):LibraryWorkflow(root,'CircuitGit-dev/CircuitGit')


if __name__=='__main__':unittest.main()
