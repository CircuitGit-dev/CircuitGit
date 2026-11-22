#!/usr/bin/env python3
"""Compatibility command; canonical entry is apps/codex/ic_workbench.py."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'apps/codex'))
from icwb.cli import main
if __name__=='__main__':raise SystemExit(main())
