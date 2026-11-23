"""Offline tests for exact web-AI/imported-source binding; no model or SSH."""
import copy
import hashlib
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'apps/codex'))
from icwb.ai_onboarding import binding, read_context, check_tool_input, check_tool_result
from icwb.ai_prompt import build_prompt
from icwb.service import Failure

TEXT = 'subckt inv A Y VDD VSS\nends inv\n'
HASH = hashlib.sha256(TEXT.encode()).hexdigest()


def example():
    session = {'schema': 'ic.onboarding.session.v1', 'connection_id': 'a'*32,
               'intake_id': 'intake_'+'b'*32, 'revision': 2, 'source_sha256': HASH,
               'source_commit': None, 'state': 'hosts_observed', 'source': {'file_name': 'inv.scs'}}
    context = {'version': 1, 'revision': 2, 'mode': 'live',
               'project': {'id': 'onboarding:'+session['intake_id'], 'sourceCommit': None},
               'file': {'path': 'inv.scs', 'baseCommit': None, 'persistedSha256': HASH,
                        'currentTextSha256': HASH, 'dirty': False, 'hashPending': False},
               'onboarding': binding(session)}
    return session, context


class OnboardingContextTests(unittest.TestCase):
    def test_unprepared_source_is_valid_without_legacy_project(self):
        session, context = example(); calls = []
        def call(op, args):
            calls.append((op, args)); return copy.deepcopy(session)
        actual = read_context(SimpleNamespace(call=call), context)
        self.assertEqual(calls, [('onboarding_session', {'intake_id': session['intake_id']})])
        self.assertIsNone(actual['file']['base_commit'])
        prompt, _ = build_prompt('跑当前电路', context, actual)
        self.assertIn(session['intake_id'], prompt)
        self.assertIn('ic_onboarding_session', prompt)
        self.assertIn('source_commit may be null', prompt)

    def test_session_change_rejects_instead_of_binding_latest(self):
        for field, value in [('connection_id', 'd'*32), ('source_sha256', 'e'*64),
                             ('revision', 3), ('intake_id', 'intake_'+'f'*32)]:
            session, context = example(); session[field] = value
            with self.subTest(field=field), self.assertRaises(Failure):
                read_context(SimpleNamespace(call=lambda *_: session), context)

    def test_displayed_path_or_commit_must_match(self):
        for field, value in [('path', 'other.scs'), ('baseCommit', 'd'*40), ('persistedSha256', 'e'*64)]:
            session, context = example(); context['file'][field] = value
            with self.subTest(field=field), self.assertRaises(Failure):
                read_context(SimpleNamespace(call=lambda *_: session), context)

    def test_import_only_the_turns_verified_bytes(self):
        session, context = example()
        check_tool_input('onboarding_netlist', {'text': TEXT}, None, context)
        with self.assertRaises(Failure): check_tool_input('onboarding_netlist', {'text': TEXT+'\n'}, None, context)
        with self.assertRaises(Failure): check_tool_input('onboarding_netlist', {'text': TEXT}, binding(session), context)

    def test_cross_intake_tools_stop(self):
        session, context = example()
        check_tool_input('onboarding_prepare', {'intake_id': session['intake_id']}, binding(session), context)
        with self.assertRaises(Failure): check_tool_input('onboarding_run', {'intake_id': 'other'}, binding(session), context)
        with self.assertRaises(Failure): check_tool_input('onboarding_session', {'intake_id': session['intake_id']}, None, context)

    def test_native_envelope_and_monotonic_result(self):
        session, context = example(); previous = binding(session); session['revision'] = 3
        result = check_tool_result('onboarding_probe', {'structuredContent': {'ok': True, 'data': session}}, previous, context)
        self.assertEqual(result['revision'], 3)
        session['revision'] = 1
        with self.assertRaises(Failure): check_tool_result('onboarding_probe', session, previous, context)

    def test_result_for_another_source_or_connection_rejected(self):
        for field, value in [('connection_id', 'e'*32), ('intake_id', 'intake_'+'f'*32), ('source_sha256', 'c'*64)]:
            session, context = example(); previous = binding(session); session[field] = value
            with self.subTest(field=field), self.assertRaises(Failure):
                check_tool_result('onboarding_prepare', session, previous, context)


if __name__ == '__main__': unittest.main()
