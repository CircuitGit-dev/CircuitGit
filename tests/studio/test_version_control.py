"""Read-only version APIs against synthetic, isolated Git repositories. No network/EDA/model."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/workbench'))
import workspace
import server

CIRCUIT='projects/demo/circuit.scs'
CONFIG='projects/demo/config.json'
AUX='projects/demo/extra.scs'

class VersionControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='ic-version-')
        self.base=Path(self.tmp.name).resolve();seed=self.base/'application';seed.mkdir()
        subprocess.run(['git','init','-b','main',str(seed)],check=True,capture_output=True)
        self.repo=seed
        self.g('config','user.name','Synthetic engineer');self.g('config','user.email','never-expose@example.invalid')
        self.write(CIRCUIT,'R0 (x 0) resistor r=1k\n');self.write(CONFIG,'{}\n')
        self.write(AUX,'R1 (y 0) resistor r=1k\n')
        self.write('projects/other/circuit.scs','PRIVATE_OTHER_SOURCE\n')
        self.write('config/credentials.local.json','SECRET_APPLICATION_CONFIG\n')
        self.write('projects/demo/pdk/foundry.scs','SECRET_PDK\n')
        self.write('projects/demo/credentials.json','SECRET_CREDENTIALS\n')
        self.write('apps/main.py','APPLICATION_SOURCE\n')
        self.initial=self.commit('Initial synthetic project')
        project={'id':'demo','source_path':CIRCUIT,'read_paths':[AUX,'projects/demo/new.scs',
                 'projects/demo/a[1].scs','projects/demo/space file.scs','projects/demo/binary.bin','projects/demo/link.scs',
                 'projects/demo/pdk/foundry.scs','projects/demo/credentials.json'],
                 'configurations':[{'id':'TRAN','configuration_path':CONFIG,'bundle_template':'sim/demo.json',
                                    'source_replacements':[{'source':AUX,'destination':'netlist/extra.scs'}]}]}
        cfg={'runtime_root':str(self.base/'runtime'),'seed_repo':str(seed),'github_repo':'fixture/private',
             'runtime_branch':'codex/version-test','projects':[project]}
        self.ws=workspace.Workspace(cfg,{},b'synthetic')
        self.repo=self.ws.root
        self.g('config','user.name','Synthetic engineer');self.g('config','user.email','never-expose@example.invalid')
        self.addCleanup(self.tmp.cleanup)

    def g(self,*args,input=None):
        return workspace.git(self.repo,*args,input=input).stdout.decode().strip()

    def write(self,path,text):
        p=self.repo/path;p.parent.mkdir(parents=True,exist_ok=True)
        p.write_bytes(text if isinstance(text,bytes) else text.encode('utf-8'))

    def commit(self,message):
        self.g('add','--all');self.g('commit','-m',message)
        return self.g('rev-parse','HEAD')

    def summary(self,**kwargs):return self.ws.version_control('demo',**kwargs)
    def detail(self,sha=None):return self.ws.version_control_commit('demo',sha or self.g('rev-parse','HEAD'))

    def snapshot(self):
        return {str(p.relative_to(self.repo)):hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.repo.rglob('*') if p.is_file() and not p.is_symlink()}

    def http(self,path,headers=None):
        handler=object.__new__(server.Handler)
        handler.server=SimpleNamespace(server_port=19323,app=SimpleNamespace(workspace=self.ws,ai=None,web=self.base))
        handler.headers={'Host':'127.0.0.1:19323',**(headers or {})};handler.path=path
        captured=[];handler.send=lambda status,data,*args,**kwargs:captured.append((status,data))
        handler.do_GET();return captured[0]

    def test_runtime_identity_and_project_only_history(self):
        self.write(CIRCUIT,'R0 (x 0) resistor r=2k\n');source=self.commit('Change runtime circuit')
        self.write('apps/main.py','UNRELATED_APPLICATION_CHANGE\n');app_commit=self.commit('App-only secret subject')
        self.write('projects/other/circuit.scs','OTHER_SECRET_UPDATE\n');other_commit=self.commit('Other-only secret subject')
        d=self.summary()
        self.assertEqual(d['branch'],'codex/version-test');self.assertEqual(d['source_commit'],other_commit)
        self.assertEqual([c['sha'] for c in d['commits']],[source,self.initial])
        self.assertEqual(d['commits'][0]['parents'],[self.initial])
        self.assertEqual(d['commits'][0]['files'],[CIRCUIT])
        for sha in [app_commit,other_commit]:
            with self.assertRaises(FileNotFoundError):self.detail(sha)
        # Advancing the application checkout cannot change the pinned runtime history.
        runtime=self.repo;self.repo=self.base/'application'
        self.write(CIRCUIT,'APPLICATION_CHECKOUT_ONLY\n');development=self.commit('Not the runtime')
        self.repo=runtime
        self.assertNotEqual(development,self.summary()['source_commit'])
        self.assertEqual(self.summary()['source_commit'],other_commit)

    def test_root_diff_and_private_exclusions(self):
        d=self.detail(self.initial)
        self.assertIsNone(d['parent_commit']);self.assertEqual(d['commit']['parents'],[])
        self.assertEqual({f['path'] for f in d['files']},{CIRCUIT,CONFIG,AUX})
        self.assertIn('+R0 (x 0) resistor r=1k',d['diff'])
        self.assertTrue(all(f['status']=='A' for f in d['files']))
        serialized=json.dumps([d,self.summary()])
        for secret in ['PRIVATE_OTHER','SECRET_','APPLICATION_SOURCE','credentials','pdk/','never-expose']:
            self.assertNotIn(secret,serialized)

    def test_working_changes_staged_unstaged_deleted_and_untracked(self):
        self.write(CIRCUIT,'STAGED\n');self.g('add','--',CIRCUIT);self.write(CIRCUIT,'UNSTAGED\n')
        (self.repo/CONFIG).unlink();self.write('projects/demo/new.scs','UNTRACKED\n')
        self.write('projects/other/circuit.scs','UNRELATED_DIRTY\n')
        d=self.summary();changes={f['path']:f for f in d['changes']}
        self.assertFalse(d['clean']);self.assertTrue(d['dirty'])
        self.assertEqual(changes[CIRCUIT],{'path':CIRCUIT,'status':'MM','staged':True,'unstaged':True})
        self.assertEqual(changes[CONFIG]['status'],' D')
        self.assertEqual(changes['projects/demo/new.scs']['status'],'??')
        self.assertFalse(changes['projects/demo/new.scs']['staged']);self.assertTrue(changes['projects/demo/new.scs']['unstaged'])
        self.assertEqual(set(changes),{CIRCUIT,CONFIG,'projects/demo/new.scs'})

    def test_unrelated_dirty_is_project_clean(self):
        self.write('apps/main.py','APP_DIRTY\n');self.write('projects/demo/credentials.json','PASSWORD\n')
        d=self.summary();self.assertTrue(d['clean']);self.assertFalse(d['dirty']);self.assertEqual(d['changes'],[])

    def test_literal_pathspec_and_spaces(self):
        self.write('projects/demo/a[1].scs','LITERAL_PUBLIC\n')
        self.write('projects/demo/a1.scs','WILDCARD_SECRET\n')
        self.write('projects/demo/space file.scs','SPACE_PUBLIC\n');self.commit('Literal filenames')
        d=self.detail();self.assertEqual(len(d['files']),2)
        self.assertIn('LITERAL_PUBLIC',d['diff']);self.assertIn('SPACE_PUBLIC',d['diff']);self.assertNotIn('WILDCARD_SECRET',d['diff'])
        self.write('projects/demo/a1.scs','SECRET_DIRTY\n');self.assertTrue(self.summary()['clean'])

    def test_rename_from_private_path_does_not_expose_old_path(self):
        self.g('mv','projects/other/circuit.scs','projects/demo/new.scs');self.commit('Move into public scope')
        d=self.detail();self.assertEqual(d['files'][0]['status'],'A')
        self.assertNotIn('projects/other',json.dumps(d))

    def test_merge_diff_against_actual_first_parent(self):
        self.g('checkout','-b','feature');self.write(AUX,'FEATURE_AUX\n');feature=self.commit('Feature source')
        self.g('checkout',self.ws.branch);self.write(CIRCUIT,'MAIN_SOURCE\n');first=self.commit('Main source')
        self.g('merge','--no-ff','feature','-m','Merge feature')
        d=self.detail();self.assertEqual(d['commit']['parents'],[first,feature]);self.assertEqual(d['parent_commit'],first)
        self.assertEqual([f['path'] for f in d['files']],[AUX]);self.assertIn('+FEATURE_AUX',d['diff']);self.assertNotIn('+MAIN_SOURCE',d['diff'])
        self.assertEqual(self.detail(feature)['commit']['sha'],feature)
        history=self.summary()['commits'];self.assertEqual(history[0]['sha'],d['commit']['sha'])
        self.assertNotIn(feature,[c['sha'] for c in history]);self.assertEqual(history[0]['parents'],[first,feature])

    def test_unconfigured_missing_and_cached_upstream(self):
        d=self.summary();self.assertIsNone(d['tracking_branch']);self.assertEqual(d['upstream']['reason'],'unconfigured')
        self.g('branch','--set-upstream-to=origin/main',self.ws.branch)
        self.write(CIRCUIT,'AHEAD\n');head=self.commit('Ahead')
        d=self.summary();u=d['upstream']
        self.assertEqual((u['ahead'],u['behind']),(1,0));self.assertTrue(u['available'])
        self.assertEqual(u['commit'],self.initial);self.assertEqual(u['freshness'],'local_cache');self.assertFalse(u['remote_checked'])
        self.assertEqual(d['source_commit'],head);self.assertEqual(d['tracking_branch'],'origin/main')
        tree=self.g('rev-parse',self.initial+'^{tree}')
        upstream=self.g('commit-tree',tree,'-p',self.initial,input=b'Synthetic cached upstream\n')
        self.g('update-ref','refs/remotes/origin/main',upstream)
        u=self.summary()['upstream'];self.assertEqual((u['ahead'],u['behind']),(1,1));self.assertFalse(u['remote_checked'])
        self.g('update-ref','-d','refs/remotes/origin/main')
        u=self.summary()['upstream'];self.assertFalse(u['available']);self.assertEqual(u['reason'],'missing_local_ref')
        self.assertEqual(u['ref'],'origin/main');self.assertIsNone(u['ahead']);self.assertIsNone(u['commit'])

    def test_history_limit_and_has_more(self):
        for i in range(3):self.write(CIRCUIT,f'R {i}\n');self.commit(f'Circuit {i}')
        d=self.summary(limit=2);self.assertEqual(len(d['commits']),2);self.assertTrue(d['has_more'])
        self.assertEqual(len(self.summary(limit=4)['commits']),4);self.assertFalse(self.summary(limit=4)['has_more'])
        for limit in [0,51,-1,True,'20',None]:
            with self.subTest(limit=limit),self.assertRaises(ValueError):self.summary(limit=limit)

    def test_binary_symlink_and_type_changes_never_return_contents(self):
        self.write('projects/demo/binary.bin',b'\x00SECRET_BINARY\xff')
        (self.repo/'projects/demo/link.scs').symlink_to('/private/SECRET_SYMLINK_TARGET')
        self.commit('Nontext project files');d=self.detail();files={f['path']:f for f in d['files']}
        self.assertTrue(files['projects/demo/binary.bin']['binary']);self.assertIsNone(files['projects/demo/binary.bin']['additions'])
        self.assertEqual(files['projects/demo/link.scs']['content_omitted'],'non_regular_file')
        self.assertEqual(d['diff'],'');self.assertNotIn('SECRET_',json.dumps(d))
        (self.repo/CIRCUIT).unlink();(self.repo/CIRCUIT).symlink_to('/private/SECRET_TARGET')
        self.commit('Type change');d=self.detail();self.assertEqual(d['files'][0]['status'],'T');self.assertEqual(d['diff'],'')

    def test_sha_scope_and_unreachable_commits(self):
        for sha in ['HEAD',self.initial[:12],self.initial.upper(),'--all','HEAD~1','0'*40+':'+CIRCUIT,True,None]:
            with self.subTest(sha=sha),self.assertRaises(ValueError):self.ws.version_control_commit('demo',sha)
        with self.assertRaises(FileNotFoundError):self.detail('0'*40)
        tree=self.g('rev-parse','HEAD^{tree}');orphan=self.g('commit-tree',tree,input=b'UNREACHABLE_SECRET\n')
        with self.assertRaises(FileNotFoundError):self.detail(orphan)
        with self.assertRaises(FileNotFoundError):self.ws.version_control('unknown')
        with self.assertRaises(FileNotFoundError):self.ws.version_control_commit('unknown',self.initial)

    def test_forced_text_attributes_cannot_expose_binary_content(self):
        self.write('.gitattributes','*.bin diff\n')
        self.write('projects/demo/binary.bin',b'\x00SECRET_BINARY_FORCED_TEXT\n')
        self.commit('Forced text attributes')
        d=self.detail();self.assertTrue(d['files'][0]['binary']);self.assertEqual(d['diff'],'')
        self.assertNotIn('SECRET_BINARY',json.dumps(d))

    def test_shallow_history_is_not_reported_as_complete(self):
        (self.repo/'.git/shallow').write_text(self.initial+'\n')
        with self.assertRaises(workspace.VersionControlError) as e:self.summary()
        self.assertEqual(e.exception.code,'version_unavailable')
        with self.assertRaises(workspace.VersionControlError):self.detail(self.initial)

    def test_missing_promisor_object_never_fetches(self):
        # All routes are local, and even a repository's per-protocol override must
        # not turn a missing promised object into a transport invocation.
        self.g('config','remote.origin.promisor','true')
        self.g('config','remote.origin.partialclonefilter','blob:none')
        self.g('config','protocol.ext.allow','always')
        marker=self.base/'fetch-must-not-run'
        self.g('remote','set-url','origin',f'ext::touch {marker}')
        self.write(CIRCUIT,'LOCAL_ONLY_PROMISED_BLOB\n');self.commit('Promisor missing object fixture')
        blob=self.g('rev-parse','HEAD:'+CIRCUIT)
        (self.repo/'.git/objects'/blob[:2]/blob[2:]).unlink()
        before=self.snapshot()
        with self.assertRaises(workspace.VersionControlError):self.detail()
        self.assertFalse(marker.exists());self.assertEqual(before,self.snapshot())

    def test_detached_or_changed_runtime_is_rejected(self):
        self.g('checkout','--detach')
        with self.assertRaises(workspace.Conflict):self.summary()
        self.g('checkout','-b','wrong-runtime')
        with self.assertRaises(workspace.Conflict):self.detail(self.initial)
        self.g('checkout',self.ws.branch)
        self.ws.root=self.base/'application'
        with self.assertRaises(workspace.Conflict):self.summary()

    def test_moving_head_is_a_conflict(self):
        original=self.ws._version_identity;calls=0
        def identity(deadline):
            nonlocal calls
            calls+=1;value=original(deadline)
            return value if calls==1 else ('f'*40,value[1])
        with patch.object(self.ws,'_version_identity',side_effect=identity):
            with self.assertRaises(workspace.Conflict):self.summary()

    def test_reads_do_not_modify_any_repository_bytes(self):
        self.write(CIRCUIT,'WORKING\n');before=self.snapshot()
        self.summary();self.detail(self.initial)
        self.assertEqual(before,self.snapshot())

    def test_external_diff_textconv_clean_filters_and_fsmonitor_are_disabled(self):
        marker=self.base/'must-not-exist'
        command=f'touch {marker}'
        self.g('config','diff.external',command);self.g('config','diff.evil.textconv',command)
        self.g('config','filter.evil.clean',command);self.g('config','filter.evil.process',command)
        self.g('config','filter.evil.required','true');self.g('config','core.fsmonitor',command)
        self.write('.gitattributes','*.scs diff=evil filter=evil\n')
        self.write(CIRCUIT,'DIRTY_WILL_HASH\n')
        before=self.snapshot();self.summary();self.detail(self.initial)
        self.assertFalse(marker.exists());self.assertEqual(before,self.snapshot())

    def test_environment_cannot_redirect_repository_or_invoke_diff(self):
        with patch.dict(os.environ,{'GIT_DIR':str(self.base/'application/.git'),'GIT_WORK_TREE':str(self.base/'application'),
                                    'GIT_EXTERNAL_DIFF':'false','GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'core.fsmonitor','GIT_CONFIG_VALUE_0':'false'}):
            self.assertEqual(self.summary()['branch'],self.ws.branch)
            self.assertEqual(self.detail()['commit']['sha'],self.initial)

    def test_output_limits_and_timeout(self):
        with self.assertRaises(workspace.VersionControlError) as e:
            workspace.version_git(self.repo,'log','--format=%H',limit=5)
        self.assertEqual(e.exception.code,'version_output_limit');self.assertEqual(e.exception.status,413)
        self.write(CIRCUIT,'huge'*70000+'\n');self.commit('Large change')
        with self.assertRaises(workspace.VersionControlError) as e:self.detail()
        self.assertEqual(e.exception.code,'version_output_limit')
        real_popen=subprocess.Popen
        def slow(*args,**kwargs):return real_popen([sys.executable,'-c','import time; time.sleep(5)'],**kwargs)
        start=time.monotonic()
        with patch.object(workspace.subprocess,'Popen',side_effect=slow):
            with self.assertRaises(workspace.VersionControlError) as e:
                workspace.version_git(self.repo,'status',deadline=time.monotonic()+.05)
        self.assertEqual(e.exception.code,'version_timeout');self.assertLess(time.monotonic()-start,2)

    def test_errors_do_not_expose_stderr(self):
        with self.assertRaises(workspace.VersionControlError) as e:
            workspace.version_git(self.repo,'show','SUPER_SECRET_UNRESOLVED_PATH')
        self.assertNotIn('SECRET',str(e.exception))

    def test_strict_http_queries_and_existing_origin_guard(self):
        for query in ['','project_id=','project_id=demo&limit=','project_id=demo&project_id=demo',
                      'project_id=demo&limit=0','project_id=demo&limit=51','project_id=demo&limit=01',
                      'project_id=demo&limit=+1','project_id=demo&path=projects/demo',
                      'project_id=demo&limit','project_id=demo&limit=%xx','project_id=demo&limit=1&limit=2']:
            with self.subTest(query=query):self.assertEqual(self.http('/api/version-control?'+query)[0],400)
        for query in ['project_id=demo','project_id=demo&commit=HEAD',f'project_id=demo&commit={self.initial}&path=x',
                      f'project_id=demo&commit={self.initial}&commit={self.initial}']:
            with self.subTest(query=query):self.assertEqual(self.http('/api/version-control/commit?'+query)[0],400)
        path='/api/version-control?project_id=demo'
        self.assertEqual(self.http(path,{'Origin':'https://evil.invalid'})[0],403)
        self.assertEqual(self.http(path,{'Host':'evil.invalid'})[0],403)
        self.assertEqual(self.http(path,{'Sec-Fetch-Site':'cross-site'})[0],403)
        status,body=self.http(path);self.assertEqual(status,200);self.assertTrue(body['ok']);self.assertEqual(body['data']['limit'],20)
        self.assertEqual(self.http(f'/api/version-control/commit?project_id=demo&commit={self.initial}')[0],200)
        self.assertEqual(self.http('/api/version-control?project_id=missing')[0],404)
        self.assertEqual(self.http('/api/project')[0],200)
        with patch.object(self.ws,'version_control',side_effect=workspace.VersionControlError('version_output_limit','Too large',413)):
            status,body=self.http(path);self.assertEqual(status,413);self.assertEqual(body['error']['code'],'version_output_limit')

    def test_rejects_recursive_and_symlinked_directory_scopes(self):
        self.ws.projects['demo']['read_paths'].append('projects/demo')
        with self.assertRaises(ValueError):self.summary()
        self.ws.projects['demo']['read_paths'].pop()
        (self.repo/'projects/demo/escape').symlink_to(self.base/'application/projects/other',target_is_directory=True)
        self.ws.projects['demo']['read_paths'].append('projects/demo/escape/circuit.scs')
        with self.assertRaises(PermissionError):self.summary()

if __name__=='__main__':unittest.main(verbosity=2)
