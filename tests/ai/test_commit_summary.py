"""Synthetic asynchronous commit drafts. No real model, tools, or engineering writes."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from test_sessions import ROOT
from icwb.commit_summary import CommitSummaries, OUTPUT_SCHEMA, parse_output
from icwb.host import AiRoutes
from icwb.service import Service, Failure, canonical
from icwb.service import atom as real_atom


def verified(review='review-001'):
    return {'schema': 'ic.commit-summary-input.v1', 'project_id': 'fixture', 'base_commit': 'a' * 40,
            'review_id': review, 'diff': '--- a/projects/demo.scs\n+++ b/projects/demo.scs\n@@ -1 +1 @@\n-R0 r=2k\n+R0 r=3k\n',
            'files': [{'path': 'projects/demo.scs', 'before_sha256': 'b' * 64, 'after_sha256': 'c' * 64}]}


class SummaryRpc:
    def __init__(self, executable, cwd, callback, timeout=30, **options):
        self.callback = callback; self.options = options; self.timeout = timeout
        self.sent = []; self.closed = False; self.started = threading.Event()
        self.thread_id = 'summary-thread'; self.turn_id = 'summary-turn'; self.close_count = 0

    def call(self, method, params):
        self.sent.append({'method': method, 'params': copy.deepcopy(params)})
        if self.options.get('raise_method') == method:
            raise self.options['rpc_error']
        if method == 'config/read':
            return {'config': {'model': 'fixture-model', 'model_provider': 'fixture-provider',
                'approval_policy': self.options.get('policy', 'on-request'),
                'approvals_reviewer': self.options.get('reviewer', 'user'),
                'mcp_servers': {'fixture-server': {'command': 'NOT_EXECUTED'}, 'name.with.dot': {'url': 'NOT_CONTACTED'}}}}
        if method == 'thread/start':
            return {'thread': {'id': self.thread_id}, 'model': self.options.get('model', 'fixture-model'),
                    'modelProvider': self.options.get('provider', 'fixture-provider'),
                    'approvalsReviewer': self.options.get('thread_reviewer', 'user'),
                    'approvalPolicy': self.options.get('thread_policy', 'on-request')}
        if method == 'turn/start':
            self.started.set()
            if not self.options.get('pending'): self.complete()
            return {'turn': {'id': self.turn_id}}
        raise AssertionError('Unexpected RPC ' + method)

    def emit(self, method, params):
        self.callback({'method': method, 'params': {'threadId': self.thread_id, 'turnId': self.turn_id, **params}})

    def complete(self):
        if self.options.get('request'):
            self.callback({'id': 'request-1', 'method': self.options['request'], 'params': {'threadId': self.thread_id, 'turnId': self.turn_id}})
            return
        if self.options.get('tool_item'):
            self.emit('item/started', {'item': {'id': 'tool', 'type': self.options['tool_item']}}); return
        if self.options.get('disconnect'):
            self.callback({'method': 'transport/disconnected', 'params': {}}); return
        if self.options.get('event_error'):
            self.emit('error', {'error': {'message': 'Do not expose this raw model error'}}); return
        text = self.options.get('output', canonical({'title': '调整电阻参数', 'body': '将 R0 的阻值从 2k 更新为 3k。'}))
        self.emit('turn/started', {'turn': {'id': self.turn_id, 'status': 'inProgress'}})
        self.emit('item/started', {'item': {'id': 'final', 'type': 'agentMessage', 'phase': 'final_answer'}})
        self.emit('item/agentMessage/delta', {'itemId': 'final', 'delta': text[:5]})
        self.emit('item/agentMessage/delta', {'itemId': 'final', 'delta': text[5:]})
        self.emit('item/completed', {'item': {'id': 'final', 'type': 'agentMessage', 'phase': 'final_answer', 'text': text}})
        terminal_thread = self.options.get('terminal_thread', self.thread_id)
        self.callback({'method': 'turn/completed', 'params': {'threadId': terminal_thread,
            'turn': {'id': self.turn_id, 'status': self.options.get('terminal_status', 'completed')}}})

    def send(self, payload):
        raise AssertionError('The summary must never approve or answer a tool request')

    def close(self):
        self.close_count += 1; self.closed = True
        self.callback({'method': 'transport/disconnected', 'params': {}})


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT / 'scratch')
        self.service = Service({'gateway_url': 'http://127.0.0.1:1', 'state_dir': self.tmp.name})
        self.managers = []; self.rpcs = []

    def tearDown(self):
        for manager in self.managers: manager.close()
        self.tmp.cleanup()

    def manager(self, timeout=2, **options):
        def factory(*args):
            rpc = SummaryRpc(*args, **options); self.rpcs.append(rpc); return rpc
        manager = CommitSummaries(self.service, factory, timeout=timeout)
        self.managers.append(manager); return manager

    def wait(self, manager, summary_id):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            record = manager.get(summary_id)
            if record['state'] != 'running': return record
            time.sleep(0.005)
        self.fail('Synthetic summary did not reach a terminal state')

    def wait_started(self):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if self.rpcs and self.rpcs[-1].started.wait(0.005): return self.rpcs[-1]
            time.sleep(0.005)
        self.fail('Synthetic summary did not start')

    def test_one_shot_summary_is_bound_to_review_and_uses_actual_diff(self):
        manager = self.manager(); value = verified()
        first = manager.start(value); result = self.wait(manager, first['summary_id'])
        self.assertEqual(result['state'], 'complete'); self.assertEqual(result['title'], '调整电阻参数')
        self.assertEqual(result['model'], 'fixture-model'); self.assertFalse(result['automatic_retry'])
        for key in ('project_id', 'base_commit', 'review_id'): self.assertEqual(result[key], value[key])
        calls = self.rpcs[0].sent
        self.assertEqual([row['method'] for row in calls], ['config/read', 'thread/start', 'turn/start'])
        prompt = calls[-1]['params']['input'][0]['text']
        self.assertIn(canonical(value), prompt); self.assertEqual(calls[-1]['params']['outputSchema'], OUTPUT_SCHEMA)
        self.assertLessEqual(len(result['title'] + '\n\n' + result['body']), 300)

    def test_thread_has_no_dynamic_native_or_connector_tools_and_no_policy_override(self):
        manager = self.manager(); result = manager.start(verified()); self.wait(manager, result['summary_id'])
        params = self.rpcs[0].sent[1]['params']
        self.assertEqual(params['dynamicTools'], []); self.assertEqual(params['sandbox'], 'read-only')
        self.assertTrue(params['ephemeral']); self.assertFalse(params['allowProviderModelFallback'])
        self.assertEqual(params['config']['web_search'], 'disabled')
        self.assertEqual(params['config']['mcp_servers']['name.with.dot'], {'enabled': False})
        self.assertFalse(params['config']['features.shell_tool']); self.assertFalse(params['config']['features.view_image'])
        self.assertIn('UNTRUSTED DATA', params['developerInstructions'])
        self.assertIn('Do not claim a commit', params['developerInstructions'])
        self.assertTrue(all('approvalPolicy' not in row['params'] and 'approvalsReviewer' not in row['params'] for row in self.rpcs[0].sent))
        self.assertFalse((self.service.state / 'ai-sessions.json').exists())

    def test_duplicate_starts_while_running_and_after_completion_never_replay(self):
        manager = self.manager(pending=True); value = verified()
        first = manager.start(value); rpc = self.wait_started()
        for _ in range(3): self.assertEqual(manager.start(value)['summary_id'], first['summary_id'])
        self.assertEqual(len(self.rpcs), 1); self.assertEqual(sum(row['method'] == 'turn/start' for row in rpc.sent), 1)
        rpc.complete(); result = self.wait(manager, first['summary_id'])
        self.assertEqual(result['state'], 'complete'); self.assertEqual(manager.start(value), result)
        self.assertEqual(len(self.rpcs), 1)

    def test_restart_completed_result_reads_cache_without_model(self):
        manager = self.manager(); first = manager.start(verified()); done = self.wait(manager, first['summary_id']); manager.close()
        second = self.manager(); before = len(self.rpcs)
        self.assertEqual(second.get(first['summary_id']), done); self.assertEqual(second.start(verified()), done)
        self.assertEqual(len(self.rpcs), before)

    def test_restart_unfinished_is_unknown_read_only_and_cannot_auto_replay(self):
        manager = self.manager(pending=True); first = manager.start(verified()); self.wait_started()
        path = manager._path(first['summary_id']); saved = path.read_bytes()
        restarted = self.manager(); before = len(self.rpcs)
        result = restarted.get(first['summary_id'])
        self.assertEqual(result['state'], 'unknown'); self.assertEqual(result['error']['code'], 'summary_restart_unknown')
        self.assertEqual(restarted.start(verified()), result); self.assertEqual(path.read_bytes(), saved)
        self.assertEqual(len(self.rpcs), before)

    def test_same_review_changed_diff_or_file_hash_is_a_conflict(self):
        manager = self.manager(); original = verified(); first = manager.start(original); self.wait(manager, first['summary_id'])
        for field in ('diff', 'files'):
            changed = copy.deepcopy(original)
            if field == 'diff': changed['diff'] += 'injected extra diff'
            else: changed['files'][0]['after_sha256'] = 'd' * 64
            with self.assertRaises(Failure) as failure: manager.start(changed)
            self.assertEqual(failure.exception.code, 'conflict')
        self.assertEqual(len(self.rpcs), 1)

    def test_different_review_or_base_has_separate_identity(self):
        manager = self.manager(); first = manager.start(verified()); self.wait(manager, first['summary_id'])
        other = verified(); other['base_commit'] = 'e' * 40
        second = manager.start(other); self.wait(manager, second['summary_id'])
        self.assertNotEqual(first['summary_id'], second['summary_id'])

    def test_invalid_input_never_creates_a_worker_or_receipt(self):
        manager = self.manager(); cases = []
        for key, value in (('schema', 'wrong'), ('base_commit', '../bad'), ('diff', ''), ('diff', '界' * 22000), ('files', [])):
            changed = verified(); changed[key] = value; cases.append(changed)
        changed = verified(); changed['untrusted'] = 'extra'; cases.append(changed)
        for path in ('../secret', '/absolute', 'projects//file', 'projects/./file', 'projects\\file'):
            changed = verified(); changed['files'][0]['path'] = path; cases.append(changed)
        changed = verified(); changed['files'][0]['after_sha256'] = 'bad'; cases.append(changed)
        for case in cases:
            with self.assertRaises(Failure): manager.start(case)
        self.assertEqual(self.rpcs, []); self.assertFalse(manager.root.exists())

    def test_review_can_include_an_unchanged_selected_file_with_real_changed_files(self):
        manager = self.manager(); value = verified()
        value['files'].append({'path': 'sim/config.json', 'before_sha256': 'd' * 64, 'after_sha256': 'd' * 64})
        first = manager.start(value)
        self.assertEqual(self.wait(manager, first['summary_id'])['state'], 'complete')

    def test_inherited_nonmanual_approval_blocks_before_thread_or_turn(self):
        for index, options in enumerate(({'policy': 'never'}, {'reviewer': 'guardian'})):
            manager = self.manager(**options); first = manager.start(verified('policy-' + str(index)))
            result = self.wait(manager, first['summary_id'])
            self.assertEqual(result['state'], 'failed'); self.assertEqual(result['error']['code'], 'manual_approval_unavailable')
            self.assertEqual([row['method'] for row in self.rpcs[-1].sent], ['config/read'])

    def test_returned_nonmanual_approval_and_changed_provider_block_before_turn(self):
        cases = ({'thread_reviewer': 'guardian'}, {'thread_policy': 'never'}, {'model': 'fallback'}, {'provider': 'other'})
        for index, options in enumerate(cases):
            manager = self.manager(**options); first = manager.start(verified('changed-' + str(index)))
            result = self.wait(manager, first['summary_id'])
            self.assertEqual(result['state'], 'failed')
            self.assertNotIn('turn/start', [row['method'] for row in self.rpcs[-1].sent])

    def test_any_tool_or_permission_request_fails_without_response_or_action(self):
        for index, method in enumerate(('item/tool/call', 'item/permissions/requestApproval', 'item/commandExecution/requestApproval', 'mcpServer/elicitation/request')):
            manager = self.manager(request=method); first = manager.start(verified('request-' + str(index)))
            result = self.wait(manager, first['summary_id'])
            self.assertEqual(result['state'], 'failed'); self.assertEqual(result['error']['code'], 'summary_tools_forbidden')
            self.assertNotIn('title', result)

    def test_native_tool_items_fail_without_engineering_service_calls(self):
        for index, item in enumerate(('commandExecution', 'fileChange', 'dynamicToolCall', 'mcpToolCall', 'webSearch')):
            manager = self.manager(tool_item=item)
            with patch.object(self.service, 'call', side_effect=AssertionError('No engineering calls')):
                first = manager.start(verified('tool-' + str(index))); result = self.wait(manager, first['summary_id'])
            self.assertEqual(result['state'], 'failed'); self.assertEqual(result['error']['code'], 'summary_tools_forbidden')

    def test_failed_terminal_never_uses_partial_json_as_success(self):
        manager = self.manager(terminal_status='failed'); first = manager.start(verified()); result = self.wait(manager, first['summary_id'])
        self.assertEqual(result['state'], 'failed'); self.assertEqual(result['error']['code'], 'summary_model_failure')
        self.assertNotIn('title', result)

    def test_disconnect_timeout_and_mismatched_identity_are_unknown_no_retry(self):
        cases = ({'disconnect': True}, {'pending': True, 'timeout': 0.08}, {'terminal_thread': 'other-thread'})
        for index, options in enumerate(cases):
            manager = self.manager(**options); value = verified('unknown-' + str(index))
            first = manager.start(value); result = self.wait(manager, first['summary_id']); before = len(self.rpcs)
            self.assertEqual(result['state'], 'unknown'); self.assertEqual(manager.start(value), result)
            self.assertEqual(len(self.rpcs), before); self.assertNotIn('title', result)

    def test_rpc_uncertainty_is_unknown_and_errors_are_redacted(self):
        manager = self.manager(raise_method='turn/start', rpc_error=Failure('app_server_error', 'Bearer PRIVATE api_key=PRIVATE', 75, {'rpc_code': -32000}))
        first = manager.start(verified()); result = self.wait(manager, first['summary_id'])
        self.assertEqual(result['state'], 'unknown'); self.assertNotIn('PRIVATE', canonical(result))

    def test_invalid_json_lengths_types_and_duplicates_fail_without_fallback(self):
        invalid = ['not json', '```json\n{}\n```', '{"title":"a","title":"b","body":"c"}',
                   canonical({'title': 'a', 'body': 'b', 'extra': 1}), canonical({'title': 1, 'body': 'b'}),
                   canonical({'title': 'a' * 81, 'body': 'b'}), canonical({'title': 'a', 'body': 'b' * 298}),
                   canonical({'title': 'a\nb', 'body': 'b'}), canonical({'title': 'a', 'body': 'b\x00'}),
                   canonical({'title': 'a', 'body': ''})]
        for index, output in enumerate(invalid):
            manager = self.manager(output=output); first = manager.start(verified('invalid-' + str(index)))
            result = self.wait(manager, first['summary_id'])
            self.assertEqual(result['state'], 'failed'); self.assertEqual(result['error']['code'], 'invalid_summary_output')
            self.assertNotIn('title', result); self.assertNotIn('body', result)

    def test_length_limits_accept_exact_boundary(self):
        good = {'title': '界' * 80, 'body': '字' * 218}
        self.assertEqual(parse_output(canonical(good)), good)

    def test_oversized_stream_and_model_error_fail_explicitly(self):
        for index, options in enumerate(({'output': 'X' * 4097}, {'event_error': True})):
            manager = self.manager(**options); first = manager.start(verified('failed-' + str(index)))
            self.assertEqual(self.wait(manager, first['summary_id'])['state'], 'failed')

    def test_shutdown_stops_only_owned_worker_and_keeps_unknown_receipt(self):
        manager = self.manager(pending=True); first = manager.start(verified()); rpc = self.wait_started()
        job = manager.jobs[first['summary_id']]
        manager.close(); result = manager.get(first['summary_id'])
        self.assertEqual(result['state'], 'unknown'); self.assertEqual(result['error']['code'], 'summary_shutdown_unknown')
        self.assertTrue(rpc.closed); self.assertEqual(rpc.close_count, 1); self.assertFalse(job.thread.is_alive())
        with self.assertRaises(Failure): manager.start(verified('after-close'))
        reopened = self.manager(); before = len(self.rpcs)
        self.assertEqual(reopened.start(verified())['state'], 'unknown'); self.assertEqual(len(self.rpcs), before)

    def test_shutdown_during_rpc_construction_closes_late_child_without_requests(self):
        entered = threading.Event(); release = threading.Event()
        def factory(*args):
            rpc = SummaryRpc(*args); self.rpcs.append(rpc); entered.set()
            release.wait(2); return rpc
        manager = CommitSummaries(self.service, factory, timeout=2); self.managers.append(manager)
        first = manager.start(verified()); self.assertTrue(entered.wait(1))
        closing = threading.Thread(target=manager.close); closing.start()
        deadline = time.monotonic() + 1
        while not manager.closed and time.monotonic() < deadline: time.sleep(0.001)
        release.set(); closing.join(2)
        self.assertFalse(closing.is_alive()); self.assertTrue(self.rpcs[0].closed)
        self.assertEqual(self.rpcs[0].sent, []); self.assertEqual(manager.get(first['summary_id'])['state'], 'unknown')

    def test_thread_creation_failure_keeps_failed_receipt_and_close_is_safe(self):
        manager = self.manager()
        with patch('icwb.commit_summary.threading.Thread.start', side_effect=RuntimeError('Synthetic thread creation failure')):
            first = manager.start(verified())
        self.assertEqual(first['state'], 'failed'); self.assertEqual(manager.activity(), {'running_count': 0})
        self.assertEqual(self.rpcs, [])
        manager.close(); manager.close()
        self.assertEqual(manager.get(first['summary_id']), first)
        reopened = self.manager()
        self.assertEqual(reopened.start(verified()), first); self.assertEqual(self.rpcs, [])

    def test_failed_complete_receipt_write_never_reports_unsaved_success(self):
        def atom(path, value):
            if value.get('state') == 'complete': raise OSError('Synthetic disk error')
            return real_atom(path, value)
        manager = self.manager()
        with patch('icwb.commit_summary.atom', side_effect=atom):
            first = manager.start(verified()); result = self.wait(manager, first['summary_id'])
        self.assertEqual(result['state'], 'failed'); self.assertNotIn('title', result)

    def test_shutdown_receipt_write_failure_still_closes_child_and_restart_is_unknown(self):
        manager = self.manager(pending=True); first = manager.start(verified()); rpc = self.wait_started()
        with patch('icwb.commit_summary.atom', side_effect=OSError('Synthetic disk error')): manager.close()
        self.assertTrue(rpc.closed)
        restarted = self.manager(); self.assertEqual(restarted.get(first['summary_id'])['state'], 'unknown')

    def test_concurrency_is_bounded_independently_of_chat_sessions(self):
        manager = self.manager(pending=True); first = manager.start(verified('one')); manager.start(verified('two'))
        with self.assertRaises(Failure) as failure: manager.start(verified('three'))
        self.assertEqual(failure.exception.code, 'summary_busy')
        self.assertEqual(manager.start(verified('one'))['summary_id'], first['summary_id'])

    def test_status_requires_opaque_id_and_never_starts_work(self):
        manager = self.manager()
        for summary_id in ('../../secret', '', 'cs_' + 'x' * 64, 'cs_' + '0' * 64):
            with self.assertRaises(Failure): manager.get(summary_id)
        self.assertEqual(self.rpcs, []); self.assertFalse(manager.root.exists())

    def test_activity_is_memory_only_and_counts_pending_worker_until_cleanup(self):
        manager = self.manager(pending=True)
        before = list(self.service.state.rglob('*'))
        self.assertEqual(manager.activity(), {'running_count': 0})
        self.assertEqual(list(self.service.state.rglob('*')), before); self.assertEqual(self.rpcs, [])
        first = manager.start(verified()); self.wait_started()
        path = manager._path(first['summary_id']); saved = path.read_bytes()
        self.assertEqual(manager.activity(), {'running_count': 1})
        self.assertEqual(path.read_bytes(), saved)
        manager.close(); self.assertEqual(manager.activity(), {'running_count': 0})

    def test_two_registries_share_durable_reservation_without_duplicate_inference(self):
        a = self.manager(pending=True); b = self.manager(pending=True); barrier = threading.Barrier(3); results = []
        def start(manager):
            barrier.wait(); results.append(manager.start(verified()))
        one = threading.Thread(target=start, args=(a,)); two = threading.Thread(target=start, args=(b,))
        one.start(); two.start(); barrier.wait(); one.join(2); two.join(2)
        self.wait_started()
        self.assertEqual(len(results), 2); self.assertEqual(results[0]['summary_id'], results[1]['summary_id'])
        self.assertEqual(len(self.rpcs), 1)

    def test_routes_bridge_does_not_construct_or_modify_user_sessions(self):
        routes = AiRoutes(self.service); manager = self.manager()
        routes.commit_summaries = manager
        self.assertEqual(routes.commit_summary_activity(), {'running_count': 0})
        first = routes.start_commit_summary(verified()); result = self.wait(manager, first['summary_id'])
        self.assertEqual(routes.get_commit_summary(first['summary_id']), result)
        self.assertEqual(routes.sessions.instances, {}); self.assertEqual(routes.sessions.rows, [])
        routes.close()


if __name__ == '__main__': unittest.main(verbosity=2)
