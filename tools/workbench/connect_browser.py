#!/usr/bin/env python3
"""Start the local browser companion with its own gateway; no typed address or code."""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import webbrowser

from platform_compat import install_sigterm_handler, lock_file, unlock_file

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/codex'))
from icwb.host import AiRoutes
from icwb.service import Service
from remote_node import Server, Handler, Node, GatewayOnboarding, node_config, node_identity
from browser_login import LocalLogin
from browser_development import LocalDevelopment
from browser_library import LocalLibrary
from library_workflow import LibraryWorkflow

PUBLIC_URL = 'https://circuitgit-dev.github.io/CircuitGit/'


def library_configuration(root, state):
    """Bind browser and agent library operations to the same installed checkout."""
    if not (root / '.git').exists(): return {}
    result = subprocess.run(['git','-C',str(root),'remote','get-url','origin'], capture_output=True, text=True, timeout=10)
    remote = result.stdout.strip() if result.returncode == 0 else ''
    match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?', remote)
    if not match: return {}
    return {'library_workspace':str(root), 'library_repository':match.group(1), 'library_access':'direct',
            'library_state_dir':str(state / 'library'), 'library_base_branch':'main',
            'library_testbench_registry':str(root / 'config/library-testbenches.json')}


def library_runtime_configuration(cfg, root, state):
    """Read configured Git library snapshots; retain custom runtime settings."""
    binding = library_configuration(root, state)
    if not binding or cfg.get('github_repo') != binding['library_repository']:
        return cfg
    if Path(cfg.get('seed_repo', '')).expanduser().resolve() != root.resolve():
        return cfg
    value = dict(cfg)
    value.setdefault('source_repository', str(root))
    installed = json.loads((root / 'config/workbench.projects.json').read_text())
    projects = list(cfg.get('projects', [])); seen = {p['id'] for p in projects}
    workspace_dir = Path(cfg['runtime_root']).expanduser().resolve() / 'workspace' if cfg.get('runtime_root') else None
    has_existing_workspace = workspace_dir is not None and workspace_dir.is_dir()
    for p in installed:
        if p['id'] in seen:
            continue
        source_path = p.get('source_path')
        if has_existing_workspace and isinstance(source_path, str) and not (workspace_dir / source_path).is_file():
            continue
        projects.append(p)
    value['projects'] = projects
    return value


