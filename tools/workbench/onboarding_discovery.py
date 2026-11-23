"""Bounded discovery transport and presentation, using only new probe evidence."""
import hashlib
import json
from pathlib import PurePosixPath
import posixpath
import re
import secrets
import shlex

from spiceowl.onboarding.environment import _transport, _SSH_OPTIONS
from spiceowl.onboarding.ssh_discovery import validate_ssh_target, config_path
from spiceowl.onboarding.pdk_discovery import build_pdk_discovery_script, profile_suggestions, DIRECTORY_SNAPSHOT_PREFIX


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode()).hexdigest()


MAX_AUTOMATIC_SEARCH_ROUNDS = 8
MAX_SEARCH_SCOPE_HISTORY = 512


def search_scope_id(probe_id, source_sha256, path):
    """Stable within one source/probe, even when discovery IDs change."""
    return digest({'probe_id':probe_id,'source_sha256':source_sha256,
                   'path':posixpath.normpath(path)})


def record_search_progress(public, rows, source_sha256, previous=None):
    """Bound automatic narrowing without exposing paths or forbidding manual scans."""
    previous=previous or {}
    scopes=set(previous.get('scope_ids',[]))
    rounds=previous.get('rounds_completed',0)+1
    complete=previous.get('history_complete',True)
    for row in rows:
        roots=list(row.get('search_roots',[]))+list((row.get('result') or {}).get('roots',[]))
        scopes.update(search_scope_id(row['probe_id'],source_sha256,path) for path in roots)
    if len(scopes)>MAX_SEARCH_SCOPE_HISTORY:
        complete=False
    history={'scope_ids':sorted(scopes)[:MAX_SEARCH_SCOPE_HISTORY],
             'rounds_completed':rounds,'history_complete':complete}
    by_id={row['directory_id']:row for row in public['search_directories']}
    for row in rows:
        for choice in (row.get('result') or {}).get('directory_suggestions',[]):
            identifier=digest({'discovery_id':public['discovery_id'],
                               'probe_id':row['probe_id'],'path':choice['path']})
            directory=by_id[identifier]
            scope=search_scope_id(row['probe_id'],source_sha256,choice['path'])
            reason=('incomplete_search_history' if not complete else
                    'search_round_limit' if rounds>=MAX_AUTOMATIC_SEARCH_ROUNDS else
                    'already_searched_scope' if scope in scopes else None)
            directory.update(search_scope_id=scope,search_attempted=scope in scopes,
                             automatic_search_allowed=reason is None,
                             automatic_search_blocked_reason=reason)
    public['automatic_search']={'rounds_completed':rounds,
        'round_limit':MAX_AUTOMATIC_SEARCH_ROUNDS,'history_complete':complete,
        'ready':any(row.get('automatic_search_allowed') is True for row in by_id.values())}
    return history


