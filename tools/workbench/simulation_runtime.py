"""Optional simulation control: explicit operator scope, stored UI, one Runner."""
import hashlib
import csv
import io
import tarfile
import importlib
import json
import re
import threading
from pathlib import Path

from runner import atomic, locked, stamp, TERMINAL
from supervision import execution_target

OPERATIONS = {'submit', 'status', 'collect', 'watch', 'unwatch', 'resources_scan', 'runtime'}
CALLERS = {'paired-helper', 'local-studio', 'native-agent', 'spiceowl-local'}
IDENTITY = {'project_id', 'configuration', 'source_commit'}


def policy(config):
    if config is None:
        return None
    if (not isinstance(config, dict) or not {'enabled', 'projects', 'hosts', 'callers', 'operations'} <= set(config) or set(config) - {'enabled', 'projects', 'hosts', 'callers', 'operations', 'authority_key_file', 'resume_monitors'} or type(config['enabled']) is not bool):
        raise ValueError('Invalid simulation_direct operator policy')
    if 'resume_monitors' in config and type(config['resume_monitors']) is not bool:
        raise ValueError('resume_monitors must be explicitly boolean')
    for key in ('projects', 'hosts', 'callers', 'operations'):
        values = config[key]
        if not isinstance(values, list) or not 1 <= len(values) <= 128 or len(set(values)) != len(values) or any(not isinstance(x, str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}', x) for x in values):
            raise ValueError('Invalid simulation policy allowlist: ' + key)
    if not set(config['callers']) <= CALLERS or not set(config['operations']) <= OPERATIONS:
        raise ValueError('Unsupported simulation authority or operation')
    return config


class _MonitorRunner:
    """Apply current connection grants before the shared monitor's remote I/O."""
    def __init__(self, runtime):
        self.runtime = runtime
        self.runner = runtime.app.runner
        self.root = self.runner.root

    def path(self, rid):
        return self.runner.path(rid)

    def read(self, rid):
        return self.runner.read(rid)

    def status(self, rid):
        if not self.runtime.watch_permitted(rid):
            return {**self.read(rid), 'status_transport': 'blocked'}
        return self.runner.status(rid)

    def collect(self, rid):
        raise PermissionError('This runtime requires an explicit collection operation')


class SimulationRuntime:
    def __init__(self, app):
        self.app = app
        self.scope = policy(app.cfg.get('simulation_direct'))
        self.root = Path(app.cfg['runtime_root']) / 'simulation-runtime'
        self._mutex = threading.RLock()
        self._scan = None
        self._monitor = None
        # Construction never starts probes, a worker, or an external dependency.

    def caller(self, headers, method, path, raw=b''):
        caller = headers.get('X-IC-Simulation-Caller')
        if caller is None:
            return 'local-studio'
        if caller == 'local-studio':
            raise PermissionError('The local browser cannot inject a caller identity')
        scope = self.scope or {}
        if not scope.get('authority_key_file') or not headers.get('X-IC-Simulation-Authorization'):
            raise PermissionError('Simulation caller authorization was not established')
        try:
            from spiceowl.integrations.authority import load_key, verify
            return verify(load_key(scope['authority_key_file']), caller, method, path, raw,
                          headers.get('X-IC-Simulation-Authorization'))
        except (ImportError, OSError, ValueError, TypeError):
            raise PermissionError('Simulation caller authorization was not established') from None

    def permitted(self, caller, operation, project):
        return bool(self.scope and self.scope['enabled'] and caller in self.scope['callers']
                    and operation in self.scope['operations'] and project in self.scope['projects'])

    def authorize(self, caller, operation, project):
        if not self.permitted(caller, operation, project):
            raise PermissionError('Simulation operation is outside the installed connection grant')
        if project not in self.app.workspace.projects:
            raise ValueError('Unknown registered simulation project')

    def monitor(self):
        with self._mutex:
            if self._monitor is None:
                from simulation_monitor import RuntimeMonitor
                self._monitor = RuntimeMonitor(_MonitorRunner(self))
            return self._monitor

    def watch_permitted(self, rid):
        path = self.app.runner.path(rid) / 'monitor-authority.json'
        try:
            if not path.is_file() or path.is_symlink() or path.stat().st_size > 8192:
                return False
            grant = json.loads(path.read_text())
            if set(grant) != {'caller', 'identity'}:
                return False
            args = grant['identity']
            if args.get('run_id') != rid:
                return False
            self.authorize(grant['caller'], 'watch', args['project_id'])
            self.bound_run(args)
            return True
        except (OSError, ValueError, TypeError, KeyError, PermissionError):
            return False

    def arm(self, run, caller):
        rid = run['run_id']
        args = {'run_id': rid, 'project_id': run['project_id'],
                'configuration': run['configuration_id'], 'source_commit': run['source_commit']}
        self.authorize(caller, 'watch', args['project_id'])
        self.bound_run(args)
        atomic(self.app.runner.path(rid) / 'monitor-authority.json', {'caller': caller, 'identity': args})
        mon = self.monitor()
        receipt = mon.watch(rid, allow_collect=False)
        mon.start()
        return receipt

    def resume(self):
        """Explicit process-start policy; never called by construction or GET."""
        if not self.scope or not self.scope['enabled'] or not self.scope.get('resume_monitors', False):
            return False
        try:
            mon = self.monitor()
            eligible = [r for r in mon.snapshot()['watches'] if r and r.get('watch_state') == 'armed'
                        and r.get('allow_collect') is False and self.watch_permitted(r['run_id'])]
            if eligible:
                mon.start()
                return True
        except (ImportError, OSError, ValueError, TypeError, KeyError):
            atomic(self.root / 'monitor-start-error.json', {'at': stamp(), 'code': 'monitor_resume_unavailable'})
        return False

    def close(self):
        if self._monitor is not None:
            self._monitor.stop(timeout=1)

    def pool_snapshot(self):
        path = self.root / 'pool.json'
        if path.is_file() and not path.is_symlink() and path.stat().st_size <= 65536:
            try:
                data = json.loads(path.read_text())
                if data.get('schema') == 'spiceowl.host-pool.snapshot.v1':
                    return {'configured': True, 'checked_at': data['checked_at'], 'hosts': data['hosts'],
                            'scan_in_progress': bool(self._scan and not self._scan.done())}
            except (OSError, ValueError, KeyError):
                pass
        return {'configured': self.app.resource_pool is not None, 'checked_at': None, 'hosts': [],
                'scan_in_progress': bool(self._scan and not self._scan.done())}

    def scan(self, project, caller):
        self.authorize(caller, 'resources_scan', project)
        pool = self.app.resource_pool
        if pool is None:
            raise ValueError('Resource pool is not configured')
        members = [host for host in pool.members if host in self.scope['hosts']]
        if not members:
            raise PermissionError('No configured host is included in this connection grant')
        with self._mutex:
            if self._scan is None or self._scan.done():
                def scan_once():
                    try:
                        data = pool._backend().scan_resources(members)
                        atomic(self.root / 'pool.json', data)
                        return {'state': 'complete'}
                    except Exception:
                        at=stamp()
                        atomic(self.root/'pool.json',{'schema':'spiceowl.host-pool.snapshot.v1','checked_at':at,'hosts':[{'host_id':host,'label':host,'reachable':False,'cpu_busy_percent':None,'load_1m':None,'cpu_count':None,'memory_available_bytes':None,'memory_total_bytes':None,'observed_at':None,'error_code':'scan_failed'} for host in members]})
                        atomic(self.root / 'scan-error.json', {'at': at, 'code': 'resource_scan_failed'})
                        return {'state': 'failed', 'error_code': 'resource_scan_failed'}
                self._scan = self.app.pool.submit(scan_once)
            return {'state': 'scanning' if not self._scan.done() else self._scan.result()['state'], 'automatic_retry': False}

    def bound_run(self, args):
        if set(args) != IDENTITY | {'run_id'}:
            raise ValueError('Exact run, project, source commit and configuration are required')
        r = self.app.runner.read(args['run_id'])
        for field, stored in (('project_id', 'project_id'), ('source_commit', 'source_commit'), ('configuration', 'configuration_id')):
            if r.get(stored) != args[field]:
                raise ValueError('Historical run identity mismatch: ' + field)
        target = execution_target(r)
        if not target or target.get('host_id') not in self.scope['hosts']:
            raise PermissionError('Run host is outside the installed connection grant')
        self.app.runner.execution_site(r)
        return r

    def _arm_after_dispatch(self, rid, project, caller):
        record = self.app.runner.dispatch(rid)
        if self.permitted(caller, 'watch', project) and record.get('state') in ('submitted', 'running_observed', 'reconcile_required', 'launch_outcome_unknown'):
            self.arm(record, caller)
        return record

    def control(self, operation, args, key, caller):
        if operation not in OPERATIONS or not isinstance(args, dict):
            raise ValueError('Unsupported finite simulation operation')
        project = args.get('project_id')
        self.authorize(caller, operation, project)
        if operation in ('runtime', 'resources_scan'):
            if set(args) != {'project_id'}:
                raise ValueError('Only project_id is accepted for this operation')
            return self.snapshot(project, caller) if operation == 'runtime' else self.scan(project, caller)
        if operation == 'submit':
            if set(args) != IDENTITY or not isinstance(key, str) or not 8 <= len(key) <= 160 or not key.isprintable():
                raise ValueError('Submission needs exact identity and a stable key')
            if self.app.resource_pool is None:
                raise ValueError('Direct submission requires an explicitly configured resource pool')
            # This lock serializes preparation; Runner remains the submission ledger.
            digest = hashlib.sha256(json.dumps(args,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            with locked(self.root / ('submit-' + digest + '.lock')):
                existing = self.app.runner.lookup_submission(key)
                if existing:
                    return self.app.public_job(self.bound_run({**args, 'run_id': existing}))
                for prior in self.app.runner.list():
                    if (prior.get('project_id')==project and prior.get('source_commit')==args['source_commit'] and prior.get('configuration_id')==args['configuration']
                            and prior.get('state') in {'staging_outcome_unknown','launch_outcome_unknown','reconcile_required'}):
                        raise ValueError('An uncertain equivalent run already exists; reconcile its original identity before another submission')
                bundle = self.app.identity(args)
                members = [host for host in self.app.resource_pool.members if host in self.scope['hosts']]
                prepared = self.app.resource_pool.prepare(self.app.runner, bundle, args, host_ids=members)
                context = self.app.resource_pool.resolve(prepared['execution_plan_id'], bundle, args)
                if context.get('resource_selection',{}).get('host_id') not in members:
                    raise PermissionError('Selected host is outside this connection grant')
                run, new = self.app.runner.reserve(bundle, key, args['source_commit'], project, args['configuration'], execution_context=context)
                if new:
                    self.app.operations[run['run_id']] = self.app.pool.submit(self._arm_after_dispatch, run['run_id'], project, caller)
                return self.app.public_job(run)
        run = self.bound_run(args)
        rid = run['run_id']
        if operation == 'status':
            return self.app.public_job(self.app.runner.status(rid))
        if operation == 'watch':
            return self.arm(run, caller)
        if operation == 'unwatch':
            return self.monitor().unwatch(rid)
        if operation == 'collect':
            if not isinstance(key, str) or not 8 <= len(key) <= 160 or not key.isprintable():
                raise ValueError('Collection needs a stable key')
            path = self.app.runner.path(rid) / 'direct-collection.json'
            with locked(path.with_suffix('.lock')):
                if path.exists():
                    return json.loads(path.read_text())
                current = self.app.runner.read(rid)
                if current.get('remote_state') not in TERMINAL and not (current.get('collection_phase') == 'complete' and current.get('collection')):
                    raise ValueError('Observe a terminal run with status before collecting its results')
                # Durable once-per-run claim before any remote collection work.
                receipt = {'schema': 'ic.sim.direct-collection.v1', 'run_id': rid, 'state': 'collecting',
                           'idempotency_key_sha256': hashlib.sha256(key.encode()).hexdigest(), 'created_at': stamp()}
                atomic(path, receipt)
                def collect_once():
                    try:
                        self.app.runner.collect(rid)
                        self.derive_results(rid)
                        result = {**receipt, 'state': 'complete', 'updated_at': stamp()}
                    except Exception:
                        result = {**receipt, 'state': 'uncertain', 'updated_at': stamp(), 'error_code': 'collection_not_confirmed'}
                    atomic(path, result)
                    return result
                self.app.operations[rid] = self.app.pool.submit(collect_once)
                return receipt
        raise ValueError('Unknown simulation operation')

    def derive_results(self, rid):
        """Derive display data locally from a verified native archive; no OCEAN."""
        record = self.app.runner.read(rid)
        collection = record.get('collection') or {}
        archive = Path(collection.get('archive', ''))
        if not archive.is_file() or archive.is_symlink():
            raise ValueError('A collected native archive is required')
        from runner import filehash
        if filehash(archive) != collection.get('sha256'):
            raise ValueError('Native result archive digest changed')
        folder = self.app.runner.path(rid)
        inventory_path = folder / 'archive-files.json'
        if not inventory_path.is_file() or inventory_path.is_symlink() or inventory_path.stat().st_size > 8*1024**2:
            raise ValueError('A bounded collected archive inventory is required')
        inventory_bytes = inventory_path.read_bytes()
        inventory = json.loads(inventory_bytes)
        with tarfile.open(archive, 'r:gz') as stream:
            # Keep source logs private; only diagnostic redactions leave the API.
            logs = []
            entries = []
            for member in stream:
                if not member.isfile():
                    continue
                if member.name in ('./psf/spectre.out', './console.log') and member.size <= 1024**2:
                    logs.append(stream.extractfile(member).read().decode(errors='replace'))
                if member.name.startswith('./psf/') and member.name.endswith('.tran'):
                    entries.append(member)
            log = '\n'.join(logs)
            target = folder/'spectre-diagnostics.log'
            target.write_text(log); target.chmod(0o600)
            if len(entries) != 1 or entries[0].size > 16*1024**2 or record['plan'].get('simulator',{}).get('output_format') != 'psfascii':
                atomic(folder/'waveform-validity.json', {'data_validity':'unknown','specification':'unknown','reason':'native_format_not_supported','run_id':rid,'source_commit':record['source_commit']})
                return
            try:
                raw_native = stream.extractfile(entries[0]).read()
                member = entries[0]
                expected_entry = {'path': member.name, 'bytes': member.size,
                                  'sha256': hashlib.sha256(raw_native).hexdigest()}
                if [row for row in inventory if row.get('path') == member.name] != [expected_entry]:
                    raise ValueError('Native waveform and collected inventory disagree')
                native = raw_native.decode()
                module = importlib.import_module('spiceowl.integrations.spectre_results')
                required = [row['name'] for row in (record['plan'].get('postprocess') or {}).get('signals',[])]
                summary = module.summarize_psf_ascii(native, required_signals=required)
                atomic(folder/'waveform-validity.json', {**summary,'run_id':rid,'source_commit':record['source_commit'],'native_archive_sha256':collection['sha256']})
                if summary['data_validity'] != 'valid':
                    return
                wave = module.parse_psf_ascii(native)
                if wave['units'].get('time') != 's':
                    atomic(folder/'waveform-validity.json',{**summary,'data_validity':'unknown','specification':'unknown','reason':'unsupported_time_unit','run_id':rid,'source_commit':record['source_commit']})
                    return
            except (UnicodeError, ValueError):
                atomic(folder/'waveform-validity.json', {'data_validity':'invalid','specification':'unknown','reason':'native_waveform_parse_failed','run_id':rid,'source_commit':record['source_commit']})
                return
        names = [name for name in wave['values'] if name != 'time' and wave['units'].get(name) in ('V','A')]
        if required: names = [name for name in names if name in required]
        if not 1 <= len(names) <= 32:
            return
        times = wave['values']['time']; output = io.StringIO(newline=''); writer = csv.writer(output)
        writer.writerow([names[0]+' X']+[name+' Y' for name in names])
        for index,t in enumerate(times):
            writer.writerow([format(t,'.17g')]+[format(wave['values'][name][index],'.17g') for name in names])
        raw = output.getvalue().encode(); path = folder/'waveforms.csv'; path.write_bytes(raw); path.chmod(0o600)
        step=max(1,(len(times)+1599)//1600);indices=list(range(0,len(times),step))
        if indices[-1] != len(times)-1:indices.append(len(times)-1)
        metadata={'run_id':rid,'source_commit':record['source_commit'],'csv_sha256':hashlib.sha256(raw).hexdigest(),
                  'native_archive_sha256':collection['sha256'],'csv_samples':len(times),'producer':'spiceowl.psf-ascii','waveforms':[{'name':name,'unit':wave['units'][name],'time_unit':'s','analysis':'tran','points':[[times[i],wave['values'][name][i]] for i in indices]} for name in names]}
        atomic(folder/'waveforms.json', metadata)
        record['postprocess_csv_sha256']=metadata['csv_sha256'];record['postprocess_phase']='complete';record['local_derivation']={'producer':'spiceowl.psf-ascii','run_id':rid,'source_commit':record['source_commit'],'native_archive_sha256':collection['sha256'],'csv_sha256':metadata['csv_sha256'],'metadata_sha256':filehash(folder/'waveforms.json'),'inventory_sha256':hashlib.sha256(inventory_bytes).hexdigest()}
        self.app.runner.save(record)

    def snapshot(self, project, caller='local-studio'):
        if project not in self.app.workspace.projects:
            raise ValueError('Unknown simulation project')
        records = self.app.supervision.snapshot(project)['runs']
        rows = []
        worker_running = bool(self._monitor and (self._monitor.snapshot() or {}).get('running'))
        for observed in records:
            rid = observed['run_id']; folder = self.app.runner.path(rid); record = self.app.runner.read(rid)
            state = {'succeeded': 'completed', 'failed': 'failed', 'running': 'running', 'queued': 'queued'}.get(observed['execution']['state'], 'unknown')
            logs = []
            for name in ('latest-status.log', 'spectre-diagnostics.log'):
                path = folder / name
                if path.is_file() and not path.is_symlink():
                    with path.open('rb') as stream:
                        stream.seek(max(0, path.stat().st_size - 24000)); logs.append(stream.read(24000).decode(errors='replace'))
            acceptance = None
            result = folder / 'waveform-validity.json'
            if result.is_file() and not result.is_symlink() and result.stat().st_size < 65536:
                try:
                    summary = json.loads(result.read_text())
                    if (summary.get('run_id')==rid and summary.get('source_commit')==record.get('source_commit') and summary.get('native_archive_sha256')==(record.get('collection') or {}).get('sha256') and summary.get('native_archive_sha256') is not None):
                        acceptance = {'data_validity': summary['data_validity'], 'specification': 'unknown'}
                except (ValueError, KeyError):
                    pass
            try:
                diagnose = importlib.import_module('spiceowl.integrations.spectre_diagnostics').diagnose_spectre
                bounded_log='\n'.join(line[:3000] for line in '\n'.join(logs).splitlines()[-1000:])[-60000:]
                diagnosis = diagnose(bounded_log, execution_state=state, exit_code=observed['execution']['exit_code'], acceptance=acceptance)
            except (ImportError, ValueError):
                diagnosis = {'schema':'spiceowl.spectre-diagnostics.v1','observed_context':{'available':False},'diagnostics':[],
                             'scientific_acceptance':{'execution':state,'data_validity':'unknown','specification':'unknown'},
                             'agent_proposal':None,'advisory_only':True}
            monitor = None
            if self._monitor is not None:
                monitor = self._monitor.snapshot(rid)
            else:
                path = folder / 'monitor.json'
                if path.is_file() and not path.is_symlink() and path.stat().st_size < 1048576:
                    try: monitor = json.loads(path.read_text())
                    except ValueError: pass
            observation = (monitor or {}).get('observation') or {}
            monitoring_state = observation.get('state', 'not_watched')
            if monitor and monitor.get('watch_state') in ('stopped', 'terminal'):
                monitoring_state = monitor['watch_state']
            elif monitor and monitor.get('watch_state') == 'armed' and not worker_running:
                monitoring_state = 'paused'
            rows.append({'run_id': rid, 'source_commit': observed['source_commit'], 'configuration': observed['configuration'],
                         'collectable': self.permitted(caller, 'collect', project) and (record.get('remote_state') in TERMINAL or bool(record.get('collection_phase') == 'complete' and record.get('collection'))),
                         'execution_target': observed.get('execution_target'), 'execution': {'state': state, 'exit_code': observed['execution']['exit_code']},
                         'monitor': {'state': monitoring_state, 'last_attempt_at': observation.get('last_attempt_at'),
                                     'last_success_at': observation.get('last_success_at'), 'next_check_at': observation.get('next_check_at') if worker_running else None,
                                     'failures': observation.get('consecutive_failures', 0)},
                         'diagnostics': diagnosis, 'acceptance': diagnosis['scientific_acceptance'] if diagnosis else {'execution': state, 'data_validity': 'unknown', 'specification': 'unknown'}})
        return {'schema': 'ic.simulation.runtime.v1', 'project_id': project, 'read_at': stamp(), 'pool': self.pool_snapshot(), 'runs': rows,
                'capabilities': {'scan': self.permitted(caller, 'resources_scan', project) and self.app.resource_pool is not None,
                                 'monitor': self.permitted(caller, 'watch', project), 'direct_submit': self.permitted(caller, 'submit', project),
                                 'direct_collect': self.permitted(caller, 'collect', project)}}
