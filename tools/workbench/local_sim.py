"""Local open-source SPICE execution backend (ngspice / Xyce) with zero SSH.

Preserves CircuitGit's exact provenance, SHA-256 input verification, atomic run
directory isolation, immutable archive collection, and hash-bound waveform
derivation, while running completely locally with open-source simulators and
optional open-source PDKs (SKY130, GF180MCU, IHP SG13G2, or built-in).
Python 3.9+, standard library only.
"""
import getpass
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

from open_pdk import resolve_open_pdk, validate_open_pdk_config
from spice_netlist import compile_payload_to_spice

LOCAL_SITE_SCHEMA = 'ic.sim.local-site.v1'
ENGINES = ('ngspice', 'xyce')
SAFE = re.compile(r'^[A-Za-z0-9_./+-]+$')


def _sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def is_local_site(site):
    return isinstance(site, dict) and (
        site.get('schema') == LOCAL_SITE_SCHEMA or site.get('transport') == 'local'
    )


def validate_local_site(raw_site):
    """Validate and normalize an ic.sim.local-site.v1 configuration object."""
    if not isinstance(raw_site, dict):
        raise ValueError('Local site configuration must be a JSON object')
    allowed = {
        'schema',
        'transport',
        'engine',
        'simulator_bin',
        'runs_root',
        'open_pdk',
        'external_files',
        'expected_host',
        'expected_user',
        # Normalized compatibility keys preserved across json round-trips:
        'ssh_target',
        'remote_runs_root',
    }
    extra = set(raw_site) - allowed
    if extra:
        raise ValueError('Unexpected local site keys: ' + ', '.join(sorted(extra)))
    if raw_site.get('schema') != LOCAL_SITE_SCHEMA:
        raise ValueError('Local site schema must be ' + LOCAL_SITE_SCHEMA)
    transport = raw_site.get('transport', 'local')
    if transport != 'local':
        raise ValueError('Local site transport must be "local"')
    engine = raw_site.get('engine', 'ngspice')
    if engine not in ENGINES:
        raise ValueError('Unsupported local simulator engine: ' + str(engine))

    sim_bin = raw_site.get('simulator_bin')
    if not isinstance(sim_bin, str) or not sim_bin.startswith('/') or not SAFE.fullmatch(sim_bin):
        raise ValueError('Local site simulator_bin must be a safe absolute path')

    runs_root = raw_site.get('runs_root') or raw_site.get('remote_runs_root')
    if not isinstance(runs_root, str) or not runs_root.startswith('/') or not SAFE.fullmatch(runs_root):
        raise ValueError('Local site runs_root must be a safe absolute path')
    if PurePosixPath(runs_root).name != 'ic_on_github_runs':
        raise ValueError('Use a dedicated absolute directory ending ic_on_github_runs')

    external = raw_site.get('external_files', {})
    if not isinstance(external, dict):
        raise ValueError('external_files must be an object')
    for key, val in external.items():
        if not re.fullmatch(r'[A-Z0-9_]+', key) or not isinstance(val, str) or not SAFE.fullmatch(val) or not val.startswith('/'):
            raise ValueError('Invalid external path alias: ' + str(key))

    pdk_cfg = validate_open_pdk_config(raw_site.get('open_pdk'))

    site = {
        'schema': LOCAL_SITE_SCHEMA,
        'transport': 'local',
        'engine': engine,
        'simulator_bin': sim_bin,
        'runs_root': runs_root,
        'ssh_target': 'local',
        'remote_runs_root': runs_root,
        'external_files': dict(external),
    }
    if pdk_cfg is not None:
        site['open_pdk'] = pdk_cfg
    for opt in ('expected_host', 'expected_user'):
        if opt in raw_site and raw_site[opt] is not None:
            if not isinstance(raw_site[opt], str) or not SAFE.fullmatch(raw_site[opt]):
                raise ValueError('Invalid local site ' + opt)
            site[opt] = raw_site[opt]
    return site


