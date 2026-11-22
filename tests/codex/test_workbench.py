"""Workbench persistence tests: synthetic services, no live gateway or engineering writes."""
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'apps/codex'), str(ROOT/'modules/gateway_client'), str(Path(__file__).parent)]
from test_views import FakeService
from icwb.service import Failure, canonical
from icwb.views import ViewService, MAX_LAYOUT_BYTES, MAX_SNAPSHOT_BYTES
from icwb.view_contracts import SCHEMAS, RESOURCES, tools, validate
from icwb.mcp import run


def group(view_id, node_id='g1'):
    return {'type': 'group', 'id': node_id, 'tabs': [view_id], 'active': view_id}


def split(first, second, node_id='split1', ratio=0.5):
    return {'type': 'split', 'id': node_id, 'axis': 'horizontal', 'ratio': ratio,
            'first': first, 'second': second}


def panel(view):
    return {'id': view['view_id'], 'kind': view['kind'], 'title': 'SYNTHETIC ' + view['kind']}


def layout(views, tree=None, maximized=None):
    return {'version': 1, 'panels': [panel(v) for v in views], 'tree': tree, 'maximized': maximized}


class WorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.service = FakeService(self.root/'state')
        self.ui = self.root/'ui'; self.ui.mkdir()
        for kind in RESOURCES:
            (self.ui/(kind+'.html')).write_text('<!doctype html>SYNTHETIC ' + kind)
        self.views = ViewService(self.service, self.ui)

    def tearDown(self):
        self.assertTrue(all(body is None for _, body in self.service.gateway.calls))
        self.temp.cleanup()

    def call(self, name, args):
        public, private = self.views.call(name, args)
        return private if private is not None else public

    def open(self, kind='workbench', workspace=None, **args):
        defaults = {'configuration': 'tran'} if kind == 'simulation' else {'run_id': 'saved-run'} if kind == 'waveforms' else {}
        return self.call('ic_' + kind + '_open', {'project_id': 'demo', **defaults, **args,
                         **({'workspace_id': workspace} if workspace else {})})

    def ref(self, view, cas=False):
        return {'workspace_id': view['workspace_id'], 'view_id': view['view_id'],
                **({'expected_revision': view['revision']} if cas else {})}

    def refresh(self, view):
        return self.call('ic_view_get', self.ref(view))

    def data(self, view, kind):
        return self.call('ic_view_data', {**self.ref(view), 'revision': view['revision'], 'query': {'kind': kind}})['payload']

    def store(self, parent, value):
        return self.call('ic_workbench_layout', {**self.ref(parent, True), 'text': canonical(value)})

    def test_entry_current_source_and_separate_historical_run_without_children(self):
        parent = self.open(configuration='tran', run_id='saved-run')
        self.assertEqual(parent['kind'], 'workbench')
        self.assertEqual(parent['identity']['source_commit'], 'a'*40)
        self.assertEqual(parent['identity']['configuration'], 'tran')
        self.assertIsNone(parent['identity']['run_id'])
        self.assertEqual(parent['workbench_run_id'], 'saved-run')
        self.assertEqual(parent['ui']['resource_uri'], 'ui://ic-workbench/workbench.html')
        self.assertIsNone(parent['ui']['mounted'])
        self.assertEqual(self.data(parent, 'layout'), {'text': None, 'views': []})
        self.assertEqual(self.data(parent, 'runs')['jobs'][0]['source_commit'], 'b'*40)
        self.assertEqual(self.data(parent, 'project')['projects'][0]['id'], 'demo')
        self.assertEqual(len(self.call('ic_workspace_get', {'workspace_id': parent['workspace_id']})['views']), 1)
        for query in ('source', 'configuration', 'signals', 'snapshot'):
            with self.assertRaises(Failure): self.data(parent, query)

    def test_open_optional_values_not_inferred_and_bad_identity_no_state_created(self):
        parent = self.open()
        self.assertIsNone(parent['identity']['configuration'])
        self.assertIsNone(parent['workbench_run_id'])
        before = set(self.views.root.glob('w_*.json'))
        for args in [{'configuration': 'unknown'}, {'run_id': 'not-in-project'}, {'project_id': 'foreign'},
                     {'workbench_id': 'v_'+'f'*32}, {'source_commit': 'a'*40}]:
            with self.subTest(args=args), self.assertRaises(Failure): self.open(**args)
        self.assertEqual(set(self.views.root.glob('w_*.json')), before)

    def test_reopen_preserves_layout_identity_revision_and_does_not_touch_gateway(self):
        parent = self.open(configuration='tran', run_id='saved-run')
        child = self.open('schematic', parent['workspace_id'])
        value = layout([child], group(child['view_id']))
        parent = self.store(parent, value)
        self.service.commit = 'f'*40
        with patch.object(self.service, 'project', side_effect=AssertionError('No registry read on reopen')), \
             patch.object(self.service, 'call', side_effect=AssertionError('No source read on reopen')), \
             patch.object(self.service.gateway, 'request', side_effect=AssertionError('No gateway read on reopen')):
            reopened = self.open(workspace=parent['workspace_id'], workbench_id=parent['view_id'])
            self.assertEqual(reopened, parent)
            self.assertEqual(self.data(reopened, 'layout')['text'], canonical(value))
        for args in [{'project_id': 'foreign'}, {'configuration': 'other'}, {'run_id': 'other'}, {'workbench_id': child['view_id']}]:
            with self.subTest(args=args), self.assertRaises(Failure):
                self.open(workspace=parent['workspace_id'], workbench_id=parent['view_id'], **{k:v for k,v in args.items() if k!='workbench_id'}) if 'workbench_id' not in args else self.open(workspace=parent['workspace_id'], **args)
        wrong = self.open()
        with self.assertRaises(Failure): self.open(workspace=wrong['workspace_id'], workbench_id=parent['view_id'])

    def test_layout_closed_panels_restart_and_exact_text_persistence(self):
        parent = self.open()
        a = self.open('schematic', parent['workspace_id'])
        b = self.open('waveforms', parent['workspace_id'])
        c = self.open('simulation', parent['workspace_id'])
        value = layout([a, b, c], split(group(a['view_id']), group(b['view_id'], 'g2')), a['view_id'])
        text = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
        before = {v['view_id']: self.refresh(v) for v in [a,b,c]}
        parent = self.call('ic_workbench_layout', {**self.ref(parent, True), 'text': text})
        self.assertEqual(parent['revision'], 2)
        self.assertNotIn('_layout', parent)
        result = self.data(parent, 'layout')
        self.assertEqual(result['text'], text)
        self.assertEqual({v['view_id'] for v in result['views']}, set(before))
        for v in [a,b,c]:
            after = self.refresh(v)
            self.assertEqual(after['revision'], before[v['view_id']]['revision'])
            self.assertEqual(after['visible'], before[v['view_id']]['visible'])
            self.assertEqual(after['identity'], before[v['view_id']]['identity'])
        parent = self.store(parent, layout([a,b,c]))
        self.views = ViewService(self.service, self.ui)
        reopened = self.open(workspace=parent['workspace_id'], workbench_id=parent['view_id'])
        saved = json.loads(self.data(reopened, 'layout')['text'])
        self.assertIsNone(saved['tree']); self.assertEqual(len(saved['panels']), 3)
        self.store(reopened, value)  # Restore the same child IDs without creation.

    def test_layout_filters_foreign_project_and_all_parent_descriptors(self):
        parent = self.open()
        child = self.open('schematic', parent['workspace_id'])
        other_parent = self.open(workspace=parent['workspace_id'])
        foreign = self.open('simulation', parent['workspace_id'])
        workspace = self.views._load(parent['workspace_id'])
        workspace['views'][foreign['view_id']]['identity']['project_id'] = 'SYNTHETIC-foreign'
        self.views._save(workspace)
        children = self.data(parent, 'layout')['views']
        self.assertEqual([v['view_id'] for v in children], [child['view_id']])
        for candidate in [foreign, parent, other_parent]:
            with self.subTest(candidate=candidate['kind']), self.assertRaises(Failure):
                self.store(parent, layout([candidate]))
        wrong_workspace = self.open('waveforms')
        with self.assertRaises(Failure): self.store(parent, layout([wrong_workspace]))

    def test_layout_rejects_bad_panels_tabs_nodes_and_maximization_atomically(self):
        parent = self.open(); a = self.open('schematic', parent['workspace_id']); b = self.open('waveforms', parent['workspace_id'])
        base = layout([a,b], split(group(a['view_id']), group(b['view_id'], 'g2')))
        edits = [lambda x: x['panels'].append(x['panels'][0]),
                 lambda x: x['panels'][0].update(kind='waveforms'),
                 lambda x: x['panels'][0].update(title='x'*257),
                 lambda x: x['panels'][0].update(id='v_'+'f'*32),
                 lambda x: x['panels'][0].update(unexpected=True),
                 lambda x: x['tree']['first']['tabs'].append(a['view_id']),
                 lambda x: x['tree']['second'].update(tabs=[a['view_id']], active=a['view_id']),
                 lambda x: x['tree']['first'].update(active=b['view_id']),
                 lambda x: x['tree']['first'].update(tabs=[]),
                 lambda x: x['tree']['second'].update(id='g1'),
                 lambda x: x['tree'].update(id='x'*181),
                 lambda x: x['tree'].update(axis='diagonal'),
                 lambda x: x['tree'].update(ratio=True),
                 lambda x: x['tree'].update(ratio=0.149),
                 lambda x: x['tree'].update(ratio=0.851),
                 lambda x: x['tree'].update(first=None),
                 lambda x: x.update(version=True),
                 lambda x: x.update(maximized='v_'+'e'*32),
                 lambda x: x.update(tree=None,maximized=a['view_id']),
                 lambda x: x.update(approve=True)]
        path = self.views.root/(parent['workspace_id']+'.json'); before = path.read_bytes()
        for edit in edits:
            value = copy.deepcopy(base); edit(value)
            with self.subTest(value=value), self.assertRaises(Failure): self.store(parent, value)
            self.assertEqual(path.read_bytes(), before)
        for ratio in [0.15, 0.85]:
            value = copy.deepcopy(base); value['tree']['ratio'] = ratio
            parent = self.store(parent, value)

    def test_depth_group_and_panel_limits_and_single_schematic_instance(self):
        parent = self.open()
        children = [self.open('waveforms', parent['workspace_id']) for _ in range(17)]
        with self.assertRaises(Failure): self.store(parent, layout(children))
        tree = group(children[0]['view_id'], 'leaf0')
        for n in range(1,8): tree = split(tree, group(children[n]['view_id'], 'leaf'+str(n)), 'split'+str(n))
        parent = self.store(parent, layout(children[:8], tree))  # exactly depth8
        tree = split(tree, group(children[8]['view_id'], 'leaf8'), 'split8')
        with self.assertRaisesRegex(Failure, 'depth'): self.store(parent, layout(children[:9], tree))
        one = self.open('schematic', parent['workspace_id']); two = self.open('schematic', parent['workspace_id'])
        with self.assertRaisesRegex(Failure, 'one visible schematic'):
            self.store(parent, layout([one,two], split(group(one['view_id']), group(two['view_id'], 'g2'))))
        self.store(parent, layout([one,two], group(one['view_id'])))  # closed metadata is allowed

    def test_snapshot_keeps_invalid_editor_text_and_does_not_change_engineering_fields(self):
        parent = self.open(); child = self.open('simulation', parent['workspace_id'])
        self.assertEqual(self.data(child,'snapshot'), {'text': None})
        text = ' {"tab":"configuration", "editor":"{ broken JSON ", "zoom":2, "notes":"中文"} \n'
        internal = copy.deepcopy(self.views._load(parent['workspace_id'])['views'][child['view_id']])
        self.service.commit = 'f'*40
        with patch.object(self.service.gateway,'request', side_effect=AssertionError('No gateway for snapshots')), \
             patch.object(self.service,'call', side_effect=AssertionError('No source/config for snapshots')):
            updated = self.call('ic_view_snapshot', {**self.ref(child, True), 'text': text})
            self.assertEqual(self.data(updated,'snapshot'), {'text': text})
        stored = self.views._load(parent['workspace_id'])['views'][child['view_id']]
        for key, value in internal.items():
            if key != 'revision': self.assertEqual(stored[key], value)
        self.assertEqual(updated['revision'], child['revision']+1)
        self.assertNotIn('_snapshot', updated)
        self.views = ViewService(self.service,self.ui)
        self.assertEqual(self.data(self.refresh(child),'snapshot')['text'], text)
        with self.assertRaises(Failure): self.call('ic_view_snapshot', {**self.ref(parent,True),'text':'{}'})
        with self.assertRaises(Failure): self.call('ic_workbench_layout',{**self.ref(updated,True),'text':canonical(layout([]))})

    def test_snapshot_and_layout_reject_nonfinite_duplicate_nonobject_and_byte_limits(self):
        parent=self.open(); child=self.open('waveforms',parent['workspace_id'])
        path=self.views.root/(parent['workspace_id']+'.json'); before=path.read_bytes()
        bad=['[]','null','true','{"x":NaN}','{"x":Infinity}','{"x":1e999}','{"x":1,"x":2}','{"x":"\\ud800"}', '{bad']
        for name,view,limit in [('ic_view_snapshot',child,MAX_SNAPSHOT_BYTES),('ic_workbench_layout',parent,MAX_LAYOUT_BYTES)]:
            for text in bad + [json.dumps({'x':'中'*(limit//3)},ensure_ascii=False)]:
                with self.subTest(name=name,text=text[:40]), self.assertRaises(Failure):
                    self.call(name,{**self.ref(view,True),'text':text})
                self.assertEqual(path.read_bytes(),before)

    def test_parent_and_child_cas_are_independent_and_failed_writes_preserve_state(self):
        parent=self.open(); child=self.open('waveforms',parent['workspace_id'])
        updated=self.call('ic_view_snapshot',{**self.ref(child,True),'text':'{"cursor":1}'})
        parent=self.store(parent,layout([child],group(child['view_id'])))
        with self.assertRaisesRegex(Failure,'revision'):
            self.call('ic_view_snapshot',{**self.ref(child,True),'text':'{"cursor":2}'})
        self.assertEqual(self.data(updated,'snapshot')['text'],'{"cursor":1}')
        with self.assertRaisesRegex(Failure,'revision'):
            self.call('ic_workbench_layout',{**self.ref(parent),'expected_revision':1,'text':canonical(layout([]))})
        path=self.views.root/(parent['workspace_id']+'.json'); before=path.read_bytes()
        with patch('icwb.views.atom',side_effect=PermissionError('SYNTHETIC denied')):
            with self.assertRaises(PermissionError): self.store(parent,layout([]))
        self.assertEqual(path.read_bytes(),before)

    def test_close_all_does_not_touch_pending_request_or_child_visibility(self):
        parent=self.open(); child=self.open('simulation',parent['workspace_id'])
        child=self.call('ic_view_plan',{**self.ref(child,True),'action':'plan'})['view']
        prepared=self.call('ic_view_request',{**self.ref(child,True),'operation':'sim_submit','idempotency_key':'SYNTHETIC-pending'})
        child=prepared['view']; receipt=copy.deepcopy(prepared['request']); calls=len(self.service.calls)
        updated=self.call('ic_view_snapshot',{**self.ref(child,True),'text':'{"editor":"{"}'})
        parent=self.store(parent,layout([child]))
        self.assertEqual(self.refresh(child)['visible'],True)
        self.assertEqual(self.refresh(child)['revision'],updated['revision'])
        self.assertEqual(self.service.receipts[receipt['request_id']],receipt)
        self.assertTrue(all(op=='request_status' for op,_ in self.service.calls[calls:]))
        self.assertEqual(json.loads(self.data(parent,'layout')['text'])['tree'],None)

    def test_schema_metadata_and_private_data_envelope(self):
        catalog={tool['name']:tool for tool in tools()}
        self.assertEqual(catalog['ic_workbench_open']['_meta']['ui']['resourceUri'],RESOURCES['workbench'])
        for name in ['ic_workbench_layout','ic_view_snapshot']:
            self.assertEqual(catalog[name]['_meta']['ui']['visibility'],['app'])
            self.assertFalse(catalog[name]['annotations']['destructiveHint'])
            with self.assertRaises(Failure): validate(SCHEMAS[name],{'decision':'approve'})
        parent=self.open(); child=self.open('waveforms',parent['workspace_id'])
        child=self.call('ic_view_snapshot',{**self.ref(child,True),'text':'{"editor":"SYNTHETIC private draft"}'})
        messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{}}},
                  {'jsonrpc':'2.0','method':'notifications/initialized'},
                  {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'ic_view_data','arguments':{**self.ref(child),'revision':child['revision'],'query':{'kind':'snapshot'}}}}]
        out=io.StringIO(); run(self.service,io.StringIO(''.join(canonical(x)+'\n' for x in messages)),out,self.views)
        result=json.loads(out.getvalue().splitlines()[-1])['result']
        self.assertNotIn('private draft',result['content'][0]['text'])
        self.assertIn('private draft',result['_meta']['icWorkbench']['data']['payload']['text'])


if __name__=='__main__': unittest.main(verbosity=2)
