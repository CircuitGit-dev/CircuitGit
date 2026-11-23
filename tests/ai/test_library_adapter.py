"""Agent library tools on isolated Git fixtures. No gateway, PDK, model or PR network."""
import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'apps/codex'), str(ROOT/'tests/library'), str(ROOT/'tests/ai')]
import test_workflow as workflow_fixture
from test_sessions import FakeRpc
from icwb.service import Service, Failure
from icwb.library import call, source_context, configured_binding
from icwb.library_contracts import tools
from icwb.host import AiRoutes
from icwb.ai import AiSession
from icwb.mcp import run as mcp_run
from icwb.cli import main as cli_main
from icwb.plugin_runtime import PluginRuntime
from icwb.ai_prompt import project_context


class Tests(unittest.TestCase):
    def setUp(self):
        self.seed = workflow_fixture.LibraryWorkflowTest(); self.seed.setUp(); self.addCleanup(self.seed.doCleanups)
        self.root = self.seed.workflow.root
        self.config = {'gateway_url':'http://127.0.0.1:1','state_dir':str(self.root/'.local/agent-state'),
                       'library_workspace':str(self.root),'library_repository':'fixture/circuits','library_access':'direct',
                       'library_state_dir':str(self.seed.workflow.state)}
        self.service = Service(self.config);self.service.library_workflow = self.seed.workflow
        self.service.call = Mock(side_effect=AssertionError('NO GATEWAY / VIRTUOSO / PDK ACCESS'))
        self.identity = {'library_id':'demo','cell_id':'gain'}
        self.live=[];self.addCleanup(lambda:[a.close() for a in self.live])

    def read(self, operation, **args):
        return call(self.service,'ic_library_read',{'operation':operation,'arguments':args})
    def execute(self, operation, key='agent-direct-key', **args):
        return call(self.service,'ic_library_execute',{'operation':operation,'arguments':{**self.identity,**args},'idempotency_key':key})
    def session(self, mode='manual'):
        session=AiSession(self.service,FakeRpc,session_id='s_library');self.live.append(session)
        context=source_context(self.service,'library:demo/gain')
        session.turn('Edit owned RNL and netlist source',context,'library-turn-key',permission_mode=mode)
        return session
    def tool(self, session, name, payload):
        session._tool({'id':'library-call','params':{'threadId':session.thread_id,'turnId':session.turn_id,'tool':name,'arguments':payload}})
        return next(message for message in reversed(session.rpc.sent) if message.get('id') == 'library-call')

    def test_unconfigured_tools_hidden_and_readonly_default_blocks_write(self):
        self.assertEqual(tools({}),[])
        self.assertEqual(tools('legacy-fake-configuration'),[])
        self.service.config.pop('library_access')
        self.assertEqual(self.read('capability')['access'],'read_only')
        with self.assertRaises(Failure) as error:self.execute('save',path=self.seed.path,base_sha256=self.seed.sha(self.seed.before),content=self.seed.after)
        self.assertEqual(error.exception.code,'library_read_only');self.assertEqual((self.root/self.seed.path).read_text(),self.seed.before)
    def test_catalog_describe_and_context_need_no_runtime_project_or_pdk(self):
        catalog=self.read('catalog');self.assertEqual(catalog['libraries'][0]['cells'][0]['project_id'],None)
        self.assertTrue(all('files' not in view for view in catalog['libraries'][0]['cells'][0]['views']))
        described=self.read('describe',**self.identity);self.assertTrue(any(x['editable'] for x in described['files']))
        context=source_context(self.service,'library:demo/gain');self.assertEqual(context['library'],self.identity)
        self.assertEqual(context['file']['persistedSha256'],self.seed.sha(self.seed.before));self.service.call.assert_not_called()
    def test_runtime_binding_comes_from_committed_manifest_even_for_explicit_path(self):
        context=source_context(self.service,'library:demo/rc','projects/rc-smoke/circuit.scs')
        self.assertEqual(context['project']['runtimeProjectId'],'rc-smoke')
        self.assertEqual(project_context(context)['project']['runtimeProjectId'],'rc-smoke')
        self.assertIsNone(source_context(self.service,'library:demo/gain')['project']['runtimeProjectId'])
        self.service.call.assert_not_called()
    def test_context_rejects_catalog_head_drift_before_reading_source(self):
        catalog=self.seed.workflow.catalog();catalog['base_commit']='f'*40
        with patch.object(self.seed.workflow,'catalog',return_value=catalog),self.assertRaises(Failure) as error:
            source_context(self.service,'library:demo/gain')
        self.assertEqual(error.exception.code,'conflict')
    def test_direct_save_and_repeat_use_shared_original_receipt_without_approval(self):
        args={'path':self.seed.path,'base_sha256':self.seed.sha(self.seed.before),'content':self.seed.after}
        first=self.execute('save',**args);second=self.execute('save',**args)
        self.assertEqual(first,second);self.assertEqual(first['state'],'complete')
        self.assertEqual((self.root/self.seed.path).read_text(),self.seed.after)
        self.assertEqual(self.read('receipt',idempotency_key='agent-direct-key'),first)
        self.service.call.assert_not_called()
    def test_atomic_electrical_and_geometry_files_share_one_save(self):
        files=self.seed.group_args()
        # The backend fixture returns arguments for the same-cell group save.
        if isinstance(files,dict):args=files
        else:args={'files':files}
        result=self.execute('save_files',**{k:v for k,v in args.items() if k not in self.identity})
        self.assertEqual(result['state'],'complete');self.service.call.assert_not_called()
    def test_cross_cell_provenance_and_config_override_are_rejected(self):
        for path in (self.seed.shared,'lib/demo/gain/docs/provenance.json','application.js'):
            with self.assertRaises(Failure):self.execute('save',path=path,base_sha256=None,content='must not write',key='reject-'+path)
        for payload in [ {'operation':'save','arguments':{**self.identity,'root':'/tmp'},'idempotency_key':'test-key1'},
                         {'operation':'save','arguments':self.identity,'idempotency_key':'test-key2','approve':True}]:
            with self.assertRaises(Failure):call(self.service,'ic_library_execute',payload)
        self.assertEqual((self.root/'application.js').read_text(),'// original application\n')
    def test_same_key_with_changed_input_conflicts(self):
        self.execute('save',path=self.seed.path,base_sha256=self.seed.sha(self.seed.before),content=self.seed.after)
        with self.assertRaises(Failure) as error:self.execute('save',path=self.seed.path,base_sha256=self.seed.sha(self.seed.after),content='new')
        self.assertEqual(error.exception.code,'conflict')
    def test_library_scope_change_cannot_reuse_injected_owner(self):
        self.service.config['library_repository']='wrong/repository'
        with self.assertRaises(Failure) as error:self.read('catalog')
        self.assertEqual(error.exception.code,'library_changed')
    def test_plain_ai_turn_uses_library_source_and_advertises_tools(self):
        session=self.session();self.service.call.assert_not_called()
        names={t['name'] for m in session.rpc.sent if m.get('method')=='thread/start' for t in m['params']['dynamicTools']}
        self.assertTrue({'ic_library_read','ic_library_execute'}<=names)
        self.assertEqual(session.turns['library-turn-key']['library_binding'],configured_binding(self.service.config))
    def test_manual_ai_executes_owned_library_directly_no_pending_approval(self):
        session=self.session()
        reply=self.tool(session,'ic_library_execute',{'operation':'save','arguments':{**self.identity,'path':self.seed.path,
          'base_sha256':self.seed.sha(self.seed.before),'content':self.seed.after},'idempotency_key':'web-library-save'})
        self.assertTrue(reply['result']['success']);self.assertEqual(session.pending,{})
        self.assertEqual((self.root/self.seed.path).read_text(),self.seed.after);self.service.call.assert_not_called()
    def test_explicit_read_only_turn_cannot_write_library(self):
        session=self.session('read_only')
        self.tool(session,'ic_library_execute',{'operation':'save','arguments':{**self.identity,'path':self.seed.path,
          'base_sha256':self.seed.sha(self.seed.before),'content':self.seed.after},'idempotency_key':'readonly-rejected'})
        self.assertEqual(session.state,'suspended');self.assertEqual(session.suspension_reason,'read_only_denial')
        self.assertEqual((self.root/self.seed.path).read_text(),self.seed.before);self.service.call.assert_not_called()
    def test_changed_operator_binding_blocks_active_turn_tool(self):
        session=self.session();self.service.config['library_access']='read_only'
        reply=self.tool(session,'ic_library_read',{'operation':'current','arguments':self.identity})
        self.assertFalse(reply['result']['success']);self.assertIn('library_changed',str(reply))
        self.assertEqual(session.state,'suspended')
    def test_library_scope_denial_suspends_dependent_model_work(self):
        session=self.session()
        reply=self.tool(session,'ic_library_execute',{'operation':'save','arguments':{**self.identity,
            'path':self.seed.shared,'base_sha256':None,'content':'must not write'},'idempotency_key':'scope-denied-key'})
        self.assertFalse(reply['result']['success']);self.assertEqual(session.state,'suspended')
        self.assertEqual(session.suspension_reason,'out_of_scope')
    def test_missing_operator_workspace_suspends_active_library_turn(self):
        session=self.session();self.service.config['library_workspace']=str(self.root/'absent')
        reply=self.tool(session,'ic_library_read',{'operation':'current','arguments':self.identity})
        self.assertFalse(reply['result']['success']);self.assertEqual(session.state,'suspended')
        self.assertEqual(session.suspension_reason,'library_unavailable')
    def test_partial_group_result_preserves_original_receipt_and_stops_turn(self):
        session=self.session();partial={'state':'partial','operation_id':'a'*64,'files':[{'path':self.seed.path,'state':'unknown'}]}
        with patch.object(self.seed.workflow,'execute',return_value=partial):
            reply=self.tool(session,'ic_library_execute',{'operation':'save_files','arguments':{**self.identity,'files':[
              {'path':self.seed.path,'base_sha256':self.seed.sha(self.seed.before),'content':self.seed.after}]},'idempotency_key':'partial-library'})
        self.assertFalse(reply['result']['success']);self.assertEqual(session.state,'suspended')
        self.assertIn('a'*64,str(reply));self.assertIn('partial',str(reply));self.assertEqual((self.root/self.seed.path).read_text(),self.seed.before)

    def test_direct_simulation_permission_denial_suspends_without_manual_fallback(self):
        session=self.session();self.service.call.side_effect=Failure('forbidden','Missing installed simulation grant',4)
        args={'operation':'submit','arguments':{'project_id':'runtime','configuration':'TRAN','source_commit':'a'*40},'idempotency_key':'original-simulation-key'}
        reply=self.tool(session,'ic_sim_execute',args)
        self.assertFalse(reply['result']['success']);self.assertEqual(session.state,'suspended')
        self.assertEqual(session.suspension_reason,'forbidden');self.assertEqual(self.service.call.call_count,1)
        reply=self.tool(session,'ic_sim_submit',args['arguments'])
        self.assertFalse(reply['result']['success']);self.assertEqual(self.service.call.call_count,1)

    def check_incomplete_simulation(self, value):
        session=self.session();self.service.call.side_effect=None;self.service.call.return_value=value
        reply=self.tool(session,'ic_sim_execute',{'operation':'submit','arguments':{'project_id':'runtime'},'idempotency_key':'original-simulation-key'})
        self.assertFalse(reply['result']['success']);self.assertEqual(session.state,'suspended')
        self.assertIn(value['request_id'],str(reply));self.assertEqual(session.suspension_reason,'simulation_incomplete')

    def test_uncertain_direct_simulation_preserves_receipt_and_suspends(self):
        self.check_incomplete_simulation({'state':'uncertain','request_id':'a'*64})

    def test_accepted_but_partial_direct_simulation_suspends(self):
        self.check_incomplete_simulation({'state':'accepted','request_id':'b'*64,'result':{'state':'partial'}})
    def test_existing_ai_turn_replay_keeps_frozen_library_profile_after_configuration_change(self):
        session=self.session();context=source_context(self.service,'library:demo/gain');before=copy.deepcopy(session.turns['library-turn-key'])
        self.service.config['library_access']='invalid'
        result=session.turn('Edit owned RNL and netlist source',context,'library-turn-key',permission_mode='manual')
        self.assertEqual(result,before)
    def test_host_context_bypasses_gateway_and_catalog_survives_missing_runtime(self):
        routes=AiRoutes(self.service);self.addCleanup(routes.close)
        context=routes.get('/api/ai/context',{'project_id':['library:demo/gain']})
        self.assertEqual(context['library'],self.identity);self.service.call.assert_not_called()
        self.service.call.side_effect=Failure('gateway_unavailable','Synthetic missing runtime',75)
        data=routes.get('/api/ai/catalog',{});row=next(p for p in data['projects'] if p['id']=='library:demo/gain')
        self.assertFalse(row['can_simulate']);self.assertTrue(row['can_edit']);self.assertFalse(row['pdk_required_for_edit'])
        self.service.config['library_access']='read_only'
        row=next(p for p in routes.get('/api/ai/catalog',{})['projects'] if p['id']=='library:demo/gain')
        self.assertFalse(row['can_edit'])
    def test_library_runtime_binding_is_not_readiness_until_live_catalog_matches(self):
        routes=AiRoutes(self.service);self.addCleanup(routes.close)
        self.service.call.side_effect=None
        def selected():return next(p for p in routes.get('/api/ai/catalog',{})['projects'] if p['id']=='library:demo/rc')
        self.service.call.return_value={'projects':[],'capabilities':{'runner':True}}
        row=selected();self.assertEqual(row['runtime_project_id'],'rc-smoke');self.assertFalse(row['can_simulate']);self.assertFalse(row['runtime_available'])
        project={'id':'rc-smoke','library_id':'demo','cell_id':'rc','configurations':[{'id':'TRAN','name':'Transient'}]}
        self.service.call.return_value={'projects':[project],'capabilities':{'runner':False}}
        row=selected();self.assertTrue(row['runtime_available']);self.assertFalse(row['can_simulate'])
        self.service.call.return_value['capabilities']['runner']=True
        row=selected();self.assertTrue(row['can_simulate']);self.assertEqual(row['configurations'],project['configurations'])
        self.assertEqual(row['simulation_readiness'],'requires_preflight')
        project['cell_id']='different-cell';row=selected();self.assertFalse(row['runtime_available']);self.assertFalse(row['can_simulate'])
    def test_mcp_calls_library_without_gateway_lifecycle(self):
        lifecycle=Mock();lifecycle.tool_names=set();lifecycle.tools.return_value=[]
        lifecycle.ensure.side_effect=AssertionError('NO CADENCE STARTUP')
        messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{}},{'jsonrpc':'2.0','method':'notifications/initialized'},
                  {'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}},
                  {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'ic_library_read','arguments':{'operation':'catalog','arguments':{}}}}]
        output=io.StringIO();mcp_run(self.service,io.StringIO('\n'.join(json.dumps(m) for m in messages)+'\n'),output,lifecycle=lifecycle)
        rows=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(rows[-1]['result']['structuredContent']['ok']);lifecycle.ensure.assert_not_called()
        self.assertIn('ic_library_execute',{t['name'] for t in rows[1]['result']['tools']})
    def test_cli_library_read_no_gateway(self):
        config=self.root/'.local/agent-client.json';config.write_text(json.dumps(self.config))
        args=self.root/'.local/args.json';args.write_text('{}');out=io.StringIO()
        with patch('icwb.library.module',return_value=Mock(LibraryWorkflow=Mock(return_value=self.seed.workflow))),contextlib.redirect_stdout(out):
            code=cli_main(['--config',str(config),'--json','library-read','--operation','catalog','--arguments',str(args)])
        self.assertEqual(code,0);self.assertTrue(json.loads(out.getvalue())['ok'])
    def test_cli_schema_matches_configured_optional_catalog_without_service(self):
        config=self.root/'.local/agent-client.json';config.write_text(json.dumps(self.config))
        for arguments, expected in [(['--json','schema'],False),(['--config',str(config),'--json','schema'],True)]:
            out=io.StringIO()
            with patch('icwb.cli.Service',side_effect=AssertionError('SCHEMA MUST NOT START SERVICE')),contextlib.redirect_stdout(out):
                code=cli_main(arguments)
            self.assertEqual(code,0)
            self.assertEqual('ic_library_read' in {t['name'] for t in json.loads(out.getvalue())['data']['tools']},expected)
    def test_plugin_settings_pass_library_profile_without_loading_site(self):
        settings={**{k:v for k,v in self.config.items() if k.startswith('library_')},'schema':'ic.plugin.settings.v1',
                  'gateway_url':'http://127.0.0.1:1','state_dir':str(self.root/'.local/plugin'), 'workbench_config':str(self.root/'.local/absent-site.json')}
        path=self.root/'.local/plugin-settings.json';path.write_text(json.dumps(settings))
        runtime=PluginRuntime(path);self.assertIsNone(runtime.setup_error)
        self.assertEqual(runtime.service.config['library_access'],'direct')
        self.assertIsNone(runtime._owned_process)


if __name__=='__main__':unittest.main(verbosity=2)
