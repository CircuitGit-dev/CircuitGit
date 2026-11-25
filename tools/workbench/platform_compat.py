"""Cross-platform OS primitives for macOS, Linux, and native Windows.

Python 3.9+, standard library only. Centralizes file locking, private file/dir
checks, symlink-safe opens, detached process flags, PID liveness, bounded pipe
reads, and Windows/POSIX path helpers so application modules never import
POSIX-only modules directly.
"""
import contextlib
import ctypes
import errno
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time

IS_WINDOWS = os.name == 'nt'
IS_MACOS = sys.platform == 'darwin'

if not IS_WINDOWS:
    import fcntl
    import selectors
else:
    import msvcrt

_POSIX_SAFE_PATH_SPACE = re.compile(r'^/[A-Za-z0-9_./ +-]+$')
_POSIX_SAFE_PATH_NOSPACE = re.compile(r'^/[A-Za-z0-9_./+-]+$')
_WIN_SAFE_PATH_SPACE = re.compile(r'^[A-Za-z]:[\\/][A-Za-z0-9_.\\/ +-]*$')
_WIN_SAFE_PATH_NOSPACE = re.compile(r'^[A-Za-z]:[\\/][A-Za-z0-9_.\\/+-]*$')


def _fileno(stream_or_fd):
    return stream_or_fd if isinstance(stream_or_fd, int) else stream_or_fd.fileno()


def lock_file(stream_or_fd, *, nonblocking=False):
    """Acquire an exclusive advisory lock on an open file or file descriptor.

    Raises BlockingIOError when nonblocking=True and another process holds it.
    """
    fd = _fileno(stream_or_fd)
    if not IS_WINDOWS:
        flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0)
        fcntl.flock(fd, flags)
        return
    # Windows msvcrt.locking locks a 1-byte region starting at the current file offset.
    os.lseek(fd, 0, os.SEEK_SET)
    if nonblocking:
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError as error:
            if error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise BlockingIOError(errno.EAGAIN, 'Lock is held by another process') from error
            raise
        return
    while True:
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
            return
        except OSError as error:
            if error.errno in (errno.EDEADLK, errno.EACCES, errno.EAGAIN):
                time.sleep(0.05)
                continue
            raise


def unlock_file(stream_or_fd):
    """Release an advisory lock previously acquired with lock_file."""
    fd = _fileno(stream_or_fd)
    if not IS_WINDOWS:
        fcntl.flock(fd, fcntl.LOCK_UN)
        return
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except OSError:
        pass


@contextlib.contextmanager
def file_lock(path, *, nonblocking=False):
    """Open and exclusively lock a lockfile across macOS, Linux, and Windows."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with target.open('a+b') as handle:
        lock_file(handle, nonblocking=nonblocking)
        try:
            yield handle
        finally:
            unlock_file(handle)


def chmod_private(path, mode=0o600):
    """Apply POSIX private permissions; safe no-op on Windows NTFS."""
    if not IS_WINDOWS:
        os.chmod(path, mode)


def fchmod_private(fd, mode=0o600):
    """Apply POSIX private permissions to an open file descriptor when supported."""
    if not IS_WINDOWS and hasattr(os, 'fchmod'):
        os.fchmod(fd, mode)


def is_owner_private_file(path, *, max_size=None, allow_root=False, reject_mode_mask=0o077):
    """Return True if path is a regular, non-symlink owner-private file."""
    target = Path(path)
    try:
        info = target.lstat()
    except OSError:
        return False
    if not stat.S_ISREG(info.st_mode) or target.is_symlink():
        return False
    if max_size is not None and info.st_size > max_size:
        return False
    if IS_WINDOWS:
        return True
    uid = os.getuid() if allow_root else os.geteuid()
    uid_ok = info.st_uid in (0, uid) if allow_root else info.st_uid == uid
    return uid_ok and not (stat.S_IMODE(info.st_mode) & reject_mode_mask)


def is_owner_private_dir(path, *, reject_mode_mask=0o077):
    """Return True if path is a real, non-symlink owner-private directory."""
    target = Path(path)
    try:
        info = target.lstat()
    except OSError:
        return False
    if not stat.S_ISDIR(info.st_mode) or target.is_symlink():
        return False
    if IS_WINDOWS:
        return True
    return info.st_uid == os.getuid() and not (stat.S_IMODE(info.st_mode) & reject_mode_mask)


def open_nofollow(path, flags, mode=0o600):
    """Open path without following symlinks on both POSIX and Windows."""
    target = Path(path)
    if IS_WINDOWS:
        if target.is_symlink():
            raise OSError(errno.ELOOP, 'Refusing to follow symlink', str(target))
        return os.open(target, flags, mode)
    nofollow = getattr(os, 'O_NOFOLLOW', 0)
    return os.open(target, flags | nofollow, mode)


def detached_popen_kwargs():
    """Return subprocess.Popen kwargs to launch a detached background child."""
    if IS_WINDOWS:
        flags = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'DETACHED_PROCESS', 0)
        return {'creationflags': flags}
    return {'start_new_session': True}


def isolated_popen_kwargs():
    """Return subprocess.Popen kwargs to isolate a child process group."""
    if IS_WINDOWS:
        return {'creationflags': getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)}
    return {'start_new_session': True}


def pid_alive(pid):
    """Check whether a local process ID is still running."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    if not IS_WINDOWS:
        try:
            os.kill(pid, 0)
            return True
        except PermissionError:
            return True
        except OSError:
            return False
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        exit_code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return False
        return exit_code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def is_safe_local_abs_path(value, *, allow_spaces=True):
    """Validate an absolute local path on POSIX (/...) or Windows (C:\\...)."""
    if not isinstance(value, str) or not value or '\x00' in value:
        return False
    if value.startswith('/'):
        pattern = _POSIX_SAFE_PATH_SPACE if allow_spaces else _POSIX_SAFE_PATH_NOSPACE
        if not pattern.fullmatch(value):
            return False
        return '..' not in PurePosixPath(value).parts
    if len(value) >= 3 and value[1] == ':' and value[2] in ('\\', '/'):
        pattern = _WIN_SAFE_PATH_SPACE if allow_spaces else _WIN_SAFE_PATH_NOSPACE
        if not pattern.fullmatch(value):
            return False
        return '..' not in PureWindowsPath(value).parts
    return False


