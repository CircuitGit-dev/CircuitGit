#!/usr/bin/env python3
"""Installed operator adapter for manual review or an explicitly granted direct lane."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


def execution_mode(settings):
    mode = settings.get('execution_mode', 'manual')
    if mode not in ('manual', 'direct'):
        raise ValueError('execution_mode must be manual or direct')
    return mode


def load_settings(path):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/workbench'))
    from platform_compat import is_owner_private_file
    path = Path(path)
    if not is_owner_private_file(path, max_size=65536, allow_root=True, reject_mode_mask=0o022):
        raise ValueError('Runner settings must be a trusted non-writable regular file')
    value = json.loads(path.read_text())
    if (not isinstance(value, dict) or value.get('schema') != 'circuitgit.spectre-ci.v1' or not isinstance(value.get('testbenches'), dict)
            or not isinstance(value.get('client_config'), str) or not Path(value['client_config']).is_absolute()):
        raise ValueError('Configure the installed runner bindings and local workbench client')
    execution_mode(value)
    return value


def safe_id(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,180}', value) else None


def direct_request(service, operation, identity, run_id, key, report):
    """Service owns grants and the durable receipt; no approval or fallback is synthesized."""
    report = {**report, 'idempotency_key': key, 'automatic_retry': False,
              'simulation_status': 'not_evaluated', 'caller_id': 'native-agent'}
    execute = getattr(service, 'execute_simulation', None)
    if not callable(execute):
        return {**report, 'state': 'unavailable', 'note': 'The installed Service does not support direct execution. No manual fallback or request was created.'}, 2
    arguments = {**identity, **({'run_id': run_id} if operation == 'collect' else {})}
    try:
        receipt = execute(operation, arguments, key, caller_id='native-agent')
    except Exception as error:
        # An unexpected interruption may follow dispatch. Preserve the stable key
        # and any original request ID, never retry here or switch execution lanes.
        code = getattr(error, 'code', '')
        details = getattr(error, 'details', {})
        details = details if isinstance(details, dict) else {}
        rejected = code in ('forbidden', 'invalid_input')
        return {**report, 'state': 'rejected' if rejected else 'unknown',
                'request_id': safe_id(details.get('request_id')), 'simulation_started': False if rejected else None,
                'error_kind': type(error).__name__,
                'note': 'Direct execution was blocked or its outcome is unknown. Inspect the original Service receipt using this key/request ID; no retry or manual fallback was attempted.'}, 2 if rejected else 10
    if not isinstance(receipt, dict):
        return {**report, 'state': 'unknown', 'simulation_started': None,
                'note': 'The Service returned no recognizable receipt. Reconcile the original action key; do not resubmit.'}, 10
    state = receipt.get('state', receipt.get('status'))
    state = state if isinstance(state, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', state) else 'unknown'
    malformed_result = 'result' in receipt and not isinstance(receipt['result'], dict)
    result = receipt.get('result') if isinstance(receipt.get('result'), dict) else {}
    inner_state = result.get('state', result.get('status'))
    inner_state = (inner_state if isinstance(inner_state, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', inner_state)
                   else 'unknown' if 'state' in result or 'status' in result else None)
    blocked_states = {'unknown', 'uncertain', 'partial', 'failed', 'error', 'rejected', 'denied', 'blocked',
                      'pending_approval', 'dispatching', 'authorized_dispatching', 'cancelled', 'canceled', 'timeout'}
    secondary_state = result.get('status') if 'state' in result else None
    inner_states = [value for value in (inner_state, secondary_state) if isinstance(value, str)]
    malformed_state = any(key in result and (not isinstance(result[key], str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', result[key]))
                          for key in ('state', 'status'))
    inner_blocked = malformed_state or any(value in blocked_states or any(word in value for word in ('unknown', 'uncertain', 'partial', 'reconcile', 'failed', 'failure'))
                                           for value in inner_states)
    mismatched = any(result.get(field) not in (None, value) for field, value in identity.items())
    if result.get('configuration_id') not in (None, identity['configuration']): mismatched = True
    observed_run = safe_id(result.get('run_id', receipt.get('run_id')))
    if operation == 'collect' and observed_run not in (None, run_id): mismatched = True
    accepted = (state in ('accepted', 'complete', 'succeeded') and receipt.get('status', state) in ('accepted', 'complete', 'succeeded')
                and not inner_blocked and not mismatched and not malformed_result
                and not receipt.get('error') and not result.get('error') and receipt.get('ok') is not False and result.get('ok') is not False)
    # Do not upload raw receipt.result: the original remains in the installed
    # Service ledger and may include private gateway or runtime details.
    projection = {'request_id': safe_id(receipt.get('request_id')), 'state': state, 'result_state': inner_state}
    if isinstance(receipt.get('fingerprint'), str) and re.fullmatch(r'[a-f0-9]{64}', receipt['fingerprint']):
        projection['fingerprint'] = receipt['fingerprint']
    if receipt.get('authorization_basis') == 'installed_connection_grant':
        projection['authorization_basis'] = receipt['authorization_basis']
    return {**report, **projection, 'run_id': observed_run or run_id or None, 'status': 'accepted' if accepted else 'blocked',
            'simulation_started': None,
            'note': ('The Service accepted the authorized request. Solver execution, collection completion and scientific acceptance are not inferred.' if accepted else
                     'The original receipt is pending, incomplete, rejected or requires reconciliation. No retry, new key or manual fallback was attempted.')}, 0 if accepted else 10


def perform(settings, testbench, commit, operation, run_id, invocation, service):
    mode = execution_mode(settings)
    if operation not in ('plan', 'preflight', 'submit', 'collect', 'results'): raise ValueError('Unsupported finite CI operation')
    if not re.fullmatch(r'[a-f0-9]{40}', commit): raise ValueError('An exact full source commit is required')
    row = settings['testbenches'].get(testbench)
    if not isinstance(row, dict) or not all(isinstance(row.get(k), str) and row[k] for k in ('project_id', 'configuration')):
        raise ValueError('Selected testbench has no operator-installed runnable binding')
    identity = {'project_id': row['project_id'], 'configuration': row['configuration'], 'source_commit': commit}
    report = {'schema': 'circuitgit.spectre-ci-request.v1', 'testbench_id': testbench, 'source_commit': commit,
              'operation': operation, 'execution_mode': mode, 'simulation_started': False, 'status': 'blocked', 'automatic_approval': False}
    if operation in ('collect', 'results'):
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,180}', run_id or ''): raise ValueError('Existing explicit run_id required')
    if operation == 'results' or (operation == 'collect' and mode == 'manual'):
        # Verify requested historical run identity before any collection request.
        listing = service.call('sim_status', {})
        matches = [r for r in listing.get('jobs', []) if r.get('run_id', r.get('job_id')) == run_id]
        if len(matches) != 1: raise ValueError('Run identity is not uniquely present in the local gateway catalog')
        observed = matches[0]
        if observed.get('source_commit') != commit or observed.get('project_id') != row['project_id']:
            raise ValueError('Run result identity must match the pinned source and registered project')
        if observed.get('configuration', observed.get('configuration_id')) != row['configuration']:
            raise ValueError('Run configuration must match the registered testbench configuration')
        if operation == 'results':
            service.call('sim_results', {'run_id': run_id})
            # Collection availability alone does not establish a successful
            # solver exit or scientific acceptance. Preserve it as an observation.
            return {**report, 'status': 'observed', 'run_id': run_id,
                    'simulation_status': 'not_evaluated', 'note': 'Read existing result metadata; no new simulation or signoff.'}, 0
        arguments = {'run_id': run_id}
    else:
        arguments = identity
    if operation in ('submit', 'collect'):
        if not re.fullmatch(r'[0-9]+', invocation or ''): raise ValueError('Stable GitHub run ID is required; retry with the same run ID')
        key = 'github-ci-' + hashlib.sha256(json.dumps([invocation, testbench, commit, operation, run_id]).encode()).hexdigest()
        if mode == 'direct':
            return direct_request(service, operation, identity, run_id, key, report)
        arguments = {**arguments, 'idempotency_key': key}
    result = service.call('sim_' + operation, arguments)
    state = result.get('state')
    if operation in ('submit', 'collect'):
        report.update(request_id=result.get('request_id'), state=state, simulation_started=False if state == 'pending_approval' else None,
                      note='Review this frozen request in IC Workbench. CI never approves, rekeys or replays an uncertain operation.')
        return report, 10
    # The gateway's preflight response nests its scientific/execution plan:
    # remote tools can be reachable while that plan still blocks submission.
    plan = result.get('plan') if operation == 'preflight' else result
    if not isinstance(plan, dict) or not isinstance(plan.get('blockers'), list):
        raise ValueError('Gateway did not return an explicit plan blocker list')
    blockers = plan['blockers']
    if not all(isinstance(value, str) for value in blockers) or len(blockers) > 100:
        raise ValueError('Invalid gateway plan blockers')
    report.update(status='checked' if not blockers else 'blocked', check_kind=operation,
                  blockers=blockers, simulation_status='not_run')
    return report, 0 if report['status'] == 'checked' else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings', type=Path, required=True); parser.add_argument('--testbench', required=True)
    parser.add_argument('--commit', required=True); parser.add_argument('--operation', choices=['plan', 'preflight', 'submit', 'collect', 'results'], default='submit')
    parser.add_argument('--run-id', default=''); parser.add_argument('--invocation', required=True); parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    try:
        settings = load_settings(args.settings)
        # This file must be installed in a reviewed checkout, never invoked from
        # a pull request checkout on a licensed/self-hosted runner.
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'apps/codex'))
        from icwb.service import Service, load_config
        report, code = perform(settings, args.testbench, args.commit, args.operation, args.run_id, args.invocation,
                               Service(load_config(settings['client_config'])))
    except Exception as error:
        # Do not publish local paths, SSH targets, raw runtime errors or credentials.
        report, code = {'schema': 'circuitgit.spectre-ci-request.v1', 'status': 'blocked', 'simulation_started': False,
                        'source_commit': args.commit, 'testbench_id': args.testbench, 'error_kind': type(error).__name__,
                        'note': 'Runner configuration, dependency, identity or gateway check failed. Inspect the trusted local operator configuration; nothing was automatically approved or retried.'}, 2
    args.report.parent.mkdir(parents=True, exist_ok=True); args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report)); return code


if __name__ == '__main__': raise SystemExit(main())
