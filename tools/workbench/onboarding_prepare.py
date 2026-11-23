"""Create an isolated runtime only from this intake's source and observations."""
import hashlib
from pathlib import Path
import re
import subprocess

from runner import atomic
from onboarding_recipe import build_intake_recipe
from onboarding_discovery import digest
from spiceowl.onboarding.pdk_discovery import audit_config_for_candidate


def selected_candidate(saved,candidate_id):
    matches=[(row,c) for row in saved['rows'] if row.get('result') for c in row['result']['entry_candidates']
             if digest({'probe_id':row['probe_id'],'candidate_id':c['candidate_id']})==candidate_id]
    if len(matches)!=1:raise ValueError('Select an exact unique candidate from this discovery')
    return matches[0]


def compile_selection(folder,state,args,saved):
    row,candidate=selected_candidate(saved,args['candidate_id'])
    data=row['result'];relative=None;tmi=args.get('tmi_candidate_id')
    if data.get('source_sha256')!=state['source_sha256'] or data.get('required_masters')!=state['source']['requirements']['required_masters']:
        raise ValueError('Selected candidate evidence belongs to a different source')
    platforms={digest({'candidate_id':candidate['candidate_id'],'relative_library':p['relative_library']}):p['relative_library']
        for item in candidate['tmi_candidates'] for p in item['platform_candidates']}
    if tmi is not None:
        if tmi not in platforms:raise ValueError('TMI selection is absent from this exact model candidate')
        relative=platforms[tmi]
    missing=[]
    if platforms and relative is None:
        missing.append({'field':'tmi_candidate_id','code':'tmi_selection_missing','message':'Select an observed TMI platform library.'})
    models=candidate['models']
    if not data['search_complete'] or not candidate['coverage_complete']:
        models=[{**m,'confidence':'unknown','needs_confirmation':True} for m in models]
    source_id='projects/'+state['intake_id']+'/input.scs'
    source_file=folder/'source.scs'
    if source_file.is_symlink() or not source_file.is_file():raise ValueError('Original intake source must remain a regular file')
    compiled=build_intake_recipe(source_file.read_bytes(),state['source']['requirements'],models,
        args['sections'],args['intent'],args.get('model_contracts'),source_id=source_id,
        candidate_sections=candidate['section_candidates'])
    missing.extend(compiled['missing'])
    if missing:return {'missing':missing,'compiled':compiled,'probe_id':row['probe_id']}
    audit=audit_config_for_candidate(data,candidate['candidate_id'],sections=args['sections'],tmi_relative_library=relative)
    return {'missing':[],'compiled':compiled,'probe_id':row['probe_id'],'audit':audit,'candidate':candidate}


def observed_site(capture,target,connection_id,ssh_config):
    """No path guesses: tools/setup/identity must be from the selected probe."""
    private=capture.get('private') or {};identity=private.get('identity',{})
    activation=private.get('activation') or {}
    selected_id=activation.get('selected_source_id')
    setup=[s for s in private.get('setup_candidates',[]) if s.get('source_id')==selected_id]
    spectre=next((t.get('path') for t in private.get('tools',[]) if t.get('kind')=='spectre'),None)
    python=next((t.get('path') for t in private.get('tools',[]) if t.get('kind')=='python'),None)
    missing=[]
    def gap(field,code,message):missing.append({'field':field,'ssh_target':target,'code':code,'message':message})
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}',target):
        gap('ssh_target','submission_requires_ssh_alias','This executor currently requires a literal configured SSH alias.')
    if str(Path(ssh_config).expanduser())!=str(Path.home()/'.ssh/config'):
        gap('ssh_config','executor_ssh_config_unsupported','This executor currently uses the default SSH configuration; an alternate discovery configuration cannot be silently substituted.')
    if not spectre:gap('environment.tools','spectre_not_observed','Select an observed environment setup and probe it explicitly.')
    if len(setup)!=1:gap('environment.setup','setup_selection_missing','Select one observed setup source before preparing this environment.')
    for k in ('hostname','username','home'):
        if not identity.get(k):gap('environment.identity','identity_missing','Remote identity observation is incomplete.')
    if missing:return None,missing
    values=[identity['home'],setup[0]['path'],spectre,python]
    if any(not isinstance(v,str) or not re.fullmatch(r'/[A-Za-z0-9_./+-]+',v) or '..' in Path(v).parts for v in values):
        gap('environment.paths','executor_path_unsupported','Observed paths are outside this executor supported path grammar.')
        return None,missing
    site={'schema':'ic.sim.site.v1','ssh_target':target,
        'remote_runs_root':identity['home']+'/spiceowl_onboarding/'+connection_id+'/ic_on_github_runs',
        'cadence_cshrc':setup[0]['path'],'spectre_bin':spectre,'external_files':{},
        'expected_host':identity['hostname'],'expected_user':identity['username']}
    host={'schema':'spiceowl.host.v1','host_id':target,'label':target,'ssh_target':target,
        'expected_host':identity['hostname'],'expected_user':identity['username'],
        'tools':[{'kind':'spectre','executable':spectre}]}
    return {'site':site,'host':host,'python':python,'setup_sha256':setup[0]['sha256']},[]


