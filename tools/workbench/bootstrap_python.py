#!/usr/bin/env python3
"""Select an isolated Python with the repository-pinned SpiceOwl, then launch.

The bootstrap itself supports Python 3.8+. Application execution requires 3.11+.
No simulator, SSH, model, global pip installation or existing service is started
by --setup-only. Existing project environments are inspected, never upgraded.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[2]
MIN_PYTHON = (3, 11)
REQUIRED_MODULES = (
    'spiceowl.onboarding.pdk_discovery',
    'spiceowl.onboarding.environment',
    'spiceowl.onboarding.ssh_discovery',
    'spiceowl.experiments',
    'spiceowl.integrations.circuitgit_pool',
)
# Isolated introspection imports only the pinned package's ordinary modules.
# It never invokes any of their operations or looks at site/SSH configuration.
PROBE_CODE = r'''
import importlib, importlib.metadata, json, pathlib, sys
out = {'version': list(sys.version_info[:3]), 'prefix': sys.prefix,
       'base_prefix': sys.base_prefix, 'dependency': None}
if sys.version_info[:2] >= (3, 11) and sys.prefix != sys.base_prefix:
    try:
        dist = importlib.metadata.distribution('spiceowl')
        direct = json.loads(dist.read_text('direct_url.json') or '{}')
        modules = {}
        for name in json.loads(sys.argv[1]):
            module = importlib.import_module(name)
            modules[name] = str(pathlib.Path(module.__file__).resolve())
        out['dependency'] = {'direct_url': direct,
            'location': str(pathlib.Path(dist.locate_file('')).resolve()),
            'modules': modules}
    except Exception as error:
        out['dependency_error'] = type(error).__name__
print(json.dumps(out))
'''


class BootstrapError(RuntimeError):
    """A concrete setup failure; launching must stop."""


def within(path, root):
    path, root = Path(path).resolve(), Path(root).resolve()
    return path == root or root in path.parents


def read_pin(root):
    path = root / 'contracts/spiceowl-integration.lock.json'
    try:
        lock = json.loads(path.read_text(encoding='utf-8'))
        pin = lock['spiceowl']
        repository, commit = pin['repository'], pin['commit']
        if not isinstance(repository, str) or not isinstance(commit, str):
            raise ValueError('Invalid repository or commit')
        url = urlsplit(repository)
        valid = (lock.get('schema') == 'circuitgit.spiceowl-integration.v1'
                 and url.scheme == 'https' and bool(url.hostname)
                 and not url.username and not url.password and not url.query
                 and not url.fragment and url.path.endswith('.git')
                 and not re.search(r'\s', repository)
                 and isinstance(commit, str) and re.fullmatch('[a-f0-9]{40}', commit))
    except (OSError, ValueError, TypeError, KeyError):
        valid = False
    if not valid:
        raise BootstrapError('依赖锁定文件无效：需要 HTTPS repository 和完整 40 位 SpiceOwl commit。')
    return {'repository': repository, 'commit': commit}


def safe_environment():
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('PYTHON', 'PIP_'))
           and key not in ('VIRTUAL_ENV', '__PYVENV_LAUNCHER__')}
    # Do not apply another project's pip target/index/user-install settings.
    env.update(PIP_CONFIG_FILE=os.devnull, PIP_NO_INPUT='1',
               PIP_DISABLE_PIP_VERSION_CHECK='1', PYTHONDONTWRITEBYTECODE='1')
    return env


def probe(python, run):
    try:
        reply = run([str(python), '-I', '-B', '-c', PROBE_CODE,
                     json.dumps(REQUIRED_MODULES)], capture_output=True, text=True,
                    timeout=30, check=False, env=safe_environment())
        value = json.loads(reply.stdout) if reply.returncode == 0 else None
        if (isinstance(value, dict) and isinstance(value.get('version'), list)
                and len(value['version']) >= 2
                and all(type(part) is int for part in value['version'][:2])):
            return value
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None


def compatible(observation):
    return observation is not None and tuple(observation['version'][:2]) >= MIN_PYTHON


def pinned(observation, environment, pin):
    if not compatible(observation):
        return False
    try:
        prefix = Path(observation['prefix']).resolve()
        dependency = observation['dependency']
        direct = dependency['direct_url']
        vcs = direct['vcs_info']
        return (prefix == environment.resolve()
                and prefix != Path(observation['base_prefix']).resolve()
                and direct.get('url') == pin['repository']
                and vcs.get('vcs') == 'git' and vcs.get('commit_id') == pin['commit']
                and vcs.get('requested_revision') == pin['commit']
                and within(dependency['location'], prefix)
                and all(within(dependency['modules'][name], prefix)
                        for name in REQUIRED_MODULES))
    except (AttributeError, KeyError, TypeError, ValueError):
        return False


def interpreter_candidates(root):
    values = [root / '.venv/bin/python', Path(sys.executable)]
    names = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3']
    for name in names:
        found = shutil.which(name)
        if found:
            values.append(Path(found))
    # Finder may omit Homebrew's bin directory from PATH.
    for directory in ['/opt/homebrew/bin', '/usr/local/bin']:
        values.extend(Path(directory) / name for name in names)
    seen = set()
    for path in values:
        # Keep the venv's lexical executable path: resolving its symlink would
        # execute the global interpreter with a different sys.prefix.
        path = path.absolute()
        if str(path) not in seen and path.is_file():
            seen.add(str(path))
            yield path


def failure_detail(reply):
    message = (reply.stderr or reply.stdout or '').strip()[-1600:]
    return re.sub(r'(https?://)[^/\s@]+@', r'\1<redacted>@', message)


def checked(command, stage, run, root, timeout):
    try:
        reply = run([str(value) for value in command], cwd=str(root),
                    capture_output=True, text=True, timeout=timeout,
                    check=False, env=safe_environment())
    except subprocess.TimeoutExpired:
        raise BootstrapError(stage + '超时；未启动应用，请检查网络或安装环境后重试。') from None
    except OSError as error:
        raise BootstrapError(stage + '无法执行：' + str(error)) from None
    if reply.returncode != 0:
        raise BootstrapError(stage + '失败（退出码 ' + str(reply.returncode) + '）：\n'
                             + failure_detail(reply))


@contextmanager
def setup_lock(directory):
    import fcntl
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'bootstrap.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BootstrapError('另一个 CircuitGit 启动器正在初始化 Python，请等待该窗口完成。') from None
        yield


def ensure_python(root=ROOT, *, run=None, candidates=None, progress=None):
    root = Path(root).resolve()
    run = run or subprocess.run
    progress = progress or (lambda message: print('[CircuitGit] ' + message,
                                                file=sys.stderr, flush=True))
    pin = read_pin(root)
    digest = hashlib.sha256((pin['repository'] + '\n' + pin['commit']).encode()).hexdigest()[:16]
    cache = root / '.local/python'
    if not within(cache, root):
        raise BootstrapError('项目 .local/python 指向仓库以外；未修改外部环境。')
    with setup_lock(cache):
        existing = [root / '.venv'] + sorted(cache.glob('spiceowl-' + digest + '-py*'))
        observations = {}
        for environment in existing:
            python = environment / 'bin/python'
            if not within(environment, root) or not python.is_file():
                continue
            observation = observations[str(python)] = probe(python, run)
            if pinned(observation, environment, pin):
                return python
        base = None
        for candidate in candidates if candidates is not None else interpreter_candidates(root):
            candidate = Path(candidate).absolute()
            observation = observations.get(str(candidate)) or probe(candidate, run)
            if compatible(observation):
                base = candidate, observation
                break
        if base is None:
            raise BootstrapError('需要 Python 3.11+；当前可用解释器版本不足或无法运行。请安装 Python 3.11+ 后再次双击启动。')
        if not shutil.which('git'):
            raise BootstrapError('需要 Git 来安装锁定的 SpiceOwl commit，请安装 Git 后重试。')
        python_version = base[1]['version'][:2]
        environment = cache / ('spiceowl-' + digest + '-py' + '.'.join(map(str, python_version)))
        if environment.is_symlink() or not within(environment, cache):
            raise BootstrapError('项目 Python 环境指向其他位置；未修改该目录。')
        marker = environment / 'circuitgit-environment.json'
        ownership = {'schema': 'circuitgit.python-environment.v1', **pin,
                     'python_version': python_version}
        if environment.exists():
            try:
                owned = json.loads(marker.read_text(encoding='utf-8')) == ownership
            except (OSError, ValueError):
                owned = False
            if not owned:
                raise BootstrapError('环境目录已存在且不属于此依赖初始化：' + str(environment))
        else:
            environment.mkdir(mode=0o700)
            marker.write_text(json.dumps(ownership, indent=2) + '\n', encoding='utf-8')
        progress('创建项目 Python 环境（首次启动；不修改全局 Python）…')
        checked([base[0], '-I', '-B', '-m', 'venv', environment],
                '创建虚拟环境', run, root, 120)
        python = environment / 'bin/python'
        progress('安装锁定的 SpiceOwl ' + pin['commit'][:12] + '（首次需要网络）…')
        checked([python, '-I', '-B', '-m', 'pip', 'install', '--no-input',
                 '--disable-pip-version-check', '--no-cache-dir', '--force-reinstall',
                 'git+' + pin['repository'] + '@' + pin['commit']],
                '安装 SpiceOwl', run, root, 900)
        if not pinned(probe(python, run), environment, pin):
            raise BootstrapError('安装后校验失败：Python、SpiceOwl commit 或必需模块与锁定值不符；未启动应用。')
        progress('依赖已核验，后续启动会复用此环境。')
        return python


def run_entrypoint(entry, application_main, *, argv=None, root=ROOT):
    """Guard only normal __main__ startup; importing an application does no setup."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    entry = Path(entry).resolve()
    if any(flag in arguments for flag in ('--help', '-h')) or (
            entry.name == 'launch.py' and '--write-config-only' in arguments):
        return application_main()
    try:
        python = ensure_python(root)
    except (BootstrapError, OSError) as error:
        print('[CircuitGit] ' + str(error), file=sys.stderr, flush=True)
        return 1
    if (Path(sys.prefix).resolve() == python.parent.parent.resolve()
            and sys.flags.ignore_environment and sys.flags.no_user_site
            and dict(os.environ) == safe_environment()):
        # -E ignores overrides in this interpreter but leaves them in environ.
        # A later ordinary Python child must not inherit those stale overrides.
        return application_main()
    return subprocess.call([str(python), '-E', '-s', '-B', str(entry), *arguments],
                           cwd=str(root), env=safe_environment())


def main(argv=None, *, root=ROOT):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--setup-only', action='store_true')
    parser.add_argument('--entry', choices=['connect_browser', 'launch'], default='connect_browser')
    options, forwarded = parser.parse_known_args(argv)
    if options.setup_only and forwarded:
        parser.error('--setup-only does not accept application arguments')
    try:
        python = ensure_python(root)
    except (BootstrapError, OSError) as error:
        print('[CircuitGit] ' + str(error), file=sys.stderr, flush=True)
        return 1
    if options.setup_only:
        print(json.dumps({'status': 'ready', 'python': str(python),
                          'spiceowl_commit': read_pin(Path(root))['commit']}))
        return 0
    command = [str(python), '-E', '-s', '-B', str(Path(root) / 'tools/workbench' / (options.entry + '.py')), *forwarded]
    return subprocess.call(command, cwd=str(root), env=safe_environment())


if __name__ == '__main__':
    raise SystemExit(main())
