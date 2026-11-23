"""Official ClientSession against real stdio subprocesses; engineering data is synthetic."""
import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'apps/mcp'), str(ROOT/'apps/codex'), str(ROOT/'modules/gateway_client')]
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client
from server import SDK_PIN, require_sdk
from icwb.elicitation import tools as review_tools
from icwb.service import tools as core_tools
from icwb.view_contracts import RESOURCES, tools as view_tools
from icwb.plugin_runtime import PluginRuntime


def wire(model):
    return model.model_dump(by_alias=True, exclude_none=True, exclude_unset=True)


class StdioTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.count = 0

    def tearDown(self): self.temp.cleanup()

    @asynccontextmanager
    async def client(self, callback=None, timeout=1.5, command=None):
        self.count += 1
        state = self.root/str(self.count)
        args = command if command is not None else [str(ROOT/'tests/mcp/synthetic_server.py'), '--state', str(state), '--review-timeout', str(timeout)]
        with (self.root/(str(self.count)+'.stderr')).open('w+') as log, self.assertNoLogs('mcp.client.stdio',level='ERROR'):
            async with stdio_client(StdioServerParameters(command=sys.executable, args=['-B',*args]),errlog=log) as streams:
                async with ClientSession(*streams, elicitation_callback=callback, read_timeout_seconds=5) as session:
                    initialized = await session.initialize()
                    self.assertEqual(initialized.server_info.name, 'ic-workbench-portable')
                    yield session, initialized

    async def prepared(self, session):
        result = await session.call_tool('ic_sim_submit', {'project_id':'demo','configuration':'tran',
                        'source_commit':'a'*40,'idempotency_key':'SYNTHETIC-protocol-key'})
        self.assertFalse(result.is_error)
        receipt = result.structured_content['data']
        self.assertEqual(receipt['state'], 'pending_approval')
        return {key: receipt[key] for key in ('request_id','fingerprint')}

    async def test_official_handshake_catalog_resources_metadata_and_real_calls(self):
        require_sdk()
        async with self.client() as (session, init):
            self.assertEqual(init.protocol_version, '2025-11-25')
            self.assertIsNone(init.capabilities.prompts)
            result = await session.list_tools()
            expected = core_tools()+view_tools()+review_tools()+PluginRuntime.tools(None)
            self.assertEqual([wire(t) for t in result.tools], expected)
            names={tool.name for tool in result.tools}
            self.assertTrue({'ic_sim_runtime','ic_sim_execute'} <= names)
            self.assertFalse({'ic_library_read','ic_library_execute'} & names)
            self.assertEqual(len(names),len(result.tools))
            status = await session.call_tool('ic_plugin_status', {})
            self.assertEqual(status.structured_content['data']['ensures'],0)
            resources = await session.list_resources()
            self.assertEqual({str(r.uri) for r in resources.resources},set(RESOURCES.values()))
            for item in resources.resources:
                self.assertEqual(item.mime_type,'text/html;profile=mcp-app')
                self.assertIn('ui',wire(item)['_meta'])
                contents = await session.read_resource(item.uri)
                self.assertIn('SYNTHETIC',contents.contents[0].text)
                self.assertEqual(wire(contents)['contents'][0]['_meta'],wire(item)['_meta'])
            status = await session.call_tool('ic_plugin_status', {})
            self.assertEqual(status.structured_content['data']['ensures'],0)
            projects = await session.call_tool('ic_projects', {})
            self.assertEqual(projects.structured_content['data']['projects'][0]['id'],'demo')
            status = await session.call_tool('ic_plugin_status', {})
            self.assertEqual(status.structured_content['data']['ensures'],1)
            opened = await session.call_tool('ic_workbench_open',{'project_id':'demo','configuration':'tran','run_id':'saved-run'})
            view = opened.structured_content['data']
            self.assertEqual(view['kind'],'workbench')
            self.assertEqual(view['identity']['source_commit'],'a'*40)
            self.assertEqual(view['workbench_run_id'],'saved-run')
            waveform = await session.call_tool('ic_waveforms_open',{'project_id':'demo','run_id':'saved-run','workspace_id':view['workspace_id']})
            wave = waveform.structured_content['data']
            data = await session.call_tool('ic_view_data',{'workspace_id':wave['workspace_id'],'view_id':wave['view_id'],'revision':wave['revision'],'query':{'kind':'signals'}})
            self.assertNotIn('sig-1',data.content[0].text)
            self.assertEqual(wire(data)['_meta']['icWorkbench']['data']['payload']['signals'][0]['id'],'sig-1')

    async def test_no_callback_leaves_review_pending(self):
        async with self.client() as (session,_):
            args=await self.prepared(session)
            result=await session.call_tool('ic_request_review',args)
            self.assertEqual(result.structured_content['data']['review_status'],'unsupported')
            self.assertEqual(result.structured_content['data']['request']['state'],'pending_approval')

    async def test_cancel_false_and_synthetic_approval_use_existing_review_semantics(self):
        for action,content,status,state in [('cancel',None,'cancelled','pending_approval'),
                 ('accept',{'approve':False},'not_approved','pending_approval'),
                 ('decline',None,'denied','denied'),('accept',{'approve':True},'approved','accepted')]:
            seen=[]
            async def callback(ctx,params):
                seen.append(wire(params))
                return types.ElicitResult(action=action,content=content)
            async with self.client(callback) as (session,_):
                args=await self.prepared(session)
                result=await session.call_tool('ic_request_review',args)
                data=result.structured_content['data']
                self.assertEqual(data['review_status'],status)
                self.assertEqual(data['request']['state'],state)
                self.assertEqual(len(seen),1)
                self.assertEqual(seen[0]['requestedSchema']['properties']['approve']['default'],False)
                self.assertIn(args['fingerprint'],seen[0]['message'])
                self.assertIn('SYNTHETIC REVIEW',seen[0]['message'])
                if state in ('denied','accepted'):
                    repeated=await session.call_tool('ic_request_review',args)
                    self.assertEqual(repeated.structured_content['data']['review_status'],'already_resolved')
                    self.assertEqual(len(seen),1)

    async def test_review_timeout_and_concurrent_read_stay_responsive(self):
        waiting=asyncio.Event()
        async def callback(ctx,params):
            waiting.set()
            await asyncio.sleep(10)
            return types.ElicitResult(action='accept',content={'approve':True})
        async with self.client(callback,timeout=0.35) as (session,_):
            args=await self.prepared(session)
            task=asyncio.create_task(session.call_tool('ic_request_review',args))
            await asyncio.wait_for(waiting.wait(),2)
            await asyncio.wait_for(session.send_ping(),1)
            busy=await session.call_tool('ic_request_review',args)
            self.assertEqual(busy.structured_content['error']['code'],'review_in_progress')
            listed=await session.list_resources();self.assertEqual(len(listed.resources),4)
            result=await task
            self.assertEqual(result.structured_content['data']['review_status'],'timeout')
            self.assertEqual(result.structured_content['data']['request']['state'],'pending_approval')
            projects=await session.call_tool('ic_projects',{})
            self.assertEqual(projects.structured_content['data']['synthetic_resolution_count'],0)

    async def test_extra_model_flags_rejected_without_host_prompt(self):
        seen=[]
        async def callback(ctx,params):
            seen.append(params)
            return types.ElicitResult(action='cancel')
        async with self.client(callback) as (session,_):
            args=await self.prepared(session)
            for field in ['approve','confirmed','decision']:
                result=await session.call_tool('ic_request_review',{**args,field:True})
                self.assertTrue(result.is_error)
            self.assertEqual(seen,[])
            result=await session.call_tool('ic_request_status',{'request_id':args['request_id']})
            self.assertEqual(result.structured_content['data']['state'],'pending_approval')

    async def test_real_entry_config_and_settings_initialize_without_gateway(self):
        config=self.root/'client.json'
        config.write_text(json.dumps({'gateway_url':'http://127.0.0.1:1','state_dir':str(self.root/'client-state')}))
        settings=self.root/'missing-settings.json'
        for flag,path in [('--config',config),('--settings',settings)]:
            async with self.client(command=[str(ROOT/'apps/mcp/server.py'),flag,str(path)]) as (session,_):
                listed=(await session.list_tools()).tools
                expected=core_tools()+view_tools()+review_tools()+(PluginRuntime.tools(None) if flag=='--settings' else [])
                self.assertEqual([wire(tool) for tool in listed],expected)
                self.assertFalse({'ic_library_read','ic_library_execute'} & {tool.name for tool in listed})
                self.assertEqual(len((await session.list_resources()).resources),4)
                if flag=='--settings':
                    status=await session.call_tool('ic_plugin_status',{})
                    self.assertEqual(status.structured_content['data']['state'],'setup_required')


if __name__=='__main__': unittest.main(verbosity=2)