def detect_local_simulator(engine='ngspice'):
    """Locate an installed local open-source SPICE binary without executing it."""
    if engine not in ENGINES:
        raise ValueError('Unsupported engine: ' + str(engine))
    candidates = ['ngspice'] if engine == 'ngspice' else ['Xyce', 'xyce']
    extra_dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
    search_path = os.environ.get('PATH', '')
    combined = os.pathsep.join([search_path, *extra_dirs]) if search_path else os.pathsep.join(extra_dirs)
    for name in candidates:
        found = shutil.which(name, path=combined)
        if found:
            return str(Path(found).resolve())
    return None


def doctor(site):
    """Verify local open-source simulator binary, optional open PDK, and external files."""
    site = validate_local_site(site)
    engine = site['engine']
    sim_path = Path(site['simulator_bin'])
    host = socket.gethostname()
    user = getpass.getuser()
    checks = [host, user]
    hashes = {}
    all_refs_ok = True

    if sim_path.is_file() and os.access(sim_path, os.X_OK):
        checks.append(f'{engine}=readable')
        hashes[engine] = _sha256_file(sim_path)
    else:
        checks.append(f'{engine}=MISSING')
        all_refs_ok = False

    pdk_info = None
    pdk_error = None
    if site.get('open_pdk'):
        try:
            pdk_info = resolve_open_pdk(site['open_pdk'], engine=engine)
            for alias, sha_val in pdk_info['dependency_sha256'].items():
                checks.append(f'{alias}=readable')
                hashes[alias] = sha_val
        except ValueError as exc:
            pdk_error = str(exc)
            checks.append('open_pdk=MISSING')
            all_refs_ok = False

    for alias, path_str in site.get('external_files', {}).items():
        p = Path(path_str)
        if p.is_file() and os.access(p, os.R_OK):
            checks.append(f'{alias}=readable')
            hashes[alias] = _sha256_file(p)
        else:
            checks.append(f'{alias}=MISSING')
            all_refs_ok = False

    version_text = ''
    exit_code = 1
    stderr_text = pdk_error or ''
    if sim_path.is_file() and os.access(sim_path, os.X_OK):
        ver_flag = '--version' if engine == 'ngspice' else '-v'
        try:
            proc = subprocess.run([str(sim_path), ver_flag], capture_output=True, text=True, timeout=15)
            exit_code = proc.returncode
            version_text = (proc.stdout or proc.stderr or '').strip()
            if version_text:
                checks.append(version_text.splitlines()[0])
            if proc.stderr and not stderr_text:
                stderr_text = proc.stderr.strip()
        except (OSError, subprocess.TimeoutExpired) as exc:
            exit_code = 1
            stderr_text = str(exc)

    expected_host = site.get('expected_host')
    expected_user = site.get('expected_user')
    identity_ok = (expected_host in (None, '', host)) and (expected_user in (None, '', user))
    tools_ok = Path('/bin/sh').is_file() and os.access('/bin/sh', os.X_OK) and (exit_code == 0)

    return {
        'exit_code': exit_code if (all_refs_ok and tools_ok) else (exit_code or 1),
        'transport': 'local',
        'engine': engine,
        'simulator_bin': str(sim_path),
        'version': version_text.splitlines()[0] if version_text else None,
        'open_pdk': pdk_info,
        'checks': checks,
        'dependency_sha256': hashes,
        'stderr': stderr_text,
        'license_checkout': 'not_required',
        'simulation': 'not_started',
        'identity_ok': identity_ok,
        'all_tools_available': tools_ok,
        'all_references_readable': all_refs_ok,
    }


