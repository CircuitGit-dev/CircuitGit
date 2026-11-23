"""Bind web AI turns to one explicit onboarding source; never infer a latest job."""
import copy
import hashlib
import re
from .service import check

READ_OPERATIONS = frozenset(('onboarding_ssh_hosts', 'onboarding_session', 'onboarding_submission',
    'onboarding_waveforms_catalog', 'onboarding_waveforms_mapping', 'onboarding_waveforms_window'))
BINDING_FIELDS = ('schema', 'connection_id', 'intake_id', 'revision', 'source_sha256')


def session_result(result):
    if isinstance(result, dict) and isinstance(result.get('structuredContent'), dict):
        result = result['structuredContent']
    if isinstance(result, dict) and result.get('ok') is True:
        result = result.get('data')
    return result if isinstance(result, dict) and result.get('schema') == 'ic.onboarding.session.v1' else None


def binding(session):
    check(isinstance(session, dict) and session.get('schema') == 'ic.onboarding.session.v1'
          and isinstance(session.get('connection_id'), str) and re.fullmatch(r'[a-f0-9]{32}', session['connection_id'])
          and isinstance(session.get('intake_id'), str) and re.fullmatch(r'intake_[a-f0-9]{32}', session['intake_id'])
          and type(session.get('revision')) is int and session['revision'] >= 1
          and isinstance(session.get('source_sha256'), str) and re.fullmatch(r'[a-f0-9]{64}', session['source_sha256']),
          'Onboarding session identity is invalid', 'onboarding_context_changed', 4)
    return {'schema': 'ic.onboarding.context.v1', **{k: session[k] for k in BINDING_FIELDS if k != 'schema'}}


def read_context(service, context):
    expected = context.get('onboarding')
    check(isinstance(expected, dict) and set(expected) == set(BINDING_FIELDS)
          and expected.get('schema') == 'ic.onboarding.context.v1',
          'Explicit onboarding context is required', 'onboarding_context_changed', 4)
    session = session_result(service.call('onboarding_session', {'intake_id': expected.get('intake_id')}))
    observed = binding(session)
    check(expected == observed, 'Onboarding changed; refresh the selected intake before sending', 'onboarding_context_changed', 4)
    source = session.get('source') or {}
    file = context.get('file') or {}
    commit = session.get('source_commit')
    check(commit is None or isinstance(commit, str) and re.fullmatch(r'[a-f0-9]{40}', commit),
          'Invalid prepared source commit', 'onboarding_context_changed', 4)
    check(context.get('project', {}).get('id') == 'onboarding:' + observed['intake_id']
          and context.get('project', {}).get('sourceCommit') == commit
          and file.get('path') == source.get('file_name') and isinstance(file.get('path'), str)
          and file.get('baseCommit') == commit and file.get('persistedSha256') == observed['source_sha256'],
          'Displayed source differs from the selected intake', 'onboarding_context_changed', 4)
    return {'project': {'id': 'onboarding:' + observed['intake_id']},
            'file': {'path': file['path'], 'base_commit': commit, 'sha256': observed['source_sha256']},
            'geometry': None, 'onboarding': observed,
            'onboarding_state': session.get('state'), 'next_actions': copy.deepcopy(session.get('next_actions', []))}


def check_tool_input(op, arguments, current_binding, context):
    if not op.startswith('onboarding_'):
        return
    check(isinstance(arguments, dict), 'Onboarding arguments must be an object')
    if op == 'onboarding_ssh_hosts':
        return
    if op == 'onboarding_netlist':
        check(current_binding is None, 'Use the already selected intake; do not create another copy', 'onboarding_context_changed', 4)
        text = arguments.get('text')
        expected = context.get('file', {}).get('persistedSha256')
        check(isinstance(text, str) and hashlib.sha256(text.encode('utf-8')).hexdigest() == expected,
              'Import must use the exact source selected for this turn', 'onboarding_context_changed', 4)
        return
    check(current_binding is not None and arguments.get('intake_id') == current_binding['intake_id'],
          'Tool intake differs from the source selected for this turn', 'onboarding_context_changed', 4)


def check_tool_result(op, result, current_binding, context):
    session = session_result(result)
    if not op.startswith('onboarding_') or session is None:
        return current_binding
    observed = binding(session)
    if current_binding:
        check(all(observed[k] == current_binding[k] for k in ('connection_id', 'intake_id', 'source_sha256'))
              and observed['revision'] >= current_binding['revision'],
              'Tool result differs from the original intake', 'onboarding_context_changed', 4)
    else:
        check(op == 'onboarding_netlist' and observed['source_sha256'] == context.get('file', {}).get('persistedSha256'),
              'Imported source differs from this turn', 'onboarding_context_changed', 4)
    return observed
