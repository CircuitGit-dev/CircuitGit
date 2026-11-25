"""Bounded runtime discovery and account metadata; never starts a model or handles credentials."""
import math
import os
from pathlib import Path
import re
import shutil
import subprocess

from .rpc import Rpc
from .service import Failure, check


def _text(value, maximum=240):
    check(isinstance(value, str) and 0 < len(value) <= maximum
          and not any(ord(c) < 32 for c in value)
          and not re.search(r'(?i)\b(?:bearer\s|sk-[a-z0-9_-]{12,}|access_token[=:]|api_key[=:])', value),
          'Invalid metadata text', 'invalid_metadata', 4)
    return value


def _optional_text(value, maximum=240):
    return None if value is None else _text(value, maximum)


def metadata_error(error, method):
    """Return classification and method/code only, never an upstream message or payload."""
    details = {'method': method}
    code, exit_code = 'metadata_check_failed', 4
    if isinstance(error, Failure):
        if re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', str(error.code)):
            code = error.code
        exit_code = error.exit_code if type(error.exit_code) is int else 4
        raw = error.details if isinstance(error.details, dict) else {}
        if type(raw.get('rpc_code')) is int:
            details['rpc_code'] = raw['rpc_code']
        if isinstance(raw.get('method'), str) and re.fullmatch(r'[a-zA-Z0-9_./-]{1,100}', raw['method']):
            details['method'] = raw['method']
    return {'code': code, 'message': 'Codex metadata check failed; no automatic retry.',
            'exit_code': exit_code, 'details': details}


