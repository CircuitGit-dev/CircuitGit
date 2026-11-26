import json
import contextlib
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/workbench'))
import connect_browser


class HelperTests(unittest.TestCase):
    def test_normal_helper_enables_an_isolated_intake_store_and_retains_chat(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();state=root/'helper'
            cfg={'runtime_root':str(root/'engineering'),'site_file':'existing-site',
                 'projects':[{'id':'existing'}]}
            app=Mock(onboarding=Mock(enabled=True,connection_id='a'*32))
            browser=Mock(server_port=31867);gateway=Mock(server_port=31866);thread=Mock()
            browser.serve_forever.side_effect=KeyboardInterrupt()
            routes=Mock()
            with (patch.object(sys,'argv',['connect_browser','--state-dir',str(state),'--no-browser']),
                  patch.object(connect_browser,'ROOT',root),
                  patch.object(connect_browser,'configuration',return_value=cfg),
                  patch.object(connect_browser,'library_runtime_configuration',side_effect=lambda cfg,*args:cfg),
                  patch.object(connect_browser,'library_configuration',return_value={}),
                  patch.object(connect_browser,'Server',return_value=browser),
                  patch('server.Server',return_value=gateway),
                  patch('server.Application',return_value=app) as application,
                  patch.object(connect_browser.threading,'Thread',return_value=thread),
                  patch.object(connect_browser,'Service'),
                  patch.object(connect_browser,'AiRoutes',return_value=routes),
                  patch.object(connect_browser,'LocalLogin'),
                  patch.object(connect_browser,'LocalDevelopment'),
                  patch.object(connect_browser.signal,'signal'),
                  patch.object(connect_browser.webbrowser,'open') as open_browser,
                  contextlib.redirect_stdout(io.StringIO())):
                connect_browser.main()
            installed=application.call_args.args[0]
            self.assertEqual(installed['projects'],cfg['projects'])
            self.assertEqual(installed['site_file'],'existing-site')
            self.assertTrue(installed['onboarding']['enabled'])
            self.assertEqual(installed['onboarding']['state_root'],str(root/'engineering/onboarding/intake-store'))
            self.assertIs(browser.node.onboarding,app.onboarding)
            self.assertIs(browser.node.routes,routes)
            self.assertTrue(browser.node.info()['capabilities']['chat'])
            self.assertEqual(browser.node.info()['connection_id'],'a'*32)
            self.assertNotEqual(browser.node.node_id,'a'*32)
            thread.start.assert_called_once();thread.join.assert_called_once_with(timeout=5)
            gateway.shutdown.assert_called_once();app.onboarding.close.assert_called_once()
            routes.close.assert_called_once();open_browser.assert_not_called()

    def test_explicit_fresh_flag_keeps_the_separate_chatless_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory)/'fresh'
            with (patch.object(sys,'argv',['connect_browser','--fresh-onboarding','--state-dir',str(state),'--no-browser']),
                  patch('onboarding_server.serve_onboarding') as serve,
                  patch.object(connect_browser,'configuration') as configuration,
                  patch.object(connect_browser,'AiRoutes') as routes):
                connect_browser.main()
            serve.assert_called_once_with(state,root=connect_browser.ROOT,node_port=8767,gateway_port=0,
                allow_origins=[],resume=False,no_browser=True)
            configuration.assert_not_called();routes.assert_not_called()

    def test_existing_gateway_helper_uses_finite_proxy_without_opening_legacy_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory)/'helper';browser=Mock(server_port=31867)
            browser.serve_forever.side_effect=KeyboardInterrupt()
            routes=Mock()
            with (patch.object(sys,'argv',['connect_browser','--gateway-url','http://127.0.0.1:31866',
                                          '--state-dir',str(state),'--no-browser']),
                  patch.object(connect_browser,'configuration') as configuration,
                  patch.object(connect_browser,'library_configuration',return_value={}),
                  patch.object(connect_browser,'Server',return_value=browser),
                  patch('server.Application') as application,
                  patch.object(connect_browser,'Service') as service,
                  patch.object(connect_browser,'AiRoutes',return_value=routes),
                  patch.object(connect_browser,'LocalLogin'),
                  patch.object(connect_browser,'LocalDevelopment'),
                  patch.object(connect_browser.signal,'signal'),
                  contextlib.redirect_stdout(io.StringIO())):
                connect_browser.main()
            self.assertIsInstance(browser.node.onboarding,connect_browser.GatewayOnboarding)
            self.assertIs(browser.node.onboarding.gateway,routes.service.gateway)
            self.assertIs(browser.node.routes,routes)
            self.assertEqual(service.call_args.args[0]['gateway_url'],'http://127.0.0.1:31866')
            configuration.assert_not_called();application.assert_not_called()
            routes.service.gateway.request.assert_not_called()

    def test_git_library_configures_committed_sources_and_preserves_operator_projects(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()/'repository';root.mkdir()
            (root/'.git').mkdir();(root/'config').mkdir()
            (root/'config/workbench.projects.json').write_text(json.dumps([{'id':'rc','name':'installed'}, {'id':'adc','name':'ADC'}]))
            cfg={'github_repo':'fixture/repo','seed_repo':str(root),'site_file':'owner-site','projects':[{'id':'rc','name':'custom'}]}
            result=subprocess.CompletedProcess([],0,'https://github.com/fixture/repo.git\n','')
            with patch.object(connect_browser.subprocess,'run',return_value=result):
                value=connect_browser.library_runtime_configuration(cfg,root,root/'.local/helper')
                self.assertEqual(value['source_repository'],str(root))
                self.assertEqual(value['projects'],[{'id':'rc','name':'custom'},{'id':'adc','name':'ADC'}])
                self.assertEqual(value['site_file'],'owner-site')
                self.assertNotIn('source_repository',cfg)
                self.assertEqual(connect_browser.library_runtime_configuration({**cfg,'github_repo':'other/repo'},root,root/'.local/helper')['projects'],cfg['projects'])
                self.assertNotIn('source_repository',connect_browser.library_runtime_configuration({**cfg,'seed_repo':str(root/'other')},root,root/'.local/helper'))

    def test_library_runtime_configuration_skips_projects_missing_from_existing_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()/'repository';root.mkdir()
            (root/'.git').mkdir();(root/'config').mkdir()
            (root/'config/workbench.projects.json').write_text(json.dumps([
                {'id':'rc','name':'RC','source_path':'projects/rc/circuit.scs'},
                {'id':'present','name':'Present','source_path':'lib/a/c1/c1.scs'},
                {'id':'missing','name':'Missing','source_path':'lib/a/c2/c2.scs'},
            ]))
            runtime_root=root/'.local/helper/engineering'
            present_file=runtime_root/'workspace/lib/a/c1/c1.scs'
            present_file.parent.mkdir(parents=True)
            present_file.write_text('// present\n')
            cfg={'github_repo':'fixture/repo','seed_repo':str(root),'runtime_root':str(runtime_root),
                 'site_file':'owner-site','projects':[{'id':'rc','name':'custom','source_path':'projects/rc/circuit.scs'}]}
            result=subprocess.CompletedProcess([],0,'https://github.com/fixture/repo.git\n','')
            with patch.object(connect_browser.subprocess,'run',return_value=result):
                value=connect_browser.library_runtime_configuration(cfg,root,root/'.local/helper')
            self.assertEqual([p['id'] for p in value['projects']],['rc','present'])

    def test_downloaded_zip_initializes_private_example_without_modifying_the_app(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()/'downloaded app';root.mkdir()
            shutil.copytree(ROOT/'config',root/'config',ignore=shutil.ignore_patterns('*.local.json'))
            shutil.copytree(ROOT/'projects',root/'projects')
            state=root/'.local/helper'
            with patch.object(connect_browser,'ROOT',root):
                cfg=connect_browser.configuration(state)
                self.assertFalse((root/'.git').exists())
                self.assertEqual(Path(cfg['seed_repo']),state/'example-seed')
                self.assertEqual(subprocess.check_output(['git','-C',cfg['seed_repo'],'branch','--show-current'],text=True).strip(),'main')
                source=root/'projects/rc-smoke/circuit.scs'
                self.assertEqual(source.read_bytes(),(Path(cfg['seed_repo'])/'projects/rc-smoke/circuit.scs').read_bytes())
                before=(state/'workbench.local.json').read_bytes()
                self.assertEqual(connect_browser.configuration(state),cfg)
                self.assertEqual((state/'workbench.local.json').read_bytes(),before)
                self.assertNotIn('ai_client_config',cfg)

if __name__=='__main__':unittest.main()
