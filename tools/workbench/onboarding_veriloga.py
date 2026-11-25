"""Bind explicitly observed standard Verilog-A headers to reviewed staging.

SpiceOwl owns header parsing and bounded remote inspection. This adapter maps
its physical observations to portable aliases; header contents never enter Git.
"""
import hashlib
import json
import posixpath
import re
import secrets
import shlex

from platform_compat import find_ssh_binary
from spiceowl_pool import canonical


def probe_request(capture,roots):
    from spiceowl.onboarding.veriloga_headers import build_veriloga_header_probe_script
    private=capture.get('private') or {}
    identity=private.get('identity') or {}
    tools={row.get('kind'):row.get('path') for row in private.get('tools',[])}
    if any(not isinstance(tools.get(kind),str) or not re.fullmatch(r'/[A-Za-z0-9_./+-]+',tools[kind])
           for kind in ('spectre','python')):
        raise ValueError('Select an observed Spectre installation and remote Python before inspecting header roots')
    if any(not isinstance(identity.get(key),str) or not identity[key] or len(identity[key])>256
           or any(ord(c)<32 for c in identity[key]) for key in ('hostname','username')):
        raise ValueError('An observed remote account is required')
    script=build_veriloga_header_probe_script(roots=roots)
    return script,tools,identity


