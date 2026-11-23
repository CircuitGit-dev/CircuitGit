"""Fresh user intake, observed discovery and explicit experiment selection.

This store never searches an old app profile, library catalogue or simulation
directory. Initial facts are supplied source bytes and selected SSH targets.
Only the preparation step is allowed to create a circuit Git snapshot.
"""
import concurrent.futures
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import threading

from runner import atomic, locked, stamp, filehash
from spiceowl_pool import read_json, canonical, MAX_RECORD_BYTES
from workspace import Conflict

PREFIX = '/api/simulation/onboarding'
READS = {'ssh-hosts','session','submission','waveforms/catalog','waveforms/mapping','waveforms/window'}
WRITES = {'netlist','probe','discover-pdk','prepare','run','inspect'}
SCHEMA = 'ic.onboarding.session.v1'


def save_discovery_observation(path, data):
    """Preserve complete observed JSON without indentation multiplying its size."""
    raw=canonical(data)+b'\n'
    if len(raw)>MAX_RECORD_BYTES:
        raise ValueError('Complete discovery evidence exceeds the local record budget; narrow the explicit search scope.')
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_name(path.name+'.'+secrets.token_hex(16)+'.tmp')
    try:
        with temporary.open('xb') as stream:
            os.chmod(temporary,0o600);stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
    finally:
        if temporary.exists():temporary.unlink()


def public_session(state):
    """Private captures/configuration never enter the browser session."""
    allowed={'schema','connection_id','intake_id','revision','source_sha256','source_commit',
        'state','created_at','updated_at','source','input_provenance','probes','discovery',
        'prepared','execution_scope','selection','job','inspection','missing','source_mapping','submission',
        'recommended_selection','suggested_intent','intent_suggestions'}
    result={k:copy.deepcopy(v) for k,v in state.items() if k in allowed}
    if 'probes' in result:
        result['probes']=[{k:copy.deepcopy(v) for k,v in row.items() if k in
            {'probe_id','ssh_target','observed_at','environment'}} for row in state['probes']]
        environment_fields={'schema','alias','observed_at','state','transport','identity','session_kind',
            'tools','licenses','resources','setup_candidates','pdk_candidates','library_root_count',
            'warnings','coverage','simulation_started','simulator_invoked_by_probe','selection_basis','error','activation','platform'}
        for row in result['probes']:
            row['environment']={k:v for k,v in row.get('environment',{}).items() if k in environment_fields}
    # Plans retain enough identity to revisit an original job, never a child
    # configuration path, selected remote paths, or signing material.
    result['plans']=[{k:copy.deepcopy(v) for k,v in row.items() if k in
        {'plan_id','source_commit','project_id','recipe_id','submission_key','job_id','dispatch_outcome'}}
        for row in state.get('plans',[])]
    from onboarding_guidance import next_actions
    result['next_actions']=next_actions(result)
    return result


