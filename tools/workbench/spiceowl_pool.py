"""Optional SpiceOwl placement adapter; signed plans are not submission receipts.

Construction reads configuration only. ``prepare`` explicitly checks the pool and
the chosen site's simulator prerequisites. ``resolve`` reads frozen material only;
the runner must call ``recheck`` before staging. Submission ownership and keys stay
with Runner. Install SpiceOwl separately to enable this optional integration.
"""
import copy
import hashlib
import hmac
import importlib
import json
import re
from datetime import datetime
from pathlib import Path

import ic_sim as core
from runner import atomic, filehash, locked


MAX_RECORD_BYTES = 4 * 1024 * 1024
IDENTITY_KEYS = {'project_id', 'configuration', 'source_commit'}
SELECTION_KEYS = {'schema', 'host_id', 'requirements', 'selected_at', 'profile',
                  'profile_sha256', 'simulator_version', 'recommendation'}
RECORD_KEYS = {'schema', 'identity', 'bundle_path', 'bundle_sha256', 'member',
               'selection', 'site', 'preflight'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key: ' + key)
        result[key] = value
    return result


def read_json(path, limit=MAX_RECORD_BYTES):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('A regular local JSON file is required')
    with path.open('rb') as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('JSON file exceeds the read limit')
    def constant(_):
        raise ValueError('Nonfinite JSON number')
    return json.loads(raw, object_pairs_hook=unique_object, parse_constant=constant)


def exact(value, keys, label):
    if type(value) is not dict or set(value) != keys:
        raise ValueError('Invalid ' + label + ' fields')


def identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}', value):
        raise ValueError('Invalid ' + label)
    return value


def host_identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}', value):
        raise ValueError('Invalid ' + label)
    return value


def absolute(value, label):
    if not isinstance(value, str) or not value or not Path(value).is_absolute() or any(ord(c) < 32 for c in value):
        raise ValueError(label + ' must be an absolute local path')
    return value


def requirements(value):
    exact(value, {'cpu_count', 'memory_bytes', 'simulator'}, 'resource requirements')
    if type(value['cpu_count']) is not int or not 1 <= value['cpu_count'] <= 4096:
        raise ValueError('cpu_count must be an integer from 1 to 4096')
    if type(value['memory_bytes']) is not int or value['memory_bytes'] <= 0:
        raise ValueError('memory_bytes must be a positive integer')
    if value['simulator'] != 'spectre':
        raise ValueError('This adapter supports Spectre only')
    return copy.deepcopy(value)


def validate_simulator_budget(plan, request):
    """Admission supports the runner's serial default and explicit local threads.

    A host snapshot is not a scheduler allocation. Unknown/distributed command
    profiles need their own adapter instead of silently assuming one CPU.
    """
    sim = plan.get('simulator') if isinstance(plan, dict) else None
    args = sim.get('args') if isinstance(sim, dict) else None
    if args == ['-64'] and sim.get('profile') == 'spectre-default':
        return 1
    if not isinstance(args, list) or not args or any(not isinstance(arg, str) for arg in args):
        raise ValueError('Resource selection needs a known Spectre argument profile')
    threads = []
    position = 0
    while position < len(args):
        arg = args[position]
        if arg in ('-64', '+aps', '++aps'):
            pass
        elif re.fullmatch(r'\+mt=[1-9][0-9]{0,3}', arg):
            threads.append(int(arg.split('=')[1]))
        elif arg in ('+lqtimeout', '-maxw', '-maxn'):
            position += 1
            if position >= len(args) or not re.fullmatch(r'[0-9]{1,6}', args[position]):
                raise ValueError('Invalid bounded Spectre option value')
        else:
            raise ValueError('Resource pool does not support this Spectre argument profile; use explicit local +mt=N')
        position += 1
    if len(threads) != 1 or threads[0] > request['cpu_count']:
        raise ValueError('Exactly one +mt=N is required and must fit the requested cpu_count')
    return threads[0]


