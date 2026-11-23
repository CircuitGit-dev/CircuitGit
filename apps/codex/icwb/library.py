"""Finite adapter to the application's installed, shared library workflow."""
import importlib.util
import json
from pathlib import Path
import re
import threading

from .library_contracts import ARGS, READS, WRITES, SCHEMAS
from .service import Failure, canonical, check

CONFIG_KEYS = {'library_workspace', 'library_repository', 'library_access', 'library_state_dir',
               'library_base_branch', 'library_testbench_registry'}
LOCK = threading.RLock()
_workflow_module = None


def profile(config):
    check(isinstance(config, dict), 'Invalid operator library configuration', 'library_unavailable', 4)
    access = config.get('library_access', 'read_only')
    check(access in ('read_only', 'direct'), 'Invalid operator library access', 'library_unavailable', 4)
    root = config.get('library_workspace')
    check(isinstance(root, str) and Path(root).is_absolute(), 'Configure an absolute library_workspace', 'library_unavailable', 4)
    repository = config.get('library_repository')
    check(isinstance(repository, str) and re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository), 'Configure library_repository as owner/repository', 'library_unavailable', 4)
    try:
        root = Path(root).resolve(strict=True)
    except OSError:
        raise Failure('library_unavailable', 'Configured library workspace is unavailable', 4) from None
    check(root.is_dir(), 'Library workspace is missing', 'library_unavailable', 4)
    state = config.get('library_state_dir', str(root / '.local/library-workflow'))
    check(isinstance(state, str) and Path(state).is_absolute() and Path(state).resolve().is_relative_to(root / '.local'),
          'Library state must be an absolute directory within workspace .local', 'library_unavailable', 4)
    return {'workspace': str(root), 'repository': repository, 'access': access, 'state_dir': str(Path(state).resolve()),
            'base_branch': config.get('library_base_branch', 'main'), 'testbench_registry': config.get('library_testbench_registry')}


def configured_binding(config):
    return profile(config) if config.get('library_workspace') else None


def module():
    global _workflow_module
    with LOCK:
        if _workflow_module is None:
            package = Path(__file__).resolve().parents[1]
            choices = [package / 'gateway/library_workflow.py', package.parent.parent / 'tools/workbench/library_workflow.py']
            code = next((p for p in choices if p.is_file()), None)
            check(code is not None, 'Installed library workflow module is missing', 'library_unavailable', 4)
            spec = importlib.util.spec_from_file_location('icwb_owned_library_workflow', code)
            loaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(loaded)
            _workflow_module = loaded
        return _workflow_module


