#!/usr/bin/env python3
"""Cross-platform installer & URI handler for the CircuitGit local connector (`circuitgit://`).

Zero third-party dependencies, no admin/root privileges required:
- Windows: user-level HKCU\\Software\\Classes\\circuitgit registry key + optional HKCU Run entry
- macOS: ~/Applications/CircuitGit Connector.app URL handler + optional ~/Library/LaunchAgents plist
- Linux: ~/.local/share/applications/circuitgit-connector.desktop handler

Security boundary: `handle-uri` accepts only finite `circuitgit://start` or `circuitgit://connect`
actions and never passes untrusted URI arguments into shell commands or filesystem paths.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

from platform_compat import (
    IS_MACOS,
    IS_WINDOWS,
    detached_popen_kwargs,
)

ROOT = Path(__file__).resolve().parents[2]
SCHEME = 'circuitgit'
ALLOWED_ACTIONS = frozenset({'start', 'connect'})
MAC_APP_NAME = 'CircuitGit Connector.app'
MAC_BUNDLE_ID = 'dev.circuitgit.connector'
WIN_RUN_VALUE = 'CircuitGitConnector'


def parse_connector_uri(uri):
    """Validate and normalize a `circuitgit://` wakeup URI into a finite action."""
    if not isinstance(uri, str) or not uri or len(uri) > 512 or any(ord(c) < 32 for c in uri):
        raise ValueError('Invalid CircuitGit connector URI')
    parsed = urlsplit(uri.strip())
    if parsed.scheme.lower() != SCHEME:
        raise ValueError('Unsupported URI scheme')
    action = (parsed.netloc or parsed.path.lstrip('/')).lower().strip('/')
    if action not in ALLOWED_ACTIONS:
        raise ValueError('Unsupported CircuitGit connector action: ' + action)
    return action


def preferred_python(root=ROOT):
    """Choose the best Python 3.11+ interpreter (preferring pythonw.exe on Windows for silent wakeup)."""
    root = Path(root).resolve()
    candidates = []
    if IS_WINDOWS:
        exe = Path(sys.executable)
        pyw = exe.with_name('pythonw.exe')
        if pyw.is_file():
            candidates.append(pyw)
        candidates.append(exe)
        for name in ('pythonw.exe', 'python3.exe', 'python.exe'):
            found = shutil.which(name)
            if found:
                candidates.append(Path(found))
    else:
        candidates.append(Path(sys.executable))
        for name in ('python3.12', 'python3.11', 'python3'):
            found = shutil.which(name)
            if found:
                candidates.append(Path(found))
    for path in candidates:
        if path.is_file():
            return path.resolve()
    return Path(sys.executable).resolve()


def _windows_command_line(python_exe, script_path, extra_args):
    parts = [f'"{python_exe}"', '-E', '-s', '-B', f'"{script_path}"', *extra_args]
    return ' '.join(parts)


def _load_winreg(reg_module=None):
    if reg_module is not None:
        return reg_module
    import winreg
    return winreg


def install_windows(root=ROOT, *, autostart=False, reg_module=None):
    reg = _load_winreg(reg_module)
    root = Path(root).resolve()
    py = preferred_python(root)
    handler_script = root / 'tools' / 'workbench' / 'connector_install.py'
    bootstrap_script = root / 'tools' / 'workbench' / 'bootstrap_python.py'

    command = _windows_command_line(py, handler_script, ['handle-uri', '"%1"'])
    with reg.CreateKey(reg.HKEY_CURRENT_USER, rf'Software\Classes\{SCHEME}') as key:
        reg.SetValueEx(key, '', 0, reg.REG_SZ, 'URL:CircuitGit Connector')
        reg.SetValueEx(key, 'URL Protocol', 0, reg.REG_SZ, '')
    with reg.CreateKey(reg.HKEY_CURRENT_USER, rf'Software\Classes\{SCHEME}\shell\open\command') as key:
        reg.SetValueEx(key, '', 0, reg.REG_SZ, command)

    autostart_cmd = None
    if autostart:
        autostart_cmd = _windows_command_line(py, bootstrap_script, ['--entry', 'connect_browser', '--no-browser'])
        with reg.CreateKey(reg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
            reg.SetValueEx(key, WIN_RUN_VALUE, 0, reg.REG_SZ, autostart_cmd)

    return {'platform': 'windows', 'scheme': SCHEME, 'registered': True, 'command': command, 'autostart': bool(autostart_cmd)}


def uninstall_windows(*, reg_module=None):
    reg = _load_winreg(reg_module)
    for subkey in (
        rf'Software\Classes\{SCHEME}\shell\open\command',
        rf'Software\Classes\{SCHEME}\shell\open',
        rf'Software\Classes\{SCHEME}\shell',
        rf'Software\Classes\{SCHEME}',
    ):
        try:
            reg.DeleteKey(reg.HKEY_CURRENT_USER, subkey)
        except OSError:
            pass
    try:
        with reg.OpenKey(reg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run', 0, reg.KEY_SET_VALUE) as key:
            reg.DeleteValue(key, WIN_RUN_VALUE)
    except OSError:
        pass
    return {'platform': 'windows', 'scheme': SCHEME, 'registered': False, 'autostart': False}


def status_windows(*, reg_module=None):
    reg = _load_winreg(reg_module)
    registered = False
    command = None
    autostart = False
    try:
        with reg.OpenKey(reg.HKEY_CURRENT_USER, rf'Software\Classes\{SCHEME}\shell\open\command') as key:
            command, _ = reg.QueryValueEx(key, '')
            registered = bool(command)
    except OSError:
        pass
    try:
        with reg.OpenKey(reg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
            val, _ = reg.QueryValueEx(key, WIN_RUN_VALUE)
            autostart = bool(val)
    except OSError:
        pass
    return {'platform': 'windows', 'scheme': SCHEME, 'registered': registered, 'command': command, 'autostart': autostart}


def install_macos(root=ROOT, *, autostart=False, home=None, run=subprocess.run):
    root = Path(root).resolve()
    home = Path(home).resolve() if home is not None else Path.home().resolve()
    py = preferred_python(root)
    handler_script = root / 'tools' / 'workbench' / 'connector_install.py'
    bootstrap_script = root / 'tools' / 'workbench' / 'bootstrap_python.py'

    app_dir = home / 'Applications' / MAC_APP_NAME
    macos_dir = app_dir / 'Contents' / 'MacOS'
    macos_dir.mkdir(parents=True, exist_ok=True)
    plist_path = app_dir / 'Contents' / 'Info.plist'
    plist_data = {
        'CFBundleName': 'CircuitGit Connector',
        'CFBundleDisplayName': 'CircuitGit Connector',
        'CFBundleIdentifier': MAC_BUNDLE_ID,
        'CFBundleVersion': '1.0',
        'CFBundleShortVersionString': '1.0',
        'CFBundleExecutable': 'launcher',
        'CFBundlePackageType': 'APPL',
        'LSUIElement': True,
        'CFBundleURLTypes': [{
            'CFBundleURLName': MAC_BUNDLE_ID,
            'CFBundleURLSchemes': [SCHEME],
        }],
    }
    plist_path.write_bytes(plistlib.dumps(plist_data))

    launcher = macos_dir / 'launcher'
    launcher_body = (
        '#!/usr/bin/env bash\n'
        'set -euo pipefail\n'
        f'exec {shlex.quote(str(py))} -E -s -B {shlex.quote(str(handler_script))} handle-uri "${{1:-circuitgit://start}}"\n'
    )
    launcher.write_text(launcher_body, encoding='utf-8')
    launcher.chmod(0o755)

    lsregister = Path('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister')
    if lsregister.is_file():
        try:
            run([str(lsregister), '-f', str(app_dir)], capture_output=True, timeout=15, check=False)
        except (OSError, subprocess.SubprocessError):
            pass

    agent_path = home / 'Library' / 'LaunchAgents' / f'{MAC_BUNDLE_ID}.plist'
    if autostart:
        agent_path.parent.mkdir(parents=True, exist_ok=True)
        agent_data = {
            'Label': MAC_BUNDLE_ID,
            'ProgramArguments': [str(py), '-E', '-s', '-B', str(bootstrap_script), '--entry', 'connect_browser', '--no-browser'],
            'WorkingDirectory': str(root),
            'RunAtLoad': True,
            'KeepAlive': False,
        }
        agent_path.write_bytes(plistlib.dumps(agent_data))

    return {
        'platform': 'macos',
        'scheme': SCHEME,
        'registered': True,
        'app': str(app_dir),
        'autostart': agent_path.is_file(),
    }


def uninstall_macos(*, home=None):
    home = Path(home).resolve() if home is not None else Path.home().resolve()
    app_dir = home / 'Applications' / MAC_APP_NAME
    agent_path = home / 'Library' / 'LaunchAgents' / f'{MAC_BUNDLE_ID}.plist'
    if app_dir.exists() and not app_dir.is_symlink():
        shutil.rmtree(app_dir, ignore_errors=True)
    if agent_path.exists() and not agent_path.is_symlink():
        try:
            agent_path.unlink()
        except OSError:
            pass
    return {'platform': 'macos', 'scheme': SCHEME, 'registered': False, 'autostart': False}


def status_macos(*, home=None):
    home = Path(home).resolve() if home is not None else Path.home().resolve()
    app_dir = home / 'Applications' / MAC_APP_NAME
    agent_path = home / 'Library' / 'LaunchAgents' / f'{MAC_BUNDLE_ID}.plist'
    return {
        'platform': 'macos',
        'scheme': SCHEME,
        'registered': (app_dir / 'Contents' / 'Info.plist').is_file(),
        'app': str(app_dir),
        'autostart': agent_path.is_file(),
    }


def install_linux(root=ROOT, *, autostart=False, home=None, run=subprocess.run):
    root = Path(root).resolve()
    home = Path(home).resolve() if home is not None else Path.home().resolve()
    py = preferred_python(root)
    handler_script = root / 'tools' / 'workbench' / 'connector_install.py'
    bootstrap_script = root / 'tools' / 'workbench' / 'bootstrap_python.py'

    apps_dir = home / '.local' / 'share' / 'applications'
    apps_dir.mkdir(parents=True, exist_ok=True)
    desktop = apps_dir / 'circuitgit-connector.desktop'
    desktop.write_text(
        '[Desktop Entry]\n'
        'Type=Application\n'
        'Name=CircuitGit Connector\n'
        f'Exec={shlex.quote(str(py))} -E -s -B {shlex.quote(str(handler_script))} handle-uri %u\n'
        'Terminal=false\n'
        'NoDisplay=true\n'
        f'MimeType=x-scheme-handler/{SCHEME};\n',
        encoding='utf-8',
    )
    if shutil.which('xdg-mime'):
        try:
            run(['xdg-mime', 'default', 'circuitgit-connector.desktop', f'x-scheme-handler/{SCHEME}'],
                capture_output=True, timeout=10, check=False)
        except (OSError, subprocess.SubprocessError):
            pass
    autostart_file = home / '.config' / 'autostart' / 'circuitgit-connector.desktop'
    if autostart:
        autostart_file.parent.mkdir(parents=True, exist_ok=True)
        autostart_file.write_text(
            '[Desktop Entry]\n'
            'Type=Application\n'
            'Name=CircuitGit Connector\n'
            f'Exec={shlex.quote(str(py))} -E -s -B {shlex.quote(str(bootstrap_script))} --entry connect_browser --no-browser\n'
            'Terminal=false\n'
            'X-GNOME-Autostart-enabled=true\n',
            encoding='utf-8',
        )
    return {'platform': 'linux', 'scheme': SCHEME, 'registered': True, 'desktop': str(desktop), 'autostart': autostart_file.is_file()}


def uninstall_linux(*, home=None):
    home = Path(home).resolve() if home is not None else Path.home().resolve()
    for path in (
        home / '.local' / 'share' / 'applications' / 'circuitgit-connector.desktop',
        home / '.config' / 'autostart' / 'circuitgit-connector.desktop',
    ):
        if path.exists() and not path.is_symlink():
            try:
                path.unlink()
            except OSError:
                pass
    return {'platform': 'linux', 'scheme': SCHEME, 'registered': False, 'autostart': False}


def status_linux(*, home=None):
    home = Path(home).resolve() if home is not None else Path.home().resolve()
    desktop = home / '.local' / 'share' / 'applications' / 'circuitgit-connector.desktop'
    autostart_file = home / '.config' / 'autostart' / 'circuitgit-connector.desktop'
    return {'platform': 'linux', 'scheme': SCHEME, 'registered': desktop.is_file(), 'desktop': str(desktop), 'autostart': autostart_file.is_file()}


def install_protocol(root=ROOT, *, autostart=False):
    if IS_WINDOWS:
        return install_windows(root, autostart=autostart)
    if IS_MACOS:
        return install_macos(root, autostart=autostart)
    return install_linux(root, autostart=autostart)


def uninstall_protocol():
    if IS_WINDOWS:
        return uninstall_windows()
    if IS_MACOS:
        return uninstall_macos()
    return uninstall_linux()


def protocol_status():
    if IS_WINDOWS:
        return status_windows()
    if IS_MACOS:
        return status_macos()
    return status_linux()


def ensure_protocol_registered(root=ROOT):
    """Best-effort register `circuitgit://` on interactive launcher startup; never raises."""
    try:
        current = protocol_status()
        if not current.get('registered'):
            return install_protocol(root, autostart=False)
        return current
    except Exception:
        return {'registered': False}


def handle_uri(uri, *, root=ROOT, popen=subprocess.Popen):
    """Handle a `circuitgit://start` or `circuitgit://connect` wakeup by launching the connector."""
    action = parse_connector_uri(uri)
    root = Path(root).resolve()
    py = preferred_python(root)
    bootstrap = root / 'tools' / 'workbench' / 'bootstrap_python.py'
    log_dir = root / '.local' / 'browser-helper'
    log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    cmd = [str(py), '-E', '-s', '-B', str(bootstrap), '--entry', 'connect_browser', '--no-browser', '--from-uri']
    with (log_dir / 'connector-wakeup.log').open('ab') as log:
        proc = popen(
            cmd,
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            **detached_popen_kwargs(),
        )
    return {'action': action, 'pid': getattr(proc, 'pid', None), 'command': cmd}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Register or invoke the CircuitGit local connector URI protocol.')
    sub = parser.add_subparsers(dest='cmd', required=True)
    p_install = sub.add_parser('install', help='Register circuitgit:// protocol for one-click web wakeup')
    p_install.add_argument('--autostart', action='store_true', help='Also start the connector silently at OS login')
    sub.add_parser('uninstall', help='Unregister circuitgit:// protocol and remove autostart entry')
    sub.add_parser('status', help='Print current circuitgit:// registration status as JSON')
    p_uri = sub.add_parser('handle-uri', help='Internal handler invoked by the OS for circuitgit:// URIs')
    p_uri.add_argument('uri', help='circuitgit://start or circuitgit://connect')
    args = parser.parse_args(argv)
    if args.cmd == 'install':
        print(json.dumps(install_protocol(ROOT, autostart=args.autostart), ensure_ascii=False))
    elif args.cmd == 'uninstall':
        print(json.dumps(uninstall_protocol(), ensure_ascii=False))
    elif args.cmd == 'status':
        print(json.dumps(protocol_status(), ensure_ascii=False))
    elif args.cmd == 'handle-uri':
        print(json.dumps(handle_uri(args.uri, root=ROOT), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
