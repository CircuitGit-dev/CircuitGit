"""Legacy test command forwarding to tests/ai."""
import runpy,sys
from pathlib import Path
target=Path(__file__).resolve().parents[3]/'tests/ai'
sys.path.insert(0,str(target))
runpy.run_path(str(target/'test_service.py'),run_name='__main__')