def normalize_identity(value):
    exact(value, IDENTITY_KEYS, 'simulation identity')
    identifier(value['project_id'], 'project ID')
    identifier(value['configuration'], 'configuration ID')
    if not isinstance(value['source_commit'], str) or not re.fullmatch('[a-f0-9]{40}', value['source_commit']):
        raise ValueError('A full source commit is required')
    return copy.deepcopy(value)


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value) if isinstance(value, str) and len(value) <= 80 else None
        if parsed is None or parsed.utcoffset() is None:
            raise ValueError()
    except (ValueError, TypeError, OverflowError):
        raise ValueError('A timezone-aware resource observation is required') from None
    return value


def validate_selection(value):
    exact(value, SELECTION_KEYS, 'SpiceOwl selection')
    if len(canonical(value)) > 1024 * 1024:
        raise ValueError('SpiceOwl resource selection exceeds the size limit')
    if value['schema'] != 'spiceowl.resource-selection.v1':
        raise ValueError('Unsupported SpiceOwl resource selection')
    host_id = host_identifier(value['host_id'], 'selected host')
    requirements(value['requirements'])
    timestamp(value['selected_at'])
    profile = value['profile']
    fields = {'schema', 'host_id', 'label', 'ssh_target', 'expected_host', 'expected_user', 'tools'}
    if type(profile) is dict and profile.get('schema') == 'spiceowl.host.v2':
        fields.add('ssh_hostname')
    exact(profile, fields, 'selected private host profile')
    if profile['schema'] not in ('spiceowl.host.v1', 'spiceowl.host.v2') or profile['host_id'] != host_id:
        raise ValueError('Selection profile host mismatch')
    if value['profile_sha256'] != hashlib.sha256(canonical(profile)).hexdigest():
        raise ValueError('Selection profile digest mismatch')
    if not isinstance(value['simulator_version'], str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){2,4}(?:\.isr[0-9]+)?', value['simulator_version'], re.I):
        raise ValueError('Invalid selected Spectre version')
    tools = profile['tools']
    if not isinstance(tools, list) or not 1 <= len(tools) <= 3:
        raise ValueError('Invalid selected host tools')
    for tool in tools:
        exact(tool, {'kind', 'executable'}, 'selected tool')
    matches = [tool for tool in tools if tool['kind'] == 'spectre']
    if len(matches) != 1:
        raise ValueError('Selection requires one Spectre executable')
    absolute(matches[0]['executable'], 'Spectre executable')
    recommendation = value['recommendation']
    if type(recommendation) is not dict or recommendation.get('recommended_host_id') != host_id or recommendation.get('evaluated_at') != value['selected_at']:
        raise ValueError('Selection recommendation identity mismatch')
    candidates, excluded = recommendation.get('candidates'), recommendation.get('excluded')
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= 32 or not isinstance(excluded, list) or len(excluded) > 32:
        raise ValueError('Invalid bounded selection recommendation')
    if any(type(row) is not dict for row in candidates + excluded):
        raise ValueError('Invalid selection recommendation row')
    selected = [row for row in candidates if row.get('host_id') == host_id]
    if len(selected) != 1 or candidates[0].get('host_id') != host_id:
        raise ValueError('Selected host must be the first unique recommendation')
    timestamp(selected[0].get('resource_observed_at'))
    return value


def match_site(site, selection):
    profile = selection['profile']
    for field in ('expected_host', 'expected_user'):
        if not isinstance(profile.get(field), str) or not profile[field] or site.get(field) != profile[field]:
            raise ValueError('Selected resource identity does not match simulation site: ' + field)
    executable = next(tool['executable'] for tool in profile['tools'] if tool['kind'] == 'spectre')
    if site.get('spectre_bin') != executable:
        raise ValueError('Selected Spectre executable does not match simulation site')


