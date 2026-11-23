"""Validate the public-only inverter starting point without model/site access."""
import hashlib
import json
from pathlib import Path
import re
import runpy
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/library'))
sys.path.insert(0,str(ROOT/'tools/workbench'))
import import_basics
import import_adc
import library_sources

BASE='lib/basics/cmos-inverter'
ENTRY=BASE+'/schematic/cmos-inverter.scs'
sha=lambda raw:hashlib.sha256(raw).hexdigest()


def instance_bytes(raw,name):
    text=raw.decode();match=re.search(r'(?m)^    '+re.escape(name)+r'\s',text)
    if not match:raise ValueError('Missing selected instance '+name)
    result=[]
    for line in text[match.start():].splitlines(keepends=True):
        result.append(line)
        if not line.rstrip().endswith('\\'):break
    return ''.join(result).encode()


class InverterExampleTests(unittest.TestCase):
    def setUp(self):
        self.raw=(ROOT/ENTRY).read_bytes()
        self.provenance=json.loads((ROOT/BASE/'docs/provenance.json').read_text())
        manifest=json.loads((ROOT/'lib/basics/library.json').read_text())
        self.cell=next(c for c in manifest['cells'] if c['id']=='cmos-inverter')

    def test_exact_two_device_statements_and_original_terminal_order(self):
        source=(ROOT/self.provenance['source_path']).read_bytes()
        self.assertEqual(sha(source),self.provenance['source_sha256'])
        blocks=library_sources.electrical_blocks(self.raw)
        self.assertEqual(set(blocks),{'CMOS_INVERTER'})
        block=blocks['CMOS_INVERTER'];self.assertEqual(block.ports,('CLK','CLKN','VDD','VSS'))
        self.assertEqual(len(block.statements),4)
        self.assertTrue(block.statements[1].startswith('M9 (CLKN CLK VSS VSS) nch_ulvt_mac '))
        self.assertTrue(block.statements[2].startswith('M10 (CLKN CLK VDD VDD) pch_ulvt_mac '))
        for row in self.provenance['instances']:
            original=instance_bytes(source,row['name']);selected=instance_bytes(self.raw,row['name'])
            self.assertEqual(selected,original);self.assertEqual(sha(selected),row['original_statement_sha256'])

    def test_only_circuit_information_and_declared_public_drawing_dependencies(self):
        code='\n'.join(line for line in self.raw.decode().splitlines() if not line.lstrip().startswith('//'))
        self.assertNotRegex(code,r'(?im)^\s*(?:include|ahdl_include|model|library|section|parameters|tran|dc|ac|save)\b')
        self.assertNotRegex(code,r'\b(?:vsource|isource)\b')
        all_text=self.raw.decode()+json.dumps(self.provenance)
        self.assertNotRegex(all_text,r'/(?:Users|home|server_local_ssd)/|site\.local|\.spiceowl|LLM_for_IC|ssh://|section=')
        self.assertEqual(self.provenance['external_models'],['nch_ulvt_mac','pch_ulvt_mac'])
        for key in ['environment_supplied','testbench_supplied','simulation_performed','native_geometry_reproduction']:
            self.assertFalse(self.provenance[key])
        view=next(v for v in self.cell['views'] if v['id']=='schematic')
        self.assertEqual(set(view['files']),{ENTRY,*(row['path'] for row in self.provenance['drawing_dependencies'])})
        for row in self.provenance['drawing_dependencies']:
            self.assertTrue(row['path'].startswith('lib/_shared/rnl/'))
            self.assertEqual(sha((ROOT/row['path']).read_bytes()),row['sha256'])

    def test_browser_identity_has_no_preconfigured_runtime_or_simulation(self):
        self.assertIsNone(self.cell['project_id']);self.assertTrue(self.cell['requires_external_models'])
        views={v['id']:v for v in self.cell['views']}
        self.assertEqual(views['schematic']['entry'],ENTRY)
        self.assertEqual(views['schematic']['level'],'CMOS_INVERTER')
        self.assertEqual(views['netlist']['entry'],ENTRY)
        self.assertNotIn('simulation',views)
        projects=json.loads((ROOT/'config/workbench.projects.json').read_text())
        self.assertFalse(any(p.get('cell_id')=='cmos-inverter' for p in projects))

    def test_each_source_view_resolves_its_declared_drawing_packages(self):
        closure=runpy.run_path(str(ROOT/'tools/ci/check.py'))['closure']
        for view in self.cell['views']:
            if view['kind'] not in ('rnl','spectre'):
                continue
            with self.subTest(view=view['id']):
                self.assertEqual(closure(ROOT,view['files'],view.get('aliases'),view['entry']),[])
                with self.assertRaisesRegex(ValueError,'Missing include/package'):
                    closure(ROOT,[view['entry']],{},view['entry'])

    def test_rc_refresh_preserves_independent_example_and_library_metadata(self):
        with tempfile.TemporaryDirectory(prefix='inverter-import-') as tmp:
            tmp=Path(tmp).resolve()
            paths=['projects/rc-smoke/circuit.scs','projects/rc-smoke/configurations/TRAN.json',
                   'projects/rc-smoke/template/bundle.json','projects/rc-smoke/project.json',
                   'projects/rc-smoke/template/netlist/input.scs','lib/basics/library.json','tools/library/adc-import-plan.json']
            for name in paths:
                target=tmp/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
            before=json.loads((tmp/'lib/basics/library.json').read_text())
            with patch.object(import_basics,'ROOT',tmp),patch.object(import_adc,'ROOT',tmp),patch.object(sys,'argv',['import_basics.py']),patch('builtins.print'):
                import_basics.main()
            after=json.loads((tmp/'lib/basics/library.json').read_text())
            self.assertEqual(next(c for c in after['cells'] if c['id']=='cmos-inverter'),self.cell)
            self.assertEqual(after['description'],before['description'])
            self.assertEqual(len(after['cells']),2)


if __name__=='__main__':unittest.main()
