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
READS = {'ssh-hosts','session','source','submission','waveforms/catalog','waveforms/mapping','waveforms/window','agent-tb','agent-tb/draft','agent-tb/review','pdk-scopes'}
WRITES = {'netlist','ssh-browse','ssh-import','probe','discover-pdk','veriloga-headers','prepare','run','inspect','agent-tb/draft','agent-tb/prepare','analysis','select-pdk-scope'}
SCHEMA = 'ic.onboarding.session.v1'
IN_PROGRESS={'probe','discover-pdk','veriloga-headers','prepare','agent-tb/draft','agent-tb/prepare','submitting','select-pdk-scope'}


def save_discovery_observation(path, data):
    """Preserve complete observed JSON without indentation multiplying its size."""
    return _save_observation(path,data,MAX_RECORD_BYTES)


def save_library_observation(path,data):
    """Private whole-library storage has its own bound, never a public payload."""
    from spiceowl.onboarding.pdk_discovery import MAX_LIBRARY_RESULT_BYTES,validate_pdk_library
    validate_pdk_library(data)
    return _save_observation(path,data,MAX_LIBRARY_RESULT_BYTES)


def _save_observation(path,data,limit):
    raw=canonical(data)+b'\n'
    if len(raw)>limit:
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
        'recommended_selection','suggested_intent','intent_suggestions','agent_tb','agent_tb_review','mode','support_files','analysis','operation','veriloga_headers','pdk_scope_selection'}
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
        {'plan_id','source_commit','project_id','recipe_id','submission_key','job_id','dispatch_outcome',
         'draft_id','review_id','review_digest','testbench_sha256'}}
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
        self._children={};self._mutex=threading.RLock();self._operation_owner=secrets.token_hex(16);self._active_operations={}
        if self.enabled:
            from onboarding_review import TestbenchReviews
            self.reviews=TestbenchReviews(self)
            self.review_authority_key_file=self.reviews.key_file

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

    def _stalled(self,state):
        if state.get('state') not in IN_PROGRESS:return False
        operation=state.get('operation') or {}
        with self._mutex:
            return not (operation.get('status')=='active' and operation.get('owner')==self._operation_owner
                and self._active_operations.get(state['intake_id'])==operation.get('operation_id'))

    def _public(self,state):
        result=public_session(state)
        if self._stalled(state):
            operation=state.get('operation') or {}
            result.update(state='recovery_required',recovery={'status':'interrupted','operation':state['state'],
                'operation_id':operation.get('operation_id'),'started_at':operation.get('started_at'),
                'requires_human':True,'automatic_retry':False,'original_records_preserved':True})
            plan=(state.get('prepared') or {}).get('plan_id') if state['state']=='submitting' else None
            result['next_actions']=[{'id':'submission' if plan else 'session',
                'tool':'ic_onboarding_submission' if plan else 'ic_onboarding_session',
                'operation':'submission' if plan else 'session','kind':'read','ready':False,
                'arguments':{'intake_id':state['intake_id'],**({'plan_id':plan} if plan else {})},
                'missing':[{'field':'operation','code':'interrupted_operation_requires_review',
                    'message':'The original operation has no active local owner. Human recovery is required; do not repeat remote work.'}],
                'reason_code':'interrupted_operation_requires_review',
                'description':'Inspect the original submission receipt before any recovery; never replay or change its key.' if plan else
                    'Stop automatic polling. Review the preserved interrupted operation before explicitly restoring this intake.'}]
        return result

    def _require_operable(self,state):
        if self._stalled(state):raise Conflict('This intake has an interrupted operation. Human recovery is required; read its preserved session and original submission without replaying remote work.')

    def _begin(self,args,operation):
        folder=self._folder(args.get('intake_id'))
        with locked(folder/'session.lock'):
            state=self._load(args['intake_id'])
            self._require_operable(state)
            if type(args.get('revision')) is not int or state['revision']!=args['revision']:
                raise Conflict('Intake changed; read its latest session before continuing')
            if operation in ('probe','discover-pdk','select-pdk-scope') and any(
                    plan.get('dispatch_outcome') in ('attempting','unknown') for plan in state.get('plans',[])):
                raise Conflict('Reconcile the original uncertain submission before changing its source/probe scope binding')
            state['revision']+=1;state['state']=operation;state['updated_at']=stamp()
            operation_id=secrets.token_hex(16)
            state['operation']={'operation_id':operation_id,'owner':self._operation_owner,'kind':operation,
                'status':'active','started_at':stamp()}
            with self._mutex:self._active_operations[state['intake_id']]=operation_id
            if operation in ('probe','discover-pdk','veriloga-headers','prepare','agent-tb/draft','agent-tb/prepare','select-pdk-scope'):
                state.pop('agent_tb_review',None)
            if operation in ('probe','discover-pdk','select-pdk-scope'):
                state.pop('pdk_scope_selection',None)
                if state.get('agent_tb'):
                    # Keep the old draft's literal text, selection and digest.
                    # Preparation needs a newly saved explicit binding.
                    state['agent_tb']={**state['agent_tb'],'status':'binding_stale'}
            for field in ({'probe':('probes','discovery','prepared','execution_scope','selection','source_mapping','job','submission','recommended_selection','discovery_search_history','veriloga_headers'),
                           'discover-pdk':('discovery','prepared','execution_scope','selection','source_mapping','job','submission','recommended_selection'),
                           'veriloga-headers':('prepared','execution_scope','job','submission'),
                           'select-pdk-scope':('prepared','execution_scope','selection','source_mapping','job','submission','recommended_selection'),
                           'prepare':('prepared','execution_scope','job','submission'),
                           'agent-tb/draft':('prepared','execution_scope','job','submission','source_mapping'),
                           'agent-tb/prepare':('prepared','execution_scope','job','submission')}.get(operation,())):
                state.pop(field,None)
            atomic(folder/'session.json',state)
        return folder,state

    def _finish(self,folder,snapshot,**updates):
        with locked(folder/'session.lock'):
            current=self._load(snapshot['intake_id'])
            if current['revision']!=snapshot['revision']:
                raise Conflict('This discovery reply is stale for the current intake')
            current.update(updates,updated_at=stamp())
            if current.get('operation',{}).get('owner')==self._operation_owner:
                current['operation'].update(status='completed',finished_at=stamp())
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
        if operation=='session' and set(args)=={'intake_id'}:return self._public(self._load(args['intake_id']))
        if operation=='pdk-scopes':return self._pdk_scopes(args)
        if operation=='source' and set(args)=={'intake_id'}:
            from onboarding_testbench import source_inputs
            state=self._load(args['intake_id']);raw,support=source_inputs(self._folder(state['intake_id']),state)
            result={'schema':'ic.onboarding.source.v1','connection_id':self.connection_id,
                'intake_id':state['intake_id'],'revision':state['revision'],'source_sha256':state['source_sha256'],
                'source':{'file_name':state['source']['file_name'],'text':raw.decode('utf-8'),'sha256':state['source_sha256']},
                'support_files':{name:{'text':text.decode('utf-8'),'sha256':hashlib.sha256(text).hexdigest()}
                    for name,text in support.items()}}
            if len(json.dumps({'ok':True,'data':result},ensure_ascii=False).encode())>2*1024*1024:
                raise ValueError('Supplied source bundle exceeds the bounded source-read response size')
            return result
        if operation in ('agent-tb','agent-tb/draft') and set(args)=={'intake_id'}:
            return self._public(self._load(args['intake_id']))
        if operation=='agent-tb/review' and set(args)=={'intake_id','review_id'}:
            return self.reviews.read(args['intake_id'],args['review_id'])
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
        methods={'netlist':self._netlist,'ssh-browse':self._ssh_browse,'ssh-import':self._ssh_import,
                 'probe':self._probe,'discover-pdk':self._discover,'veriloga-headers':self._veriloga_headers,
                 'select-pdk-scope':self._select_pdk_scope,
                 'prepare':self._prepare,'run':self._run,'inspect':self._inspect,
                 'agent-tb/draft':self._agent_draft,'agent-tb/prepare':self._agent_prepare,'analysis':self._analysis}
        if operation not in methods:raise ValueError('Unknown finite onboarding operation')
        if operation in ('netlist','ssh-browse','ssh-import'):return methods[operation](args,origin)
        with locked(self._folder(args.get('intake_id'))/'operation.lock'):
            self._require_operable(self._load(args['intake_id']))
            try:return methods[operation](args,origin)
            finally:
                with self._mutex:self._active_operations.pop(args['intake_id'],None)

    def _pdk_scopes(self,args):
        from onboarding_pdk_scope import library_catalog
        folder=self._folder(args.get('intake_id'))
        state=self._load(args['intake_id'])
        return library_catalog(folder,state,args)

    def _select_pdk_scope(self,args,origin):
        from onboarding_pdk_scope import project_selection,save_scope_selection
        previous=self._load(args['intake_id'])
        if type(args.get('revision')) is not int or previous['revision']!=args['revision']:
            raise Conflict('Intake changed; read its latest session before selecting cached PDK scopes')
        if any(plan.get('dispatch_outcome') in ('attempting','unknown') for plan in previous.get('plans',[])):
            raise Conflict('Reconcile the original uncertain submission before selecting another PDK scope')
        context,selection=project_selection(self._folder(args['intake_id']),previous,args)
        folder,state=self._begin(args,'select-pdk-scope')
        public=save_scope_selection(folder,context,selection)
        return self._finish(folder,state,state='models_discovered',pdk_scope_selection=public,
            input_provenance=state['input_provenance']+[{'kind':'cached_pdk_scope_selection','origin':origin,
                'probe_id':public['probe_id'],'library_id':public['library_id'],
                'selection_id':public['selection_id']}])

    def _netlist(self,args,origin):
        if not {'file_name','text'}<=set(args) or set(args)-{'file_name','text','mode','support_files'}:
            raise ValueError('Provide the file label, literal text and optional agent-TB source bundle')
        agent=args.get('mode')=='agent-tb'
        if 'mode' in args and not agent:raise ValueError('Only the explicit agent-tb import mode is supported')
        if not agent and 'support_files' in args:raise ValueError('Supporting sources require agent-tb mode')
        name=args['file_name'];text=args['text']
        if not isinstance(name,str) or not 1<=len(name)<=240 or any(ord(c)<32 for c in name):
            raise ValueError('Invalid input display name')
        from spiceowl.onboarding.pdk_discovery import inspect_netlist
        support=args.get('support_files',{})
        if agent:
            from spiceowl.onboarding.agent_tb import inspect_agent_source
            if type(support) is not dict or any(not isinstance(v,str) for v in support.values()):
                raise ValueError('Supporting sources must be literal UTF-8 text')
            requirements=inspect_agent_source(text,source_id='dut.scs',support_files=support)
            suggested_intent,intent_suggestions=None,None
        else:
            requirements=inspect_netlist(text,source_id=name)
            from onboarding_recommendations import source_intent
            suggested_intent,intent_suggestions=source_intent(requirements)
        intake_id='intake_'+secrets.token_hex(16);folder=self._folder(intake_id)
        folder.mkdir(parents=True,mode=0o700)
        source=folder/'source.scs';source.write_bytes(text.encode('utf-8'));source.chmod(0o600)
        for relative,content in support.items():
            path=folder/'support'/relative;path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(content.encode('utf-8'));path.chmod(0o600)
        state={'schema':SCHEMA,'connection_id':self.connection_id,'intake_id':intake_id,
            'revision':1,'source_sha256':requirements['source_sha256'],'source_commit':None,
            'state':'source_inspected','created_at':stamp(),'updated_at':stamp(),
            'source':{'file_name':name,'source_sha256':requirements['source_sha256'],
                      'source_commit':None,'requirements':requirements},
            'input_provenance':[{'kind':'netlist','origin':origin,'sha256':requirements['source_sha256']}],
            'plans':[],'suggested_intent':suggested_intent,'intent_suggestions':intent_suggestions,
            'recommended_selection':None}
        if agent:
            state.update(mode='agent-tb',support_files={name:{'sha256':hashlib.sha256(raw.encode()).hexdigest()}
                for name,raw in support.items()})
        atomic(folder/'session.json',state)
        return public_session(state)

    def _ssh_browse(self,args,origin):
        if not {'ssh_target'}<=set(args) or set(args)-{'ssh_target','path'}:
            raise ValueError('Provide an explicit ssh_target and optional remote path')
        from onboarding_ssh_import import browse_remote_netlists
        return browse_remote_netlists(args['ssh_target'],self.config.get('ssh_config'),args.get('path'))

    def _ssh_import(self,args,origin):
        if not {'ssh_target','path'}<=set(args) or set(args)-{'ssh_target','path','include_dependencies'}:
            raise ValueError('Provide an explicit ssh_target and remote netlist path')
        from onboarding_ssh_import import fetch_remote_netlist
        return fetch_remote_netlist(
            args['ssh_target'],
            self.config.get('ssh_config'),
            args['path'],
            include_dependencies=args.get('include_dependencies',True),
        )

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
        if not required<=set(args) or set(args)-required-{'search_paths','cds_lib_hint','search_directory_ids','refresh','library_selection'}:
            raise ValueError('Use the explicit probe identities and optional search hints')
        if 'refresh' in args and type(args['refresh']) is not bool:raise ValueError('refresh must be an explicit boolean')
        previous=self._load(args['intake_id']);ids=args['probe_ids']
        if not isinstance(ids,list) or not 1<=len(ids)<=2 or any(not isinstance(x,str) for x in ids) or len(set(ids))!=len(ids):
            raise ValueError('Full-library discovery accepts one or two exact probe IDs per batch')
        selected=[p for p in previous.get('probes',[]) if p['probe_id'] in ids]
        if len(selected)!=len(ids):raise ValueError('Probe does not belong to the current intake revision')
        hints=args.get('search_paths')
        roots_by_probe={}
        library_selection=args.get('library_selection')
        if library_selection is not None:
            if (type(library_selection) is not dict or set(library_selection)!={'probe_id','library_id','library_candidate_id'}
                    or ids!=[library_selection.get('probe_id')]
                    or any(not isinstance(library_selection.get(k),str) or not re.fullmatch('[a-f0-9]{64}',library_selection[k])
                           for k in ('library_id','library_candidate_id'))
                    or any(args.get(k) for k in ('search_paths','search_directory_ids','cds_lib_hint','refresh'))):
                raise ValueError('Select one exact returned library entry without new scan hints')
            previous_id=(previous.get('discovery') or {}).get('discovery_id')
            if not previous_id:raise ValueError('A bounded library entry query requires previous choices')
            old=read_json(self._folder(previous['intake_id'])/'discoveries'/(previous_id+'.json'))
            records=[r for r in old['rows'] if r['probe_id']==library_selection['probe_id']]
            if len(records)!=1:raise ValueError('Library entry belongs to another probe')
            cached=records[0].get('lut') or {};choices=cached.get('projection') or cached
            if choices.get('library_id')!=library_selection['library_id']:
                raise ValueError('Select only an entry returned by the original library observation')
            entry_observed=any(r['library_candidate_id']==library_selection['library_candidate_id'] for r in choices.get('entry_choices',[]))
            if not entry_observed:
                # A legacy multi-entry query may have no public entry_choices.
                # Only exact original candidate IDs from this intake's saved
                # library may name the existing cache-only selection branch.
                from onboarding_pdk_scope import private_path
                from spiceowl.onboarding.pdk_discovery import validate_pdk_library,MAX_LIBRARY_RESULT_BYTES
                original=read_json(private_path(self._folder(previous['intake_id']),'libraries',library_selection['library_id']+'.json'),limit=MAX_LIBRARY_RESULT_BYTES)
                validate_pdk_library(original)
                if original.get('library_id')!=library_selection['library_id']:
                    raise ValueError('The retained library differs from this current observation')
                entry_observed=any(r.get('candidate_id')==library_selection['library_candidate_id'] for r in original.get('entry_candidates',[]))
            if not entry_observed:raise ValueError('Select only an original observed library candidate, not a scope entry identity')
            roots_by_probe[library_selection['probe_id']]=records[0].get('lookup_roots',records[0]['search_roots'])
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
        from onboarding_discovery import remote_discovery,public_discovery,record_search_progress
        from onboarding_lut import lookup_discovery,store_discovery,store_library,load_library_snapshot
        from onboarding_pdk_scope import library_observation_binding,digest as scope_digest
        pinned_cache=pinned_library=pinned_capture_sha=None
        if library_selection:
            # This existing explicit branch is cache-only. Validate it before
            # changing the intake revision and reuse these exact local reads.
            capture=read_json(self._folder(previous['intake_id'])/'probes'/(library_selection['probe_id']+'.json'))
            roots=roots_by_probe[library_selection['probe_id']]
            pinned_cache=lookup_discovery(self.root/'pdk-cache',capture,previous['source']['requirements'],
                roots=roots,library_id=library_selection['library_id'],
                library_candidate_id=library_selection['library_candidate_id'])
            if pinned_cache['public'].get('status') not in ('hit','partial') or pinned_cache['public'].get('scan_required') is not False:
                raise ValueError('The explicitly selected cached library is missing or stale; cache-only selection never starts a scan')
            pinned_library=load_library_snapshot(self.root/'pdk-cache',capture,pinned_cache['public'],roots=roots)
            pinned_capture_sha=scope_digest(capture)
        folder,state=self._begin(args,'discover-pdk')
        def discover(probe):
            capture=read_json(folder/'probes'/(probe['probe_id']+'.json'))
            search_roots=roots_by_probe.get(probe['probe_id'],hints)
            if not search_roots:
                search_roots=[row['path'] for row in (capture.get('private') or {}).get('pdk_candidates',[])
                              if row.get('exists')]
            try:
                if library_selection:
                    if scope_digest(capture)!=pinned_capture_sha:raise ValueError('The observed host changed during explicit cache binding')
                    cached=pinned_cache
                else:
                    cached=lookup_discovery(self.root/'pdk-cache',capture,state['source']['requirements'],
                        roots=search_roots,refresh=args.get('refresh',False) or bool(args.get('cds_lib_hint')))
                lookup_roots=search_roots
                retained=None
                result=cached['discovery'];lut={**cached['public'],'scan_performed':False,'storage':None}
                if cached['public'].get('library_id') and cached['public'].get('scan_required') is False:
                    retained=pinned_library if library_selection else load_library_snapshot(self.root/'pdk-cache',capture,cached['public'],roots=search_roots)
                    save_library_observation(folder/'libraries'/(retained['library_id']+'.json'),retained)
                    lookup_roots=retained['roots']
                if result is None and cached['public']['scan_required']:
                    lut['scan_performed']=True
                    observed=remote_discovery(probe['ssh_target'],self.config['ssh_config'],capture,
                        state['source']['requirements'],roots_by_probe.get(probe['probe_id'],hints),args.get('cds_lib_hint'),full_library=True)
                    is_library=observed.get('schema')=='spiceowl.pdk-library.v1'
                    if is_library:
                        retained=observed
                        lookup_roots=observed['roots']
                        save_library_observation(folder/'libraries'/(observed['library_id']+'.json'),observed)
                    else:
                        # The retained filtered adapter/receipts remain valid;
                        # they never establish whole-library coverage.
                        result=observed
                    try:
                        lut['storage']=(store_library if is_library else store_discovery)(self.root/'pdk-cache',capture,observed)
                        if is_library and lut['storage']['status']=='stored':
                            projected=lookup_discovery(self.root/'pdk-cache',capture,state['source']['requirements'],roots=observed['roots'])
                            result=projected['discovery']
                            lut['projection']=projected['public']
                    except Exception as error:
                        atomic(folder/'cache-errors'/(probe['probe_id']+'.json'),{'error':str(error)[:2000]})
                        lut['storage']={'schema':'ic.onboarding.pdk-lut.v1','status':'not_stored',
                            'missing':[{'field':'cache','code':'cache_storage_failed','message':'The new observation is retained in this intake; reusable cache storage failed.'}],
                            'fresh_dependency_audit_required':True,'remote_freshness_verified':False,'ready_to_run':False}
                return {'probe_id':probe['probe_id'],'result':result,'search_roots':search_roots,
                        **({'library_binding':library_observation_binding(capture,probe['probe_id'],retained,state['source_sha256'])} if retained is not None else {}),
                        **({'lookup_roots':lookup_roots} if lookup_roots!=search_roots else {}),
                        **({'error_code':'pdk_library_binding_incomplete'} if result is None else {}),
                        'lut':lut,
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
        public['lut']=[{'probe_id':row['probe_id'],'ssh_target':next(p['ssh_target'] for p in selected if p['probe_id']==row['probe_id']),
            **row['lut']} for row in rows if row.get('lut')]
        search_history=record_search_progress(public,rows,state['source_sha256'],
                                               state.get('discovery_search_history'))
        recommended=values=suggestions=None
        if state.get('mode')!='agent-tb':
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
                'explicit_cds_lib_hint':args.get('cds_lib_hint'),'explicit_refresh':args.get('refresh',False),
                **({'library_selection':copy.deepcopy(library_selection)} if library_selection else {})}])

    def _veriloga_headers(self,args,origin):
        if set(args)!={'intake_id','revision','probe_id','roots'}:
            raise ValueError('Select one observed host and explicit standard-header directories')
        previous=self._load(args['intake_id'])
        if previous.get('mode')!='agent-tb':raise ValueError('Header inspection requires an agent-TB intake')
        if any(p.get('dispatch_outcome') in ('attempting','unknown') for p in previous['plans']):
            raise Conflict('Reconcile the original uncertain submission before changing its dependencies')
        probes=[p for p in previous.get('probes',[]) if p.get('probe_id')==args['probe_id']]
        if len(probes)!=1:raise ValueError('Select an exact probe belonging to this intake')
        probe=probes[0];capture=read_json(self._folder(previous['intake_id'])/'probes'/(probe['probe_id']+'.json'))
        from onboarding_veriloga import probe_request,remote_headers,freeze_observation,public_headers
        probe_request(capture,args['roots'])  # Validate before changing the operation state.
        folder,state=self._begin(args,'veriloga-headers')
        try:
            observed=remote_headers(probe['ssh_target'],self.config['ssh_config'],capture,args['roots'])
            record=freeze_observation(capture,probe['probe_id'],observed)
            save_discovery_observation(folder/'veriloga-headers'/(record['header_id']+'.json'),record)
            public=public_headers(record)
        except Exception as error:
            atomic(folder/'header-errors'/(probe['probe_id']+'.json'),{'error':str(error)[:2000]})
            return self._finish(folder,state,state='needs_input',missing=[{'field':'veriloga_headers',
                'code':'header_probe_incomplete','message':'The explicit header observation did not complete; inspect the selected installation and roots.'}])
        rows=[row for row in state.get('veriloga_headers',[]) if row['probe_id']!=probe['probe_id']]
        return self._finish(folder,state,state='headers_observed',veriloga_headers=rows+[public],missing=[],
            input_provenance=state['input_provenance']+[{'kind':'veriloga_header_observation','origin':origin,
                'header_id':record['header_id'],'probe_id':probe['probe_id'],'inventory_sha256':observed['observation_id']}])

    def _prepare(self,args,origin):
        previous=self._load(args['intake_id'])
        if previous.get('mode')=='agent-tb':
            raise ValueError('Prepare the authored testbench with agent-tb/prepare and its exact draft ID')
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

    def _agent_draft(self,args,origin):
        if not {'intake_id','revision','testbench'}<=set(args) or set(args)-{'intake_id','revision','testbench','selection'}:
            raise ValueError('Save the literal testbench manifest and optional explicit selection')
        previous=self._load(args['intake_id'])
        if previous.get('mode')!='agent-tb':raise ValueError('Import the general circuit in agent-tb mode first')
        if any(p.get('dispatch_outcome') in ('attempting','unknown') for p in previous['plans']):
            raise Conflict('Reconcile the original uncertain submission before changing this intake')
        from onboarding_testbench import draft_record
        draft=draft_record(self._folder(args['intake_id']),previous,args['testbench'],args.get('selection'))
        folder,state=self._begin(args,'agent-tb/draft');draft['revision']=state['revision']
        return self._finish(folder,state,state='testbench_drafted',agent_tb=draft,
            input_provenance=state['input_provenance']+[{'kind':'agent_testbench_draft','origin':origin,
                'draft_id':draft['draft_id'],'testbench_sha256':draft['testbench_sha256']}])

    def _agent_prepare(self,args,origin):
        if set(args)!={'intake_id','revision','draft_id'}:raise ValueError('Prepare the exact saved testbench draft')
        previous=self._load(args['intake_id']);draft=previous.get('agent_tb')
        if previous.get('mode')!='agent-tb' or not draft or draft['draft_id']!=args['draft_id']:
            raise Conflict('Save and select this intake’s exact agent testbench draft')
        if draft.get('status')=='binding_stale':
            raise Conflict('The selected model or probe changed; save the testbench draft again with the current binding')
        if any(p.get('dispatch_outcome') in ('attempting','unknown') for p in previous['plans']):
            raise Conflict('Reconcile the original uncertain submission before preparing another experiment')
        from onboarding_testbench import compile_agent_selection,validate_selection
        from onboarding_prepare import observed_site,create_child_config
        selection=validate_selection(draft.get('selection'));missing=[]
        if not selection:missing.append({'field':'selection','code':'selection_missing','message':'Select the observed PDK and host scope for this testbench.'})
        elif 'scope_selection_id' not in selection and (not previous.get('discovery') or previous['discovery']['discovery_id']!=selection['discovery_id']):
            raise Conflict('The draft must select the current PDK discovery')
        probes={p['ssh_target']:p for p in previous.get('probes',[]) if p.get('probe_id')}
        if selection and set(selection['host_ids'])-set(probes):
            raise ValueError('Select only SSH aliases observed for this intake')
        selected=None
        if not missing:
            saved=None
            if 'scope_selection_id' not in selection:
                saved=read_json(self._folder(previous['intake_id'])/'discoveries'/(selection['discovery_id']+'.json'))
                if saved['source_sha256']!=previous['source_sha256']:raise ValueError('Discovery source digest changed')
            selected=compile_agent_selection(self._folder(previous['intake_id']),previous,saved)
            missing.extend(selected['missing'])
            audit_probe=next((p for p in probes.values() if p['probe_id']==selected.get('probe_id')),None)
            if not audit_probe or audit_probe['ssh_target'] not in selection['host_ids']:
                raise ValueError('Include the observed host for the selected PDK before preparing this draft')
        folder,state=self._begin(args,'agent-tb/prepare')
        def blocked():
            return self._finish(folder,state,state='needs_input',prepared={
                'schema':'ic.experiment.plan.v1','state':'blocked','project_id':state['intake_id'],
                'recipe_id':'agent-testbench','source_commit':None,'plan_id':None,'missing':missing,'submission_key':None})
        if missing:return blocked()
        hosts={};exclusions=[]
        for target in selection['host_ids']:
            probe=probes[target];capture=read_json(folder/'probes'/(probe['probe_id']+'.json'))
            observed,gaps=observed_site(capture,target,self.connection_id,self.config['ssh_config'])
            if observed:hosts[target]=observed
            else:exclusions.extend(gaps);missing.extend(gaps)
        if missing:return blocked()
        cfg,child_root,commit=create_child_config(folder,state,selected,hosts)
        from server import Application
        child=Application(cfg,self.app.web)
        with self._mutex:self._children[str(child_root)]=child
        prepared=child.simulation.control('prepare',{'project_id':state['intake_id'],
            'recipe_id':'agent-testbench','source_commit':commit},None,'local-studio')
        prepared['submission_key']='experiment-'+prepared['plan_id'] if prepared['plan_id'] else None
        mapping=read_json(child_root/'source-mapping.json');plans=state['plans']
        scope={'selected_ssh_targets':selection['host_ids'],'candidate_host_ids':list(hosts),
            'selection_mode':'automatic_within_selected_hosts','resource_check_at_run':True,'excluded_before_preparation':exclusions}
        updates={'state':'awaiting_human_review' if prepared['plan_id'] else 'needs_input',
            'source_commit':commit,'source':{**state['source'],'source_commit':commit},'prepared':prepared,
            'selection':copy.deepcopy(selection),'execution_scope':scope,'source_mapping':mapping}
        if prepared['plan_id']:
            plan={'plan_id':prepared['plan_id'],'source_commit':commit,'project_id':state['intake_id'],
                'recipe_id':'agent-testbench','submission_key':prepared['submission_key'],'draft_id':draft['draft_id'],
                'child_revision':state['revision'],'dispatch_outcome':'not_requested','source_mapping':mapping,
                'configuration_sha256':filehash(child_root/'configuration.json'),'pool_sha256':filehash(child_root/'pool.json'),
                'site_sha256':{h:filehash(child_root/(h+'.site.json')) for h in hosts}}
            updates['plans']=plans+[plan]
            snapshot_state={**state,**updates}
            snapshot=self._agent_snapshot(snapshot_state,plan,child)
            updates['agent_tb_review']=self.reviews.freeze(snapshot_state,snapshot)
            plan.update(review_id=updates['agent_tb_review']['review_id'],
                review_digest=updates['agent_tb_review']['review_digest'],testbench_sha256=draft['testbench_sha256'])
        return self._finish(folder,state,**updates)

    def _agent_snapshot(self,state,plan,child):
        from onboarding_testbench import draft_record
        from experiment_workflow import ExperimentWorkflow
        folder=self._folder(state['intake_id']);draft=state['agent_tb']
        if draft.get('status')=='binding_stale':
            raise Conflict('The testbench binding changed; save, prepare and review it again')
        if draft_record(folder,state,draft['testbench'],draft.get('selection'))['draft_id']!=draft['draft_id']:
            raise Conflict('The authored source, supporting files, testbench or selected execution scope changed')
        data=ExperimentWorkflow(child.simulation).plan(plan['plan_id'],plan['project_id'])
        if 'scope_selection_id' in (draft.get('selection') or {}):
            from onboarding_pdk_scope import load_scope_selection
            selected=load_scope_selection(folder,state,draft['selection']['scope_selection_id'])
            verification=data.get('pdk_scope_audit_verification') or {}
            if (data.get('pdk_scope_selection')!=selected['public']
                    or verification.get('selection_id')!=selected['public']['selection_id']
                    or verification.get('status')!='matched' or verification.get('matches_selection') is not True
                    or verification.get('missing')!=[]):
                raise Conflict('The frozen model scope or its fresh audit proof differs from this review')
        bundle_path=Path(data['bundle_path']);bundle=read_json(bundle_path)
        for item in bundle['files']:
            relative=item['source']
            if Path(relative).is_absolute() or '..' in Path(relative).parts:raise ValueError('Invalid frozen source identity')
            artifact=bundle_path.parent/relative
            if artifact.is_symlink() or not artifact.is_file() or filehash(artifact)!=item['sha256']:
                raise Conflict('Frozen testbench artifact bytes changed; prepare and review again')
        source_files={}
        for name,checksum in plan['source_mapping']['file_sha256'].items():
            raw=child.workspace.compiler_blob(plan['source_commit'],name)
            if hashlib.sha256(raw).hexdigest()!=checksum:raise Conflict('Frozen source bytes changed')
            source_files[name]={'sha256':checksum,'text':raw.decode('utf-8')}
        return {'schema':'ic.agent-tb.review-snapshot.v1','source_commit':plan['source_commit'],
            'original_source_sha256':state['source_sha256'],'draft_id':draft['draft_id'],'plan_id':plan['plan_id'],
            'testbench':copy.deepcopy(draft['testbench']),'files':source_files,
            'selection':copy.deepcopy(draft['selection']),'recipe':data['recipe'],
            'dependency_audit':data['dependency_audit'],'dependency_profile_sha256':data['dependency_profile_sha256'],
            **({'pdk_scope_selection':data['pdk_scope_selection'],
                'pdk_scope_audit_verification':data['pdk_scope_audit_verification']} if data.get('pdk_scope_selection') else {}),
            **({'veriloga_header_audit':data['veriloga_header_audit']} if data.get('veriloga_header_audit') else {}),
            'hosts':data['sites'],'environment_pins':data['environment_pins'],'requirements':data['requirements'],
            'bundle_sha256':data['bundle_sha256'],'configuration_sha256':plan['configuration_sha256'],
            'pool_sha256':plan['pool_sha256'],'site_sha256':plan['site_sha256']}

    def _verify_agent_review(self,state,plan):
        from onboarding_review import BINDING_FIELDS
        summary=state.get('agent_tb_review') or {}
        review=self.reviews.current(state,{k:summary.get(k) for k in BINDING_FIELDS},approved=True)
        child=self._child(state,plan)
        if self._agent_snapshot(state,plan,child)!=review['snapshot']:
            raise Conflict('The frozen source, testbench, PDK or execution inputs changed; prepare and review again')
        return review

    def human_run(self,args,*,origin,run=True):
        self._check()
        if origin not in ('native_host_form','browser_form'):raise PermissionError('Correlated human review is required')
        with locked(self._folder(args.get('intake_id'))/'operation.lock'):
            self._require_operable(self._load(args['intake_id']))
            try:return self._human_run_locked(args,origin=origin,run=run)
            finally:
                with self._mutex:self._active_operations.pop(args['intake_id'],None)

    def _human_run_locked(self,args,*,origin,run):
        state=self._load(args['intake_id']);plan=self._plan_row(state,args.get('plan_id'))
        review=self.reviews.read(args['intake_id'],args.get('review_id'))
        if review['state']=='approved' and plan.get('dispatch_outcome')!='not_requested':
            self.reviews.current(state,args,approved=True)
            return self._run({'intake_id':state['intake_id'],'revision':state['revision'],'plan_id':plan['plan_id']},origin)
        self.reviews.current(state,args)
        child=self._child(state,plan)
        if self._agent_snapshot(state,plan,child)!=review['snapshot']:
            raise Conflict('The frozen testbench review no longer matches this preparation')
        decision=self.reviews.decide(state,args,origin=origin,run=run)
        state['agent_tb_review']=decision
        if not run:state.update(state='review_denied',revision=state['revision']+1,updated_at=stamp())
        atomic(self._folder(state['intake_id'])/'session.json',state)
        if not run:return public_session(state)
        return self._run({'intake_id':state['intake_id'],'revision':state['revision'],'plan_id':plan['plan_id']},origin)

    def _analysis(self,args,origin):
        from onboarding_analysis import OnboardingAnalysis
        return OnboardingAnalysis(self._analysis_binding).analyze(args)

    def _analysis_binding(self,intake_id,job_id):
        from onboarding_analysis import AnalysisBinding
        state,plan,child=self._bound_job(intake_id,job_id);record=child.runner.read(job_id)
        return AnalysisBinding(intake_id,job_id,plan['source_commit'],service=child.waveforms,
            original_source_sha256=plan['source_mapping']['original_source_sha256'],
            archive_sha256=(record.get('collection') or {}).get('sha256'),
            compiled_source_sha256=plan['source_mapping']['compiled_source_sha256'],
            output_root=child.runner.path(job_id)/'analysis')

    def _plan_row(self,state,plan_id):
        rows=[p for p in state['plans'] if p['plan_id']==plan_id]
        if len(rows)!=1:raise ValueError('Plan does not belong to this intake')
        return rows[0]

    def _child(self,state,plan):
        revision=plan.get('child_revision')
        if type(revision) is not int or revision<1:raise ValueError('Invalid prepared child identity')
        root=self._folder(state['intake_id'])/'prepared'/str(revision)
        with self._mutex:
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
            if str(root) in self._children:return self._children[str(root)]
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
            if plan.get('recipe_id')=='agent-testbench':self._verify_agent_review(state,plan)
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
                    if state.get('operation',{}).get('kind')=='submitting':
                        state['operation'].update(status='reconciled',finished_at=stamp())
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
