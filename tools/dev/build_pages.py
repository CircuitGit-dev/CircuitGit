#!/usr/bin/env python3
"""Build the static GitHub Pages demo from explicit web/module asset roots."""
import json
from pathlib import Path
import subprocess
from build import build
from build_library import publish as publish_library
from build_library_history import publish as publish_library_history

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'site'

def main():
    result = build('web', OUTPUT)
    (OUTPUT / '.nojekyll').write_text('')
    (OUTPUT / 'index.html').write_text('''<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="CircuitGit: AI-native circuit design, versioned on GitHub. Interactive schematic and waveform workbench.">
<title>CircuitGit · Interactive workbench</title><link rel="icon" href="branding/circuitgit-small.svg">
<script src="pages-redirect.js" defer></script></head><body>
<h1>CircuitGit</h1><p>AI-native circuit design, versioned on GitHub.</p>
<a href="studio/index.html?layout=dockview&amp;demo=1">Open interactive demo</a>
<a href="workflow/index.html">Explore the real-circuit workflow and capability boundaries</a>
</body></html>''')
    (OUTPUT / 'pages-redirect.js').write_text("location.replace(new URL('studio/index.html?layout=dockview&demo=1',location.href));\n")
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
