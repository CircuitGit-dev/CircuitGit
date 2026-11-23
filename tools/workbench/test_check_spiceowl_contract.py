"""Offline integration lock fixtures; Git operations only touch temporary repos."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import check_spiceowl_contract as checker


class ContractCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.local = self.root / 'circuitgit'
        self.external = self.root / 'spiceowl'
        self.local.mkdir(); self.external.mkdir()
        self.local_schema = self.local / 'contracts/supervision.json'
        self.external_schema = self.external / 'docs/contracts/supervision.json'
        self.adapter = self.external / checker.ADAPTER_PATH
        self.schema = b'{"x-contract-version":"1.2.0","type":"object"}\n'
        for path, content in ((self.local_schema, self.schema), (self.external_schema, self.schema),
                              (self.adapter, b'raise AssertionError("Do not import the external adapter")\n')):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        self.git('init', '-b', 'main')
        self.git('add', '.')
        self.commit('fixture')
        self.lock = {'schema': checker.LOCK_SCHEMA,
                     'spiceowl': {'repository': 'https://example.invalid/fixture/spiceowl',
                                  'commit': self.git('rev-parse', 'HEAD'),
                                  'contract_path': 'docs/contracts/supervision.json',
                                  'contract_sha256': hashlib.sha256(self.schema).hexdigest()},
                     'contract': {'path': 'contracts/supervision.json', 'version': '1.2.0'},
                     'resource_selection_profile': 'spiceowl.resource-selection.v1',
                     'related_pull_requests': ['https://example.invalid/fixture/pull/1']}
        self.write_lock()

    def git(self, *args):
        result = subprocess.run(['git', '-C', str(self.external), *args], capture_output=True, check=True)
        return result.stdout.decode().strip()

    def commit(self, message):
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
                 '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message)

    def write_lock(self):
        (self.local / checker.LOCK_PATH).write_text(json.dumps(self.lock))

    def check(self):
        return checker.check(self.external, root=self.local)

    def assert_error(self, code):
        with self.assertRaises(checker.ContractError) as error:
            self.check()
        self.assertEqual(error.exception.code, code)

    def test_matching_pinned_checkout_passes_without_importing_adapter(self):
        result = self.check()
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['spiceowl_commit'], self.lock['spiceowl']['commit'])
        self.assertEqual(result['contract_version'], '1.2.0')

    def test_wrong_pin_and_advanced_head_fail(self):
        self.lock['spiceowl']['commit'] = 'f' * 40
        self.write_lock(); self.assert_error('commit_mismatch')
        self.lock['spiceowl']['commit'] = self.git('rev-parse', 'HEAD')
        self.write_lock()
        (self.external / 'new.txt').write_text('new revision')
        self.git('add', '.'); self.commit('next')
        self.assert_error('commit_mismatch')

    def test_byte_drift_is_rejected_even_for_equivalent_json(self):
        self.local_schema.write_text(json.dumps(json.loads(self.schema), indent=2))
        self.assert_error('contract_drift')

    def test_wrong_digest_is_rejected(self):
        self.lock['spiceowl']['contract_sha256'] = '0' * 64
        self.write_lock(); self.assert_error('digest_mismatch')

    def test_wrong_locked_and_schema_versions_are_rejected(self):
        self.lock['contract']['version'] = '1.1.0'
        self.write_lock(); self.assert_error('version_mismatch')
        raw = self.schema.replace(b'1.2.0', b'1.1.0')
        self.local_schema.write_bytes(raw); self.external_schema.write_bytes(raw)
        self.lock['contract']['version'] = '1.2.0'
        self.lock['spiceowl']['contract_sha256'] = hashlib.sha256(raw).hexdigest()
        self.write_lock(); self.assert_error('version_mismatch')

    def test_matching_dirty_contracts_cannot_bypass_pinned_content(self):
        raw = self.schema.replace(b'"object"', b'"string"')
        self.local_schema.write_bytes(raw); self.external_schema.write_bytes(raw)
        self.lock['spiceowl']['contract_sha256'] = hashlib.sha256(raw).hexdigest()
        self.write_lock(); self.assert_error('uncommitted_contract')

    def test_missing_adapter_is_rejected(self):
        self.adapter.unlink()
        self.assert_error('adapter_missing')

    def test_nested_directory_is_not_accepted_as_repository_root(self):
        with self.assertRaises(checker.ContractError) as error:
            checker.check(self.external / 'docs', root=self.local)
        self.assertEqual(error.exception.code, 'checkout_root_mismatch')

    def test_invalid_paths_and_lock_structure_fail_before_git(self):
        for bad_path in ('../outside.json', '/tmp/outside.json', './contract.json', 'docs//contract.json'):
            with self.subTest(path=bad_path):
                self.lock['contract']['path'] = bad_path
                self.write_lock()
                with patch.object(checker, 'git', side_effect=AssertionError('must not inspect Git')):
                    self.assert_error('invalid_path')
        self.lock['contract']['path'] = 'contracts/supervision.json'
        self.lock['spiceowl']['commit'] = 'not-a-full-commit'
        self.write_lock()
        with patch.object(checker, 'git', side_effect=AssertionError('must not inspect Git')):
            self.assert_error('invalid_lock')

    def test_import_has_no_subprocess_side_effects(self):
        spec = importlib.util.spec_from_file_location('checker_import_fixture', checker.__file__)
        module = importlib.util.module_from_spec(spec)
        with patch.object(subprocess, 'run', side_effect=AssertionError('import must be passive')):
            spec.loader.exec_module(module)

    def test_cli_failure_is_nonzero_and_machine_readable(self):
        output = io.StringIO()
        with patch.object(checker, 'check', side_effect=checker.ContractError('commit_mismatch', 'Fixture mismatch.')):
            with contextlib.redirect_stderr(output):
                status = checker.main(['--spiceowl-root', str(self.external)])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(output.getvalue()),
                         {'status': 'failed', 'code': 'commit_mismatch', 'message': 'Fixture mismatch.'})

    def test_paired_runtime_schema_requires_bytes_digest_version_and_committed_content(self):
        raw = b'{"x-contract-version":"1.0.0","type":"object"}\n'
        own = self.local/'contracts/runtime.json'
        other = self.external/'docs/contracts/runtime.json'
        own.write_bytes(raw); other.write_bytes(raw)
        self.git('add', '.'); self.commit('runtime contract')
        self.lock['spiceowl']['commit'] = self.git('rev-parse', 'HEAD')
        self.lock['runtime_contract'] = {'path':'contracts/runtime.json',
            'upstream_path':'docs/contracts/runtime.json','version':'1.0.0','sha256':hashlib.sha256(raw).hexdigest()}
        self.write_lock()
        self.assertEqual(self.check()['runtime_contract_version'],'1.0.0')
        own.write_bytes(raw + b' ')
        self.assert_error('contract_drift')
        other.write_bytes(raw + b' ')
        self.assert_error('digest_mismatch')
        self.lock['runtime_contract']['sha256'] = hashlib.sha256(raw+b' ').hexdigest()
        self.write_lock(); self.assert_error('uncommitted_contract')


if __name__ == '__main__':
    unittest.main(verbosity=2)
