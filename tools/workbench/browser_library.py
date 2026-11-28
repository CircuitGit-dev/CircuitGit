"""Finite library operations authorized by an existing origin-bound browser grant."""
import hashlib
import html
import json
import secrets
import threading
import time

READS = {'catalog', 'describe', 'read_file', 'current', 'history', 'commit_detail', 'checkpoints', 'get_ci', 'receipt', 'pr_status', 'get_testbenches', 'get_testbench_result', 'branches'}
PREVIEWS = {'preview_save', 'preview_commit', 'preview_restore', 'preview_pr', 'preview_ci', 'preview_testbench', 'preview_create_library', 'preview_create_cell', 'preview_clone_cell', 'preview_create_view', 'preview_create_branch', 'preview_switch_branch'}
EXECUTIONS = {'save', 'save_files', 'commit', 'restore', 'pr', 'ci', 'create_library', 'create_cell', 'clone_cell', 'create_view', 'create_branch', 'switch_branch'}


class LocalLibrary:
    def __init__(self, workflow, pairing, local_url, clock=time.monotonic):
        self.workflow, self.pairing, self.local_url, self.clock = workflow, pairing, local_url, clock
        self.lock = threading.RLock()
        self.reviews, self.tickets = {}, {}
        self.running_executions = {}

    def activity(self):
        with self.lock:
            return {'running_actions': sum(self.running_executions.values()) + sum(row['state'] == 'running' for row in self.tickets.values())}

    def identity(self, token, origin):
        if not self.pairing.accepts(token, origin):
            raise PermissionError('Circuit library access requires a confirmed local browser connection')
        return hashlib.sha256((origin+'\n'+token).encode()).hexdigest()

    def _ticket(self, ticket, token=None, origin=None):
        row = self.tickets.get(ticket)
        if not row or (token is not None and row['owner'] != self.identity(token, origin)):
            raise PermissionError('Unknown circuit review for this browser connection')
        if not self.pairing.accepts(row['token'], row['origin']):
            raise PermissionError('The local browser connection expired')
        return row

    def read(self, operation, args, token, origin):
        self.identity(token, origin)
        if not isinstance(args, dict): raise ValueError('Operation arguments must be an object')
        if operation == 'review_testbench':
            if set(args) != {'library_id', 'cell_id', 'review_id'}:
                raise ValueError('Exact cell and testbench proposal are required')
            # Rehydrate only a stored proposal bound to this owned cell. This
            # opens the existing local human form; it never approves a bundle.
            review = self.workflow.testbench_review(**args)
            rid = review['review_id']
            with self.lock:
                self.reviews[rid] = {'owner': self.identity(token, origin), 'review': review,
                    'token': token, 'origin': origin, 'preparation': 'testbench-' + rid}
            return self.request(rid, token, origin)
        if operation == 'review_status':
            if set(args) != {'ticket'}: raise ValueError('Exact ticket required')
            with self.lock:
                row = self._ticket(args['ticket'], token, origin)
                if row['state'] == 'pending' and row['expires'] <= self.clock(): row['state'] = 'expired'
                if row['state'] in ('unknown', 'running'):
                    result = self.workflow.receipt(review_id=row['review_id'])
                    if result.get('state') == 'complete':
                        row['state'], row['result'] = 'completed', result
                return {k: row[k] for k in ('state', 'review_id', 'result', 'error') if k in row}
        if operation == 'capability':
            if args: raise ValueError('Capability takes no arguments')
            return {'available': True, 'schema': 'circuitgit.library-workflow.v1',
                    'repository': self.workflow.repository, 'root': str(self.workflow.root),
                    'authorization': 'paired-browser', 'human_review': 'required-for-testbench-registration',
                    'operations': sorted(READS | PREVIEWS | EXECUTIONS), 'execute_operations': sorted(EXECUTIONS)}
        if operation not in READS: raise ValueError('Unknown library read operation')
        if operation == 'receipt':
            key = args.get('idempotency_key')
            oid = hashlib.sha256(key.encode()).hexdigest() if isinstance(key, str) else args.get('operation_id')
            with self.lock:
                if isinstance(oid, str) and self.running_executions.get(oid):
                    return {'operation_id': oid, 'state': 'running', 'automatic_retry': False}
        return getattr(self.workflow, operation)(**args)

    def execute(self, operation, args, idempotency_key, token, origin):
        self.identity(token, origin)
        if not isinstance(operation, str) or operation not in EXECUTIONS or not isinstance(args, dict):
            raise ValueError('Unknown finite library execution')
        if not isinstance(idempotency_key, str) or not 8 <= len(idempotency_key) <= 160 or any(ord(c) < 32 for c in idempotency_key):
            raise ValueError('A stable idempotency key is required')
        oid = hashlib.sha256(idempotency_key.encode()).hexdigest()
        with self.lock:
            self.running_executions[oid] = self.running_executions.get(oid, 0) + 1
        try:
            return self.workflow.execute(operation, args, idempotency_key)
        finally:
            with self.lock:
                self.running_executions[oid] -= 1
                if not self.running_executions[oid]:
                    del self.running_executions[oid]

    def prepare(self, operation, args, token, origin):
        owner = self.identity(token, origin)
        if operation not in PREVIEWS or not isinstance(args, dict): raise ValueError('Unknown library preview')
        result = getattr(self.workflow, operation)(**args)
        rid = result['review_id']
        with self.lock:
            self.reviews[rid] = {'owner': owner, 'review': result, 'token': token, 'origin': origin,
                                 'preparation': secrets.token_hex(16)}
            # Old previews can be reconstructed explicitly; never dispatch by pruning.
            if len(self.reviews) > 256: self.reviews.pop(next(iter(self.reviews)))
        return result

    def request(self, review_id, token, origin):
        owner = self.identity(token, origin)
        with self.lock:
            review = self.reviews.get(review_id)
            if not review or review['owner'] != owner: raise PermissionError('Prepare this exact change in the current connection first')
            for ticket, row in reversed(list(self.tickets.items())):
                if row['review_id'] == review_id and row['owner'] == owner:
                    if row['state'] == 'pending' and row['expires'] <= self.clock(): row['state'] = 'expired'
                    # A fresh, explicit preview may replace a decision that never
                    # dispatched. Running/uncertain/completed actions always retain
                    # their original execution key, including after another preview.
                    if row['state'] in ('denied', 'expired') and row['preparation'] != review['preparation']:
                        continue
                    return {'ticket': ticket, 'url': self.local_url+'/library/review?ticket='+ticket}
            if len(self.tickets) >= 128: raise ValueError('Too many review windows; reconnect after resolving them')
            # Pairing or helper restart must not turn an uncertain durable write
            # into a fresh execution with a different idempotency key.
            previous = self.workflow.receipt(review_id=review_id)
            prior_state = previous.get('state', 'unknown')
            state = 'pending' if prior_state == 'prepared' else 'completed' if prior_state == 'complete' else 'unknown'
            ticket = secrets.token_urlsafe(32)
            self.tickets[ticket] = {**review, 'review_id': review_id, 'csrf': secrets.token_urlsafe(32),
                                   'execution_key': 'library-'+secrets.token_hex(24), 'state': state,
                                   'expires': self.clock()+600}
            if state != 'pending': self.tickets[ticket]['result'] = previous
            return {'ticket': ticket, 'url': self.local_url+'/library/review?ticket='+ticket}

    def form(self, ticket, nonce):
        with self.lock:
            row = self._ticket(ticket)
            if row['state'] == 'pending' and row['expires'] <= self.clock(): row['state'] = 'expired'
            payload = json.dumps(row['review'], ensure_ascii=False, indent=2)
            summary = row['review'].get('summary') or '请核对这次电路操作'
            difference = row['review'].get('diff') or json.dumps(row['review'].get('payload', {}), ensure_ascii=False, indent=2)
            if len(payload.encode()) > 2*1024*1024: raise ValueError('Review exceeds local display limit')
            cfg = json.dumps({'ticket': ticket, 'csrf': row['csrf']}).replace('<', '\\u003c')
            state = row['state']
        return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>审阅电路版本操作</title><style nonce="'''+nonce+'''">
