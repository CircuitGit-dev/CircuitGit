"""Tests for Step 2: Library CRUD, Branch Workflow, and Multi-Cell Related PRs."""
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/workbench"))
sys.path.insert(0, str(ROOT / "apps/codex"))
sys.path.insert(0, str(ROOT / "modules/gateway_client"))

import browser_library
import library_workflow as MOD
import icwb.library as library_adapter


class FakePairing:
    def accepts(self, token, origin):
        return token == "ok-token" and origin == "http://127.0.0.1:8766"


class FakeService:
    def __init__(self, root, workflow):
        self.config = {
            "library_workspace": str(root),
            "library_repository": "fixture/circuits",
            "library_access": "direct",
            "library_state_dir": str(root / ".local/library-workflow"),
            "library_base_branch": "main",
        }
        self.library_workflow = workflow


class LibraryCrudBranchesPrTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="circuitgit-crud-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Fixture Author")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("remote", "add", "origin", "https://github.com/fixture/circuits.git")
        self.write(".gitignore", ".local/\n")
        self.write("application.js", "// application code\n")
        self.write("lib/demo/gain/schematic/gain.scs", "simulator lang=spectre\nsubckt gain a b\nR0 (a b) resistor r=1k\nends gain\n")
        self.write("lib/demo/gain/README.md", "# Gain\n")
        self.write("lib/demo/top/schematic/top.scs", "simulator lang=spectre\nsubckt top x y\nX0 (x y) gain\nends top\n")
        self.write("lib/demo/top/README.md", "# Top\n")
        self.write("lib/demo/other/schematic/other.scs", "simulator lang=spectre\nsubckt other a b\nR0 (a b) resistor r=5k\nends other\n")
        self.write("lib/demo/other/README.md", "# Other\n")
        self.write("lib/catalog.json", {
            "schema": "circuitgit.libraries.v1",
            "libraries": [{"id": "demo", "name": "Demo", "manifest": "lib/demo/library.json"}],
        })
        self.write("lib/demo/library.json", {
            "schema": "circuitgit.library.v1",
            "id": "demo",
            "name": "Demo",
            "cells": [
                {
                    "id": "gain", "name": "Gain", "directory": "lib/demo/gain", "kind": "circuit",
                    "readme": "lib/demo/gain/README.md", "project_id": None, "requires_external_models": False,
                    "views": [{"id": "schematic", "kind": "rnl", "entry": "lib/demo/gain/schematic/gain.scs", "files": ["lib/demo/gain/schematic/gain.scs"]}],
                },
                {
                    "id": "top", "name": "Top", "directory": "lib/demo/top", "kind": "circuit",
                    "readme": "lib/demo/top/README.md", "project_id": None, "requires_external_models": False,
                    "views": [{"id": "schematic", "kind": "rnl", "entry": "lib/demo/top/schematic/top.scs", "files": ["lib/demo/top/schematic/top.scs"]}],
                },
                {
                    "id": "other", "name": "Other", "directory": "lib/demo/other", "kind": "circuit",
                    "readme": "lib/demo/other/README.md", "project_id": None, "requires_external_models": False,
                    "views": [{"id": "schematic", "kind": "rnl", "entry": "lib/demo/other/schematic/other.scs", "files": ["lib/demo/other/schematic/other.scs"]}],
                },
            ],
        })
        self.git("add", ".")
        self.git("commit", "-m", "Initial fixture")
        self.base = self.head()
        self.git("checkout", "-b", "codex/work")
        self.workflow = MOD.LibraryWorkflow(self.root, "fixture/circuits")

    def git(self, *args):
        p = subprocess.run(["git", "-C", str(self.root), *args], capture_output=True)
        self.assertEqual(p.returncode, 0, p.stderr.decode())
        return p.stdout

    def write(self, path, content):
        f = self.root / path
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(content, indent=2) + "\n" if isinstance(content, (dict, list)) else content)

    def head(self):
        return self.git("rev-parse", "HEAD").decode().strip()

    def test_create_library_create_cell_clone_cell_and_new_cell_pr(self):
        lib_res = self.workflow.execute(
            "create_library",
            {"library_id": "analog-blocks", "name": "Analog Blocks", "description": "Opamps and references", "base_commit": self.head()},
            "create-lib-001",
        )
        self.assertEqual(lib_res["state"], "complete")
        self.assertEqual(lib_res["library_id"], "analog-blocks")
        # Idempotent replay returns exact receipt.
        self.assertEqual(
            self.workflow.execute(
                "create_library",
                {"library_id": "analog-blocks", "name": "Analog Blocks", "description": "Opamps and references", "base_commit": self.base},
                "create-lib-001",
            ),
            lib_res,
        )

        cell_res = self.workflow.execute(
            "create_cell",
            {"library_id": "analog-blocks", "cell_id": "ota_two_stage", "name": "Two-Stage OTA", "base_commit": self.head()},
            "create-cell-001",
        )
        self.assertEqual(cell_res["state"], "complete")
        self.assertEqual(cell_res["entry"], "lib/analog-blocks/ota_two_stage/schematic/ota_two_stage.scs")
        desc = self.workflow.describe("analog-blocks", "ota_two_stage")
        self.assertTrue(desc["capabilities"]["create_cell"])
        self.assertTrue(desc["capabilities"]["create_branch"])

        # Clone the new cell into a second variant.
        clone_res = self.workflow.execute(
            "clone_cell",
            {
                "source_library_id": "analog-blocks",
                "source_cell_id": "ota_two_stage",
                "library_id": "analog-blocks",
                "cell_id": "ota_two_stage_v2",
                "base_commit": self.head(),
            },
            "clone-cell-001",
        )
        self.assertEqual(clone_res["state"], "complete")
        cat = self.workflow.catalog()
        ab = next(l for l in cat["libraries"] if l["id"] == "analog-blocks")
        self.assertEqual([c["id"] for c in ab["cells"]], ["ota_two_stage", "ota_two_stage_v2"])

        # Previewing a multi-cell PR covering both newly created cells + new library manifest succeeds!
        pr_preview = self.workflow.preview_pr(
            "analog-blocks",
            "ota_two_stage",
            self.head(),
            "Add analog-blocks library and OTA cells",
            related_cells=[{"library_id": "analog-blocks", "cell_id": "ota_two_stage_v2"}],
        )
        self.assertIn("lib/catalog.json", pr_preview["payload"]["files"])
        self.assertIn("lib/analog-blocks/library.json", pr_preview["payload"]["files"])
        self.assertEqual(
            pr_preview["payload"]["related_cells"],
            [{"library_id": "analog-blocks", "cell_id": "ota_two_stage_v2"}],
        )

    def test_branches_create_and_switch_with_dirty_guard(self):
        info = self.workflow.branches()
        self.assertEqual(info["current_branch"], "codex/work")
        self.assertFalse(info["dirty"])
        self.assertEqual({b["name"] for b in info["branches"]}, {"main", "codex/work"})

        created = self.workflow.execute(
            "create_branch",
            {"branch": "feat/new-topology", "base_commit": self.head(), "checkout": True},
            "branch-create-001",
        )
        self.assertEqual(created["state"], "complete")
        self.assertEqual(created["branch"], "feat/new-topology")
        self.assertEqual(self.workflow.branches()["current_branch"], "feat/new-topology")

        # Dirty working tree blocks branch switch so uncommitted edits cannot be lost.
        f = self.workflow.read_file("demo", "gain", "lib/demo/gain/schematic/gain.scs")
        self.workflow.execute(
            "save",
            {"library_id": "demo", "cell_id": "gain", "path": f["path"], "content": f["content"].replace("1k", "3k"), "base_sha256": f["sha256"]},
            "dirty-save-001",
        )
        with self.assertRaises(MOD.WorkflowError) as exc:
            self.workflow.execute(
                "switch_branch",
                {"branch": "codex/work", "base_commit": self.head()},
                "branch-switch-dirty",
            )
        self.assertEqual(exc.exception.code, "conflict")

        # Commit cleanly, then switch branch succeeds.
        self.workflow.execute(
            "commit",
            {"library_id": "demo", "cell_id": "gain", "base_commit": self.head(), "title": "Tune resistor"},
            "commit-clean-001",
        )
        switched = self.workflow.execute(
            "switch_branch",
            {"branch": "codex/work", "base_commit": self.head()},
            "branch-switch-clean",
        )
        self.assertEqual(switched["state"], "complete")
        self.assertEqual(self.workflow.branches()["current_branch"], "codex/work")

    def test_multi_cell_related_pr_and_out_of_scope_enforcement(self):
        # Edit both demo/gain and demo/top and commit each.
        f1 = self.workflow.read_file("demo", "gain", "lib/demo/gain/schematic/gain.scs")
        self.workflow.execute(
            "save",
            {"library_id": "demo", "cell_id": "gain", "path": f1["path"], "content": f1["content"].replace("1k", "4k"), "base_sha256": f1["sha256"]},
            "multi-save-1",
        )
        self.workflow.execute("commit", {"library_id": "demo", "cell_id": "gain", "base_commit": self.head(), "title": "Edit gain"}, "multi-commit-1")

        f2 = self.workflow.read_file("demo", "top", "lib/demo/top/schematic/top.scs")
        self.workflow.execute(
            "save",
            {"library_id": "demo", "cell_id": "top", "path": f2["path"], "content": f2["content"] + "// updated for gain\n", "base_sha256": f2["sha256"]},
            "multi-save-2",
        )
        self.workflow.execute("commit", {"library_id": "demo", "cell_id": "top", "base_commit": self.head(), "title": "Edit top"}, "multi-commit-2")

        # Without related_cells, single-cell PR must fail with out_of_scope (409).
        with self.assertRaises(MOD.WorkflowError) as exc:
            self.workflow.preview_pr("demo", "top", self.head(), "Single cell PR")
        self.assertEqual(exc.exception.code, "out_of_scope")

        # With explicit related_cells=[demo/gain], multi-cell PR succeeds!
        preview = self.workflow.preview_pr(
            "demo", "top", self.head(), "Coordinated gain + top update",
            related_cells=[{"library_id": "demo", "cell_id": "gain"}],
        )
        self.assertEqual(set(preview["payload"]["files"]), {
            "lib/demo/gain/schematic/gain.scs",
            "lib/demo/top/schematic/top.scs",
        })

        # Touching an undeclared 3rd cell must STILL fail out_of_scope.
        f3 = self.workflow.read_file("demo", "other", "lib/demo/other/schematic/other.scs")
        self.workflow.execute(
            "save",
            {"library_id": "demo", "cell_id": "other", "path": f3["path"], "content": f3["content"].replace("5k", "6k"), "base_sha256": f3["sha256"]},
            "multi-save-3",
        )
        self.workflow.execute("commit", {"library_id": "demo", "cell_id": "other", "base_commit": self.head(), "title": "Edit other"}, "multi-commit-3")
        with self.assertRaises(MOD.WorkflowError) as exc2:
            self.workflow.preview_pr(
                "demo", "top", self.head(), "Missing other in related_cells",
                related_cells=[{"library_id": "demo", "cell_id": "gain"}],
            )
        self.assertEqual(exc2.exception.code, "out_of_scope")

    def test_mcp_adapter_and_browser_library_bridges(self):
        svc = FakeService(self.root, self.workflow)
        br = library_adapter.call(svc, "ic_library_read", {"operation": "branches", "arguments": {}})
        self.assertEqual(br["current_branch"], "codex/work")

        res = library_adapter.call(svc, "ic_library_execute", {
            "operation": "create_cell",
            "arguments": {"library_id": "demo", "cell_id": "via_mcp", "base_commit": self.head()},
            "idempotency_key": "mcp-create-cell-001",
        })
        self.assertEqual(res["state"], "complete")
        self.assertEqual(res["cell_id"], "via_mcp")

        local = browser_library.LocalLibrary(self.workflow, FakePairing(), "http://127.0.0.1:8766")
        b_info = local.read("branches", {}, "ok-token", "http://127.0.0.1:8766")
        self.assertEqual(b_info["current_branch"], "codex/work")
        b_create = local.execute(
            "create_branch",
            {"branch": "feat/browser-branch", "base_commit": self.head(), "checkout": True},
            "browser-branch-001",
            "ok-token",
            "http://127.0.0.1:8766",
        )
        self.assertEqual(b_create["state"], "complete")
        self.assertEqual(self.workflow.branches()["current_branch"], "feat/browser-branch")


if __name__ == "__main__":
    unittest.main(verbosity=2)
