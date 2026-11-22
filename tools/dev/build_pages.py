#!/usr/bin/env python3
"""Build the static GitHub Pages demo from explicit web/module asset roots."""
import json
from pathlib import Path
import subprocess
from build import build

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
<a href="vendor/rnl-viewer/index.html?studio=1&amp;layout=dockview&amp;demo=1">Open interactive demo</a>
</body></html>''')
    (OUTPUT / 'pages-redirect.js').write_text("location.replace(new URL('vendor/rnl-viewer/index.html?studio=1&layout=dockview&demo=1',location.href));\n")
    commits=[]
    output=subprocess.check_output(['git','log','-8','--format=%H%x09%s'],cwd=ROOT,text=True)
    for line in output.splitlines():
        sha,subject=line.split('\t',1);commits.append({'sha':sha,'subject':subject})
    (OUTPUT / 'demo/release.json').write_text(json.dumps({'repository':'joshuazeng713/CircuitGit','commits':commits},indent=2)+'\n')
    forbidden={'projects','design','results','runs','validation','config','.local','.git'}
    for path in OUTPUT.rglob('*'):
        rel=path.relative_to(OUTPUT)
        if path.is_symlink() or any(x in forbidden for x in rel.parts) or path.name.endswith('.local.json'):
            raise ValueError('Private or unsupported Pages asset: '+str(rel))
    print(json.dumps({**result,'mode':'static-demo','entry':'index.html','backend_required':False}))

if __name__ == '__main__':main()
