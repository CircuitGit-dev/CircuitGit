"""Bounded metadata/session/progress tests. All app-server and circuit operations are synthetic."""
import base64,copy,io,json,struct,sys,tempfile,threading,time,unittest,shutil,zlib
from pathlib import Path
from unittest.mock import Mock,patch
ROOT = Path(__file__).resolve().parents[2] / 'apps/codex'
sys.path.insert(0,str(ROOT))
(ROOT/'scratch').mkdir(exist_ok=True)
from icwb.ai import AiSession,INSTRUCTIONS
from icwb.host import AiRoutes
from icwb.sessions import SessionRegistry
from icwb.service import Service,Failure
from icwb.images import SessionImages,validate_images

class FakeRpc:
    created=[]
    def __init__(self,executable,cwd,callback,timeout=30):
        self.callback=callback;self.sent=[];self.closed=False;self.info={};self.n=0;self.thread='thread-'+str(len(self.created));self.fail_catalog=False;self.provider='fixture';self.created.append(self)
    def call(self,method,params):
        self.sent.append({'method':method,'params':copy.deepcopy(params)})
        if method=='config/read':return {'config':{'model':'slow-slug','model_provider':self.provider}}
        if method=='model/list':
            if self.fail_catalog:raise Failure('catalog_failed','SYNTHETIC provider catalog unavailable',75)
            return {'data':[{'id':'slow-id','model':'slow-slug','displayName':'Fixture careful','description':'Synthetic general model','hidden':False,'isDefault':True},
                            {'id':'quick-id','model':'quick-slug','displayName':'Fixture quick','description':'Synthetic fast option, not benchmarked','hidden':False,'isDefault':False},
                            {'id':'hidden-id','model':'hidden-slug','displayName':'Hidden fixture','hidden':True}], 'nextCursor':None}
        if method=='thread/start':return {'thread':{'id':self.thread},'model':'slow-slug','modelProvider':self.provider,'approvalPolicy':'on-request','approvalsReviewer':'user'}
        if method=='turn/start':
            self.n+=1;tid='turn-'+self.thread+'-'+str(self.n)
            self.callback({'method':'turn/started','params':{'threadId':self.thread,'turn':{'id':tid,'status':'inProgress'}}})
            return {'turn':{'id':tid}}
        return {}
    def send(self,msg):self.sent.append(msg)
    def close(self):self.closed=True

def context():return {'version':1,'revision':1,'mode':'live','project':{'id':'SYNTHETIC'},'file':{'path':'projects/demo.scs','baseCommit':'a'*40,'persistedSha256':'b'*64,'currentTextSha256':'b'*64,'dirty':False}}
def source_call(self,op,args):
    if op=='read':return {'project':{'id':'SYNTHETIC'},'file':{'path':'projects/demo.scs','base_commit':'a'*40,'sha256':'b'*64,'content':'R0 r=2k'},'geometry':{}}
    if op=='projects':return {'projects':[]}
    raise AssertionError('Unexpected real or mutation service call '+op)

