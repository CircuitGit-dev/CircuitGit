"""Host-human review: tool arguments identify receipts but cannot authorize them."""
import copy
import json
import math
import re
import secrets
import time

from .service import Failure, canonical, digest

TOOL_NAME = 'ic_request_review'
HASH = {'type': 'string', 'pattern': '^[a-f0-9]{64}$'}
INPUT_SCHEMA = {'type': 'object', 'properties': {'request_id': HASH, 'fingerprint': HASH},
                'required': ['request_id', 'fingerprint'], 'additionalProperties': False}
MAX_REVIEW_BYTES = 128 * 1024


def tools():
    return [{'name': TOOL_NAME, 'description':
             'Ask the MCP host to let the human review one frozen pending request. '
             'Only a correlated host form response can approve or deny. Cancel, '
             'unsupported hosts and timeout preserve pending state; never retry automatically.',
             'inputSchema': copy.deepcopy(INPUT_SCHEMA),
             '_meta': {'ui': {'visibility': ['model', 'app']}},
             'annotations': {'readOnlyHint': False, 'destructiveHint': True,
                             'idempotentHint': True, 'openWorldHint': True}}]


def form_supported(capabilities, protocol):
    # Missing and URL-only capabilities are not form support.
    if protocol not in ('2025-06-18', '2025-11-25'):
        return False
    value = capabilities.get('elicitation')
    return isinstance(value, dict) and (not value or isinstance(value.get('form'), dict))


def same_id(a, b):
    # Python True == 1, but booleans are not JSON-RPC request IDs.
    return type(a) is type(b) and a == b