def configuration(state):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = state / 'workbench.local.json'
    if config.exists():
        return json.loads(config.read_text())
    if not shutil.which('git'):
        raise RuntimeError('需要 Git。请先安装 Git 后重新打开连接助手。')
    seed = ROOT
    if not (ROOT / '.git').exists():
        # GitHub ZIP downloads have no repository metadata. Initialize only the
        # bundled public example in private helper state, never the extracted app.
        seed = state / 'example-seed'
        if not seed.exists():
            seed.mkdir()
            shutil.copytree(ROOT / 'projects', seed / 'projects')
        if not (seed / '.git').exists():
            subprocess.run(['git', 'init', '--initial-branch=main', str(seed)], check=True, stdout=subprocess.DEVNULL)
        has_commit = subprocess.run(['git', '-C', str(seed), 'rev-parse', '--verify', 'HEAD'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if not has_commit:
            subprocess.run(['git', '-C', str(seed), 'add', 'projects'], check=True)
            subprocess.run(['git', '-C', str(seed), '-c', 'user.name=CircuitGit', '-c', 'user.email=local@example.invalid', 'commit', '-m', 'Initialize bundled public RC example'], check=True, stdout=subprocess.DEVNULL)
    site = state / 'site.local.json'
    if not site.exists():
        from local_sim import detect_local_simulator, validate_local_site
        local_engine = local_bin = None
        for candidate in ('ngspice', 'xyce'):
            found = detect_local_simulator(candidate)
            if found:
                local_engine, local_bin = candidate, found
                break
        if local_engine and local_bin:
            local_site = validate_local_site({
                'schema': 'ic.sim.local-site.v1',
                'transport': 'local',
                'engine': local_engine,
                'simulator_bin': local_bin,
                'runs_root': str(state / 'engineering/ic_on_github_runs'),
                'open_pdk': {'pdk': 'builtin', 'corner': 'typical'},
                'external_files': {},
            })
            fd_s = os.open(site, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd_s, 'w') as sf:
                json.dump(local_site, sf, indent=2)
                sf.write('\n')
        else:
            shutil.copyfile(ROOT / 'config/site.example.json', site)
    value = json.loads((ROOT / 'config/workbench.example.json').read_text())
    value.update(seed_repo=str(seed), runtime_root=str(state / 'engineering'), runs_root=str(state / 'engineering/runs'),
                 site_file=str(site), projects=[p for p in json.loads((ROOT / 'config/workbench.projects.json').read_text())
                                               if (seed / p['source_path']).is_file()], gh_bin=shutil.which('gh') or 'gh')
    fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(value, file, indent=2)
    return value


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--state-dir', type=Path, default=ROOT / '.local/browser-helper')
    p.add_argument('--gateway-url', help='Optional existing loopback engineering gateway')
    p.add_argument('--no-browser', action='store_true')
    p.add_argument('--from-uri', action='store_true', help='Launched by circuitgit:// wakeup; exit 0 quietly if already running')
    p.add_argument('--allow-origin', action='append', default=[])
    mode=p.add_mutually_exclusive_group()
    mode.add_argument('--fresh-onboarding',action='store_true',help='Start simulation onboarding in an explicitly empty state directory')
    mode.add_argument('--resume-onboarding',action='store_true',help='Resume only the explicitly selected onboarding store')
    p.add_argument('--port',type=int,default=8767,help='Browser companion loopback port')
    p.add_argument('--gateway-port',type=int,default=0,help='Fresh onboarding gateway loopback port')
    args = p.parse_args()
    if args.fresh_onboarding or args.resume_onboarding:
        if args.gateway_url:p.error('Onboarding creates an isolated gateway; it cannot reuse --gateway-url')
        from onboarding_server import serve_onboarding
        return serve_onboarding(args.state_dir,root=ROOT,node_port=args.port,gateway_port=args.gateway_port,
            allow_origins=args.allow_origin,resume=args.resume_onboarding,no_browser=args.no_browser)
    state = args.state_dir.expanduser().resolve();state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'helper.lock').open('a+b') as lock:
        try:lock_file(lock, nonblocking=True)
        except BlockingIOError:
            if args.from_uri:
                return 0
            raise RuntimeError('连接助手已经运行，请回到网页点击“连接本机”。')
        # Reserve the known pairing port first. Never replace another process.
        try:browser = Server(('127.0.0.1', args.port), Handler)
        except OSError:
            if args.from_uri:
                return 0
            raise RuntimeError('本机连接端口已被占用。请检查已有连接助手，未停止任何现有程序。')
        gateway = routes = node = remote_lock = app = None
        gateway_started = False
        thread = None
        cfg = None
        try:
            gateway_url = args.gateway_url
            if not gateway_url:
                cfg = library_runtime_configuration(configuration(state), ROOT, state)
                import server as engineering
                cfg = engineering.default_onboarding_configuration(cfg)
                app = engineering.Application(cfg, ROOT / 'apps/web')
                gateway = engineering.Server(('127.0.0.1', 0), engineering.Handler);gateway.app = app
                thread = threading.Thread(target=gateway.serve_forever, daemon=True);thread.start();gateway_started = True
                if getattr(app, 'simulation', None) is not None:
                    app.simulation.resume()
                gateway_url = 'http://127.0.0.1:' + str(gateway.server_port)
            config = node_config(gateway_url=gateway_url, state_dir=state / 'ai')
            config.update(library_configuration(ROOT, state))
            if app is not None and getattr(app.onboarding, 'review_authority_key_file', None):
                config['onboarding_review_authority_key_file'] = str(app.onboarding.review_authority_key_file)
            if cfg and cfg.get('simulation_direct'):
                config['simulation_direct'] = dict(cfg['simulation_direct'])
            token, identity, _ = node_identity(Path(config['state_dir']))
            remote_lock = (Path(config['state_dir']) / 'remote-node.lock').open('a+b')
            try:lock_file(remote_lock, nonblocking=True)
            except BlockingIOError:raise RuntimeError('已有服务使用此 AI 会话目录，未启动重复实例。')
            routes = AiRoutes(Service(config))
            node = Node(routes, token, ['https://circuitgit-dev.github.io', *args.allow_origin], identity, 'http://127.0.0.1:'+str(browser.server_port), '本机 Codex')
            if gateway:
                node.onboarding = gateway.app.onboarding
            else:
                node.onboarding = GatewayOnboarding(routes.service.gateway)
            node.onboarding_review_base = gateway_url
            node.login = LocalLogin(config)
            if config.get('simulation_direct', {}).get('enabled') and callable(getattr(routes.service, 'execute_simulation', None)):
                node.simulation = routes.service.execute_simulation
            node.development = LocalDevelopment(state / 'owner-settings', routes, node.pairing, node.url, workspace_hint=ROOT)
            # A Git checkout is required for branch/history operations. ZIP users
            # retain chat and the isolated RC runtime without a fabricated origin.
            if config.get('library_workspace'):
                registry_path = ROOT / 'config/library-testbenches.json'
                registry = json.loads(registry_path.read_text()) if registry_path.is_file() else {'testbenches': []}
                node.library = LocalLibrary(LibraryWorkflow(ROOT, repository=config['library_repository'], state_dir=state / 'library', ci_registry=registry), node.pairing, node.url)
            browser.node = node
            if args.state_dir == (ROOT / '.local/browser-helper') and not args.from_uri:
                from connector_install import ensure_protocol_registered
                ensure_protocol_registered(ROOT)
            print('CircuitGit 本机连接器已启动（已注册 circuitgit:// 网页一键唤醒）。请保持运行，后续可直接在网页端点击连接。', flush=True)
            print('不会自动登录、发送模型消息或运行仿真。关闭此窗口可停止连接器。', flush=True)
            if not args.no_browser:webbrowser.open(PUBLIC_URL)
            def stop(signum, frame):raise KeyboardInterrupt
            install_sigterm_handler(stop, signal_module=signal)
            try:browser.serve_forever()
            except KeyboardInterrupt:pass
        finally:
            browser.server_close()
            if node and node.login:node.login.close()
            if routes:routes.close()
            if gateway:
                if gateway_started:
                    gateway.shutdown();thread.join(timeout=5)
                gateway.server_close()
            if app:
                app.onboarding.close()
                if getattr(app, 'simulation', None) is not None:
                    app.simulation.close()
                app.pool.shutdown(wait=False)
            if remote_lock:
                unlock_file(remote_lock)
                remote_lock.close()
            unlock_file(lock)


if __name__ == '__main__':
    try:
        if any(flag in sys.argv[1:] for flag in ('--help','-h')):main()
        else:
            from bootstrap_python import run_entrypoint
            raise SystemExit(run_entrypoint(__file__,main))
    except Exception as error:
        print('连接助手未启动：' + str(error), file=sys.stderr)
        sys.exit(1)