def remote_headers(target,ssh_config,capture,roots):
    from spiceowl.onboarding.environment import _transport,_SSH_OPTIONS
    from spiceowl.onboarding.ssh_discovery import validate_ssh_target,config_path
    from spiceowl.onboarding.veriloga_headers import validate_veriloga_headers,MAX_RESULT_BYTES
    script,tools,identity=probe_request(capture,roots)
    marker='IC_VA_HEADERS_'+secrets.token_hex(16);begin=marker+'_BEGIN';end=marker+'_END';q=shlex.quote
    command='set -eu\n[ "$(hostname)" = '+q(identity['hostname'])+' ]\n[ "$(id -un)" = '+q(identity['username'])+' ]\n'
    command+='printf "\\n%s\\n" '+q(begin)+'\n/usr/bin/timeout 50 '+q(tools['python'])+" - <<'IC_VA_HEADERS_PY'\n"+script+'\nIC_VA_HEADERS_PY\n'
    command+='printf "%s\\n" '+q(end)+'\n'
    argv=[find_ssh_binary(),'-T','-F',str(config_path(ssh_config))]
    for option in (*_SSH_OPTIONS,'StdinNull=no'):argv.extend(('-o',option))
    argv.extend(('--',validate_ssh_target(target),'/bin/sh -s'))
    reply=_transport(argv,command,timeout=60,max_output=MAX_RESULT_BYTES+1024)
    lines=reply.stdout.splitlines();b=begin.encode();e=end.encode()
    if reply.returncode or lines.count(b)!=1 or lines.count(e)!=1 or lines.index(b)>=lines.index(e):
        raise ValueError('The explicit bounded Verilog-A header probe did not complete')
    from spiceowl_pool import unique_object
    result=json.loads(b'\n'.join(lines[lines.index(b)+1:lines.index(e)]),object_pairs_hook=unique_object,
        parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Nonfinite header observation')))
    return validate_veriloga_headers(result)


def freeze_observation(capture,probe_id,observation):
    from spiceowl.onboarding.veriloga_headers import validate_veriloga_headers
    validate_veriloga_headers(observation)
    private=capture.get('private') or {}
    spectre=[row['path'] for row in private.get('tools',[]) if row.get('kind')=='spectre' and row.get('path')]
    if len(spectre)!=1:raise ValueError('Select one observed Spectre installation')
    record={'probe_id':probe_id,'spectre':spectre[0],'activation':private.get('activation'),
            'observation':observation}
    record['header_id']='headers_'+hashlib.sha256(canonical(record)).hexdigest()
    return record


def verify_record(record,header_id,probe_id):
    from spiceowl.onboarding.veriloga_headers import validate_veriloga_headers
    if (record.get('header_id')!=header_id or record.get('probe_id')!=probe_id
            or header_id!='headers_'+hashlib.sha256(canonical({k:v for k,v in record.items() if k!='header_id'})).hexdigest()):
        raise ValueError('Header observation does not match this selected probe')
    return validate_veriloga_headers(record['observation'])


def public_headers(record):
    observation=verify_record(record,record['header_id'],record['probe_id'])
    return {'id':record['header_id'],'probe_id':record['probe_id'],'status':observation['status'],
        'inventory_sha256':observation['observation_id'],
        'headers':[{**{k:row[k] for k in ('name','sha256')},
                    'alias':'VA_HEADER_'+hashlib.sha256(row['name'].encode()).hexdigest()[:24].upper()}
                   for row in observation['headers']],
        'coverage':observation['coverage'],'missing':[{'code':row['code']} for row in observation['missing']],
        'fresh_audit_required':True,'remote_freshness_verified':False,'ready_to_run':False}


def header_binding(observation,names):
    """Delegate graph selection, aliases and closure to the pinned owner API."""
    if not names:return {},{}
    from spiceowl.onboarding.veriloga_headers import build_veriloga_header_binding
    result=build_veriloga_header_binding(observation,required_names=sorted(names))
    return result['public'],{alias:row['path'] for alias,row in result['private_aliases'].items()}


STAGING_ROOT='netlist/__ic_va_headers__'


def staging_manifest(recipe):
    binding=recipe['agent_tb_manifest']['pdk_binding']
    return {'schema':'ic.veriloga-header-staging.v1','binding':binding,
            'uses':recipe['veriloga_external_dependencies']}


def prepare_header_staging(bundle,site,payload,provenance):
    """Use exact owner-parsed include locations; never parse a second VA grammar."""
    staging=bundle.get('veriloga_header_staging')
    if staging is None:return {}
    from spiceowl.onboarding.agent_tb import _binding,_check_header_closure
    from spiceowl.experiments import validate_recipe
    recipe=json.loads(payload['experiment/recipe.json'])
    validate_recipe(recipe)
    if recipe.get('recipe')!='agent-testbench' or staging!=staging_manifest(recipe):
        raise ValueError('Standard header staging differs from the frozen owner recipe')
    binding=_binding(staging['binding']);names={row['reference'] for row in staging['uses']};issues=[]
    _check_header_closure(binding,names,issues)
    if issues or not names:raise ValueError('A complete observed standard header graph is required')
    closure=binding['veriloga_header_closure'];files=closure['files'];targets={}
    for row in files:
        alias=row['alias']
        if bundle.get('external_sha256',{}).get(alias)!=row['sha256'] or alias not in site.get('external_files',{}):
            raise ValueError('Every staged standard header requires an exact audited external pin')
        targets[STAGING_ROOT+'/'+row['name']]=row['sha256']
    if any(name==STAGING_ROOT or name.startswith(STAGING_ROOT+'/') or name.startswith('veriloga-stage') for name in payload):
        raise ValueError('Supplied sources conflict with the reserved header staging namespace')
    replacements={}
    for edge in staging['uses']:
        path='netlist/'+edge['from'];line=edge['line'];reference=edge['reference']
        if path not in payload or reference not in names or type(line) is not int:
            raise ValueError('Frozen standard header usage identity is missing')
        replacements.setdefault(path,[]).append((line,reference))
    for path,rows in replacements.items():
        lines=payload[path].decode('utf-8').splitlines(keepends=True)
        for line,reference in rows:
            if not 1<=line<=len(lines):raise ValueError('Frozen standard header usage line differs')
            pattern=r'(`include\s+")'+re.escape(reference)+r'(")'
            if len(re.findall(pattern,lines[line-1]))!=1:
                raise ValueError('Frozen standard header usage is not uniquely located')
            target=posixpath.relpath(STAGING_ROOT+'/'+reference,posixpath.dirname(path))
            lines[line-1]=re.sub(pattern,lambda match:match[1]+target+match[2],lines[line-1],count=1)
        payload[path]=''.join(lines).encode('utf-8')
        for row in provenance:
            if row['destination']==path:row['staged_sha256']=hashlib.sha256(payload[path]).hexdigest()
    # Header bytes stay on the selected simulator host. Both their original
    # aliases and the copied graph are verified immediately before the solver.
    script=['#!/bin/sh','set -eu','umask 077']
    q=shlex.quote
    for row in files:
        destination=STAGING_ROOT+'/'+row['name']
        script+=['mkdir -p '+q(posixpath.dirname(destination)),
                 'if [ -e '+q(destination)+' ] || [ -L '+q(destination)+' ]; then exit 73; fi',
                 'cp -- '+q(site['external_files'][row['alias']])+' '+q(destination)]
    script+=['printf "%s\\n" '+' '.join(q(sha+'  '+name) for name,sha in sorted(targets.items()))+' > veriloga-staged.sha256',
             'sha256sum -c veriloga-staged.sha256 > veriloga-staged-checksums.log 2>&1']
    payload['veriloga-stage.sh']=('\n'.join(script)+'\n').encode()
    return targets
