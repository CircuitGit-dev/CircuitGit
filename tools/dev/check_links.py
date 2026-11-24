#!/usr/bin/env python3
"""Check repository document links offline; optionally audit public HTTP URLs.

No dependencies, browser, credentials, service startup or automatic URL rewrites.
External availability is a bounded observation, not a lasting guarantee.
"""
import argparse
from collections import Counter
import html
from html.parser import HTMLParser
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler

ROOT = Path(__file__).resolve().parents[2]
GENERATED = {'web','site','dist','node_modules','__pycache__'}
HISTORY = {'validation','results','design','sim'}
MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
URL = re.compile(r'https?://[^\s<>"\]\)`*，。；：！？]+')


def is_within(path, root):
    return path == root or root in path.parents


def mask_code(text, *, inline=True):
    result = []; fence = None
    for line in text.splitlines(keepends=True):
        marker = re.match(r'^\s{0,3}(`{3,}|~{3,})', line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence):fence = None
            result.append(''.join('\n' if ch == '\n' else ' ' for ch in line))
        elif marker:
            fence = marker[1];result.append(''.join('\n' if ch == '\n' else ' ' for ch in line))
        else:result.append(line)
    value = ''.join(result)
    value = re.sub(r'<!--.*?-->', lambda m:re.sub(r'[^\n]', ' ', m[0]), value, flags=re.S)
    return re.sub(r'(`+)([^`]|(?!\1)`)*?\1', lambda m:re.sub(r'[^\n]', ' ', m[0]), value) if inline else value


def destination(value):
    value = value.strip()
    if value.startswith('<') and '>' in value:return value[1:value.index('>')]
    found = re.match(r'(?:\\.|[^\s])+', value)
    return re.sub(r'\\([\s()])', r'\1', found[0]) if found else ''


class MarkupLinks(HTMLParser):
    def __init__(self):super().__init__(convert_charrefs=True);self.links=[];self.ids=set()
    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        for key in ('id','name'):
            if values.get(key):self.ids.add(values[key])
        for key in ('href','src'):
            if values.get(key):self.links.append((self.getpos()[0],values[key],'html-'+key))


def extract_links(text):
    value = mask_code(text);rows=[];definitions={};occupied=[]
    def add(offset,target,kind):
        target=html.unescape(target.strip())
        if target:rows.append({'line':value.count('\n',0,offset)+1,'target':target,'kind':kind})
    for match in re.finditer(r'^\s{0,3}\[([^]\n]+)\]:\s*(.+)$',value,re.M):
        target=destination(match[2]);definitions[' '.join(match[1].lower().split())]=target
        add(match.start(),target,'reference-definition');occupied.append((match.start(),match.end()))
    for match in re.finditer(r'!?\[[^]\n]*\]\(',value):
        start=match.end();index=start;depth=1;quoted=False
        while index<len(value) and value[index]!='\n':
            char=value[index]
            if char=='\\':index+=2;continue
            if char=='<' and index==start:quoted=True
            elif char=='>' and quoted:quoted=False
            elif not quoted and char=='(':depth+=1
            elif not quoted and char==')':
                depth-=1
                if depth==0:break
            index+=1
        if depth==0:add(match.start(),destination(value[start:index]),'markdown');occupied.append((match.start(),index+1))
    for match in re.finditer(r'!?\[([^]\n]+)\](?:\[([^]\n]*)\])?',value):
        if any(begin<=match.start()<end for begin,end in occupied):continue
        if match.end()<len(value) and value[match.end()]=='(':continue
        label=' '.join((match[2] or match[1]).lower().split())
        if label in definitions:add(match.start(),definitions[label],'reference')
        elif match[2] is not None:add(match.start(),'reference:'+label,'missing-reference')
    parser=MarkupLinks();parser.feed(value)
    rows.extend({'line':line,'target':target,'kind':kind} for line,target,kind in parser.links)
    for match in URL.finditer(value):
        target=match[0].rstrip('.,;:!?*`，。');line=value.count('\n',0,match.start())+1
        if not any(row['line']==line and row['target'].startswith(target) for row in rows):add(match.start(),target,'autolink')
    unique={}
    for row in rows:unique.setdefault((row['line'],row['target']),row)
    return list(unique.values())


