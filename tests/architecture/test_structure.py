"""Application packaging and entrypoint compatibility; no model/EDA/network calls."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/dev'))
import build
from check_structure import check

class StructureTests(unittest.TestCase):
    def test_optional_mcp_package_reuses_service_without_engineering_or_venv(self):
        payload=build.mcp_payload()
        self.assertIn('server.py',payload)
        self.assertIn('backend/icwb/service.py',payload)
        self.assertIn('backend/lib/ic_gateway/service.py',payload)
        self.assertIn('backend/gateway/server.py',payload)
        self.assertEqual(payload['backend/lib/ic_gateway/service.py'],
                         (ROOT/'modules/gateway_client/ic_gateway/service.py').read_bytes())
        for name in payload:
            self.assertFalse(any(part in ('.venv','state','runs','projects','design','results','submodules','.git') for part in Path(name).parts))
            self.assertFalse(name.endswith('.local.json'))

    def test_shared_dependencies_and_contract_drift(self):
        self.assertEqual(check()['status'],'passed')

    def test_generated_web_routes_and_assets_are_deterministic(self):
        first=build.web_payload();second=build.web_payload()
        self.assertEqual(first,second)
        for path in ['index.html','vendor/rnl-viewer/index.html','studio/plot/window.html',
                     'waveforms/panel.js','modules/waveforms/panel.js','studio/help.js']:
            self.assertIn(path,first)
        self.assertIn(b'manualSignals:true',first['studio/plot/window.js'])
        self.assertIn(b"../modules/waveforms/panel.js",first['waveforms/panel.js'])
        self.assertNotIn(b'waveformAPI',first['modules/waveforms/panel.js'])
        self.assertIn('modules/workspace/context.js',first)
        manifest=json.loads(first['asset-manifest.json'])
        for row in manifest['files']:self.assertEqual(build.sha(first[row['path']]),row['sha256'])
        self.assertFalse(any(row['source'].startswith('submodules/') for row in manifest['files']))
        self.assertFalse(any(name.startswith('submodules/') or name=='.gitmodules' for name in first))

    def test_build_refuses_unmanaged_destination_and_preserves_user_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'existing';p.mkdir();(p/'my-file').write_text('keep')
            with self.assertRaises(ValueError):build.build('web',p)
            self.assertEqual((p/'my-file').read_text(),'keep')

    def test_plugin_is_standalone_and_protocol_matches_source_and_legacy(self):
        with tempfile.TemporaryDirectory(prefix='ic standalone plugin ') as tmp:
            folder=Path(tmp)/'plugin';build.build('codex',folder)
            schema=[]
            for script in [ROOT/'apps/codex/ic_workbench.py',ROOT/'tools/ai/ic_workbench.py',folder/'ic_workbench.py']:
                run=subprocess.run([sys.executable,'-B',str(script),'--json','schema'],cwd=tmp,capture_output=True,text=True)
                self.assertEqual(run.returncode,0,run.stderr)
                schema.append(json.loads(run.stdout))
            self.assertEqual(schema[0],schema[1]);self.assertEqual(schema[0],schema[2])
            for private in ['projects','design','results','config','runs','submodules','.git']:
                self.assertFalse((folder/private).exists())
            conf=Path(tmp)/'client.json'
            conf.write_text(json.dumps({'gateway_url':'http://127.0.0.1:1','state_dir':str(Path(tmp)/'state')}))
            requests=[
                {'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18'}},
                {'jsonrpc':'2.0','method':'notifications/initialized'},
                {'jsonrpc':'2.0','id':2,'method':'tools/list'},
                {'jsonrpc':'2.0','id':3,'method':'ping'},
                {'jsonrpc':'2.0','id':4,'method':'resources/list'}]
            run=subprocess.run([sys.executable,'-B',str(folder/'ic_workbench.py'),'--config',str(conf),'mcp'],
                input=''.join(json.dumps(r)+'\n' for r in requests),capture_output=True,text=True,cwd=tmp)
            self.assertEqual(run.returncode,0,run.stderr)
            replies=[json.loads(line) for line in run.stdout.splitlines()]
            tools=next(r['result']['tools'] for r in replies if r['id']==2)
            core=schema[0]['data']['tools']
            core_names={tool['name'] for tool in core}
            self.assertEqual([tool for tool in tools if tool['name'] in core_names],core)
            self.assertEqual(len({tool['name'] for tool in tools}),len(tools))
            for kind in ('schematic','waveforms','simulation','workbench'):
                tool=next(tool for tool in tools if tool['name']=='ic_'+kind+'_open')
                self.assertEqual(tool['_meta']['ui']['resourceUri'],'ui://ic-workbench/'+kind+'.html')
            resources=next(r['result']['resources'] for r in replies if r['id']==4)
            self.assertEqual({r['uri'] for r in resources},{'ui://ic-workbench/'+kind+'.html' for kind in ('schematic','waveforms','simulation','workbench')})
            self.assertFalse(any('approve' in tool['name'] for tool in tools))
            self.assertEqual(next(r['result'] for r in replies if r['id']==3),{})

if __name__=='__main__':unittest.main()
