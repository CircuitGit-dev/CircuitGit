"""Bounded, read-only remote netlist discovery and import over explicit SSH targets.

Never runs arbitrary shell commands, never interpolates user paths into shell syntax,
never reads private keys/credentials/hidden dotfiles, and enforces strict byte/count caps.
"""
import base64
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import secrets
import subprocess

from platform_compat import find_ssh_binary

BROWSE_SCHEMA = 'ic.onboarding.ssh-browse.v1'
IMPORT_SCHEMA = 'ic.onboarding.ssh-import.v1'

MAX_BROWSE_ENTRIES = 200
MAX_FILE_BYTES = 1024 * 1024
MAX_TOTAL_IMPORT_BYTES = 1400 * 1024
MAX_SUPPORT_FILES = 48
MAX_INCLUDE_DEPTH = 4
SSH_TIMEOUT_SECONDS = 25
MAX_SSH_OUTPUT_BYTES = 1900 * 1024

ALLOWED_CIRCUIT_EXTS = frozenset({
    '.scs', '.sp', '.spi', '.spice', '.cir', '.ckt', '.net',
    '.inc', '.va', '.vams', '.v', '.rnl', '.txt', '.cdl', '.mdl',
})

_SSH_TARGET_RE = re.compile(r'^[A-Za-z0-9._@:%+\-\[\]]+$')
_SENSITIVE_EXACT = frozenset({
    '.ssh', '.gnupg', '.aws', '.kube', '.env', '.netrc', '.git-credentials',
    '.npmrc', '.pypirc', '.docker',
    'shadow', 'passwd', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
    'authorized_keys', 'known_hosts', 'credentials',
})
_SENSITIVE_PREFIXES = ('.env.',)
_SENSITIVE_SUFFIXES = ('.key', '.pem', '.p12', '.pfx', '.jks', '.kdbx', '.lic', '.ppk')
_SENSITIVE_SUBSTRINGS = ('id_rsa', 'id_ed25519', 'id_ecdsa', 'secret', 'password', 'passwd', 'token', 'credential', 'license')

_SSH_OPTIONS = (
    'BatchMode=yes',
    'ConnectTimeout=10',
    'NumberOfPasswordPrompts=0',
    'KbdInteractiveAuthentication=no',
    'PasswordAuthentication=no',
    'ForwardAgent=no',
    'ForwardX11=no',
    'ClearAllForwardings=yes',
    'RequestTTY=no',
    'ControlMaster=no',
    'ControlPath=none',
    'StdinNull=no',
)


def validate_ssh_target(target):
    """Validate an explicit SSH alias or user@host without options or whitespace."""
    if not isinstance(target, str) or not 1 <= len(target) <= 240:
        raise ValueError('Select an explicit SSH host alias or user@host')
    if target.startswith('-') or not _SSH_TARGET_RE.fullmatch(target):
        raise ValueError('SSH host target contains unsupported characters')
    return target


def is_sensitive_name(name):
    """Reject known credential/secret/key/license/dot-config filenames or directories."""
    if not isinstance(name, str) or not name:
        return True
    low = name.lower()
    if low in _SENSITIVE_EXACT:
        return True
    if any(low.startswith(pre) for pre in _SENSITIVE_PREFIXES):
        return True
    if any(low.endswith(ext) for ext in _SENSITIVE_SUFFIXES):
        return True
    if any(token in low for token in _SENSITIVE_SUBSTRINGS):
        return True
    return False


def is_sensitive_path(path):
    """Check whether any path component is a sensitive directory or file."""
    parts = [p for p in PurePosixPath(path).parts if p not in ('/', '', '~')]
    return any(is_sensitive_name(part) for part in parts)


def is_circuit_filename(name):
    if not isinstance(name, str) or not name or name.startswith('.') or is_sensitive_name(name):
        return False
    _, ext = posixpath.splitext(name.lower())
    return ext in ALLOWED_CIRCUIT_EXTS


