"""Bind a reviewed library testbench to one explicit saved onboarding job."""
import importlib.util
import hashlib
import json
from pathlib import Path
import posixpath

from .service import check


def _runner():
    package = Path(__file__).resolve().parents[1]
    path = next((p for p in (package / 'gateway/testbench_bundle.py',
                            package.parent.parent / 'tools/ci/testbench_bundle.py') if p.is_file()), None)
    check(path is not None, 'The installed Testbench CI runner is unavailable.', 'library_unavailable', 4)
    spec = importlib.util.spec_from_file_location('ic_registered_testbench_analysis', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _electrical_support(workflow, scope, primary, source_files):
    """Resolve literal electrical includes, retaining logical names and bytes.

    The version binding includes documentation/geometry too. They must not be
    injected as simulation support files. Alias mappings are taken only from
    committed views containing this exact primary source.
    """
    aliases = {}
    for view in scope['cell']['views']:
        if primary not in view['files']:
            continue
        for logical, physical in view.get('aliases', {}).items():
            check(logical not in aliases or aliases[logical] == physical, 'Ambiguous committed source alias.', 'conflict', 3)
            check(physical in source_files, 'Source alias escaped the registered closure.', 'conflict', 3)
            aliases[logical] = physical
    from spiceowl.onboarding.agent_tb import inspect_agent_source
    base = posixpath.dirname(primary)
    sources, hashes = {}, {}
    logical_files = {path: path for path in source_files}
    logical_files.update(aliases)
    for logical, physical in logical_files.items():
        if physical == primary or Path(logical).suffix.lower() not in ('.scs', '.sp', '.spice', '.cir', '.va', '.vams'):
            continue
        name = posixpath.relpath(logical, base)
        if name in ('.', '..') or name.startswith('../'):
            continue
        raw = workflow._blob(scope['head'], physical)
        check(raw is not None and hashlib.sha256(raw).hexdigest() == source_files[physical],
              'Registered support source changed.', 'conflict', 3)
        check(name not in sources or sources[name] == raw, 'Ambiguous logical support source.', 'conflict', 3)
        sources[name], hashes[name] = raw, source_files[physical]
    primary_raw = workflow._blob(scope['head'], primary)
    check(primary_raw is not None and hashlib.sha256(primary_raw).hexdigest() == source_files[primary],
          'Registered primary source changed.', 'conflict', 3)
    # The same owner parser resolves Spectre, ahdl_include and Verilog-A
    # `include edges. Unreferenced catalogue files are not simulation inputs.
    inventory = inspect_agent_source(primary_raw, support_files=sources)
    check(not [row for row in inventory['issues'] if row['code'] != 'unreferenced_supplied_file'],
          'Registered electrical include closure is incomplete or unsupported.', 'conflict', 3)
    used = {row['target'] for row in inventory['includes'] if not row.get('external') and row['target'] != 'pdk.scs'}
    check(used <= set(hashes), 'Electrical include is absent from the registered source closure.', 'conflict', 3)
    return {name: hashes[name] for name in sorted(used)}


def _snapshot_files(snapshot):
    files = snapshot.get('files')
    check(isinstance(files, dict) and bool(files), 'The approved review has no frozen source files.', 'conflict', 3)
    hashes = {}
    for name, row in files.items():
        check(isinstance(name, str) and isinstance(row, dict) and isinstance(row.get('text'), str)
              and hashlib.sha256(row['text'].encode()).hexdigest() == row.get('sha256'),
              'Frozen review source bytes do not match their hashes.', 'conflict', 3)
        hashes[name] = row['sha256']
    return hashes


def run(service, workflow, args):
    """Arguments contain only known identities; trusted reads supply all hashes."""
    lid, cid, tid = (args[k] for k in ('library_id', 'cell_id', 'testbench_id'))
    inventory = workflow.get_testbenches(lid, cid)
    rows = [r for r in inventory['bundles'] if r['id'] == tid]
    check(len(rows) == 1 and rows[0]['registration_commit'] == args['registration_commit']
          and rows[0]['source_matches'] and rows[0]['enabled'],
          'The registered Testbench CI or its source changed; review the new version.', 'conflict', 3)
    bundle = rows[0]
    scope = workflow._scope(lid, cid)
    record = json.loads(workflow._blob(scope['head'], bundle['manifest_path']))
    session = service.call('onboarding_session', {'intake_id': args['intake_id']})
    check(session.get('mode') == 'agent-tb', 'CI requires an explicitly authored testbench intake.', 'conflict', 3)
    plans = [p for p in session.get('plans', []) if p.get('job_id') == args['job_id']]
    check(len(plans) == 1 and plans[0].get('review_id'), 'The exact job has no retained testbench review.', 'conflict', 3)
    plan = plans[0]
    review = service.call('onboarding_agent_tb_review', {'intake_id': args['intake_id'], 'review_id': plan['review_id']})
    snapshot = review.get('snapshot') or {}
    check(review.get('state') == 'approved' and review.get('plan_id') == plan['plan_id']
          and review.get('review_digest') == plan.get('review_digest')
          and plan.get('testbench_sha256') == bundle['binding']['testbench_sha256']
          and snapshot.get('testbench') == record['agent_manifest'],
          'This job did not execute the registered reviewed testbench and criteria.', 'conflict', 3)
    expected_review_digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    check(review.get('review_digest') == expected_review_digest, 'Historical human review digest differs.', 'conflict', 3)
    # Preserve file names as well as contents. A source closure hash is not the
    # primary DUT hash; match the immutable intake support map independently.
    source_files = record['source']['files']
    primary = session.get('source_sha256')
    matched = [path for path, sha in source_files.items() if sha == primary]
    check(len(matched) == 1, 'The primary DUT is absent or ambiguous in this registered cell.', 'conflict', 3)
    expected_support = _electrical_support(workflow, scope, matched[0], source_files)
    actual_support = {path: row.get('sha256') for path, row in session.get('support_files', {}).items()}
    check(expected_support == actual_support and snapshot.get('original_source_sha256') == primary,
          'The supplied source/support closure differs from this registered cell.', 'conflict', 3)
    frozen_files = _snapshot_files(snapshot)
    runtime_prefix = 'projects/' + args['intake_id'] + '/'
    helpers = workflow._testbench_helper_files(record['agent_manifest'])
    helper_hashes = {name: hashlib.sha256(raw).hexdigest() for name, raw in helpers.items()}
    check(not any(a.lower() == b.lower() or a.lower().startswith(b.lower() + '/') or b.lower().startswith(a.lower() + '/')
                  for a in helper_hashes for b in expected_support),
          'Testbench helper conflicts with original source support.', 'conflict', 3)
    check(bundle['binding'].get('helper_sha256', {}) == helper_hashes
          and {name[len(runtime_prefix + 'helpers/'):]: sha for name, sha in frozen_files.items()
               if name.startswith(runtime_prefix + 'helpers/')} == helper_hashes,
          'The original approved helper files differ from the registered Testbench CI.', 'conflict', 3)
    check(frozen_files.get(runtime_prefix + 'dut.scs') == primary
          and frozen_files.get(runtime_prefix + 'tb.scs') == bundle['binding']['testbench_sha256']
          and {name[len(runtime_prefix + 'support/'):]: sha for name, sha in frozen_files.items()
               if name.startswith(runtime_prefix + 'support/')} == expected_support,
          'The original approved runtime files differ from the registered DUT/testbench/support.', 'conflict', 3)
    catalog = service.call('onboarding_waveforms_catalog', {'intake_id': args['intake_id'], 'job_id': args['job_id']})
    check(catalog.get('job_id') == args['job_id'] and catalog.get('source_commit') == plan['source_commit']
          and snapshot.get('source_commit') == plan['source_commit']
          and catalog.get('original_source_sha256') == primary and isinstance(catalog.get('catalog'), dict),
          'The saved waveform archive belongs to a different reviewed source.', 'conflict', 3)
    waveform = catalog['catalog']
    check(waveform.get('run_id') == args['job_id'] and waveform.get('source_commit') == plan['source_commit']
          and waveform.get('archive_sha256') == catalog.get('archive_sha256')
          and isinstance(waveform.get('source_hashes'), dict)
          and all(waveform['source_hashes'].get(path) == sha for path, sha in frozen_files.items()),
          'Saved waveform provenance differs from the approved source files.', 'conflict', 3)
    runtime = {'library_id': lid, 'cell_id': cid, 'testbench_id': tid,
               'registration_commit': args['registration_commit'], 'intake_id': args['intake_id'], 'job_id': args['job_id'],
               'source_commit': plan['source_commit'], 'original_source_sha256': primary,
               'source_sha256': bundle['binding']['source_sha256'], 'source_files': source_files,
               'testbench_sha256': bundle['binding']['testbench_sha256'], 'archive_sha256': catalog['archive_sha256'],
               'archive_source_hashes': catalog['catalog'].get('source_hashes'),
               'signal_catalog': {**catalog['catalog'], 'job_id': args['job_id']}}

    class Analyzer:
        def analyze(self, request):
            return service.call('onboarding_analysis', request)

    return _runner().run_registered_analysis(workflow, lid, cid, tid, args['registration_commit'], runtime, Analyzer())
