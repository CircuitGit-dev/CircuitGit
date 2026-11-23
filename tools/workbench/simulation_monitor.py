"""Optional SpiceOwl monitor wiring. Importing CircuitGit requires no SpiceOwl."""


def RuntimeMonitor(runner, interval_seconds=30, max_backoff_seconds=300):
    """Construct the shared monitor only when this integration is enabled."""
    try:
        from spiceowl.monitoring.remote import RuntimeMonitor as SharedMonitor
    except ImportError:
        raise ValueError('Install the pinned SpiceOwl package to enable background simulation monitoring') from None
    return SharedMonitor(runner, interval_seconds=interval_seconds, max_backoff_seconds=max_backoff_seconds)
