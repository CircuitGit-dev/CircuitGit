"""Existing synthetic SQLite store through the neutral SDK and loopback route.

Tests only local temporary fixtures. No controllers, models, SSH or real storage.
"""
import copy
import hashlib
import http.client
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock,patch

import server
from spiceowl_readonly import SpiceReadAdapter,SpiceReadError,read_contracts
from simulation_runtime import SimulationRuntime
from supervision import Supervision


def existing_store(root):
    from spiceowl.storage.sqlite import Store
    store=Store(root)
    record={'run_id':'synthetic-run','synthetic':True,'scenario':'completed','execution':'completed',
            'resource_history':[{'sequence':1,'simulated_time_us':2,'memory_mb':3}],
            'events':[{'event_id':'event-1','sequence':1,'kind':'execution.completed','message':'Synthetic observation',
                       'observed_at':'2026-11-24T00:00:00Z','facts':{'synthetic':True}}]}
    store.create('run','synthetic-run',record)
    store.create('connection','fake-connection',{'connection_id':'fake-connection','kind':'agent','backend':'fake_agent',
        'synthetic':True,'api_key':'private-sentinel','enabled':True})
    store.create('host','host-1',{'host_id':'host-1','synthetic':True,'label':'Synthetic host','tools':[],
        'ssh_target':'private-sentinel'})
    store.create('ic_gateway','gateway-1',{'id':'gateway-1','backend':'ic-workbench','project_id':'project',
        'api_key':'private-sentinel','base_url':'private-sentinel'})
    store.create('ic_run:gateway-1','native-run',{'schema':'spiceowl.ic-run.v1','run_id':'native-run','gateway_id':'gateway-1',
        'project_id':'project','backend':'ic-workbench','source':'stored_observations','synthetic':True,
        'source_commit':'a'*40,'submission_key':'private-sentinel'})
    return store


class AdapterTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);self.root=Path(tmp.name)

    def test_configuration_never_creates_or_guesses_a_store(self):
        for value in [True,{'enabled':'true'},{'enabled':True},{'enabled':True,'data_dir':'relative'},
                      {'enabled':True,'data_dir':'/x','runs_root':'/y'}]:
            with self.assertRaises(ValueError):SpiceReadAdapter(value)
        self.assertEqual(list(self.root.iterdir()),[])
        for value in [None,{'enabled':False}]:
            adapter=SpiceReadAdapter(value)
            with self.assertRaises(SpiceReadError) as error:adapter.read('spiceowl_status',{})
            self.assertEqual(error.exception.code,'spiceowl_read_unavailable')
        target=self.root/'missing';adapter=SpiceReadAdapter({'enabled':True,'data_dir':str(target)})
        self.assertFalse(target.exists())

    def require_sdk(self):
        try:from spiceowl.embedded import read_tool_definitions
        except ImportError:self.skipTest('New pinned SpiceOwl embedded exports not installed yet')
        return read_tool_definitions

    def test_actual_sdk_reads_leave_store_and_observation_times_unchanged(self):
        self.require_sdk();store=self.root/'store';existing_store(store)
        db=store/'spiceowl.sqlite3';before=(db.read_bytes(),db.stat().st_mtime_ns,sorted(path.name for path in store.iterdir()))
        adapter=SpiceReadAdapter({'enabled':True,'data_dir':str(store)})
        status=adapter.read('spiceowl_status',{});self.assertTrue(status['read_only']);self.assertEqual(status['counts']['records']['run'],1)
        result=adapter.read('spiceowl_get_run',{'run_id':'synthetic-run'});self.assertTrue(result['run']['synthetic'])
        self.assertEqual(result['run']['events'][0]['observed_at'],'2026-11-24T00:00:00Z')
        self.assertEqual(result['run']['resource_history'][0]['memory_mb'],3)
        self.assertEqual((db.read_bytes(),db.stat().st_mtime_ns,sorted(path.name for path in store.iterdir())),before)
        self.assertEqual(adapter.read('spiceowl_list_hosts',{})['hosts'][0]['host_id'],'host-1')
        missing=self.root/'does-not-exist'
        with self.assertRaises(SpiceReadError) as error:SpiceReadAdapter({'enabled':True,'data_dir':str(missing)}).read('spiceowl_status',{})
        self.assertEqual(error.exception.code,'storage_missing');self.assertFalse(missing.exists())
        self.assertNotIn(str(missing),str(error.exception))

    def test_all_eight_tools_cross_real_store_sdk_http_and_service_without_writes(self):
        self.require_sdk();store=self.root/'store';existing_store(store)
        package_root=Path(__file__).resolve().parents[2]
        sys.path.insert(0,str(package_root/'modules/gateway_client'))
        from ic_gateway.service import Service
        from ic_gateway.contracts import SPICEOWL_READS
        db=store/'spiceowl.sqlite3';before=(db.read_bytes(),db.stat().st_mtime_ns,sorted(path.name for path in store.iterdir()))
        app=types.SimpleNamespace(ai=None,spiceowl_reads=SpiceReadAdapter({'enabled':True,'data_dir':str(store)}),token='synthetic')
        http_server=server.Server(('127.0.0.1',0),server.Handler);http_server.app=app
        thread=threading.Thread(target=http_server.serve_forever,daemon=True);thread.start()
        self.addCleanup(http_server.server_close);self.addCleanup(http_server.shutdown)
        service=Service({'gateway_url':'http://127.0.0.1:'+str(http_server.server_port),
            'state_dir':str(self.root/'client'),'spiceowl_readonly':{'enabled':True}})
        results={}
        with patch('spiceowl.storage.sqlite.Store',side_effect=AssertionError('Reads cannot construct Store')):
            with patch('subprocess.Popen',side_effect=AssertionError('Reads cannot start any process')):
                for name,schema in SPICEOWL_READS.items():
                    args={key:('gateway-1' if key=='gateway_id' else 'native-run' if name=='spiceowl_get_ic_run' else 'synthetic-run')
                        for key in schema['required']}
                    results[name]=service.call(name,args)
        self.assertEqual(len(results),8)
        self.assertTrue(all(row['read_only'] for row in results.values()))
        self.assertEqual(results['spiceowl_get_ic_run']['run']['run_id'],'native-run')
        self.assertEqual(results['spiceowl_get_run']['run']['resource_history'][0]['memory_mb'],3)
        self.assertNotIn('private-sentinel',json.dumps(results))
        self.assertEqual((db.read_bytes(),db.stat().st_mtime_ns,sorted(path.name for path in store.iterdir())),before)

    def test_schema_drift_stops_before_opening_the_store(self):
        definitions=self.require_sdk();adapter=SpiceReadAdapter({'enabled':True,'data_dir':str(self.root/'missing')})
        for mutate in [lambda rows:rows.pop(),lambda rows:rows[0]['annotations'].update(readOnlyHint=False),
                       lambda rows:rows[0]['inputSchema'].update(additionalProperties=True),
                       lambda rows:rows[2]['inputSchema']['properties']['run_id'].update(pattern='.*'),
                       lambda rows:rows[2]['inputSchema']['properties']['run_id'].update(minLength=True),
                       lambda rows:rows[0]['annotations'].update(openWorldHint=0),
                       lambda rows:rows[2]['inputSchema'].update(required=[])]:
            rows=definitions();mutate(rows)
            with patch('spiceowl.embedded.read_tool_definitions',return_value=rows),patch('spiceowl.read_api.open_read_views') as open_views:
                with self.assertRaises(SpiceReadError) as error:adapter.read('spiceowl_status',{})
                self.assertEqual(error.exception.code,'spiceowl_read_contract');open_views.assert_not_called()

    def test_http_routes_are_get_only_exact_and_keep_errors_bounded(self):
        self.require_sdk();store=self.root/'store';existing_store(store)
        app=types.SimpleNamespace(ai=None,spiceowl_reads=SpiceReadAdapter({'enabled':True,'data_dir':str(store)}),token='synthetic')
        http_server=server.Server(('127.0.0.1',0),server.Handler);http_server.app=app
        thread=threading.Thread(target=http_server.serve_forever,daemon=True);thread.start()
        self.addCleanup(http_server.server_close);self.addCleanup(http_server.shutdown)
        def call(path,method='GET'):
            conn=http.client.HTTPConnection('127.0.0.1',http_server.server_port,timeout=3)
            try:
                conn.request(method,path);response=conn.getresponse();return response.status,json.loads(response.read())
            finally:conn.close()
        status,data=call('/api/spiceowl/read/spiceowl_get_run?run_id=synthetic-run')
        self.assertEqual(status,200);self.assertTrue(data['data']['read_only'])
        for path in ['/api/spiceowl/read/spiceowl_get_run?run_id=synthetic-run&run_id=other',
                     '/api/spiceowl/read/spiceowl_status?data_dir=/secret',
                     '/api/spiceowl/read/spiceowl_get_run?run_id=../other',
                     '/api/spiceowl/read/spiceowl_submit']:
            status,data=call(path);self.assertEqual(status,400);self.assertFalse(data['ok'])
        status,data=call('/api/spiceowl/read/spiceowl_status','POST');self.assertEqual(status,403)


class SavedRunnerTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);self.root=Path(tmp.name)
        self.folder=self.root/'runs'/'original';self.folder.mkdir(parents=True)
        self.record={'run_id':'original','project_id':'project','source_commit':'a'*40,'configuration_id':'tran',
            'state':'collected','observed_at':'2026-11-23T00:00:00Z','collection':{'sha256':'b'*64},'execution_site_sha256':'c'*64}
        (self.folder/'run.json').write_text(json.dumps(self.record))
        self.runner=types.SimpleNamespace(root=self.root/'runs',path=lambda rid:self.root/'runs'/rid)
        self.app=types.SimpleNamespace(cfg={'runtime_root':str(self.root/'runtime')},runner=self.runner,
            workspace=types.SimpleNamespace(projects={'project':{},'other':{}}))
        self.app.supervision=Supervision(self.runner,self.app.workspace.projects)
        self.runtime=SimulationRuntime(self.app)

    def test_exact_historical_run_reads_saved_five_dimensions_without_active_calls(self):
        report={'schema':'spiceowl.simulation-report.v1','run_id':'original',**{key:{'status':'unknown'}
            for key in ['execution_status','measurement_validity','functional_performance','operating_qualification','dependency_provenance']}}
        (self.folder/'simulation-report.json').write_text(json.dumps({'run_id':'original','source_commit':'a'*40,'native_archive_sha256':'b'*64,'report':report}))
        monitor={'schema':'ic.sim.monitor.v1','run_id':'original','binding':{'source_commit':'a'*40,'execution_site_sha256':'c'*64},
            'watch_state':'terminal','observation':{'last_success_at':'2026-11-23T00:00:00Z'},
            'events':[{'sequence':i,'at':'2026-11-23T00:00:00Z','kind':'connected','secret':'not copied'} for i in range(100)]}
        (self.folder/'monitor.json').write_text(json.dumps(monitor))
        before={p.name:(p.read_bytes(),p.stat().st_mtime_ns) for p in self.folder.iterdir()}
        with patch.object(self.runtime,'monitor',side_effect=AssertionError('No monitor startup')):
            with patch.object(self.app.supervision,'snapshot',side_effect=AssertionError('Do not substitute recent runs')):
                result=self.runtime.saved_run('project','original')
        self.assertEqual(result['report'],report);self.assertEqual(result['resource_history'],[])
        self.assertEqual(result['resource_history_status'],'not_recorded_by_runner');self.assertFalse(result['active_query_performed'])
        self.assertEqual(len(result['monitor']['events']),64);self.assertTrue(result['monitor']['events_truncated'])
        self.assertNotIn('not copied',json.dumps(result));self.assertEqual(result['monitor']['last_success_at'],'2026-11-23T00:00:00Z')
        self.assertEqual({p.name:(p.read_bytes(),p.stat().st_mtime_ns) for p in self.folder.iterdir()},before)
        self.assertFalse((self.root/'runtime').exists())

    def test_foreign_project_run_paths_and_monitor_binding_are_rejected(self):
        with self.assertRaises(FileNotFoundError):self.runtime.saved_run('other','original')
        with self.assertRaises(ValueError):self.runtime.saved_run('project','../original')
        (self.folder/'monitor.json').write_text(json.dumps({'schema':'ic.sim.monitor.v1','run_id':'foreign','events':[]}))
        result=self.runtime.saved_run('project','original');self.assertEqual(result['monitor']['status'],'unavailable')
        self.assertIsNone(result['report']);self.assertEqual(result['report_status'],'not_available')

    def test_null_or_malformed_source_and_archive_never_claim_a_bound_report(self):
        for source,archive in [(None,'b'*64),('malformed','b'*64),(True,'b'*64),('a'*40,None),('a'*40,'invalid'),('a'*40,True)]:
            record={**self.record,'source_commit':source,'collection':{'sha256':archive}}
            (self.folder/'run.json').write_text(json.dumps(record))
            (self.folder/'simulation-report.json').write_text(json.dumps({'run_id':'original','source_commit':source,'native_archive_sha256':archive,
                'report':{'schema':'spiceowl.simulation-report.v1','run_id':'original','execution_status':{'status':'completed'}}}))
            result=self.runtime.saved_run('project','original')
            self.assertIsNone(result['report']);self.assertEqual(result['report_status'],'not_available')
            self.assertEqual(result['source_commit'],source if isinstance(source,str) and len(source)==40 else None)

    def test_nonfinite_report_stays_unavailable_instead_of_breaking_agent_json(self):
        for value in [float('nan'),float('inf')]:
            (self.folder/'simulation-report.json').write_text(json.dumps({'run_id':'original','source_commit':'a'*40,'native_archive_sha256':'b'*64,
                'report':{'schema':'spiceowl.simulation-report.v1','run_id':'original','metric':value}}))
            result=self.runtime.saved_run('project','original')
            self.assertIsNone(result['report']);self.assertEqual(result['report_status'],'not_available')
            json.dumps(result,allow_nan=False)


if __name__=='__main__':unittest.main()