def create_onboarding_config(root, *, resume=False):
    """Initialize only an explicitly selected empty store; no legacy fallback."""
    root=Path(root).expanduser().absolute()
    if root.is_symlink():raise ValueError('Select a regular fresh state directory')
    if root.exists() and not root.is_dir():raise ValueError('Select a regular fresh state directory')
    if resume:
        # Fixed descendants keep this connection isolated even if a local
        # connection file was edited between launches. Do not follow a linked
        # runtime or intake directory merely because the marker still matches.
        for name in ('gateway','intake-store','node','gateway/frozen','gateway/runs','gateway/simulation-runtime'):
            child=root/name
            if child.is_symlink() or (child.exists() and not child.is_dir()):
                raise ValueError('Onboarding state directories must be regular local directories')
        for name in ('gateway/signing.key','node/node-id','node/browser-access.key'):
            child=root/name
            if child.is_symlink() or (child.exists() and not child.is_file()):
                raise ValueError('Onboarding identity files must be regular local files')
        marker=read_json(root/'onboarding-state.json')
        if (type(marker) is not dict or set(marker)!={'schema','connection_id','created_at','source_mode'}
                or marker.get('schema')!='ic.onboarding.store.v1'
                or marker.get('source_mode')!='fresh_explicit_intake'
                or not isinstance(marker.get('created_at'),str)
                or not isinstance(marker.get('connection_id'),str)
                or not re.fullmatch(r'[a-f0-9]{32}',marker['connection_id'])):
            raise ValueError('This is not an onboarding store')
        config=read_json(root/'connection.json')
        if (type(config) is not dict or set(config)!={'local_only','onboarding_only','github_repo','runtime_root','projects','onboarding'}
                or config.get('local_only') is not True or config.get('onboarding_only') is not True
                or config.get('github_repo') is not None or config.get('projects')!=[]
                or type(config.get('projects')) is not list or config.get('runtime_root')!=str(root/'gateway')):
            raise ValueError('Onboarding configuration must retain its isolated local storage')
        onboarding=config['onboarding']
        if (type(onboarding) is not dict or set(onboarding)!={'enabled','state_root','connection_id','ssh_config'}
                or onboarding.get('enabled') is not True or onboarding.get('state_root')!=str(root/'intake-store')):
            raise ValueError('Onboarding configuration must retain its isolated intake storage')
        if onboarding.get('connection_id')!=marker['connection_id']:
            raise ValueError('Onboarding connection identity differs')
        ssh_config=onboarding['ssh_config']
        if (not isinstance(ssh_config,str) or not 1<=len(ssh_config)<=4096
                or any(ord(c)<32 or ord(c)==127 for c in ssh_config)
                or not Path(ssh_config).is_absolute() or '..' in Path(ssh_config).parts):
            raise ValueError('SSH configuration must be an explicit absolute local file path')
        return config
    if root.exists() and any(root.iterdir()):raise ValueError('Fresh onboarding requires an empty state directory')
    root.mkdir(parents=True,exist_ok=True,mode=0o700);root.chmod(0o700)
    connection_id=secrets.token_hex(16)
    atomic(root/'onboarding-state.json',{'schema':'ic.onboarding.store.v1',
        'connection_id':connection_id,'created_at':stamp(),'source_mode':'fresh_explicit_intake'})
    config={'local_only':True,'onboarding_only':True,'github_repo':None,
        'runtime_root':str(root/'gateway'),'projects':[],
        'onboarding':{'enabled':True,'state_root':str(root/'intake-store'),
                      'connection_id':connection_id,'ssh_config':str(Path.home()/'.ssh/config')}}
    atomic(root/'connection.json',config)
    return config


def unconfigured_site():
    # Never executed. A selected, observed host replaces this only in an intake's
    # own prepared runtime; there is no default remote connection.
    return {'schema':'ic.sim.site.v1','ssh_target':'unconfigured',
        'remote_runs_root':'/unconfigured/ic_on_github_runs',
        'cadence_cshrc':'/unconfigured/setup','spectre_bin':'/unconfigured/spectre',
        'external_files':{},'expected_host':'unconfigured','expected_user':'unconfigured'}


class EmptyWorkspace:
    """No source checkout exists before a new intake is prepared."""
    def __init__(self,cfg,key):
        self.cfg=cfg;self.key=key;self.projects={};self.local_only=True;self.repo=None
        self.runtime=Path(cfg['runtime_root']);self.root=self.runtime/'unprepared'
        self.frozen=self.runtime/'frozen';self.frozen.mkdir(parents=True,exist_ok=True)
    def head(self):return None
    def clean(self):return True
    def describe(self):
        return {'repo':None,'branch':None,'tracking_branch':None,'source_commit':None,
            'clean':True,'dirty':False,'projects':[],'active_project':None,
            'capabilities':{'git':False,'runner':False,'publish':False,'viewer':False}}
    def materialize(self,*args,**kwargs):
        raise ValueError('Import and prepare an explicit intake before simulation')


