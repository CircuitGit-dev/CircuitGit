"""Finite MCP window contract tests. All writes and data are synthetic fixtures."""
import base64
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit,parse_qs
ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/codex'),str(ROOT/'modules/gateway_client')]
from icwb.service import Failure,canonical,digest,sha,tools as core_tools
from icwb.views import ViewService
from icwb.view_contracts import SCHEMAS,RESOURCES,MIME,tools as view_tools
from icwb.mcp import run

RAW=b'{"native":"original geometry fixture"}'
class FakeGateway:
    origin='http://127.0.0.1:1';port=1;timeout=1
    def __init__(self,service):self.service=service;self.calls=[]
    def request(self,path,body=None):
        self.calls.append((path,body));assert body is None,'View reads must not POST raw gateway operations'
        s=self.service;u=urlsplit(path);q={k:v[0] for k,v in parse_qs(u.query).items()}
        if u.path=='/api/project':return s.registry()
        if u.path=='/api/jobs':return {'jobs':[{'run_id':'saved-run','associated_project_id':'demo','source_commit':'b'*40,'configuration':'tran','state':'archived'},*s.extra_jobs]}
        if u.path=='/api/configuration':return {'schema':'ic.sim.configuration-description.v1','project_id':'demo','source_commit':s.commit,'configuration':'tran','configuration_text':s.config,'configuration_path':'projects/demo/config.json','configuration_sha256':sha(s.config),'effective':{'compiled_inputs_sha256':'e'*64}}
        if u.path=='/api/jobs/saved-run/signals':return {'schema':'ic.waveforms.v1','run_id':'saved-run','source_commit':'b'*40,'signals':[{'id':'sig-1','label':'/out','unit':'V','status':'available'}]}
        if u.path=='/api/jobs/saved-run/waveform':return {'run_id':'saved-run','source_commit':'b'*40,'signal_id':q['signal_id'],'points':[[0,0],[1e-9,1]],'data_basis':'SYNTHETIC fixture'}
        if u.path=='/api/jobs/saved-run/waveform-map':return {'run_id':'saved-run','source_commit':'b'*40,'status':'unmapped','objects':[]}
        if u.path=='/api/geometry/viewer-manifest':return {'format':1,'id':'native-fixture','entry':'native/root.json','files':[{'path':'native/root.json','sha256':sha(RAW.decode()),'size':len(RAW)}],'pool':[]}
        raise AssertionError('Unexpected gateway route '+path)

class FakeService:
    def __init__(self,state):
        self.state=Path(state);self.state.mkdir(parents=True,exist_ok=True);self.commit='a'*40;self.source='R0 (in out) resistor r=2k\n';self.config='{"tran":{"stop":"1n"}}\n';self.gateway=FakeGateway(self);self.receipts={};self.calls=[];self.extra_jobs=[]
    def registry(self):return {'repo':'SYNTHETIC','branch':'fixture','source_commit':self.commit,'projects':[{'id':'demo','source_path':'projects/demo/circuit.scs','configurations':[{'id':'tran','configuration_path':'projects/demo/config.json'}]}]}
    def project(self,pid):
        if pid!='demo':raise Failure('invalid_input','Unknown project')
        return self.registry(),self.registry()['projects'][0]
    def call(self,op,args):
        self.calls.append((op,copy.deepcopy(args)))
        if op=='projects':return self.registry()
        if op=='read':
            return {'project':{'id':'demo'},'file':{'path':args.get('path','projects/demo/circuit.scs'),'base_commit':self.commit,'sha256':sha(self.source),'content':self.source},
                    'geometry':{'source_commit':self.commit,'source_hash':sha(self.source),'geometry':{'available':True,'stale':True,'native_ready':False,'bundle_commit':'c'*40,'manifest_sha256':'d'*64,'cells':[{'id':'top','entrypoint':'native/root.json'}],'files':[]}}}
        if op=='diff':return {'review_id':digest(args),'diff':'--- old\n+++ new\n-stop=1n\n+stop=2n','validation':{'fixture':True}}
        if op=='sim_plan':return {**args,'blockers':[],'settings':{'fixture':True}}
        if op in ('apply','sim_submit','sim_collect','sim_archive'):
            rid=digest([self.gateway.origin,args['idempotency_key']]);fp=digest([op,args]);old=self.receipts.get(rid)
            if old and old['fingerprint']!=fp:raise Failure('conflict','Changed key arguments',3)
            self.receipts[rid]=old or {'request_id':rid,'operation':op,'state':'pending_approval','fingerprint':fp,'arguments':copy.deepcopy(args),'review':{'diff':'SYNTHETIC REVIEW'},'automatic_retry':False}
            return copy.deepcopy(self.receipts[rid])
        if op=='request_status':
            if args['request_id'] not in self.receipts:raise Failure('not_found','Unknown request')
            return copy.deepcopy(self.receipts[args['request_id']])
        if op=='sim_results':return {'run_id':args['run_id'],'state':'collected','metrics':{'fixture':True}}
        raise Failure('invalid_input','Unknown operation')
    def resolve(self,*_):raise AssertionError('MCP must never resolve a human approval')

