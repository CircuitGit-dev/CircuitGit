"""Open-source PDK profiles, bounded local discovery, and pinned include generation.

Supports SkyWater SKY130, GlobalFoundries GF180MCU, IHP SG13G2, and PDK-free
built-in models without fabricating missing files or modifying external trees.
Python 3.9+, standard library only.
"""
import hashlib
import os
import re
from pathlib import Path

from platform_compat import IS_WINDOWS, is_safe_local_abs_path

SCHEMA = 'ic.open-pdk.v1'
SAFE_CORNER = re.compile(r'^[A-Za-z0-9_.-]{1,64}$')
SAFE_REL_PATH = re.compile(r'^[A-Za-z0-9_./ +-]+$')

OPEN_PDK_PROFILES = {
    'builtin': {
        'label': 'PDK-free built-in SPICE models',
        'requires_root': False,
        'default_corner': 'typical',
        'corners': ['typical'],
        'entry_candidates': [],
        'ngspice_options': [],
        'xyce_options': [],
        'devices': [],
    },
    'sky130': {
        'label': 'SkyWater SKY130 (sky130A / sky130B)',
        'requires_root': True,
        'default_corner': 'tt',
        'corners': ['tt', 'ff', 'ss', 'sf', 'fs', 'tt_mm', 'mc'],
        'entry_candidates': [
            'libs.tech/ngspice/sky130.lib.spice',
            'libs.tech/combined/sky130.lib.spice',
        ],
        'ngspice_options': ['.option ngbehavior=hsa'],
        'xyce_options': [],
        'devices': [
            'sky130_fd_pr__nfet_01v8',
            'sky130_fd_pr__pfet_01v8',
            'sky130_fd_pr__nfet_01v8_lvt',
            'sky130_fd_pr__pfet_01v8_lvt',
            'sky130_fd_pr__nfet_01v8_hvt',
            'sky130_fd_pr__pfet_01v8_hvt',
        ],
    },
    'gf180mcu': {
        'label': 'GlobalFoundries GF180MCU (gf180mcuC / gf180mcuD)',
        'requires_root': True,
        'default_corner': 'typical',
        'corners': ['typical', 'ff', 'ss', 'sf', 'fs'],
        'entry_candidates': [
            'libs.tech/ngspice/sm141064.ngspice',
            'libs.tech/ngspice/design.ngspice',
        ],
        'ngspice_options': ['.option ngbehavior=hsa'],
        'xyce_options': [],
        'devices': [
            'nfet_03v3',
            'pfet_03v3',
            'nfet_06v0',
            'pfet_06v0',
        ],
    },
    'ihp-sg13g2': {
        'label': 'IHP SG13G2 130nm SiGe BiCMOS Open PDK',
        'requires_root': True,
        'default_corner': 'mos_tt',
        'corners': ['mos_tt', 'mos_ff', 'mos_ss', 'mos_sf', 'mos_fs'],
        'entry_candidates': [
            'libs.tech/ngspice/models/cornerMOSlv.lib',
            'libs.tech/ngspice/models/cornerMOShv.lib',
        ],
        'ngspice_options': ['.option ngbehavior=hsa'],
        'xyce_options': [],
        'devices': [
            'sg13_lv_nmos',
            'sg13_lv_pmos',
            'sg13_hv_nmos',
            'sg13_hv_pmos',
            'npn13G2',
        ],
    },
}

DEFAULT_PDK_DIRS = (
    ('sky130', ('sky130A', 'sky130B')),
    ('gf180mcu', ('gf180mcuD', 'gf180mcuC')),
    ('ihp-sg13g2', ('ihp-sg13g2', 'sg13g2')),
)