class OnboardingRuntime:
    def __init__(self,app):
        self.app=app;self.config=app.cfg.get('onboarding') or {}
        self.enabled=self.config.get('enabled') is True
        self.root=Path(self.config['state_root']) if self.enabled else None
        self.connection_id=self.config.get('connection_id') if self.enabled else None
        self._children={};self._mutex=threading.RLock()

    def _check(self):
        if not self.enabled:raise PermissionError('This connection has no onboarding capability')

    def _folder(self,intake_id):
        self._check()
        if not isinstance(intake_id,str) or not re.fullmatch(r'intake_[a-f0-9]{32}',intake_id):
            raise ValueError('Use the exact returned intake ID')
        folder=self.root/intake_id
        if folder.is_symlink():raise ValueError('An intake cannot redirect to another store')
        return folder

    def _load(self,intake_id):
        state=read_json(self._folder(intake_id)/'session.json')
        if state.get('intake_id')!=intake_id or state.get('connection_id')!=self.connection_id:
            raise ValueError('Intake belongs to a different connection')
        return state

    def _begin(self,args,operation):
        folder=self._folder(args.get('intake_id'))
        with locked(folder/'session.lock'):
            state=self._load(args['intake_id'])
            if type(args.get('revision')) is not int or state['revision']!=args['revision']:
                raise Conflict('Intake changed; read its latest session before continuing')
            state['revision']+=1;state['state']=operation;state['updated_at']=stamp()
            for field in ({'probe':('probes','discovery','prepared','execution_scope','selection','source_mapping','job','submission','recommended_selection','discovery_search_history'),
                           'discover-pdk':('discovery','prepared','execution_scope','selection','source_mapping','job','submission','recommended_selection'),
                           'prepare':('prepared','execution_scope','job','submission')}.get(operation,())):
                state.pop(field,None)
            atomic(folder/'session.json',state)
        return folder,state

    def _finish(self,folder,snapshot,**updates):
        with locked(folder/'session.lock'):
            current=self._load(snapshot['intake_id'])
            if current['revision']!=snapshot['revision']:
                raise Conflict('This discovery reply is stale for the current intake')
            current.update(updates,updated_at=stamp())
            from onboarding_recommendations import bound_session_recommendations
            bound_session_recommendations(current,public_session)
            atomic(folder/'session.json',current)
        return public_session(current)

    def read(self,operation,args,*,origin='interactive_client'):
        self._check()
        if operation=='ssh-hosts':
            if args:raise ValueError('SSH listing has no caller-supplied file path')
            from spiceowl.onboarding.ssh_discovery import discover_ssh_hosts
            return discover_ssh_hosts(self.config['ssh_config'])
        if operation=='session' and set(args)=={'intake_id'}:return public_session(self._load(args['intake_id']))
        if operation=='submission' and set(args)=={'intake_id','plan_id'}:
            return self._submission(args)
        if operation in {'waveforms/catalog','waveforms/mapping','waveforms/window'}:
            from onboarding_waveforms import OnboardingWaveforms
            return OnboardingWaveforms(self._waveform_binding).read(operation.split('/')[1],args)
        raise ValueError('Unknown bounded onboarding read')

    def write(self,operation,args,*,origin='interactive_client'):
        self._check()
        if origin not in ('interactive_client','native_agent','test_harness'):
            raise PermissionError('Unsupported onboarding entry point')
        if not isinstance(args,dict):raise ValueError('Onboarding arguments must be an object')
        methods={'netlist':self._netlist,'probe':self._probe,'discover-pdk':self._discover,
                 'prepare':self._prepare,'run':self._run,'inspect':self._inspect}
        if operation not in methods:raise ValueError('Unknown finite onboarding operation')
        if operation=='netlist':return methods[operation](args,origin)
        with locked(self._folder(args.get('intake_id'))/'operation.lock'):
            return methods[operation](args,origin)

    def _netlist(self,args,origin):
        if set(args)!={'file_name','text'}:raise ValueError('Provide only the new file label and literal text')
        name=args['file_name'];text=args['text']
        if not isinstance(name,str) or not 1<=len(name)<=240 or any(ord(c)<32 for c in name):
            raise ValueError('Invalid input display name')
        from spiceowl.onboarding.pdk_discovery import inspect_netlist
        requirements=inspect_netlist(text,source_id=name)
        from onboarding_recommendations import source_intent
        suggested_intent,intent_suggestions=source_intent(requirements)
        intake_id='intake_'+secrets.token_hex(16);folder=self._folder(intake_id)
        folder.mkdir(parents=True,mode=0o700)
        source=folder/'source.scs';source.write_text(text,encoding='utf-8');source.chmod(0o600)
        state={'schema':SCHEMA,'connection_id':self.connection_id,'intake_id':intake_id,
            'revision':1,'source_sha256':requirements['source_sha256'],'source_commit':None,
            'state':'source_inspected','created_at':stamp(),'updated_at':stamp(),
            'source':{'file_name':name,'source_sha256':requirements['source_sha256'],
                      'source_commit':None,'requirements':requirements},
            'input_provenance':[{'kind':'netlist','origin':origin,'sha256':requirements['source_sha256']}],
            'plans':[],'suggested_intent':suggested_intent,'intent_suggestions':intent_suggestions,
            'recommended_selection':None}
        atomic(folder/'session.json',state)
        return public_session(state)

    def _probe(self,args,origin):
        if set(args)-{'intake_id','revision','ssh_targets','overrides'} or not {'intake_id','revision','ssh_targets'}<=set(args):
            raise ValueError('Select explicit SSH targets for this intake')
        from spiceowl.onboarding.environment import capture_server_environment,activate_observed_environment
        from spiceowl.onboarding.ssh_discovery import validate_ssh_target
        targets=args['ssh_targets']
        if not isinstance(targets,list) or not 1<=len(targets)<=8 or len(set(targets))!=len(targets):
            raise ValueError('Select one to eight distinct SSH targets')
        for target in targets:validate_ssh_target(target)
        overrides=args.get('overrides') or {}
        if not isinstance(overrides,dict) or set(overrides)-{'setup_source_ids'}:
            raise ValueError('Only selection of already observed setup_source_ids is supported')
        setup_ids=overrides.get('setup_source_ids',{})
        if not isinstance(setup_ids,dict) or set(setup_ids)-set(targets):
            raise ValueError('Setup selections must belong to the selected SSH targets')
        previous=self._load(args['intake_id']);selected_setups={}
        for target,setup_id in setup_ids.items():
            previous_probes=[p for p in previous.get('probes',[]) if p['ssh_target']==target and p.get('probe_id')]
            if len(previous_probes)!=1:raise ValueError('Probe this host before selecting one observed setup')
            capture=read_json(self._folder(previous['intake_id'])/'probes'/(previous_probes[0]['probe_id']+'.json'))
            selected=[r for r in (capture.get('private') or {}).get('setup_candidates',[]) if r.get('source_id')==setup_id]
            if len(selected)!=1:raise ValueError('Select an exact setup candidate observed on this host')
            selected_setups[target]=selected[0]
        folder,state=self._begin(args,'probe')
        def observe(target):
            try:
                observed=capture_server_environment(target,self.config['ssh_config'])
                if target in selected_setups:
                    selected=selected_setups[target]
                    fresh=[r for r in (observed.get('private') or {}).get('setup_candidates',[]) if r.get('source_id')==selected['source_id']]
                    if len(fresh)!=1 or any(fresh[0].get(k)!=selected.get(k) for k in ('path','sha256')):
                        return {'probe_id':None,'ssh_target':target,'observed_at':stamp(),
                            'environment':{'state':'missing','error_code':'setup_source_changed','simulation_started':False}}
                    observed=activate_observed_environment(target,self.config['ssh_config'],observed,selected['source_id'])
                if observed.get('private') is None:
                    return {'probe_id':None,'ssh_target':target,'observed_at':stamp(),'environment':observed['public']}
                probe_id='probe_'+secrets.token_hex(16)
                atomic(folder/'probes'/(probe_id+'.json'),observed)
                return {'probe_id':probe_id,'ssh_target':target,'observed_at':stamp(),
                        'environment':observed['public']}
            except Exception as error:
                return {'probe_id':None,'ssh_target':target,'observed_at':stamp(),
                        'environment':{'state':'unavailable','error_code':getattr(error,'code','environment_probe_failed')}}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            probes=list(workers.map(observe,targets))
        return self._finish(folder,state,state='hosts_observed',probes=probes,
            input_provenance=state['input_provenance']+[{'kind':'ssh_selection','origin':origin,'ssh_targets':targets,
                'setup_source_ids':copy.deepcopy(setup_ids)}])

    def _discover(self,args,origin):
        required={'intake_id','revision','probe_ids'}
        if not required<=set(args) or set(args)-required-{'search_paths','cds_lib_hint','search_directory_ids'}:
            raise ValueError('Use the explicit probe identities and optional search hints')
        previous=self._load(args['intake_id']);ids=args['probe_ids']
        if not isinstance(ids,list) or not 1<=len(ids)<=8 or any(not isinstance(x,str) for x in ids) or len(set(ids))!=len(ids):
            raise ValueError('Select one to eight exact probe IDs')
        selected=[p for p in previous.get('probes',[]) if p['probe_id'] in ids]
        if len(selected)!=len(ids):raise ValueError('Probe does not belong to the current intake revision')
        hints=args.get('search_paths')
        roots_by_probe={}
        if 'search_directory_ids' in args:
            requested=args['search_directory_ids']
            if hints or not isinstance(requested,list) or not 1<=len(requested)<=8 or any(not isinstance(x,str) for x in requested) or len(set(requested))!=len(requested):
                raise ValueError('Select one to eight observed directories, without simultaneous path hints')
            old_id=(previous.get('discovery') or {}).get('discovery_id')
            if not old_id:raise ValueError('Directory choices require a previous discovery observation')
            from onboarding_discovery import digest
            old=read_json(self._folder(previous['intake_id'])/'discoveries'/(old_id+'.json'))
            resolved=set()
            for row in old['rows']:
                if row['probe_id'] not in ids:continue
                for choice in (row.get('result') or {}).get('directory_suggestions',[]):
                    cid=digest({'discovery_id':old_id,'probe_id':row['probe_id'],'path':choice['path']})
                    if cid in requested:
                        roots_by_probe.setdefault(row['probe_id'],[]).append(choice['path']);resolved.add(cid)
            if resolved!=set(requested) or set(roots_by_probe)!=set(ids):
                raise ValueError('Directory choices must belong to every selected current probe and discovery')
        if hints is not None and (not isinstance(hints,list) or not 1<=len(hints)<=8 or any(not isinstance(x,str) or not x.startswith('/') or len(x)>4096 for x in hints)):
            raise ValueError('Search paths must be one to eight explicit absolute directories')
        if args.get('cds_lib_hint') is not None and (not isinstance(args['cds_lib_hint'],str) or not args['cds_lib_hint'].startswith('/') or len(args['cds_lib_hint'])>4096):
            raise ValueError('Use one explicit absolute cds.lib hint')
        folder,state=self._begin(args,'discover-pdk')
        from onboarding_discovery import remote_discovery,public_discovery,record_search_progress
        def discover(probe):
            capture=read_json(folder/'probes'/(probe['probe_id']+'.json'))
            search_roots=roots_by_probe.get(probe['probe_id'],hints)
            if not search_roots:
                search_roots=[row['path'] for row in (capture.get('private') or {}).get('pdk_candidates',[])
                              if row.get('exists')]
            try:
                result=remote_discovery(probe['ssh_target'],self.config['ssh_config'],capture,
                    state['source']['requirements'],roots_by_probe.get(probe['probe_id'],hints),args.get('cds_lib_hint'))
                return {'probe_id':probe['probe_id'],'result':result,'search_roots':search_roots,
                        'platform':(capture.get('private') or {}).get('platform') or (capture.get('public') or {}).get('platform')}
            except Exception as error:
                atomic(folder/'discovery-errors'/(probe['probe_id']+'.json'),{'error':str(error)[:2000]})
                return {'probe_id':probe['probe_id'],'result':None,'search_roots':search_roots,
                        'error_code':'pdk_discovery_incomplete'}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:rows=list(workers.map(discover,selected))
        discovery_id='discovery_'+secrets.token_hex(16)
        save_discovery_observation(folder/'discoveries'/(discovery_id+'.json'),
                                   {'rows':rows,'source_sha256':state['source_sha256']})
        public=public_discovery(rows,discovery_id)
        search_history=record_search_progress(public,rows,state['source_sha256'],
                                               state.get('discovery_search_history'))
        from onboarding_recommendations import attach_recommendations,source_intent
        public=attach_recommendations(public,rows,state)
        recommended=public['recommended_selection']
        values,suggestions=source_intent(state['source']['requirements'])
        if recommended:
            values=recommended['intent']
            suggestions={'preset':recommended['provenance']['preset'],
                'fields':recommended['provenance']['fields']['intent'],'requires_acceptance':True,
                'scientific_intent_discovered':False}
        return self._finish(folder,state,state='models_discovered',discovery=public,
            discovery_search_history=search_history,
            recommended_selection=recommended,suggested_intent=values,intent_suggestions=suggestions,
            input_provenance=state['input_provenance']+[{'kind':'pdk_search','origin':origin,
                'probe_ids':ids,'explicit_search_paths':hints or [],'search_directory_ids':args.get('search_directory_ids',[]),
                'explicit_cds_lib_hint':args.get('cds_lib_hint')}])

    def _prepare(self,args,origin):
        previous=self._load(args['intake_id'])
        if not previous.get('discovery'):
            raise ValueError('Discover models for this intake before preparing an experiment')
        if any(p.get('dispatch_outcome') in ('attempting','unknown') for p in previous['plans']):
            raise Conflict('Reconcile the original uncertain submission before preparing another experiment')
        from onboarding_recommendations import resolve_preparation
        supplied_model_contracts=copy.deepcopy(args.get('model_contracts'))
        resolved,selection_missing,selection_provenance=resolve_preparation(previous,args)
        folder,state=self._begin(args,'prepare')
        if selection_missing:
            prepared={'schema':'ic.experiment.plan.v1','state':'blocked','project_id':state['intake_id'],
                'recipe_id':'inverter-tran','source_commit':None,'plan_id':None,'missing':selection_missing,'submission_key':None}
            selection={k:copy.deepcopy(resolved[k]) for k in ('discovery_id','candidate_id','sections','tmi_candidate_id','model_contracts','intent')} if resolved else None
            return self._finish(folder,state,state='needs_input',prepared=prepared,selection=selection,
                input_provenance=state['input_provenance']+[{'kind':'experiment_selection','origin':origin,
                    'recommendation':selection_provenance}])
        args=resolved
        from onboarding_prepare import compile_selection,observed_site,create_child_config
        saved=read_json(folder/'discoveries'/(args['discovery_id']+'.json'))
        if saved['source_sha256']!=state['source_sha256']:raise ValueError('Discovery source digest changed')
        selected=compile_selection(folder,state,args,saved);missing=selected['missing'];hosts={}
        exclusions=[]
        for probe in state.get('probes',[]):
            if not probe.get('probe_id'):continue
            capture=read_json(folder/'probes'/(probe['probe_id']+'.json'))
            observed,gaps=observed_site(capture,probe['ssh_target'],self.connection_id,self.config['ssh_config'])
            if observed:hosts[probe['ssh_target']]=observed
            else:exclusions.extend(gaps)
            if probe['probe_id']==selected['probe_id']:missing.extend(gaps)
        if not hosts and not missing:missing.append({'field':'hosts','code':'no_preparable_host','message':'No selected host has a complete observed environment.'})
        selection={k:copy.deepcopy(args[k]) for k in ('discovery_id','candidate_id','sections','tmi_candidate_id','model_contracts','intent')}
        effective_models=(selected.get('compiled',{}).get('electrical') or {}).get('models')
        if effective_models is not None:
            selection['model_contracts']=copy.deepcopy(effective_models)
        provenance=state['input_provenance']+[{'kind':'experiment_selection','origin':origin,
            'discovery_id':args['discovery_id'],'candidate_id':args['candidate_id'],'intent':copy.deepcopy(args['intent']),
            'sections':copy.deepcopy(args['sections']),'tmi_candidate_id':args['tmi_candidate_id'],
            'explicit_model_contracts':supplied_model_contracts,
            'recommendation':selection_provenance}]
        scope={'selected_ssh_targets':[p['ssh_target'] for p in state.get('probes',[])],
            'candidate_host_ids':list(hosts),'selection_mode':'automatic_within_selected_hosts',
            'resource_check_at_run':True,'excluded_before_preparation':exclusions}
        if missing:
            prepared={'schema':'ic.experiment.plan.v1','state':'blocked','project_id':state['intake_id'],
                'recipe_id':'inverter-tran','source_commit':None,'plan_id':None,'missing':missing,'submission_key':None}
            return self._finish(folder,state,state='needs_input',prepared=prepared,selection=selection,
                input_provenance=provenance,execution_scope=scope)
        cfg,child_root,commit=create_child_config(folder,state,selected,hosts)
        from server import Application
        child=Application(cfg,self.app.web)
        with self._mutex:self._children[str(child_root)]=child
        prepared=child.simulation.control('prepare',{'project_id':state['intake_id'],
            'recipe_id':'inverter-tran','source_commit':commit},None,'local-studio')
        prepared['submission_key']='experiment-'+prepared['plan_id'] if prepared['plan_id'] else None
        mapping=read_json(child_root/'source-mapping.json');plans=state['plans']
        if prepared['plan_id']:
            plans=plans+[{'plan_id':prepared['plan_id'],'source_commit':commit,'project_id':state['intake_id'],
                'recipe_id':'inverter-tran','submission_key':prepared['submission_key'],
                'child_revision':state['revision'],'dispatch_outcome':'not_requested','source_mapping':mapping,
                'configuration_sha256':filehash(child_root/'configuration.json'),
                'pool_sha256':filehash(child_root/'pool.json'),
                'site_sha256':{h:filehash(child_root/(h+'.site.json')) for h in hosts}}]
        return self._finish(folder,state,state='prepared' if prepared['plan_id'] else 'needs_input',
            source_commit=commit,source={**state['source'],'source_commit':commit},prepared=prepared,
            selection=selection,plans=plans,input_provenance=provenance,execution_scope=scope,source_mapping=mapping)

    def _plan_row(self,state,plan_id):
        rows=[p for p in state['plans'] if p['plan_id']==plan_id]
        if len(rows)!=1:raise ValueError('Plan does not belong to this intake')
        return rows[0]

    def _child(self,state,plan):
        revision=plan.get('child_revision')
        if type(revision) is not int or revision<1:raise ValueError('Invalid prepared child identity')
        root=self._folder(state['intake_id'])/'prepared'/str(revision)
        with self._mutex:
            if str(root) in self._children:return self._children[str(root)]
            # Restore only the exact runtime produced here. GET cannot create a
            # replacement checkout when saved state is missing or redirected.
            for path in (root.parent,root,root/'runtime',root/'runtime/workspace',root/'runtime/workspace/.git',root/'source',
                         root/'runtime/frozen',root/'runtime/runs'):
                if path.is_symlink() or not path.is_dir():raise ValueError('Original intake runtime is unavailable')
            files=[root/'configuration.json',root/'pool.json',root/'runtime/signing.key']
            for host in plan.get('site_sha256',{}):
                if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}',host):raise ValueError('Invalid saved site identity')
                files.append(root/(host+'.site.json'))
            if any(path.is_symlink() or not path.is_file() for path in files):
                raise ValueError('Original intake files cannot redirect to other storage')
            if filehash(root/'configuration.json')!=plan.get('configuration_sha256') or filehash(root/'pool.json')!=plan.get('pool_sha256'):
                raise ValueError('Original intake configuration hash differs')
            for host,checksum in plan.get('site_sha256',{}).items():
                if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}',host) or filehash(root/(host+'.site.json'))!=checksum:
                    raise ValueError('Original intake site hash differs')
            cfg=read_json(root/'configuration.json')
            if (cfg.get('local_only') is not True or cfg.get('github_repo') is not None
                    or cfg.get('runtime_root')!=str(root/'runtime') or cfg.get('seed_repo')!=str(root/'source')
                    or cfg.get('ai_client_config') or cfg.get('source_repository') or cfg.get('onboarding')
                    or cfg.get('spiceowl_pool_file')!=str(root/'pool.json')
                    or {p.get('id') for p in cfg.get('projects',[])}!={state['intake_id']}):
                raise ValueError('Stored intake runtime configuration differs from its original scope')
            from server import Application
            child=Application(cfg,self.app.web);self._children[str(root)]=child
            return child

    def _run(self,args,origin):
        if set(args)!={'intake_id','revision','plan_id'}:raise ValueError('Run requires exact intake revision and prepared plan')
        folder=self._folder(args['intake_id'])
        with locked(folder/'submission.lock'):
            state=self._load(args['intake_id']);plan=self._plan_row(state,args['plan_id'])
            if (state.get('prepared') or {}).get('plan_id')!=plan['plan_id']:
                raise Conflict('This is a historical plan; use original-key lookup and saved waveform reads without changing the current intake')
            if plan.get('dispatch_outcome')!='not_requested':
                receipt=self._submission({'intake_id':state['intake_id'],'plan_id':plan['plan_id']})
                return {**public_session(self._load(state['intake_id'])),'job':receipt['job'],'submission':receipt}
            folder,state=self._begin(args,'submitting');plan=self._plan_row(state,plan['plan_id'])
            # Persist before entering Runner. A crash before reservation is still
            # ambiguous to a remote client and never authorizes an automatic replay.
            plan.update(dispatch_outcome='attempting',entry_origin=origin)
            atomic(folder/'session.json',state)
            child=self._child(state,plan)
            from experiment_workflow import PreDispatchRejected
            try:
                job=child.simulation.control('run',{'project_id':plan['project_id'],'plan_id':plan['plan_id']},
                    plan['submission_key'],'local-studio')
            except PreDispatchRejected as error:
                rejection={'schema':'ic.experiment.pre-dispatch-rejection.v1','plan_id':plan['plan_id'],
                    'project_id':plan['project_id'],'source_commit':plan['source_commit'],
                    'submission_key':plan['submission_key'],'phase':'before_runner_reserve',
                    'code':error.code,'launch_attempted':False,'recorded_at':stamp()}
                plan.update(dispatch_outcome='pre_dispatch_rejected',rejection=rejection)
                submission={'intake_id':state['intake_id'],'plan_id':plan['plan_id'],'found':False,'run_id':None,
                    'submission_key':plan['submission_key'],'dispatch_outcome':'pre_dispatch_rejected',
                    'replay_permitted':False,'job':None,'rejection':rejection}
                return self._finish(folder,state,state='pre_dispatch_rejected',plans=state['plans'],job=None,submission=submission)
            except Exception as error:
                plan['dispatch_outcome']='unknown';atomic(folder/'submission-error.json',{'message':str(error)[:2000]})
                self._finish(folder,state,state='submission_uncertain',plans=state['plans'])
                raise
            plan.update(dispatch_outcome='recorded',job_id=job['job_id'])
            return self._finish(folder,state,state='submitted',plans=state['plans'],job=job)

    def _inspect(self,args,origin):
        if set(args)!={'intake_id','job_id'}:raise ValueError('Inspect requires the original intake and job')
        state,plan,child=self._bound_job(args['intake_id'],args['job_id'])
        if (state.get('prepared') or {}).get('plan_id')!=plan['plan_id']:
            raise Conflict('This job belongs to a historical plan. The current intake is unchanged; use its original-job waveform reads for saved data. Historical active inspection is not supported by this session endpoint.')
        job=child.simulation.control('inspect',{'project_id':plan['project_id'],'job_id':args['job_id']},None,'local-studio')
        from onboarding_waveforms import OnboardingWaveforms
        job['waveforms']=OnboardingWaveforms(self._waveform_binding).describe(state['intake_id'],args['job_id'])
        folder=self._folder(state['intake_id'])
        with locked(folder/'session.lock'):
            current=self._load(state['intake_id'])
            if (current.get('prepared') or {}).get('plan_id')==plan['plan_id']:
                current.update(job=job,updated_at=stamp())
                atomic(folder/'session.json',current)
            response=public_session(current);response['job']=job
        return response

    def _submission(self,args):
        state=self._load(args['intake_id'])
        plan=self._plan_row(state,args['plan_id']);child=self._child(state,plan)
        rid=child.runner.lookup_submission(plan['submission_key']);job=None
        if rid:
            from experiment_workflow import ExperimentWorkflow
            workflow=ExperimentWorkflow(child.simulation);record=workflow._bound(rid,plan['project_id'])
            if record['experiment']['plan_id']!=plan['plan_id']:raise ValueError('Submission belongs to a different plan')
            job=workflow._job(record,plan['plan_id'])
            with locked(self._folder(state['intake_id'])/'session.lock'):
                state=self._load(state['intake_id']);saved=self._plan_row(state,plan['plan_id'])
                saved.update(job_id=rid,dispatch_outcome='recorded')
                if (state.get('prepared') or {}).get('plan_id')==plan['plan_id']:
                    state.update(job=job,state='submitted',updated_at=stamp())
                atomic(self._folder(state['intake_id'])/'session.json',state)
        return {'intake_id':state['intake_id'],'plan_id':args['plan_id'],
            'found':bool(rid),'run_id':rid,'submission_key':plan['submission_key'],
            'dispatch_outcome':'recorded' if rid else plan.get('dispatch_outcome','unknown'),
            'replay_permitted':False,'job':job,
            **({'rejection':plan['rejection']} if not rid and plan.get('dispatch_outcome')=='pre_dispatch_rejected' else {})}

    def _bound_job(self,intake_id,job_id):
        state=self._load(intake_id)
        matches=[p for p in state['plans'] if p.get('job_id')==job_id]
        if len(matches)!=1:raise ValueError('Job does not belong to this intake; reconcile its original plan if necessary')
        plan=matches[0];child=self._child(state,plan)
        from experiment_workflow import ExperimentWorkflow
        record=ExperimentWorkflow(child.simulation)._bound(job_id,plan['project_id'])
        if record['experiment']['plan_id']!=plan['plan_id'] or record['source_commit']!=plan['source_commit']:
            raise ValueError('Job and frozen intake plan differ')
        return state,plan,child

    def _waveform_binding(self,intake_id,job_id):
        from onboarding_waveforms import WaveformBinding
        state,plan,child=self._bound_job(intake_id,job_id)
        mapping=plan['source_mapping'];record=child.runner.read(job_id)
        return WaveformBinding(intake_id,job_id,job_id,plan['source_commit'],child.waveforms,
            archive_sha256=(record.get('collection') or {}).get('sha256'),
            original_source_sha256=mapping['original_source_sha256'],
            compiled_source_sha256=mapping['compiled_source_sha256'],transformation=mapping['transformation'],
            compiled_source_path=mapping['source_id'])

    def close(self):
        for child in self._children.values():
            child.simulation.close();child.pool.shutdown(wait=False)
