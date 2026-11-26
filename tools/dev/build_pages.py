#!/usr/bin/env python3
"""Build the static GitHub Pages demo from explicit web/module asset roots."""
import json
from pathlib import Path
import re
import subprocess
from build import build
from build_library import publish as publish_library
from build_library_history import publish as publish_library_history

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'site'
APP_ASSET_DIRS = ('studio', 'demo', 'remote', 'library', 'ai', 'modules')
MODULE_IMPORT_RE = re.compile(
    r"""((?:from\s+|import\s*\(|new\s+URL\(\s*)(['"]))(\.\.?/[^'"?\n]+\.(?:js|css))(\2)"""
)


def stamp_pages_cache_buster(output, rev):
    """Append ?v=<rev> to app-owned JS/CSS specifiers in generated site/ so Pages updates immediately."""
    def replace_specifier(match):
        prefix, quote, spec, end_quote = match.groups()
        if '/vendor/' in spec or spec.startswith('./vendor/'):
            return match.group(0)
        return f'{prefix}{spec}?v={rev}{end_quote}'

    for folder in APP_ASSET_DIRS:
        root_dir = output / folder
        if not root_dir.is_dir():
            continue
        for js_file in root_dir.rglob('*.js'):
            text = js_file.read_text(encoding='utf-8')
            updated = MODULE_IMPORT_RE.sub(replace_specifier, text)
            if updated != text:
                js_file.write_text(updated, encoding='utf-8')

    studio_html = output / 'studio/index.html'
    if studio_html.is_file():
        html = studio_html.read_text(encoding='utf-8')
        html = re.sub(
            r'((?:href|src)=")(\.\./\.\./studio/[^"?]+\.(?:js|css))(")',
            rf'\1\2?v={rev}\3',
            html,
        )
        studio_html.write_text(html, encoding='utf-8')


def main():
    result = build('web', OUTPUT)
    rev = subprocess.check_output(['git', 'rev-parse', '--short=8', 'HEAD'], cwd=ROOT, text=True).strip()
    stamp_pages_cache_buster(OUTPUT, rev)
    (OUTPUT / '.nojekyll').write_text('')
    (OUTPUT / 'index.html').write_text(f'''<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="CircuitGit: AI-native circuit design, versioned on GitHub. Interactive schematic and waveform workbench.">
<title>CircuitGit · Interactive workbench</title><link rel="icon" href="branding/circuitgit-small.svg">
<script src="pages-redirect.js?v={rev}" defer></script></head><body>
<h1>CircuitGit</h1><p>AI-native circuit design, versioned on GitHub.</p>
<a href="studio/index.html?layout=dockview&amp;demo=1&amp;v={rev}">Open interactive demo</a>
<a href="workflow/index.html">Explore the real-circuit workflow and capability boundaries</a>
</body></html>''')
    (OUTPUT / 'pages-redirect.js').write_text(f"location.replace(new URL('studio/index.html?layout=dockview&demo=1&v={rev}',location.href));\n")
    commits=[]
    output=subprocess.check_output(['git','log','-8','--format=%H%x09%s'],cwd=ROOT,text=True)
    for line in output.splitlines():
        sha,subject=line.split('\t',1);commits.append({'sha':sha,'subject':subject})
    (OUTPUT / 'demo/release.json').write_text(json.dumps({'repository':'CircuitGit-dev/CircuitGit','commits':commits},indent=2)+'\n')
    library = publish_library(ROOT, OUTPUT)
    published_library_files = {item['path'] for item in library['files']}
    history = publish_library_history(ROOT, OUTPUT)
    published_library_files.add('lib/history.json')
    forbidden={'projects','design','results','runs','validation','config','.local','.git','.gitmodules','submodules'}
    for path in OUTPUT.rglob('*'):
        rel=path.relative_to(OUTPUT)
        indexed = rel.parts[0] == 'library-files'
        if path.is_symlink() or path.name.endswith('.local.json') or (not indexed and any(x in forbidden for x in rel.parts)):
            raise ValueError('Private or unsupported Pages asset: '+str(rel))
        if indexed and path.is_file() and rel.relative_to('library-files').as_posix() not in published_library_files:
            raise ValueError('Unindexed library asset: '+str(rel))
    print(json.dumps({**result,'mode':'static-demo','entry':'index.html','backend_required':False,
                      'libraries':library['libraries'],'library_cells':library['cells'],'library_files':len(library['files']),
                      'history_cells':len(history['cells'])}))

if __name__ == '__main__':main()
