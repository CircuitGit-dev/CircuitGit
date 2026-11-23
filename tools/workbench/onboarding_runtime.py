"""Fresh user intake, observed discovery and explicit experiment selection.

This store never searches an old app profile, library catalogue or simulation
directory. Initial facts are supplied source bytes and selected SSH targets.
Only the preparation step is allowed to create a circuit Git snapshot.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import threading

from runner import atomic, locked, stamp, filehash
from spiceowl_pool import read_json, canonical
from workspace import Conflict

PREFIX = '/api/simulation/onboarding'
READS = {'ssh-hosts','session','submission'}
WRITES = {'netlist','probe','discover-pdk','prepare','run','inspect'}
SCHEMA = 'ic.onboarding.session.v1'


def create_onboarding_config(root, *, resume=False):
    """Initialize only an explicitly selected empty store; no legacy fallback."""
    root=Path(root).expanduser().absolute()
    if root.is_symlink():raise ValueError('Select a regular fresh state directory')
    if resume:
        marker=read_json(root/'onboarding-state.json')
        if marker.get('schema')!='ic.onboarding.store.v1':raise ValueError('This is not an onboarding store')
        config=read_json(root/'connection.json')
        if config.get('onboarding',{}).get('connection_id')!=marker['connection_id']:
            raise ValueError('Onboarding connection identity differs')
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
        return self.root/intake_id

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
            for field in ({'probe':('probes','discovery','prepared','execution_scope'),
                           'discover-pdk':('discovery','prepared','execution_scope'),
                           'prepare':('prepared','execution_scope')}.get(operation,())):
                state.pop(field,None)
            atomic(folder/'session.json',state)
        return folder,state

    def _finish(self,folder,state,**updates):
        with locked(folder/'session.lock'):
            current=self._load(state['intake_id'])
            if current['revision']!=state['revision']:
                raise Conflict('This discovery reply is stale for the current intake')
            current.update(updates,updated_at=stamp());atomic(folder/'session.json',current)
        return current

    def read(self,operation,args,*,origin='interactive_client'):
        self._check()
        if operation=='ssh-hosts':
            if args:raise ValueError('SSH listing has no caller-supplied file path')
            from spiceowl.onboarding.ssh_discovery import discover_ssh_hosts
            return discover_ssh_hosts(self.config['ssh_config'])
        if operation=='session' and set(args)=={'intake_id'}:return self._load(args['intake_id'])
        if operation=='submission' and set(args)=={'intake_id','plan_id'}:
            return self._submission(args)
        raise ValueError('Unknown bounded onboarding read')

    def write(self,operation,args,*,origin='interactive_client'):
        self._check()
        if origin not in ('interactive_client','native_agent','test_harness'):
            raise PermissionError('Unsupported onboarding entry point')
        if not isinstance(args,dict):raise ValueError('Onboarding arguments must be an object')
        methods={'netlist':self._netlist,'probe':self._probe,'discover-pdk':self._discover,
                 'prepare':self._prepare,'run':self._run,'inspect':self._inspect}
        if operation not in methods:raise ValueError('Unknown finite onboarding operation')
        return methods[operation](args,origin)

    def _netlist(self,args,origin):
        if set(args)!={'file_name','text'}:raise ValueError('Provide only the new file label and literal text')
        name=args['file_name'];text=args['text']
        if not isinstance(name,str) or not 1<=len(name)<=240 or any(ord(c)<32 for c in name):
            raise ValueError('Invalid input display name')
        from spiceowl.onboarding.pdk_discovery import inspect_netlist
        requirements=inspect_netlist(text,source_id=name)
        intake_id='intake_'+secrets.token_hex(16);folder=self._folder(intake_id)
        folder.mkdir(parents=True,mode=0o700)
        source=folder/'source.scs';source.write_text(text,encoding='utf-8');source.chmod(0o600)
        state={'schema':SCHEMA,'connection_id':self.connection_id,'intake_id':intake_id,
            'revision':1,'source_sha256':requirements['source_sha256'],'source_commit':None,
            'state':'source_inspected','created_at':stamp(),'updated_at':stamp(),
            'source':{'file_name':name,'source_sha256':requirements['source_sha256'],
                      'source_commit':None,'requirements':requirements},
            'input_provenance':[{'kind':'netlist','origin':origin,'sha256':requirements['source_sha256']}],
            'plans':[]}
        atomic(folder/'session.json',state)
        return state

    def _probe(self,args,origin):
        if set(args)-{'intake_id','revision','ssh_targets','overrides'} or not {'intake_id','revision','ssh_targets'}<=set(args):
            raise ValueError('Select explicit SSH targets for this intake')
        from spiceowl.onboarding.environment import capture_server_environment
        from spiceowl.onboarding.ssh_discovery import validate_ssh_target
        targets=args['ssh_targets']
        if not isinstance(targets,list) or not 1<=len(targets)<=8 or len(set(targets))!=len(targets):
            raise ValueError('Select one to eight distinct SSH targets')
        for target in targets:validate_ssh_target(target)
        if args.get('overrides'):raise ValueError('This version accepts search hints at PDK discovery; environment overrides are not yet supported')
        folder,state=self._begin(args,'probe')
        def observe(target):
            try:
                observed=capture_server_environment(target,self.config['ssh_config'])
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
            input_provenance=state['input_provenance']+[{'kind':'ssh_selection','origin':origin,'ssh_targets':targets}])

    def _discover(self,args,origin):
        raise ValueError('PDK discovery integration is not yet available in this development build')

    def _prepare(self,args,origin):
        raise ValueError('Intake preparation integration is not yet available in this development build')

    def _run(self,args,origin):
        raise ValueError('No prepared intake runtime is available')

    def _inspect(self,args,origin):
        raise ValueError('No original intake job is available')

    def _submission(self,args):
        state=self._load(args['intake_id'])
        found=[p for p in state['plans'] if p['plan_id']==args['plan_id']]
        if len(found)!=1:raise ValueError('Plan does not belong to this intake')
        return {'intake_id':state['intake_id'],'plan_id':args['plan_id'],
            'found':False,'run_id':None,'submission_key':'experiment-'+args['plan_id'],
            'dispatch_outcome':'unknown','replay_permitted':False,'job':None}

    def close(self):
        for child in self._children.values():
            child.simulation.close();child.pool.shutdown(wait=False)
