#!/usr/bin/env python3
"""Compatibility entry for the canonical tools/workbench/ic_sim.py runner.

Public functions retain the canonical module globals, including __file__, so
runner provenance hashes the implementation rather than this compatibility file.
The export also supports callers using spec_from_file_location/exec_module.
"""
import importlib.util as _importlib
from pathlib import Path as _Path
import sys as _sys

_implementation_path = _Path(__file__).resolve().parents[1] / 'workbench/ic_sim.py'
_spec = _importlib.spec_from_file_location('_ic_workbench_standalone_spectre', _implementation_path)
_implementation = _importlib.module_from_spec(_spec)
_spec.loader.exec_module(_implementation)

if __name__ == '__main__':
    try:
        _implementation.main()
    except (ValueError, KeyError, OSError, _implementation.subprocess.TimeoutExpired) as error:
        print('ERROR: ' + str(error), file=_sys.stderr)
        raise SystemExit(2)
else:
    # spec callers retain this module object; normal imports receive the actual
    # implementation, preserving monkeypatching and function-global semantics.
    globals().update({name: value for name, value in vars(_implementation).items() if not name.startswith('__')})
    __file__ = str(_implementation_path)
    _sys.modules[__name__] = _implementation
