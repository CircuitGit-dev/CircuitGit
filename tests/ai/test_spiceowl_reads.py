"""Finite embedded read tools; synthetic transport only, no store or model startup."""
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/codex'),str(ROOT/'modules/gateway_client')]
from ic_gateway.contracts import SCHEMAS,SPICEOWL_READS,tools
from ic_gateway.service import Service,Failure
from icwb.ai import AiSession
from icwb.mcp import run as run_mcp


def envelope(**data):
    return {'read_only':True,'source':'stored_local_state','read_at':'2026-11-24T00:00:00Z',
            'data_trust':'untrusted_evidence',**data}


class EmbeddedReadTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.cfg={'gateway_url':'http://127.0.0.1:1','state_dir':temp.name,'spiceowl_readonly':{'enabled':True}}
        self.service=Service(self.cfg);self.service.gateway=Mock()

    def test_eight_schemas_are_finite_read_only_and_explicitly_exposed(self):
        enabled={row['name']:row for row in tools(self.cfg)}
        for name in SPICEOWL_READS:
            row=enabled['ic_'+name]
            self.assertEqual(row['inputSchema'],SCHEMAS[name]);self.assertFalse(row['inputSchema']['additionalProperties'])
            self.assertEqual(row['annotations'],{'readOnlyHint':True,'destructiveHint':False,'idempotentHint':True,'openWorldHint':False})
        self.assertEqual(len(SPICEOWL_READS),8)
        for config in [{},{'spiceowl_readonly':{'enabled':False}}]:
            self.assertFalse(any(row['name'].startswith('ic_spiceowl_') for row in tools(config)))
        self.assertTrue(any(row['name']=='ic_sim_saved_run' for row in tools({})))

    def test_reads_use_only_fixed_get_routes_and_validate_exact_response_identities(self):
        for name in SPICEOWL_READS:
            args={key:('gateway-1' if key=='gateway_id' else 'run-1') for key in SCHEMAS[name]['required']}
            result=envelope(**({'run':dict(args)} if name in {'spiceowl_get_run','spiceowl_get_ic_run'} else {'gateway_id':'gateway-1'} if name=='spiceowl_list_ic_runs' else {}))
            self.service.gateway.reset_mock();self.service.gateway.request.return_value=result
            self.assertEqual(self.service.call(name,args),result)
            call=self.service.gateway.request.call_args
            self.assertTrue(call.args[0].startswith('/api/spiceowl/read/'+name));self.assertEqual(len(call.args),1);self.assertEqual(call.kwargs,{})
        self.service.gateway.request.return_value=envelope(run={'run_id':'other','gateway_id':'gateway-1'})
        with self.assertRaises(Failure):self.service.call('spiceowl_get_ic_run',{'gateway_id':'gateway-1','run_id':'run-1'})
        self.service.gateway.request.return_value=envelope(run={'run_id':'run-1','gateway_id':'other'})
        with self.assertRaises(Failure):self.service.call('spiceowl_get_ic_run',{'gateway_id':'gateway-1','run_id':'run-1'})

    def test_absent_grant_paths_unknown_arguments_and_invalid_ids_stop_before_gateway(self):
        invalid=[('spiceowl_status',{'data_dir':'/secret'}),('spiceowl_get_run',{'run_id':'../other'}),
            ('spiceowl_get_run',{'run_id':True}),('spiceowl_get_ic_run',{'run_id':'run','gateway_id':'../gw'}),
            ('spiceowl_list_ic_runs',{'gateway_id':'g','refresh':True})]
        for name,args in invalid:
            with self.assertRaises(Failure):self.service.call(name,args)
        for grant in [None,{'enabled':False}]:
            self.service.config['spiceowl_readonly']=grant
            with self.assertRaises(Failure) as error:self.service.call('spiceowl_status',{})
            self.assertEqual(error.exception.code,'spiceowl_read_unavailable')
        self.service.gateway.request.assert_not_called()

    def test_client_config_cannot_select_store_paths_or_create_a_directory_on_rejection(self):
        target=Path(self.cfg['state_dir'])/'not-created'
        for value in [{'enabled':True,'data_dir':'/private'},{'enabled':'yes'},True]:
            with self.assertRaises(Failure):Service({**self.cfg,'state_dir':str(target),'spiceowl_readonly':value})
            self.assertFalse(target.exists())

    def test_untrusted_or_oversized_envelopes_are_rejected(self):
        for value in [{},envelope(read_only=False),envelope(source='fresh_probe'),envelope(extra=float('nan')),envelope(extra='x'*(2*1024*1024))]:
            self.service.gateway.request.return_value=value
            with self.assertRaises(Failure):self.service.call('spiceowl_status',{})

    def test_saved_runner_reads_are_exact_and_do_not_use_active_status(self):
        args={'project_id':'project','run_id':'saved-run'}
        result={'schema':'ic.simulation.saved-run.v1',**args,'read_only':True,'active_query_performed':False,
            'run':{**args,'source_commit':'a'*40},'source_commit':'a'*40}
        self.service.gateway.request.return_value=result;self.assertEqual(self.service.call('sim_saved_run',args),result)
        self.service.gateway.request.assert_called_once_with('/api/simulation/saved-run?project_id=project&run_id=saved-run')
        for change in [{'run_id':'other'},{'project_id':'other'},{'active_query_performed':True}]:
            self.service.gateway.request.return_value={**result,**change}
            with self.assertRaises(Failure):self.service.call('sim_saved_run',args)
        self.service.gateway.request.return_value={**result,'run':{**result['run'],'run_id':'foreign'}}
        with self.assertRaises(Failure):self.service.call('sim_saved_run',args)
        for report in [{'metric':float('nan')},{'metric':float('inf')},{'text':'x'*(2*1024*1024)}]:
            self.service.gateway.request.return_value={**result,'report':report}
            with self.assertRaises(Failure) as error:self.service.call('sim_saved_run',args)
            self.assertEqual(error.exception.code,'simulation_read_response_mismatch')

    def test_same_ai_thread_exposes_and_dispatches_reads_without_an_extra_agent_or_approval(self):
        ai=AiSession(self.service);self.addCleanup(ai.close)
        rpc=Mock();rpc.info={};rpc.call.side_effect=lambda method,args: {'config':{'approval_policy':'on-request','approvals_reviewer':'user','mcp_servers':{'legacy':{}}}} if method=='config/read' else {'thread':{'id':'one-thread'},'model':'fixture','modelProvider':'fixture','approvalPolicy':'on-request','approvalsReviewer':'user'}
        ai.rpc=rpc
        with patch.object(ai,'connect') as connect:ai._start_thread()
        self.assertEqual(connect.call_count,1)
        starts=[call for call in rpc.call.call_args_list if call.args[0]=='thread/start'];self.assertEqual(len(starts),1)
        names={row['name'] for row in starts[0].args[1]['dynamicTools']}
        self.assertTrue({'ic_spiceowl_status','ic_onboarding_probe','ic_sim_submit','ic_sim_saved_run'}<=names)
        self.assertFalse(starts[0].args[1]['config']['mcp_servers.legacy.enabled'])
        ai.turn_id='turn';ai.state='running';ai.request_key='read-request';ai.turns[ai.request_key]={'key':ai.request_key,'permission_mode':'read_only'}
        self.service.gateway.request.return_value=envelope(counts={})
        ai._tool({'id':'call','params':{'threadId':'one-thread','turnId':'turn','tool':'ic_spiceowl_status','arguments':{},'callId':'read-call'}})
        self.assertTrue(rpc.send.call_args.args[0]['result']['success']);self.assertEqual(ai.pending,{})
        self.assertEqual(len([call for call in rpc.call.call_args_list if call.args[0]=='thread/start']),1)
        self.service.gateway.request.assert_called_once_with('/api/spiceowl/read/spiceowl_status')

    def test_installed_sdk_exports_match_circuitgit_schemas(self):
        try:from spiceowl.embedded import read_tool_definitions
        except ImportError:self.skipTest('New pinned SpiceOwl embedded exports not installed yet')
        definitions={row['name']:row for row in read_tool_definitions()}
        self.assertEqual(set(definitions),set(SPICEOWL_READS))
        for name,schema in SPICEOWL_READS.items():self.assertEqual(definitions[name]['inputSchema'],schema)


if __name__=='__main__':unittest.main()
