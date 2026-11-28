"""Validate and publish only the explicit, redistributable circuit-library inventory."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil

CATALOG = 'lib/catalog.json'
EXTENSIONS = {'.json', '.md', '.scs', '.rnl', '.va', '.v', '.sv', '.svg', '.png', '.jpg', '.jpeg', '.csv', '.txt', '.ocn', '.il'}
TEXT_EXTENSIONS = EXTENSIONS - {'.png', '.jpg', '.jpeg'}
PRIVATE = re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,})\b|https?://[^\s/@:]+:[^\s/@]+@|/(?:Users|home)/[^/\s]+/', re.I)
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')


def check(value, message):
    if not value:
        raise ValueError(message)


def library_path(value):
    check(isinstance(value, str) and 0 < len(value) <= 512, 'Library paths must be bounded strings')
    parts = PurePosixPath(value).parts
    check(not value.startswith('/') and not any(c in value for c in '\\:%?#')
          and not any(ord(c) < 32 or ord(c) == 127 for c in value)
          and parts and parts[0] in {'lib', 'projects'} and all(p not in {'.', '..', ''} for p in value.split('/')),
          'Invalid library path: ' + value)
    check(not any(p.startswith('.') or p.lower() in {'private', 'pdks', 'psf', 'ahdlsimdb', 'node_modules'} for p in parts),
          'Private/runtime path in library inventory: ' + value)
    check(not value.endswith('.local.json') and PurePosixPath(value).suffix.lower() in EXTENSIONS,
          'Unsupported library file: ' + value)
    return value


def path_at(root, value):
    library_path(value)
    path = root / value
    check(all(not p.is_symlink() for p in [path, *path.parents] if p != root and root in p.parents),
          'Library symlinks are not publishable: ' + value)
    check(path.is_file() and path.resolve().is_relative_to(root.resolve()), 'Missing library file: ' + value)
    return path


def view_aliases(view):
    aliases = view.get('aliases', {})
    check(isinstance(aliases, dict) and len(aliases) <= 8192, 'Invalid library source mapping')
    names = set(view['files'])
    for logical, canonical in aliases.items():
        library_path(logical); library_path(canonical)
        check(canonical in names and (logical not in names or logical == canonical), 'Alias must reference a declared canonical file without shadowing another file')
    return aliases


def collect(root):
    root = Path(root).resolve()
    check(not (root / 'lib').is_symlink() and not (root / CATALOG).is_symlink(),
          'Library catalog symlinks are not publishable')
    if not (root / CATALOG).exists():
        return {'schema': 'circuitgit.library-build.v1', 'libraries': 0, 'cells': 0, 'views': 0, 'files': [], 'bytes': 0}
    files, total = {}, 0

    def take(value):
        nonlocal total
        check(isinstance(value, str), 'Library paths must be strings')
        if value in files:
            return files[value]
        path = path_at(root, value)
        size = path.stat().st_size
        check(size <= 10 * 1024 * 1024, 'Library file exceeds 10 MiB: ' + value)
        raw = path.read_bytes()
        if path.suffix.lower() in TEXT_EXTENSIONS:
            text = raw.decode('utf-8')
            check(not PRIVATE.search(text), 'Private credentials or machine paths in library file: ' + value)
        total += len(raw)
        check(total <= 150 * 1024 * 1024 and len(files) < 10000, 'Library publication exceeds bounded inventory')
        files[value] = {'path': value, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        return files[value]

    def read(value):
        take(value)
        return json.loads((root / value).read_text())

    catalog = read(CATALOG)
    check(isinstance(catalog, dict) and catalog.get('schema') == 'circuitgit.libraries.v1', 'Unsupported library catalog')
    libraries = catalog.get('libraries')
    check(isinstance(libraries, list) and len(libraries) <= 200, 'Invalid library list')
    seen, cell_count, view_count = set(), 0, 0
    for summary in libraries:
        check(isinstance(summary, dict), 'Invalid library entry')
        lid = summary.get('id', '')
        check(isinstance(lid, str) and ID.fullmatch(lid) and lid not in seen, 'Duplicate or invalid library ID')
        seen.add(lid)
        expected = 'lib/' + lid + '/library.json'
        check(summary.get('manifest') == expected, 'Library manifest must be inside its own library')
        library = read(expected)
        check(isinstance(library, dict) and library.get('schema') == 'circuitgit.library.v1' and library.get('id') == lid, 'Library identity mismatch')
        cells, ids = library.get('cells'), set()
        check(isinstance(cells, list) and len(cells) <= 5000, 'Invalid cell list')
        for cell in cells:
            check(isinstance(cell, dict), 'Invalid cell record')
            cid = cell.get('id', '')
            check(isinstance(cid, str) and ID.fullmatch(cid) and cid not in ids, 'Duplicate or invalid cell ID')
            ids.add(cid);cell_count += 1
            directory = 'lib/' + lid + '/' + cid
            check(cell.get('directory') == directory, 'Cell directory identity mismatch')
            check(cell.get('kind') in {'circuit', 'testbench', 'primitive'}, 'Invalid cell kind')
            check(type(cell.get('requires_external_models')) is bool, 'Cell model dependency must be explicit')
            check(cell.get('project_id') is None or isinstance(cell['project_id'], str), 'Invalid runtime project reference')
            readme = cell.get('readme')
            check(isinstance(readme, str) and readme.startswith(directory + '/'), 'Cell README must belong to the cell')
            take(readme)
            views, view_ids = cell.get('views'), set()
            check(isinstance(views, list) and 0 < len(views) <= 32, 'Cell must declare its available views')
            for view in views:
                check(isinstance(view, dict), 'Invalid view record')
                vid = view.get('id')
                check(isinstance(vid, str) and ID.fullmatch(vid) and vid not in view_ids, 'Invalid or duplicate view')
                view_ids.add(vid);view_count += 1
                check(view.get('kind') in {'rnl', 'veriloga', 'spectre', 'json', 'markdown'}, 'Unsupported view kind')
                level = view.get('level')
                check(level is None or (isinstance(level, str) and 0 < len(level) <= 256
                                       and not any(ord(c) < 32 for c in level)), 'Invalid native view level')
                names = view.get('files')
                check(isinstance(names, list) and 0 < len(names) <= 4096 and all(isinstance(n, str) for n in names)
                      and len(names) == len(set(names)) and view.get('entry') in names, 'View requires an explicit file closure including its entry')
                view_aliases(view)
                for name in names:
                    take(name)
    if (root / 'lib/README.md').exists():
        take('lib/README.md')
    return {'schema': 'circuitgit.library-build.v1', 'libraries': len(libraries), 'cells': cell_count,
            'views': view_count, 'files': [files[k] for k in sorted(files)], 'bytes': total}


def publish(root, output):
    report = collect(root)
    target = Path(output) / 'library-files'
    check(not target.is_symlink(), 'Library output must not be a symlink')
    if target.exists():
        shutil.rmtree(target)
    for item in report['files']:
        dest = target / item['path'];dest.parent.mkdir(parents=True, exist_ok=True)
        raw = path_at(Path(root).resolve(), item['path']).read_bytes()
        check(hashlib.sha256(raw).hexdigest() == item['sha256'], 'Library source changed during publication: ' + item['path'])
        dest.write_bytes(raw)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    result = collect(args.root)
    print(json.dumps({k: len(v) if k == 'files' else v for k, v in result.items()}))
