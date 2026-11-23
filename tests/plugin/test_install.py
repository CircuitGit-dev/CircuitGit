"""Guard the real CLI's config normalization without touching user settings."""
import sys
import tomllib
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'tools/dev'))
from install_local_plugin import migrated_config,configure_manifest,discovered_server,NAME,PLUGIN

BEFORE=b'''# Keep the user's comment and spacing.
approval_policy = "on-request"
[mcp_servers.node_repl]
command = "node"
args = []

[mcp_servers.ic-workbench]
command = "python"
args = ["entry.py"]
disabled_tools = ["ic_sim_submit"]

[projects."/my/project"]
trust_level = "trusted"
'''
ADDED=('\n[marketplaces.'+NAME+']\nsource_type="local"\nsource="/fixture/marketplace"\n'
       '[plugins."'+PLUGIN+'"]\nenabled=true\n').encode()


class InstallTests(unittest.TestCase):
    def test_manifest_keeps_portable_command_and_only_pins_settings(self):
        source={'mcpServers':{'ic-workbench':{'type':'stdio','command':'python3'}}}
        result=configure_manifest(source,Path('/fixture/settings.json'))
        self.assertEqual(result['mcpServers']['ic-workbench']['command'],'python3')
        self.assertEqual(result['mcpServers']['ic-workbench']['args'][-1],'/fixture/settings.json')
        self.assertNotIn('args',source['mcpServers']['ic-workbench'])
        source['mcpServers']['ic-workbench']['command']='/usr/bin/python3'
        with self.assertRaisesRegex(ValueError,'portable'):configure_manifest(source,Path('/fixture/settings.json'))

    def test_installation_requires_codex_to_discover_its_actual_cached_server(self):
        with self.assertRaisesRegex(RuntimeError,'incomplete'):discovered_server([],Path('/cache/plugin'))
        row={'name':'ic-workbench','enabled':True,'transport':{'cwd':'/cache/plugin'}}
        self.assertEqual(discovered_server([row],Path('/cache/plugin')),row)
        with self.assertRaisesRegex(RuntimeError,'different'):discovered_server([row],Path('/somewhere/else'))

    def test_upgrade_preserves_exact_settings_and_stops_on_unrelated_changes(self):
        before=BEFORE+ADDED
        self.assertEqual(migrated_config(before,before.replace(b'args = []\n',b''),upgrade=True),before.decode())
        with self.assertRaisesRegex(RuntimeError,'Unrelated'):
            migrated_config(before,before.replace(b'on-request',b'never'),upgrade=True)

    def test_cli_empty_array_normalization_preserves_original_bytes_and_policy(self):
        after=BEFORE.replace(b'args = []\n',b'')+ADDED
        output=migrated_config(BEFORE,after)
        self.assertTrue(output.startswith('# Keep the user\'s comment and spacing.\n'))
        self.assertIn('command = "node"\nargs = []\n',output)
        config=tomllib.loads(output)
        self.assertEqual(config['approval_policy'],'on-request')
        self.assertNotIn('ic-workbench',config['mcp_servers'])
        policy=config['plugins'][PLUGIN]['mcp_servers']['ic-workbench']
        self.assertEqual(policy,{'disabled_tools':['ic_sim_submit'],'tool_timeout_sec':360})

    def test_unrelated_setting_changes_are_rejected(self):
        after=BEFORE.replace(b'on-request',b'never')+ADDED
        with self.assertRaisesRegex(RuntimeError,'Unrelated'):migrated_config(BEFORE,after)

    def test_nested_direct_server_configuration_is_not_silently_lost(self):
        before=BEFORE+b'\n[mcp_servers.ic-workbench.env]\nFLAG="value"\n'
        with self.assertRaisesRegex(RuntimeError,'Final configuration'):migrated_config(before,before+ADDED)

    def test_disabled_install_does_not_remove_working_connection(self):
        with self.assertRaisesRegex(RuntimeError,'enabled local plugin'):
            migrated_config(BEFORE,BEFORE+ADDED.replace(b'enabled=true',b'enabled=false'))


if __name__=='__main__':unittest.main(verbosity=2)
