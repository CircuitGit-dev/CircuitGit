#!/usr/bin/env python3
"""Check the locally installed SpiceOwl contract pin; never fetch or run adapters."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys


ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = 'contracts/spiceowl-integration.lock.json'
ADAPTER_PATH = 'src/spiceowl/integrations/circuitgit_pool.py'
LOCK_SCHEMA = 'circuitgit.spiceowl-integration.v1'
CONTRACT_VERSION = '1.2.0'
RUNTIME_VERSIONS = {'1.0.0', '1.1.0'}
REPORT_VERSION = '1.0.0'
MAX_BYTES = 2 * 1024 * 1024


class ContractError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def require(condition, code, message):
    if not condition:
        raise ContractError(code, message)


def local_path(root, relative):
    require(isinstance(relative, str) and relative and '\\' not in relative,
            'invalid_path', 'Contract paths must be relative repository paths.')
    parts = relative.split('/')
    require(not PurePosixPath(relative).is_absolute() and not any(p in ('', '.', '..') for p in parts),
            'invalid_path', 'Contract paths must remain within their repository.')
    path = root.joinpath(*parts)
    require(not path.is_symlink() and path.resolve().is_relative_to(root),
            'invalid_path', 'Contract files must remain within their repository.')
    return path


def read_bytes(path, code):
    require(path.is_file(), code, 'Required local file is missing: ' + path.name)
    with path.open('rb') as stream:
        raw = stream.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, code, 'Local contract file exceeds the read limit.')
    return raw


def parse_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'invalid_json', 'Duplicate JSON fields are not allowed.')
            result[key] = value
        return result
    def constant(_):
        raise ContractError('invalid_json', 'Nonfinite JSON numbers are not allowed.')
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, json.JSONDecodeError):
        raise ContractError('invalid_json', 'The local contract or lock is not valid JSON.') from None
    require(isinstance(value, dict), 'invalid_json', 'The local contract or lock must be a JSON object.')
    return value


def git(root, *args):
    # Importing this checker never starts a subprocess or imports external code.
    import os
    import subprocess
    environment = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_NO_REPLACE_OBJECTS='1')
    try:
        result = subprocess.run(['git', '-C', str(root), *args], capture_output=True,
                                timeout=10, env=environment, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ContractError('git_unavailable', 'The local Git inspection could not complete.') from None
    require(result.returncode == 0, 'git_inspection_failed', 'The supplied SpiceOwl checkout could not be inspected locally.')
    return result.stdout


def embedded_report(report):
    """Rebase local report references when nesting it in the runtime schema."""
    def rebase(value):
        if isinstance(value, list):
            return [rebase(item) for item in value]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, item in value.items():
            if key == '$ref' and isinstance(item, str) and item.startswith('#/'):
                result[key] = '#/$defs/simulation_report' + item[1:]
            else:
                result[key] = rebase(item)
        return result
    return rebase({key: value for key, value in report.items() if key != '$id'})


def check_paired_schema(record, root, external, commit, versions, label):
    require(isinstance(record, dict) and set(record) == {'path', 'upstream_path', 'version', 'sha256'}
            and isinstance(record['version'], str) and record['version'] in versions
            and isinstance(record['sha256'], str) and re.fullmatch('[a-f0-9]{64}', record['sha256']),
            'invalid_lock', 'The ' + label + ' contract needs exact paths, version and SHA-256.')
    own = read_bytes(local_path(root, record['path']), 'contract_missing')
    other = read_bytes(local_path(external, record['upstream_path']), 'upstream_contract_missing')
    require(own == other, 'contract_drift', 'The ' + label + ' contracts differ byte for byte.')
    require(hashlib.sha256(own).hexdigest() == record['sha256'],
            'digest_mismatch', 'The ' + label + ' contract differs from the locked SHA-256.')
    schema = parse_json(own)
    require(schema.get('x-contract-version') == record['version'],
            'version_mismatch', 'The ' + label + ' schema version differs from its lock.')
    require(git(external, 'show', commit + ':' + record['upstream_path']) == other,
            'uncommitted_contract', 'The ' + label + ' contract is not the content saved at the locked commit.')
    return schema


def check(spiceowl_root, root=ROOT):
    root = Path(root).resolve()
    external = Path(spiceowl_root).resolve()
    lock = parse_json(read_bytes(local_path(root, LOCK_PATH), 'lock_missing'))
    fields = {'schema', 'spiceowl', 'contract', 'resource_selection_profile', 'related_pull_requests'}
    require(fields <= set(lock) and not set(lock) - fields - {'runtime_contract', 'simulation_report_contract'}
            and lock['schema'] == LOCK_SCHEMA, 'invalid_lock', 'Unsupported integration lock structure or schema.')
    upstream, contract = lock['spiceowl'], lock['contract']
    require(isinstance(upstream, dict) and set(upstream) == {'repository', 'commit', 'contract_path', 'contract_sha256'}
            and isinstance(contract, dict) and set(contract) == {'path', 'version'},
            'invalid_lock', 'The integration lock needs exact upstream and contract fields.')
    require(isinstance(upstream['repository'], str) and bool(upstream['repository'])
            and isinstance(upstream['commit'], str) and re.fullmatch('[a-f0-9]{40}', upstream['commit'])
            and isinstance(upstream['contract_sha256'], str) and re.fullmatch('[a-f0-9]{64}', upstream['contract_sha256']),
            'invalid_lock', 'The integration lock needs a repository, full commit, and SHA-256.')
    require(contract['version'] == CONTRACT_VERSION, 'version_mismatch', 'This checker requires locked contract version 1.2.0.')
    require(isinstance(lock['resource_selection_profile'], str) and bool(lock['resource_selection_profile'])
            and isinstance(lock['related_pull_requests'], list)
            and all(isinstance(value, str) and value for value in lock['related_pull_requests']),
            'invalid_lock', 'Invalid resource profile or related pull request metadata.')
    own_schema = local_path(root, contract['path'])
    upstream_schema = local_path(external, upstream['contract_path'])
    adapter = local_path(external, ADAPTER_PATH)
    require(external.is_dir(), 'checkout_missing', 'The supplied SpiceOwl checkout does not exist.')
    top = Path(git(external, 'rev-parse', '--show-toplevel').decode().strip()).resolve()
    require(top == external, 'checkout_root_mismatch', '--spiceowl-root must name the external Git repository root.')
    head = git(external, 'rev-parse', '--verify', 'HEAD').decode().strip()
    require(head == upstream['commit'], 'commit_mismatch', 'SpiceOwl HEAD differs from the locked commit.')
    own_bytes = read_bytes(own_schema, 'contract_missing')
    upstream_bytes = read_bytes(upstream_schema, 'upstream_contract_missing')
    require(own_bytes == upstream_bytes, 'contract_drift', 'The two supervision contracts differ byte for byte.')
    actual = hashlib.sha256(own_bytes).hexdigest()
    require(actual == upstream['contract_sha256'], 'digest_mismatch', 'The supervision contract differs from the locked SHA-256.')
    require(parse_json(own_bytes).get('x-contract-version') == contract['version'],
            'version_mismatch', 'The supervision schema version differs from the integration lock.')
    pinned_bytes = git(external, 'show', upstream['commit'] + ':' + upstream['contract_path'])
    require(pinned_bytes == upstream_bytes, 'uncommitted_contract', 'The external contract is not the content saved at the locked commit.')
    require(adapter.is_file(), 'adapter_missing', 'The local SpiceOwl CircuitGit resource adapter is missing.')
    git(external, 'cat-file', '-e', upstream['commit'] + ':' + ADAPTER_PATH)
    runtime = lock.get('runtime_contract')
    report = lock.get('simulation_report_contract')
    runtime_schema = None
    if runtime is not None:
        runtime_schema = check_paired_schema(runtime, root, external, upstream['commit'], RUNTIME_VERSIONS, 'runtime')
        require(runtime['version'] != '1.1.0' or report is not None,
                'invalid_lock', 'Runtime 1.1.0 requires an exact simulation report contract pin.')
    if report is not None:
        report_schema = check_paired_schema(report, root, external, upstream['commit'], {REPORT_VERSION}, 'simulation report')
        require(runtime_schema is not None and runtime['version'] == '1.1.0',
                'version_mismatch', 'The simulation report contract requires runtime version 1.1.0.')
        definitions = runtime_schema.get('$defs', {})
        require(isinstance(definitions, dict) and definitions.get('simulation_report') == embedded_report(report_schema),
                'embedded_report_drift', 'The runtime report definition differs from the pinned standalone report schema.')
        run = definitions.get('run', {})
        require(isinstance(run, dict) and isinstance(run.get('properties'), dict)
                and run['properties'].get('report') == {'$ref': '#/$defs/simulation_report'},
                'embedded_report_drift', 'Runtime runs must reference the pinned embedded report definition.')
    return {'status': 'passed', 'schema': LOCK_SCHEMA, 'spiceowl_commit': head,
            'contract_sha256': actual, 'contract_version': contract['version'],
            'runtime_contract_version': runtime['version'] if runtime else None,
            'simulation_report_contract_version': report['version'] if report else None,
            'simulation_report_contract_sha256': report['sha256'] if report else None,
            'resource_selection_profile': lock['resource_selection_profile'], 'adapter': ADAPTER_PATH}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spiceowl-root', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = check(args.spiceowl_root)
    except (ContractError, OSError, UnicodeError) as error:
        code = error.code if isinstance(error, ContractError) else 'local_read_failed'
        message = str(error) if isinstance(error, ContractError) else 'A local integration file could not be read.'
        print(json.dumps({'status': 'failed', 'code': code, 'message': message}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
