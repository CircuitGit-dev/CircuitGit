"""Finite library workflow tests using isolated Git fixtures; never a real push/PR."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("library_workflow", ROOT / "tools/workbench/library_workflow.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class LibraryWorkflowTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="circuitgit-workflow-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = "lib/demo/gain/netlist/gain.scs"
        self.shared = "lib/shared/resistor/netlist/device.scs"
        self.before = "subckt gain a b\nR0 (a b) resistor r=1k\nends gain\n"
        self.after = self.before.replace("1k", "2k")
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Fixture author")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("remote", "add", "origin", "https://github.com/fixture/circuits.git")
        self.write(".gitignore", ".local/\n")
        self.write("application.js", "// original application\n")
        self.write(self.path, self.before)
        self.write(self.shared, "// shared read-only source\n")
        self.write("lib/demo/gain/README.md", "# Synthetic gain fixture\n")
        self.write("lib/demo/gain/docs/provenance.json", {"source_sha256": "0" * 64})
        self.write("projects/rc-smoke/circuit.scs", "// legacy RC fixture\n")
        self.write("lib/demo/rc/README.md", "# Legacy RC reference\n")
        self.catalog = {"schema": "circuitgit.libraries.v1", "libraries": [{"id": "demo", "name": "Demo", "manifest": "lib/demo/library.json"}]}
        self.manifest = {"schema": "circuitgit.library.v1", "id": "demo", "name": "Demo", "cells": [
            {"id": "gain", "name": "Gain", "directory": "lib/demo/gain", "kind": "circuit",
             "readme": "lib/demo/gain/README.md", "project_id": None, "requires_external_models": False,
             "views": [{"id": "netlist", "kind": "spectre", "entry": self.path, "files": [self.path, self.shared]},
                       {"id": "docs", "kind": "markdown", "entry": "lib/demo/gain/README.md", "files": ["lib/demo/gain/README.md", "lib/demo/gain/docs/provenance.json"]}]},
            {"id": "rc", "name": "RC", "directory": "lib/demo/rc", "kind": "testbench",
             "readme": "lib/demo/rc/README.md", "project_id": "rc-smoke", "requires_external_models": False,
             "views": [{"id": "netlist", "kind": "spectre", "entry": "projects/rc-smoke/circuit.scs", "files": ["projects/rc-smoke/circuit.scs"]}]}]}
        self.write("lib/catalog.json", self.catalog)
        self.write("lib/demo/library.json", self.manifest)
        self.git("add", ".")
        self.git("commit", "-m", "Initial public fixture")
        self.initial = self.head()
        self.git("checkout", "-b", "codex/development")
        registry = {"gain-check": {"id": "gain-check", "library_id": "demo", "cell_id": "gain",
                                  "configuration_path": self.path, "engine": "source-check",
                                  "workflow_path": ".github/workflows/circuit-ci.yml", "label": "Source checks"},
                    "rc-check": {"id": "rc-check", "library_id": "demo", "cell_id": "rc",
                                 "configuration_path": "projects/rc-smoke/circuit.scs", "engine": "spectre",
                                 "workflow_path": ".github/workflows/spectre-manual.yml", "requires_external_models": True}}
        self.workflow = MOD.LibraryWorkflow(self.root, "fixture/circuits", ci_registry=registry)

    def git(self, *args, data=None):
        result = subprocess.run(["git", "-C", str(self.root), *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return result.stdout

    def write(self, path, content):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(content) if isinstance(content, (dict, list)) else content)
        return file

    def head(self):
        return self.git("rev-parse", "HEAD").decode().strip()

    def sha(self, value):
        return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()

    def preview_save(self, text=None):
        current = self.workflow.read_file("demo", "gain", self.path)
        return self.workflow.preview_save("demo", "gain", self.path, current["sha256"], content=self.after if text is None else text)

    def save(self, key="save-fixture-1", text=None):
        review = self.preview_save(text)
        return self.workflow.confirm(review["review_id"], key)

    def commit(self, key="commit-fixture-1"):
        review = self.workflow.preview_commit("demo", "gain", self.head(), title="Update resistor", body="Use the reviewed source value.")
        return self.workflow.confirm(review["review_id"], key)

    def execute(self, operation, key, **args):
        return self.workflow.execute(operation, {"library_id": "demo", "cell_id": "gain", **args}, key)

    def group_args(self):
        geometry = "lib/demo/gain/geometry/gain.json"
        self.write(geometry, '{"x":1}\n')
        self.manifest["cells"][0]["views"].append({"id": "geometry", "kind": "json", "entry": geometry, "files": [geometry]})
        self.write("lib/demo/library.json", self.manifest)
        self.git("add", geometry, "lib/demo/library.json")
        self.git("commit", "-m", "Register synthetic geometry")
        return [{"path": self.path, "content": self.after, "base_sha256": self.sha(self.before)},
                {"path": geometry, "content": '{"x":2}\n', "base_sha256": self.sha('{"x":1}\n')}]

    def test_direct_save_replays_original_receipt_without_revalidating_old_hash(self):
        args = {"path": self.path, "content": self.after, "base_sha256": self.sha(self.before)}
        result = self.execute("save", "direct-save-key", **args)
        self.assertEqual(result["state"], "complete")
        self.assertEqual(self.execute("save", "direct-save-key", **args), result)
        # Durable intent survives helper reconstruction and an unrelated later source edit.
        workflow = MOD.LibraryWorkflow(self.root, "fixture/circuits")
        self.write(self.path, self.after + "// outside editor\n")
        self.assertEqual(workflow.execute("save", {"library_id": "demo", "cell_id": "gain", **args}, "direct-save-key"), result)
        self.assertEqual(len(workflow.checkpoints("demo", "gain")["checkpoints"]), 1)
        for changed in ({**args, "content": self.before}, {**args, "path": self.shared}):
            with self.assertRaises(MOD.WorkflowError) as failure:
                self.execute("save", "direct-save-key", **changed)
            self.assertEqual(failure.exception.code, "conflict")

    def test_direct_commit_restore_ci_and_explicit_repeated_edit(self):
        original_revision = self.workflow.current("demo", "gain")["revision"]
        saved = self.execute("save", "direct-first-save", path=self.path, content=self.after, base_sha256=self.sha(self.before))
        self.execute("restore", "direct-restore-key", path=self.path, base_sha256=self.sha(self.after),
                     checkpoint_id=saved["checkpoint_id"], checkpoint_version="before")
        restored_revision = self.workflow.current("demo", "gain")["revision"]
        self.assertNotEqual(original_revision, restored_revision)
        second = self.execute("save", "direct-second-save", path=self.path, content=self.after, base_sha256=self.sha(self.before))
        self.assertNotEqual(saved["review_id"], second["review_id"])
        committed = self.execute("commit", "direct-commit-key", base_commit=self.head(), title="Update circuit", body="Increase the resistor value.")
        self.assertEqual(committed["state"], "complete")
        self.assertEqual(self.workflow.history("demo", "gain")["commits"][0]["title"], "Update circuit")
        ci = self.execute("ci", "direct-ci-key", enabled=True, testbench_ids=["gain-check"], base_sha256=None)
        self.assertEqual(ci["state"], "complete")
        self.assertEqual(self.workflow.get_ci("demo", "gain")["execution_status"], "not_checked")

    def test_direct_request_receipts_distinguish_missing_prepared_and_unknown(self):
        self.assertEqual(self.workflow.receipt(idempotency_key="missing-key")["state"], "not_found")
        args = {"path": self.path, "content": self.after, "base_sha256": self.sha(self.before)}
        with patch.object(self.workflow, "confirm", side_effect=MOD.WorkflowError("conflict", "Synthetic stop before dispatch")):
            with self.assertRaises(MOD.WorkflowError):
                self.execute("save", "prepared-key", **args)
        prepared = self.workflow.receipt(idempotency_key="prepared-key")
        self.assertEqual(prepared["state"], "prepared")
        self.assertFalse(prepared["dispatched"])
        with patch.object(self.workflow, "_apply_save", side_effect=OSError("Synthetic disk failure")) as apply:
            with self.assertRaises(MOD.WorkflowError):
                self.execute("save", "unknown-key", **args)
            self.assertEqual(self.execute("save", "unknown-key", **args)["state"], "unknown")
            self.assertEqual(apply.call_count, 1)

    def test_grouped_save_captures_netlist_and_geometry_and_replays_once(self):
        files = self.group_args()
        result = self.execute("save_files", "group-save-key", files=files)
        self.assertEqual(result["state"], "complete")
        self.assertEqual(result["files"], [row["path"] for row in files])
        self.assertEqual(self.execute("save_files", "group-save-key", files=files), result)
        checkpoints = self.workflow.checkpoints("demo", "gain")["checkpoints"]
        self.assertEqual(len(checkpoints), 2)
        self.assertEqual({row["group_id"] for row in checkpoints}, {result["operation_id"]})
        for row in files:
            self.assertEqual((self.root / row["path"]).read_text(), row["content"])
        for checkpoint in checkpoints:
            for hash_key in ("before_sha256", "sha256"):
                self.assertTrue((self.workflow.state / "objects" / checkpoint[hash_key]).is_file())

    def test_grouped_stale_hash_or_foreign_scope_rejects_before_any_write(self):
        files = self.group_args()
        files[1]["base_sha256"] = "f" * 64
        with self.assertRaises(MOD.WorkflowError):
            self.execute("save_files", "group-stale-key", files=files)
        self.assertEqual((self.root / self.path).read_text(), self.before)
        self.assertEqual((self.root / files[1]["path"]).read_text(), '{"x":1}\n')
        self.assertEqual(self.workflow.checkpoints("demo", "gain")["checkpoints"], [])
        files[1] = {"path": self.shared, "content": "// changed\n", "base_sha256": self.sha("// shared read-only source\n")}
        with self.assertRaises(MOD.WorkflowError):
            self.execute("save_files", "group-foreign-key", files=files)

    def test_grouped_second_failure_rolls_back_even_after_replace_then_fsync_error(self):
        files = self.group_args()
        original = self.workflow._replace_source
        calls = []
        def replace(path, raw, expected):
            calls.append((path, raw))
            original(path, raw, expected)
            if path == files[1]["path"] and raw == files[1]["content"].encode():
                raise OSError("Synthetic failure after successful rename")
        with patch.object(self.workflow, "_replace_source", side_effect=replace):
            result = self.execute("save_files", "group-rollback-key", files=files)
        self.assertEqual(result["state"], "rolled_back")
        self.assertTrue(all(row["restored"] for row in result["files"]))
        self.assertEqual((self.root / self.path).read_text(), self.before)
        self.assertEqual((self.root / files[1]["path"]).read_text(), '{"x":1}\n')
        with patch.object(self.workflow, "_replace_source") as replace:
            self.assertEqual(self.execute("save_files", "group-rollback-key", files=files), result)
            replace.assert_not_called()
        for row in self.workflow.checkpoints("demo", "gain")["checkpoints"]:
            self.assertEqual(row["state"], "rolled_back")
            with self.assertRaises(MOD.WorkflowError):
                self.workflow._checkpoint(row["checkpoint_id"])

    def test_grouped_failure_preserves_external_edit_and_reports_partial(self):
        files = self.group_args()
        original = self.workflow._replace_source
        def replace(path, raw, expected):
            if path == files[1]["path"]:
                self.write(self.path, self.before + "// concurrent external edit\n")
                raise OSError("Synthetic second-source write failure")
            original(path, raw, expected)
        with patch.object(self.workflow, "_replace_source", side_effect=replace):
            result = self.execute("save_files", "group-partial-key", files=files)
        self.assertEqual(result["state"], "partial")
        self.assertFalse(result["automatic_retry"])
        self.assertEqual((self.root / self.path).read_text(), self.before + "// concurrent external edit\n")
        self.assertEqual(result["rollback_errors"], [{"path": self.path, "code": "conflict"}])
        self.assertEqual(self.execute("save_files", "group-partial-key", files=files), result)

    def test_revision_tracks_readonly_dependencies_and_catalog_includes_unbound_cells(self):
        baseline = self.workflow.current("demo", "gain")
        self.assertEqual(baseline["revision"], baseline["fingerprint"])
        self.assertEqual(self.workflow.read_file("demo", "gain", self.path)["revision"], baseline["revision"])
        self.write(self.shared, "// shared dependency modified outside this cell\n")
        changed = self.workflow.current("demo", "gain")
        self.assertEqual(changed["changes"], [])
        self.assertFalse(changed["dirty"])
        self.assertNotEqual(changed["revision"], baseline["revision"])
        self.assertEqual(self.workflow.checkpoints("demo", "gain")["revision"], changed["revision"])
        catalog = self.workflow.catalog()
        gain, rc = catalog["libraries"][0]["cells"]
        self.assertEqual(gain["source_path"], self.path)
        self.assertIsNone(gain["project_id"])
        self.assertEqual(rc["source_path"], "projects/rc-smoke/circuit.scs")
        self.assertEqual(catalog["repository"], "fixture/circuits")

    def test_catalog_prefers_owned_electrical_cell_source_over_native_view_wrapper(self):
        wrapper = "lib/demo/gain/netlist/view-gain.scs"
        self.write(wrapper, 'simulator lang=spectre\ninclude "gain.scs"\n')
        source_view = self.manifest["cells"][0]["views"][0]
        source_view.update(kind="rnl", entry=wrapper, files=[wrapper, self.path, self.shared])
        self.write("lib/demo/library.json", self.manifest)
        self.git("add", wrapper, "lib/demo/library.json")
        self.git("commit", "-m", "Declare synthetic native assembly")
        cells = self.workflow.catalog()["libraries"][0]["cells"]
        self.assertEqual(cells[0]["source_path"], self.path)
        self.assertEqual(cells[1]["source_path"], "projects/rc-smoke/circuit.scs")
        description = self.workflow.describe("demo", "gain")
        by_path = {row["path"]: row["editable"] for row in description["files"]}
        self.assertTrue(by_path[wrapper])
        self.assertTrue(by_path[self.path])
        self.assertFalse(by_path[self.shared])

    def test_describe_uses_committed_scope_and_snapshot_match_is_informational(self):
        description = self.workflow.describe("demo", "gain", self.path, "f" * 64)
        self.assertFalse(description["snapshot_matches_head"])
        self.assertTrue(description["capabilities"]["save"])
        files = {row["path"]: row["editable"] for row in description["files"]}
        self.assertTrue(files[self.path])
        self.assertFalse(files[self.shared])
        self.assertFalse(files["lib/demo/gain/docs/provenance.json"])
        changed = copy.deepcopy(self.manifest)
        changed["cells"][0]["views"][0]["files"].append("application.js")
        self.write("lib/demo/library.json", changed)
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.read_file("demo", "gain", "application.js")
        self.assertTrue(self.workflow.read_file("demo", "rc", "projects/rc-smoke/circuit.scs")["editable"])

    def test_preview_save_is_immutable_and_does_not_write_source(self):
        review = self.preview_save()
        self.assertEqual((self.root / self.path).read_text(), self.before)
        self.assertIn("+R0 (a b) resistor r=2k", review["diff"])
        self.assertEqual(self.workflow.receipt(review_id=review["review_id"])["state"], "prepared")
        self.assertEqual(self.workflow.review(review["review_id"])["payload"]["sha256"], self.sha(self.after))
        self.assertEqual(self.workflow.checkpoints("demo", "gain")["checkpoints"], [])

    def test_save_checkpoint_captures_before_and_after_and_same_key_is_idempotent(self):
        review = self.preview_save()
        first = self.workflow.confirm(review["review_id"], "stable-save-key")
        second = self.workflow.confirm(review["review_id"], "stable-save-key")
        self.assertEqual(first, second)
        self.assertEqual(first["state"], "complete")
        self.assertEqual(self.head(), self.initial)
        self.assertEqual((self.root / self.path).read_text(), self.after)
        checkpoints = self.workflow.checkpoints("demo", "gain")["checkpoints"]
        self.assertEqual(len(checkpoints), 1)
        self.assertEqual(checkpoints[0]["before_sha256"], self.sha(self.before))
        self.assertEqual(checkpoints[0]["restore_versions"], ["before", "after"])
        self.assertEqual(self.workflow.receipt(review_id=review["review_id"]), first)

    def test_save_rejects_stale_hash_and_source_change_after_preview(self):
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.preview_save("demo", "gain", self.path, "f" * 64, self.after)
        review = self.preview_save()
        self.write(self.path, self.before.replace("1k", "3k"))
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.confirm(review["review_id"], "changed-source-key")
        self.assertEqual(self.workflow.receipt(review_id=review["review_id"])["state"], "prepared")
        self.assertEqual(self.workflow.checkpoints("demo", "gain")["checkpoints"], [])

    def test_private_paths_shared_files_and_provenance_are_not_editable(self):
        for path in ("lib/../application.js", "/tmp/model.scs", self.shared, "lib/demo/gain/docs/provenance.json"):
            with self.subTest(path=path), self.assertRaises(MOD.WorkflowError):
                self.workflow.preview_save("demo", "gain", path, None, "changed\n")
        for value in ("// /Users/fixture/private/model.scs\n", "ghp_" + "0" * 36):
            with self.subTest(value=value), self.assertRaises(MOD.WorkflowError):
                self.preview_save(value)

    def test_symlink_sources_and_foreign_origin_are_rejected(self):
        source = self.root / self.path
        source.unlink()
        source.symlink_to(self.root / self.shared)
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.read_file("demo", "gain", self.path)
        self.git("remote", "set-url", "origin", "https://github.com/other/repository.git")
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.describe("demo", "gain")
        self.git("remote", "set-url", "origin", "https://github.com/fixture/circuits.git")
        self.write(".git/rewrite.cfg", '[url "https://example.invalid/"]\n    insteadOf = https://github.com/\n')
        self.git("config", "include.path", "rewrite.cfg")
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.describe("demo", "gain")

    def test_current_observes_external_edits_without_inventing_checkpoints(self):
        self.write(self.path, self.after)
        self.write("application.js", "// unrelated local application change\n")
        current = self.workflow.current("demo", "gain")
        self.assertEqual([row["path"] for row in current["changes"]], [self.path])
        self.assertIn("2k", current["diff"])
        self.assertEqual(self.workflow.checkpoints("demo", "gain")["checkpoints"], [])

    def test_scoped_commit_preserves_unrelated_index_and_worktree_and_runs_no_hooks_or_filters(self):
        self.save()
        self.write("application.js", "// staged unrelated application\n")
        self.git("add", "application.js")
        staged_blob = self.git("show", ":application.js")
        self.write("application.js", "// unstaged unrelated application\n")
        sentinel = self.root / "hook-ran"
        hook = self.write(".git/hooks/pre-commit", "#!/bin/sh\ntouch " + str(sentinel) + "\nexit 1\n")
        hook.chmod(0o755)
        self.write(".gitattributes", "*.scs filter=must_not_run\n")
        self.git("config", "filter.must_not_run.clean", "touch " + str(sentinel))
        result = self.commit()
        self.assertEqual(result["files"], [self.path])
        self.assertEqual(self.git("diff-tree", "--no-commit-id", "--name-only", "-r", result["commit"]).decode().splitlines(), [self.path])
        self.assertEqual(self.git("show", ":application.js"), staged_blob)
        self.assertEqual((self.root / "application.js").read_text(), "// unstaged unrelated application\n")
        self.assertFalse(sentinel.exists())
        self.assertEqual(self.workflow.current("demo", "gain")["changes"], [])

    def test_commit_refuses_selected_staging_and_changed_preview(self):
        self.write(self.path, self.after)
        self.git("add", self.path)
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.preview_commit("demo", "gain", self.head(), message="Review staged cell")
        self.git("reset", "HEAD", "--", self.path)
        preview = self.workflow.preview_commit("demo", "gain", self.head(), message="Review source")
        self.write(self.path, self.after + "// later edit\n")
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.confirm(preview["review_id"], "stale-commit-key")
        self.assertEqual(self.head(), self.initial)

    def test_committer_identity_is_explicit_frozen_and_has_neutral_fallback(self):
        self.save()
        review = self.workflow.preview_commit("demo", "gain", self.head(), message="Configured author")
        self.assertEqual(review["payload"]["committer"], {"name": "Fixture author", "email": "fixture@example.invalid", "source": "git_config"})
        self.git("config", "user.name", "Changed fixture author")
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.confirm(review["review_id"], "changed-identity-key")
        self.git("config", "--unset", "user.name"); self.git("config", "--unset", "user.email")
        home = self.root / "empty-home"
        home.mkdir()
        with patch.dict(os.environ, {"HOME": str(home), "XDG_CONFIG_HOME": str(home)}):
            review = self.workflow.preview_commit("demo", "gain", self.head(), message="Neutral identity")
            self.assertEqual(review["payload"]["committer"]["source"], "neutral_fallback")
            result = self.workflow.confirm(review["review_id"], "neutral-identity-key")
        self.assertEqual(result["committer"]["email"], "circuitgit@localhost.invalid")
        self.assertEqual(self.git("show", "-s", "--format=%an <%ae>", result["commit"]).decode().strip(), "CircuitGit Workbench <circuitgit@localhost.invalid>")

    def test_history_is_cell_scoped_and_restore_makes_new_change_without_reset(self):
        saved = self.save()
        committed = self.commit()
        self.assertEqual(self.workflow.history("demo", "gain")["commits"][0]["sha"], committed["commit"])
        detail = self.workflow.commit_detail("demo", "gain", committed["commit"])
        self.assertIn("2k", detail["diff"])
        self.assertNotIn("application.js", detail["files"])
        restore = self.workflow.preview_restore("demo", "gain", self.path, self.sha(self.after), checkpoint_id=saved["checkpoint_id"], checkpoint_version="before")
        result = self.workflow.confirm(restore["review_id"], "restore-before-key")
        self.assertEqual((self.root / self.path).read_text(), self.before)
        self.assertEqual(self.head(), committed["commit"])
        self.assertNotEqual(result["checkpoint_id"], saved["checkpoint_id"])
        self.assertEqual(len(self.workflow.checkpoints("demo", "gain")["checkpoints"]), 2)
        new_commit = self.commit("commit-restoration-key")
        self.assertEqual(self.git("rev-parse", new_commit["commit"] + "^").decode().strip(), committed["commit"])

    def test_restore_historical_commit_and_wrong_cell_checkpoint(self):
        saved = self.save()
        preview = self.workflow.preview_restore("demo", "gain", self.path, self.sha(self.after), commit=self.initial)
        self.assertEqual(preview["payload"]["content"], self.before)
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.preview_restore("demo", "rc", "projects/rc-smoke/circuit.scs", self.sha("// legacy RC fixture\n"), checkpoint_id=saved["checkpoint_id"])
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.commit_detail("demo", "gain", "HEAD; touch /tmp/no")

    def test_ci_selects_only_registered_cell_testbenches_and_does_not_execute(self):
        ci = self.workflow.get_ci("demo", "gain")
        self.assertEqual([row["id"] for row in ci["testbenches"]], ["gain-check"])
        self.assertIsNone(ci["config"])
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.preview_ci("demo", "gain", ["rc-check"], True, None)
        review = self.workflow.preview_ci("demo", "gain", ["gain-check"], True, None)
        result = self.workflow.confirm(review["review_id"], "ci-save-key")
        self.assertEqual(result["path"], "lib/demo/gain/ci.json")
        config = self.workflow.get_ci("demo", "gain")
        self.assertEqual(config["config"]["testbench_ids"], ["gain-check"])
        self.assertEqual(config["execution_status"], "not_checked")
        self.assertEqual(self.head(), self.initial)
        self.assertEqual(self.workflow.current("demo", "gain")["changes"][0]["path"], result["path"])

    def test_pr_review_binds_cell_only_commit_and_rejects_branch_ref_injection(self):
        self.save(); committed = self.commit()
        review = self.workflow.preview_pr("demo", "gain", committed["commit"], "Adjust resistor", "Reviewed source changes")
        self.assertEqual(review["payload"]["base_sha"], self.initial)
        self.assertTrue(review["payload"]["pr_branch"].startswith("codex/library/demo/gain-"))
        for branch in ("main", "codex/library/x..y", "--upload-pack=evil", "codex/library/a;touch"):
            with self.subTest(branch=branch), self.assertRaises(MOD.WorkflowError):
                self.workflow.preview_pr("demo", "gain", committed["commit"], "Title", branch=branch)
        self.write("application.js", "// independent code change\n")
        self.git("add", "application.js"); self.git("commit", "-m", "Application update")
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.preview_pr("demo", "gain", self.head(), "Must not include app code")

    def test_confirmed_pr_uses_exact_sha_safe_args_and_idempotent_receipt(self):
        self.save(); committed = self.commit()
        review = self.workflow.preview_pr("demo", "gain", committed["commit"], "Adjust resistor", "Line one\nLine two")
        commands, gh_commands = [], []
        original_git = self.workflow._git
        def git(*args, **kwargs):
            if kwargs.get("network"):
                commands.append(args)
                if args[0] == "ls-remote":
                    return subprocess.CompletedProcess(args, 0, (self.initial + "\trefs/heads/main\n").encode(), b"")
                return subprocess.CompletedProcess(args, 0, b"ok", b"")
            return original_git(*args, **kwargs)
        def gh(*args):
            gh_commands.append(args)
            if args[:2] == ("pr", "list"):
                return b"[]"
            if args[:2] == ("pr", "view"):
                return json.dumps({"url": "https://github.com/fixture/circuits/pull/7", "state": "OPEN", "headRefName": review["payload"]["pr_branch"], "headRefOid": committed["commit"], "baseRefName": "main"}).encode()
            return b"https://github.com/fixture/circuits/pull/7\n"
        with patch.object(self.workflow, "_git", side_effect=git), patch.object(self.workflow, "_gh", side_effect=gh):
            receipt = self.execute("pr", "pr-stable-key", commit=committed["commit"], title="Adjust resistor", body="Line one\nLine two")
            self.assertEqual(self.execute("pr", "pr-stable-key", commit=committed["commit"], title="Adjust resistor", body="Line one\nLine two"), receipt)
        self.assertEqual([args[0] for args in commands], ["ls-remote", "push"])
        self.assertEqual(commands[1][-1], committed["commit"] + ":refs/heads/" + review["payload"]["pr_branch"])
        self.assertFalse(any("force" in value for value in commands[1]))
        self.assertEqual([args[1] for args in gh_commands], ["list", "create", "view"])
        self.assertIn("--body-file", gh_commands[1])
        self.assertEqual(receipt["url"], "https://github.com/fixture/circuits/pull/7")
        self.assertFalse(receipt["merged"])

    def test_pr_status_is_explicit_scoped_read_without_changing_receipts(self):
        branch = "codex/library/demo/gain-review"
        row = {"number": 7, "url": "https://github.com/fixture/circuits/pull/7", "state": "OPEN",
               "headRefName": branch, "headRefOid": self.initial, "baseRefName": "main",
               "statusCheckRollup": [{"name": "Source checks", "status": "COMPLETED", "conclusion": "SUCCESS", "unused": "omit"}]}
        with patch.object(self.workflow, "_gh", return_value=json.dumps([row]).encode()) as gh:
            result = self.workflow.pr_status("demo", "gain", branch)
            self.assertEqual(result["state"], "open")
            self.assertEqual(result["pull_requests"][0]["statusCheckRollup"][0]["conclusion"], "SUCCESS")
            self.assertNotIn("unused", result["pull_requests"][0]["statusCheckRollup"][0])
            self.assertEqual(gh.call_args.args[:2], ("pr", "list"))
        with patch.object(self.workflow, "_gh") as gh, self.assertRaises(MOD.WorkflowError):
            self.workflow.pr_status("demo", "gain", "codex/library/demo/rc-review")
        gh.assert_not_called()

    def test_pr_update_targets_exact_existing_branch_and_checks_returned_head(self):
        self.save(); committed = self.commit()
        review = self.workflow.preview_pr("demo", "gain", committed["commit"], "Updated PR title", action="update")
        branch = review["payload"]["pr_branch"]
        row = {"number": 8, "url": "https://github.com/fixture/circuits/pull/8", "state": "OPEN",
               "headRefName": branch, "headRefOid": committed["commit"], "baseRefName": "main"}
        original_git, calls = self.workflow._git, []
        def git(*args, **kwargs):
            if kwargs.get("network"):
                stdout = (self.initial + "\trefs/heads/main\n").encode() if args[0] == "ls-remote" else b"ok"
                return subprocess.CompletedProcess(args, 0, stdout, b"")
            return original_git(*args, **kwargs)
        def gh(*args):
            calls.append(args)
            return json.dumps([row] if args[:2] == ("pr", "list") else row if args[:2] == ("pr", "view") else {}).encode()
        with patch.object(self.workflow, "_git", side_effect=git), patch.object(self.workflow, "_gh", side_effect=gh):
            result = self.workflow.confirm(review["review_id"], "pr-update-key")
        self.assertEqual([args[1] for args in calls], ["list", "edit", "view"])
        self.assertEqual(calls[1][2], "8")
        self.assertEqual(result["action"], "update")
        self.assertEqual(result["commit"], committed["commit"])

    def test_changed_remote_base_stops_before_any_push_or_pr_write(self):
        self.save(); committed = self.commit()
        review = self.workflow.preview_pr("demo", "gain", committed["commit"], "Reviewed base")
        original_git, network = self.workflow._git, []
        def git(*args, **kwargs):
            if kwargs.get("network"):
                network.append(args)
                return subprocess.CompletedProcess(args, 0, ("a" * 40 + "\trefs/heads/main\n").encode(), b"")
            return original_git(*args, **kwargs)
        with patch.object(self.workflow, "_git", side_effect=git), patch.object(self.workflow, "_gh", return_value=b"[]") as gh:
            with self.assertRaises(MOD.WorkflowError):
                self.workflow.confirm(review["review_id"], "pr-base-race-key")
            self.assertEqual([args[0] for args in network], ["ls-remote"])
            self.assertEqual(gh.call_count, 1)
        self.assertEqual(self.workflow.receipt(review_id=review["review_id"])["state"], "unknown")

    def test_manual_ci_file_cannot_commit_unregistered_or_foreign_selections(self):
        self.write("lib/demo/gain/ci.json", {"schema": "circuitgit.cell-ci.v1", "library_id": "demo", "cell_id": "gain",
                                              "enabled": True, "testbench_ids": ["rc-check"]})
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.preview_commit("demo", "gain", self.head(), title="Wrong CI selection")
        with self.assertRaises(MOD.WorkflowError):
            self.workflow.get_ci("demo", "gain")

    def test_unknown_pr_outcome_is_durable_and_never_replayed(self):
        self.save(); committed = self.commit()
        review = self.workflow.preview_pr("demo", "gain", committed["commit"], "Adjust resistor")
        with patch.object(self.workflow, "_gh", side_effect=MOD.WorkflowError("github_unknown", "Synthetic timeout", 503)) as gh:
            with self.assertRaises(MOD.WorkflowError) as failure:
                self.workflow.confirm(review["review_id"], "pr-unknown-key")
            self.assertEqual(failure.exception.code, "outcome_unknown")
            receipt = self.workflow.confirm(review["review_id"], "pr-unknown-key")
            self.assertEqual(receipt["state"], "unknown")
            self.assertEqual(gh.call_count, 1)
        self.assertEqual(self.workflow.receipt(review_id=review["review_id"])["state"], "unknown")
        self.assertFalse(receipt["automatic_retry"])

    def test_dispatch_has_no_direct_save_confirm_or_arbitrary_commands(self):
        for operation in ("save", "confirm", "git", "shell", "__dict__"):
            with self.subTest(operation=operation), self.assertRaises(MOD.WorkflowError):
                self.workflow.dispatch(operation, {})
        description = self.workflow.dispatch("describe", {"library_id": "demo", "cell_id": "gain"})
        self.assertEqual(description["repository"], "fixture/circuits")


if __name__ == "__main__":
    unittest.main()