def path_basename(value):
    """Return the final path component for either POSIX or Windows paths."""
    if isinstance(value, str) and len(value) >= 3 and value[1] == ':' and value[2] in ('\\', '/'):
        return PureWindowsPath(value).name
    return PurePosixPath(str(value)).name


def venv_python_path(env_dir, *, windows=None):
    """Return the expected interpreter path inside a Python venv."""
    use_win = IS_WINDOWS if windows is None else bool(windows)
    base = Path(env_dir)
    return base / ('Scripts/python.exe' if use_win else 'bin/python')


def find_venv_python(env_dir):
    """Locate an existing interpreter inside a venv (checks native layout first)."""
    base = Path(env_dir)
    candidates = (
        (base / 'Scripts/python.exe', base / 'bin/python')
        if IS_WINDOWS
        else (base / 'bin/python', base / 'Scripts/python.exe')
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def git_devnull():
    """Return the OS null device path for Git config overrides."""
    return os.devnull


def git_credential_helper(gh_bin, *, windows=None):
    """Build a safe Git credential.helper=!... invocation for gh."""
    use_win = IS_WINDOWS if windows is None else bool(windows)
    executable = str(gh_bin).replace('\\', '/') if use_win else str(gh_bin)
    return '!' + shlex.quote(executable) + ' auth git-credential'


def find_ssh_binary():
    """Locate the local OpenSSH client binary."""
    if IS_WINDOWS:
        return shutil.which('ssh') or 'ssh'
    if Path('/usr/bin/ssh').is_file():
        return '/usr/bin/ssh'
    return shutil.which('ssh') or 'ssh'


def install_sigterm_handler(handler, *, signal_module=None):
    """Install a SIGTERM handler when supported by the current OS."""
    mod = signal if signal_module is None else signal_module
    sigterm = getattr(mod, 'SIGTERM', None)
    if sigterm is None:
        return None
    try:
        return mod.signal(sigterm, handler)
    except (OSError, ValueError):
        return None


def read_bounded_pipes(proc, deadline, *, stdout_limit, stderr_limit,
                       on_timeout, on_limit, use_threads=None):
    """Read stdout/stderr from a Popen child with strict byte and time bounds.

    Uses selectors.DefaultSelector on POSIX and daemon reader threads on Windows
    (where select() only accepts sockets).
    """
    threaded = IS_WINDOWS if use_threads is None else bool(use_threads)
    if not threaded:
        stdout = bytearray()
        sizes = {'stdout': 0, 'stderr': 0}
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ, 'stdout')
            selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise on_timeout()
                for key, _ in selector.select(remaining):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    sizes[key.data] += len(chunk)
                    limit = stdout_limit if key.data == 'stdout' else stderr_limit
                    if sizes[key.data] > limit:
                        raise on_limit()
                    if key.data == 'stdout':
                        stdout.extend(chunk)
        return bytes(stdout)

    stdout = bytearray()
    overflow = threading.Event()
    done = threading.Event()
    state_lock = threading.Lock()
    remaining_readers = [2]

    def drain(stream, limit, capture):
        total = 0
        try:
            while not overflow.is_set():
                chunk = stream.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    overflow.set()
                    try:
                        proc.kill()
                    except OSError:
                        pass
                    break
                if capture:
                    stdout.extend(chunk)
        except OSError:
            pass
        finally:
            with state_lock:
                remaining_readers[0] -= 1
                if remaining_readers[0] == 0:
                    done.set()

    t_out = threading.Thread(target=drain, args=(proc.stdout, stdout_limit, True), daemon=True)
    t_err = threading.Thread(target=drain, args=(proc.stderr, stderr_limit, False), daemon=True)
    t_out.start()
    t_err.start()
    while not done.is_set():
        if overflow.is_set():
            raise on_limit()
        left = deadline - time.monotonic()
        if left <= 0:
            try:
                proc.kill()
            except OSError:
                pass
            raise on_timeout()
        done.wait(min(0.05, left))
    t_out.join(timeout=1.0)
    t_err.join(timeout=1.0)
    if overflow.is_set():
        raise on_limit()
    return bytes(stdout)