def public_recommendation(selection):
    """Expose only identifiers and controlled reason-code prose, never raw paths."""
    recommendation = selection['recommendation']
    candidates = [{'host_id': host_identifier(row.get('host_id'), 'candidate host')}
                  for row in recommendation['candidates']]
    excluded = []
    for row in recommendation['excluded']:
        codes = row.get('reason_codes', [])
        if not isinstance(codes, list):
            codes = []
        safe = [code for code in codes if isinstance(code, str) and re.fullmatch('[a-z][a-z0-9_]{0,79}', code)][:8]
        excluded.append({'host_id': host_identifier(row.get('host_id'), 'excluded host'),
                         'reason_codes': safe,
                         'reasons': [code.replace('_', ' ') for code in safe] or ['Resource eligibility was not established.']})
    return {'recommended_host_id': selection['host_id'], 'evaluated_at': selection['selected_at'],
            'candidates': candidates, 'excluded': excluded, 'resource_reservation': False}


class ResourcePool:
    def __init__(self, config_path, runtime, signing_key):
        config = read_json(config_path, 65536)
        exact(config, {'schema', 'spiceowl_data_dir', 'requirements', 'members'}, 'resource pool configuration')
        if config['schema'] != 'ic.spiceowl-pool.v1':
            raise ValueError('Unsupported resource pool configuration')
        self.data_dir = absolute(config['spiceowl_data_dir'], 'spiceowl_data_dir')
        self.requirements = requirements(config['requirements'])
        members = config['members']
        if not isinstance(members, list) or not 1 <= len(members) <= 32:
            raise ValueError('A resource pool needs 1..32 members')
        self.members = {}
        for member in members:
            exact(member, {'host_id', 'site_file'}, 'resource pool member')
            host_id = host_identifier(member['host_id'], 'member host')
            absolute(member['site_file'], 'site_file')
            if host_id in self.members:
                raise ValueError('Duplicate resource pool host')
            self.members[host_id] = copy.deepcopy(member)
        if not isinstance(signing_key, bytes) or not signing_key:
            raise ValueError('The gateway signing key is required')
        self.signing_key = signing_key
        self.root = Path(runtime).resolve() / 'spiceowl-plans'
        self._external = None

    def _backend(self):
        if self._external is None:
            try:
                module = importlib.import_module('spiceowl.integrations.circuitgit_pool')
            except ImportError:
                raise ValueError('Install a compatible SpiceOwl package to enable resource pool selection') from None
            self._external = module.CircuitGitPool(self.data_dir)
        return self._external

    @staticmethod
    def _bundle(bundle):
        path = Path(bundle)
        if path.is_symlink() or not path.is_file():
            raise ValueError('A regular simulation bundle file is required')
        return str(path.resolve()), filehash(path)

    def prepare(self, runner, bundle, identity):
        bound_identity = normalize_identity(identity)
        bundle_path, bundle_hash = self._bundle(bundle)
        local_plan = runner.plan(bundle, bound_identity['source_commit'])
        validate_simulator_budget(local_plan, self.requirements)
        selection = copy.deepcopy(self._backend().select(list(self.members), copy.deepcopy(self.requirements)))
        validate_selection(selection)
        if selection['host_id'] not in self.members or selection['requirements'] != self.requirements:
            raise ValueError('SpiceOwl selected an unconfigured host or resource request')
        member = self.members[selection['host_id']]
        site_path = Path(member['site_file'])
        parsed_site = read_json(site_path, 65536)  # core.site_load does not reject duplicate JSON keys.
        site = core.site_load(site_path)
        if site != parsed_site:
            raise ValueError('Simulation site changed while it was read')
        match_site(site, selection)
        summary = public_recommendation(selection)
        preflight = copy.deepcopy(runner.preflight(bundle, bound_identity['source_commit'], site=copy.deepcopy(site)))
        if type(preflight) is not dict:
            raise ValueError('Runner preflight must return a record')
        validate_simulator_budget(preflight.get('plan'), self.requirements)
        if preflight['plan']['simulator'] != local_plan['simulator']:
            raise ValueError('Spectre settings changed during resource preflight')
        proof = preflight.get('plan', {}).get('provenance', {})
        if proof.get('source_commit') != bound_identity['source_commit']:
            raise ValueError('Runner preflight source identity mismatch')
        if self._bundle(bundle) != (bundle_path, bundle_hash):
            raise ValueError('Simulation bundle changed during preflight')
        record = {'schema': 'ic.spiceowl-plan.v1', 'identity': bound_identity,
                  'bundle_path': bundle_path, 'bundle_sha256': bundle_hash,
                  'member': copy.deepcopy(member), 'selection': selection,
                  'site': site, 'preflight': preflight}
        payload = canonical(record)
        if len(payload) > MAX_RECORD_BYTES - 1024:
            raise ValueError('Frozen resource plan exceeds the size limit')
        plan_id = hashlib.sha256(payload).hexdigest()
        signed = {'data': record, 'signature': hmac.new(self.signing_key, payload, hashlib.sha256).hexdigest()}
        if len(json.dumps(signed, indent=2, allow_nan=False).encode()) + 1 > MAX_RECORD_BYTES:
            raise ValueError('Frozen resource plan exceeds the size limit')
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with locked(self.root / (plan_id + '.lock')):
            path = self.root / (plan_id + '.json')
            if path.exists() or path.is_symlink():
                if read_json(path) != signed:
                    raise ValueError('Existing frozen plan is inconsistent')
            else:
                atomic(path, signed)
        observed = selection['recommendation']['candidates'][0]['resource_observed_at']
        return {**preflight, 'execution_plan_id': plan_id,
                'execution_target': {'mode': 'resource_pool', 'host_id': selection['host_id'],
                                     'plan_id': plan_id, 'resource_observed_at': observed,
                                     'resource_reservation': False},
                'resource_recommendation': summary}

    def resolve(self, plan_id, bundle, identity):
        if not isinstance(plan_id, str) or not re.fullmatch('[a-f0-9]{64}', plan_id):
            raise ValueError('Invalid execution plan ID')
        signed = read_json(self.root / (plan_id + '.json'))
        exact(signed, {'data', 'signature'}, 'signed resource plan')
        record = signed['data']
        exact(record, RECORD_KEYS, 'frozen resource plan')
        payload = canonical(record)
        signature = hmac.new(self.signing_key, payload, hashlib.sha256).hexdigest()
        if not isinstance(signed['signature'], str) or not hmac.compare_digest(signature, signed['signature']) or hashlib.sha256(payload).hexdigest() != plan_id:
            raise ValueError('Invalid frozen resource plan signature or content ID')
        if record['schema'] != 'ic.spiceowl-plan.v1' or record['identity'] != normalize_identity(identity):
            raise ValueError('Execution plan identity mismatch')
        if self._bundle(bundle) != (record['bundle_path'], record['bundle_sha256']):
            raise ValueError('Execution plan bundle path or digest mismatch')
        validate_selection(record['selection'])
        exact(record['member'], {'host_id', 'site_file'}, 'frozen member')
        if record['member']['host_id'] != record['selection']['host_id']:
            raise ValueError('Frozen member does not match selected host')
        match_site(record['site'], record['selection'])
        return {'schema': 'ic.execution.context.v1', 'plan_id': plan_id,
                'site': copy.deepcopy(record['site']), 'resource_selection': copy.deepcopy(record['selection'])}

    def recheck(self, selection):
        original = copy.deepcopy(validate_selection(selection))
        latest = copy.deepcopy(self._backend().recheck(copy.deepcopy(original)))
        validate_selection(latest)
        for key in ('host_id', 'requirements', 'profile_sha256', 'simulator_version'):
            if latest[key] != original[key]:
                raise ValueError('Resource recheck changed the frozen selection identity: ' + key)
        return {'eligible': True, 'host_id': latest['host_id'], 'checked_at': latest['selected_at'],
                'selection': latest}
