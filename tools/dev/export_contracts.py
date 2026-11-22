#!/usr/bin/env python3
"""Export/check the exact live tool schema without a gateway or model request."""
import argparse,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'modules/gateway_client'))
from ic_gateway.contracts import tools

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--check',action='store_true');a=p.parse_args()
    path=ROOT/'contracts/ic-tools.v1.json'
    content=json.dumps({'schema':'ic.tools.catalog.v1','tools':tools()},ensure_ascii=False,indent=2)+'\n'
    if a.check:
        if not path.exists() or path.read_text()!=content:raise SystemExit('Tool catalog drift: run tools/dev/export_contracts.py')
        print('Tool catalog matches the executable contract.')
    else:path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content)
if __name__=='__main__':main()
