"""IC host adapters. Shared gateway logic is provided by ic_gateway."""
import sys
from pathlib import Path
here=Path(__file__).resolve().parent
library=here.parent/'lib'
if not (library/'ic_gateway').is_dir():
    library=here.parents[2]/'modules/gateway_client'
if str(library) not in sys.path:sys.path.insert(0,str(library))
__version__='0.4.1'
