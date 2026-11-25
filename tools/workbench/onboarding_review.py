"""Human review control plane for one immutable, prepared agent testbench.

Nothing in this module is a model-callable approval operation. Browser decisions
consume a locally rendered one-use form; native decisions require the installed
host's separate private signing key. Runner still owns every execution receipt.
"""
import copy
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import re
import secrets
import stat
import threading
import time

from platform_compat import is_owner_private_file, open_nofollow
from runner import atomic, stamp
from spiceowl_pool import canonical, read_json
from workspace import Conflict

DOMAIN='ic.agent-tb.human-review.v1'
HUMAN_RUN_PATH='/api/simulation/onboarding/agent-tb/human-run'
BINDING_FIELDS={'intake_id','revision','draft_id','plan_id','review_id','review_digest'}


def authority_key(path, *, create=False):
    path=Path(path)
    if create:
        path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        try:fd=open_nofollow(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        except FileExistsError:pass
        else:
            with os.fdopen(fd,'wb') as stream:stream.write(secrets.token_bytes(32))
    if not is_owner_private_file(path):
        raise PermissionError('Human review authority must be an owner-private regular file')
    value=path.read_bytes()
    if not 32<=len(value)<=128:raise PermissionError('Invalid human review authority key')
    return value


def verify_authorization(key,raw,authorization,*,now=None):
    if not isinstance(raw,bytes) or len(raw)>16384 or not isinstance(authorization,str) or not re.fullmatch(r'[0-9]{1,12}\.[a-f0-9]{64}',authorization):
        raise PermissionError('A signed native human-review response is required')
    timestamp,proof=authorization.split('.')
    if abs((time.time() if now is None else now)-int(timestamp))>120:
        raise PermissionError('Human review response expired')
    message=json.dumps([DOMAIN,'POST',HUMAN_RUN_PATH,hashlib.sha256(raw).hexdigest(),timestamp],separators=(',',':')).encode()
    expected=hmac.new(key,message,hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected,proof):raise PermissionError('Human review response does not match this request')


class TestbenchReviews:
    def __init__(self,runtime,*,clock=time.monotonic):
        self.runtime=runtime;self.clock=clock;self.lock=threading.RLock();self.tickets={}
        self.key_file=runtime.root/'review-authority.key'
        self.key=authority_key(self.key_file,create=True)

    def path(self,intake,review):
        if not isinstance(review,str) or not re.fullmatch('[a-f0-9]{64}',review):raise ValueError('Exact review ID required')
        return self.runtime._folder(intake)/'reviews'/(review+'.json')

    def _sign(self,value):return hmac.new(self.key,canonical(value),hashlib.sha256).hexdigest()

    def freeze(self,state,snapshot):
        # Snapshot includes all source/support/TB bytes and all scientific and
        # execution inputs. Its digest, rather than UI summaries, is authority.
        if len(canonical(snapshot))>1536*1024:raise ValueError('Frozen human review exceeds its display budget')
        digest=hashlib.sha256(canonical(snapshot)).hexdigest()
        identity={'intake_id':state['intake_id'],'revision':state['revision'],
            'draft_id':state['agent_tb']['draft_id'],'plan_id':state['prepared']['plan_id'],'review_digest':digest}
        review_id=hashlib.sha256(canonical({'connection_id':self.runtime.connection_id,**identity})).hexdigest()
        data={'schema':'ic.agent-tb.review.v1','connection_id':self.runtime.connection_id,
            **identity,'review_id':review_id,'state':'pending','requires_human':True,
            'created_at':stamp(),'snapshot':copy.deepcopy(snapshot)}
        path=self.path(state['intake_id'],review_id)
        if path.exists():
            old=self.read(state['intake_id'],review_id)
            if old['snapshot']!=data['snapshot']:raise Conflict('Frozen review already exists with other content')
            return self.summary(old)
        atomic(path,{'data':data,'signature':self._sign(data)})
        return self.summary(data)

    @staticmethod
    def summary(data):
        return {k:copy.deepcopy(v) for k,v in data.items() if k!='snapshot'}|{
            'review_path':'/agent-tb/review?intake_id='+data['intake_id']+'&review_id='+data['review_id']}

    def read(self,intake,review):
        path=self.path(intake,review)
        if path.is_symlink() or not path.is_file():raise ValueError('Frozen review is unavailable')
        saved=read_json(path);data=saved.get('data')
        if not isinstance(data,dict) or not hmac.compare_digest(self._sign(data),saved.get('signature','')):
            raise PermissionError('Frozen review signature differs')
        if data.get('intake_id')!=intake or data.get('review_id')!=review or data.get('connection_id')!=self.runtime.connection_id:
            raise PermissionError('Frozen review belongs to another connection or intake')
        if hashlib.sha256(canonical(data['snapshot'])).hexdigest()!=data['review_digest']:
            raise PermissionError('Frozen review bytes differ')
        return data

    def current(self,state,args,*,approved=False):
        if not isinstance(args,dict) or set(args)!=BINDING_FIELDS:raise ValueError('Exact frozen human review binding required')
        review=self.read(args['intake_id'],args['review_id'])
        if any(args[k]!=review[k] for k in BINDING_FIELDS) or state.get('intake_id')!=review['intake_id']:
            raise Conflict('Human review binding differs from its frozen inputs')
        selected=state.get('agent_tb_review') or {}
        if (selected.get('review_id')!=review['review_id'] or selected.get('review_digest')!=review['review_digest']
                or (state.get('agent_tb') or {}).get('draft_id')!=review['draft_id']
                or (state.get('prepared') or {}).get('plan_id')!=review['plan_id']):
            raise Conflict('Source, testbench or preparation changed; review the new plan')
        if approved:
            if review['state']!='approved':raise PermissionError('This agent testbench requires human review before simulation')
        elif state['revision']!=review['revision'] or review['state'] not in ('pending','approved'):
            raise Conflict('Intake revision changed; review the current frozen plan')
        return review

    def decide(self,state,args,*,origin,run):
        if origin not in ('native_host_form','browser_form'):raise PermissionError('Human review control plane required')
        review=self.current(state,args)
        if review['state']=='approved':return self.summary(review)
        review.update(state='approved' if run else 'denied',decided_at=stamp(),decision_origin=origin)
        atomic(self.path(state['intake_id'],review['review_id']),{'data':review,'signature':self._sign(review)})
        return self.summary(review)

    def browser_page(self,intake,review_id):
        state=self.runtime._load(intake);review=self.read(intake,review_id)
        binding={k:review[k] for k in BINDING_FIELDS}
        self.current(state,binding)
        with self.lock:
            self.tickets={k:v for k,v in self.tickets.items() if v['expires']>self.clock()}
            if len(self.tickets)>=64:raise ValueError('Too many pending human review forms')
            ticket=secrets.token_urlsafe(32);csrf=secrets.token_urlsafe(32)
            self.tickets[ticket]={'binding':binding,'csrf':csrf,'expires':self.clock()+900,'used':False}
        nonce=secrets.token_urlsafe(24)
        options=json.dumps({'ticket':ticket,'csrf':csrf}).replace('<','\\u003c')
        snapshot=html.escape(json.dumps(review['snapshot'],ensure_ascii=False,indent=2))
        body='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>审阅仿真测试平台</title>
<style nonce="'''+nonce+'''">body{font:14px system-ui;max-width:1100px;margin:32px auto;padding:20px;color:#172a32;background:#f8fafb}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;border:1px solid #ccd5d9;padding:18px}button{font:inherit;padding:10px 18px;margin-right:10px}#run{background:#205d49;color:white}</style>
<h1>审阅并运行这一份仿真测试平台</h1><p>确认后只提交下面固定的源文件、测试平台、PDK、主机范围、分析和判据。修改任何输入都需要重新审阅。</p>
<p>审阅指纹：<code>'''+review['review_digest']+'''</code></p><pre>'''+snapshot+'''</pre>
<button id="run">审阅通过并运行仿真</button><button id="deny">不运行</button><p id="status" role="status"></p>
<script nonce="'''+nonce+'''">const binding='''+options+''';
async function decide(decision){document.querySelectorAll('button').forEach(b=>b.disabled=true);const s=document.querySelector('#status');s.textContent='正在记录原请求…';
try{const r=await fetch('/agent-tb/review/confirm',{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({...binding,decision})});const v=await r.json();if(!r.ok||!v.ok)throw Error(v.error?.message||'未完成');s.textContent=decision==='run'?'已记录原仿真请求，请返回工作台查看。':'已拒绝，未运行仿真。';}
catch(e){s.textContent=e.message+'；请核对原请求，不会自动重发。';}}
document.querySelector('#run').onclick=()=>decide('run');document.querySelector('#deny').onclick=()=>decide('deny');</script></html>'''
        return body.encode('utf-8'),nonce

    def browser_decision(self,args):
        if not isinstance(args,dict) or set(args)!={'ticket','csrf','decision'} or args.get('decision') not in ('run','deny'):
            raise ValueError('A correlated human form decision is required')
        with self.lock:
            ticket=self.tickets.get(args['ticket'])
            if not ticket or ticket['used'] or ticket['expires']<=self.clock() or not secrets.compare_digest(ticket['csrf'],str(args.get('csrf',''))):
                raise PermissionError('Human review form expired, changed or was already used')
            ticket['used']=True;binding=copy.deepcopy(ticket['binding'])
        return self.runtime.human_run(binding,origin='browser_form',run=args['decision']=='run')
