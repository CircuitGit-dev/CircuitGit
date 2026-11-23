"""Official SDK wire calls into the real Service with synthetic gateway evidence."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/mcp'),str(ROOT/'tests/ai')]
from server import create_adapter
from test_onboarding_service import FixtureGateway,CONNECTION,INTAKE,PLAN
from ic_gateway.contracts import ONBOARDING_ROUTES
from ic_gateway.service import Service
from icwb.plugin_runtime import PluginRuntime


def fixture(state):
    import anyio
    service=Service({'gateway_url':FixtureGateway.origin,'state_dir':str(state)})
    gateway=FixtureGateway();gateway.lose_reply=True;service.gateway=gateway
    class Lifecycle:
        tool_names={'ic_plugin_status','ic_plugin_connect'}
        def __init__(self):self.count=0
        def tools(self):return PluginRuntime.tools(self)
        def ensure(self):self.count+=1
        def call(self,name,args):
            assert args=={}
            if name=='ic_plugin_connect':self.ensure()
            return {'fixture':True,'ensures':self.count,
                    'run_posts':sum(path.endswith('/run') and body is not None for path,body,_ in gateway.calls)}
    anyio.run(create_adapter(service,lifecycle=Lifecycle()).serve)


class NativeOnboardingSDKTests(unittest.IsolatedAsyncioTestCase):
    async def test_official_stdio_retains_full_sessions_strict_inputs_and_single_dispatch(self):
        from mcp import ClientSession,StdioServerParameters
        from mcp.client.stdio import stdio_client
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with (root/'stderr.log').open('w+') as log:
                params=StdioServerParameters(command=sys.executable,args=['-B',str(Path(__file__).resolve()),'--fixture-state',str(root/'state')])
                async with stdio_client(params,errlog=log) as streams:
                    async with ClientSession(*streams,read_timeout_seconds=5) as session:
                        await session.initialize()
                        listed=await session.list_tools()
                        self.assertTrue({'ic_'+name for name in ONBOARDING_ROUTES}<={tool.name for tool in listed.tools})
                        netlist=await session.call_tool('ic_onboarding_netlist',{'file_name':'synthetic.scs','text':'SYNTHETIC\r\n'})
                        self.assertFalse(netlist.is_error)
                        self.assertIsNone(netlist.structured_content['data']['source_commit'])
                        prepared=await session.call_tool('ic_onboarding_prepare',{'intake_id':INTAKE,'revision':3,
                            'accept_recommendation':True,'intent':{'supply_v':.9}})
                        self.assertFalse(prepared.is_error)
                        self.assertEqual(prepared.structured_content['data']['next_actions'],FixtureGateway().session['next_actions'])
                        invalid=await session.call_tool('ic_onboarding_run',{'intake_id':INTAKE,'revision':True,'plan_id':PLAN})
                        self.assertTrue(invalid.is_error)
                        args={'intake_id':INTAKE,'revision':3,'plan_id':PLAN}
                        lost=await session.call_tool('ic_onboarding_run',args)
                        self.assertTrue(lost.is_error)
                        recovered=await session.call_tool('ic_onboarding_run',args)
                        self.assertFalse(recovered.is_error)
                        data=recovered.structured_content['data']
                        self.assertEqual(data['connection_id'],CONNECTION)
                        self.assertTrue(data['reconciliation_only'])
                        self.assertEqual(data['next_actions'],FixtureGateway().session['next_actions'])
                        self.assertEqual(json.loads(recovered.content[0].text),recovered.structured_content)
                        status=await session.call_tool('ic_plugin_status',{})
                        self.assertEqual(status.structured_content['data']['run_posts'],1)
                        self.assertGreaterEqual(status.structured_content['data']['ensures'],4)


if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--fixture-state':fixture(Path(sys.argv[2]))
    else:unittest.main(verbosity=2)
