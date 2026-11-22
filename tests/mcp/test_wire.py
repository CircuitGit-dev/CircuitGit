"""Adversarial raw client against the official SDK server; only synthetic services."""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[2]


def request(rid,method,params=None):
    return {'jsonrpc':'2.0','id':rid,'method':method,**({'params':params} if params is not None else {})}


def tool(rid,name,args=None):
    return request(rid,'tools/call',{'name':name,'arguments':args or {}})


class Host:
    def __init__(self,root,capabilities=None):
        self.log=(root/'stderr').open('w+')
        self.p=subprocess.Popen([sys.executable,'-B',str(ROOT/'tests/mcp/synthetic_server.py'),
            '--state',str(root/'state'),'--review-timeout','1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log)
        self.buffer=b''
        self.send(request(1,'initialize',{'protocolVersion':'2025-11-25','clientInfo':{'name':'SYNTHETIC-raw-client','version':'0'},
                       'capabilities':capabilities if capabilities is not None else {'elicitation':{'form':{}}}}))
        assert self.read()['id']==1
        self.send({'jsonrpc':'2.0','method':'notifications/initialized'})
        self.send(tool(2,'ic_sim_submit',{'project_id':'demo','configuration':'tran','source_commit':'a'*40,'idempotency_key':'SYNTHETIC-wire-key'}))
        receipt=self.read()['result']['structuredContent']['data']
        self.args={key:receipt[key] for key in ['request_id','fingerprint']}

    def send(self,*values):
        self.raw((''.join(json.dumps(v)+'\n' for v in values)).encode())

    def raw(self,value):
        self.p.stdin.write(value);self.p.stdin.flush()

    def read(self,timeout=5):
        deadline=time.monotonic()+timeout
        while b'\n' not in self.buffer:
            left=deadline-time.monotonic()
            if left<=0 or not select.select([self.p.stdout],[],[],left)[0]: raise AssertionError('No SDK server response')
            data=os.read(self.p.stdout.fileno(),65536)
            if not data: raise AssertionError('Unexpected server EOF')
            self.buffer+=data
        raw,self.buffer=self.buffer.split(b'\n',1)
        value=json.loads(raw);assert value['jsonrpc']=='2.0';return value

    def begin(self,rid=3):
        self.send(tool(rid,'ic_request_review',self.args))
        message=self.read();assert message['method']=='elicitation/create',message;return message

    def result(self,rid):
        for _ in range(12):
            value=self.read()
            if value.get('id')==rid and ('result' in value or 'error' in value):return value
        raise AssertionError('Missing response ID '+str(rid))

    def count(self,rid=90):
        self.send(tool(rid,'ic_projects'))
        return self.result(rid)['result']['structuredContent']['data']['synthetic_resolution_count']

    def close(self):
        self.p.stdin.close();self.p.wait(timeout=5)
        rest=self.buffer+self.p.stdout.read();self.p.stdout.close()
        for line in rest.splitlines(): json.loads(line)  # Includes shutdown-flushed output.
        self.log.seek(0);log=self.log.read();self.log.close()
        assert self.p.returncode==0,log
        assert 'SYNTHETIC diagnostic' in log


class WireTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.host=None
    def tearDown(self):
        if self.host:self.host.close()
        self.tmp.cleanup()
    def start(self,**kwargs):
        self.host=Host(self.root,**kwargs);return self.host

    def test_wrong_response_ids_and_notifications_cannot_authorize(self):
        h=self.start();prompt=h.begin()
        accept={'action':'accept','content':{'approve':True}}
        h.send({'jsonrpc':'2.0','id':'unrelated','result':accept},
               {'jsonrpc':'2.0','method':'elicitation/create','params':accept},
               {'jsonrpc':'2.0','method':'tools/call','params':{'name':'ic_request_review','arguments':{**h.args,'approve':True}}},
               request(4,'ping'))
        self.assertEqual(h.result(4)['result'],{})
        self.assertEqual(h.count(),0)
        h.send({'jsonrpc':'2.0','id':prompt['id'],'result':{'action':'cancel'}})
        result=h.result(3)['result']['structuredContent']['data']
        self.assertEqual(result['review_status'],'cancelled')
        self.assertEqual(result['request']['state'],'pending_approval')

    def test_duplicate_correlated_response_never_resolves_twice(self):
        h=self.start();prompt=h.begin()
        answer={'jsonrpc':'2.0','id':prompt['id'],'result':{'action':'accept','content':{'approve':True}}}
        h.send(answer,answer)
        self.assertEqual(h.result(3)['result']['structuredContent']['data']['request']['state'],'accepted')
        self.assertEqual(h.count(),1)
        h.send(tool(5,'ic_request_review',h.args))
        self.assertEqual(h.result(5)['result']['structuredContent']['data']['review_status'],'already_resolved')

    def test_raw_non_boolean_accept_is_rejected_without_coercion(self):
        h=self.start();prompt=h.begin()
        h.send({'jsonrpc':'2.0','id':prompt['id'],'result':{'action':'accept','content':{'approve':1}}})
        result=h.result(3)['result']['structuredContent']['data']
        self.assertEqual(result['review_status'],'invalid_response')
        self.assertEqual(h.count(),0)

    def test_cancelled_parent_does_not_accept_late_host_result(self):
        h=self.start();prompt=h.begin()
        h.send({'jsonrpc':'2.0','method':'notifications/cancelled','params':{'requestId':3,'reason':'SYNTHETIC cancellation'}},request(4,'ping'))
        h.result(4)
        h.send({'jsonrpc':'2.0','id':prompt['id'],'result':{'action':'accept','content':{'approve':True}}})
        self.assertEqual(h.count(),0)
        h.send(tool(5,'ic_request_status',{'request_id':h.args['request_id']}))
        self.assertEqual(h.result(5)['result']['structuredContent']['data']['state'],'pending_approval')

    def test_url_only_capability_cannot_receive_form(self):
        h=self.start(capabilities={'elicitation':{'url':{}}})
        h.send(tool(3,'ic_request_review',h.args))
        self.assertEqual(h.result(3)['result']['structuredContent']['data']['review_status'],'unsupported')
        self.assertEqual(h.count(),0)

    def test_ambiguous_duplicate_approval_keys_never_reach_sdk_decoder(self):
        h=self.start()
        for index,content in enumerate(['"approve":false,"approve":true',
                                        '"approve":true,"approve":false',
                                        '"approve":false,"appr\\u006fve":true']):
            rid=10+index;prompt=h.begin(rid)
            h.raw(('{"jsonrpc":"2.0","id":'+json.dumps(prompt['id'])+',"result":{"action":"accept","content":{'+content+'}}}\n').encode())
            data=h.result(rid)['result']['structuredContent']['data']
            self.assertEqual(data['review_status'],'invalid_response')
            self.assertEqual(data['request']['state'],'pending_approval')
            # The retired original SDK correlation cannot accept a late repair.
            h.send({'jsonrpc':'2.0','id':prompt['id'],'result':{'action':'accept','content':{'approve':True}}})
            self.assertEqual(h.count(90+index),0)

    def test_extra_or_conflicting_response_envelopes_leave_pending(self):
        h=self.start()
        cases=[{'unrecognized':'extra'}, {'_meta':{}}, {'params':{}},
               {'error':{'code':-32000,'message':'failed'}}, {'method':'ping'},
               {'jsonrpc':'1.0'}, {'id':True}, {'id':1.0}]
        for index,extra in enumerate(cases):
            rid=10+index;prompt=h.begin(rid)
            h.send({'jsonrpc':'2.0','id':prompt['id'],'result':{'action':'accept','content':{'approve':True}},**extra})
            data=h.result(rid)['result']['structuredContent']['data']
            self.assertEqual(data['review_status'],'invalid_response')
            self.assertEqual(data['request']['state'],'pending_approval')
        self.assertEqual(h.count(),0)

    def test_invalid_and_valid_approval_in_same_write_cannot_race_gate(self):
        h=self.start();prompt=h.begin()
        answer=json.dumps({'jsonrpc':'2.0','id':prompt['id'],'result':{'action':'accept','content':{'approve':True}}})
        invalid=answer.replace('"approve": true','"approve": false, "approve": true')
        h.raw((invalid+'\n'+answer+'\n').encode())
        result=h.result(3)['result']['structuredContent']['data']
        self.assertEqual(result['review_status'],'invalid_response')
        self.assertEqual(result['request']['state'],'pending_approval')
        self.assertEqual(h.count(),0)

    def test_duplicate_response_id_result_action_and_meta_are_rejected(self):
        h=self.start()
        templates=[
            '{"jsonrpc":"2.0","id":RID,"id":RID,"result":{"action":"accept","content":{"approve":true}}}',
            '{"jsonrpc":"2.0","id":RID,"result":{"action":"cancel"},"result":{"action":"accept","content":{"approve":true}}}',
            '{"jsonrpc":"2.0","id":RID,"result":{"action":"cancel","action":"accept","content":{"approve":true}}}',
            '{"jsonrpc":"2.0","id":RID,"result":{"action":"accept","content":{"approve":true},"_meta":{"note":0,"note":1}}}',
        ]
        for index,template in enumerate(templates):
            rid=10+index;prompt=h.begin(rid)
            h.raw((template.replace('RID',json.dumps(prompt['id']))+'\n').encode())
            self.assertEqual(h.result(rid)['result']['structuredContent']['data']['request']['state'],'pending_approval')
        self.assertEqual(h.count(),0)

    def test_nonfinite_and_invalid_utf8_cannot_hide_in_approval_metadata(self):
        h=self.start()
        for index,value in enumerate(['NaN','Infinity','-Infinity','1e999','"\\ud800"']):
            rid=10+index;prompt=h.begin(rid)
            raw='{"jsonrpc":"2.0","id":'+json.dumps(prompt['id'])+',"result":{"action":"accept","content":{"approve":true},"_meta":{"hidden":'+value+'}}}\n'
            h.raw(raw.encode())
            self.assertEqual(h.result(rid)['result']['structuredContent']['data']['request']['state'],'pending_approval')
        prompt=h.begin(20)
        raw=json.dumps({'jsonrpc':'2.0','id':prompt['id'],'result':{'action':'accept','content':{'approve':True},'_meta':{'hidden':'BADUTF8'}}})
        h.raw(raw.encode().replace(b'BADUTF8',b'\xff')+b'\n')
        self.assertEqual(h.result(20)['result']['structuredContent']['data']['review_status'],'invalid_response')
        self.assertEqual(h.count(),0)

    def test_rejected_input_is_not_dispatched_and_next_valid_ping_works(self):
        h=self.start()
        h.raw(b'{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"ic_request_review","arguments":{},"arguments":{"approve":true}}}\n')
        h.send(request(11,'ping'));self.assertEqual(h.result(11)['result'],{})
        self.assertEqual(h.count(),0)

    def test_oversize_frame_is_drained_without_parsing_embedded_fragments(self):
        h=self.start();h.begin()
        raw=b'{"jsonrpc":"2.0","id":30,"result":{"action":"accept","content":{"approve":true},"_meta":{"pad":"'+b'x'*(2*1024*1024)+b'"}}}\n'
        h.raw(raw)
        self.assertEqual(h.result(3)['result']['structuredContent']['data']['request']['state'],'pending_approval')
        h.send(request(4,'ping'));self.assertEqual(h.result(4)['result'],{})
        self.assertEqual(h.count(),0)


if __name__=='__main__':unittest.main(verbosity=2)
