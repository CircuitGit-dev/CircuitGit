"""Registered deterministic experiments over the existing Workspace and Runner.

Plans contain scientific intent and compilation evidence, never another execution
ledger. Runner's original submission key and run record own every launch. Inspect
is an explicitly authorized control operation because it can collect a terminal
run. Cached runtime reads never call it.
"""
import concurrent.futures
import hashlib
import hmac
import json
from pathlib import Path
import re
import tarfile

import ic_sim as core
from runner import atomic, filehash, locked, stamp, TERMINAL
from spiceowl_pool import ResourcePool, read_json, canonical


def identifier(value):
    if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}',value):
        raise ValueError('Invalid experiment identity')
    return value


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def blocked(project,recipe,commit,missing):
    return {'schema':'ic.experiment.plan.v1','state':'blocked','project_id':project,
            'recipe_id':recipe,'source_commit':commit,'plan_id':None,'missing':missing}


class ExperimentWorkflow:
    def __init__(self,runtime):
        self.runtime=runtime;self.app=runtime.app
        self.root=Path(self.app.cfg['runtime_root'])/'experiments'
        self.key=self.app.workspace.key

    def configuration(self,project,recipe):
        config=self.app.cfg.get('experiment_workflow') or {}
        rows=config.get('recipes',[])
        selected=[row for row in rows if row.get('project_id')==project and row.get('id')==recipe]
        if len(selected)!=1:return None,None
        profile=(config.get('profiles') or {}).get(selected[0].get('model_profile'))
        return selected[0],profile

    def _save_plan(self,data):
        plan_id=digest(data)
        signed={'data':data,'signature':hmac.new(self.key,canonical(data),hashlib.sha256).hexdigest()}
        path=self.root/'plans'/(plan_id+'.json')
        with locked(path.with_suffix('.lock')):
            if path.exists():
                if read_json(path)!=signed:raise ValueError('Existing experiment plan differs')
            else:atomic(path,signed)
        return plan_id

    def plan(self,plan_id,project):
        if not isinstance(plan_id,str) or not re.fullmatch('[a-f0-9]{64}',plan_id):
            raise ValueError('Invalid experiment plan ID')
        signed=read_json(self.root/'plans'/(plan_id+'.json'))
        data=signed['data']
        expected=hmac.new(self.key,canonical(data),hashlib.sha256).hexdigest()
        if (not hmac.compare_digest(expected,signed.get('signature','')) or digest(data)!=plan_id
                or data['identity']['project_id']!=project):raise ValueError('Experiment plan binding differs')
        if filehash(data['bundle_path'])!=data['bundle_sha256']:raise ValueError('Frozen experiment bundle changed')
        return data

    def _audit(self,site,config,remote_python):
        from spiceowl.integrations.model_dependencies import build_model_audit_script
        if not isinstance(remote_python,str) or not remote_python.startswith('/') or not core.SAFE.fullmatch(remote_python):
            raise ValueError('An installed absolute remote Python executable is required')
        code=build_model_audit_script(config)
        script='set -eu\n'
        script+='[ "$(hostname)" = '+core.q(site['expected_host'])+' ]\n'
        script+='[ "$(id -un)" = '+core.q(site['expected_user'])+' ]\n'
        script+='/usr/bin/timeout 55 '+core.q(remote_python)+' - <<\'IC_MODEL_AUDIT_PY\'\n'+code+'\nIC_MODEL_AUDIT_PY\n'
        result=core.ssh(site,script,timeout=60)
        if result.returncode or len(result.stdout)>2*1024*1024:
            raise ValueError('Bounded remote model audit did not complete')
        return json.loads(result.stdout)

    @staticmethod
    def _validate_audit(audit,config):
        from spiceowl.integrations.model_dependencies import validate_audit_config
        normalized=validate_audit_config(config);limits=normalized['limits']
        if (not isinstance(audit,dict) or audit.get('schema')!='spiceowl.model-dependency-audit.v1'
                or audit.get('static_only') is not True or audit.get('unknown')!=[]
                or audit.get('unknown_count')!=0 or audit.get('unknown_truncated') is not False
                or audit.get('missing_masters')!=[] or audit.get('limits')!=limits):
            raise ValueError('Model audit returned inconsistent coverage evidence')
        files=audit.get('files');directories=audit.get('directories')
        if (not isinstance(files,list) or not 1<=len(files)<=limits['max_files']
                or not isinstance(directories,list) or len(directories)>limits['max_edges']):
            raise ValueError('Model audit inventory exceeds registered bounds')
        seen=set()
        for row in files+directories:
            path=row.get('path') if isinstance(row,dict) else None
            if (not isinstance(path,str) or not core.SAFE.fullmatch(path) or not path.startswith('/')
                    or '..' in Path(path).parts or path in seen
                    or not any(path==root or path.startswith(root+'/') for root in normalized['roots'])):
                raise ValueError('Model audit path is duplicate or outside authorized roots')
            seen.add(path)
        for row in files:
            if (row.get('kind')!='file' or not isinstance(row.get('sha256'),str)
                    or not re.fullmatch('[a-f0-9]{64}',row['sha256'])
                    or type(row.get('bytes')) is not int or not 0<=row['bytes']<=limits['max_file_bytes']):
                raise ValueError('Model audit file pin is invalid')
        if sum(row['bytes'] for row in files)>limits['max_total_bytes']:
            raise ValueError('Model audit files exceed byte budget')
        if any(row.get('kind')!='directory' or row.get('role')!='directory_reference' for row in directories):
            raise ValueError('Model audit directory is not a registered reference')

    def prepare(self,args,caller):
        if set(args)!={'project_id','recipe_id','source_commit'}:
            raise ValueError('Prepare requires an exact project, recipe and source commit')
        project=identifier(args['project_id']);recipe_id=identifier(args['recipe_id']);commit=args['source_commit']
        self.runtime.authorize(caller,'prepare',project)
        selected,profile=self.configuration(project,recipe_id)
        if selected is None:
            return blocked(project,recipe_id,commit,[{'field':'recipe_id','code':'recipe_not_registered','message':'Register an explicit test recipe for this project or cell.'}])
        if not profile:
            return blocked(project,recipe_id,commit,[{'field':'model_profile','code':'model_profile_missing','message':'Register an electrical model and dependency profile.'}])
        ws=self.app.workspace;ws.require_compilation_base(commit)
        allowed={ws.projects[project]['source_path'],*ws.projects[project].get('read_paths',[])}
        for config in ws.projects[project].get('configurations',[]):
            allowed.update(r['source'] for r in config.get('source_replacements',[]))
        paths=selected.get('source_paths',[])
        if not isinstance(paths,list) or not 1<=len(paths)<=64 or len(set(paths))!=len(paths) or not set(paths)<=allowed:
            raise ValueError('Recipe sources must be explicit files registered to this project')
        sources={path:ws.compiler_blob(commit,path) for path in paths}
        from spiceowl.experiments import prepare_experiment
        compiled=prepare_experiment(sources,selected.get('selection',{}),selected.get('spec',{}),profile.get('electrical',{}))
        if compiled['status']!='ready':return blocked(project,recipe_id,commit,compiled['missing'])
        pool=self.app.resource_pool
        if pool is None:return blocked(project,recipe_id,commit,[{'field':'host_pool','code':'pool_missing','message':'Configure an authorized resource pool.'}])
        requested=selected.get('host_ids',list(pool.members))
        hosts=[host for host in requested if host in pool.members and host in self.runtime.scope['hosts']]
        audit_host=profile.get('audit_host',hosts[0] if hosts else None)
        if not hosts or audit_host not in hosts:raise PermissionError('Model audit host is outside the installed connection grant')
        sites={host:core.site_load(Path(pool.members[host]['site_file'])) for host in hosts}
        audit_config=profile.get('dependencies')
        if not isinstance(audit_config,dict):return blocked(project,recipe_id,commit,[{'field':'dependencies','code':'dependency_profile_missing','message':'Register the remote model roots, sections and dynamic library profile.'}])
        recipe=compiled['recipe'];electrical=profile['electrical']
        from spiceowl.integrations.model_dependencies import validate_audit_config
        normalized=validate_audit_config(audit_config)
        includes=recipe['external_includes']
        if not includes or any(item['alias']!='PDK_MAIN' or item['section'] not in normalized['sections'] for item in includes):
            return blocked(project,recipe_id,commit,[{'field':'external_includes','code':'include_profile_mismatch','message':'Recipe model includes must select authorized PDK_MAIN sections.'}])
        # The profile may authorize several corners. Only this recipe's actual
        # entry sections establish its model closure; other corners cannot supply
        # missing masters. The scanner still follows global/transitive includes.
        audit_config={**audit_config,'sections':list(dict.fromkeys(item['section'] for item in includes)),
                      'required_masters':list(dict.fromkeys([*normalized['required_masters'],*recipe['used_models']]))}
        audit=self._audit(sites[audit_host],audit_config,profile.get('remote_python','/usr/bin/python'))
        if audit.get('status')!='complete_for_supported_static_syntax':
            return blocked(project,recipe_id,commit,[{'field':'dependencies','code':'dependency_audit_incomplete','message':'The bounded model audit found missing or unsupported dependencies.'}])
        self._validate_audit(audit,audit_config)
        # Bind the compiler's actual masters and include sections to the audited
        # model, rather than trusting an independently configured scanner list.
        declarations=audit.get('master_declarations',[])
        for master in recipe['used_models']:
            found=[row for row in declarations if row.get('name')==master]
            count=len(electrical['models'][master]['terminals'])
            if not found or any(row.get('port_count')!=count for row in found):
                return blocked(project,recipe_id,commit,[{'field':'models','code':'model_terminal_contract_unverified','message':'An actual recipe master is absent from the audited model or has a different terminal count.'}])
        files=audit.get('files',[])
        main=audit_config['main'];main_row=next((row for row in files if row['path']==main),None)
        if not main_row or main_row['sha256']!=profile.get('expected_main_sha256'):
            return blocked(project,recipe_id,commit,[{'field':'model_profile','code':'model_revision_mismatch','message':'The model entry differs from the explicitly registered revision.'}])
        aliases={};pins={}
        for row in files:
            path=row['path'];checksum=row['sha256']
            alias='PDK_MAIN' if path==main else ('PDK_TMI_LIB' if path.endswith('/libTMImodel.so') else 'DEPENDENCY_'+hashlib.sha256(path.encode()).hexdigest()[:16].upper())
            if alias in aliases and aliases[alias]!=path:alias+='_'+hashlib.sha256(path.encode()).hexdigest()[:8].upper()
            aliases[alias]=path;pins[alias]=checksum
        if not aliases:raise ValueError('Model audit returned no pinned dependencies')
        for site in sites.values():site['external_files']={**site.get('external_files',{}),**aliases}
        payload=dict(compiled['files'])
        recipe_raw=canonical(recipe)
        payload['experiment/recipe.json']=recipe_raw
        payload['experiment/source.json']=canonical(compiled['source'])
        checks=selected.get('qualification_checks',[])
        qualification={'scope_id':recipe_id,'manifest_sha256':hashlib.sha256(recipe_raw).hexdigest(),
                       'frozen_before_execution':True,'checks':checks}
        # Validate the declared scope before any launch; a missing scope stays unknown.
        from spiceowl.integrations.spectre_report import build_spectre_report
        build_spectre_report('',execution_state='unknown',exit_code=None,qualification_scope=qualification if checks else None)
        entry=compiled.get('entrypoint','netlist/input.scs')
        if entry not in payload:raise ValueError('Recipe compiler returned no standard entrypoint')
        bundle={'schema':'ic.sim.bundle.v1','source_root':'.','entrypoint':entry,'design_id':project,
                'design_origin':'registered-deterministic-recipe','testbench':recipe_id,'reviewed_for_distribution':True,
                'files':[{'source':name,'destination':name,'sha256':hashlib.sha256(raw).hexdigest()} for name,raw in sorted(payload.items())],
                'external_sha256':pins,'configuration':{'recipe_id':recipe_id,'manifest_sha256':qualification['manifest_sha256']},
                'simulator':{'profile':'explicit-local-1cpu','args':['-64','+mt=1','+lqtimeout','60','-maxw','10','-maxn','10'],'output_format':'psfascii'}}
        source_hashes={path:hashlib.sha256(raw).hexdigest() for path,raw in sources.items()}
        compiler=digest({'workflow':filehash(__file__),'compiled_recipe':hashlib.sha256(recipe_raw).hexdigest()})
        bundle_path=ws.freeze_experiment(project,recipe_id,commit,payload,bundle,source_hashes,compiler)
        data={'schema':'ic.experiment.frozen-plan.v1','identity':{'project_id':project,'configuration':recipe_id,'source_commit':commit},
              'bundle_path':str(bundle_path),'bundle_sha256':filehash(bundle_path),'recipe':recipe,
              'source':compiled['source'],'qualification_scope':qualification if checks else None,
              'dependency_audit':audit,'dependency_profile_sha256':digest(profile),'sites':sites,
              'requirements':pool.requirements,'spiceowl_data_dir':pool.data_dir}
        plan_id=self._save_plan(data)
        return {'schema':'ic.experiment.plan.v1','state':'prepared','project_id':project,'recipe_id':recipe_id,
                'source_commit':commit,'plan_id':plan_id,'missing':[],
                'dependency_summary':{'file_count':len(pins),'pre_pinned':True},
                'qualification_scope':qualification,'source':compiled['source']}

    def _pool(self,plan_id,data):
        root=self.root/'execution'/plan_id;members=[]
        for host,site in data['sites'].items():
            path=root/(host+'.site.json');atomic(path,site);members.append({'host_id':host,'site_file':str(path)})
        config={'schema':'ic.spiceowl-pool.v1','spiceowl_data_dir':data['spiceowl_data_dir'],
                'requirements':data['requirements'],'members':members}
        path=root/'pool.json';atomic(path,config)
        return ResourcePool(path,root,self.key)

    def run(self,args,caller):
        if set(args)!={'project_id','plan_id'}:raise ValueError('Run requires a project and frozen plan ID')
        project=identifier(args['project_id']);self.runtime.authorize(caller,'run',project)
        self.runtime.authorize(caller,'watch',project)
        plan_id=args['plan_id'];data=self.plan(plan_id,project);identity=data['identity'];key='experiment-'+plan_id
        with locked(self.root/'execution'/(plan_id+'.lock')):
            rid=self.app.runner.lookup_submission(key)
            if rid:
                existing=self._bound(rid,project)
                if existing['experiment']['plan_id']!=plan_id:raise ValueError('Submission key maps to a different experiment plan')
                return self._job(existing,plan_id)
            for previous in self.app.runner.list():
                if (previous.get('project_id')==project and previous.get('source_commit')==identity['source_commit']
                        and previous.get('configuration_id')==identity['configuration'] and previous.get('state') in
                        {'queued','preflight','staging_outcome_unknown','launch_outcome_unknown','reconcile_required'}):
                    raise ValueError('An unresolved equivalent experiment exists; inspect its original job')
            pool=self._pool(plan_id,data)
            hosts=[host for host in pool.members if host in self.runtime.scope['hosts']]
            # Filter model-incompatible nodes before the resource ranking. This is
            # a new bounded preflight, not a scheduler reservation or model copy.
            def verify(host):
                try:
                    site=data['sites'][host];probe=core.doctor(site)
                    b=json.loads(Path(data['bundle_path']).read_text())
                    core.check_external(b,site,probe)
                    return host if probe['identity_ok'] and probe['all_references_readable'] and probe['all_tools_available'] and not probe['exit_code'] else None
                except Exception:return None
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
                eligible=[host for host in workers.map(verify,hosts) if host]
            if not eligible:raise ValueError('No authorized host matches the frozen model and tool dependencies')
            prepared=pool.prepare(self.app.runner,Path(data['bundle_path']),identity,host_ids=eligible)
            context=pool.resolve(prepared['execution_plan_id'],Path(data['bundle_path']),identity)
            run,new=self.app.runner.reserve(data['bundle_path'],key,identity['source_commit'],project,identity['configuration'],context)
            if new:
                run['experiment']={'plan_id':plan_id,'manifest_sha256':data['qualification_scope']['manifest_sha256'] if data['qualification_scope'] else digest(data['recipe'])}
                self.app.runner.save(run)
                self.app.operations[run['run_id']]=self.app.pool.submit(self._dispatch_bound,run['run_id'],project,caller)
            return self._job(run,plan_id)

    def _dispatch_bound(self,rid,project,caller):
        # The executor can wait behind other work. Recheck current authority and
        # the selected host at the point the reserved job can actually launch.
        self.runtime.authorize(caller,'run',project)
        self.runtime.authorize(caller,'watch',project)
        self._bound(rid,project)
        return self.runtime._arm_after_dispatch(rid,project,caller)

    def _bound(self,rid,project):
        record=self.app.runner.read(identifier(rid))
        if record.get('project_id')!=project or not record.get('experiment'):raise ValueError('Job does not belong to this experiment project')
        self.runtime.bound_run({'project_id':project,'configuration':record['configuration_id'],
                                'source_commit':record['source_commit'],'run_id':rid})
        data=self.plan(record['experiment']['plan_id'],project)
        if data['identity']!={'project_id':project,'configuration':record['configuration_id'],'source_commit':record['source_commit']}:
            raise ValueError('Experiment job identity differs from the frozen plan')
        return record

    def _job(self,record,plan_id):
        return {'schema':'ic.experiment.job.v1','project_id':record['project_id'],'plan_id':plan_id,
                'job_id':record['run_id'],'run_id':record['run_id'],'source_commit':record['source_commit'],
                'configuration':record['configuration_id'],'state':record['state'],
                'launch_attempts':record['launch_attempts'],'execution_target':record.get('execution_context',{}).get('resource_selection',{}).get('host_id'),
                'automatic_retry':False}

    def inspect(self,args,caller):
        if set(args)!={'project_id','job_id'}:raise ValueError('Inspect requires the original project and job ID')
        project=identifier(args['project_id']);self.runtime.authorize(caller,'inspect',project)
        self.runtime.authorize(caller,'collect',project)
        record=self._bound(args['job_id'],project);rid=record['run_id'];plan_id=record['experiment']['plan_id']
        folder=self.app.runner.path(rid);receipt=folder/'experiment-inspection.json'
        with locked(folder/'experiment-inspect.lock'):
            active=self.app.operations.get(rid)
            if active and not active.done():return {**self._job(record,plan_id),'inspection_state':'working'}
            if active and (active.cancelled() or active.exception() is not None):
                return {**self._job(record,plan_id),'inspection_state':'uncertain','error_code':'experiment_dispatch_unconfirmed'}
            record=self._bound(rid,project)
            if receipt.exists():
                saved=read_json(receipt)
                if saved.get('state')=='complete':
                    result=read_json(folder/'experiment-result.json')
                    if result.get('run_id')!=rid or result.get('source_commit')!=record['source_commit'] or result.get('native_archive_sha256')!=(record.get('collection') or {}).get('sha256'):
                        raise ValueError('Experiment result binding differs')
                    if filehash(folder/'experiment-result.json')!=saved['result_sha256']:raise ValueError('Experiment result changed')
                    if result['report'].get('run_id')!=rid:raise ValueError('Report run binding differs')
                    return {**self._job(record,plan_id),'inspection_state':'complete','report':result['report'],'measurements':result['measurements']}
                return {**self._job(record,plan_id),'inspection_state':'uncertain','automatic_retry':False}
            record=self.app.runner.status(rid)
            if record.get('state') in {'preflight_failed','staging_outcome_unknown','launch_outcome_unknown','reconcile_required'} or record.get('status_transport') in {'disconnected','blocked'}:
                return {**self._job(record,plan_id),'inspection_state':'uncertain','error_code':'experiment_execution_unconfirmed'}
            if record.get('remote_state') in TERMINAL:
                atomic(receipt,{'state':'collecting','run_id':rid,'created_at':stamp()})
                self.app.operations[rid]=self.app.pool.submit(self._collect_validate,rid,caller)
                return {**self._job(record,plan_id),'inspection_state':'collecting'}
            return {**self._job(record,plan_id),'inspection_state':'pending'}

    def _collect_validate(self,rid,caller):
        folder=self.app.runner.path(rid)
        try:
            record=self.app.runner.read(rid);self.runtime.authorize(caller,'inspect',record['project_id'])
            self.runtime.authorize(caller,'collect',record['project_id']);self._bound(rid,record['project_id'])
            record=self.app.runner.collect(rid)
            result=self.validate_result(record)
            atomic(folder/'experiment-result.json',result)
            atomic(folder/'simulation-report.json',{'run_id':rid,'source_commit':record['source_commit'],
                'native_archive_sha256':record['collection']['sha256'],'report':result['report']})
            self.runtime.derive_results(rid)
            atomic(folder/'experiment-inspection.json',{'state':'complete','run_id':rid,'updated_at':stamp(),
                'result_sha256':filehash(folder/'experiment-result.json'),
                'report_sha256':filehash(folder/'simulation-report.json')})
        except Exception as error:
            atomic(folder/'experiment-inspection.json',{'state':'uncertain','run_id':rid,'updated_at':stamp(),
                'error_code':'experiment_collection_or_validation_unconfirmed','automatic_retry':False})
            # Private evidence for the operator; public responses expose only a bounded code.
            atomic(folder/'experiment-inspection-error.json',{'error':str(error)[:2000]})

    def validate_result(self,record):
        """Validate native input bytes before measurements and five-axis reporting."""
        from spiceowl.experiments import measure_psf_ascii
        from spiceowl.integrations.model_dependencies import audit_read_log
        from spiceowl.integrations.spectre_report import build_spectre_report
        rid=record['run_id'];data=self.plan(record['experiment']['plan_id'],record['project_id'])
        archive=Path(record['collection']['archive'])
        if filehash(archive)!=record['collection']['sha256']:raise ValueError('Native archive digest differs')
        if record['plan']['provenance']['bundle_sha256']!=data['bundle_sha256']:raise ValueError('Execution bundle differs')
        bundle=json.loads(Path(data['bundle_path']).read_text());site=self.app.runner.execution_site(record)
        if record['plan']['external_sha256']!=bundle['external_sha256']:raise ValueError('Execution model pins differ')
        with tarfile.open(archive,'r:gz') as tf:
            members={}
            for member in tf.getmembers():
                name=member.name.removeprefix('./')
                if name.startswith('/') or '..' in Path(name).parts or member.issym() or member.islnk():
                    raise ValueError('Unsafe native archive member')
                if not member.isfile():continue
                if name in members:raise ValueError('Duplicate native archive member')
                members[name]=member
            def read(name,limit):
                m=members.get(name)
                if m is None or m.size>limit:raise ValueError('Missing or oversized native artifact: '+name)
                return tf.extractfile(m).read()
            native=json.loads(read('run.json',2*1024*1024))
            for field in ('schema','run_id','job_id','project_id','source_commit','configuration_id',
                          'remote_directory','execution_site','execution_site_sha256',
                          'execution_context','execution_context_sha256','experiment','plan'):
                if field not in record or native.get(field)!=record[field]:
                    raise ValueError('Native run identity differs: '+field)
            if read('state',1024).decode().strip()!=record.get('remote_state'):
                raise ValueError('Native terminal state differs')
            if read('exit_code',1024).decode().strip()!=str(record.get('simulator_exit_code')):
                raise ValueError('Native exit code differs')
            payload={}
            for row in record['plan']['provenance']['files']:
                raw=read(row['destination'],2*1024*1024)
                if hashlib.sha256(raw).hexdigest()!=row['staged_sha256']:raise ValueError('Native input differs from the frozen plan')
                payload[record['remote_directory']+'/'+row['destination']]=row['staged_sha256']
            external=read('external.sha256',128*1024).decode().splitlines()
            checks=read('external-checksums.log',128*1024).decode().splitlines()
            for alias,checksum in bundle['external_sha256'].items():
                path=site['external_files'][alias]
                matching=[line for line in checks if line.startswith(path+': ')]
                manifest=[line for line in external if line.endswith('  '+path)]
                if manifest!=[checksum+'  '+path] or matching!=[path+': OK']:
                    raise ValueError('Native prelaunch dependency verification differs')
            log=read('psf/spectre.out',1024*1024).decode(errors='replace')
            transients=[name for name in members if name.endswith('.tran')]
            psf=read(transients[0],16*1024*1024).decode() if len(transients)==1 else ''
        execution='completed' if record.get('simulator_exit_code')==0 and record.get('remote_state')=='simulator_complete_pending_measurements' else 'failed'
        measured=measure_psf_ascii(psf,data['recipe'],execution_state=execution,exit_code=record.get('simulator_exit_code'))
        audit=audit_read_log(log,pinned_paths={alias:site['external_files'][alias] for alias in bundle['external_sha256']},pinned_sha256=bundle['external_sha256'],
                             native_payload=payload,builtin_profile=[{**row,'phase':'prelaunch'} for row in data['dependency_audit'].get('directories',[])])
        dependency=self._report_dependencies(audit,data,record)
        acceptance=self._measurement_acceptance(measured)
        report=build_spectre_report(log,execution_state=execution,exit_code=record.get('simulator_exit_code'),
            acceptance=acceptance,log_complete=True,qualification_scope=data['qualification_scope'],dependency_audit=dependency,run_id=rid)
        return {'schema':'ic.experiment-result.v1','run_id':rid,'source_commit':record['source_commit'],
                'native_archive_sha256':record['collection']['sha256'],'report':report,'measurements':measured}

    @staticmethod
    def _measurement_acceptance(measured):
        return {'data_validity':measured.get('data_validity','unknown'),
                'specification':measured.get('specification','unknown')}

    @staticmethod
    def _report_dependencies(audit,data,record):
        # The dependency module supplies evidence only. This trusted adapter binds
        # it to the native run whose prelaunch checksum archive was just verified.
        entries=[]
        files={row['path']:row for row in data['dependency_audit']['files']}
        seen=set()
        for row in audit.get('references',[]):
            path=row['path']
            if path in seen:continue
            seen.add(path)
            roles=files.get(path,{}).get('roles',[])
            kind=('directory' if row['kind']=='directory' else 'tmi_library' if path.endswith('/libTMImodel.so')
                  else 'tool_config' if 'tool_config' in roles else 'tool_library' if 'dynamic_library' in roles else 'model_file')
            registered=(row['pin_status']=='pre_pinned' or row['kind']=='directory' and row.get('prelaunch_declared') is True) and not row['postrun_observed']
            entry={'dependency_id':hashlib.sha256(path.encode()).hexdigest(),
                'kind':kind,'pre_pinned':registered,
                'hash_matches':True if registered and kind!='directory' else None,'observed':True}
            if row.get('sha256'):entry['evidence_sha256']=row['sha256']
            entries.append(entry)
        return {'run_id':record['run_id'],'scope_id':'declared-and-observed-model-tool-dependencies',
                'manifest_sha256':digest(data['dependency_audit']),'run_bound':True,
                'inventory_complete':audit.get('status')=='covered_by_declared_prelaunch_pins','entries':entries}