def validate_remote_path(path, *, allow_empty=False, require_circuit_ext=False):
    """Validate an explicit POSIX remote path (absolute or ~/...)."""
    if path is None or path == '':
        if allow_empty:
            return ''
        raise ValueError('Provide an explicit remote POSIX path')
    if not isinstance(path, str) or not 1 <= len(path) <= 2048:
        raise ValueError('Remote path must be a non-empty string up to 2048 characters')
    if any(ord(c) < 32 or ord(c) == 127 for c in path):
        raise ValueError('Remote path contains invalid control characters')
    if not (path == '~' or path.startswith('~/') or path.startswith('/')):
        raise ValueError('Remote path must be absolute (/...) or start with ~/')
    parts = PurePosixPath(path).parts
    if '..' in parts:
        raise ValueError('Remote path cannot contain parent traversal segments (..)')
    if is_sensitive_path(path):
        raise ValueError('Remote path points to a hidden or sensitive location')
    if require_circuit_ext:
        base = posixpath.basename(path.rstrip('/'))
        if not is_circuit_filename(base):
            raise ValueError('Select a supported circuit/netlist file (.scs, .sp, .spice, .cir, .va, .rnl, .txt)')
    return path


_REMOTE_PY = r"""
from __future__ import print_function
import base64
import io
import json
import os
import posixpath
import re
import sys

PAYLOAD = json.loads(base64.b64decode('__PAYLOAD_B64__').decode('utf-8'))
ALLOWED_EXTS = set(PAYLOAD['allowed_exts'])
SENSITIVE_EXACT = set(PAYLOAD['sensitive_exact'])
SENSITIVE_SUFFIXES = tuple(PAYLOAD['sensitive_suffixes'])
SENSITIVE_SUBSTRINGS = tuple(PAYLOAD['sensitive_substrings'])
INCLUDE_RE = re.compile(
    r'^\s*(?:\.?include|ahdl_include|\.lib)\s+(?:"([^"]+)"|\'([^\']+)\'|([^\s;]+))',
    re.IGNORECASE,
)


def sensitive_name(name):
    if not name or name.startswith('.'):
        return True
    low = name.lower()
    if low in SENSITIVE_EXACT:
        return True
    for pre in ('.env.',):
        if low.startswith(pre):
            return True
    for suf in SENSITIVE_SUFFIXES:
        if low.endswith(suf):
            return True
    for sub in SENSITIVE_SUBSTRINGS:
        if sub in low:
            return True
    return False


def circuit_file(name):
    if sensitive_name(name):
        return False
    _, ext = posixpath.splitext(name.lower())
    return ext in ALLOWED_EXTS


def resolve_user_path(raw):
    if not raw or raw == '~':
        expanded = os.path.expanduser('~')
    elif raw.startswith('~/'):
        expanded = os.path.join(os.path.expanduser('~'), raw[2:])
    else:
        expanded = raw
    return os.path.realpath(expanded)


def read_utf8(file_path, max_bytes):
    st = os.stat(file_path)
    if st.st_size > max_bytes:
        raise ValueError('File exceeds size limit (%d bytes)' % st.st_size)
    with io.open(file_path, 'rb') as fh:
        raw = fh.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError('File exceeds size limit')
    if b'\x00' in raw:
        raise ValueError('Binary file is not supported')
    return raw.decode('utf-8')


def do_browse():
    target_dir = resolve_user_path(PAYLOAD.get('path') or '')
    if not os.path.isdir(target_dir):
        return {'error': 'Remote directory does not exist: ' + target_dir}
    try:
        names = os.listdir(target_dir)
    except OSError as exc:
        return {'error': 'Cannot list remote directory: ' + str(exc)}
    dirs = []
    files = []
    for name in names:
        if sensitive_name(name):
            continue
        full = os.path.join(target_dir, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        if os.path.isdir(full):
            dirs.append({'name': name, 'path': full, 'kind': 'dir', 'size': None})
        elif os.path.isfile(full) and circuit_file(name):
            files.append({'name': name, 'path': full, 'kind': 'file', 'size': int(st.st_size)})
    dirs.sort(key=lambda row: row['name'].lower())
    def file_rank(row):
        _, ext = posixpath.splitext(row['name'].lower())
        pri = 0 if ext == '.scs' else 1 if ext in ('.sp', '.spice', '.cir') else 2
        return (pri, row['name'].lower())
    files.sort(key=file_rank)
    combined = dirs + files
    limit = int(PAYLOAD['max_entries'])
    parent = os.path.dirname(target_dir) if target_dir != '/' else None
    if parent == target_dir:
        parent = None
    return {
        'ok': True,
        'cwd': target_dir,
        'parent': parent,
        'entries': combined[:limit],
        'total': len(combined),
        'truncated': len(combined) > limit,
    }


def collect_includes(text):
    refs = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('//') or stripped.startswith('*'):
            continue
        m = INCLUDE_RE.match(line)
        if not m:
            continue
        ref = m.group(1) or m.group(2) or m.group(3)
        if ref:
            refs.append(ref.strip())
    return refs


def do_import():
    entry = resolve_user_path(PAYLOAD['path'])
    if not os.path.isfile(entry):
        return {'error': 'Remote netlist file does not exist: ' + entry}
    file_name = os.path.basename(entry)
    if not circuit_file(file_name):
        return {'error': 'Unsupported or sensitive remote file: ' + file_name}
    max_file = int(PAYLOAD['max_file_bytes'])
    max_total = int(PAYLOAD['max_total_bytes'])
    max_support = int(PAYLOAD['max_support_files'])
    max_depth = int(PAYLOAD['max_depth'])
    try:
        entry_text = read_utf8(entry, max_file)
    except Exception as exc:
        return {'error': 'Cannot read remote netlist: ' + str(exc)}
    base_dir = os.path.dirname(entry)
    support = {}
    skipped = []
    total_bytes = len(entry_text.encode('utf-8'))
    if PAYLOAD.get('include_dependencies', True):
        queue = [(entry, entry_text, 0)]
        seen = set([entry])
        while queue:
            cur_path, cur_text, depth = queue.pop(0)
            if depth >= max_depth:
                continue
            cur_dir = os.path.dirname(cur_path)
            for ref in collect_includes(cur_text):
                if ref.startswith('/') or ref.startswith('~') or '$' in ref or '\\' in ref:
                    continue
                candidate = os.path.realpath(os.path.join(cur_dir, ref))
                if candidate in seen:
                    continue
                try:
                    rel = os.path.relpath(candidate, base_dir)
                except ValueError:
                    continue
                if rel.startswith('..') or os.path.isabs(rel):
                    skipped.append({'ref': ref, 'reason': 'outside_project_dir'})
                    continue
                rel_posix = rel.replace(os.sep, '/')
                if any(sensitive_name(part) for part in rel_posix.split('/')):
                    skipped.append({'ref': ref, 'reason': 'sensitive_path'})
                    continue
                if not os.path.isfile(candidate) or not circuit_file(os.path.basename(candidate)):
                    continue
                if len(support) >= max_support:
                    skipped.append({'ref': ref, 'reason': 'file_count_limit'})
                    continue
                try:
                    dep_text = read_utf8(candidate, max_file)
                except Exception:
                    skipped.append({'ref': ref, 'reason': 'unreadable_or_too_large'})
                    continue
                dep_bytes = len(dep_text.encode('utf-8'))
                if total_bytes + dep_bytes > max_total:
                    skipped.append({'ref': ref, 'reason': 'bundle_size_limit'})
                    continue
                seen.add(candidate)
                support[rel_posix] = dep_text
                total_bytes += dep_bytes
                queue.append((candidate, dep_text, depth + 1))
    return {
        'ok': True,
        'remote_path': entry,
        'remote_dir': base_dir,
        'file_name': file_name,
        'text': entry_text,
        'support_files': support,
        'skipped': skipped[:32],
    }


result = do_browse() if PAYLOAD['action'] == 'browse' else do_import()
print(json.dumps(result, ensure_ascii=False))
"""