def anchors(path):
    text=path.read_text(encoding='utf-8');parser=MarkupLinks();parser.feed(mask_code(text));found=set(parser.ids);seen=Counter()
    lines=mask_code(text,inline=False).splitlines()
    for index,line in enumerate(lines):
        match=re.match(r'^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$',line)
        title=match[1] if match else line.strip() if index+1<len(lines) and re.fullmatch(r'\s{0,3}(?:=+|-+)\s*',lines[index+1]) else None
        if not title:continue
        title=re.sub(r'!?\[([^]]*)\]\([^)]*\)',r'\1',title)
        title=html.unescape(re.sub(r'<[^>]*>','',title)).lower()
        slug=re.sub(r'[^\w\- ]','',title).replace(' ','-')
        count=seen[slug];seen[slug]+=1;found.add(slug+('-'+str(count) if count else ''))
    return found


def outdated_url(value):
    try:parsed=urlsplit(value);host=(parsed.hostname or '').lower();path=parsed.path
    except ValueError:return None
    replacements={
        ('github.com','/analog-topology-synth/circuitgit'):('github.com','/CircuitGit-dev/CircuitGit'),
        ('github.com','/analog-topology-synth/spiceowl'):('github.com','/spiceowl-dev/spiceowl'),
        ('analog-topology-synth.github.io','/circuitgit'):('circuitgit-dev.github.io','/CircuitGit'),
    }
    for (old_host,old_path),(new_host,new_path) in replacements.items():
        if host==old_host and path.lower().startswith(old_path) and path[len(old_path):len(old_path)+1] in ('','/','.'):
            return urlunsplit((parsed.scheme,new_host,new_path+path[len(old_path):],parsed.query,parsed.fragment))
    return None


def document_paths(root, selected=None):
    paths=[];skipped=[]
    for base in [root/path for path in selected] if selected else [root]:
        base=base.absolute()
        if not is_within(base.resolve(),root):raise ValueError('Document selection leaves the repository')
        if not base.exists():raise ValueError('Document selection does not exist: '+str(base.relative_to(root)))
        if base.is_file():candidates=[base]
        else:
            candidates=[]
            for folder,dirs,files in os.walk(base,followlinks=False):
                relative=Path(folder).relative_to(root)
                retained=[]
                for name in dirs:
                    path=Path(folder)/name;parts=path.relative_to(root).parts
                    if path.is_symlink() or name.startswith('.') and name!='.github' or name in ('node_modules','__pycache__') or len(parts)==1 and name in GENERATED|{'submodules'} or name in ('vendor','third_party'):
                        skipped.append({'path':path.relative_to(root).as_posix(),'reason':'symlink, generated, cache or third-party directory'})
                    else:retained.append(name)
                dirs[:]=retained
                candidates.extend(Path(folder)/name for name in files if name.lower().endswith(('.md','.markdown')) or name.lower().endswith('.html') and (not relative.parts or relative.parts[0]=='docs'))
        for path in candidates:
            if path.is_symlink():skipped.append({'path':path.relative_to(root).as_posix(),'reason':'symlink document'});continue
            if path.stat().st_size>MAX_DOCUMENT_BYTES:skipped.append({'path':path.relative_to(root).as_posix(),'reason':'document exceeds 2 MiB bound'});continue
            paths.append(path)
    return sorted(set(paths)),skipped


