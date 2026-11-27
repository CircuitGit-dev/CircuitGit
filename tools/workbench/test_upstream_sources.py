"""Disposable local Git objects; initialization is mocked and never uses network."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock

import upstream_sources as upstream


class UpstreamFixture(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.temp=Path(tmp.name).resolve();self.root=self.temp/'project with spaces';self.root.mkdir()
        self.calls=[]
        self.git(self.root,'init','-b','main')
        self.commits={}
        for name,spec in upstream.UPSTREAMS.items():
            path=self.root/spec['relative_path'];path.mkdir(parents=True)
            self.git(path,'init','-b','main')
            self.write(path/'README.md','Synthetic '+name+' source\n')
            self.write(path/'.gitignore','ignored-output/\n')
            self.git(path,'add','.');self.git(path,'commit','-m','Synthetic upstream fixture')
            self.git(path,'config','remote.origin.url',spec['repository'])
            self.commits[name]=self.git(path,'rev-parse','HEAD').strip()
            self.git(self.root,'update-index','--add','--cacheinfo','160000,'+self.commits[name]+','+spec['relative_path'])
        self.metadata(self.root)
        self.calls=[]

    @staticmethod
    def write(path,text):
        # LF bytes on every platform: the inspection compares them with system and user Git config disabled.
        path.write_bytes(text.encode('utf-8'))

    def git(self,path,*args):
        # Fixture commits and checkouts do not depend on the developer's core.autocrlf.
        command=['git','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','core.autocrlf=false',
            '-c','user.name=Synthetic fixture','-c','user.email=fixture@localhost','-C',str(path),*args]
        result=subprocess.run(command,capture_output=True,text=True,check=True)
        return result.stdout

    def metadata(self,root):
        (root/'contracts').mkdir(parents=True,exist_ok=True)
        (root/'contracts/spiceowl-integration.lock.json').write_text(json.dumps({
            'schema':'circuitgit.spiceowl-integration.v1','spiceowl':{
                'repository':upstream.UPSTREAMS['spiceowl']['repository'],'commit':self.commits['spiceowl']}}))
        (root/'tools/viewer').mkdir(parents=True,exist_ok=True)
        (root/'tools/viewer/upstream-lock.json').write_text(json.dumps({
            'upstream_repository':upstream.UPSTREAMS['rnl']['repository'][:-4], 'upstream_commit':self.commits['rnl']}))
        (root/'apps/web/vendor/rnl-viewer').mkdir(parents=True,exist_ok=True)
        (root/'apps/web/vendor/rnl-viewer/provenance.json').write_text(json.dumps({
            'upstream':upstream.UPSTREAMS['rnl']['repository'][:-4],'commit':self.commits['rnl']}))
        (root/'.gitmodules').write_text(''.join('[submodule "'+name+'"]\n\tpath = '+spec['relative_path']+'\n\turl = '+spec['repository']+'\n'
            for name,spec in upstream.UPSTREAMS.items()))

    def read_git(self,command,**options):
        self.calls.append((command,options))
        self.assertEqual(command[0],'git')
        self.assertFalse(any(action in command for action in ('submodule','clone','fetch','push','checkout','reset')))
        return subprocess.run(command,**options)


class UpstreamTests(UpstreamFixture):
    def test_inspection_requires_matching_official_gitlinks_locks_and_clean_heads(self):
        result=upstream.inspect_upstreams(self.root,run=self.read_git,require_initialized=True)
        self.assertEqual(result['status'],'ready')
        for name,row in result['sources'].items():
            self.assertEqual(row['head_commit'],self.commits[name]);self.assertEqual(row['gitlink_commit'],self.commits[name])
            self.assertTrue(row['gitlink_verified']);self.assertRegex(row['tree'],r'^[a-f0-9]{40}$')
        self.assertTrue(all(options['env']['GIT_CONFIG_GLOBAL']==os.devnull for _,options in self.calls))

    def test_archive_below_a_git_parent_remains_unchecked_without_git_calls(self):
        archive=self.root/'archive';archive.mkdir();self.metadata(archive)
        no_git=Mock(side_effect=AssertionError('Do not inspect the parent repository'))
        result=upstream.inspect_upstreams(archive,run=no_git)
        self.assertEqual(result['status'],'unchecked')
        self.assertTrue(all(not row['gitlink_verified'] and row['head_commit'] is None for row in result['sources'].values()))
        with self.assertRaises(upstream.UpstreamError):upstream.inspect_upstreams(archive,run=no_git,require_initialized=True)
        no_git.assert_not_called()

    def test_dirty_and_untracked_source_are_rejected_before_sync_without_changing_files(self):
        source=self.root/'submodules/spiceowl/README.md';source.write_text('User work must survive\n')
        before=source.read_bytes()
        with self.assertRaisesRegex(upstream.UpstreamError,'local changes'):
            upstream.ensure_upstreams(self.root,run=self.read_git)
        self.assertEqual(source.read_bytes(),before)
        self.git(source.parent,'checkout','--','README.md');(source.parent/'new-user-file').write_text('keep')
        with self.assertRaisesRegex(upstream.UpstreamError,'local changes'):
            upstream.ensure_upstreams(self.root,run=self.read_git)
        self.assertEqual((source.parent/'new-user-file').read_text(),'keep')

    def test_mismatched_head_is_preserved_and_never_checked_out(self):
        source=self.root/'submodules/spiceowl'
        (source/'README.md').write_text('User branch change\n');self.git(source,'add','README.md');self.git(source,'commit','-m','User change')
        head=self.git(source,'rev-parse','HEAD')
        with self.assertRaisesRegex(upstream.UpstreamError,'HEAD differs'):
            upstream.ensure_upstreams(self.root,run=self.read_git)
        self.assertEqual(self.git(source,'rev-parse','HEAD'),head)

    def test_foreign_url_gitlink_and_provenance_are_not_repaired_implicitly(self):
        modules=self.root/'.gitmodules';original=modules.read_text()
        modules.write_text(original.replace('https://github.com/rich-netlist/rnl.git','https://example.invalid/other.git'))
        with self.assertRaises(upstream.UpstreamError):upstream.ensure_upstreams(self.root,run=self.read_git)
        modules.write_text(original)
        self.git(self.root,'config','submodule.spiceowl.url','https://example.invalid/other.git')
        with self.assertRaises(upstream.UpstreamError):upstream.inspect_upstreams(self.root,run=self.read_git)
        self.git(self.root,'config','--unset','submodule.spiceowl.url')
        self.git(self.root,'update-index','--cacheinfo','160000,'+'a'*40+',submodules/spiceowl')
        with self.assertRaisesRegex(upstream.UpstreamError,'Git link differs'):upstream.inspect_upstreams(self.root,run=self.read_git)
        self.git(self.root,'update-index','--cacheinfo','160000,'+self.commits['spiceowl']+',submodules/spiceowl')
        provenance=self.root/'apps/web/vendor/rnl-viewer/provenance.json'
        provenance.write_text(json.dumps({'upstream':upstream.UPSTREAMS['rnl']['repository'],'commit':'a'*40}))
        with self.assertRaisesRegex(upstream.UpstreamError,'provenance differ'):upstream.inspect_upstreams(self.root,run=self.read_git)

    def test_missing_initializes_only_the_exact_registered_path(self):
        path=self.root/'submodules/spiceowl';saved=self.temp/'saved-spiceowl';path.rename(saved)
        self.assertEqual(upstream.inspect_upstreams(self.root,run=self.read_git)['status'],'missing')
        commands=[]
        def execute(command,**options):
            if 'submodule' in command:
                commands.append(command)
                if 'update' in command:
                    self.assertEqual(command[-1],'submodules/spiceowl');shutil.copytree(saved,path)
                return subprocess.CompletedProcess(command,0,'','')
            return self.read_git(command,**options)
        result=upstream.ensure_upstreams(self.root,run=execute)
        self.assertEqual(result['status'],'ready');self.assertEqual(len(commands),2)
        self.assertIn('sync',commands[0]);self.assertIn('--init',commands[1]);self.assertIn('--checkout',commands[1])
        self.assertFalse(any(flag in command for command in commands for flag in ('--force','--recursive','--remote','reset')))

    def test_existing_nonrepo_and_symlink_content_are_never_overwritten(self):
        source=self.root/'submodules/spiceowl';saved=self.temp/'saved';source.rename(saved)
        source.mkdir();(source/'user.txt').write_text('preserve')
        with self.assertRaisesRegex(upstream.UpstreamError,'non-submodule'):
            upstream.ensure_upstreams(self.root,run=self.read_git)
        self.assertEqual((source/'user.txt').read_text(),'preserve')
        shutil.rmtree(source);source.symlink_to(saved,target_is_directory=True)
        with self.assertRaisesRegex(upstream.UpstreamError,'symlinks'):
            upstream.ensure_upstreams(self.root,run=self.read_git)

    def test_commit_archive_excludes_ignored_files_and_never_builds_in_submodule(self):
        pin={'repository':upstream.UPSTREAMS['spiceowl']['repository'],'commit':self.commits['spiceowl']}
        source=upstream.spiceowl_source(self.root,pin,run=self.read_git)
        ignored=self.root/'submodules/spiceowl/ignored-output';ignored.mkdir();(ignored/'private.txt').write_text('not committed')
        archive=self.temp/'source.tar'
        receipt=upstream.archive_source(self.root,source,archive,run=self.read_git)
        with tarfile.open(archive) as saved:
            self.assertIn('README.md',saved.getnames());self.assertFalse(any('ignored-output' in name for name in saved.getnames()))
        self.assertEqual(receipt['source'],source);self.assertEqual(receipt['url'],archive.as_uri())
        self.assertEqual(upstream.spiceowl_source(self.root,pin,run=self.read_git),source)
        with self.assertRaises(upstream.UpstreamError):upstream.archive_source(self.root,source,archive,run=self.read_git)


if __name__=='__main__':unittest.main()
