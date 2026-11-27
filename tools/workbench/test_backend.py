import concurrent.futures, http.client, json, os, shutil, socket, subprocess, tempfile, threading, time, unittest
from pathlib import Path
from unittest.mock import patch
import server,runner,workspace,ic_sim

HERE=Path(__file__).resolve().parent
def g(root,*args):return workspace.git(root,*args).stdout.decode().strip()
class BackendTests(unittest.TestCase):
    def setUp(self):
        scratch=HERE/'test-scratch';scratch.mkdir(exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=scratch);self.root=Path(self.tmp.name);seed=self.root/'seed';seed.mkdir()
        subprocess.run(['git','init','-b','main',str(seed)],capture_output=True,check=True);g(seed,'config','user.name','Test');g(seed,'config','user.email','test@localhost')
        for path,text in {'projects/demo/circuit.scs':'simulator lang=spectre\nglobal 0\nR0 (x 0) resistor r=1k\n','projects/demo/config.json':'{}\n','sim/demo/netlist/input.scs':'simulator lang=spectre\ninclude "project.scs"\ntran tran stop=1n\n','sim/demo/netlist/project.scs':'simulator lang=spectre\nR0 (x 0) resistor r=1k\n'}.items():p=seed/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
        b={'schema':'ic.sim.bundle.v1','design_id':'demo','design_origin':'text-netlist','test_id':'demo-tran','source_root':'.','entrypoint':'netlist/input.scs','reviewed_for_distribution':True,'files':[{'source':'netlist/'+n,'destination':'netlist/'+n,'sha256':runner.filehash(seed/'sim/demo/netlist'/n)} for n in ['input.scs','project.scs']]};runner.atomic(seed/'sim/demo/bundle.json',b);g(seed,'add','.');g(seed,'commit','-m','seed')
        site={'schema':'ic.sim.site.v1','ssh_target':'unused','remote_runs_root':'/unused/ic_on_github_runs','cadence_cshrc':'/unused/setup','spectre_bin':'/unused/spectre','external_files':{},'expected_host':'unused','expected_user':'unused'};runner.atomic(self.root/'site.json',site)
        cfg={'github_repo':'analog-topology-synth/IC_on_Github','seed_repo':str(seed),'runtime_root':str(self.root/'runtime'),'site_file':str(self.root/'site.json'),'base_branch':'main','runtime_branch':'codex/test-session','projects':[{'id':'demo','source_path':'projects/demo/circuit.scs','configurations':[{'id':'tran','configuration_path':'projects/demo/config.json','bundle_template':'sim/demo/bundle.json'}]}]}
        web=self.root/'web';web.mkdir();(web/'index.html').write_text('<p>test</p>');(web/'commands.json').write_text('{"okfile":true}')
        self.app=server.Application(cfg,web);self.http=server.Server(('127.0.0.1',0),server.Handler);self.http.app=self.app;self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start();self.origin='http://127.0.0.1:'+str(self.http.server_port)
    def tearDown(self):self.http.shutdown();self.http.server_close();self.app.pool.shutdown(wait=True);self.tmp.cleanup()
    def request(self,path,method='GET',data=None,headers=None):
        h={'Origin':self.origin,'X-Workbench-Token':self.app.token,'Content-Type':'application/json'};h.update(headers or {})
        c=http.client.HTTPConnection('127.0.0.1',self.http.server_port);c.request(method,path,body=json.dumps(data) if data is not None else None,headers=h);r=c.getresponse();raw=r.read();status=r.status;c.close();return status,json.loads(raw)
    def test_static_json_and_origin_guards(self):
        self.assertEqual(self.request('/commands.json'),(200,{'okfile':True}))
        self.assertEqual(self.request('/api/project',headers={'Host':'evil.example'})[0],403)
        self.assertEqual(self.request('/api/sync','POST',{},headers={'Origin':'https://evil.example'})[0],403)
        self.assertEqual(self.request('/api/sync','POST',{},headers={'X-Workbench-Token':'bad'})[0],403)
        self.assertEqual(self.request('/api/file?path=../../etc/passwd')[0],400)
    def test_preview_closure_and_stale_conflict(self):
        base=self.app.workspace.head();path='projects/demo/circuit.scs';content=self.app.workspace.file(path)['content']
        invalid={'base_commit':base,'changes':[{'path':path,'content':content+'include "missing.scs"\n'}]}
        self.assertEqual(self.request('/api/changes/preview','POST',invalid)[0],400)
        invalid['base_commit']='f'*40;self.assertEqual(self.request('/api/changes/preview','POST',invalid)[0],409)
    def test_rejected_post_closes_unread_body_connection(self):
        c=http.client.HTTPConnection('127.0.0.1',self.http.server_port)
        c.request('POST','/api/sync',body='{"not_consumed":true}',headers={'Origin':self.origin,'Content-Type':'application/json','X-Workbench-Token':'expired'})
        response=c.getresponse();self.assertEqual(response.status,403);response.read()
        try:
            trailing=c.sock.recv(1) if c.sock else b''
        except ConnectionResetError:
            trailing=b''
        self.assertEqual(trailing,b'','Rejected body must not survive on a keepalive connection')
        c.close()
    def test_rejected_post_whose_body_arrives_late_is_still_answered(self):
        # A client can be paused between sending headers and body. Closing
        # before the body arrives makes Windows reset the connection, which
        # overtakes the 403 instead of delivering it.
        body=b'{"not_consumed":true}'
        with socket.create_connection(('127.0.0.1',self.http.server_port),timeout=5) as c:
            c.sendall(('POST /api/sync HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nOrigin: %s\r\nContent-Type: application/json\r\nX-Workbench-Token: expired\r\nContent-Length: %d\r\n\r\n'%(self.http.server_port,self.origin,len(body))).encode())
            time.sleep(0.05);c.sendall(body)
            self.assertTrue(c.recv(1024).startswith(b'HTTP/1.1 403'),'The rejection must reach a client whose body arrives late')
    def test_commit_and_signed_materialization(self):
        base=self.app.workspace.head();path='projects/demo/circuit.scs';body={'base_commit':base,'changes':[{'path':path,'content':self.app.workspace.file(path)['content']+'// reviewed edit\n'}]}
        self.assertEqual(self.request('/api/changes/preview','POST',body)[0],200);status,result=self.request('/api/changes/commit','POST',body|{'message':'test edit','push':False});self.assertEqual(status,200,result)
        head=result['data']['source_commit'];status,plan=self.request('/api/plan','POST',{'project_id':'demo','configuration':'tran','source_commit':head});self.assertEqual(status,200,plan);self.assertEqual(plan['data']['source_commit'],head);self.assertEqual(plan['data']['blockers'],[])
        bundle=self.app.workspace.materialize('demo','tran',head);b=json.loads(bundle.read_text());b['configuration']={'forged':True};runner.atomic(bundle,b)
        with self.assertRaisesRegex(ValueError,'signature'):self.app.runner.plan(bundle,head)
    def test_external_runtime_branch_sync(self):
        ws=self.app.workspace;bare=self.root/'remote.git';subprocess.run(['git','clone','--bare',str(ws.root),str(bare)],capture_output=True,check=True);g(ws.root,'remote','set-url','origin',str(bare))
        external=self.root/'external';subprocess.run(['git','clone',str(bare),str(external)],capture_output=True,check=True);g(external,'config','user.name','External');g(external,'config','user.email','external@localhost')
        p=external/'projects/demo/circuit.scs';p.write_text(p.read_text()+'// remote edit\n');g(external,'add','.');g(external,'commit','-m','external edit');g(external,'push','origin',ws.branch)
        result=ws.sync();self.assertEqual(result['source_commit'],g(external,'rev-parse','HEAD'));self.assertIn('remote edit',ws.file('projects/demo/circuit.scs')['content']);self.assertEqual(result['tracking_branch'],'origin/'+ws.branch)
    def test_concurrent_get_collect_publish_receipts(self):
        rid='concurrency-test';r={'run_id':rid,'job_id':rid,'state':'submitted','source_commit':self.app.workspace.head(),'remote_directory':'/unused/run','plan':{'design_id':'demo','provenance':{},'external_sha256':{}},'collection':None,'publication':None};self.app.runner.save(r)
        fake=subprocess.CompletedProcess([],0,b'STATE simulator_complete_pending_measurements\nEXIT 0\nPID 1\nALIVE no\n',b'')
        def fields():
            for i in range(40):
                c=self.app.runner.read(rid);time.sleep(.002);c['collection']={'contains_full_raw':True,'sha256':'a'*64,'bytes':1,'revision':i};self.app.runner.save(c)
                p=self.app.runner.read(rid);time.sleep(.002);p['publication']={'status':'complete','asset_id':42,'revision':i};self.app.runner.save(p)
        def poll():
            for _ in range(40):self.assertEqual(self.request('/api/jobs/'+rid)[0],200)
        with patch.object(ic_sim,'ssh',return_value=fake):
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(lambda fn:fn(),[fields,poll,poll,poll]))
        result=self.app.runner.read(rid);self.assertEqual(result['collection']['revision'],39);self.assertEqual(result['publication']['revision'],39);self.assertEqual(result['publication']['asset_id'],42)
    def test_idempotency_conflicts(self):
        b=self.app.workspace.materialize('demo','tran',self.app.workspace.head());r,new=self.app.runner.reserve(b,'unique-test-key',self.app.workspace.head(),'demo','tran');again,new2=self.app.runner.reserve(b,'unique-test-key',self.app.workspace.head(),'demo','tran');self.assertTrue(new);self.assertFalse(new2);self.assertEqual(r['run_id'],again['run_id'])
        with self.assertRaisesRegex(ValueError,'different input'):self.app.runner.reserve(b,'unique-test-key',self.app.workspace.head(),'another','tran')
    def test_published_archive_is_immutable(self):
        rid='published-test';folder=self.app.runner.path(rid);folder.mkdir();archive=folder/'full-results.tar.gz';archive.write_bytes(b'original');sha=runner.filehash(archive)
        self.app.runner.save({'run_id':rid,'state':'simulator_complete_pending_measurements','collection':{'archive':str(archive),'sha256':sha},'publication':{'status':'complete','full_archive_sha256':sha}})
        with patch.object(ic_sim,'ssh',side_effect=AssertionError('published collect must not regenerate remote archive')):
            self.assertEqual(self.app.runner.collect(rid)['collection']['sha256'],sha)
            archive.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'published archive changed'):self.app.runner.collect(rid)
    def test_postprocess_is_explicit_and_bounded(self):
        self.assertIsNone(runner.postprocess_config(None))
        spec=runner.postprocess_config({'signals':[{'name':'out','unit':'V'}],'start_s':0,'end_s':12e-9,'step_s':5e-12})
        self.assertEqual(spec['signals'][0]['name'],'out')
        with self.assertRaises(ValueError):runner.postprocess_config({'signals':['out);system()'],'end_s':1,'step_s':.01})
    def test_publication_stages_only_small_allowlist(self):
        ws=self.app.workspace;root=ws.root;d=root/'results/runs/test';d.mkdir(parents=True)
        (root/'.gitignore').write_text('results/\n');g(root,'add','.gitignore');g(root,'-c','user.name=Test','-c','user.email=test@localhost','commit','-m','ignore raw results')
        for name in ['manifest.json','summary.json','files.json','publication.json']:(d/name).write_text('{}\n')
        (d/'full-results.tar.gz').write_bytes(b'raw must not enter Git')
        self.app.publisher.stage_index(root,d,True);staged=g(root,'diff','--cached','--name-only').splitlines()
        self.assertEqual(len(staged),4);self.assertFalse(any('tar.gz' in p for p in staged))
    def test_final_release_uses_published_metadata(self):
        p=self.app.publisher;sha='a'*64;release={'id':88,'tag_name':'sim-test','draft':False,'html_url':'https://github.com/owner/repo/releases/tag/sim-test'};asset={'id':77,'name':'full.tar.gz','state':'uploaded','size':123,'digest':'sha256:'+sha,'browser_download_url':'https://github.com/owner/repo/releases/download/sim-test/full.tar.gz'}
        with patch.object(p,'api',return_value=release),patch.object(p,'list_assets',return_value=[asset]):
            final,verified=p.final_release(88,'sim-test',[{'name':'full.tar.gz','bytes':123,'sha256':sha}],self.root)
            self.assertNotIn('untagged',verified[0]['url']);self.assertEqual(final['html_url'],release['html_url'])
            with self.assertRaises(ValueError):p.final_release(88,'wrong-tag',[{'name':'full.tar.gz','bytes':123,'sha256':sha}],self.root)

if __name__=='__main__':unittest.main(verbosity=2)