def _build_local_job_script(site, compiled_entry, sim_args):
    engine = site['engine']
    sim_bin = shlex.quote(site['simulator_bin'])
    entry_name = shlex.quote(PurePosixPath(compiled_entry).name)
    extra_args = ' '.join(shlex.quote(a) for a in sim_args if a)
    if engine == 'ngspice':
        sim_cmd = f'{sim_bin} -b {extra_args} -r ../raw/results.raw -o ../raw/ngspice.out {entry_name}'.replace('  ', ' ')
        log_file = 'raw/ngspice.out'
    else:
        sim_cmd = f'{sim_bin} {extra_args} -r ../raw/results.raw -l ../raw/xyce.log {entry_name}'.replace('  ', ' ')
        log_file = 'raw/xyce.log'

    return f'''#!/bin/sh
set -u
cd "$(dirname "$0")" || exit 70
umask 077
terminal_written=0
on_exit() {{
  rc=$?
  if [ "$terminal_written" != 1 ]; then
    printf '%s\\n' "$rc" > exit_code
    printf 'job_setup_failed\\n' > state.tmp
    mv state.tmp state
  fi
}}
trap on_exit 0
printf 'running\\n' > state.tmp
mv state.tmp state || exit 70
mkdir -p raw || exit 70
cd netlist || exit 70
{sim_cmd} > ../console.log 2>&1
rc=$?
cd .. || exit 70
printf '%s\\n' "$rc" > exit_code.tmp
mv exit_code.tmp exit_code
if [ "$rc" = 0 ] && [ -s raw/results.raw ]; then
  printf 'simulator_complete_pending_measurements\\n' > state.tmp
else
  printf 'simulator_failed\\n' > state.tmp
fi
mv state.tmp state
terminal_written=1
exit "$rc"
''', log_file


