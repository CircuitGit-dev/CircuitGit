"""Circuit-only history, restore proposals and frozen summary inputs; synthetic Git only."""
import json
import unittest
from unittest.mock import patch
import test_version_control as fixture
import workspace

class DesignHistoryTests(unittest.TestCase):
    setUp=fixture.VersionControlTests.setUp
    g=fixture.VersionControlTests.g
    write=fixture.VersionControlTests.write
    commit=fixture.VersionControlTests.commit
    snapshot=fixture.VersionControlTests.snapshot
    http=fixture.VersionControlTests.http
    def summary(self,**kw):return self.ws.version_control('demo',scope='design',**kw)
    def test_default_design_history_excludes_readonly_provenance_and_cosmetic_edits(self):
        self.write(fixture.CIRCUIT,'R0 (x 0) resistor r=2k\n');changed=self.commit('UI-centric old title')
        self.write(fixture.CIRCUIT,'// browser acceptance marker\nR0 (x 0) resistor r=2k\n\n');comment=self.commit('Verify browser UI')
        self.write(fixture.CONFIG,'{\n}\n');formatting=self.commit('Format JSON')
        self.write(fixture.AUX,'READONLY_PROVENANCE\n');self.commit('Metadata only')
        self.write('apps/main.py','APP ONLY\n');self.commit('App only')
        before=self.snapshot();summary=self.summary()
        self.assertEqual([c['sha'] for c in summary['commits']],[changed,self.initial])
        self.assertEqual(summary['cosmetic_hidden'],2)
        self.assertEqual(summary['scope']['paths'],[fixture.CIRCUIT,fixture.CONFIG])
        self.assertEqual(summary['commits'][0]['subject'],'UI-centric old title')
        self.assertEqual(summary['commits'][0]['design_summary'],'更新电路 1 个文件')
        detailed=self.summary(include_cosmetic=True)
        self.assertIn(comment,[c['sha'] for c in detailed['commits']]);self.assertIn(formatting,[c['sha'] for c in detailed['commits']])
        self.assertEqual(self.snapshot(),before)
    def test_hierarchy_replacements_are_included_when_editable(self):
        self.ws.projects['demo']['read_paths'].remove(fixture.AUX)
        self.write(fixture.AUX,'R1 (y 0) resistor r=3k\n');sha=self.commit('Nested circuit change')
        self.assertIn(fixture.AUX,self.summary()['scope']['paths'])
        self.assertEqual(self.summary()['commits'][0]['sha'],sha)
    def test_cosmetic_comparison_preserves_inline_comments_strings_and_continuations(self):
        normalize=workspace.Workspace._version_normalized
        for before,after in [
            (b'R0 r=1k // old\n',b'R0 r=1k // new\n'),
            (b'parameters s="a b"\n',b'parameters s="ab"\n'),
            (b'parameters a=1 \\\n// x\n',b'parameters a=1 \\\n// y\n'),
            (b'parameters s="start\n// x\nend"\n',b'parameters s="start\n// y\nend"\n'),
        ]:
            with self.subTest(before=before):self.assertNotEqual(normalize(fixture.CIRCUIT,before),normalize(fixture.CIRCUIT,after))
        self.assertNotEqual(normalize(fixture.CONFIG,b'{"N":1}'),normalize(fixture.CONFIG,b'{"N":1.0}'))
        self.assertNotEqual(normalize(fixture.CONFIG,b'{"N":1,"N":2}'),normalize(fixture.CONFIG,b'{"N":2}'))
    def test_design_detail_keeps_original_title_and_commit_body(self):
        self.write(fixture.CONFIG,'{"parameters":{"N":8}}\n');sha=self.commit('Set converter resolution\n\nIncrease N to 8; no new simulation.')
        detail=self.ws.version_control_commit('demo',sha,scope='design')
        self.assertEqual(detail['commit']['subject'],'Set converter resolution')
        self.assertIn('Increase N to 8',detail['commit']['body'])
    def test_restore_preview_does_not_write_source_and_uses_current_hash_guards(self):
        self.write(fixture.CIRCUIT,'R0 (x 0) resistor r=2k\n');head=self.commit('Change resistor')
        before=self.snapshot()
        with patch.object(self.ws,'compile_inputs',return_value=({}, {}, {})),patch.object(self.ws,'validate_compiled'):
            # Preview compilation metadata must retain its normal shape.
            with patch.object(self.ws,'compile_inputs',return_value=({'configuration':{'effective':{}}},{},{})):
                result=self.ws.version_control_restore_preview('demo',self.initial,head)
        self.assertEqual(self.g('rev-parse','HEAD'),head);self.assertFalse(result['automatic_commit'])
        self.assertEqual(result['changes'][0]['content'],'R0 (x 0) resistor r=1k\n')
        self.assertEqual(result['changes'][0]['sha256'],workspace.core.sha(b'R0 (x 0) resistor r=2k\n'))
        self.assertIn('-R0 (x 0) resistor r=2k',result['preview']['diff'])
        self.assertEqual(self.snapshot(),before)
    def test_restore_rejects_stale_dirty_unreachable_or_incomplete_snapshot(self):
        head=self.g('rev-parse','HEAD')
        with self.assertRaises(workspace.Conflict):self.ws.version_control_restore_preview('demo',self.initial,'0'*40)
        self.write(fixture.CIRCUIT,'dirty\n')
        with self.assertRaises(workspace.Conflict):self.ws.version_control_restore_preview('demo',self.initial,head)
        self.g('checkout','--',fixture.CIRCUIT)
        self.ws.projects['demo']['configurations'].append({'id':'ADDED','configuration_path':'projects/demo/added.json','bundle_template':'sim/demo.json'})
        self.ws.allowed.add('projects/demo/added.json');self.write('projects/demo/added.json','{}\n');head=self.commit('Add configuration')
        with self.assertRaisesRegex(workspace.Conflict,'全部电路'):self.ws.version_control_restore_preview('demo',self.initial,head)
    def test_summary_input_revalidates_review_and_rejects_cross_project_or_changed_hash(self):
        base=self.g('rev-parse','HEAD');change={'path':fixture.CIRCUIT,'content':'R0 (x 0) resistor r=4k\n'}
        with patch.object(self.ws,'compile_inputs',return_value=({'configuration':{'effective':{}}},{},{})),patch.object(self.ws,'validate_compiled'):
            preview=self.ws.preview(base,[change]);before=self.snapshot()
            reviewed=self.ws.commit_summary_input('demo',base,preview['review_id'])
            self.assertEqual(reviewed['schema'],'ic.commit-summary-input.v1');self.assertIn('+R0',reviewed['diff'])
            self.assertEqual(set(reviewed['files'][0]),{'path','before_sha256','after_sha256'})
            self.assertEqual(self.snapshot(),before)
            self.write(fixture.CIRCUIT,'changed\n')
            with self.assertRaises(workspace.Conflict):self.ws.commit_summary_input('demo',base,preview['review_id'])
    def test_design_query_is_explicit_and_strict(self):
        status,body=self.http('/api/version-control?project_id=demo&scope=design&include_cosmetic=1')
        self.assertEqual(status,200);self.assertEqual(body['data']['scope']['kind'],'project_design')
        for query in ['scope=unknown','scope=design&include_cosmetic=true','scope=design&include_cosmetic=2']:
            self.assertEqual(self.http('/api/version-control?project_id=demo&'+query)[0],400)

if __name__=='__main__':unittest.main(verbosity=2)
