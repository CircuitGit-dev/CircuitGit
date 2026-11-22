"""Plugin lifecycle tests with isolated local-only fixtures. No model/SSH/solver."""
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch,Mock

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/codex'),str(ROOT/'tools/dev')]
from icwb.plugin_runtime import PluginRuntime
from icwb.service import Failure
import build


def write(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data)+'\n')


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ic-plugin-runtime-')
        self.root=Path(self.temp.name);self.pid=None;self.listener=None;self.process=None
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));self.port=sock.getsockname()[1]
        self.seed=self.root/'seed';self.seed.mkdir()
        subprocess.run(['git','init','-b','main',str(self.seed)],check=True,capture_output=True)
        self.git('config','user.name','Fixture');self.git('config','user.email','fixture@localhost')
        p=self.seed/'projects/demo/circuit.scs';p.parent.mkdir(parents=True);p.write_text('simulator lang=spectre\nR0 (x 0) resistor r=1k\n')
        write(self.seed/'projects/demo/config.json',{})
        self.git('add','.');self.git('commit','-m','fixture')
        site={'schema':'ic.sim.site.v1','ssh_target':'unused','remote_runs_root':'/unused/ic_on_github_runs',
              'cadence_cshrc':'/unused/setup','spectre_bin':'/unused/spectre','external_files':{}}
        write(self.root/'site.json',site)
        self.cfg={'github_repo':'fixture/ic','seed_repo':str(self.seed),'runtime_root':str(self.root/'gateway'),
          'site_file':str(self.root/'site.json'),'base_branch':'main','runtime_branch':'codex/plugin-test',
          'projects':[{'id':'demo','source_path':'projects/demo/circuit.scs','configurations':[{'id':'tran',
            'configuration_path':'projects/demo/config.json','bundle_template':'sim/demo/bundle.json'}]}],
          'ai_client_config':'/must-not-be-loaded/model.json'}
        write(self.root/'workbench.json',self.cfg)
        (self.seed/'web').mkdir();(self.seed/'web/index.html').write_text('fixture')
        self.settings={'schema':'ic.plugin.settings.v1','gateway_url':'http://127.0.0.1:'+str(self.port),
          'state_dir':str(self.root/'state'),'workbench_config':str(self.root/'workbench.json')}
        self.path=self.root/'settings.json';write(self.path,self.settings)

    def git(self,*args):
        return subprocess.check_output(['git','-C',str(self.seed),*args],text=True,stderr=subprocess.DEVNULL).strip()

    def tearDown(self):
        if self.process:
            self.process.terminate();self.process.wait(timeout=5);self.pid=None
        if self.pid:
            try:os.kill(self.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            deadline=time.monotonic()+3
            while time.monotonic()<deadline:
                try:
                    found,status=os.waitpid(self.pid,os.WNOHANG)
                    if found:break
                except ChildProcessError:break
                time.sleep(.05)
        if self.listener:self.listener.shutdown();self.listener.server_close()
        self.temp.cleanup()

    def test_catalog_without_settings_does_not_start_anything(self):
        runtime=PluginRuntime(self.root/'missing.json')
        with patch('subprocess.Popen',side_effect=AssertionError('no process')):
            self.assertEqual(runtime.status()['state'],'setup_required')
            self.assertEqual(len(runtime.tools()),2)
            with self.assertRaises(Failure):runtime.ensure()

    def test_hostile_settings_cannot_inject_a_command_or_remote_url(self):
        for change in [{'command':'touch /tmp/not-allowed'},{'gateway_url':'https://example.com'},{'state_dir':'relative'}]:
            write(self.path,{**self.settings,**change});runtime=PluginRuntime(self.path)
            self.assertEqual(runtime.status()['state'],'setup_required')
        runtime=PluginRuntime(self.path)
        with self.assertRaises(Failure):runtime.call('ic_plugin_connect',{'path':'/arbitrary'})

    def test_cold_start_bundled_gateway_and_second_connection_reuses(self):
        package=self.root/'plugin';build.build('codex',package)
        # Execute packaged code; source/engineering directory scripts are irrelevant.
        runtime=PluginRuntime(self.path)
        with patch.object(runtime,'gateway_root',return_value=package/'gateway'):
            self.assertEqual(runtime.status()['state'],'ready_to_start')
            result=runtime.ensure();self.assertTrue(result['gateway_started'])
            self.process=runtime._owned_process
            record=json.loads((runtime.control/'startup.json').read_text());self.pid=record['pid']
            self.assertEqual(record['state'],'ready')
            second=PluginRuntime(self.path)
            with patch('subprocess.Popen',side_effect=AssertionError('duplicate gateway launch')):
                again=second.ensure();self.assertFalse(again['gateway_started'])
            self.assertEqual(second.status()['state'],'connected')
            saved=json.loads((runtime.control/'gateway.local.json').read_text())
            self.assertNotIn('ai_client_config',saved)
            self.assertEqual(json.loads((self.root/'workbench.json').read_text()),self.cfg)
            self.assertEqual(self.git('rev-parse','HEAD'),subprocess.check_output(['git','-C',str(self.root/'gateway/workspace'),'rev-parse','HEAD'],text=True).strip())
            self.assertFalse(list((self.root/'gateway/runs').glob('*/run.json')))

    def test_unrelated_listener_is_never_replaced(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):self.send_response(404);self.end_headers()
            def log_message(self,*args):pass
        self.listener=http.server.ThreadingHTTPServer(('127.0.0.1',self.port),Handler)
        thread=threading.Thread(target=self.listener.serve_forever,daemon=True);thread.start()
        runtime=PluginRuntime(self.path)
        with patch('subprocess.Popen',side_effect=AssertionError('must not replace listener')):
            with self.assertRaises(Failure) as caught:runtime.ensure()
            self.assertEqual(caught.exception.code,'gateway_conflict')
        self.assertEqual(runtime.status()['state'],'suspended')

    def test_failed_start_stops_automatic_launch_retries(self):
        runtime=PluginRuntime(self.path);process=Mock(pid=123,poll=Mock(return_value=1))
        with patch('subprocess.Popen',return_value=process) as start:
            with self.assertRaises(Failure):runtime.ensure()
            with self.assertRaises(Failure) as caught:runtime.ensure()
            self.assertEqual(caught.exception.code,'startup_suspended');self.assertEqual(start.call_count,1)
            self.assertEqual(runtime.status()['state'],'suspended')


if __name__=='__main__':unittest.main(verbosity=2)