def local_result(root,path,target):
    if target.startswith('reference:'):return 'error','missing_reference_definition','Reference-style link has no definition'
    parsed=urlsplit(target)
    if parsed.scheme or parsed.netloc:return 'skip','non_file_scheme','Application or non-file URI'
    decoded=unquote(parsed.path)
    if any(token in decoded for token in ('{{','${','<','>')):return 'skip','template_target','Template target cannot be resolved statically'
    location=(root/decoded.lstrip('/') if decoded.startswith('/') else path.parent/decoded if decoded else path).resolve()
    if not is_within(location,root):return 'error','outside_repository','Relative document link leaves the repository'
    if not location.exists():return 'error','missing_local_target',str(location.relative_to(root))
    if not parsed.fragment:return 'ok','local_target_exists',None
    if location.is_dir():
        candidate=next((location/name for name in ('README.md','readme.md','index.md','index.html') if (location/name).is_file()),None)
        if candidate is None:return 'skip','directory_fragment','Directory has no document for anchor inspection'
        location=candidate
    fragment=unquote(parsed.fragment)
    if location.suffix.lower() in ('.md','.markdown','.html','.svg'):
        return ('ok','local_anchor_exists',None) if fragment in anchors(location) else ('error','missing_local_anchor',fragment)
    line=re.fullmatch(r'L([1-9][0-9]*)(?:-L([1-9][0-9]*))?',fragment)
    if line:
        try:count=len(location.read_text(encoding='utf-8').splitlines())
        except (OSError,UnicodeError):return 'skip','binary_line_fragment','Cannot check a text line in this asset'
        first,last=int(line[1]),int(line[2] or line[1])
        return ('ok','local_line_exists',None) if first<=last<=count else ('error','missing_local_line',fragment)
    return 'skip','unsupported_asset_fragment','File exists; its fragment syntax is not checked'


def public_url(url, *, resolve_dns=False):
    try:parsed=urlsplit(url);host=(parsed.hostname or '').lower();port=parsed.port
    except ValueError:return 'malformed_url'
    if parsed.scheme not in ('http','https') or not host:return 'unsupported_scheme'
    if parsed.username or parsed.password:return 'credential_url'
    if re.search(r'(?i)(token|password|secret|access_code|api_key)=',parsed.query):return 'credential_query'
    if host in ('localhost','example.com','example.org','example.net') or host.endswith(('.localhost','.local','.test','.invalid','.example')):return 'local_or_example_address'
    try:
        if not ipaddress.ip_address(host).is_global:return 'non_public_address'
    except ValueError:
        if '.' not in host:return 'local_or_example_address'
    if resolve_dns:
        addresses=socket.getaddrinfo(host,port or (443 if parsed.scheme=='https' else 80),type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):return 'non_public_dns_result'
    return None


def public_report(value):
    if isinstance(value,list):return [public_report(item) for item in value]
    if not isinstance(value,dict):return value
    result={}
    for key,item in value.items():
        if key in ('target','url','suggested','final_url') and isinstance(item,str) and item.startswith(('http://','https://')):
            try:
                parsed=urlsplit(item);netloc=parsed.netloc;query=parsed.query
                if parsed.username or parsed.password:netloc='<redacted>@'+netloc.rsplit('@',1)[-1]
                if re.search(r'(?i)(token|password|secret|access_code|api_key)=',query):query='<redacted>'
                item=urlunsplit((parsed.scheme,netloc,parsed.path,query,parsed.fragment))
            except ValueError:pass
        result[key]=public_report(item)
    return result


class SkippedURL(ValueError):
    def __init__(self,reason):self.reason=reason;super().__init__(reason)