def create_child_config(folder,state,compiled_selection,hosts):
    """Write a new explicit source Git snapshot, local-only config and host pool."""
    root=folder/'prepared'/str(state['revision']);root.mkdir(parents=True,mode=0o700)
    seed=root/'source';seed.mkdir(mode=0o700)
    compiled=compiled_selection['compiled'];source=compiled['source'];project=state['intake_id'];recipe=compiled.get('recipe_id','inverter-tran')
    documents=compiled.get('documents') or {source['source_id']:source['text'].encode('utf-8')}
    for name,raw in documents.items():
        if not isinstance(name,str) or not name.startswith('projects/'+project+'/') or '..' in Path(name).parts or Path(name).is_absolute():
            raise ValueError('Prepared source must belong to this explicit intake')
        path=seed/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw);path.chmod(0o600)
    def git(*args):
        p=subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',str(seed),*args],
            capture_output=True,timeout=20)
        if p.returncode:raise ValueError('New intake source snapshot could not be created')
        return p.stdout.decode().strip()
    git('init','-b','main');git('add','--',*documents)
    git('-c','user.name=SpiceOwl local intake','-c','user.email=intake@localhost','commit','-m','Freeze explicitly supplied circuit and experiment sources')
    commit=git('rev-parse','HEAD')
    from spiceowl.hosts import HostRegistry
    registry=HostRegistry(root/'resource-observations');members=[]
    for host_id,observed in hosts.items():
        site_path=root/(host_id+'.site.json');atomic(site_path,observed['site'])
        registry.register(observed['host']);members.append({'host_id':host_id,'site_file':str(site_path)})
    pool={'schema':'ic.spiceowl-pool.v1','spiceowl_data_dir':str(root/'resource-observations'),
        'requirements':{'cpu_count':1,'memory_bytes':512*1024*1024,'simulator':'spectre'},'members':members}
    atomic(root/'pool.json',pool)
    audit_probe=next(p for p in state['probes'] if p['probe_id']==compiled_selection['probe_id'])
    audit_host=audit_probe['ssh_target']
    profile={'electrical':compiled['electrical'],'dependencies':compiled_selection['audit'],
        'expected_main_sha256':compiled_selection['candidate']['entry_sha256'],
        'audit_host':audit_host,'remote_python':hosts[audit_host]['python'],
        'environment_pins':{host:{'cadence_setup':row['setup_sha256']} for host,row in hosts.items()}}
    cfg={'local_only':True,'github_repo':None,'seed_repo':str(seed),'runtime_root':str(root/'runtime'),
        'runtime_branch':'codex/intake','base_branch':'main','site_file':members[0]['site_file'],
        'spiceowl_pool_file':str(root/'pool.json'),'projects':[{'id':project,'source_path':source['source_id'],
            'read_paths':[name for name in documents if name!=source['source_id']],'configurations':[]}],
        'simulation_direct':{'enabled':True,'projects':[project],'hosts':list(hosts),'callers':['local-studio'],
            'operations':['prepare','run','inspect','runtime','watch','collect','status'],'resume_monitors':False},
        'experiment_workflow':{'recipes':[{'id':recipe,'project_id':project,'source_paths':list(documents),
            'selection':compiled['selection'],'spec':compiled['spec'],'model_profile':'intake-model',
            'host_ids':list(hosts),'qualification_checks':['soa_voltage','model_parameter_range'] if recipe=='inverter-tran' else []}],
            'profiles':{'intake-model':profile}}}
    atomic(root/'configuration.json',cfg)
    atomic(root/'source-mapping.json',{'source_id':source['source_id'],'original_source_sha256':source['original_sha256'],
        'compiled_source_sha256':source['sha256'],'transformation':compiled['wrapper']['transformation'],
        'wrapper':compiled['wrapper'],'source_commit':commit,
        **({'file_sha256':{name:hashlib.sha256(raw).hexdigest() for name,raw in documents.items()}} if recipe=='agent-testbench' else {})})
    return cfg,root,commit
