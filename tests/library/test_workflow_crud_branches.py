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

    def test_live_server_library_http_endpoints(self):
        import io
        from types import SimpleNamespace
        import server as wb_server

        ws = SimpleNamespace(root=self.root, branch="codex/work")
        app = SimpleNamespace(
            cfg={"onboarding_only": False, "local_only": True},
            workspace=ws,
            library=self.workflow,
            ai=None,
            web=self.root,
            token="live-token-123",
            site={},
            spiceowl_reads=SimpleNamespace(enabled=False),
            onboarding=SimpleNamespace(enabled=False),
        )

        def call_get(path):
            handler = object.__new__(wb_server.Handler)
            handler.server = SimpleNamespace(server_port=18765, app=app)
            handler.headers = {"Host": "127.0.0.1:18765"}
            handler.path = path
            captured = []
            handler.send = lambda status, data, *args, **kwargs: captured.append((status, data))
            handler.do_GET()
            return captured[0]

        def call_post(path, payload, token="live-token-123"):
            raw = json.dumps(payload).encode("utf-8")
            handler = object.__new__(wb_server.Handler)
            handler.server = SimpleNamespace(server_port=18765, app=app)
            handler.headers = {
                "Host": "127.0.0.1:18765",
                "Origin": "http://127.0.0.1:18765",
                "Content-Type": "application/json",
                "Content-Length": str(len(raw)),
                "X-Workbench-Token": token,
            }
            handler.path = path
            handler.rfile = io.BytesIO(raw)
            captured = []
            handler.send = lambda status, data, *args, **kwargs: captured.append((status, data))
            handler.do_POST()
            return captured[0]

        as_json = lambda data: data if isinstance(data, dict) else json.loads(data)

        status, body = call_get("/api/health")
        self.assertEqual(status, 200)
        health = as_json(body)
        self.assertTrue(health["data"]["capabilities"]["library_workflow"])

        status, body = call_get("/api/library/files/lib/catalog.json")
        self.assertEqual(status, 200)
        self.assertEqual(as_json(body)["schema"], "circuitgit.libraries.v1")

        status, _ = call_get("/api/library/files/../.git/config")
        self.assertEqual(status, 400)

        status, body = call_post("/api/library/read", {"operation": "capability", "args": {}})
        self.assertEqual(status, 200)
        cap = as_json(body)["data"]
        self.assertTrue(cap["available"])
        self.assertIn("branches", cap["operations"])
        self.assertIn("create_branch", cap["operations"])

        status, body = call_post("/api/library/read", {"operation": "branches", "args": {}})
        self.assertEqual(status, 200)
        self.assertEqual(as_json(body)["data"]["current_branch"], "codex/work")

        status, _ = call_post("/api/library/execute", {"operation": "create_branch", "args": {"branch": "feat/bad", "base_commit": self.head(), "checkout": True}, "idempotency_key": "bad-tok-001"}, token="wrong")
        self.assertEqual(status, 403)

        status, body = call_post(
            "/api/library/execute",
            {
                "operation": "create_branch",
                "args": {"branch": "feat/live-branch", "base_commit": self.head(), "checkout": True},
                "idempotency_key": "live-branch-001",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(as_json(body)["data"]["state"], "complete")
        self.assertEqual(ws.branch, "feat/live-branch")
        self.assertEqual(self.workflow.branches()["current_branch"], "feat/live-branch")

        status, body = call_post(
            "/api/library/execute",
            {
                "operation": "create_library",
                "args": {"library_id": "live-lib", "name": "Live Library", "base_commit": self.head()},
                "idempotency_key": "live-lib-001",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(as_json(body)["data"]["library_id"], "live-lib")

        status, body = call_post(
            "/api/library/execute",
            {
                "operation": "create_view",
                "args": {"library_id": "demo", "cell_id": "gain", "view_id": "netlist", "base_commit": self.head()},
                "idempotency_key": "live-view-001",
            },
        )
        self.assertEqual(status, 200)
        view_data = as_json(body)["data"]
        self.assertEqual(view_data["state"], "complete")
        self.assertEqual(view_data["view_id"], "netlist")
        self.assertEqual(view_data["entry"], "lib/demo/gain/netlist/gain.scs")

    def test_create_view_workflow_guards_pr_and_bridges(self):
        desc0 = self.workflow.describe("demo", "gain")
        self.assertTrue(desc0["capabilities"]["create_view"])

        # 1. Create symbol, veriloga, simulation, and docs views on existing cell demo/gain.
        sym_base = self.head()
        sym_res = self.workflow.execute(
            "create_view",
            {"library_id": "demo", "cell_id": "gain", "view_id": "symbol", "base_commit": sym_base, "level": "GAIN_SYM"},
            "create-view-sym-001",
        )
        self.assertEqual(sym_res["state"], "complete")
        self.assertEqual(sym_res["view_id"], "symbol")
        self.assertEqual(sym_res["entry"], "lib/demo/gain/symbol/gain.rnl")
        self.assertEqual(sym_res["view"]["level"], "GAIN_SYM")
        # Idempotent replay with the original request args returns exact receipt.
        self.assertEqual(
            self.workflow.execute(
                "create_view",
                {"library_id": "demo", "cell_id": "gain", "view_id": "symbol", "base_commit": sym_base, "level": "GAIN_SYM"},
                "create-view-sym-001",
            ),
            sym_res,
        )

        va_res = self.workflow.execute(
            "create_view",
            {"library_id": "demo", "cell_id": "gain", "view_id": "veriloga", "label": "Behavioral VA", "base_commit": self.head()},
            "create-view-va-001",
        )
        self.assertEqual(va_res["entry"], "lib/demo/gain/veriloga/gain.va")
        self.assertIn("module gain(", (self.root / va_res["entry"]).read_text(encoding="utf-8"))

        sim_res = self.workflow.execute(
            "create_view",
            {"library_id": "demo", "cell_id": "gain", "view_id": "simulation", "base_commit": self.head()},
            "create-view-sim-001",
        )
        self.assertEqual(sim_res["entry"], "lib/demo/gain/simulation/config.json")

        # 2. Verify describe() and catalog() reflect new editable views.
        desc = self.workflow.describe("demo", "gain")
        editable_by_path = {f["path"]: f["editable"] for f in desc["files"]}
        self.assertTrue(editable_by_path["lib/demo/gain/symbol/gain.rnl"])
        self.assertTrue(editable_by_path["lib/demo/gain/veriloga/gain.va"])
        self.assertTrue(editable_by_path["lib/demo/gain/simulation/config.json"])
        gain_cat = next(c for c in self.workflow.catalog()["libraries"][0]["cells"] if c["id"] == "gain")
        self.assertEqual([v["id"] for v in gain_cat["views"]], ["schematic", "symbol", "veriloga", "simulation"])

        # 3. Verify build_library.collect accepts the updated repo including veriloga view.
        spec = importlib.util.spec_from_file_location("circuitgit_build_library", ROOT / "tools/dev/build_library.py")
        build_lib = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build_lib)
        report = build_lib.collect(self.root)
        self.assertGreaterEqual(report["views"], 6)

        # 4. Cell-scoped PR succeeds for existing cell demo/gain after create_view, while editing another cell stays out_of_scope.
        pr_preview = self.workflow.preview_pr("demo", "gain", self.head(), "Add symbol/veriloga/simulation views to gain")
        self.assertIn("lib/demo/library.json", pr_preview["payload"]["files"])
        self.assertIn("lib/demo/gain/veriloga/gain.va", pr_preview["payload"]["files"])

        f_other = self.workflow.read_file("demo", "other", "lib/demo/other/schematic/other.scs")
        self.workflow.execute(
            "save",
            {"library_id": "demo", "cell_id": "other", "path": f_other["path"], "content": f_other["content"].replace("5k", "6k"), "base_sha256": f_other["sha256"]},
            "view-other-save",
        )
        self.workflow.execute("commit", {"library_id": "demo", "cell_id": "other", "base_commit": self.head(), "title": "Edit other"}, "view-other-commit")
        with self.assertRaises(MOD.WorkflowError) as out_exc:
            self.workflow.preview_pr("demo", "gain", self.head(), "Should fail when other cell changed")
        self.assertEqual(out_exc.exception.code, "out_of_scope")

        # 5. Validation and conflict guards.
        for bad_args, expected_code in [
            ({"library_id": "demo", "cell_id": "gain", "view_id": "symbol", "base_commit": self.head()}, "conflict"),
            ({"library_id": "demo", "cell_id": "gain", "view_id": "netlist", "base_commit": self.base}, "conflict"),
            ({"library_id": "demo", "cell_id": "gain", "view_id": "unknown", "base_commit": self.head()}, "invalid_request"),
            ({"library_id": "demo", "cell_id": "gain", "view_id": "netlist", "kind": "json", "base_commit": self.head()}, "invalid_request"),
            ({"library_id": "demo", "cell_id": "gain", "view_id": "netlist", "filename": "../evil.scs", "base_commit": self.head()}, "invalid_request"),
            ({"library_id": "demo", "cell_id": "gain", "view_id": "netlist", "filename": "wrong.va", "base_commit": self.head()}, "invalid_request"),
            ({"library_id": "demo", "cell_id": "gain", "view_id": "netlist", "level": "TOP", "base_commit": self.head()}, "invalid_request"),
            ({"library_id": "demo", "cell_id": "gain", "view_id": "docs", "filename": "bad.md", "base_commit": "0" * 40}, "conflict"),
        ]:
            with self.subTest(bad_args=bad_args), self.assertRaises(MOD.WorkflowError) as err:
                self.workflow.preview_create_view(**bad_args)
            self.assertEqual(err.exception.code, expected_code)

        # Simulation view rejects non-object JSON.
        self.workflow.execute(
            "create_view",
            {"library_id": "demo", "cell_id": "top", "view_id": "netlist", "base_commit": self.head()},
            "create-view-top-net",
        )
        with self.assertRaises(MOD.WorkflowError) as json_err:
            self.workflow.preview_create_view("demo", "top", "simulation", self.head(), content="[1, 2, 3]")
        self.assertEqual(json_err.exception.code, "invalid_json")

        # 6. MCP adapter and browser_library bridges both expose and execute create_view.
        svc = FakeService(self.root, self.workflow)
        cap = library_adapter.call(svc, "ic_library_read", {"operation": "capability", "arguments": {}})
        self.assertIn("create_view", cap["operations"])
        mcp_res = library_adapter.call(svc, "ic_library_execute", {
            "operation": "create_view",
            "arguments": {"library_id": "demo", "cell_id": "top", "view_id": "docs", "filename": "notes.md", "base_commit": self.head()},
            "idempotency_key": "mcp-create-view-001",
        })
        self.assertEqual(mcp_res["state"], "complete")
        self.assertEqual(mcp_res["entry"], "lib/demo/top/docs/notes.md")

        local = browser_library.LocalLibrary(self.workflow, FakePairing(), "http://127.0.0.1:8766")
        b_cap = local.read("capability", {}, "ok-token", "http://127.0.0.1:8766")
        self.assertIn("create_view", b_cap["execute_operations"])
        b_res = local.execute(
            "create_view",
            {"library_id": "demo", "cell_id": "other", "view_id": "simulation", "base_commit": self.head()},
            "browser-create-view-001",
            "ok-token",
            "http://127.0.0.1:8766",
        )
        self.assertEqual(b_res["state"], "complete")
        self.assertEqual(b_res["view_id"], "simulation")


if __name__ == "__main__":
    unittest.main(verbosity=2)