def validate_args(value):
    check(isinstance(value, dict) and set(value) <= set(ARGS), 'Unsupported library operation arguments')
    check(len(canonical(value).encode()) <= 2 * 1024 * 1024, 'Library arguments exceed 2 MiB')
    for key, item in value.items():
        if key == 'files':
            check(isinstance(item, list) and 1 <= len(item) <= 20, 'save_files requires 1..20 files')
            for row in item:
                check(isinstance(row, dict) and set(row) == {'path', 'base_sha256', 'content'}, 'Each file requires exact path/base_sha256/content')
                check(isinstance(row['path'], str) and isinstance(row['content'], str), 'File path/content must be strings')
                check(row['base_sha256'] is None or isinstance(row['base_sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', row['base_sha256']), 'Invalid base file hash')
        elif key == 'enabled': check(type(item) is bool, 'enabled must be boolean')
        elif key == 'limit': check(type(item) is int and 1 <= item <= 100, 'limit must be 1..100')
        elif key == 'testbench_ids': check(isinstance(item, list) and len(item) <= 32 and all(isinstance(x, str) for x in item), 'Invalid testbench IDs')
        elif key in ('base_sha256', 'source_sha256'): check(item is None or isinstance(item, str) and re.fullmatch(r'[a-f0-9]{64}', item), 'Invalid content hash')
        else: check(isinstance(item, str) and len(item) <= 1024 * 1024 and '\x00' not in item, 'Library arguments must be bounded text')


class LibraryAdapter:
    def __init__(self, service):
        self.service = service
        self.binding = None
        self.workflow = None

    def owner(self):
        binding = profile(self.service.config)
        with LOCK:
            if self.binding != binding:
                installed = module(); package = Path(__file__).resolve().parents[1]
                registry = binding['testbench_registry']
                if registry is None:
                    registry = next((p for p in (package / 'library-testbenches.json', package.parent.parent / 'config/library-testbenches.json') if p.is_file()), None)
                if registry is not None:
                    check(Path(registry).is_absolute() and Path(registry).is_file() and Path(registry).stat().st_size <= 1024 * 1024, 'Invalid operator testbench registry')
                    registry = json.loads(Path(registry).read_text())
                injected = getattr(self.service, 'library_workflow', None)
                if injected is not None:
                    check(str(injected.root) == binding['workspace'] and injected.repository == binding['repository']
                          and str(injected.state) == binding['state_dir'], 'Injected library owner differs from configured scope', 'library_changed', 4)
                    workflow = injected
                else:
                    workflow = installed.LibraryWorkflow(binding['workspace'], binding['repository'], base_branch=binding['base_branch'],
                        state_dir=binding['state_dir'], ci_registry=registry or {}, gh_bin=self.service.config.get('gh_bin', 'gh'))
                self.workflow, self.binding = workflow, binding
            return self.workflow, binding

    def catalog(self, workflow):
        check(callable(getattr(workflow, 'catalog', None)), 'Installed workflow lacks the committed library catalog; update the application', 'library_unavailable', 4)
        catalog = workflow.catalog()
        # File inventories belong to describe: listing all cells should remain
        # small enough for model context and browser project selection.
        return {**catalog, 'libraries': [{**lib, 'cells': [
            {**{key: value for key, value in cell.items() if key != 'views'},
             'views': [{key: view[key] for key in ('kind', 'entry', 'level') if key in view}
                       for view in cell.get('views', [])]}
            for cell in lib['cells']]} for lib in catalog['libraries']]}

    def call(self, name, payload):
        try:
            check(name in SCHEMAS and isinstance(payload, dict), 'Unknown library tool')
            execute = name == 'ic_library_execute'
            required = {'operation', 'arguments', 'idempotency_key'} if execute else {'operation', 'arguments'}
            check(set(payload) == required, 'Library tools require exact fields; no root/access/approval overrides')
            operation, args = payload['operation'], payload['arguments']
            check(isinstance(operation, str) and operation in (WRITES if execute else READS), 'Unsupported finite library operation')
            validate_args(args)
            binding = profile(self.service.config)
            if execute:
                check(binding['access'] == 'direct', 'Library workspace is read-only; direct access requires operator configuration', 'library_read_only', 4)
                key = payload['idempotency_key']; check(isinstance(key, str) and 8 <= len(key) <= 160, 'Stable library idempotency key required')
            owner, binding = self.owner()
            if operation == 'capability':
                check(not args, 'Capability accepts no arguments')
                return {'available': True, 'repository': binding['repository'], 'access': binding['access'],
                        'operations': sorted(READS | (WRITES if binding['access'] == 'direct' else set())),
                        'pdk_required_for_edit': False, 'virtuoso_required': False}
            if operation == 'catalog':
                check(not args, 'Catalog accepts no arguments'); return self.catalog(owner)
            if execute:
                check(callable(getattr(owner, 'execute', None)), 'Installed workflow lacks direct execution; update the application', 'library_unavailable', 4)
                result = owner.execute(operation, args, payload['idempotency_key'])
                if not isinstance(result, dict) or result.get('state') != 'complete':
                    raise Failure('library_incomplete', 'Library operation is incomplete; inspect its original receipt, do not change its key or repeat dependent work',
                                  75, {'receipt': result if isinstance(result, dict) else {'state': 'unknown'}})
                return result
            return owner.dispatch(operation, args)
        except Failure: raise
        except Exception as error:
            code = getattr(error, 'code', 'library_error'); status = getattr(error, 'status', 400)
            raise Failure(code, str(error), 75 if status >= 500 else 4 if status == 403 else 3 if status == 409 else 2,
                          getattr(error, 'details', {})) from None


def call(service, name, payload):
    # Per-Service instance: two chats share the workflow's durable lock/ledger,
    # while no model can mutate an adapter's operator configuration.
    with LOCK:
        adapter = getattr(service, '_library_adapter', None)
        if adapter is None or adapter.service is not service:
            adapter = LibraryAdapter(service); service._library_adapter = adapter
    return adapter.call(name, payload)


def library_identity(project_id):
    check(isinstance(project_id, str) and project_id.startswith('library:'), 'Explicit library project identity required')
    parts = project_id[8:].split('/')
    check(len(parts) == 2 and all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', p) and '..' not in p for p in parts), 'Invalid library project identity')
    return {'library_id': parts[0], 'cell_id': parts[1]}


def source(service, project_id, path=None):
    identity = library_identity(project_id)
    described = call(service, 'ic_library_read', {'operation': 'describe', 'arguments': identity})
    catalog = call(service, 'ic_library_read', {'operation': 'catalog', 'arguments': {}})
    check(catalog.get('base_commit') == described['base_commit'], 'Library HEAD changed during manifest read; refresh context', 'conflict', 3)
    cell = next((cell for lib in catalog['libraries'] if lib['id'] == identity['library_id']
                 for cell in lib['cells'] if cell['id'] == identity['cell_id']), None)
    check(cell is not None, 'Library cell is absent from the committed catalog', 'not_found', 4)
    if path is None:
        path = cell.get('source_path', cell.get('entry'))
        if path is None: path = next((item['path'] for item in described['files'] if item.get('editable')), None)
    check(path is not None, 'This library cell has no declared editable source', 'not_found', 4)
    file = call(service, 'ic_library_read', {'operation': 'read_file', 'arguments': {**identity, 'path': path}})
    check(file['base_commit'] == described['base_commit'], 'Library HEAD changed during source read; refresh context', 'conflict', 3)
    return {'project': {'id': project_id, 'repository': described['repository'], 'branch': described.get('branch'),
                        'runtimeProjectId': cell.get('project_id'), **identity},
            'file': file, 'geometry': {'mode': 'library-owned-rnl', 'state': 'unknown', 'native_ready': False}}


def source_context(service, project_id, path=None):
    actual = source(service, project_id, path); file = actual['file']; project = actual['project']
    return {'version': 1, 'revision': 1, 'mode': 'live', 'library': library_identity(project_id),
            'project': {**project, 'sourceCommit': file['base_commit']},
            'file': {'path': file['path'], 'baseCommit': file['base_commit'], 'persistedSha256': file['sha256'],
                     'currentTextSha256': file['sha256'], 'dirty': False, 'editable': file['editable']},
            'selection': None, 'geometry': actual['geometry'], 'run': None}
