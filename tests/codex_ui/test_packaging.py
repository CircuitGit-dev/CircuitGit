import base64,json,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/dev'));sys.path.insert(0,str(Path(__file__).parent))
from mcp_ui import render_document,ui_payload
from build_fixtures import fixture_root

class PackagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(prefix='ic-mcp-ui-package-test-');cls.root=fixture_root(cls.tmp.name)
    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()
    def test_three_standalone_resources_and_early_handshake(self):
        payload=ui_payload(self.root)
        self.assertEqual(set(payload),{'ui/'+kind+'.html' for kind in ['schematic','waveforms','simulation','workbench']}|{'ui/manifest.json'})
        for kind in ['schematic','waveforms','simulation','workbench']:
            first,row=render_document(self.root,kind);second,_=render_document(self.root,kind);self.assertEqual(first,second);self.assertTrue(row['entry_present'])
            self.assertLess(first.index(b"request('ui/initialize'"),first.index(b'id="ic-bundle"'))
            self.assertNotIn(b'http://127.0.0.1:8766',first);self.assertNotIn(b'X-Workbench-Token',first)
            start=first.index(b'type="application/octet-stream">')+len(b'type="application/octet-stream">');bundle=json.loads(base64.b64decode(first[start:first.index(b'</script>',start)]))
            if kind in ('schematic','workbench'):
                wasm=bundle['assets']['apps/web/vendor/rnl-viewer/core/rnl_runtime_wasm.wasm'];self.assertEqual(base64.b64decode(wasm['data'])[:4],b'\0asm')
                self.assertIn('apps/web/vendor/rnl-viewer/core/packages.js',bundle['modules'])
                self.assertIn('apps/web/vendor/rnl-viewer/fonts/fonts.css',bundle['assets'])
            self.assertFalse(any(path.startswith(('config/','projects/','results/','design/','sim/')) for path in bundle['assets']))
    def test_missing_component_is_explicit_not_fake_mounted(self):
        entry=self.root/'apps/codex/ui/waveforms/index.js';saved=entry.read_bytes();entry.unlink()
        try:
            html,row=render_document(self.root,'waveforms');self.assertFalse(row['entry_present']);self.assertIn(b'component is not installed',html)
        finally:entry.write_bytes(saved)
    def test_import_outside_registered_roots_fails_closed(self):
        entry=self.root/'apps/codex/ui/simulation/index.js';saved=entry.read_bytes();entry.write_text("import '/private/config/token.js';")
        try:
            with self.assertRaisesRegex(ValueError,'relative packaged imports'):render_document(self.root,'simulation')
        finally:entry.write_bytes(saved)
    def test_cycles_use_import_map_instead_of_recursive_inline_modules(self):
        directory=self.root/'apps/codex/ui/simulation';entry=directory/'index.js';saved=entry.read_bytes();entry.write_text("import {b} from './cycle.js';export function mount(){return {dispose(){}}};export const a=1;")
        (directory/'cycle.js').write_text("import {a} from './index.js';export function b(){return a}")
        try:
            _,row=render_document(self.root,'simulation');self.assertEqual(row['module_count'],2)
        finally:entry.write_bytes(saved);(directory/'cycle.js').unlink()

if __name__=='__main__':unittest.main()
