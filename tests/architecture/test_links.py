"""Local documents and mocked HTTP classifications; no external requests."""
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/dev'))
import check_links as links


class LinkTests(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup);self.root=Path(directory.name)
    def write(self,name,text):
        path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text,encoding='utf-8');return path
    def audit(self,**args):return links.audit(self.root,**args)
    def test_markdown_html_references_unicode_anchors_and_nested_parentheses(self):
        self.write('docs/My Report_(new).md','# 快速 `setup`\n\n## Repeated\n\n## Repeated\n\n<span id="custom"></span>\n')
        self.write('docs/chart.svg','<svg><g id="plot"></g></svg>')
        self.write('README.md','[start](<docs/My Report_(new).md#快速-setup>)\n[again][guide]\n[guide]: <docs/My Report_(new).md#repeated-1>\n<a href="docs/My%20Report_(new).md#custom">custom</a>\n![plot](docs/chart.svg#plot)\n')
        result=self.audit();self.assertEqual(result['status'],'passed');self.assertEqual(result['findings'],[])
        self.assertGreaterEqual(result['coverage']['rendered_links'],5)
    def test_code_fences_inline_examples_and_comments_are_not_rendered_links(self):
        self.write('README.md','```md\n[example](missing.md)\n```\n`[inline](also-missing.md)`\n<!-- [comment](no.md) -->\n')
        result=self.audit();self.assertEqual(result['status'],'passed');self.assertEqual(result['coverage']['rendered_links'],0)
    def test_missing_file_fragment_and_reference_are_actionable_and_keep_line_numbers(self):
        self.write('a.md','# Present\n')
        self.write('README.md','[missing](missing.md)\n[anchor](a.md#absent)\n[label][undefined]\n')
        result=self.audit();self.assertEqual(result['status'],'failed')
        self.assertEqual([(row['line'],row['code']) for row in result['findings'] if row['source']=='README.md'],[(1,'missing_local_target'),(2,'missing_local_anchor'),(3,'missing_reference_definition')])
    def test_current_clone_examples_flag_migrated_first_party_but_keep_unrelated_sources(self):
        self.write('README.md','```sh\ngit clone https://github.com/analog-topology-synth/CircuitGit.git\n```\n[original](https://github.com/analog-topology-synth/IC_on_Github)\n[upstream](https://github.com/rich-netlist/rnl)\n')
        result=self.audit();outdated=[row for row in result['findings'] if row['code']=='outdated_first_party_url']
        self.assertEqual(len(outdated),1);self.assertEqual(outdated[0]['line'],2);self.assertEqual(outdated[0]['suggested'],'https://github.com/CircuitGit-dev/CircuitGit.git')
    def test_historical_evidence_is_reported_without_rewriting_and_vendor_is_excluded(self):
        original='[archive](missing.md)\nhttps://github.com/analog-topology-synth/CircuitGit\n'
        path=self.write('validation/old/README.md',original);self.write('apps/web/vendor/example/README.md','[source](upstream-only.md)')
        result=self.audit();self.assertEqual(result['status'],'passed');self.assertEqual(path.read_text(),original)
        self.assertTrue(any(row['code']=='historical_missing_local_target' for row in result['findings']))
        self.assertTrue(any(row['path']=='apps/web/vendor' for row in result['coverage']['skipped_paths']))
    def test_offline_never_calls_http_and_reports_external_scope(self):
        self.write('README.md','[upstream](https://github.com/rich-netlist/rnl)\n[local](http://127.0.0.1:8766/)')
        result=self.audit(probe=lambda *args:self.fail('offline audit must not request HTTP'))
        self.assertEqual(result['coverage']['external_audited'],0);self.assertEqual(result['external'][0]['code'],'offline_external_not_checked')
        self.assertTrue(any(row['code']=='non_public_address' for row in result['findings']))
    def test_optional_online_classifies_auth_rate_limit_missing_and_limit_without_false_success(self):
        self.write('README.md','[a](https://github.com/a)\n[b](https://github.com/b)\n[c](https://docs.python.org/c)\n[d](https://www.python.org/d)\n[e](https://www.example.edu/e)\n')
        calls=[]
        def probe(url,_timeout):
            calls.append(url)
            if 'github' in url:return {'status':'warning','code':'rate_limited','http_status':429}
            if 'docs.python' in url:return {'status':'warning','code':'access_restricted','http_status':403}
            return {'status':'error','code':'not_found','http_status':404}
        result=self.audit(online=True,max_external=3,probe=probe)
        self.assertEqual(len(calls),3);self.assertEqual(result['status'],'failed')
        codes={row['code'] for row in result['external']};self.assertTrue({'access_restricted','rate_limited','host_rate_limited','not_found','external_audit_limit'}<=codes)
    def test_local_or_credential_urls_are_never_eligible_for_external_audit(self):
        for value in ['http://localhost:8766','http://10.0.0.1/','https://example.test/','https://user:secret@github.com/','https://github.com/?token=secret','https://github.com:bad/']:
            self.assertIsNotNone(links.public_url(value))
        self.write('README.md','[login](https://user:synthetic-password@github.com/a)\n[token](https://github.com/a?token=synthetic-token)')
        report=self.audit(online=True,probe=lambda *args:self.fail('Credential URL must not be requested'))
        self.assertNotIn('synthetic-password',json.dumps(report));self.assertNotIn('synthetic-token',json.dumps(report))
    def test_http_probe_falls_back_from_head_without_reading_or_authenticating(self):
        calls=[]
        class Response:
            status=200
            def geturl(self):return 'https://docs.python.org/new'
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):raise AssertionError('Do not download page bodies')
        class Opener:
            def open(self,request,timeout):
                calls.append((request,timeout))
                if request.method=='HEAD':raise HTTPError(request.full_url,405,'not supported',{},None)
                return Response()
        with patch.object(links,'public_url',return_value=None),patch.object(links,'build_opener',return_value=Opener()):
            result=links.online_probe('https://docs.python.org/old',3)
        self.assertEqual(result['code'],'redirected');self.assertEqual([call[0].method for call in calls],['HEAD','GET'])
        for request,timeout in calls:
            self.assertEqual(timeout,3);self.assertNotIn('Authorization',dict(request.header_items()));self.assertNotIn('Cookie',dict(request.header_items()))
    def test_private_redirect_is_an_explicit_skip_and_never_opens_target(self):
        with self.assertRaises(links.SkippedURL) as caught:
            links.PublicRedirect().redirect_request(None,None,302,'redirect',{},'http://127.0.0.1:8766/')
        self.assertEqual(caught.exception.reason,'redirect_non_public_address')
    def test_network_failure_and_access_denial_remain_unverified(self):
        class Opener:
            def __init__(self,error):self.error=error
            def open(self,*args,**kwargs):raise self.error
        for error,code in [(TimeoutError(),'network_unverified'),(HTTPError('https://github.com/a',403,'forbidden',{},None),'access_restricted')]:
            with patch.object(links,'public_url',return_value=None),patch.object(links,'build_opener',return_value=Opener(error)):
                result=links.online_probe('https://github.com/a',1)
            self.assertEqual(result['status'],'warning');self.assertEqual(result['code'],code)
    def test_repository_escape_and_symlink_target_fail_closed(self):
        outside=self.root.parent/'outside-link-test.md';outside.write_text('# outside');self.addCleanup(outside.unlink)
        (self.root/'alias.md').symlink_to(outside);self.write('README.md','[outside](../outside-link-test.md)\n[alias](alias.md)')
        result=self.audit();self.assertEqual(result['status'],'failed');self.assertEqual(sum(row['code']=='outside_repository' for row in result['findings']),2)
    def test_source_line_links_are_checked_without_running_the_file(self):
        self.write('script.py','raise AssertionError("never import")\n# second line\n');self.write('README.md','[code](script.py#L1-L2)\n[bad](script.py#L3)')
        result=self.audit();self.assertEqual([row['code'] for row in result['findings']],['missing_local_line'])
    def test_malformed_link_is_reported_without_aborting_other_documents(self):
        self.write('README.md','[bad](https://[broken)\n');self.write('guide.md','[missing](absent.md)')
        result=self.audit();self.assertEqual(result['status'],'failed');self.assertTrue({'malformed_target','missing_local_target'}<={row['code'] for row in result['findings']})


if __name__=='__main__':unittest.main()
