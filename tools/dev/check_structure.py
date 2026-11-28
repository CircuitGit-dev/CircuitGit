#!/usr/bin/env python3
"""Check architectural boundaries, cross-platform guards, and all static JS imports without installing packages."""
import ast,json,re,sys,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(Path(__file__).resolve().parent))
from build import assets,web_payload
sys.path.insert(0,str(ROOT/'tools/workbench'))
from upstream_sources import inspect_upstreams

IMPORT=re.compile(r'''(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"\n]+)\1''')
POSIX_ONLY_PATTERNS = (
    (re.compile(r'\bos\.get(?:e)?uid\s*\('), 'Direct os.getuid/os.geteuid breaks Windows; use platform_compat.is_owner_private_file/dir'),
    (re.compile(r'\bselectors\.DefaultSelector\s*\('), 'Direct selectors.DefaultSelector on pipes breaks Windows; use platform_compat.read_bounded_pipes'),
    (re.compile(r'\bstart_new_session\s*=\s*True\b'), 'Direct start_new_session=True breaks Windows; use platform_compat.detached_popen_kwargs/isolated_popen_kwargs'),
    (re.compile(r"""['"]/usr/bin/ssh['"]"""), 'Hardcoded /usr/bin/ssh breaks Windows; use platform_compat.find_ssh_binary()'),
    (re.compile(r'core\.(?:hooksPath|attributesFile)=/dev/null'), 'Hardcoded /dev/null in Git config breaks Windows; use os.devnull / platform_compat.git_devnull()'),
)
COMPAT_MODULES = {
    'tools/workbench/platform_compat.py',
    'modules/gateway_client/ic_gateway/platform_compat.py',
    'tools/dev/check_structure.py',
}

def check_cross_platform():
    checked = 0
    for root_name in ('apps', 'modules', 'tools'):
        base = ROOT / root_name
        if not base.is_dir():
            continue
        for path in sorted(base.rglob('*.py')):
            rel = path.relative_to(ROOT).as_posix()
            if any(part.startswith('.') or part in ('__pycache__', 'node_modules', 'scratch') for part in path.parts):
                continue
            if rel in COMPAT_MODULES or rel.startswith('tools/sim/') or path.name.startswith('test_'):
                continue
            checked += 1
            text = path.read_text(encoding='utf-8')
            tree = ast.parse(text, filename=rel)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name == 'fcntl':
                            raise ValueError(f'Cross-platform guard: {rel} imports fcntl directly; use platform_compat')
                elif isinstance(node, ast.ImportFrom) and node.module == 'fcntl':
                    raise ValueError(f'Cross-platform guard: {rel} imports from fcntl directly; use platform_compat')
            for pattern, reason in POSIX_ONLY_PATTERNS:
                if pattern.search(text):
                    raise ValueError(f'Cross-platform guard ({rel}): {reason}')
    if not (ROOT / 'Start CircuitGit.command').is_file():
        raise ValueError('Cross-platform guard: missing macOS launcher Start CircuitGit.command')
    if not (ROOT / 'Start CircuitGit.bat').is_file():
        raise ValueError('Cross-platform guard: missing Windows launcher Start CircuitGit.bat')
    return checked

def imports(text):
    # Vendor JSDoc references upstream TypeScript sources not shipped at runtime.
    return IMPORT.finditer(re.sub(r'/\*[\s\S]*?\*/','',text))

def check():
    # Git index gitlinks remain available in a nonrecursive/shallow checkout.
    # Inspection is offline and never initializes or rewrites upstream sources.
    upstreams=inspect_upstreams(ROOT)
    cross_platform_checked=check_cross_platform()
    mapping=assets();count=0
    for path in mapping:
        if path.is_relative_to(ROOT/'submodules'):
            raise ValueError('Upstream source cannot be packaged as an application asset: '+str(path))
        if path.suffix not in ('.js','.mjs'):continue
        for match in imports(path.read_text()):
            value=match[2]
            if not value.startswith('.'):continue
            target=(path.parent/value.split('?')[0].split('#')[0]).resolve()
            if not target.is_file():raise ValueError('Broken source import: '+str(path.relative_to(ROOT))+' -> '+value)
            if target not in mapping:raise ValueError('Import escapes public asset roots: '+str(target))
            if path.is_relative_to(ROOT/'modules') and not target.is_relative_to(ROOT/'modules'):
                raise ValueError('Shared module depends on an app: '+str(path))
            count+=1
    # Generated URLs must resolve under the static root, including compatibility entrypoints.
    from urllib.parse import urljoin,urlsplit
    output=web_payload()
    for name,data in output.items():
        if not name.endswith(('.js','.mjs')):continue
        for match in imports(data.decode()):
            value=match[2]
            if not value.startswith('.'):continue
            resolved=urlsplit(urljoin('http://build/'+name,value)).path.lstrip('/')
            if resolved not in output:raise ValueError('Broken built import: '+name+' -> '+value)
    from subprocess import check_call
    check_call([sys.executable,'-X','utf8','-B',str(ROOT/'tools/dev/export_contracts.py'),'--check'])
    registry=json.loads((ROOT/'contracts/modules.v1.json').read_text())
    for module in registry['modules']:
        if not (ROOT/module['entry']).is_file():raise ValueError('Missing module entry: '+module['id'])
    return {'status':'passed','source_imports':count,'public_assets':len(mapping),'module_entries':len(registry['modules']),'cross_platform_files_checked':cross_platform_checked,'upstreams':upstreams}
if __name__=='__main__':print(json.dumps(check()))