def remote_discovery(target,ssh_config,capture,requirements,search_paths=None,cds_lib_hint=None,*,full_library=False):
    private=capture.get('private')
    if not private:raise ValueError('The selected probe has no remote environment evidence')
    roots=search_paths if search_paths else [r['path'] for r in private.get('pdk_candidates',[]) if r.get('exists')]
    roots=list(dict.fromkeys(roots))
    if not roots:raise ValueError('No search root was discovered; supply an explicit PDK search directory')
    python=next((r['path'] for r in private['tools'] if r.get('kind')=='python' and r.get('path')),None)
    if not python or not re.fullmatch(r'/[A-Za-z0-9_./+-]+',python):raise ValueError('A discovered Python executable is required')
    cds=[r['path'] for r in private.get('scripts',[]) if r.get('kind')=='cds_lib']
    if cds_lib_hint:cds=[cds_lib_hint]
    if full_library:
        from spiceowl.onboarding.pdk_discovery import build_pdk_library_script,validate_pdk_library,MAX_LIBRARY_RESULT_BYTES
        script=build_pdk_library_script(roots=roots,cds_libs=cds[:16])
        output_limit=MAX_LIBRARY_RESULT_BYTES+1024  # Framing only; receipt retains its own strict bound.
    else:
        script=build_pdk_discovery_script(required_masters=requirements['required_masters'],roots=roots,
            source_sha256=requirements['source_sha256'],cds_libs=cds[:16])
        output_limit=2*1024*1024
    nonce=secrets.token_hex(16);begin='SPICEOWL_DISCOVERY_'+nonce+'_BEGIN';end='SPICEOWL_DISCOVERY_'+nonce+'_END'
    identity=private['identity'];q=shlex.quote
    command='set -eu\n[ "$(hostname)" = '+q(identity['hostname'])+' ]\n[ "$(id -un)" = '+q(identity['username'])+' ]\n'
    command+='printf "\\n%s\\n" '+q(begin)+'\n/usr/bin/timeout 50 '+q(python)+" - <<'SPICEOWL_DISCOVERY_PY'\n"+script+'\nSPICEOWL_DISCOVERY_PY\n'
    command+='printf "%s\\n" '+q(end)+'\n'
    argv=['/usr/bin/ssh','-T','-F',str(config_path(ssh_config))]
    for option in (*_SSH_OPTIONS,'StdinNull=no'):argv.extend(('-o',option))
    argv.extend(('--',validate_ssh_target(target),'/bin/sh -s'))
    reply=_transport(argv,command,timeout=60,max_output=output_limit)
    lines=reply.stdout.splitlines();b=begin.encode();e=end.encode()
    prefix=DIRECTORY_SNAPSHOT_PREFIX.encode();snapshots=[line[len(prefix):] for line in lines if line.startswith(prefix)]
    partial=not full_library and reply.returncode==124 and lines.count(b)==1 and lines.count(e)==0 and len(snapshots)==1 and len(snapshots[0])<=65536
    if partial:body=snapshots[0]
    else:
        if reply.returncode or lines.count(b)!=1 or lines.count(e)!=1 or lines.index(b)>=lines.index(e):
            raise ValueError('Bounded PDK discovery did not complete (exit='+str(reply.returncode)+
                ', bytes='+str(len(reply.stdout))+', begin='+str(lines.count(b))+', end='+str(lines.count(e))+')')
        body=b'\n'.join(line for line in lines[lines.index(b)+1:lines.index(e)] if not line.startswith(prefix))
    def unique(pairs):
        result={}
        for k,v in pairs:
            if k in result:raise ValueError('Duplicate discovery JSON field')
            result[k]=v
        return result
    result=json.loads(body,object_pairs_hook=unique,
        parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Nonfinite discovery value')))
    if full_library:
        if len(body)>MAX_LIBRARY_RESULT_BYTES:raise ValueError('Full PDK library observation exceeds its private transport budget')
        validate_pdk_library(result)
        return result
    if result.get('source_sha256')!=requirements['source_sha256'] or result.get('required_masters')!=requirements['required_masters']:
        raise ValueError('Discovery source binding differs')
    checksum=result.get('discovery_id');unsigned={k:v for k,v in result.items() if k!='discovery_id'}
    if checksum!=digest(unsigned):raise ValueError('Discovery evidence digest differs')
    profile_suggestions(result)  # Existing bounded schema and candidate validator.
    if partial:
        if result.get('snapshot') is not True or result.get('phase')!='directory_inventory' or result.get('search_complete') is not False or result.get('entry_candidates')!=[]:
            raise ValueError('Interrupted discovery must remain a directory-only incomplete snapshot')
        result['transport']={'exit_code':124,'completion':'timeout_directory_snapshot'}
        result['discovery_id']=digest({k:v for k,v in result.items() if k!='discovery_id'})
    return result


def public_discovery(rows,discovery_id):
    """Only public candidate metadata; full dependency paths stay backend-side."""
    candidates=[];missing=[];ambiguities=[];coverage=[];directories=[]
    for row in rows:
        probe_id=row['probe_id'];data=row.get('result')
        if data is None:
            missing.append({'field':'discovery','probe_id':probe_id,'code':row['error_code'],
                'message':'No complete discovery observation; check the host or narrow the search directory.'})
            coverage.append({'probe_id':probe_id,'search_complete':False,'status':'unavailable'});continue
        files={r['path']:r for r in data.get('files',[])}
        for choice in data.get('directory_suggestions',[]):
            path=PurePosixPath(choice['path']);label=path.name
            roots=sorted(data.get('roots',[]),key=len,reverse=True)
            for root in roots:
                try:label=PurePosixPath(root).name+'/'+str(path.relative_to(root));break
                except ValueError:pass
            directories.append({'directory_id':digest({'discovery_id':discovery_id,'probe_id':probe_id,'path':choice['path']}),
                'probe_id':probe_id,'label':label,'basis':choice['basis'],'scanned':choice['scanned'],'qualified':False})
        def evidence(value):
            if isinstance(value,list):return [evidence(v) for v in value]
            if isinstance(value,dict):
                out={k:evidence(v) for k,v in value.items() if k not in ('path','entry_path','directory','resolved_path')}
                if value.get('path') in files:out['file_sha256']=files[value['path']]['sha256']
                return out
            return value
        for c in data.get('entry_candidates',[]):
            platforms=[]
            for t in c['tmi_candidates']:
                for p in t['platform_candidates']:
                    identifier=digest({'candidate_id':c['candidate_id'],'relative_library':p['relative_library']})
                    if not any(x['tmi_candidate_id']==identifier for x in platforms):
                        platforms.append({'tmi_candidate_id':identifier,'label':p['relative_library'],
                            'selection_basis':'observed_directory_entry','qualified':False})
            candidates.append({'candidate_id':digest({'probe_id':probe_id,'candidate_id':c['candidate_id']}),'probe_id':probe_id,
                'label':PurePosixPath(c['entry_path']).name,'entry_role':c['entry_role'],
                'available_sections':c['available_sections'],'section_candidates':c['section_candidates'],
                'master_coverage':c['master_coverage'],'model_contracts':evidence(c['models']),
                'tmi_candidates':platforms,'evidence':{'entry_sha256':c['entry_sha256'],
                    'file_count':len(c['dependency_paths']),'coverage_complete':c['coverage_complete']},
                'missing':[{'code':'master_missing','master':m} for m in c['missing_masters']]+
                    [{'code':code} for code in c['unknown_codes']],'ready_to_run':False})
        ambiguities.extend({'probe_id':probe_id,**evidence(r)} for r in data.get('ambiguities',[]))
        coverage.append({'probe_id':probe_id,'search_complete':data['search_complete'],'status':data['status'],
            'file_count':len(files),'bytes_read':data.get('bytes_read'),'unknown_count':data.get('unknown_count'),
            'results_omitted':data.get('results_omitted',False),'summary':data.get('summary'),
            'phase':data.get('phase'),'transport':data.get('transport'),
            'unknown_codes':list(dict.fromkeys(r['code'] for r in data.get('unknown',[])))})
    if not candidates:missing.append({'field':'search_paths','code':'discovery_results_omitted' if any(r.get('results_omitted') for r in coverage) else 'no_model_candidates',
        'message':'Select a narrower PDK directory or provide an optional cds.lib hint.'})
    return {'discovery_id':discovery_id,'candidates':candidates,'ambiguities':ambiguities,
        'missing':missing,'coverage':coverage,'search_directories':directories,'selection_made':False,'simulation_started':False}
