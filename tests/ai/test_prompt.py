"""Bounded prompt tests use only local fake Service/Rpc; never start a model or gateway."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'apps/codex'))
from icwb.ai import AiSession
from icwb.host import AiRoutes
from icwb.ai_prompt import build_prompt, geometry_summary, safe_error_record, MAX_PROMPT_CHARS, MAX_INPUT_BYTES
from icwb.service import Failure, canonical, digest

COMMIT='a'*40
HASH='b'*64
BUNDLE='c'*40
MANIFEST='d'*64


def context():
    return {'version':1,'revision':4,'mode':'live','project':{'id':'SYNTHETIC','sourceCommit':COMMIT},
            'file':{'path':'projects/demo.scs','baseCommit':COMMIT,'persistedSha256':HASH,
                    'currentTextSha256':HASH,'dirty':False,'hashPending':False},
            'selection':{'kind':'terminal','name':'M1','scope':'TOP','sourcePath':'projects/demo.scs',
                         'sourceSha256':HASH,'lineStart':10,'lineEnd':12,'targetKind':'unmapped',
                         'mappingVerified':False,'readonly':True,'occurrencePath':['X0','M1'],
                         'occurrenceResolved':True,'terminalName':'g','netName':'vin','busBit':3,
                         'reason':'geometry is stale','viewerSourcePath':'native/top.json','nativeEntryId':'top'},
            'run':{'runId':'saved-run','sourceCommit':'e'*40,'projectId':'SYNTHETIC','configurationId':'PIPE_LOW','historical':True},
            'configuration':{'id':'PIPE_LOW','source_commit':COMMIT},
            'geometry':{'state':'stale','sourceMatch':False,'nativeReady':False,'snapshotOnly':True,
                        'canonicalMappingEnabled':False,'bundleCommit':BUNDLE,'manifestSha256':MANIFEST}}


def actual():
    return {'project':{'id':'SYNTHETIC','repository':'SYNTHETIC/repo','branch':'test'},
            'file':{'path':'projects/demo.scs','base_commit':COMMIT,'sha256':HASH,'content':'DO_NOT_INJECT_FULL_SOURCE'},
            'geometry':{'source_path':'projects/demo.scs','source_hash':HASH,'source_commit':COMMIT,
                        'available':True,'stale':True,'native_ready':False,
                        'geometry':{'state':'stale','native_ready':False,'integrity':'valid','fidelity':'partial',
                                    'bundle_commit':BUNDLE,'manifest_sha256':MANIFEST,'root_cell':'top',
                                    'source_binding':{'path':'projects/demo.scs','geometry_source_commit':'e'*40,
                                        'geometry_source_sha256':'f'*64,'current_source_sha256':HASH,
                                        'current_source_commit':COMMIT,'requested_source_sha256':HASH,
                                        'match_kind':'mismatch','dirty':False,'observed_head':COMMIT},
                                    'reasons':['source_hash_mismatch:projects/demo.scs'],
                                    'losses':[{'reason':'missing pin','blocking':True,'severity':'error'}],
                                    'coverage':{'status':'partial','counts':{'pins':{'expected':5,'actual':4}}},
                                    'mapping':{'canonical_enabled':False,'objects':[]}}},
            'cell':'top','scope':'TOP','geometry_provenance_status':'reported_by_gateway'}


class FakeService:
    def __init__(self,path):
        self.state=path;self.config={};self.calls=[];self.source=actual()
    def call(self,op,args):
        self.calls.append((op,copy.deepcopy(args)))
        if op=='read': return copy.deepcopy(self.source)
        raise AssertionError('Unexpected service operation '+op)


class FakeRpc:
    failure=None
    thread_result={'thread':{'id':'SYNTHETIC-thread'},'model':'SYNTHETIC-model','modelProvider':'SYNTHETIC-provider',
                   'approvalPolicy':'on-request','approvalsReviewer':'user'}
    def __init__(self,*args):self.sent=[];self.closed=False
    def call(self,method,params):
        self.sent.append({'method':method,'params':copy.deepcopy(params)})
        if method=='config/read':return {'config':{'model':'SYNTHETIC-model','model_provider':'SYNTHETIC-provider'}}
        if method=='thread/start':return copy.deepcopy(self.thread_result)
        if method=='turn/start':
            if self.failure:raise self.failure
            return {'turn':{'id':'SYNTHETIC-turn'}}
        raise AssertionError('Unexpected RPC method '+method)
    def close(self):self.closed=True


class ProjectionTests(unittest.TestCase):
    def test_context_endpoint_does_not_return_renderer_payload(self):
        source = actual()
        source['file']['editable'] = True
        source['geometry']['geometry']['objects'] = [{'raw': 'GEOMETRY_SENTINEL' + 'x' * 1500000}]
        service = SimpleNamespace(call=lambda op, args: copy.deepcopy(source))
        routes = object.__new__(AiRoutes)
        routes.sessions = SimpleNamespace(get=lambda sid: SimpleNamespace(service=service))
        result = routes.get('/api/ai/context', {'project_id': ['SYNTHETIC']})
        self.assertLess(len(canonical(result)), 10000)
        self.assertNotIn('GEOMETRY_SENTINEL', canonical(result))
        self.assertEqual(result['file']['persistedSha256'], HASH)
        self.assertEqual(result['file']['baseCommit'], COMMIT)
        self.assertEqual(result['geometry']['state'], 'unknown')
        self.assertFalse(result['geometry']['gatewayMetadata']['native_ready'])
        self.assertTrue(result['geometry']['gatewayMetadata']['stale'])

    def test_megabyte_geometry_removed_identity_and_user_text_preserved(self):
        c,a=context(),actual();heavy='HEAVY_GEOMETRY_SENTINEL'+('x'*1500000)
        c['geometry'].update(objects=[heavy]*2,raw=heavy,cells=[{'payload':heavy}]*30)
        c['selection']['payload']=heavy
        a['geometry']['geometry']['mapping']['objects']=[{'raw':heavy}]*200
        a['geometry']['geometry'].update(files=[{'content':heavy}],cells=[{'shapes':heavy}])
        before_c,before_a=canonical(c),canonical(a)
        message='  用户原文\n保持 "quotes" \\ 路径与 emoji 🧪 '+chr(0)
        prompt,info=build_prompt(message,c,a)
        self.assertTrue(prompt.startswith(message+'\n\nContext metadata'))
        self.assertNotIn('HEAVY_GEOMETRY_SENTINEL',prompt);self.assertNotIn('DO_NOT_INJECT_FULL_SOURCE',prompt)
        self.assertEqual(canonical(c),before_c);self.assertEqual(canonical(a),before_a)
        self.assertLess(len(prompt),10000);self.assertLess(info['input_bytes'],MAX_INPUT_BYTES)
        for identity in [COMMIT,HASH,BUNDLE,MANIFEST,'PIPE_LOW','saved-run','projects/demo.scs','TOP','M1','vin']:
            self.assertIn(identity,prompt)
        projection=json.loads(prompt.split('bounded projection):\n',1)[1].split('\nServer-verified',1)[0])
        self.assertEqual(projection['selection'],{k:v for k,v in c['selection'].items() if k!='payload'})
        self.assertEqual(projection['file'],c['file']);self.assertEqual(projection['run'],c['run'])
        self.assertEqual(projection['configuration'],c['configuration'])
        self.assertFalse(projection['geometry']['sourceMatch']);self.assertTrue(projection['geometry']['snapshotOnly'])
        self.assertFalse(projection['geometry']['canonicalMappingEnabled'])
        self.assertIn('source_hash_mismatch',prompt);self.assertIn('"blocking":true',prompt)
        self.assertTrue(info['geometry_details_omitted']);self.assertIn('ic_read',prompt)

    def test_geometry_public_helper_preserves_exact_binding_and_false_unknown(self):
        g=actual()['geometry'];result=geometry_summary(g)
        self.assertFalse(result['native_ready']);self.assertTrue(result['stale'])
        self.assertEqual(result['geometry']['source_binding'],g['geometry']['source_binding'])
        self.assertEqual(result['geometry']['coverage']['status'],'partial')
        self.assertEqual(result['geometry']['coverage']['counts']['pins'],{'expected':5,'actual':4})
        self.assertEqual(geometry_summary(None),None)
        empty=geometry_summary({});self.assertNotIn('native_ready',empty);self.assertNotIn('stale',empty)
        self.assertFalse(geometry_summary(result)['native_ready'])
        self.assertTrue(geometry_summary(result)['stale'])

    def test_huge_descriptive_arrays_report_omission_not_ready(self):
        a=actual();a['geometry']['geometry']['losses']=[{'reason':'long '*500,'blocking':True}]*1000
        a['geometry']['geometry']['reasons']=['stale '*500]*1000
        prompt,_=build_prompt('why stale',context(),a)
        self.assertLess(len(prompt),MAX_PROMPT_CHARS)
        self.assertIn('"omitted_count":984',prompt);self.assertIn('"truncated":true',prompt)
        self.assertIn('"native_ready":false',prompt)

    def test_identity_is_never_silently_truncated(self):
        c=context();c['selection']['name']='M'*3000
        with self.assertRaises(Failure) as error:build_prompt('original',c,actual())
        self.assertEqual(error.exception.code,'prompt_metadata_limit')
        c=context();c['selection']['occurrencePath']=['X']*129
        with self.assertRaises(Failure):build_prompt('original',c,actual())

    def test_long_unicode_user_and_escaped_history_stay_bounded(self):
        message='🧪'*24000
        history=[{'role':'assistant','text':chr(0)*100000} for _ in range(30)]
        prompt,info=build_prompt(message,context(),actual(),history)
        self.assertTrue(prompt.startswith(message));self.assertEqual(prompt.count(message),1)
        self.assertLessEqual(len(prompt),MAX_PROMPT_CHARS);self.assertLessEqual(info['input_bytes'],MAX_INPUT_BYTES)

    def test_error_structure_keeps_method_codes_and_redacts_secrets(self):
        error=Failure('app_server_error','Input exceeds the maximum length of 1048576 characters.',4,
                      {'method':'turn/start','rpc_code':-32602,'token':'NEVER_INCLUDE','context':actual(),'authorization':'NEVER_INCLUDE'})
        record=safe_error_record(error)
        self.assertEqual(record['details'],{'method':'turn/start','rpc_code':-32602})
        self.assertEqual(record['message'],str(error));self.assertNotIn('NEVER_INCLUDE',canonical(record))
        record=safe_error_record(Failure('bad','Authorization: Bearer SUPERSECRET token=PRIVATE api_key=SECRET sk-veryprivate',4))
        for value in ['SUPERSECRET','PRIVATE','SECRET','sk-veryprivate']:self.assertNotIn(value,canonical(record))
        self.assertEqual(safe_error_record(RuntimeError('arbitrary private payload'))['message'],'AI operation failed: RuntimeError')


class SessionPromptTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.service=FakeService(self.root)
        self.ai=AiSession(self.service,FakeRpc)
    def tearDown(self):self.ai.close();self.tmp.cleanup()
    def sent(self,method):return [x for x in self.ai.rpc.sent if x['method']==method] if self.ai.rpc else []

    def test_actual_turn_path_large_geometry_bounded_original_key_unchanged(self):
        c=context();heavy='HUGE_SHAPE'+('x'*2000000)
        c['geometry']['raw']=heavy;self.service.source['geometry']['geometry']['mapping']['objects']=[heavy]
        key='SYNTHETIC-large-prompt';message='  原样测试\n'
        result=self.ai.turn(message,c,key)
        prompt=self.sent('turn/start')[0]['params']['input'][0]['text']
        self.assertTrue(prompt.startswith(message));self.assertNotIn('HUGE_SHAPE',prompt)
        self.assertEqual(result['fingerprint'],digest([message,c]))
        self.assertEqual(self.service.calls[0],('read',{'project_id':'SYNTHETIC','path':'projects/demo.scs'}))
        self.assertLess(result['prompt']['prompt_chars'],10000)
        thread=self.sent('thread/start')[0]['params']
        self.assertEqual(thread['sandbox'],'read-only');self.assertFalse(thread['allowProviderModelFallback'])
        self.assertEqual(self.ai.messages[0]['text'],message)

    def test_structured_turn_rejection_persisted_and_no_retry(self):
        self.ai.connect()
        self.ai.rpc.failure=Failure('app_server_error','Input exceeds the maximum length of 1048576 characters.',4,
                                  {'method':'turn/start','rpc_code':-32602,'secret':'DO_NOT_STORE'})
        c=context();key='SYNTHETIC-size-error'
        with self.assertRaises(Failure):self.ai.turn('request',c,key)
        receipt=json.loads((self.root/'ai-turns'/(digest(key)+'.json')).read_text())
        self.assertEqual(receipt['state'],'suspended');self.assertFalse(receipt['automatic_retry'])
        self.assertEqual(receipt['error_record']['details'],{'method':'turn/start','rpc_code':-32602})
        self.assertNotIn('DO_NOT_STORE',canonical(receipt));self.assertEqual(self.ai.state,'suspended')
        event=[e for e in self.ai.events if e['method']=='session/error'][-1]
        self.assertEqual(event['params']['error'],receipt['error_record'])
        repeated=self.ai.turn('request',c,key);self.assertEqual(repeated,receipt)
        with self.assertRaises(Failure):self.ai.turn('another',c,'SYNTHETIC-other-key')
        self.assertEqual(len(self.sent('turn/start')),1)

    def test_existing_manual_source_dirty_and_suspended_guards_retained(self):
        c=context();c['file']['dirty']=True
        with self.assertRaises(Failure):self.ai.turn('request',c,'SYNTHETIC-dirty')
        self.assertIsNone(self.ai.rpc)
        c=context();c['file']['baseCommit']='f'*40
        with self.assertRaises(Failure):self.ai.turn('request',c,'SYNTHETIC-hash')
        self.assertIsNone(self.ai.rpc);self.assertEqual(self.ai.state,'suspended')

    def test_manual_approval_failure_still_blocks_fake_turn(self):
        self.ai.connect();self.ai.rpc.thread_result={**FakeRpc.thread_result,'approvalsReviewer':None}
        with self.assertRaises(Failure) as err:self.ai.turn('request',context(),'SYNTHETIC-manual')
        self.assertEqual(err.exception.code,'manual_approval_unavailable')
        self.assertEqual(self.sent('turn/start'),[]);self.assertEqual(self.ai.state,'suspended')

    def test_model_start_readiness_error_never_falls_through(self):
        error=Failure('app_server_error','SYNTHETIC readiness rejected',4,{'method':'model/start','rpc_code':-32602})
        with patch.object(self.ai,'_start_thread',side_effect=error):
            with self.assertRaises(Failure):self.ai.turn('request',context(),'SYNTHETIC-readiness')
        self.assertEqual(self.sent('turn/start'),[]);self.assertEqual(self.ai.state,'suspended')
        self.assertEqual(self.ai.turns['SYNTHETIC-readiness']['error_record']['details']['method'],'model/start')

    def test_oversized_critical_identity_fails_before_any_model_rpc(self):
        c=context();c['selection']['name']='M'*3000
        with self.assertRaises(Failure):self.ai.turn('request',c,'SYNTHETIC-identity')
        self.assertIsNone(self.ai.rpc);self.assertEqual(self.ai.state,'suspended')
        self.assertEqual(self.ai.turns['SYNTHETIC-identity']['error_record']['code'],'prompt_metadata_limit')


if __name__=='__main__':unittest.main(verbosity=2)
