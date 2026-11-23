"""Strict native intake tools and durable client journal; synthetic transport only."""
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/codex'),str(ROOT/'modules/gateway_client')]
from ic_gateway.contracts import ONBOARDING_ROUTES,SCHEMAS,tools
from ic_gateway.service import Failure,Gateway,Service,canonical,validate
from icwb.mcp import run as run_mcp

CONNECTION='c'*32
INTAKE='intake_'+'a'*32
PLAN='b'*64
COMMIT='d'*40
PROBE='probe_'+'e'*32
DISCOVERY='discovery_'+'f'*32
JOB='synthetic-original-job'


class FixtureGateway:
    origin='http://127.0.0.1:18884'
    def __init__(self):
        self.calls=[];self.lose_reply=False;self.record_on_loss=True;self.rejection=None
        self.health={'api_version':'1','mode':'live','connection_id':CONNECTION,'mutation_token':'synthetic-private-token',
            'capabilities':{'simulation_onboarding':True,'simulation_onboarding_native_entry':True,
                            'simulation_onboarding_api_version':'1'}}
        self.session={'schema':'ic.onboarding.session.v1','connection_id':CONNECTION,'intake_id':INTAKE,'revision':3,
            'source_commit':COMMIT,'prepared':{'plan_id':PLAN,'submission_key':'experiment-'+PLAN,'source_commit':COMMIT},
            'next_actions':[{'tool':'ic_onboarding_run','arguments':{'intake_id':INTAKE,'revision':3,'plan_id':PLAN}}]}
        self.job=None

    def request(self,path,body=None,**kwargs):
        self.calls.append((path,copy.deepcopy(body),kwargs))
        if path=='/api/health':return copy.deepcopy(self.health)
        assert path.startswith('/api/simulation/onboarding/'), 'No legacy project/site endpoint may be called'
        assert kwargs['onboarding_entry']=='native_agent'
        assert kwargs['onboarding_connection_id']==CONNECTION
        route=urlsplit(path).path.rsplit('/api/simulation/onboarding/',1)[1]
        if route=='ssh-hosts':return {'schema':'spiceowl.ssh-discovery.v1','hosts':[],'network_operations':0}
        if route=='submission':
            result={'intake_id':INTAKE,'plan_id':PLAN,'submission_key':'experiment-'+PLAN,
                'found':self.job is not None,'run_id':JOB if self.job else None,'job':copy.deepcopy(self.job),
                'dispatch_outcome':'recorded' if self.job else 'unknown','replay_permitted':False}
            if self.rejection:result.update(dispatch_outcome='pre_dispatch_rejected',rejection=copy.deepcopy(self.rejection))
            return result
        if route.startswith('waveforms/'):
            return {'schema':'ic.onboarding.waveforms.v1','intake_id':INTAKE,'job_id':JOB,'fixture':route}
        if route=='run':
            if not self.lose_reply or self.record_on_loss:
                self.job={'schema':'ic.experiment.job.v1','project_id':INTAKE,'plan_id':PLAN,'job_id':JOB,
                    'run_id':JOB,'source_commit':COMMIT,'state':'queued','launch_attempts':0}
                self.session['job']=copy.deepcopy(self.job)
            if self.lose_reply:raise Failure('transport_unknown','Synthetic response loss after POST',75)
        result=copy.deepcopy(self.session)
        if route=='netlist':result.update(source_commit=None,prepared=None,revision=1)
        return result


class OnboardingServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.cfg={'gateway_url':FixtureGateway.origin,'state_dir':self.temp.name}
        self.service=Service(self.cfg);self.gateway=FixtureGateway();self.service.gateway=self.gateway

    def run_args(self):return {'intake_id':INTAKE,'revision':3,'plan_id':PLAN}

    def posts(self):return [(p,b) for p,b,_ in self.gateway.calls if b is not None]

    def test_catalog_has_nineteen_strict_independent_tools_and_correct_effect_hints(self):
        names={'ic_'+name for name in ONBOARDING_ROUTES}
        selected={row['name']:row for row in tools() if row['name'] in names}
        self.assertEqual(len(selected),19)
        for name,row in selected.items():
            self.assertIs(row['inputSchema']['additionalProperties'],False)
            self.assertFalse({'origin','caller_id','commands','url','config_path','idempotency_key'} & set(row['inputSchema']['properties']))
            if ONBOARDING_ROUTES[name[3:]][0]=='GET':
                self.assertTrue(row['annotations']['readOnlyHint'])
                self.assertFalse(row['annotations']['openWorldHint'])
        self.assertFalse(selected['ic_onboarding_netlist']['annotations']['idempotentHint'])
        self.assertFalse(selected['ic_onboarding_veriloga_headers']['annotations']['idempotentHint'])
        self.assertTrue(selected['ic_onboarding_veriloga_headers']['annotations']['openWorldHint'])
        self.assertTrue(selected['ic_onboarding_run']['annotations']['idempotentHint'])

    def test_all_routes_use_main_service_with_native_provenance_and_no_legacy_registry(self):
        cases={
            'onboarding_netlist':{'file_name':'fixture.scs','text':'simulator lang=spectre\r\n'},
            'onboarding_ssh_hosts':{},'onboarding_session':{'intake_id':INTAKE},
            'onboarding_probe':{'intake_id':INTAKE,'revision':3,'ssh_targets':['fixture-host'],
                'overrides':{'setup_source_ids':{'fixture-host':'source-'+'a'*20}}},
            'onboarding_discover_pdk':{'intake_id':INTAKE,'revision':3,'probe_ids':[PROBE],'search_directory_ids':['a'*64]},
            'onboarding_veriloga_headers':{'intake_id':INTAKE,'revision':3,'probe_id':PROBE,'roots':['/observed/headers']},
            'onboarding_prepare':{'intake_id':INTAKE,'revision':3},
            'onboarding_run':self.run_args(),'onboarding_submission':{'intake_id':INTAKE,'plan_id':PLAN},
            'onboarding_inspect':{'intake_id':INTAKE,'job_id':JOB},
            'onboarding_waveforms_catalog':{'intake_id':INTAKE,'job_id':JOB},
            'onboarding_waveforms_mapping':{'intake_id':INTAKE,'job_id':JOB},
            'onboarding_waveforms_window':{'intake_id':INTAKE,'job_id':JOB,'signal_ids':['s_'+'a'*32,'s_'+'b'*32],
                'start':0.0,'stop':1e-9,'max_points':16},
        }
        for op,args in cases.items():
            with self.subTest(op=op):
                result=self.service.call(op,args)
                self.assertNotIn('synthetic-private-token',canonical(result))
        window=self.gateway.calls[-1]
        self.assertEqual(parse_qs(urlsplit(window[0]).query)['signal_ids'],['s_'+'a'*32+',s_'+'b'*32])
        self.assertTrue(all(p=='/api/health' or p.startswith('/api/simulation/onboarding/') for p,_,_ in self.gateway.calls))
        self.assertEqual(self.posts()[0][1]['text'],'simulator lang=spectre\r\n')
        self.assertFalse((Path(self.temp.name)/'requests').exists())
        run=next(options for path,body,options in self.gateway.calls if path.endswith('/run'))
        self.assertEqual(run['route_timeout'],320)
        headers=next(options for path,body,options in self.gateway.calls if path.endswith('/veriloga-headers'))
        self.assertEqual(headers['route_timeout'],300)

    def test_explicit_dataset_identity_is_forwarded_and_checked(self):
        dataset='ds_'+'e'*32
        args={'intake_id':INTAKE,'job_id':JOB,'dataset_id':dataset}
        original=self.gateway.request
        def reply(path,*rest,**options):
            result=original(path,*rest,**options)
            if '/waveforms/' in path:result['dataset_id']=dataset
            return result
        self.gateway.request=reply
        for operation in ('catalog','mapping','window'):
            with self.subTest(operation=operation):
                extra={'signal_ids':['s_'+'a'*32]} if operation=='window' else {}
                result=self.service.call('onboarding_waveforms_'+operation,{**args,**extra})
                self.assertEqual(result['dataset_id'],dataset)
                query=parse_qs(urlsplit(self.gateway.calls[-1][0]).query)
                self.assertEqual(query['dataset_id'],[dataset])
                self.assertNotIn('analysis',query)
        self.gateway.request=original
        with self.assertRaises(Failure) as caught:self.service.call('onboarding_waveforms_catalog',args)
        self.assertEqual(caught.exception.code,'onboarding_response_mismatch')

    def test_ac_dc_catalog_selectors_are_finite_and_dataset_ids_are_not_paths(self):
        base={'intake_id':INTAKE,'job_id':JOB,'dataset_id':'ds_'+'e'*32,'parameters':{'backend':'spiceowl'}}
        validate({**base,'operation':'ac_metrics','inputs':{'response':'s_'+'a'*32,'reference':'s_'+'b'*32}},SCHEMAS['onboarding_analysis'])
        validate({**base,'operation':'dc_op_metrics','inputs':{'devices':['d_'+'a'*32]}},SCHEMAS['onboarding_analysis'])
        for dataset in ('/private/dataset.json','ds_'+'x'*32,'ds_'+'a'*31):
            with self.subTest(dataset=dataset),self.assertRaises(Failure):
                self.service.call('onboarding_waveforms_catalog',{'intake_id':INTAKE,'job_id':JOB,'dataset_id':dataset})
        self.assertEqual(self.gateway.calls,[])

    def test_prepare_supports_explicit_legacy_and_partial_recommendation_overrides(self):
        for extra in ({},{'accept_recommendation':True,'recommendation_id':'a'*64,'recommendation_revision':2,
                          'intent':{'supply_v':.9,'nominal_temperature_c':27}},
                      {'accept_recommendation':False,'discovery_id':DISCOVERY,'candidate_id':'a'*64,
                       'sections':[None,'ObservedCorner'],'tmi_candidate_id':None,
                       'model_contracts':{'fixture_n':{'polarity':'n','terminals':['d','g','s','b']}},'intent':{}}):
            args={'intake_id':INTAKE,'revision':3,**extra}
            result=self.service.call('onboarding_prepare',args)
            self.assertEqual(self.posts()[-1][1],args)
            self.assertEqual(result['next_actions'],self.gateway.session['next_actions'])

    def test_library_choice_preserves_original_observation_without_refresh(self):
        args={'intake_id':INTAKE,'revision':3,'probe_ids':[PROBE],
            'library_selection':{'probe_id':PROBE,'library_id':'a'*64,'library_candidate_id':'b'*64}}
        self.service.call('onboarding_discover_pdk',args)
        self.assertEqual(self.posts()[-1][1],args)

    def test_invalid_types_extra_authority_duplicates_and_paths_stop_before_transport(self):
        cases=[('onboarding_run',{**self.run_args(),'revision':True}),
            ('onboarding_run',{**self.run_args(),'origin':'interactive_client'}),
            ('onboarding_prepare',{'intake_id':INTAKE,'revision':3,'accept_recommendation':'true'}),
            ('onboarding_prepare',{'intake_id':INTAKE,'revision':3,'intent':{'supply_v':float('nan')}}),
            ('onboarding_prepare',{'intake_id':INTAKE,'revision':3,'intent':{'cycles':2.0}}),
            ('onboarding_prepare',{'intake_id':INTAKE,'revision':3,'sections':['X','X']}),
            ('onboarding_prepare',{'intake_id':INTAKE,'revision':3,'model_contracts':{'n':{'polarity':'n','terminals':['d','g','s','s']}}}),
            ('onboarding_probe',{'intake_id':INTAKE,'revision':3,'ssh_targets':['host; command']}),
            ('onboarding_probe',{'intake_id':INTAKE,'revision':3,'ssh_targets':['host'],'overrides':{'command':'evil'}}),
            ('onboarding_discover_pdk',{'intake_id':INTAKE,'revision':3,'probe_ids':[PROBE],'search_paths':['/../private']}),
            ('onboarding_veriloga_headers',{'intake_id':INTAKE,'revision':3,'probe_id':PROBE,'roots':[]}),
            ('onboarding_veriloga_headers',{'intake_id':INTAKE,'revision':3,'probe_id':PROBE,'roots':['relative/path']}),
            ('onboarding_veriloga_headers',{'intake_id':INTAKE,'revision':3,'probe_id':PROBE,'roots':['/x/../private']}),
            ('onboarding_waveforms_window',{'intake_id':INTAKE,'job_id':JOB,'signal_ids':['V(out)']}),
            ('onboarding_ssh_hosts',{'config_path':'/private/config'})]
        for op,args in cases:
            with self.subTest(op=op,args=args),self.assertRaises(Failure):self.service.call(op,args)
        self.assertEqual(self.gateway.calls,[])

    def test_old_simulation_still_requires_installed_operator_grant(self):
        with self.assertRaises(Failure) as caught:
            self.service.call('sim_execute',{'operation':'run','arguments':{'project_id':'legacy','plan_id':PLAN}})
        self.assertEqual(caught.exception.code,'forbidden')
        self.assertEqual(self.gateway.calls,[])
        self.assertEqual(self.service.call('onboarding_netlist',{'file_name':'new.scs','text':'synthetic'})['source_commit'],None)

    def test_unknown_post_is_journaled_and_repeated_call_after_restart_only_reconciles(self):
        self.gateway.lose_reply=True
        with self.assertRaises(Failure):self.service.call('onboarding_run',self.run_args())
        records=list((Path(self.temp.name)/'onboarding-runs').glob('*.json'))
        self.assertEqual(len(records),1)
        record=json.loads(records[0].read_text())
        self.assertEqual(record['state'],'unknown')
        self.assertEqual(record['submission_key'],'experiment-'+PLAN)
        restarted=Service(self.cfg);restarted.gateway=self.gateway
        result=restarted.call('onboarding_run',{**self.run_args(),'revision':4})
        self.assertTrue(result['reconciliation_only'])
        self.assertEqual(result['submission']['run_id'],JOB)
        self.assertEqual(sum(p.endswith('/run') for p,b in self.posts()),1)

    def test_missing_mapping_cannot_unlock_an_unknown_run_or_a_new_prepare(self):
        self.gateway.lose_reply=True;self.gateway.record_on_loss=False
        with self.assertRaises(Failure):self.service.call('onboarding_run',self.run_args())
        for _ in range(2):
            receipt=self.service.call('onboarding_submission',{'intake_id':INTAKE,'plan_id':PLAN})
            self.assertFalse(receipt['found'])
            with self.assertRaises(Failure) as caught:self.service.call('onboarding_prepare',{'intake_id':INTAKE,'revision':4})
            self.assertEqual(caught.exception.code,'onboarding_submission_unresolved')
        result=self.service.call('onboarding_run',self.run_args())
        self.assertFalse(result['submission']['found'])
        self.assertEqual(len(self.posts()),1)

    def test_only_exact_authoritative_predispatch_rejection_unlocks_new_prepare(self):
        self.gateway.lose_reply=True;self.gateway.record_on_loss=False
        with self.assertRaises(Failure):self.service.call('onboarding_run',self.run_args())
        rejection={'schema':'ic.experiment.pre-dispatch-rejection.v1','project_id':INTAKE,'plan_id':PLAN,
            'submission_key':'experiment-'+PLAN,'source_commit':'0'*40,'phase':'before_runner_reserve',
            'code':'resource_or_dependency_preflight_rejected','launch_attempted':False}
        self.gateway.rejection=rejection
        with self.assertRaises(Failure):self.service.call('onboarding_submission',{'intake_id':INTAKE,'plan_id':PLAN})
        self.gateway.rejection['source_commit']=COMMIT
        self.service.call('onboarding_submission',{'intake_id':INTAKE,'plan_id':PLAN})
        self.service.call('onboarding_prepare',{'intake_id':INTAKE,'revision':4})
        self.service.call('onboarding_run',self.run_args())
        self.assertEqual(sum(p.endswith('/run') for p,b in self.posts()),1)

    def test_generic_http_rejection_does_not_authorize_a_replacement_plan(self):
        original=self.gateway.request
        def request(path,body=None,**kwargs):
            if path.endswith('/run'):raise Failure('conflict','SYNTHETIC ambiguous server rejection',3,{'http_status':409})
            return original(path,body,**kwargs)
        self.gateway.request=request
        with self.assertRaises(Failure):self.service.call('onboarding_run',self.run_args())
        record=json.loads(next((Path(self.temp.name)/'onboarding-runs').glob('*.json')).read_text())
        self.assertEqual(record['state'],'unknown')
        with self.assertRaises(Failure) as caught:self.service.call('onboarding_prepare',{'intake_id':INTAKE,'revision':4})
        self.assertEqual(caught.exception.code,'onboarding_submission_unresolved')

    def test_old_gateway_and_disabled_operation_never_dispatch(self):
        self.gateway.health['capabilities'].pop('simulation_onboarding_native_entry')
        with self.assertRaises(Failure):self.service.call('onboarding_netlist',{'file_name':'fixture','text':'fixture'})
        self.assertEqual(len(self.gateway.calls),1)
        self.service.disabled.add('onboarding_ssh_hosts')
        with self.assertRaises(Failure):self.service.call('onboarding_ssh_hosts',{})
        self.assertEqual(len(self.gateway.calls),1)

    def test_real_legacy_mcp_dispatch_preserves_session_and_lifecycle_with_no_second_post(self):
        self.gateway.lose_reply=True
        messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{}}},
            {'jsonrpc':'2.0','method':'notifications/initialized'},
            {'jsonrpc':'2.0','id':2,'method':'tools/list'},
            *[{'jsonrpc':'2.0','id':rid,'method':'tools/call','params':{'name':'ic_onboarding_run','arguments':self.run_args()}} for rid in (3,4)]]
        output=io.StringIO();lifecycle=Mock(tool_names=set(),tools=Mock(return_value=[]))
        run_mcp(self.service,stdin=io.StringIO('\n'.join(canonical(row) for row in messages)+'\n'),stdout=output,
            views=Mock(),lifecycle=lifecycle)
        replies={row['id']:row for row in map(json.loads,output.getvalue().splitlines())}
        self.assertTrue({'ic_'+op for op in ONBOARDING_ROUTES}<={t['name'] for t in replies[2]['result']['tools']})
        self.assertTrue(replies[3]['result']['isError'])
        result=replies[4]['result']['structuredContent']
        self.assertTrue(result['ok'])
        self.assertEqual(result['data']['schema'],'ic.onboarding.session.v1')
        self.assertEqual(result['data']['next_actions'],self.gateway.session['next_actions'])
        self.assertEqual(lifecycle.ensure.call_count,2)
        self.assertEqual(sum(p.endswith('/run') for p,b in self.posts()),1)


