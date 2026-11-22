#!/usr/bin/env python3
"""GET-only thin consumer; no alternate simulation or Git execution path."""
import argparse
import json
import urllib.parse
import urllib.request


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--gateway',required=True)
    p.add_argument('operation',choices=['signals','waveform','waveform-map'])
    p.add_argument('run_id')
    for key in ['signal-id','analysis','start','end','limit','cursor-a','cursor-b']:
        p.add_argument('--'+key)
    a=p.parse_args()
    base=urllib.parse.urlsplit(a.gateway)
    if base.scheme!='http' or base.hostname!='127.0.0.1' or not base.port or base.username or base.password or base.query or base.fragment or base.path not in ('','/'):
        p.error('gateway must be an explicit http://127.0.0.1:PORT origin')
    params={k:v for k,v in vars(a).items() if k not in ('gateway','operation','run_id') and v is not None}
    url=a.gateway.rstrip('/')+'/api/jobs/'+urllib.parse.quote(a.run_id,safe='')+'/'+a.operation+'?'+urllib.parse.urlencode(params)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args):
            raise ValueError('Gateway redirects are not allowed')
    with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open(url,timeout=20) as r:
        print(json.dumps(json.load(r),ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
