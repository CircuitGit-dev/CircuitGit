#!/usr/bin/env python3
"""Select an isolated Python with the repository-pinned SpiceOwl, then launch.

The bootstrap itself supports Python 3.8+. Application execution requires 3.11+.
No simulator, SSH, model, global pip installation or existing service is started
by --setup-only. Existing project environments are inspected, never upgraded.
"""
import argparse
from contextlib import contextmanager
import hashlib
from itertools import chain
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

from upstream_sources import UPSTREAMS, UpstreamError, archive_source, spiceowl_source
from platform_compat import (
    IS_WINDOWS,
    chmod_private,
    find_venv_python,
    lock_file,
    unlock_file,
    venv_python_path,
)


ROOT = Path(__file__).resolve().parents[2]
MIN_PYTHON = (3, 11)
REQUIRED_MODULES = (
    'spiceowl.read_api',
    'spiceowl.onboarding.pdk_discovery',
    'spiceowl.onboarding.environment',
    'spiceowl.onboarding.ssh_discovery',
    'spiceowl.onboarding.agent_tb',
    'spiceowl.onboarding.pdk_lut',
    'spiceowl.onboarding.pdk_scope',
    'adctoolbox', 'numpy', 'scipy',
    'spiceowl.experiments',
    'spiceowl.integrations.circuitgit_pool',
)
# Isolated introspection imports only the pinned package's ordinary modules.
# It never invokes any of their operations or looks at site/SSH configuration.
PROBE_CODE = r'''
import base64, csv, hashlib, importlib, importlib.metadata, io, json, pathlib, sys
def record_evidence(dist):
    raw = dist.read_text('RECORD')
    if not raw or len(raw.encode()) > 8 * 1024 * 1024:
        raise ValueError('Missing bounded installation record')
    rows = list(csv.reader(io.StringIO(raw)))
    if not 1 <= len(rows) <= 20000:
        raise ValueError('Installation record is oversized')
    files = {}; seen = set(); total = 0; prefix = pathlib.Path(sys.prefix).resolve()
    for row in rows:
        if len(row) != 3 or row[0] in seen:
            raise ValueError('Invalid installation record')
        name, checksum, size = row
        seen.add(name)
        path = pathlib.Path(dist.locate_file(name))
        if path.is_symlink() or prefix not in path.resolve().parents or not path.is_file():
            raise ValueError('Installed file is outside this environment')
        if not checksum:
            if not (name.endswith('.dist-info/RECORD') or name.endswith('.pyc')):
                raise ValueError('Installed file has no digest')
            continue
        if not checksum.startswith('sha256=') or not size.isdigit():
            raise ValueError('Unsupported installation digest')
        total += int(size)
        if total > 512 * 1024 * 1024 or path.stat().st_size != int(size):
            raise ValueError('Installed file size differs')
        digest = hashlib.sha256(path.read_bytes()).digest()
        if base64.urlsafe_b64encode(digest).rstrip(b'=').decode() != checksum[7:]:
            raise ValueError('Installed file digest differs')
        files[name] = digest.hex()
    if not files:
        raise ValueError('Installation record has no verified files')
    return {'verified': True, 'record_sha256': hashlib.sha256(raw.encode()).hexdigest(),
            'files_sha256': hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'file_count': len(files)}
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
            'modules': modules, 'adctoolbox_version': importlib.metadata.version('adctoolbox')}
        if direct.get('url', '').startswith('file:'):
            out['dependency']['record'] = record_evidence(dist)
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
                 and repository == UPSTREAMS['spiceowl']['repository']
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


def probe(python, run, modules=REQUIRED_MODULES):
    try:
        reply = run([str(python), '-I', '-B', '-c', PROBE_CODE,
                     json.dumps(modules)], capture_output=True, text=True,
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


def pinned(observation, environment, pin, modules=REQUIRED_MODULES):
    if not compatible(observation):
        return False
    try:
        prefix = Path(observation['prefix']).resolve()
        dependency = observation['dependency']
        direct = dependency['direct_url']
        isolated = (prefix == environment.resolve()
                and prefix != Path(observation['base_prefix']).resolve()
                and dependency.get('adctoolbox_version') == '0.9.3'
                and within(dependency['location'], prefix)
                and all(within(dependency['modules'][name], prefix)
                        for name in modules))
        if not isolated:return False
        if direct.get('url', '').startswith('file:'):
            return local_install_pinned(dependency,environment,pin)
        vcs = direct['vcs_info']
        return (direct.get('url') == pin['repository']
                and not direct.get('dir_info')
                and vcs.get('vcs') == 'git' and vcs.get('commit_id') == pin['commit']
                and vcs.get('requested_revision') == pin['commit'])
    except (AttributeError, KeyError, TypeError, ValueError):
        return False


def archive_matches(direct,archive):
    info=direct.get('archive_info') or {}
    checksum=(info.get('hashes') or {}).get('sha256')
    if checksum is None and isinstance(info.get('hash'),str) and info['hash'].startswith('sha256='):
        checksum=info['hash'][7:]
    return (direct.get('url')==archive['url'] and checksum==archive['sha256']
            and 'dir_info' not in direct and 'vcs_info' not in direct
            and ('hash' not in info or info['hash']=='sha256='+archive['sha256']))


def local_install_pinned(dependency,environment,pin):
    """A file URL alone never identifies a trusted local source installation."""
    try:
        receipt=environment/'circuitgit-local-source.json';marker=environment/'circuitgit-environment.json'
        archive=environment/'source'/'spiceowl.tar'
        if any(path.is_symlink() or not path.is_file() for path in (receipt,marker,archive)):
            return False
        if archive.parent.is_symlink():return False
        saved=json.loads(receipt.read_text(encoding='utf-8'));owned=json.loads(marker.read_text(encoding='utf-8'))
        source=saved['archive']['source'];record=dependency['record']
        return (saved.get('schema')=='circuitgit.local-source-install.v1'
                and environment.parent.name=='python' and environment.parent.parent.name=='.local'
                and saved.get('environment')==str(environment.resolve())
                and owned.get('schema')=='circuitgit.python-environment.v1'
                and all(owned.get(key)==value and source.get(key)==value for key,value in pin.items())
                and source.get('name')=='spiceowl' and source.get('relative_path')==UPSTREAMS['spiceowl']['relative_path']
                and source.get('path')==str(environment.parents[2]/UPSTREAMS['spiceowl']['relative_path'])
                and source.get('gitlink_verified') is True and source.get('status')=='ready'
                and source.get('head_commit')==pin['commit'] and source.get('gitlink_commit')==pin['commit']
                and re.fullmatch('[a-f0-9]{40}',source.get('tree','')) is not None
                and saved['archive'].get('schema')=='circuitgit.upstream-archive.v1'
                and saved['archive']['url']==archive.resolve().as_uri()
                and saved['archive']['sha256']==hashlib.sha256(archive.read_bytes()).hexdigest()
                and archive_matches(dependency['direct_url'],saved['archive'])
                and record.get('verified') is True and record==saved['installed_record'])
    except (AttributeError,KeyError,TypeError,ValueError,OSError):return False


def save_local_install(environment,pin,archive,observation):
    dependency=(observation or {}).get('dependency') or {};record=dependency.get('record') or {}
    if (not archive_matches(dependency.get('direct_url') or {},archive) or record.get('verified') is not True
            or any(archive['source'].get(key)!=value for key,value in pin.items())):
        raise BootstrapError('本地源码安装缺少匹配的归档来源或文件校验记录；未启动应用。')
    receipt={'schema':'circuitgit.local-source-install.v1','environment':str(environment.resolve()),
        'archive':archive,'installed_record':record}
    path=environment/'circuitgit-local-source.json'
    if path.exists() or path.is_symlink():raise BootstrapError('本地安装回执已存在；不会覆盖。')
    path.write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');chmod_private(path,0o600)


def interpreter_candidates(root):
    values = [venv_python_path(root / '.venv'), Path(sys.executable)]
    if IS_WINDOWS:
        names = ['python3.14.exe', 'python3.13.exe', 'python3.12.exe', 'python3.11.exe', 'python3.exe', 'python.exe']
        for name in names:
            found = shutil.which(name)
            if found:
                values.append(Path(found))
        local_app = os.environ.get('LOCALAPPDATA')
        if local_app:
            for minor in ('314', '313', '312', '311'):
                values.append(Path(local_app) / 'Programs' / 'Python' / ('Python' + minor) / 'python.exe')
        for prog in (os.environ.get('ProgramFiles'), 'C:\\'):
            if prog:
                for minor in ('314', '313', '312', '311'):
                    values.append(Path(prog) / ('Python' + minor) / 'python.exe')
    else:
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
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'bootstrap.lock').open('a+b') as lock:
        try:
            lock_file(lock, nonblocking=True)
        except BlockingIOError:
            raise BootstrapError('另一个 CircuitGit 启动器正在初始化 Python，请等待该窗口完成。') from None
        try:
            yield
        finally:
            unlock_file(lock)


def ensure_python(root=ROOT, *, run=None, candidates=None, progress=None, extras=('adctools',)):
    root = Path(root).resolve()
    run = run or subprocess.run
    progress = progress or (lambda message: print('[CircuitGit] ' + message,
                                                file=sys.stderr, flush=True))
    pin = read_pin(root)
    if not isinstance(extras, (tuple, list)) or not extras or any(value not in ('adctools','mcp') for value in extras) or 'adctools' not in extras:
        raise BootstrapError('仅支持带 adctools 的固定依赖组合；开发环境可另外选择 mcp。')
    extras = tuple(sorted(set(extras)))
    modules = REQUIRED_MODULES + (('mcp',) if 'mcp' in extras else ())
    # Keep existing launcher environments reusable. The developer SDK extra
    # gets a distinct identity and can never upgrade another runtime in place.
    identity = pin['repository'] + '\n' + pin['commit']
    if extras != ('adctools',):identity += '\n' + ','.join(extras)
    digest = hashlib.sha256(identity.encode()).hexdigest()[:16]
    cache = root / '.local/python'
    if not within(cache, root):
        raise BootstrapError('项目 .local/python 指向仓库以外；未修改外部环境。')
    with setup_lock(cache):
        existing = [root / '.venv'] + sorted(cache.glob('spiceowl-' + digest + '-py*'))
        # A verified developer environment is also suitable for the launcher.
        # Check capabilities and the exact pin before reusing another cache;
        # never add extras to an existing environment in place.
        existing = list(dict.fromkeys(existing + sorted(cache.glob('spiceowl-*-py*'))))
        observations = {}
        for environment in existing:
            python = find_venv_python(environment)
            if not within(environment, root) or python is None:
                continue
            observation = observations[str(python)] = probe(python, run, modules)
            if pinned(observation, environment, pin, modules):
                return python
        base = None
        if candidates is None:
            # A previous pin may lack current modules but still provides a valid
            # interpreter for creating a separate environment. Never upgrade it.
            candidates = chain((Path(path) for path, observation in observations.items()
                                if compatible(observation)), interpreter_candidates(root))
        for candidate in candidates:
            candidate = Path(candidate).absolute()
            observation = observations.get(str(candidate)) or probe(candidate, run, modules)
            if compatible(observation):
                base = candidate, observation
                break
        if base is None:
            raise BootstrapError('需要 Python 3.11+；当前可用解释器版本不足或无法运行。请安装 Python 3.11+ 后再次双击启动。')
        if not shutil.which('git'):
            raise BootstrapError('需要 Git 来安装锁定的 SpiceOwl commit，请安装 Git 后重试。')
        try:local_source=spiceowl_source(root,pin,run=run)
        except UpstreamError as error:raise BootstrapError(str(error)) from error
        python_version = base[1]['version'][:2]
        name='spiceowl-' + digest + '-py' + '.'.join(map(str, python_version))
        environment=None
        # A failed or foreign environment is evidence, not a directory to repair
        # in place. Bound retries and preserve every prior installation attempt.
        for attempt in range(1,4):
            candidate=cache/(name+('-attempt'+str(attempt) if attempt>1 else ''))
            if candidate.is_symlink() or not within(candidate,cache):
                raise BootstrapError('项目 Python 环境指向其他位置；未修改该目录。')
            if not candidate.exists():environment=candidate;break
        if environment is None:
            raise BootstrapError('此依赖已有三个未通过校验的安装目录；请检查并保留已有环境，未原地重装。')
        marker = environment / 'circuitgit-environment.json'
        ownership = {'schema': 'circuitgit.python-environment.v1', **pin,
                     'python_version': python_version}
        if extras != ('adctools',):ownership['extras'] = list(extras)
        environment.mkdir(mode=0o700)
        marker.write_text(json.dumps(ownership, indent=2) + '\n', encoding='utf-8')
        progress('创建项目 Python 环境（首次启动；不修改全局 Python）…')
        checked([base[0], '-I', '-B', '-m', 'venv', environment],
                '创建虚拟环境', run, root, 120)
        python = find_venv_python(environment) or venv_python_path(environment)
        archive=None
        requirement='spiceowl[' + ','.join(extras) + '] @ git+' + pin['repository'] + '@' + pin['commit']
        if local_source is not None:
            source_dir=environment/'source';source_dir.mkdir(mode=0o700)
            try:archive=archive_source(root,local_source,source_dir/'spiceowl.tar',run=run)
            except UpstreamError as error:raise BootstrapError(str(error)) from error
            requirement='spiceowl['+','.join(extras)+'] @ '+archive['url']
            progress('从已核验的本地子模块安装 SpiceOwl '+pin['commit'][:12]+'…')
        else:progress('安装锁定的 SpiceOwl ' + pin['commit'][:12] + '（首次需要网络）…')
        checked([python, '-I', '-B', '-m', 'pip', 'install', '--no-input',
                 '--disable-pip-version-check', '--no-cache-dir',
                 'adctoolbox==0.9.3',
                 requirement],
                '安装 SpiceOwl', run, root, 900)
        installed=probe(python,run,modules)
        if archive is not None:save_local_install(environment,pin,archive,installed)
        if not pinned(installed, environment, pin, modules):
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
