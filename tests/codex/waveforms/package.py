#!/usr/bin/env python3
"""Assemble a wave resource with a read-only snapshot of the UI owner's packager.

This local build check does not install or mount a native Codex app.
"""
import argparse,hashlib,importlib.util,json,shutil,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--host-code',type=Path,required=True);p.add_argument('--schematic-code',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
root=Path(__file__).resolve().parents[3];host=a.host_code.resolve();out=a.output.resolve();out.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='wave-package-',dir=out) as temp:
 stage=Path(temp);ui=stage/'apps/codex/ui';ui.mkdir(parents=True)
 shutil.copytree(root/'apps/codex/ui/waveforms',ui/'waveforms')
 inputs=[]
 for name in ['host.js','shell.css','bootstrap.js']:
  source=host/'apps/codex/ui'/name;shutil.copy2(source,ui/name);inputs.append({'path':str(source),'sha256':sha(source)})
 shutil.copytree(root/'modules/waveforms',stage/'modules/waveforms')
 if a.schematic_code:
  shutil.copytree(a.schematic_code/'apps/codex/ui/schematic',ui/'schematic')
  shutil.copytree(root/'apps/web/vendor/rnl-viewer',stage/'apps/web/vendor/rnl-viewer')
  shutil.copytree(root/'modules/schematic',stage/'modules/schematic')
 source=host/'tools/dev/mcp_ui.py';spec=importlib.util.spec_from_file_location('wave_ui_packager',source);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 html,manifest=module.render_document(stage,'waveforms');assert manifest['entry_present'];assert manifest['module_count']>=5
 (out/'waveforms.html').write_bytes(html);manifest['host_inputs']=inputs+[{'path':str(source),'sha256':sha(source)}];manifest['native_host_mount_verified']=False
 if a.schematic_code:
  schematic_html,schematic_manifest=module.render_document(stage,'schematic');(out/'schematic.html').write_bytes(schematic_html);(out/'schematic-package-report.json').write_text(json.dumps(schematic_manifest,indent=2)+'\n')
 (out/'package-report.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
