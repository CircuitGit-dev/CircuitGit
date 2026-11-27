"""Cross-platform OS primitives for ic_gateway and apps/codex/icwb.

Python 3.9+, standard library only. Provides macOS, Linux, and native Windows
implementations of file locking, owner-private file checks, detached subprocess
flags, and symlink-safe private file handling.
"""
import contextlib
import errno
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

IS_WINDOWS = os.name == 'nt'
IS_MACOS = sys.platform == 'darwin'

if not IS_WINDOWS:
    import fcntl
else:
    import msvcrt


def _fileno(stream_or_fd):
    return stream_or_fd if isinstance(stream_or_fd, int) else stream_or_fd.fileno()


def lock_file(stream_or_fd, *, nonblocking=False):
    """Acquire an exclusive advisory lock on an open file or descriptor."""
    fd = _fileno(stream_or_fd)
    if not IS_WINDOWS:
        flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0)
        fcntl.flock(fd, flags)
        return
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
    """Return subprocess.Popen kwargs to launch a detached background child.

    On Windows the child owns a hidden console. A child started without one
    gives every console application it launches a console of its own, and Git
    children then exit intermittently with STATUS_CONTROL_C_EXIT.
    """
    if IS_WINDOWS:
        flags = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        return {'creationflags': flags}
    return {'start_new_session': True}


def discard_unread_body(handler, limit, timeout=2.0):
    """Read and discard a request body that a rejecting handler did not read.

    A handler marks a consumed body with `handler.body_read`. Closing while the
    peer is still sending makes Windows answer the remaining bytes with a
    connection reset, which can overtake the error response.
    """
    if getattr(handler, 'body_read', False) or getattr(handler, 'command', None) != 'POST':
        return
    handler.body_read = True
    lengths = handler.headers.get_all('Content-Length', [])
    if handler.headers.get('Transfer-Encoding') or len(lengths) != 1:
        return
    try:
        length = int(lengths[0])
    except ValueError:
        return
    if not 0 < length <= limit:
        return
    previous = handler.connection.gettimeout()
    handler.connection.settimeout(timeout)
    try:
        remaining = length
        while remaining > 0:
            chunk = handler.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            remaining -= len(chunk)
    except OSError:
        pass  # A slow or vanished peer keeps its error response.
    finally:
        handler.connection.settimeout(previous)
