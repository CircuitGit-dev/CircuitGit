#!/usr/bin/env python3
"""Installed operator adapter for protected manual CI; never auto-approves work."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


def load_settings(path):
    path = Path(path)
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid())
            or info.st_mode & 0o022 or info.st_size > 65536):
        raise ValueError('Runner settings must be a trusted non-writable regular file')
    value = json.loads(path.read_text())
    if (value.get('schema') != 'circuitgit.spectre-ci.v1' or not isinstance(value.get('testbenches'), dict)
            or not isinstance(value.get('client_config'), str) or not Path(value['client_config']).is_absolute()):
        raise ValueError('Configure the installed runner bindings and local workbench client')
    return value


def perform(settings, testbench, commit, operation, run_id, invocation, service):
    if not re.fullmatch(r'[a-f0-9]{40}', commit): raise ValueError('An exact full source commit is required')
    row = settings['testbenches'].get(testbench)
    if not isinstance(row, dict) or not all(isinstance(row.get(k), str) and row[k] for k in ('project_id', 'configuration')):
        raise ValueError('Selected testbench has no operator-installed runnable binding')
    identity = {'project_id': row['project_id'], 'configuration': row['configuration'], 'source_commit': commit}
    report = {'schema': 'circuitgit.spectre-ci-request.v1', 'testbench_id': testbench, 'source_commit': commit,
              'operation': operation, 'simulation_started': False, 'status': 'blocked', 'automatic_approval': False}
    if operation in ('collect', 'results'):
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,180}', run_id or ''): raise ValueError('Existing explicit run_id required')
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
        arguments = {**arguments, 'idempotency_key': 'github-ci-' + hashlib.sha256(json.dumps([invocation, testbench, commit, operation, run_id]).encode()).hexdigest()}
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