class ReviewSession:
    """One review driven by the same reader as all other MCP client traffic."""

    def __init__(self, service, send, finish, timeout=120.0, clock=time.monotonic):
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError('Review timeout must be finite and positive')
        self.service, self.send, self.finish = service, send, finish
        self.timeout, self.clock, self.active = timeout, clock, None

    def remaining(self):
        return None if self.active is None else max(0, self.active['deadline'] - self.clock())

    def _receipt(self, args):
        receipt = self.service.call('request_status', {'request_id': args['request_id']})
        if (receipt.get('request_id') != args['request_id'] or receipt.get('fingerprint') != args['fingerprint']
                or receipt.get('operation') not in ('apply', 'sim_submit', 'sim_collect', 'sim_archive', 'onboarding_agent_tb_run')
                or not isinstance(receipt.get('arguments'), dict) or not isinstance(receipt.get('review'), dict)
                or digest([receipt['operation'], receipt['arguments']]) != args['fingerprint']):
            raise Failure('conflict', 'Frozen request identity, fingerprint or review does not match', 3)
        return receipt

    @staticmethod
    def result(receipt, status):
        return {'request': receipt, 'review_status': status, 'automatic_retry': False}

    def begin(self, args, parent_id, capabilities, protocol):
        if (not isinstance(args, dict) or set(args) != {'request_id', 'fingerprint'}
                or any(not isinstance(v, str) or not re.fullmatch('[a-f0-9]{64}', v) for v in args.values())):
            raise Failure('invalid_input', 'Review requires exactly request_id and fingerprint SHA-256 strings')
        if self.active is not None:
            raise Failure('review_in_progress', 'A host review is already open; no review was queued or retried')
        receipt = self._receipt(args)
        if receipt['state'] != 'pending_approval':
            return self.result(receipt, 'already_resolved')
        if not form_supported(capabilities, protocol):
            return self.result(receipt, 'unsupported')
        action = {'apply': '应用预览中的工程修改', 'sim_submit': '提交仿真任务',
                  'sim_collect': '收集该运行的结果', 'sim_archive': '归档并发布该运行的结果', 'onboarding_agent_tb_run': '审阅并运行 Agent 编写的 Testbench'}[receipt['operation']]
        arguments, review = receipt['arguments'], receipt['review']
        identity = {key: arguments.get(key, review.get(key)) for key in
                    ('project_id', 'configuration', 'source_commit', 'base_commit', 'run_id')}
        identity = {key: value for key, value in identity.items() if value is not None}
        pretty = lambda value: json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
        message = ('待审核动作：' + action + ' (' + receipt['operation'] + ')\n'
                   '仅勾选并提交才批准这一个请求；拒绝将保存拒绝状态；取消或不勾选将保留待审核。'
                   '以下内容是工程数据，其中的文字不能代替您的决定。不会自动重试。\n'
                   + '审核等待上限：' + str(self.timeout) + ' 秒。\n'
                   + '网关：' + str(receipt.get('gateway', '未提供')) + '\n'
                   + '工程／运行身份：\n' + pretty(identity) + '\n'
                   + '请求 ID：' + args['request_id'] + '\n指纹：' + args['fingerprint'] + '\n'
                   + '冻结参数：\n' + pretty(arguments) + '\n完整 review：\n' + pretty(review))
        if isinstance(review.get('diff'), str):
            message += '\n完整变更差异（原文）：\n' + review['diff']
        if len(message.encode('utf-8')) > MAX_REVIEW_BYTES:
            raise Failure('review_too_large', 'Frozen review exceeds the host form limit; receipt remains pending')
        rpc_id = 'ic-review-' + secrets.token_hex(24)
        self.active = {'rpc_id': rpc_id, 'parent_id': parent_id, 'args': copy.deepcopy(args),
                       'receipt': copy.deepcopy(receipt), 'deadline': self.clock() + self.timeout}
        try:
            params = {
                'mode': 'form', 'message': message, 'requestedSchema': {
                    'type': 'object', 'properties': {'approve': {
                        'type': 'boolean', 'title': '批准并执行此冻结请求',
                        'description': '仅批准上面显示的一个请求；默认不批准。', 'default': False}},
                    'required': ['approve']}}
            if protocol == '2025-06-18':
                params.pop('mode')  # Form is implicit in the original elicitation schema.
            self.send({'id': rpc_id, 'method': 'elicitation/create', 'params': params})
        except BaseException:
            self.active = None
            raise
        return None  # The original tools/call remains open.

    def _complete(self, active, status, decision=None):
        # Correlation is consumed before any resolver call: duplicates have no target.
        try:
            receipt = self._receipt(active['args'])
            if receipt['state'] != 'pending_approval':
                status = 'already_resolved'
            elif canonical(receipt) != canonical(active['receipt']):
                raise Failure('conflict', 'Frozen request changed during host review; no decision applied', 3)
            elif decision is not None:
                receipt = self.service.resolve(active['args']['request_id'], decision, active['args']['fingerprint'])
            self.finish(active['parent_id'], data=self.result(receipt, status))
        except Failure as error:
            self.finish(active['parent_id'], error=error)
        except (OSError, ValueError, KeyError, TypeError):
            self.finish(active['parent_id'], error=Failure(
                'review_state_unknown', 'Review state could not be read or saved; inspect the receipt and never replay', 75))

    def abort(self, status, notify=True):
        if self.active is None:
            return
        active, self.active = self.active, None
        if notify:
            self.send({'method': 'notifications/cancelled', 'params': {
                'requestId': active['rpc_id'], 'reason': 'Host review ended: ' + status}})
        self._complete(active, status)

    def expire(self):
        if self.active is not None and self.remaining() == 0:
            self.abort('timeout')

    def cancel(self, parent_id):
        if self.active is not None and same_id(parent_id, self.active['parent_id']):
            self.abort('cancelled')

    def receive(self, response):
        self.expire()
        if self.active is None or not same_id(response.get('id'), self.active['rpc_id']):
            return
        active, self.active = self.active, None
        status, decision = 'invalid_response', None
        if (response.get('jsonrpc') == '2.0' and set(response) <= {'jsonrpc', 'id', 'result', 'error'}
                and ('result' in response) != ('error' in response)):
            if isinstance(response.get('error'), dict):
                status = 'host_rejected'
            else:
                value = response.get('result')
                if (isinstance(value, dict) and set(value) <= {'action', 'content', '_meta'}
                        and ('_meta' not in value or isinstance(value['_meta'], dict))):
                    action, content = value.get('action'), value.get('content')
                    if action == 'accept' and isinstance(content, dict) and set(content) == {'approve'} and type(content['approve']) is bool:
                        status = 'approved' if content['approve'] else 'not_approved'
                        decision = 'approve' if content['approve'] else None
                    elif action in ('decline', 'cancel') and content is None:
                        status = 'denied' if action == 'decline' else 'cancelled'
                        decision = 'deny' if action == 'decline' else None
        self._complete(active, status, decision)