body{font:14px system-ui;margin:28px auto;padding:20px;max-width:980px;color:#233e33;background:#f8faf9}h1{font-size:22px}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #ccd8d1;padding:16px;background:white;max-height:65vh;overflow:auto}button{padding:10px 18px;margin-right:10px;font:inherit;border:1px solid #aac1b3;border-radius:5px;cursor:pointer}#confirm{background:#166a4e;color:white}#status{padding:10px 0}</style>
<h1>审阅电路版本操作</h1><p>'''+html.escape(summary)+'''</p>
<p>网站：'''+html.escape(row['origin'])+'''</p><pre>'''+html.escape(difference)+'''</pre>
<details><summary>完整操作信息</summary><pre>'''+html.escape(payload)+'''</pre></details>
<button id="confirm">确认执行</button><button id="deny">取消操作</button><button id="done">返回工作台</button>
<p id="status" role="status">'''+html.escape(state)+'''</p>
<script nonce="'''+nonce+'''">const c='''+cfg+''';const state='''+json.dumps(state)+''';
const status=document.querySelector('#status');if(state!=='pending')document.querySelectorAll('#confirm,#deny').forEach(b=>b.disabled=true);
async function decide(action){document.querySelectorAll('#confirm,#deny').forEach(b=>b.disabled=true);status.textContent='正在记录操作回执…';
try{const r=await fetch('/library/review/confirm',{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({...c,action})});const result=await r.json();if(!r.ok||!result.ok)throw Error(result.error?.message||'未完成');status.textContent=JSON.stringify(result.data,null,2);}
catch(e){status.textContent=e.message+'。请返回工作台刷新原记录；此窗口不会重发操作。';}}
document.querySelector('#confirm').onclick=()=>decide('confirm');document.querySelector('#deny').onclick=()=>decide('deny');document.querySelector('#done').onclick=()=>window.close();
</script></html>'''

    def confirm(self, body):
        if not isinstance(body, dict) or set(body) != {'ticket', 'csrf', 'action'} or body['action'] not in ('confirm', 'deny'):
            raise ValueError('Exact human circuit review response required')
        if not all(isinstance(v, str) for v in body.values()): raise ValueError('Review fields must be strings')
        with self.lock:
            row = self._ticket(body['ticket'])
            if not secrets.compare_digest(row['csrf'], body['csrf']): raise PermissionError('Circuit review confirmation did not match')
            if row['state'] != 'pending': return {k: row[k] for k in ('state','result','error') if k in row}
            if row['expires'] <= self.clock():
                row['state'] = 'expired'; return {'state': 'expired'}
            if body['action'] == 'deny':
                row['state'] = 'denied'; return {'state': 'denied'}
            row['state'] = 'running'
        try:
            result = self.workflow.confirm(row['review_id'], row['execution_key'])
        except Exception as error:
            # The workflow's durable receipt is authoritative. Unknown writes are
            # never rekeyed or retried by the browser confirmation route.
            with self.lock:
                row['state'] = 'failed' if getattr(error, 'code', '') and getattr(error, 'code', '') != 'outcome_unknown' else 'unknown'
                row['error'] = {'message': str(error)[:1000], 'code': getattr(error, 'code', 'library_operation_failed'),
                                'details': getattr(error, 'details', {})}
            return {'state': row['state'], 'error': row['error']}
        with self.lock:
            row['result'] = result
            row['state'] = 'completed' if result.get('state', result.get('status')) in ('complete','completed') else 'unknown'
            return {'state': row['state'], 'result': result}
