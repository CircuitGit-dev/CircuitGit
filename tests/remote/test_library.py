"""Real loopback boundary with a synthetic workflow; no Git/model/simulator writes."""
import json
import importlib.util
from pathlib import Path
import re
import sys
import threading
import unittest
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'tools/workbench'),str(ROOT/'apps/codex')]
from remote_node import Node, Server, Handler
from browser_library import LocalLibrary
from library_workflow import WorkflowError


class Workflow:
    repository='example/circuits';root=Path('/synthetic')
    def __init__(self): self.calls=[];self.result={'state':'complete','operation':'save'}
    def describe(self, library_id, cell_id): return {'library_id':library_id,'cell_id':cell_id}
    def preview_save(self, **args): return {'review_id':'a'*64,'operation':'save','diff':'<script>untrusted()</script>','payload':args}
    def confirm(self, review_id, key): self.calls.append((review_id,key));return self.result
    def receipt(self, **args): return self.result if self.calls else {'state':'prepared'}


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.origin='https://fixture.invalid';self.owner='x'*43
        self.server=Server(('127.0.0.1',0),Handler);self.base='http://127.0.0.1:'+str(self.server.server_port)
        self.node=Node(None,self.owner,[self.origin],'fixture',self.base)
        self.workflow=Workflow();self.node.library=LocalLibrary(self.workflow,self.node.pairing,self.base)
        self.server.node=self.node;self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        rid,csrf=self.node.pairing.create(self.origin,'s'*32)
        self.token=self.node.pairing.decide(rid,csrf,True)['accessCode']

    def tearDown(self): self.server.shutdown();self.server.server_close();self.thread.join()

    def request(self,path,body=None,origin=None,token=None,extra=None):
        headers={'Origin':origin or self.origin,'Authorization':'Bearer '+(token or self.token),**(extra or {})}
        if body is not None: headers['Content-Type']='application/json'
        request=urllib.request.Request(self.base+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
        try:
            with urllib.request.urlopen(request,timeout=5) as response:return response.status,response.headers,response.read()
        except urllib.error.HTTPError as error:return error.code,error.headers,error.read()

    def prepare(self):
        code,_,raw=self.request('/api/library/prepare',{'operation':'preview_save','args':{'library_id':'lib','cell_id':'cell','path':'lib/lib/cell/source.scs','content':'safe'}})
        self.assertEqual(code,200);rid=json.loads(raw)['data']['review_id']
        code,_,raw=self.request('/api/library/review-request',{'review_id':rid});self.assertEqual(code,200)
        ticket=json.loads(raw)['data']['ticket'];row=self.node.library.tickets[ticket]
        return ticket,{'ticket':ticket,'csrf':row['csrf'],'action':'confirm'}

    def test_paired_read_only_capability_and_finite_operation(self):
        code,_,raw=self.request('/api/library/read',{'operation':'capability','args':{}})
        self.assertEqual(code,200);self.assertTrue(json.loads(raw)['data']['available'])
        self.assertEqual(self.request('/api/library/read',{'operation':'confirm','args':{}})[0],400)
        self.assertEqual(self.workflow.calls,[])

    def test_owner_bearer_and_wrong_origin_cannot_use_library(self):
        body={'operation':'capability','args':{}}
        self.assertEqual(self.request('/api/library/read',body,token=self.owner)[0],403)
        self.assertEqual(self.request('/api/library/read',body,origin='https://other.invalid')[0],403)

    def test_prepare_has_no_effect_page_is_unframeable_and_escaped(self):
        ticket,_=self.prepare();self.assertEqual(self.workflow.calls,[])
        code,headers,raw=self.request('/library/review?ticket='+ticket)
        self.assertEqual(code,200);self.assertEqual(headers['X-Frame-Options'],'DENY')
        self.assertNotIn('Access-Control-Allow-Origin',headers)
        self.assertIn(b'&lt;script&gt;',raw);self.assertNotIn(b'<script>untrusted()',raw)

    def test_confirmation_requires_local_origin_csrf_and_human_page(self):
        ticket,body=self.prepare()
        self.assertEqual(self.request('/library/review/confirm',body)[0],403)
        self.assertEqual(self.request('/library/review/confirm',{**body,'csrf':'wrong'},origin=self.base)[0],403)
        self.assertEqual(self.request('/library/review/confirm',body,origin=self.base,extra={'Sec-Fetch-Site':'cross-site'})[0],403)
        self.assertEqual(self.workflow.calls,[])
        code,_,raw=self.request('/library/review/confirm',body,origin=self.base)
        self.assertEqual(code,200);self.assertEqual(json.loads(raw)['data']['state'],'completed')
        self.request('/library/review/confirm',body,origin=self.base);self.assertEqual(len(self.workflow.calls),1)
        code,_,raw=self.request('/api/library/read',{'operation':'review_status','args':{'ticket':ticket}})
        self.assertEqual(json.loads(raw)['data']['state'],'completed')

    def test_cancel_expiry_and_other_grant_never_dispatch(self):
        ticket,body=self.prepare()
        rid,csrf=self.node.pairing.create(self.origin,'z'*32);other=self.node.pairing.decide(rid,csrf,True)['accessCode']
        self.assertEqual(self.request('/api/library/read',{'operation':'review_status','args':{'ticket':ticket}},token=other)[0],403)
        self.request('/library/review/confirm',{**body,'action':'deny'},origin=self.base)
        self.request('/library/review/confirm',body,origin=self.base);self.assertEqual(self.workflow.calls,[])
        self.node.library.tickets[ticket]['state']='pending';self.node.library.tickets[ticket]['expires']=0
        _,_,raw=self.request('/library/review/confirm',body,origin=self.base)
        self.assertEqual(json.loads(raw)['data']['state'],'expired');self.assertEqual(self.workflow.calls,[])

    def test_unknown_is_not_success_and_refresh_does_not_replay(self):
        self.workflow.result={'state':'unknown','automatic_retry':False}
        ticket,body=self.prepare();_,_,raw=self.request('/library/review/confirm',body,origin=self.base)
        self.assertEqual(json.loads(raw)['data']['state'],'unknown')
        self.request('/api/library/read',{'operation':'review_status','args':{'ticket':ticket}})
        self.request('/library/review/confirm',body,origin=self.base);self.assertEqual(len(self.workflow.calls),1)

    def test_typed_conflict_preserves_diagnostics(self):
        def conflict(**args): raise WorkflowError('conflict','Source changed',409)
        self.workflow.describe=conflict
        code,_,raw=self.request('/api/library/read',{'operation':'describe','args':{'library_id':'lib','cell_id':'cell'}})
        self.assertEqual(code,409);self.assertEqual(json.loads(raw)['error']['code'],'conflict')

    def test_fresh_preview_replaces_only_a_never_executed_expired_or_denied_ticket(self):
        ticket,body=self.prepare()
        self.request('/library/review/confirm',{**body,'action':'deny'},origin=self.base)
        next_ticket,_=self.prepare()
        self.assertNotEqual(next_ticket,ticket)
        self.node.library.tickets[next_ticket]['expires']=0
        _,_,raw=self.request('/api/library/read',{'operation':'review_status','args':{'ticket':next_ticket}})
        self.assertEqual(json.loads(raw)['data']['state'],'expired')
        final_ticket,body=self.prepare()
        self.assertNotEqual(final_ticket,next_ticket)
        self.request('/library/review/confirm',body,origin=self.base)
        same,_=self.prepare()
        self.assertEqual(same,final_ticket)
        self.assertEqual(len(self.workflow.calls),1)

    def test_new_pairing_after_unknown_receipt_never_rekeys_dispatch(self):
        self.workflow.result={'state':'unknown','automatic_retry':False}
        _,body=self.prepare();self.request('/library/review/confirm',body,origin=self.base)
        self.node.library=LocalLibrary(self.workflow,self.node.pairing,self.base)
        ticket,body=self.prepare()
        self.assertEqual(self.node.library.tickets[ticket]['state'],'unknown')
        self.request('/library/review/confirm',body,origin=self.base)
        self.assertEqual(len(self.workflow.calls),1)


class RealWorkflowTests(unittest.TestCase):
    """Exercise the actual HTTP adapter and Git workflow, only in a disposable repo."""
    request=BoundaryTests.request

    def setUp(self):
        spec=importlib.util.spec_from_file_location('library_fixture',ROOT/'tests/library/test_workflow.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        self.fixture=module.LibraryWorkflowTest();self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        BoundaryTests.setUp(self)
        self.workflow=self.fixture.workflow
        self.node.library=LocalLibrary(self.workflow,self.node.pairing,self.base)

    def tearDown(self): BoundaryTests.tearDown(self)

    def call(self,operation,args):
        route='prepare' if operation.startswith('preview_') else 'read'
        code,_,raw=self.request('/api/library/'+route,{'operation':operation,'args':args})
        self.assertEqual(code,200,raw)
        return json.loads(raw)['data']

    def human_confirm(self,proposal):
        code,_,raw=self.request('/api/library/review-request',{'review_id':proposal['review_id']})
        self.assertEqual(code,200)
        ticket=json.loads(raw)['data']['ticket'];csrf=self.node.library.tickets[ticket]['csrf']
        code,_,raw=self.request('/library/review/confirm',{'ticket':ticket,'csrf':csrf,'action':'confirm'},origin=self.base)
        self.assertEqual(code,200,raw);result=json.loads(raw)['data']
        self.assertEqual(result['state'],'completed',result)
        self.assertEqual(self.call('review_status',{'ticket':ticket})['state'],'completed')
        return result['result']

    def test_source_checkpoint_scoped_commit_and_restore_across_real_transport(self):
        scope={'library_id':'demo','cell_id':'gain'};f=self.fixture
        current=self.call('read_file',{**scope,'path':f.path})
        preview=self.call('preview_save',{**scope,'path':f.path,'base_sha256':current['sha256'],'content':f.after})
        self.assertEqual((f.root/f.path).read_text(),f.before)
        self.human_confirm(preview)
        self.assertEqual((f.root/f.path).read_text(),f.after)
        self.assertEqual(f.head(),f.initial)
        points=self.call('checkpoints',scope)['checkpoints'];self.assertEqual(len(points),1)
        committed=self.human_confirm(self.call('preview_commit',{**scope,'base_commit':f.head(),'title':'Reviewed resistor edit'}))
        self.assertNotEqual(f.head(),f.initial)
        self.assertEqual(f.git('diff','--name-only',f.initial,f.head()).decode().strip(),f.path)
        after=self.call('read_file',{**scope,'path':f.path})
        self.human_confirm(self.call('preview_restore',{**scope,'path':f.path,'base_sha256':after['sha256'],
                           'checkpoint_id':points[0]['checkpoint_id'],'checkpoint_version':'before'}))
        self.assertEqual((f.root/f.path).read_text(),f.before)
        self.assertEqual(f.head(),committed['commit'])
        self.assertEqual(len(self.call('checkpoints',scope)['checkpoints']),2)
        self.assertTrue(self.call('current',scope)['changes'])

    def test_save_restore_save_same_text_is_a_new_explicit_checkpoint(self):
        scope={'library_id':'demo','cell_id':'gain'};f=self.fixture
        first=self.call('preview_save',{**scope,'path':f.path,'base_sha256':f.sha(f.before),'content':f.after})
        saved=self.human_confirm(first)
        self.human_confirm(self.call('preview_restore',{**scope,'path':f.path,'base_sha256':f.sha(f.after),
                           'checkpoint_id':saved['checkpoint_id'],'checkpoint_version':'before'}))
        repeated=self.call('preview_save',{**scope,'path':f.path,'base_sha256':f.sha(f.before),'content':f.after})
        self.assertNotEqual(first['review_id'],repeated['review_id'])
        self.human_confirm(repeated)
        self.assertEqual((f.root/f.path).read_text(),f.after)
        self.assertEqual(len(self.call('checkpoints',scope)['checkpoints']),3)
        self.assertEqual(f.head(),f.initial)


if __name__=='__main__': unittest.main()