class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=ROOT/'scratch');self.service=Service({'gateway_url':'http://127.0.0.1:1','state_dir':self.tmp.name});self.live=[]
        self.patch=patch.object(Service,'call',source_call);self.patch.start()
    def tearDown(self):
        for obj in self.live:obj.close()
        self.patch.stop();self.tmp.cleanup()
    def ai(self,service=None,sid='default'):
        a=AiSession(service or self.service,FakeRpc,session_id=sid);self.live.append(a);return a
    def done(self,a,ms=17452):
        a._receive({'method':'turn/completed','params':{'threadId':a.thread_id,'turn':{'id':a.turn_id,'status':'completed','durationMs':ms}}})
    def routes(self):
        r=AiRoutes(self.service);r.sessions.factory=lambda service,session_id:self.ai(service,session_id);return r
    def test_catalog_allowlist_no_thread_unknown_and_explicit_failure(self):
        a=self.ai();catalog=a.models();self.assertEqual([m['id'] for m in catalog['models']],['slow-id','quick-id']);self.assertFalse(catalog['inference_verified']);self.assertIsNone(a.thread_id)
        with self.assertRaises(Failure):a.turn('unknown',context(),'unknown-key','imaginary')
        self.assertEqual(a.state,'idle');self.assertFalse(any(x['method']=='turn/start' for x in a.rpc.sent))
        a.catalog=None;a.rpc.fail_catalog=True
        with self.assertRaises(Failure):a.models()
        a.turn('use original default',context(),'default-key');self.assertNotIn('model',[x for x in a.rpc.sent if x['method']=='turn/start'][-1]['params'])
    def test_turn_selection_restore_default_busy_and_identity(self):
        a=self.ai();a.turn('first',context(),'first-key');self.done(a)
        a.turn('quick',context(),'quick-key','quick-id');self.assertEqual(a.rpc.sent[-1]['params']['model'],'quick-slug')
        count=len(a.rpc.sent)
        with self.assertRaises(Failure):a.turn('busy',context(),'busy-key','slow-id')
        self.assertEqual(len(a.rpc.sent),count)
        with self.assertRaises(Failure):a.turn('quick',context(),'quick-key','slow-id')
        self.done(a);a.turn('back to default',context(),'restore-key');self.assertEqual(a.rpc.sent[-1]['params']['model'],'slow-slug')
        self.assertTrue(all('modelProvider' not in x.get('params',{}) for x in a.rpc.sent))
        self.assertEqual(sum(x.get('method')=='thread/start' for x in a.rpc.sent),1)
    def test_prompt_in_actual_thread_params(self):
        a=self.ai();a.turn('prompt check',context(),'prompt-key')
        params=next(x['params'] for x in a.rpc.sent if x['method']=='thread/start');doc=(ROOT/'prompts/workbench.md').read_text()
        self.assertTrue(params['developerInstructions'].startswith(INSTRUCTIONS));self.assertIn(doc,params['developerInstructions']);self.assertIn('2026-11-10.1',params['developerInstructions'])
        self.assertFalse(params['allowProviderModelFallback']);self.assertEqual(params['sandbox'],'read-only')
    def test_progress_ownership_timing_reasoning_filtered(self):
        a=self.ai();a.turn('first',context(),'one-key-000');old=a.turn_id
        a._receive({'method':'item/started','params':{'threadId':a.thread_id,'turnId':old,'item':{'id':'m','type':'agentMessage','phase':'final_answer'}}})
        a._receive({'method':'item/agentMessage/delta','params':{'threadId':a.thread_id,'turnId':old,'itemId':'m','delta':'Saved answer'}})
        self.done(a,127299);a.turn('second',context(),'two-key-000');count=len(a.events)
        a._receive({'method':'turn/completed','params':{'threadId':a.thread_id,'turn':{'id':old,'status':'completed'}}})
        a._receive({'method':'item/reasoning/textDelta','params':{'delta':'NEVER_STORE_REASONING'}})
        a._receive({'method':'item/started','params':{'item':{'id':'r','type':'reasoning','text':'NEVER_STORE_REASONING'}}})
        self.assertEqual(len(a.events),count);self.assertEqual(a.state,'running')
        history=a.history();self.assertEqual(history['turns'][0]['duration_ms'],127299);self.assertIn('first_text_ms',history['turns'][0]['timings'])
        self.assertNotIn('NEVER_STORE_REASONING',json.dumps(history));self.assertEqual(a.events[-1]['request_key'],'two-key-000')
    def test_explicit_sessions_metadata_limits_and_no_eager_rpc(self):
        r=self.routes();before=len(FakeRpc.created);new=r.post('/api/ai/sessions',{'name':'Second'})
        self.assertEqual(len(FakeRpc.created),before);self.assertEqual(r.sessions.instances,{})
        self.assertEqual(r.post('/api/ai/sessions/rename',{'session_id':new['session_id'],'name':'Renamed'})['name'],'Renamed')
        for _ in range(6):r.post('/api/ai/sessions',{})
        self.assertEqual(len(r.get('/api/ai/sessions',{})['sessions']),8)
        with self.assertRaises(Failure):r.post('/api/ai/sessions',{})
        with self.assertRaises(Failure):r.get('/api/ai/models',{'session_id':['not-real']})
        with self.assertRaises(Failure):r.post('/api/ai/turn',{'session_id':'default','message':'x','context':context(),'idempotency_key':'extra-key','provider':'other'})
        with self.assertRaises(Failure):r.get('/api/ai/models',{'provider':['other']})
    def test_session_turns_and_approval_are_isolated(self):
        r=self.routes();sid=r.post('/api/ai/sessions',{})['session_id']
        body={'message':'one','context':context(),'idempotency_key':'same-key-123'}
        ra=r.post('/api/ai/turn',body);rb=r.post('/api/ai/turn',{**body,'session_id':sid,'model':'quick-id'})
        a=r.sessions.get('default');b=r.sessions.get(sid)
        self.assertIsNot(a.rpc,b.rpc);self.assertNotEqual(a.scratch,b.scratch);self.assertNotEqual(ra['thread_id'],rb['thread_id']);self.assertNotEqual(a.service.state,b.service.state)
        a.pending['ONLY_A']={'status':'pending','params':{'threadId':a.thread_id,'turnId':a.turn_id},'kind':'codex','rpc_id':1,'method':'item/fileChange/requestApproval','request_key':'same-key-123'}
        with self.assertRaises(Failure):r.post('/api/ai/approval',{'session_id':sid,'approval_id':'ONLY_A','decision':'deny'})
        self.assertEqual(a.pending['ONLY_A']['status'],'pending');self.assertEqual(b.state,'running')
        r.post('/api/ai/approval',{'approval_id':'ONLY_A','decision':'deny'});self.assertEqual(a.state,'suspended');self.assertEqual(b.state,'running')
        r.close();self.assertTrue(a.rpc.closed and b.rpc.closed)
    def test_restart_completed_history_is_reference_not_execution(self):
        a=self.ai();a.turn('Remember the capacitor is 2pF',context(),'history-key')
        a._receive({'method':'item/agentMessage/delta','params':{'threadId':a.thread_id,'turnId':a.turn_id,'itemId':'m','delta':'Recorded capacitor 2pF'}});self.done(a);a.close()
        b=self.ai();self.assertTrue(b.restored);self.assertIsNone(b.rpc);self.assertEqual(len(b.history()['messages']),2)
        b.turn('What did we discuss?',context(),'new-key-000');prompt=b.rpc.sent[-1]['params']['input'][0]['text']
        self.assertIn('UNTRUSTED REFERENCE ONLY',prompt);self.assertIn('2pF',prompt);self.assertEqual(prompt.count('What did we discuss?'),1)
        self.assertEqual(sum(x.get('method')=='turn/start' for x in b.rpc.sent),1)
    def test_restart_running_is_suspended_no_replay(self):
        a=self.ai();a.turn('unfinished',context(),'unfinished-key');a.close();before=len(FakeRpc.created)
        b=self.ai();self.assertEqual(b.state,'suspended');self.assertEqual(len(FakeRpc.created),before)
        with self.assertRaises(Failure):b.turn('continue',context(),'must-not-replay')
        self.assertEqual(len(FakeRpc.created),before)

    def test_delete_retains_history_images_receipts_and_releases_slot(self):
        r=self.routes();rows=[r.post('/api/ai/sessions',{'name':'Session '+str(i)}) for i in range(7)]
        sid=rows[0]['session_id'];a=r.sessions.get(sid);b=r.sessions.get(rows[1]['session_id'])
        a.turn('retained message',context(),'delete-retained-key');self.done(a)
        def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
        png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0\x20\x80\x40'))+chunk(b'IEND',b'')
        prepared=validate_images([{'name':'retained.png','mime_type':'image/png','data_url':'data:image/png;base64,'+base64.b64encode(png).decode()}])
        SessionImages(a.scratch).store(prepared);a.messages[0]['images']=[prepared[0][0]];a._persist(force=True)
        operation=a.service.state/'operations'/'retained.json';operation.parent.mkdir();operation.write_text('{"synthetic":"receipt"}')
        before={p:p.read_bytes() for p in a.service.state.rglob('*') if p.is_file()}
        b.turn('other active session',context(),'other-active-key');b_rpc=b.rpc
        expected={'session_id':sid,'deleted':True,'history_retained':True}
        with patch.object(a.rpc,'close',wraps=a.rpc.close) as close:
            self.assertEqual(r.post('/api/ai/sessions/delete',{'session_id':sid}),expected)
            registry_bytes=r.sessions.path.read_bytes()
            self.assertEqual(r.post('/api/ai/sessions/delete',{'session_id':sid}),expected)
            self.assertEqual(r.sessions.path.read_bytes(),registry_bytes);close.assert_called_once()
            a.close();close.assert_called_once()
        self.assertTrue(a.rpc.closed);self.assertFalse(b_rpc.closed);self.assertEqual(b.state,'running')
        self.assertEqual({p:p.read_bytes() for p in before},before)
        self.assertNotIn(sid,r.sessions.instances);self.assertEqual(len(r.sessions.list()['sessions']),7)
        replacement=r.post('/api/ai/sessions',{'name':'Replacement'})
        self.assertNotEqual(replacement['session_id'],sid);self.assertEqual(len(r.sessions.list()['sessions']),8)
        self.assertIn(sid,json.loads(r.sessions.path.read_text())['deleted_sessions'])

    def test_unloaded_delete_and_restart_tombstone_never_construct_session(self):
        r=self.routes();sid=r.post('/api/ai/sessions',{'name':'Unloaded'})['session_id']
        saved=self.service.state/'sessions'/sid/'ai-session.json';saved.parent.mkdir(parents=True)
        saved.write_text(json.dumps({'session_id':sid,'state':'complete','pending':[],'messages':[{'role':'user','text':'retained'}]}))
        original=saved.read_bytes();r.sessions.factory=Mock(side_effect=AssertionError('NO SESSION CONSTRUCTION'))
        listing=r.sessions.list();row=next(v for v in listing['sessions'] if v['session_id']==sid)
        self.assertTrue(row['can_delete']);self.assertIsNone(row['delete_block_reason'])
        result=r.sessions.delete(sid);self.assertEqual(saved.read_bytes(),original);r.sessions.factory.assert_not_called()
        restored=SessionRegistry(self.service,session_factory=Mock(side_effect=AssertionError('NO RESURRECTION')))
        self.assertEqual(restored.delete(sid),result);self.assertEqual(len(restored.list()['sessions']),1)
        for call in (lambda:restored.get(sid),lambda:restored.info(sid),lambda:restored.rename(sid,'revive')):
            with self.assertRaises(Failure) as error:call()
            self.assertEqual(error.exception.code,'not_found')
        routes=AiRoutes(self.service);routes.sessions=restored
        for path,query in (('/api/ai/history',{'session_id':[sid]}),('/api/ai/models',{'session_id':[sid]}),
                           ('/api/ai/image',{'session_id':[sid],'image_id':['a'*64]}),('/api/ai/context',{'session_id':[sid]})):
            with self.assertRaises(Failure):routes.get(path,query)
        restored.rename('default','Default retained');restored.create('New after deletion')
        again=SessionRegistry(self.service)
        self.assertIn(sid,again.deleted);restored.factory.assert_not_called()

    def test_delete_body_unknown_and_default_protection(self):
        r=self.routes();before=len(FakeRpc.created)
        default=r.sessions.list()['sessions'][0]
        self.assertFalse(default['can_delete']);self.assertEqual(default['delete_block_reason'],'default_session')
        for body in ({},{'session_id':'default','confirm':True},{'session_id':None},{'session_id':['default']}):
            with self.assertRaises(Failure):r.post('/api/ai/sessions/delete',body)
        with self.assertRaises(Failure) as error:r.post('/api/ai/sessions/delete',{'session_id':'default'})
        self.assertEqual(error.exception.details['delete_block_reason'],'default_session')
        with self.assertRaises(Failure) as error:r.sessions.delete('unknown')
        self.assertEqual(error.exception.code,'not_found');self.assertEqual(len(FakeRpc.created),before)
        self.assertEqual(r.sessions.deleted,{});self.assertEqual(r.sessions.instances,{})

    def test_active_metadata_pending_and_closing_delete_guards(self):
        r=self.routes();sid=r.sessions.create('Guarded')['session_id'];a=r.sessions.get(sid)
        cases=[('starting',False,{},False,'active_turn'),('running',False,{},False,'active_turn'),
               ('idle',True,{},False,'metadata_busy'),('idle',False,{},True,'session_closing')]
        for status in ('pending','resolving','suspended','unknown'):
            cases.append(('suspended',False,{'approval':{'status':status}},False,'unresolved_approval'))
        for state,busy,pending,closing,reason in cases:
            a.state=state;a.metadata_busy=busy;a.pending=copy.deepcopy(pending);a.closing=closing
            with self.subTest(reason=reason,pending=pending):
                info=r.sessions.info(sid);self.assertFalse(info['can_delete']);self.assertEqual(info['delete_block_reason'],reason)
                with self.assertRaises(Failure) as error:r.sessions.delete(sid)
                self.assertEqual(error.exception.details['delete_block_reason'],reason)
                self.assertFalse(a.deleted);self.assertNotIn(sid,r.sessions.deleted)
        a.state='suspended';a.metadata_busy=False;a.pending={'old':{'status':'resolved'}};a.closing=False
        self.assertTrue(r.sessions.info(sid)['can_delete']);self.assertTrue(r.sessions.delete(sid)['deleted'])

    def test_saved_active_and_unresolved_approval_block_without_rpc(self):
        r=self.routes();sid=r.sessions.create('Saved')['session_id']
        path=self.service.state/'sessions'/sid/'ai-session.json';path.parent.mkdir(parents=True)
        before=len(FakeRpc.created)
        for state,pending,busy,reason in [('starting',[],False,'active_turn'),('running',[],False,'active_turn'),
                                          ('idle',[],True,'metadata_busy')]+[
                ('complete',[{'status':status}],False,'unresolved_approval') for status in ('pending','resolving','suspended')]:
            path.write_text(json.dumps({'session_id':sid,'state':state,'pending':pending,'metadata_busy':busy}))
            self.assertEqual(r.sessions.info(sid)['delete_block_reason'],reason)
            with self.assertRaises(Failure):r.sessions.delete(sid)
        self.assertEqual(len(FakeRpc.created),before);self.assertEqual(r.sessions.instances,{})
        path.write_text(json.dumps({'session_id':sid,'state':'suspended','pending':[]}))
        self.assertTrue(r.sessions.info(sid)['can_delete']);self.assertTrue(r.sessions.delete(sid)['deleted'])

    def test_deleted_late_handle_cannot_read_start_turn_or_approve(self):
        r=self.routes();sid=r.sessions.create('Late handle')['session_id'];a=r.sessions.get(sid)
        a.turn('retained',context(),'retained-late-key');self.done(a);a.models()
        r.sessions.delete(sid);before=len(a.rpc.sent);files={p:p.read_bytes() for p in a.service.state.rglob('*') if p.is_file()}
        actions=[lambda:a.connect(),lambda:a.models(),lambda:a.models(refresh=True),lambda:a.connection(),lambda:a.doctor(),
                 lambda:a._start_thread(),lambda:a.turn('new',context(),'new-late-key'),lambda:a.turn('retained',context(),'retained-late-key'),
                 lambda:a.approve('old','approve'),lambda:a.history(),lambda:a.poll(0),lambda:a.image('a'*64),
                 lambda:a.interrupt(),lambda:a._tool({'id':'late','params':{}}),lambda:a._tool_reply('late',True,{})]
        for index,action in enumerate(actions):
            with self.subTest(action=index),self.assertRaises(Failure) as error:action()
            self.assertEqual(error.exception.code,'not_found')
        events=copy.deepcopy(a.events);messages=copy.deepcopy(a.messages)
        a._receive({'id':'late','method':'item/tool/call','params':{'tool':'ic_apply'}})
        a._receive({'method':'item/agentMessage/delta','params':{'delta':'LATE_DATA'}})
        a.event('item/agentMessage/delta',{'delta':'LATE_DATA'});a._persist(force=True)
        self.assertEqual(a.events,events);self.assertEqual(a.messages,messages);self.assertEqual(len(a.rpc.sent),before)
        self.assertEqual({p:p.read_bytes() for p in files},files);self.assertEqual(a.active_calls,0)

    def test_inflight_connect_or_catalog_prevents_deletion(self):
        for phase in ('connect','catalog'):
            r=self.routes();sid=r.sessions.create('Concurrent '+phase)['session_id'];a=r.sessions.get(sid)
            entered=threading.Event();release=threading.Event();outcome=[]
            def gate():
                entered.set()
                if not release.wait(5):raise AssertionError('test release timeout')
            if phase=='connect':
                def factory(*args,**kwargs):gate();return FakeRpc(*args,**kwargs)
                a.factory=factory
            else:
                a.connect();original=a.rpc.call
                def call(method,params):
                    if method=='model/list':gate()
                    return original(method,params)
                a.rpc.call=call
            def work():
                try:outcome.append(a.models(refresh=True))
                except Exception as error:outcome.append(error)
            thread=threading.Thread(target=work);thread.start()
            try:
                self.assertTrue(entered.wait(5));self.assertEqual(r.sessions.info(sid)['delete_block_reason'],'session_busy')
                with self.assertRaises(Failure) as error:r.sessions.delete(sid)
                self.assertEqual(error.exception.details['delete_block_reason'],'session_busy');self.assertFalse(a.deleted)
            finally:release.set();thread.join(5)
            self.assertFalse(thread.is_alive());self.assertIsInstance(outcome[0],dict);self.assertEqual(a.active_calls,0)
            self.assertTrue(r.sessions.delete(sid)['deleted']);self.assertTrue(a.rpc.closed)

    def test_delete_wins_before_queued_old_handle_enters(self):
        r=self.routes();sid=r.sessions.create('Queued handle')['session_id'];a=r.sessions.get(sid)
        entered=threading.Event();release=threading.Event();outcome=[];before=len(FakeRpc.created)
        def work():
            entered.set();release.wait(5)
            try:a.turn('late work',context(),'late-queued-key')
            except Exception as error:outcome.append(error)
        thread=threading.Thread(target=work);thread.start();self.assertTrue(entered.wait(5))
        try:r.sessions.delete(sid)
        finally:release.set();thread.join(5)
        self.assertFalse(thread.is_alive());self.assertIsInstance(outcome[0],Failure)
        self.assertEqual(outcome[0].code,'not_found');self.assertEqual(len(FakeRpc.created),before);self.assertEqual(a.turns,{})

    def test_failed_tombstone_write_does_not_close_or_remove_session(self):
        r=self.routes();sid=r.sessions.create('Write failure')['session_id'];a=r.sessions.get(sid);a.connect()
        before=r.sessions.path.read_bytes()
        with patch('icwb.sessions.atom',side_effect=OSError('synthetic disk error')):
            with self.assertRaises(OSError):r.sessions.delete(sid)
        self.assertEqual(r.sessions.path.read_bytes(),before);self.assertIs(r.sessions.get(sid),a)
        self.assertFalse(a.deleted);self.assertFalse(a.closing);self.assertFalse(a.rpc.closed);self.assertNotIn(sid,r.sessions.deleted)
        self.assertTrue(r.sessions.delete(sid)['deleted'])

    def test_close_failure_keeps_tombstone_and_retry_does_not_close_again(self):
        r=self.routes();sid=r.sessions.create('Close failure')['session_id'];a=r.sessions.get(sid);a.connect()
        with patch.object(a.rpc,'close',side_effect=OSError('synthetic close error')) as close:
            with self.assertRaises(OSError):r.sessions.delete(sid)
            self.assertEqual(r.sessions.delete(sid),{'session_id':sid,'deleted':True,'history_retained':True})
            close.assert_called_once();a.close();close.assert_called_once()
        self.assertTrue(a.deleted);self.assertNotIn(sid,r.sessions.instances)

    def test_tombstone_survives_create_rename_and_rejects_identity_reuse(self):
        r=self.routes();sid=r.sessions.create('Gone')['session_id'];r.sessions.delete(sid)
        new=r.sessions.create('Live')['session_id'];r.sessions.rename(new,'Renamed')
        self.assertIn(sid,SessionRegistry(self.service).deleted)
        with patch('icwb.sessions.uuid.uuid4',return_value=Mock(hex=sid[2:]+'0'*8)):
            with self.assertRaises(Failure):r.sessions.create('Cannot reuse deleted id')
        with self.assertRaises(Failure):r.sessions.get(sid)

    def test_existing_sse_ends_normally_after_delete_or_close(self):
        for action in ('delete','close'):
            r=self.routes();sid=r.sessions.create('SSE '+action)['session_id'];a=r.sessions.get(sid)
            output=io.BytesIO();handler=Mock();handler.wfile=Mock(wraps=output)
            handler.wfile.flush.side_effect=(lambda:r.sessions.delete(sid)) if action=='delete' else a.close
            with patch('icwb.host.time',Mock(sleep=lambda _:None)):
                r.stream(handler,0,sid)
            handler.send_response.assert_called_once_with(200);handler.end_headers.assert_called_once()
            handler.wfile.write.assert_called_once();self.assertTrue(handler.close_connection)
            self.assertTrue(output.getvalue().startswith(b'id: '));self.assertNotIn(b'"error"',output.getvalue())
            self.assertTrue(a.closing);self.assertEqual(a.deleted,action=='delete')

    def test_sse_still_propagates_unrelated_poll_failures(self):
        for code,closing in (('conflict',False),('not_found',False),('invalid_input',True),('forbidden',True)):
            r=self.routes();sid=r.sessions.create('SSE failure')['session_id'];a=r.sessions.get(sid)
            handler=Mock();error=Failure(code,'Synthetic unrelated poll failure',4)
            if closing:handler.end_headers.side_effect=a.close
            with patch.object(a,'poll',side_effect=error):
                with self.assertRaises(Failure) as caught:r.stream(handler,0,sid)
            self.assertIs(caught.exception,error);handler.send_response.assert_called_once_with(200)
            handler.wfile.write.assert_not_called()


if __name__=='__main__':unittest.main(verbosity=2)