class PublicRedirect(HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        reason=public_url(newurl,resolve_dns=True)
        if reason:raise SkippedURL('redirect_'+reason)
        return super().redirect_request(req,fp,code,msg,headers,newurl)


def online_probe(url,timeout):
    try:
        reason=public_url(url,resolve_dns=True)
        if reason:return {'status':'skip','code':reason}
        opener=build_opener(ProxyHandler({}),PublicRedirect())
        for method in ('HEAD','GET'):
            try:
                with opener.open(Request(url,method=method,headers={'User-Agent':'CircuitGit-LinkAudit/1.0'}),timeout=timeout) as response:
                    final=response.geturl();return {'status':'ok','code':'redirected' if final!=url else 'reachable','http_status':response.status,'final_url':final}
            except HTTPError as error:
                if method=='HEAD' and error.code in (405,501):continue
                code=('not_found' if error.code in (404,410) else 'access_restricted' if error.code in (401,403,407) else 'rate_limited' if error.code==429 else 'http_unavailable')
                return {'status':'error' if error.code in (404,410) else 'warning','code':code,'http_status':error.code}
    except SkippedURL as error:
        return {'status':'skip','code':error.reason}
    except (OSError,ValueError,URLError) as error:
        return {'status':'warning','code':'network_unverified','detail':type(error).__name__}


def audit(root=ROOT, *, paths=None, online=False, max_external=50, timeout=5, probe=online_probe):
    root=Path(root).resolve();documents,skipped=document_paths(root,paths);findings=[];external={};checked=0
    for path in documents:
        relative=path.relative_to(root).as_posix();text=path.read_text(encoding='utf-8')
        historical=bool(path.relative_to(root).parts[0] in HISTORY or path.name.upper().startswith(('LICENSE','COPYING','THIRD_PARTY')))
        rows=extract_links(text)
        # Migration strings in executable documentation examples matter too,
        # but only actual rendered links undergo local/HTTP target checks.
        for match in URL.finditer(text):
            url=match[0].rstrip('.,;:!?*`，。');new=outdated_url(url)
            if new:
                findings.append({'source':relative,'line':text.count('\n',0,match.start())+1,'target':url,
                    'status':'warning' if historical else 'error','code':'historical_first_party_url' if historical else 'outdated_first_party_url','suggested':new})
        for row in rows:
            checked+=1;record={'source':relative,**row};target=row['target']
            try:parsed=urlsplit(target)
            except ValueError:
                findings.append({**record,'status':'warning' if historical else 'error','code':'malformed_target'});continue
            if parsed.scheme in ('http','https'):
                reason=public_url(target)
                if reason:findings.append({**record,'status':'skip','code':reason});continue
                external.setdefault(urlunsplit((parsed.scheme,parsed.netloc,parsed.path,parsed.query,'')),[]).append(record)
            else:
                status,code,detail=local_result(root,path,target)
                if historical and status=='error':status='warning';code='historical_'+code
                if status!='ok':findings.append({**record,'status':status,'code':code,**({'detail':detail} if detail else {})})
    observations=[];rate_limited=set();audited=0
    for url,references in sorted(external.items()):
        host=urlsplit(url).hostname
        if not online:result={'status':'skip','code':'offline_external_not_checked'}
        elif audited>=max_external:result={'status':'skip','code':'external_audit_limit'}
        elif host in rate_limited:result={'status':'skip','code':'host_rate_limited'}
        else:
            result=probe(url,timeout);audited+=1
            if result.get('code')=='rate_limited':rate_limited.add(host)
        observations.append({'url':url,**result,'references':references})
        if result['status'] in ('error','warning'):findings.append({'target':url,**result,'source':references[0]['source'],'line':references[0]['line']})
    counts=Counter(row['status'] for row in findings)
    return public_report({'schema':'circuitgit.link-audit.v1','status':'failed' if counts['error'] else 'passed',
            'coverage':{'documents':len(documents),'rendered_links':checked,'external_urls':len(external),'external_audited':audited,'online':online,'max_external':max_external if online else 0,
                        'scope':'Repository Markdown and document HTML; code links and generated/vendor/cache trees excluded','skipped_paths':skipped},
            'counts':dict(counts),'external_counts':dict(Counter(row['status'] for row in observations)),
            'findings':findings,'external':observations,
            'limitations':['HTTP status is a bounded point-in-time observation; external fragments are not checked.',
                          'Authentication, rate limits and network failures remain unverified; historical evidence is never rewritten.',
                          'The Markdown scanner is conservative; dynamically generated links and uncommon extensions need manual review.']})


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=ROOT)
    parser.add_argument('--path',action='append',help='Limit discovery to a repository-relative document or directory')
    parser.add_argument('--online',action='store_true',help='Audit bounded public URLs without credentials or local-address requests')
    parser.add_argument('--max-external',type=int,default=50)
    parser.add_argument('--timeout',type=float,default=5)
    args=parser.parse_args(argv)
    if not 1<=args.max_external<=1000 or not 0<args.timeout<=30:parser.error('Use 1–1000 external URLs and a timeout of at most 30 seconds')
    try:report=audit(args.root,paths=args.path,online=args.online,max_external=args.max_external,timeout=args.timeout)
    except (OSError,ValueError,UnicodeError) as error:
        print(json.dumps({'status':'failed','code':'audit_input_error','message':str(error)}),file=sys.stderr);return 1
    print(json.dumps(report,indent=2,ensure_ascii=False));return 1 if report['status']=='failed' else 0


if __name__=='__main__':raise SystemExit(main())
