"""Durable standalone runner. No automatic launch retries, no CIW access."""
import contextlib, fcntl, hashlib, hmac, json, os, re, subprocess, tarfile, time, uuid
import csv,io,math
import copy
from datetime import datetime, timezone
from pathlib import Path
import ic_sim as core

TERMINAL={'simulator_complete_pending_measurements','simulator_failed','input_hash_failure','job_setup_failed'}
def stamp():return datetime.now(timezone.utc).isoformat()
def atomic(path,obj):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp');tmp.write_text(json.dumps(obj,indent=2)+'\n');os.chmod(tmp,0o600);tmp.replace(path)
@contextlib.contextmanager
def locked(path):
    Path(path).parent.mkdir(parents=True,exist_ok=True)
    with open(path,'a') as f:
        fcntl.flock(f,fcntl.LOCK_EX)
        try:yield
        finally:fcntl.flock(f,fcntl.LOCK_UN)
def filehash(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()
def postprocess_config(spec):
    if spec is None:return None
    if not isinstance(spec,dict) or set(spec)-{'signals','start_s','end_s','step_s','max_display_points'}:raise ValueError('invalid postprocess configuration')
    signals=spec.get('signals',[])
    if not isinstance(signals,list) or not 1<=len(signals)<=32:raise ValueError('postprocess needs 1..32 explicit signals')
    normalized=[]
    for item in signals:
        if isinstance(item,str):item={'name':item,'unit':'V'}
        if not isinstance(item,dict) or set(item)-{'name','unit'} or not re.fullmatch(r'[A-Za-z0-9_./<>\\:-]{1,160}',item.get('name','')) or item.get('unit') not in ['V','A']:raise ValueError('invalid postprocess signal/unit')
        normalized.append(item)
    start=float(spec.get('start_s',0));end=float(spec['end_s']);step=float(spec['step_s']);points=int(spec.get('max_display_points',1600))
    if not all(math.isfinite(x) for x in [start,end,step]) or start<0 or end<=start or step<=0 or (end-start)/step>200000 or not 100<=points<=5000:raise ValueError('postprocess window/step exceeds bounded export')
    return {'signals':normalized,'start_s':start,'end_s':end,'step_s':step,'max_display_points':points}
def command(script):
    import base64
    return '/bin/sh -c '+core.q('eval "$(printf %s '+base64.b64encode(script.encode()).decode()+' | /usr/bin/base64 -d)"')

class ExecutionBindingError(ValueError):
    """A local execution identity check failed; it says nothing about the solver."""
    def __init__(self, code):
        self.code = code
        super().__init__(code.replace('_', ' '))

def json_snapshot(value):
    return json.loads(json.dumps(value, sort_keys=True, allow_nan=False))

def record_digest(value):
    return core.sha(json.dumps(value, sort_keys=True, allow_nan=False).encode())

def validated_site(value):
    """Reuse the original site loader's rules without writing a temporary site."""
    if not isinstance(value, dict):
        raise ExecutionBindingError('execution_site_invalid')
    class Document:
        def read_text(self):
            return json.dumps(value, sort_keys=True, allow_nan=False)
    try:
        return copy.deepcopy(core.site_load(Document()))
    except (ValueError, TypeError, AttributeError, KeyError):
        raise ExecutionBindingError('execution_site_invalid') from None

def validated_execution_context(value):
    if value is None:
        return None
    if (not isinstance(value, dict) or set(value) - {'schema', 'plan_id', 'site', 'resource_selection'}
            or not {'schema', 'plan_id', 'site'}.issubset(value)
            or value.get('schema') != 'ic.execution.context.v1'
            or not isinstance(value.get('plan_id'), str)
            or not re.fullmatch('[a-f0-9]{64}', value['plan_id'])):
        raise ExecutionBindingError('execution_context_invalid')
    try:
        frozen = json_snapshot(value)
    except (TypeError, ValueError):
        raise ExecutionBindingError('execution_context_invalid') from None
    frozen['site'] = validated_site(frozen['site'])
    selection = frozen.get('resource_selection')
    if selection is not None and (not isinstance(selection, dict)
            or not isinstance(selection.get('host_id'), str) or not selection['host_id']):
        raise ExecutionBindingError('resource_selection_invalid')
    return frozen

def materialization_metadata(proof):
    data = proof.get('materialization')
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError('invalid verified materialization')
    metadata = {}
    for field in ('library_id', 'cell_id'):
        if field not in data:
            continue
        value = data[field]
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}', value):
            raise ValueError('invalid materialization ' + field)
        metadata[field] = value
    return metadata