def _sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_existing_file(root, relative):
    root = Path(root).resolve()
    candidate = root / relative
    if not candidate.exists():
        return None
    for part in [candidate, *candidate.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise ValueError('Open-PDK entry symlink escapes bounded root: ' + str(candidate))
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError('Open-PDK entry is not a regular file within root: ' + str(candidate))
    return resolved


def validate_open_pdk_config(spec):
    """Validate open_pdk object inside ic.sim.local-site.v1 without filesystem I/O."""
    if spec is None:
        return None
    if not isinstance(spec, dict):
        raise ValueError('open_pdk must be an object')
    allowed = {'pdk', 'root', 'corner', 'entry_file'}
    if set(spec) - allowed:
        raise ValueError('Unsupported open_pdk fields: ' + ', '.join(sorted(set(spec) - allowed)))
    pdk = spec.get('pdk')
    if pdk not in OPEN_PDK_PROFILES:
        raise ValueError('Unsupported open_pdk profile: ' + str(pdk))
    profile = OPEN_PDK_PROFILES[pdk]
    corner = spec.get('corner', profile['default_corner'])
    if not isinstance(corner, str) or corner not in profile['corners'] or not SAFE_CORNER.fullmatch(corner):
        raise ValueError(f'Unsupported corner {corner!r} for open_pdk {pdk}')
    root = spec.get('root')
    if profile['requires_root']:
        if not is_safe_local_abs_path(root, allow_spaces=True):
            raise ValueError(f'open_pdk {pdk} requires an absolute safe root path')
    elif root is not None:
        raise ValueError('open_pdk builtin does not accept a root path')
    entry_file = spec.get('entry_file')
    if entry_file is not None:
        if not isinstance(entry_file, str) or not SAFE_REL_PATH.fullmatch(entry_file) or entry_file.startswith('/') or '..' in Path(entry_file).parts:
            raise ValueError('open_pdk entry_file must be a safe relative path')
    normalized = {'pdk': pdk, 'corner': corner}
    if root is not None:
        normalized['root'] = root
    if entry_file is not None:
        normalized['entry_file'] = entry_file
    return normalized


def resolve_open_pdk(spec, engine='ngspice'):
    """Resolve an installed open PDK on disk and compute deterministic file hashes."""
    config = validate_open_pdk_config(spec)
    if config is None or config['pdk'] == 'builtin':
        return {
            'schema': SCHEMA,
            'pdk': 'builtin',
            'corner': 'typical',
            'root': None,
            'entry_files': [],
            'directives': [],
            'external_files': {},
            'dependency_sha256': {},
            'available': True,
        }
    pdk = config['pdk']
    profile = OPEN_PDK_PROFILES[pdk]
    root = Path(config['root'])
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f'Open-PDK root directory not found: {root}')
    root = root.resolve()

    candidates = [config['entry_file']] if 'entry_file' in config else list(profile['entry_candidates'])
    found = None
    for rel in candidates:
        resolved = _safe_existing_file(root, rel)
        if resolved is not None:
            found = (rel, resolved)
            break
    if found is None:
        raise ValueError(f'No supported entry library found under {root} for {pdk}: tried {", ".join(candidates)}')

    rel_entry, entry_path = found
    entry_sha = _sha256_file(entry_path)
    alias = 'OPEN_PDK_' + re.sub(r'[^A-Z0-9]+', '_', pdk.upper()).strip('_')
    directives = []
    if engine == 'ngspice':
        directives.extend(profile['ngspice_options'])
    elif engine == 'xyce':
        directives.extend(profile['xyce_options'])
    directives.append(f'.lib "{entry_path}" {config["corner"]}')

    return {
        'schema': SCHEMA,
        'pdk': pdk,
        'label': profile['label'],
        'corner': config['corner'],
        'root': str(root),
        'entry_files': [{'relative': rel_entry, 'path': str(entry_path), 'sha256': entry_sha}],
        'directives': directives,
        'external_files': {alias: str(entry_path)},
        'dependency_sha256': {alias: entry_sha},
        'available': True,
    }


def discover_open_pdks(search_roots=None):
    """Read-only probe for installed open PDKs in standard local locations."""
    roots = []
    if search_roots is not None:
        roots.extend(Path(p).expanduser() for p in search_roots)
    else:
        for env_key in ('PDK_ROOT', 'VOLARE_HOME'):
            val = os.environ.get(env_key)
            if val:
                roots.append(Path(val).expanduser())
        if IS_WINDOWS:
            local_app = os.environ.get('LOCALAPPDATA')
            if local_app:
                roots.extend([Path(local_app) / 'pdk', Path(local_app) / 'volare'])
            roots.extend([
                Path.home() / '.volare',
                Path.home() / 'pdk',
                Path('C:/pdk'),
                Path('C:/open_pdks'),
            ])
        else:
            roots.extend([
                Path('/usr/local/share/pdk'),
                Path('/opt/homebrew/share/pdk'),
                Path.home() / '.volare',
                Path.home() / 'pdk',
            ])

    discovered = []
    seen = set()
    for base in roots:
        if not base.is_dir():
            continue
        for pdk, names in DEFAULT_PDK_DIRS:
            for folder_name in names:
                candidate_roots = [base / folder_name]
                if base.name == folder_name:
                    candidate_roots.insert(0, base)
                for candidate in candidate_roots:
                    key = (pdk, str(candidate))
                    if key in seen or not candidate.is_dir() or candidate.is_symlink():
                        continue
                    seen.add(key)
                    try:
                        resolved = resolve_open_pdk({'pdk': pdk, 'root': str(candidate)})
                        discovered.append({
                            'pdk': pdk,
                            'label': resolved['label'],
                            'root': resolved['root'],
                            'default_corner': resolved['corner'],
                            'corners': list(OPEN_PDK_PROFILES[pdk]['corners']),
                            'entry_files': resolved['entry_files'],
                        })
                    except ValueError:
                        continue
    return {
        'schema': 'ic.open-pdk-discovery.v1',
        'discovered': discovered,
        'supported_profiles': sorted(OPEN_PDK_PROFILES),
    }