class NativeGatewayTests(unittest.TestCase):
    def test_transport_uses_process_token_native_header_fixed_connection_and_route_timeout(self):
        health=FixtureGateway().health;seen=[]
        class Connection:
            def __init__(self,*args,**kwargs):self.timeout=kwargs['timeout']
            def request(self,method,path,body,headers):
                self.path=path;seen.append((method,path,body,headers,self.timeout))
            def getresponse(self):
                data=health if self.path=='/api/health' else {'fixture':'no execution'}
                return Mock(status=200,read=Mock(return_value=canonical({'ok':True,'data':data}).encode()))
            def close(self):pass
        with patch('ic_gateway.service.http.client.HTTPConnection',Connection),patch('ic_gateway.service.time.monotonic',return_value=1000):
            gateway=Gateway('http://127.0.0.1:18884')
            result=gateway.request('/api/simulation/onboarding/netlist',{'file_name':'f','text':'fixture'},
                onboarding_entry='native_agent',onboarding_connection_id=CONNECTION,route_timeout=300)
        method,path,raw,headers,timeout=seen[-1]
        self.assertEqual(method,'POST');self.assertEqual(timeout,300)
        self.assertEqual(headers['Origin'],'http://127.0.0.1:18884')
        self.assertEqual(headers['X-Workbench-Token'],'synthetic-private-token')
        self.assertEqual(headers['X-IC-Onboarding-Entry'],'native_agent')
        self.assertNotIn('X-IC-Simulation-Authorization',headers)
        self.assertNotIn('synthetic-private-token',canonical(result))

    def test_interactive_proxy_checks_connection_without_claiming_native_entry(self):
        health=FixtureGateway().health;health['capabilities'].pop('simulation_onboarding_native_entry')
        seen=[]
        class Connection:
            def __init__(self,*args,**kwargs):self.timeout=kwargs['timeout']
            def request(self,method,path,body,headers):
                self.path=path;seen.append((method,path,headers,self.timeout))
            def getresponse(self):
                data=health if self.path=='/api/health' else {'fixture':'interactive'}
                return Mock(status=200,read=Mock(return_value=canonical({'ok':True,'data':data}).encode()))
            def close(self):pass
        gateway=Gateway('http://127.0.0.1:18884')
        with patch('ic_gateway.service.http.client.HTTPConnection',Connection),patch('ic_gateway.service.time.monotonic',return_value=1000):
            result=gateway.request('/api/simulation/onboarding/session?intake_id='+INTAKE,
                onboarding_connection_id=CONNECTION,route_timeout=320)
            self.assertEqual(result,{'fixture':'interactive'})
            self.assertEqual([row[1] for row in seen],['/api/health','/api/simulation/onboarding/session?intake_id='+INTAKE])
            self.assertNotIn('X-IC-Onboarding-Entry',seen[-1][2])
            self.assertEqual(seen[-1][3],320)
            for changes,code in [({'connection_id':'0'*32},'conflict'),
                                 ({'capabilities':[]},'onboarding_unavailable'),
                                 ({'capabilities':{'simulation_onboarding':True}},'onboarding_unavailable')]:
                previous=copy.deepcopy(health);health.update(changes);seen.clear()
                with self.subTest(changes=changes),self.assertRaises(Failure) as caught:
                    gateway.request('/api/simulation/onboarding/session?intake_id='+INTAKE,
                        onboarding_connection_id=CONNECTION)
                self.assertEqual(caught.exception.code,code)
                self.assertEqual([row[1] for row in seen],['/api/health'])
                health.clear();health.update(previous)

    def test_native_and_interactive_proxy_apply_same_two_mib_response_bound(self):
        health=FixtureGateway().health;read_limits=[]
        class Connection:
            def __init__(self,*args,**kwargs):pass
            def request(self,method,path,body,headers):self.path=path
            def getresponse(self):
                if self.path=='/api/health':
                    return Mock(status=200,read=Mock(return_value=canonical({'ok':True,'data':health}).encode()))
                def read(limit):read_limits.append(limit);return b'x'*(2*1024*1024+1)
                return Mock(status=200,read=read)
            def close(self):pass
        with patch('ic_gateway.service.http.client.HTTPConnection',Connection):
            for entry in (None,'native_agent'):
                with self.subTest(entry=entry),self.assertRaises(Failure) as caught:
                    Gateway('http://127.0.0.1:18884').request('/api/simulation/onboarding/ssh-hosts',
                        onboarding_entry=entry,onboarding_connection_id=CONNECTION)
                self.assertEqual(caught.exception.code,'transport_unknown')
                self.assertEqual(caught.exception.exit_code,75)
        self.assertEqual(read_limits,[2*1024*1024+1]*2)


if __name__=='__main__':unittest.main()