def _build_ssh_argv(ssh_target, ssh_config):
    argv = [find_ssh_binary(), '-T']
    if isinstance(ssh_config, str) and ssh_config:
        cfg = Path(ssh_config)
        if cfg.is_file():
            argv.extend(['-F', str(cfg)])
    for option in _SSH_OPTIONS:
        argv.extend(['-o', option])
    argv.extend(['--', ssh_target, '/bin/sh -s'])
    return argv


def _build_remote_shell(payload):
    nonce = secrets.token_hex(16)
    begin = f'IC_SSH_IMPORT_{nonce}_BEGIN'
    end = f'IC_SSH_IMPORT_{nonce}_END'
    encoded = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode('utf-8')).decode('ascii')
    py_script = _REMOTE_PY.replace('__PAYLOAD_B64__', encoded)
    shell_script = (
        'set -eu\n'
        'PY="$(command -v python3 || command -v python || true)"\n'
        'if [ -z "$PY" ]; then echo "NO_REMOTE_PYTHON" >&2; exit 127; fi\n'
        f'printf "\\n%s\\n" \'{begin}\'\n'
        f'"$PY" - <<\'IC_SSH_IMPORT_PY\'\n{py_script}\nIC_SSH_IMPORT_PY\n'
        f'printf "%s\\n" \'{end}\'\n'
    )
    return shell_script, begin, end


