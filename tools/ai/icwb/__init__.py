"""Legacy import path forwarding to the canonical Codex adapter package."""
import sys
from pathlib import Path
root=Path(__file__).resolve().parents[3]
__path__=[str(root/'apps/codex/icwb')]
sys.path.insert(0,str(root/'modules/gateway_client'))
__version__='0.1.0'