class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.service=FakeService(self.root/'state');self.ui=self.root/'ui';self.ui.mkdir()
        for kind in RESOURCES:(self.ui/(kind+'.html')).write_text('<!doctype html><p>SYNTHETIC '+kind+' UI fixture</p>')
        self.views=ViewService(self.service,self.ui)
    def tearDown(self):self.tmp.cleanup()
    def call(self,name,args):
        public,private=self.views.call(name,args);return private if private is not None else public
    def open(self,kind='schematic',workspace=None):
        a={'project_id':'demo'}
        if workspace:a['workspace_id']=workspace
        if kind=='simulation':a['configuration']='tran'
        if kind=='waveforms':a['run_id']='saved-run'
        return self.call('ic_'+kind+'_open',a)
    def ref(self,v,cas=False):return {'workspace_id':v['workspace_id'],'view_id':v['view_id'],**({'expected_revision':v['revision']} if cas else {})}
    def data(self,v,kind,**args):return self.call('ic_view_data',{**self.ref(v),'revision':v['revision'],'query':{'kind':kind,**args}})['payload']
    def test_three_resources_and_open_identity(self):
        with self.assertRaises(Failure):self.call('ic_schematic_open',{'project_id':'demo','path':'projects/demo/config.json'})
        a=self.open();b=self.open('waveforms',a['workspace_id']);c=self.open('simulation',a['workspace_id'])
        self.assertEqual(len({a['view_id'],b['view_id'],c['view_id']}),3)
        self.assertEqual(b['identity']['source_commit'],'b'*40);self.assertEqual(a['identity']['source_commit'],'a'*40)
        self.assertTrue(all(v['ui']['mounted'] is None and v['readiness']['state']=='requested' for v in (a,b,c)))
        resources=self.views.resources();self.assertEqual(len(resources),4)
        for item in resources:self.assertEqual(self.views.read_resource(item['uri'])['contents'][0]['mimeType'],MIME)
        with self.assertRaises(Failure):self.views.read_resource('file:///etc/passwd')
        (self.ui/'waveforms.html').unlink()
        with self.assertRaises(Failure):self.views.read_resource(RESOURCES['waveforms'])
    def test_cas_workspace_selection_hide_and_restart(self):
        a=self.open();b=self.open('simulation',a['workspace_id']);other=self.open()
        a2=self.call('ic_view_select',{**self.ref(a,True),'selection':{'kind':'instance','name':'M0','occurrence_path':['XDUT','M0']}})
        self.assertEqual(a2['revision'],2);self.assertEqual(a2['selection']['verification'],'ui-metadata')
        with self.assertRaises(Failure):self.call('ic_view_state',{**self.ref(a,True),'visible':False})
        with self.assertRaises(Failure):self.call('ic_view_get',{'workspace_id':other['workspace_id'],'view_id':a['view_id']})
        a3=self.call('ic_view_state',{**self.ref(a2,True),'visible':False,'client_state':'loaded'})
        self.assertIsNone(a3['ui']['mounted']);self.assertEqual(a3['readiness']['basis'],'client-report')
        w=self.call('ic_workspace_get',{'workspace_id':a['workspace_id']});self.assertEqual(w['selection']['view_id'],a['view_id'])
        self.assertEqual(next(v for v in w['views'] if v['view_id']==b['view_id'])['revision'],1)
        restored=ViewService(self.service,self.ui);public,_=restored.call('ic_view_get',self.ref(a3));self.assertFalse(public['visible'])
    def test_historical_waveforms_independent_of_current_source(self):
        v=self.open('waveforms');self.service.commit='f'*40
        self.assertEqual(len(self.data(v,'signals')['signals']),1)
        self.assertEqual(self.data(v,'waveform',signal_id='sig-1')['points'][1][1],1)
        self.assertEqual(self.data(v,'mapping')['status'],'unmapped')
        with self.assertRaises(Failure):self.data(v,'waveform',signal_id='foreign')
        with self.assertRaises(Failure):self.data(v,'waveform',signal_id='sig-1',cursor_a=float('nan'))
        updated=self.call('ic_view_select',{**self.ref(v,True),'selection':{'kind':'signals','signal_ids':['sig-1']}})
        self.assertEqual(updated['selection']['verification'],'saved-signal-catalog')
        self.assertFalse(any('/saved-run'==p for p,_ in self.service.gateway.calls))
    def test_pinned_geometry_allowlist_hash_and_chunks(self):
        v=self.open()
        with self.assertRaises(Failure):self.data(v,'geometry_file',path='native/root.json')
        manifest={'format':1,'id':'native-fixture','entry':'native/root.json','files':[{'path':'native/root.json','sha256':sha(RAW.decode()),'size':len(RAW)}]}
        with patch.object(self.views,'_geometry_bytes',return_value=(canonical(manifest).encode(),'application/json')):self.data(v,'geometry_manifest',entry='top')
        with self.assertRaises(Failure):self.data(v,'geometry_file',path='../../secret')
        calls=[]
        class Response:
            status=200
            def read(self,limit):return RAW
            def getheader(self,*_):return 'application/json'
        class Connection:
            def __init__(self,*args,**kwargs):calls.append((args,kwargs))
            def request(self,method,path,headers):calls.append((method,path,headers))
            def getresponse(self):return Response()
            def close(self):pass
        with patch('icwb.views.http.client.HTTPConnection',Connection):
            first=self.data(v,'geometry_file',path='native/root.json',limit=12);second=self.data(v,'geometry_file',path='native/root.json',offset=12)
        self.assertEqual(base64.b64decode(first['data'])+base64.b64decode(second['data']),RAW)
        self.assertEqual(first['next_offset'],12);self.assertIsNone(second['next_offset']);self.assertIn('bundle_commit='+'c'*40,calls[1][1])
    def test_draft_preview_request_only_and_invalidation(self):
        v=self.open('simulation');v=self.call('ic_view_draft',{**self.ref(v,True),'text':'{"tran":{"stop":"2n"}}\n'})
        self.assertTrue(v['draft_dirty']);self.assertFalse(v['plan_ready'])
        with self.assertRaises(Failure):self.call('ic_view_plan',{**self.ref(v,True),'action':'plan'})
        review=self.call('ic_view_plan',{**self.ref(v,True),'action':'preview_draft'});v=review['view']
        self.assertIn('diff',review['result']);self.assertTrue(v['review_id'])
        result=self.call('ic_view_request',{**self.ref(v,True),'operation':'apply','idempotency_key':'view-key-001','message':'Reviewed configuration'});v=result['view'];request=result['request']
        self.assertEqual(request['state'],'pending_approval');self.assertFalse(result['human_confirmation']['automatic_approval'])
        self.assertEqual(self.data(v,'request',request_id=request['request_id'])['fingerprint'],request['fingerprint'])
        with self.assertRaises(Failure):self.call('ic_view_request',{**self.ref(v,True),'operation':'apply','idempotency_key':'view-key-001','message':'Reviewed configuration','confirmed':True})
        with self.assertRaises(Failure):self.call('ic_view_confirm',{**self.ref(v,True),'request_id':request['request_id']})
        v=self.call('ic_view_draft',{**self.ref(v,True),'text':'{}'});self.assertIsNone(v['review_id'])
        with self.assertRaises(Failure):self.call('ic_view_draft',{**self.ref(v,True),'text':'{"stop":1,"stop":2}'})
    def test_plan_submit_request_and_source_drift(self):
        v=self.open('simulation');plan=self.call('ic_view_plan',{**self.ref(v,True),'action':'plan'});v=plan['view']
        r=self.call('ic_view_request',{**self.ref(v,True),'operation':'sim_submit','idempotency_key':'submit-view-key'})
        self.assertEqual(r['request']['state'],'pending_approval')
        self.service.commit='e'*40
        with self.assertRaises(Failure):self.data(r['view'],'configuration')
    def test_simulation_historical_run_and_owned_receipt_binding(self):
        historical=self.call('ic_simulation_open',{'project_id':'demo','configuration':'tran','run_id':'saved-run'})
        self.assertEqual(historical['identity']['source_commit'],'b'*40)
        self.assertEqual(self.data(historical,'results')['run_id'],'saved-run')
        with self.assertRaises(Failure):self.data(historical,'draft')
        with self.assertRaises(Failure):self.call('ic_simulation_open',{'project_id':'demo','configuration':'wrong','run_id':'saved-run'})
        collected=self.call('ic_view_request',{**self.ref(historical,True),'operation':'sim_collect','idempotency_key':'history-collect-key'})
        self.assertEqual(collected['request']['state'],'pending_approval')
        v=self.open('simulation');v=self.call('ic_view_plan',{**self.ref(v,True),'action':'plan'})['view']
        prepared=self.call('ic_view_request',{**self.ref(v,True),'operation':'sim_submit','idempotency_key':'bind-submit-key'});v=prepared['view'];rid=prepared['request']['request_id']
        with self.assertRaises(Failure):self.call('ic_view_bind_run',{**self.ref(v,True),'request_id':rid})
        self.service.receipts[rid].update(state='accepted',result={'run_id':'new-exact-run'})
        self.service.extra_jobs=[{'run_id':'new-exact-run','associated_project_id':'demo','configuration':'tran','source_commit':'f'*40}]
        with self.assertRaises(Failure):self.call('ic_view_bind_run',{**self.ref(v,True),'request_id':rid})
        self.service.extra_jobs[0]['source_commit']='a'*40
        bound=self.call('ic_view_bind_run',{**self.ref(v,True),'request_id':rid});self.assertEqual(bound['identity']['run_id'],'new-exact-run')
        self.assertEqual(self.data(bound,'results')['run_id'],'new-exact-run')
        with self.assertRaises(Failure):self.call('ic_view_bind_run',{**self.ref(v,True),'request_id':rid})
        with self.assertRaises(Failure):self.call('ic_view_bind_run',{**self.ref(self.open('simulation'),True),'request_id':rid})

    def test_tool_schemas_and_private_payload(self):
        self.assertEqual(set(t['name'] for t in view_tools()),set(SCHEMAS));self.assertNotIn('ic_view_confirm',SCHEMAS)
        requests=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{}}},
                  {'jsonrpc':'2.0','method':'notifications/initialized'}, {'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}}]
        out=io.StringIO();run(self.service,io.StringIO('\n'.join(map(json.dumps,requests))+'\n'),out,self.views)
        messages=[json.loads(s) for s in out.getvalue().splitlines()];listed=messages[-1]['result']['tools'];self.assertEqual(listed[:len(core_tools())],core_tools())
        v=self.open();inp=io.StringIO('\n'.join(map(json.dumps,requests[:2]+[{'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'ic_view_data','arguments':{**self.ref(v),'revision':1,'query':{'kind':'source'}}}}]))+'\n');out=io.StringIO();run(self.service,inp,out,self.views)
        result=json.loads(out.getvalue().splitlines()[-1])['result'];self.assertNotIn(self.service.source,result['content'][0]['text']);self.assertEqual(result['_meta']['icWorkbench']['data']['payload']['file']['content'],self.service.source)
    def test_real_stdio_core_and_three_ui_resources(self):
        p=subprocess.Popen([sys.executable,'-B',str(Path(__file__)),'--stdio-fixture',str(self.root/'stdio')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        def call(method,params=None,id=1):
            p.stdin.write(json.dumps({'jsonrpc':'2.0','id':id,'method':method,'params':params or {}})+'\n');p.stdin.flush();return json.loads(p.stdout.readline())
        try:
            initialized=call('initialize',{'protocolVersion':'2025-11-25','capabilities':{}});self.assertIn('resources',initialized['result']['capabilities'])
            p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');p.stdin.flush()
            listed=call('resources/list')['result']['resources'];self.assertEqual(len(listed),4)
            for item in listed:self.assertIn('SYNTHETIC',call('resources/read',{'uri':item['uri']})['result']['contents'][0]['text'])
            self.assertEqual(call('tools/call',{'name':'ic_projects','arguments':{}})['result']['structuredContent']['data']['projects'][0]['id'],'demo')
            render=call('tools/call',{'name':'ic_schematic_open','arguments':{'project_id':'demo'}})['result'];self.assertEqual(render['structuredContent']['data']['kind'],'schematic')
            denied=call('tools/call',{'name':'ic_approve','arguments':{'confirmed':True}})['result'];self.assertTrue(denied['isError'])
        finally:p.stdin.close();p.wait(timeout=5);p.stdout.close();self.assertEqual(p.returncode,0,p.stderr.read());p.stderr.close()

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--stdio-fixture':
        base=Path(sys.argv[2]);base.mkdir();ui=base/'ui';ui.mkdir()
        for kind in RESOURCES:(ui/(kind+'.html')).write_text('<!doctype html>SYNTHETIC '+kind)
        service=FakeService(base/'state');raise SystemExit(run(service,views=ViewService(service,ui)))
    unittest.main(verbosity=2)