class Record(dict):
    """Tracks only locally changed fields so polling cannot erase other receipts."""
    def __init__(self,data):super().__init__(data);self.baseline=copy.deepcopy(data)
class Runner:
    def __init__(self,root,site,frozen_root=None,signing_key=None,resource_recheck=None):
        self.root=Path(root).resolve();self.root.mkdir(parents=True,exist_ok=True);self.site=copy.deepcopy(site);self.frozen_root=Path(frozen_root).resolve() if frozen_root else None;self.signing_key=signing_key;self.resource_recheck=resource_recheck
    def prepare(self,bundle,site=None):
        site=validated_site(self.site if site is None else site)
        b,payload,proof=core.prepare(Path(bundle),site);sidecar=Path(bundle).parent/'materialization.json'
        if self.frozen_root and Path(bundle).resolve().is_relative_to(self.frozen_root):
            signed=json.loads(sidecar.read_text());data=signed['data'];actual=hmac.new(self.signing_key,json.dumps(data,sort_keys=True).encode(),hashlib.sha256).hexdigest()
            if not hmac.compare_digest(actual,signed['signature']) or data['bundle_sha256']!=filehash(bundle):raise ValueError('invalid gateway materialization signature')
            proof.update(source_commit=data['source_commit'],source_clean=True,materialization=data)
        materialization_metadata(proof)
        return b,payload,proof
    def execution_site(self,r):
        if 'execution_site' not in r:
            if any(name in r for name in ('execution_site_sha256','execution_context','execution_context_sha256')):
                raise ExecutionBindingError('execution_site_missing')
            site=validated_site(self.site)
            if 'ssh_target' in r and r['ssh_target']!=site['ssh_target']:
                raise ExecutionBindingError('legacy_execution_site_mismatch')
            return site
        site=validated_site(r['execution_site'])
        if r.get('execution_site_sha256')!=record_digest(site):
            raise ExecutionBindingError('execution_site_digest_mismatch')
        if r.get('ssh_target')!=site['ssh_target'] or r.get('remote_directory')!=site['remote_runs_root']+'/'+r['run_id']:
            raise ExecutionBindingError('execution_site_binding_mismatch')
        if not {'execution_context','execution_context_sha256'}.issubset(r):
            raise ExecutionBindingError('execution_context_missing')
        context=r.get('execution_context')
        if context is not None:
            frozen=validated_execution_context(context)
            if frozen['site']!=site or r.get('execution_context_sha256')!=record_digest(frozen):
                raise ExecutionBindingError('execution_context_digest_mismatch')
        elif r.get('execution_context_sha256') is not None:
            raise ExecutionBindingError('execution_context_missing')
        return site
    def recheck_resources(self,r):
        selection=(r.get('execution_context') or {}).get('resource_selection')
        if selection is None:return
        host=selection['host_id']
        if not callable(self.resource_recheck):
            r['prelaunch_resources']={'eligible':False,'host_id':host,'checked_at':stamp(),'error_code':'resource_recheck_missing'}
            self.save(r)
            raise ExecutionBindingError('resource_recheck_missing')
        try:
            evidence=json_snapshot(self.resource_recheck(copy.deepcopy(selection)))
        except Exception:
            r['prelaunch_resources']={'eligible':False,'host_id':host,'checked_at':stamp(),'error_code':'resource_recheck_failed'}
            self.save(r)
            raise ExecutionBindingError('resource_recheck_failed') from None
        valid=not (not isinstance(evidence,dict) or evidence.get('eligible') is not True
                or evidence.get('host_id')!=host or not isinstance(evidence.get('checked_at'),str)
                or not evidence['checked_at'] or not isinstance(evidence.get('selection'),dict)
                or evidence['selection'].get('host_id')!=host)
        if valid:
            try:
                valid=datetime.fromisoformat(evidence['checked_at'].replace('Z','+00:00')).utcoffset() is not None
            except ValueError:valid=False
        if not valid:
            r['prelaunch_resources']={'eligible':False,'host_id':host,'checked_at':stamp(),
                'error_code':'resource_recheck_rejected','response':evidence}
            self.save(r)
            raise ExecutionBindingError('resource_recheck_rejected')
        r['prelaunch_resources']=evidence
        self.save(r)
    def path(self,rid):
        if not re.fullmatch(r'[A-Za-z0-9_-]+',rid):raise ValueError('invalid run id')
        return self.root/rid
    def read(self,rid):return Record(json.loads((self.path(rid)/'run.json').read_text()))
    def save(self,r):
        path=self.path(r['run_id'])/'run.json';baseline=getattr(r,'baseline',{})
        changed={key:value for key,value in r.items() if key not in baseline or baseline[key]!=value};deleted=set(baseline)-set(r)
        # One short shared lock for every writer. No network or recursive call here.
        with locked(path.parent/'record.lock'):
            current=json.loads(path.read_text()) if path.exists() else {}
            current.update(changed)
            for key in deleted:current.pop(key,None)
            current['updated_at']=stamp();atomic(path,current)
        r.clear();r.update(current)
        if isinstance(r,Record):r.baseline=copy.deepcopy(current)
    def list(self):return [json.loads(p.read_text()) for p in sorted(self.root.glob('*/run.json'),reverse=True)]
    def lookup_submission(self,key):
        """Read an existing reservation. Never create an index, lock, run or dispatch."""
        if not isinstance(key,str) or not 8<=len(key)<=160 or any(ord(c)<32 or ord(c)==127 for c in key):
            raise ValueError('submission key must contain 8..160 printable characters')
        path=self.root/'keys.json'
        if path.is_symlink():raise ValueError('Submission index must be a regular local file')
        if not path.exists():return None
        with path.open('rb') as stream:raw=stream.read(1024*1024+1)
        if len(raw)>1024*1024:raise ValueError('Submission index exceeds read limit')
        keys=json.loads(raw)
        if not isinstance(keys,dict):raise ValueError('Invalid submission index')
        if key not in keys:return None
        entry=keys[key]
        if not isinstance(entry,dict) or not re.fullmatch('[A-Za-z0-9_-]{1,180}',str(entry.get('run_id',''))):
            raise ValueError('Invalid saved submission mapping')
        return entry['run_id']
    def plan(self,bundle,expected_commit=None,site=None):
        b,payload,proof=self.prepare(Path(bundle),site=site);sim=core.simulator_config(b)
        if expected_commit and proof['source_commit']!=expected_commit:raise ValueError('source_commit conflict')
        if Path(b['entrypoint']).parent!=Path('netlist'):raise ValueError('entrypoint must be within netlist/')
        return {'schema':'ic.sim.plan.v2',**{k:b.get(k) for k in ['design_id','design_origin','library','top_cell','testbench','test','test_id','history','configuration','historical_reference']},**materialization_metadata(proof),'postprocess':postprocess_config(b.get('postprocess')),'entrypoint':b['entrypoint'],'simulator':sim,'provenance':proof,'external_sha256':core.external_pins(b),'reviewed_for_distribution':bool(b.get('reviewed_for_distribution')),'blockers':[s for c,s in [(not proof['source_clean'],'dirty_source'),(not proof['source_commit'],'uncommitted_source'),(not b.get('reviewed_for_distribution'),'review_required')] if c]}
    def preflight(self,bundle,expected_commit=None,site=None):
        site=validated_site(self.site if site is None else site)
        plan=self.plan(bundle,expected_commit,site=site);b,_,proof=self.prepare(Path(bundle),site=site);p=core.doctor(site)
        if p['exit_code'] or not p['identity_ok'] or not p['all_references_readable'] or not p['all_tools_available']:raise ValueError('remote preflight failed: '+json.dumps(p))
        pins=core.check_external(b,site,p)
        if not core.required_aliases(proof,site).issubset(pins):raise ValueError('missing external hash pins')
        return {'plan':plan,'probe':p}
    def reserve(self,bundle,key,expected_commit,project_id=None,configuration=None,execution_context=None):
        if not isinstance(key,str) or not 8<=len(key)<=160:raise ValueError('idempotency_key must contain 8..160 characters')
        context=validated_execution_context(execution_context)
        bundle=Path(bundle).resolve();identity=[str(bundle),expected_commit,project_id,configuration]
        if context is not None:identity.append(context)
        fingerprint=record_digest(identity)
        with locked(self.root/'keys.lock'):
            index_path=self.root/'keys.json';keys=json.loads(index_path.read_text()) if index_path.exists() else {}
            if key in keys:
                old=keys[key]
                if old['fingerprint']!=fingerprint:raise ValueError('idempotency_key already binds different input')
                return self.read(old['run_id']),False
            site=validated_site(self.site if context is None else context['site'])
            plan=self.plan(bundle,expected_commit,site=site)
            if plan['blockers']:raise ValueError('submission blocked: '+','.join(plan['blockers']))
            b,_,proof=self.prepare(bundle,site=site);root=Path(proof['source_root'])
            if proof!=plan['provenance']:raise ValueError('sources changed during reservation')
            if 'materialization' in proof:
                data=proof['materialization']
                for field,expected in (('source_commit',expected_commit),('project_id',project_id),('configuration',configuration)):
                    if expected is not None and data.get(field)!=expected:raise ValueError('materialization identity conflict: '+field)
            if 'materialization' not in proof:
                for p in [bundle]+[Path(f['source']) for f in proof['files']]:
                    if not p.is_relative_to(root) or core.git(root,'ls-files','--error-unmatch','--',str(p.relative_to(root))) is None:raise ValueError('bundle sources must be tracked')
            rid=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+expected_commit[:10]+'-'+uuid.uuid4().hex[:8]
            r={'schema':'ic.sim.run.v2','run_id':rid,'job_id':rid,'state':'queued','created_at':stamp(),'source_commit':expected_commit,'project_id':project_id,'configuration_id':configuration,'bundle_path':str(bundle),'ssh_target':site['ssh_target'],'remote_directory':site['remote_runs_root']+'/'+rid,'execution_site':copy.deepcopy(site),'execution_site_sha256':record_digest(site),'execution_context':copy.deepcopy(context),'execution_context_sha256':record_digest(context) if context is not None else None,**materialization_metadata(proof),'plan':plan,'collection':None,'publication':None,'launch_attempts':0}
            self.save(r);keys[key]={'run_id':rid,'fingerprint':fingerprint};atomic(index_path,keys);return r,True
    def dispatch(self,rid):
        with locked(self.path(rid)/'dispatch.lock'):
            r=self.read(rid)
            if r['state']!='queued':return r
            try:
                site=self.execution_site(r)
                self.recheck_resources(r)
                site=self.execution_site(r)
                r['state']='preflight';self.save(r)
                check=self.preflight(r['bundle_path'],r['source_commit'],site=site);r['runtime_preflight']=check['probe'];self.save(r)
                b,payload,proof=self.prepare(Path(r['bundle_path']),site=site)
                if proof!=r['plan']['provenance']:raise ValueError('sources changed after reservation')
                payload.update(core.scripts(site,b['entrypoint'],r['plan']['simulator']))
                # Retain exact identity/config/model hashes on the server, no credentials.
                payload['run.json']=json.dumps(r,indent=2).encode()
                pins=[(h,site['external_files'][k]) for k,h in r['plan']['external_sha256'].items()]
                pins += [(check['probe']['dependency_sha256'][k],site[name]) for k,name in [('cadence_setup','cadence_cshrc'),('spectre','spectre_bin')]]
                payload['external.sha256']=''.join(h+'  '+p+'\n' for h,p in pins).encode()
                payload['payload.sha256']=''.join(core.sha(v)+'  '+k+'\n' for k,v in sorted(payload.items())).encode()
                r['state']='staging_outcome_unknown';self.save(r)
                p=core.ssh(site,core.stage_command(site,r['remote_directory']),timeout=60,data=core.archive(payload))
                if p.returncode:raise ValueError('stage exit '+str(p.returncode)+': '+p.stderr.decode(errors='replace'))
                r['state']='launch_outcome_unknown';r['launch_attempts']=1;self.save(r)
                p=core.ssh(site,core.launch_command(r['remote_directory']))
                if p.returncode:raise ValueError('launch exit '+str(p.returncode)+': '+p.stderr.decode(errors='replace'))
                r['state']='submitted';r['submitted_at']=stamp();self.save(r)
            except Exception as e:
                if r['state']=='preflight' or isinstance(e,ExecutionBindingError) and e.code.startswith('resource_recheck_'):
                    r['state']='preflight_failed'
                if isinstance(e,ExecutionBindingError):r['error_code']=e.code
                r['error']=str(e);self.save(r)
            return r
    def status(self,rid):
        with locked(self.path(rid)/'state.lock'):
            r=self.read(rid)
            try:site=self.execution_site(r)
            except ExecutionBindingError as e:
                r['status_attempted_at']=stamp();r['status_transport']='blocked'
                r['status_error']=str(e);r['status_error_code']=e.code;self.save(r);return r
            if r['state'] in ['queued','preflight','preflight_failed']:return r
            remote=r['remote_directory']
            script=f'''cd {core.q(remote)} || exit 70
printf 'STATE '; cat state 2>/dev/null || true
printf 'EXIT '; cat exit_code 2>/dev/null || true
printf 'PID '; cat supervisor.pid 2>/dev/null || true
if test -f supervisor.pid; then p=$(cat supervisor.pid); kill -0 "$p" 2>/dev/null && printf 'ALIVE yes\n' || printf 'ALIVE no\n'; fi
test ! -f psf/spectre.out || tail -c 60000 psf/spectre.out
'''
            try:
                r['status_attempted_at']=stamp()
                p=core.ssh(site,script)
                if p.returncode:
                    r['status_transport']='disconnected';r['status_error_code']='ssh_status_failed'
                    r['status_error']='Remote status read failed with exit '+str(p.returncode)
                    self.save(r);return r
                txt=p.stdout.decode(errors='replace');s=re.search(r'^STATE (\S+)',txt,re.M);state=s[1] if s else 'unknown'
                r['observed_at']=stamp();r['remote_state']=state;r['remote_status_exit']=p.returncode
                r['status_transport']='connected';r.pop('status_error',None);r.pop('status_error_code',None)
                r['process_observed_alive']='ALIVE yes' in txt
                e=re.search(r'^EXIT (\d+)',txt,re.M);r['simulator_exit_code']=int(e[1]) if e else None
                r['state']=state if state in TERMINAL else ('running_observed' if state=='running' and r['process_observed_alive'] else 'reconcile_required')
                (self.path(rid)/'latest-status.log').write_text(txt)
            except Exception as e:r['status_transport']='disconnected';r['status_error_code']='ssh_status_failed';r['status_error']=str(e)
            self.save(r);return r
    def collect(self,rid):
        with locked(self.path(rid)/'collect.lock'):
            existing=self.read(rid)
            self.execution_site(existing)
            if existing.get('collection_phase') and existing.get('collection_phase') != 'complete':
                raise ValueError('Previous collection outcome requires reconciliation; automatic replay is disabled')
            completed=existing.get('collection')
            if completed and existing.get('collection_phase') == 'complete':
                archive=Path(completed['archive'])
                if not archive.is_file() or archive.is_symlink() or filehash(archive)!=completed.get('sha256'):
                    raise ValueError('Collected native archive changed; reconcile before collecting again')
                desired=existing.get('postprocess_csv_sha256')
                local=(existing.get('local_derivation') or {}).get('native_archive_sha256')==completed['sha256']
                inventory=json.loads((self.path(rid)/'archive-files.json').read_text())
                if not desired or local or any(row.get('path','').endswith('/waveforms.csv') and row.get('sha256')==desired for row in inventory):
                    return existing
            if existing.get('publication'):
                c=existing.get('collection')
                expected=(existing['publication'].get('full_archive_sha256') or (c or {}).get('sha256'))
                if not c or not Path(c['archive']).exists() or filehash(c['archive'])!=expected:raise ValueError('published archive changed; explicit new version required')
                return existing
            r=self.status(rid)
            site=self.execution_site(r)
            if r.get('remote_state') not in TERMINAL:raise ValueError('collection requires observed terminal run; no partial success claim')
            root=self.path(rid);remote=r['remote_directory'];r['collection_phase']='preparing';self.save(r)
            # Full run result tree, including generated solver outputs outside psf.
            # AHDL compiled cache is excluded; neither site env nor PDK bodies are copied.
            script=f'''cd {core.q(remote)} || exit 70
mkdir -p exports || exit 70
find . -type f ! -path './ahdl/*' ! -path './exports/*' ! -path './launch_once/*' -print0 | sort -z | xargs -0 sha256sum > exports/files.new || exit 71
if test ! -f exports/full-results.tar.gz || ! cmp -s exports/files.new exports/files.sha256; then
  tar czf exports/full-results.tar.gz.part --exclude='./ahdl' --exclude='./exports' --exclude='./launch_once' . || exit 71
  mv exports/full-results.tar.gz.part exports/full-results.tar.gz || exit 71
  mv exports/files.new exports/files.sha256 || exit 71
fi
sha256sum exports/full-results.tar.gz
wc -c < exports/full-results.tar.gz
'''
            p=core.ssh(site,script,timeout=600)
            if p.returncode:raise ValueError('remote archive generation failed: '+p.stderr.decode(errors='replace'))
            lines=p.stdout.decode().splitlines();expected=lines[-2].split()[0];size=int(lines[-1]);out=root/'full-results.tar.gz';part=out.with_suffix('.part')
            argv=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',site['ssh_target'],command('cat '+core.q(remote+'/exports/full-results.tar.gz'))]
            with part.open('wb') as f:p=subprocess.run(argv,stdout=f,stderr=subprocess.PIPE,timeout=1200)
            if p.returncode or part.stat().st_size!=size or filehash(part)!=expected:raise ValueError('archive transfer checksum/size mismatch')
            if out.exists() and filehash(out)!=expected:
                history=root/'archives';history.mkdir(exist_ok=True);out.replace(history/(filehash(out)+'.tar.gz'))
            part.replace(out)
            inventory=[];logs={}
            with tarfile.open(out,'r:gz') as tf:
                for member in tf:
                    if not member.isfile():continue
                    if member.name.startswith('/') or '..' in Path(member.name).parts:raise ValueError('unsafe archive member')
                    f=tf.extractfile(member);h=hashlib.sha256()
                    for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
                    inventory.append({'path':member.name,'bytes':member.size,'sha256':h.hexdigest()})
                    if member.name in ['./psf/spectre.out','./console.log'] and member.size<10*1024*1024:logs[member.name]=tf.extractfile(member).read().decode(errors='replace')
            if r['remote_state']=='simulator_complete_pending_measurements' and not any('/psf/' in m['path'] and 'tran' in m['path'] for m in inventory):raise ValueError('success archive has no transient raw result')
            summary={'execution_success':r['remote_state']=='simulator_complete_pending_measurements','scientific_acceptance':False,'source_commit':r['source_commit'],'configuration':r['plan'].get('configuration'),'metrics':r.get('scientific_metrics',[]),'postprocess_phase':r.get('postprocess_phase'),'simulator_footer':re.findall(r'spectre completes with .*',logs.get('./psf/spectre.out',''))[-1:]}
            atomic(root/'result-summary.json',summary);atomic(root/'archive-files.json',inventory)
            r['collection']={'archive':str(out),'sha256':expected,'bytes':size,'file_count':len(inventory),'contains_full_raw':True,'included':'all regular files from run tree','excluded':['ahdl compiled cache','exports packaging scratch','launch_once directory'],'summary':summary,'collected_at':stamp()};r['collection_phase']='complete';self.save(r);return r
    def postprocess(self,rid,wait_seconds=90):
        """Export a few actual signals through an independent owned OCEAN process."""
        with locked(self.path(rid)/'postprocess.lock'):
            self.execution_site(self.read(rid))
            r=self.status(rid)
            site=self.execution_site(r)
            if r.get('remote_state')!='simulator_complete_pending_measurements':raise ValueError('postprocess requires successful completed Spectre run')
            root=self.path(rid)
            if r.get('postprocess_phase')=='complete':return json.loads((root/'waveforms.json').read_text())
            if r.get('publication'):raise ValueError('published run is frozen; postprocess needs an explicit new archive version')
            if 'postprocess_remote' not in r:
                spec=postprocess_config(r['plan'].get('postprocess'))
                if spec is None:
                    r['postprocess_phase']='not_configured';self.save(r);raise ValueError('No committed postprocess configuration: native raw retained; no signals/window guessed')
                signals=[x['name'] for x in spec['signals']];end=spec['end_s'];r['postprocess_config']=spec
                remote=r['remote_directory']+'/analysis-'+uuid.uuid4().hex[:8];r['postprocess_remote']=remote;r['postprocess_signals']=signals;r['postprocess_phase']='reserved';self.save(r)
                quoted=lambda s:json.dumps(s)
                ocn='openResults('+quoted(r['remote_directory']+'/psf')+")\nselectResult('tran)\n"
                ocn+='awvSaveToCSV(list('+ ' '.join('getData('+quoted(s)+" ?result 'tran)" for s in signals)+') '+quoted(remote+'/waveforms.csv')+f' ?from {spec["start_s"]:.12g} ?to {end:.12g} ?step {spec["step_s"]:.12g} ?precision 15 ?exprList list('+ ' '.join(quoted(s) for s in signals)+') ?mergeXAxis t)\n'
                ocn+='let((f) f=outfile('+quoted(remote+'/done')+') fprintf(f "done\\n") close(f))\nexit()\n'
                run='#!/bin/csh -f\nsource '+site['cadence_cshrc']+'\ncd '+remote+'\n/usr/bin/xvfb-run -a -s "-screen 0 1600x1000x24" '+site['ocean_bin']+' -nograph -nocdsinit -restore postprocess.ocn > ocean.log\n'
                p=core.ssh(site,core.stage_command(site,remote),data=core.archive({'postprocess.ocn':ocn.encode(),'run.csh':run.encode()}))
                if p.returncode:r['postprocess_phase']='stage_failed';self.save(r);raise ValueError('postprocess stage failed')
                r['postprocess_phase']='launch_outcome_unknown';self.save(r)
                p=core.ssh(site,'cd '+core.q(remote)+' || exit 70\nnohup /bin/csh -f run.csh > launcher.log 2>&1 </dev/null &\necho $! > ocean.pid\n')
                if p.returncode:raise ValueError('postprocess launch outcome unknown; do not relaunch')
            remote=r['postprocess_remote'];deadline=time.monotonic()+wait_seconds
            while time.monotonic()<deadline:
                p=core.ssh(site,'test -f '+core.q(remote+'/done')+' && test -s '+core.q(remote+'/waveforms.csv'))
                if p.returncode==0:break
                time.sleep(2)
            else:
                r['postprocess_phase']='reconcile_required';self.save(r);raise ValueError('OCEAN export incomplete; raw results remain available, retry only checks original export')
            p=core.ssh(site,'cat '+core.q(remote+'/waveforms.csv'))
            if p.returncode:raise ValueError('CSV download failed')
            (root/'waveforms.csv').write_bytes(p.stdout);rows=list(csv.reader(io.StringIO(p.stdout.decode())));header=rows[0];data=[[float(x) for x in row] for row in rows[1:] if row]
            if not data or not all(math.isfinite(x) for row in data for x in row):raise ValueError('nonfinite/empty exported waveforms')
            if not all(a[0]<b[0] for a,b in zip(data,data[1:])):raise ValueError('nonmonotonic exported time')
            spec=r.get('postprocess_config');limit=spec['max_display_points'] if spec else 1600
            stride=max(1,math.ceil(len(data)/limit));indices=sorted(set(range(0,len(data),stride))|{len(data)-1});waves=[]
            for i,signal in enumerate(r['postprocess_signals'],1):waves.append({'name':signal,'unit':spec['signals'][i-1]['unit'] if spec else 'V','time_unit':'s','run_id':rid,'source_commit':r['source_commit'],'points':[[data[j][0],data[j][i]] for j in indices]})
            result={'run_id':rid,'source_commit':r['source_commit'],'configuration':spec,'csv_sha256':filehash(root/'waveforms.csv'),'csv_samples':len(data),'waveforms':waves,'method':'Independent OCEAN from this exact run PSFXL; display-only decimation; no historical CSV reuse'}
            atomic(root/'waveforms.json',result)
            try:
                os.environ.setdefault('MPLCONFIGDIR',str(self.root/'.mplconfig'))
                from matplotlib.figure import Figure
                from matplotlib.backends.backend_agg import FigureCanvasAgg
                fig=Figure(figsize=(10,2.2*len(waves)));FigureCanvasAgg(fig)
                axes=fig.subplots(len(waves),1,sharex=True,squeeze=False)
                for ax,wave in zip(axes[:,0],waves):
                    ax.plot([x[0] for x in wave['points']],[x[1] for x in wave['points']],linewidth=.8);ax.set_ylabel(wave['name']+' ('+wave['unit']+')');ax.grid(alpha=.2)
                axes[-1,0].set_xlabel('Time (s)');fig.suptitle(rid,fontsize=9);fig.tight_layout();fig.savefig(root/'waveforms.png',dpi=130)
                sent=core.ssh(site,'cat > '+core.q(remote+'/waveforms.png'),data=(root/'waveforms.png').read_bytes())
                if sent.returncode:raise ValueError('PNG upload failed')
                r['plot_status']='complete'
            except Exception as e:r['plot_status']='failed';r['plot_error']=str(e)
            # Include derived display JSON in the next complete server archive too.
            p=core.ssh(site,'cat > '+core.q(remote+'/waveforms.json'),data=(root/'waveforms.json').read_bytes())
            if p.returncode:raise ValueError('derived JSON upload failed; collection not refreshed')
            r['postprocess_phase']='complete';r['postprocess_csv_sha256']=result['csv_sha256'];self.save(r);return result

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--site',required=True,type=Path);p.add_argument('--runs',required=True,type=Path);p.add_argument('action',choices=['submit','status','collect']);p.add_argument('--bundle',type=Path);p.add_argument('--commit');p.add_argument('--key');p.add_argument('--id');a=p.parse_args();runner=Runner(a.runs,core.site_load(a.site))
    if a.action=='submit':
        r,new=runner.reserve(a.bundle,a.key,a.commit);print(json.dumps(r),flush=True)
        if new:r=runner.dispatch(r['run_id'])
    else:r=getattr(runner,a.action)(a.id)
    print(json.dumps(r,indent=2))
