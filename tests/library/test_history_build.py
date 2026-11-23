"""Cell history excludes application commits and never emits old source bodies."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('history',ROOT/'tools/dev/build_library_history.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class HistoryTests(unittest.TestCase):
    def test_scope_and_real_history_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            def git(*args):return subprocess.check_output(['git','-C',tmp,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',*args],stderr=subprocess.DEVNULL).decode().strip()
            def write(path,content):p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content)
            git('init','-b','main')
            write('lib/catalog.json',json.dumps({'libraries':[{'id':'one','manifest':'lib/one/library.json'}]}))
            write('lib/one/library.json',json.dumps({'cells':[{'id':'cell','directory':'lib/one/cell','readme':'lib/one/cell/README.md','project_id':None,'views':[{'files':['lib/one/cell/source.scs']}]}]}))
            write('lib/one/cell/README.md','Circuit');write('lib/one/cell/source.scs','R0 a b resistor r=1\n')
            git('add','.');git('commit','-m','Import circuit');initial=git('rev-parse','HEAD')
            write('apps/example.js','application only');git('add','.');git('commit','-m','Change website toolbar')
            write('lib/one/cell/source.scs','R0 a b resistor r=2\n');git('add','.');git('commit','-m','Change resistor');latest=git('rev-parse','HEAD')
            report=module.generate(root);row=report['cells'][0]
            self.assertEqual([r['sha'] for r in row['commits']],[latest,initial])
            self.assertEqual(row['commits'][0]['files'],['lib/one/cell/source.scs'])
            self.assertNotIn('R0 a b',json.dumps(report));self.assertTrue(row['history_complete'])
            output=root/'site';module.publish(root,output)
            self.assertTrue((output/'library-files/lib/history.json').is_file())

if __name__=='__main__':unittest.main()
