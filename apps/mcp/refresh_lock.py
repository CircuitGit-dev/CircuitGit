"""Explicit maintainer operation: lock a trusted pip report using official PyPI hashes.

Not called by the runtime, normal startup, package build or tests. This only writes
the isolated requirements lock and provenance; it does not install dependencies.
"""
import argparse
import json
from pathlib import Path
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--metadata-dir', type=Path, help='Use already fetched official PyPI metadata instead of network')
    args = parser.parse_args()
    report = json.loads(args.report.read_text())
    rows, provenance = [], []
    for record in sorted(report['install'], key=lambda r: r['metadata']['name'].lower()):
        name, version = record['metadata']['name'], record['metadata']['version']
        url = 'https://pypi.org/pypi/' + name + '/' + version + '/json'
        if args.metadata_dir:
            metadata = json.loads((args.metadata_dir/(name+'.json')).read_text())
        else:
            with urlopen(url, timeout=30) as response:
                metadata = json.load(response)
        if metadata['info']['name'].lower().replace('_','-') != name.lower().replace('_','-') or metadata['info']['version'] != version:
            raise ValueError('PyPI identity mismatch: '+name)
        files = [f for f in metadata['urls'] if not f.get('yanked') and f['packagetype']=='bdist_wheel']
        hashes = sorted({f['digests']['sha256'] for f in files})
        installed_hash = record['download_info']['archive_info']['hashes']['sha256']
        if installed_hash not in hashes:
            raise ValueError('Installed artifact is not a current non-yanked official wheel: '+name)
        # Include every wheel at this exact version for Linux/macOS portability.
        # --only-binary prevents unreviewed source build dependencies from entering.
        rows.append(name+'=='+version+' \\\n'+' \\\n'.join('    --hash=sha256:'+h for h in hashes))
        provenance.append({'name':name,'version':version,'pypi_metadata':url,
                           'license':metadata['info'].get('license_expression') or metadata['info'].get('license'),
                           'requires_python':metadata['info'].get('requires_python'),
                           'verified_installed_wheel_sha256':installed_hash,'allowed_wheel_count':len(hashes)})
    root = Path(__file__).resolve().parent
    (root/'requirements.lock').write_text(
        '# Optional POSIX Python3.12 environment, resolved 2026-11-13.\n'
        '# Official PyPI hashes for all wheels at each exact version. No source builds.\n'
        '--index-url https://pypi.org/simple\n--only-binary :all:\n\n'+'\n'.join(rows)+'\n')
    (root/'dependency-provenance.json').write_text(json.dumps({'schema':'ic.mcp.dependencies.v1',
        'resolved_python':report['environment']['python_full_version'],
        'resolved_platform':report['environment']['sys_platform'],
        'packages':provenance},ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__': main()