def discover_runtime(config, *, search_path=None, app_roots=None):
    """Return public metadata plus a private executable. Stat/PATH lookup only; no subprocess."""
    is_win = os.name == 'nt'
    if app_roots is not None:
        roots = [Path(p) for p in app_roots]
    elif is_win:
        local_app = os.environ.get('LOCALAPPDATA')
        app_data = os.environ.get('APPDATA')
        roots = [p for p in (
            Path(local_app) / 'Programs' / 'Codex' if local_app else None,
            Path(local_app) / 'Codex' if local_app else None,
            Path(app_data) / 'npm' if app_data else None,
        ) if p is not None]
    else:
        roots = [
            Path('/Applications/Codex.app'), Path.home() / 'Applications/Codex.app',
            Path('/Applications/ChatGPT.app'), Path.home() / 'Applications/ChatGPT.app',
        ]
    # Ignore relative PATH entries, including the empty entry denoting the project cwd.
    env_path = os.environ.get('PATH', '') if search_path is None else search_path
    path = os.pathsep.join(p for p in env_path.split(os.pathsep) if p and Path(p).is_absolute())

    def executable(candidate):
        try:
            p = Path(candidate).resolve(strict=True)
            if not p.is_file():
                return None
            if is_win:
                return str(p)
            return str(p) if os.access(p, os.X_OK) else None
        except (OSError, RuntimeError, TypeError, ValueError):
            return None

    def which_codex(name='codex'):
        if not path:
            return None
        if is_win and name == 'codex':
            for candidate_name in ('codex.exe', 'codex.cmd', 'codex'):
                hit = shutil.which(candidate_name, path=path)
                if hit:
                    return hit
            # shutil.which on Windows skips extensionless files; check absolute PATH entries directly.
            for directory in path.split(os.pathsep):
                direct = Path(directory) / name
                if direct.is_file():
                    return str(direct)
            return None
        return shutil.which(name, path=path)

    selected, source, reason = None, 'none', 'executable_not_found'
    if 'codex_bin' in config:
        value = config['codex_bin']; source = 'configured'
        if (not isinstance(value, str) or not value or len(value) > 4096
                or any(ord(c) < 32 for c in value)
                or not (Path(value).is_absolute() or value == 'codex')):
            reason = 'invalid_executable_configuration'
        else:
            if value == 'codex':
                found = which_codex(value)
                selected = executable(found) if found else None
            else:
                selected = executable(value)
            reason = None if selected else 'configured_executable_unavailable'
    else:
        found = which_codex('codex')
        selected = executable(found) if found else None
        if selected:
            source, reason = 'path', None
        else:
            entries = (
                ('codex.exe', 'resources/codex.exe', 'codex.cmd',
                 'Contents/Resources/codex', 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
                if is_win
                else ('Contents/Resources/codex', 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
            )
            for root in roots:
                for entry in entries:
                    selected = executable(root / entry)
                    if selected:
                        break
                if selected:
                    source, reason = 'official_app', None
                    break
    try:
        installed = True if any(root.is_dir() for root in roots) else 'unknown'
    except OSError:
        installed = 'unknown'
    return {'schema': 'ic.ai.discovery.v1',
            'codex': {'executable_found': selected is not None, 'source': source, 'reason': reason,
                      'transport': 'app-server', 'tool_protocol': 'mcp'},
            'desktop': {'installed': installed, 'running': 'unknown', 'reason': 'desktop_process_not_queried'},
            'other_agents': {'status': 'unsupported', 'reason': 'no_account_protocol_adapter'},
            'side_effects': {'process_started': False, 'model_started': False, 'account_queried': False},
            'automatic_retry': False}, selected


class MetadataRpc(Rpc):
    """Clean up only our own child if its initialization fails; never touch a desktop process."""
    def __init__(self, *args, **kwargs):
        try:
            super().__init__(*args, **kwargs)
        except Exception:
            self.closed = True
            process = getattr(self, 'process', None)
            if process is not None:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=5)
                reader = getattr(self, 'reader', None)
                if reader is not None:
                    reader.join(timeout=1)
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        stream.close()
            raise


def empty_connection(session_id, completed=0):
    return {'schema': 'ic.ai.connection.v1', 'session_id': session_id, 'status': 'unavailable',
            'transport': 'app-server', 'tool_protocol': 'mcp',
            'runtime': {'source': 'none', 'reused_rpc': False, 'process_started': False},
            'account': {'status': 'unknown', 'account_type': 'unknown', 'login_status': 'unknown',
                        'plan_type': 'unknown', 'requires_openai_auth': None, 'reason': 'not_queried'},
            'usage': {'status': 'unknown', 'kind': 'rate_limits', 'source': 'account/rateLimits/read',
                      'reason': 'not_queried', 'buckets': []},
            'catalog': {'status': 'unknown', 'provider': None, 'default_model': None, 'models': [],
                        'inference_verified': False, 'reason': 'not_queried'},
            'policy': {'status': 'unknown', 'approval_policy': None, 'approvals_reviewer': None,
                       'reason': 'not_queried'},
            'chat': {'status': 'unknown', 'reason': 'metadata_check_failed', 'manual_guard_required': True},
            'inference': {'checked': False, 'historical_completed_turns': completed},
            'errors': [], 'automatic_retry': False}


def project_account(reply):
    check(isinstance(reply, dict) and 'account' in reply, 'Invalid account reply', 'invalid_metadata', 4)
    account = reply['account']; requires = reply.get('requiresOpenaiAuth')
    check(requires is None or type(requires) is bool, 'Invalid auth requirement', 'invalid_metadata', 4)
    result = {'status': 'unknown', 'account_type': 'unknown', 'login_status': 'unknown',
              'plan_type': 'unknown', 'requires_openai_auth': requires, 'reason': 'account_not_reported'}
    if account is None:
        if requires is True:
            result.update(login_status='signed_out', reason='sign_in_required')
        return result
    check(isinstance(account, dict), 'Invalid account object', 'invalid_metadata', 4)
    kind = account.get('type')
    if kind not in ('chatgpt', 'chatgptAuthTokens', 'apiKey', 'amazonBedrock', 'agentIdentity', 'personalAccessToken'):
        result['reason'] = 'unknown_account_type'
        return result
    result.update(status='known', account_type=kind, reason=None)
    # External credential chains are selected, not necessarily authenticated.
    if kind in ('chatgpt', 'chatgptAuthTokens', 'apiKey'):
        result['login_status'] = 'signed_in'
    if kind in ('chatgpt', 'chatgptAuthTokens') and account.get('planType') is not None:
        result['plan_type'] = _text(account['planType'], 64)
    return result


def project_policy(config):
    policy, reviewer = config.get('approval_policy'), config.get('approvals_reviewer')
    # Arbitrary policy objects are not a public config escape hatch.
    public_policy = _optional_text(policy, 64) if isinstance(policy, str) else None
    public_reviewer = _optional_text(reviewer, 64)
    blocked = reviewer is not None and reviewer != 'user' or policy == 'never'
    known_manual = reviewer == 'user' and policy in ('untrusted', 'on-failure', 'on-request')
    return {'status': 'blocked' if blocked else 'manual' if known_manual else 'unknown',
            'approval_policy': public_policy, 'approvals_reviewer': public_reviewer,
            'reason': 'manual_approval_required' if blocked else None if known_manual else 'policy_not_reported'}


def read_model_catalog(rpc):
    result, seen, cursors, cursor = [], set(), set(), None
    for _ in range(5):
        params = {'limit': 100, 'includeHidden': False}
        if cursor is not None:
            params['cursor'] = cursor
        page = rpc.call('model/list', params)
        check(isinstance(page, dict) and isinstance(page.get('data'), list) and len(page['data']) <= 100,
              'Invalid model page', 'invalid_metadata', 4)
        for item in page['data']:
            check(isinstance(item, dict), 'Invalid model item', 'invalid_metadata', 4)
            modalities = item.get('inputModalities', ['text', 'image'])
            check(isinstance(modalities, list) and len(modalities) <= 8, 'Invalid modalities', 'invalid_metadata', 4)
            modalities = [_text(v, 32) for v in modalities]
            if item.get('hidden') or 'text' not in modalities:
                continue
            row = {k: _text(item.get(k)) for k in ('id', 'model', 'displayName')}
            check(row['id'] not in seen, 'Duplicate model identity', 'invalid_metadata', 4)
            seen.add(row['id'])
            efforts = item.get('supportedReasoningEfforts', [])
            check(isinstance(efforts, list) and len(efforts) <= 16, 'Invalid efforts', 'invalid_metadata', 4)
            choices = []
            for effort in efforts:
                check(isinstance(effort, dict), 'Invalid effort', 'invalid_metadata', 4)
                choices.append({'reasoningEffort': _text(effort.get('reasoningEffort'), 32),
                                'description': _optional_text(effort.get('description'), 1024)})
            default = item.get('isDefault')
            check(default is None or type(default) is bool, 'Invalid model default', 'invalid_metadata', 4)
            row.update(description=_optional_text(item.get('description'), 2048), isDefault=default,
                       defaultReasoningEffort=_optional_text(item.get('defaultReasoningEffort'), 32),
                       supportedReasoningEfforts=choices, inputModalities=modalities)
            result.append(row)
        cursor = page.get('nextCursor')
        if cursor is None:
            return result
        cursor = _text(cursor, 2048)
        check(cursor not in cursors, 'Repeated model cursor', 'invalid_metadata', 4)
        cursors.add(cursor)
    raise Failure('model_catalog_unavailable', 'Model catalog exceeded bounded pagination', 4)


def project_usage(reply):
    check(isinstance(reply, dict), 'Invalid rate limit reply', 'invalid_metadata', 4)
    raw = reply.get('rateLimitsByLimitId')
    if raw is None:
        single = reply.get('rateLimits')
        raw = {} if single is None else {'': single}
    check(isinstance(raw, dict) and len(raw) <= 32, 'Invalid quota buckets', 'invalid_metadata', 4)

    def window(value):
        if value is None:
            return None
        check(isinstance(value, dict), 'Invalid quota window', 'invalid_metadata', 4)
        out = {}
        for source, target in (('usedPercent', 'used_percent'), ('windowDurationMins', 'window_duration_mins'), ('resetsAt', 'resets_at')):
            number = value.get(source)
            check(number is None or type(number) in (int, float) and math.isfinite(number) and number >= 0,
                  'Invalid quota measurement', 'invalid_metadata', 4)
            if source != 'usedPercent':
                check(number is None or type(number) is int, 'Invalid quota timestamp/window', 'invalid_metadata', 4)
            out[target] = number
        return out

    buckets = []
    for key, value in raw.items():
        check(isinstance(value, dict), 'Invalid quota bucket', 'invalid_metadata', 4)
        ident = value.get('limitId') or key or 'unknown'
        check(not key or ident == key, 'Mismatched quota bucket', 'invalid_metadata', 4)
        buckets.append({'limit_id': _text(ident, 128), 'plan_type': _text(value['planType'], 64) if value.get('planType') is not None else 'unknown',
                        'primary': window(value.get('primary')), 'secondary': window(value.get('secondary'))})
    available = any(w is not None and w['used_percent'] is not None for b in buckets for w in (b['primary'], b['secondary']))
    return {'status': 'available' if available else 'unknown', 'kind': 'rate_limits',
            'source': 'account/rateLimits/read', 'reason': None if available else 'quota_not_reported', 'buckets': buckets}


def probe_metadata(rpc, result):
    """Query only the four approved methods; optional failures stay partial and never retry."""
    halted = False

    def query(method, params, project):
        nonlocal halted
        if halted:
            return None, 'transport_unavailable'
        try:
            value = project(rpc.call(method, params))
            return value, None
        except Exception as error:
            record = metadata_error(error, method); result['errors'].append(record)
            halted = getattr(rpc, 'closed', False) or record['code'] in ('app_server_timeout', 'app_server_disconnected')
            return None, 'unsupported' if record['details'].get('rpc_code') == -32601 else 'query_failed'

    account, reason = query('account/read', {'refreshToken': False}, project_account)
    if account is not None:
        result['account'] = account
    else:
        result['account']['reason'] = reason

    def config_projection(reply):
        check(isinstance(reply, dict) and isinstance(reply.get('config'), dict), 'Invalid config reply', 'invalid_metadata', 4)
        cfg = reply['config']
        return {'provider': _optional_text(cfg.get('model_provider')), 'model': _optional_text(cfg.get('model')),
                'policy': project_policy(cfg)}

    config, reason = query('config/read', {'includeLayers': False}, config_projection)
    if config is not None:
        result['catalog'].update(provider=config['provider'], default_model=config['model'])
        result['policy'] = config['policy']
    else:
        result['policy']['reason'] = reason

    if result['account']['account_type'] in ('chatgpt', 'chatgptAuthTokens'):
        usage, reason = query('account/rateLimits/read', {}, project_usage)
        if usage is not None:
            result['usage'] = usage
        else:
            result['usage'].update(status='unsupported' if reason == 'unsupported' else 'unknown', reason=reason)
    else:
        result['usage'].update(status='not_applicable' if result['account']['status'] == 'known' else 'unknown',
                               reason='not_chatgpt_account' if result['account']['status'] == 'known' else 'account_unknown')

    if not halted:
        try:
            result['catalog'].update(status='available', models=read_model_catalog(rpc), reason=None)
        except Exception as error:
            record = metadata_error(error, 'model/list'); result['errors'].append(record)
            result['catalog'].update(status='unsupported' if record['details'].get('rpc_code') == -32601 else 'unknown', reason='query_failed')
    else:
        result['catalog']['reason'] = 'transport_unavailable'

    complete = (not result['errors'] and result['account']['status'] == 'known'
                and result['policy']['status'] != 'unknown' and result['catalog']['status'] == 'available'
                and result['usage']['status'] in ('available', 'not_applicable')
                and config is not None and config['provider'] is not None and config['model'] is not None)
    result['status'] = 'connected' if complete else 'partial'
    if result['policy']['status'] == 'blocked':
        result['chat'].update(status='blocked', reason='manual_approval_required')
    elif result['account']['login_status'] == 'signed_out':
        result['chat'].update(status='blocked', reason='sign_in_required')
    elif result['catalog']['status'] == 'available' and not result['catalog']['models']:
        result['chat'].update(status='blocked', reason='empty_model_catalog')
    elif (config is not None and config['provider'] is not None and config['model'] is not None
          and result['policy']['status'] == 'manual'
          and result['catalog']['status'] == 'available' and result['catalog']['models']
          and account is not None and account['status'] == 'known'):
        result['chat'].update(status='unverified', reason=None)
    elif not result['errors']:
        if result['account']['status'] == 'unknown':
            result['chat']['reason'] = result['account']['reason']
        elif result['policy']['status'] == 'unknown':
            result['chat']['reason'] = result['policy']['reason']
        elif config is not None:
            result['chat']['reason'] = 'provider_not_reported' if config['provider'] is None else 'model_not_reported'
    return result