def _run_remote(ssh_target, ssh_config, payload, *, runner=None, timeout=SSH_TIMEOUT_SECONDS):
    argv = _build_ssh_argv(ssh_target, ssh_config)
    shell_script, begin, end = _build_remote_shell(payload)
    exec_fn = runner or subprocess.run
    try:
        completed = exec_fn(
            argv,
            input=shell_script.encode('utf-8'),
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError(f'SSH connection to {ssh_target} timed out after {timeout}s') from exc
    except OSError as exc:
        raise ValueError(f'Failed to launch local SSH client: {exc}') from exc

    stdout = completed.stdout or b''
    stderr = (completed.stderr or b'').decode('utf-8', errors='replace').strip()
    if len(stdout) > MAX_SSH_OUTPUT_BYTES:
        raise ValueError('Remote SSH response exceeded bounded size limit')

    lines = stdout.splitlines()
    b_marker = begin.encode('ascii')
    e_marker = end.encode('ascii')
    if completed.returncode != 0 or lines.count(b_marker) != 1 or lines.count(e_marker) != 1:
        detail = stderr.splitlines()[-1] if stderr else f'exit code {completed.returncode}'
        if 'NO_REMOTE_PYTHON' in stderr:
            raise ValueError(f'Remote host {ssh_target} does not have python3/python available on PATH')
        raise ValueError(f'SSH browse/import on {ssh_target} failed: {detail[:260]}')
    start_idx = lines.index(b_marker)
    end_idx = lines.index(e_marker)
    if start_idx >= end_idx:
        raise ValueError('Malformed framed response from remote SSH host')
    body = b'\n'.join(lines[start_idx + 1:end_idx]).decode('utf-8')
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError('Remote SSH host returned invalid JSON') from exc
    if not isinstance(parsed, dict):
        raise ValueError('Remote SSH host returned unexpected payload')
    if not parsed.get('ok'):
        raise ValueError(str(parsed.get('error') or 'Remote SSH operation failed'))
    return parsed


def browse_remote_netlists(ssh_target, ssh_config, path=None, *, runner=None):
    """List directories and supported circuit files on an explicit SSH server.

    Delegates to the shared ``spiceowl.onboarding.ssh_import`` implementation when
    available so CircuitGit and SpiceOwl maintain one single SSH browse contract
    (``ic.onboarding.ssh-browse.v1``), falling back seamlessly to the local copy
    when running with an older SpiceOwl package.
    """
    if runner is None:
        try:
            from spiceowl.onboarding.ssh_import import browse_remote_netlists as _shared_browse
            return _shared_browse(ssh_target, ssh_config, path)
        except ImportError:
            pass
    target = validate_ssh_target(ssh_target)
    clean_path = validate_remote_path(path, allow_empty=True, require_circuit_ext=False)
    payload = {
        'action': 'browse',
        'path': clean_path,
        'max_entries': MAX_BROWSE_ENTRIES,
        'allowed_exts': sorted(ALLOWED_CIRCUIT_EXTS),
        'sensitive_exact': sorted(_SENSITIVE_EXACT),
        'sensitive_suffixes': list(_SENSITIVE_SUFFIXES),
        'sensitive_substrings': list(_SENSITIVE_SUBSTRINGS),
    }
    data = _run_remote(target, ssh_config, payload, runner=runner)
    entries = data.get('entries')
    if not isinstance(data.get('cwd'), str) or not isinstance(entries, list):
        raise ValueError('Incomplete remote directory listing')
    return {
        'schema': BROWSE_SCHEMA,
        'ssh_target': target,
        'cwd': data['cwd'],
        'parent': data.get('parent') if isinstance(data.get('parent'), str) else None,
        'entries': entries[:MAX_BROWSE_ENTRIES],
        'total': int(data.get('total', len(entries))),
        'truncated': bool(data.get('truncated', False)),
    }


def fetch_remote_netlist(ssh_target, ssh_config, path, *, include_dependencies=True, runner=None):
    """Fetch a remote netlist file (and optional relative include dependencies) over SSH.

    Delegates to the shared ``spiceowl.onboarding.ssh_import`` implementation when
    available (``ic.onboarding.ssh-import.v1``).
    """
    if runner is None:
        try:
            from spiceowl.onboarding.ssh_import import fetch_remote_netlist as _shared_fetch
            return _shared_fetch(ssh_target, ssh_config, path, include_dependencies=include_dependencies)
        except ImportError:
            pass
    target = validate_ssh_target(ssh_target)
    clean_path = validate_remote_path(path, allow_empty=False, require_circuit_ext=True)
    if not isinstance(include_dependencies, bool):
        raise ValueError('include_dependencies must be an explicit boolean')
    payload = {
        'action': 'import',
        'path': clean_path,
        'include_dependencies': include_dependencies,
        'max_file_bytes': MAX_FILE_BYTES,
        'max_total_bytes': MAX_TOTAL_IMPORT_BYTES,
        'max_support_files': MAX_SUPPORT_FILES,
        'max_depth': MAX_INCLUDE_DEPTH,
        'allowed_exts': sorted(ALLOWED_CIRCUIT_EXTS),
        'sensitive_exact': sorted(_SENSITIVE_EXACT),
        'sensitive_suffixes': list(_SENSITIVE_SUFFIXES),
        'sensitive_substrings': list(_SENSITIVE_SUBSTRINGS),
    }
    data = _run_remote(target, ssh_config, payload, runner=runner)
    file_name = data.get('file_name')
    text = data.get('text')
    support = data.get('support_files')
    if not isinstance(file_name, str) or not isinstance(text, str) or not isinstance(support, dict):
        raise ValueError('Incomplete remote netlist payload')
    if len(text.encode('utf-8')) > MAX_FILE_BYTES:
        raise ValueError('Remote netlist exceeds 1 MiB import limit')
    return {
        'schema': IMPORT_SCHEMA,
        'ssh_target': target,
        'remote_path': str(data.get('remote_path') or clean_path),
        'remote_dir': str(data.get('remote_dir') or posixpath.dirname(clean_path)),
        'file_name': file_name,
        'text': text,
        'support_files': {str(k): str(v) for k, v in support.items()},
        'skipped': list(data.get('skipped') or [])[:32],
    }