def stage_and_launch_local(site, run_dir, bundle, payload, run_record, probe_result):
    """Transpile (if needed), stage with SHA-256 receipts, and launch local SPICE."""
    site = validate_local_site(site)
    engine = site['engine']
    pdk_directives = []
    if site.get('open_pdk'):
        pdk_info = resolve_open_pdk(site['open_pdk'], engine=engine)
        pdk_directives = pdk_info['directives']

    compiled_files, compiled_entry, transpile_manifest = compile_payload_to_spice(
        payload,
        bundle['entrypoint'],
        engine=engine,
        pdk_directives=pdk_directives,
    )

    sim_cfg = run_record['plan'].get('simulator', {})
    sim_args = [a for a in sim_cfg.get('args', []) if not a.startswith(('-64', '+aps', '++aps', '+lqtimeout', '-maxw', '-maxn', '+mt='))]
    job_script, _ = _build_local_job_script(site, compiled_entry, sim_args)

    staged = dict(payload)
    staged.update(compiled_files)
    staged['spice-transpile.json'] = (json.dumps(transpile_manifest, indent=2) + '\n').encode('utf-8')
    staged['job.sh'] = job_script.encode('utf-8')
    staged['run.json'] = (json.dumps(run_record, indent=2) + '\n').encode('utf-8')

    pins = [(h, site['external_files'][k]) for k, h in run_record['plan'].get('external_sha256', {}).items() if k in site.get('external_files', {})]
    if engine in probe_result.get('dependency_sha256', {}):
        pins.append((probe_result['dependency_sha256'][engine], site['simulator_bin']))
    if probe_result.get('open_pdk'):
        for entry in probe_result['open_pdk'].get('entry_files', []):
            pins.append((entry['sha256'], entry['path']))
    staged['external.sha256'] = ''.join(f'{h}  {p}\n' for h, p in pins).encode('utf-8')
    staged['payload.sha256'] = ''.join(f'{_sha256_bytes(v)}  {k}\n' for k, v in sorted(staged.items())).encode('utf-8')

    target = Path(run_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Atomic exclusive run directory creation (never overwrite existing run).
    target.mkdir(mode=0o700, exist_ok=False)
    for rel, raw in sorted(staged.items()):
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
        os.chmod(dest, 0o700 if rel == 'job.sh' else 0o600)
    (target / 'state').write_text('staged\n')

    # Single-launch guard matching remote launch_once semantics.
    (target / 'launch_once').mkdir(mode=0o700, exist_ok=False)
    launch = subprocess.run(
        ['/bin/sh', '-c', 'nohup /bin/sh job.sh >/dev/null 2>&1 </dev/null &\necho $! > supervisor.pid\n'],
        cwd=str(target),
        capture_output=True,
        timeout=15,
    )
    if launch.returncode != 0:
        raise ValueError('Local simulator launch failed: ' + launch.stderr.decode(errors='replace'))
    raw_pid = (target / 'supervisor.pid').read_text().strip()
    pid = int(raw_pid) if raw_pid.isdigit() else None
    return {'pid': pid, 'transpile_manifest': transpile_manifest}


def local_status(run_dir):
    """Observe local open-source SPICE run state without restarting or polling."""
    target = Path(run_dir)
    if not target.is_dir():
        return {'ok': False, 'error': 'Local run directory not found: ' + str(target)}
    state_file = target / 'state'
    exit_file = target / 'exit_code'
    pid_file = target / 'supervisor.pid'
    state_str = state_file.read_text().strip() if state_file.is_file() else 'unknown'
    exit_code = None
    if exit_file.is_file():
        raw_rc = exit_file.read_text().strip()
        if raw_rc.isdigit():
            exit_code = int(raw_rc)
    alive = False
    pid_val = None
    if pid_file.is_file():
        raw_pid = pid_file.read_text().strip()
        if raw_pid.isdigit():
            pid_val = int(raw_pid)
            try:
                os.kill(pid_val, 0)
                alive = True
            except OSError:
                alive = False

    log_tail = ''
    for candidate in ('raw/ngspice.out', 'raw/xyce.log', 'console.log'):
        p = target / candidate
        if p.is_file():
            data = p.read_bytes()
            log_tail = data[-60000:].decode('utf-8', errors='replace')
            break

    return {
        'ok': True,
        'remote_state': state_str or 'unknown',
        'simulator_exit_code': exit_code,
        'pid': pid_val,
        'process_observed_alive': alive,
        'log_text': f'STATE {state_str}\nEXIT {exit_code if exit_code is not None else ""}\nPID {pid_val or ""}\nALIVE {"yes" if alive else "no"}\n{log_tail}',
    }


def collect_local_archive(run_dir, dest_archive):
    """Package the completed local run directory into an immutable tar.gz + inventory."""
    target = Path(run_dir)
    if not target.is_dir():
        raise ValueError('Local run directory missing: ' + str(target))
    excluded_dirs = {'exports', 'launch_once'}
    dest = Path(dest_archive)
    part = dest.with_suffix('.part')
    inventory = []
    logs = {}
    try:
        with tarfile.open(part, 'w:gz') as tf:
            for item in sorted(target.rglob('*')):
                rel = item.relative_to(target)
                if any(part_name in excluded_dirs for part_name in rel.parts):
                    continue
                if item.is_symlink() or not item.is_file():
                    continue
                arcname = './' + rel.as_posix()
                raw = item.read_bytes()
                info = tarfile.TarInfo(arcname)
                info.size = len(raw)
                info.mode = 0o600
                info.mtime = 0
                tf.addfile(info, io.BytesIO(raw))
                inventory.append({
                    'path': arcname,
                    'bytes': len(raw),
                    'sha256': _sha256_bytes(raw),
                })
                if rel.as_posix() in ('raw/ngspice.out', 'raw/xyce.log', 'console.log') and len(raw) < 10 * 1024 * 1024:
                    logs[rel.as_posix()] = raw.decode('utf-8', errors='replace')
        archive_sha = _sha256_file(part)
        archive_bytes = part.stat().st_size
        part.replace(dest)
    except Exception:
        part.unlink(missing_ok=True)
        raise
    return {
        'archive': str(dest),
        'sha256': archive_sha,
        'bytes': archive_bytes,
        'inventory': inventory,
        'logs': logs,
    }
