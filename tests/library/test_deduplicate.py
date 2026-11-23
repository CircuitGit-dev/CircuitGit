"""Canonicalization on disposable fixtures; no public data, renderer or Git writes."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("deduplicate", ROOT / "tools/library/deduplicate.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class DeduplicateTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="circuitgit-deduplicate-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.child = b'// native positions stay untouched\n// @USE-PACKAGE(name="eda-symbol", path="eda-symbol.rnl")\nsubckt Child a b\nR0 (a b) resistor r=1k\n// @PLACE(12, 34)\nends Child\n'
        self.parent = b'subckt Parent a b\nX1 (a b) Child\nends Parent\n'
        self.support = {"eda-style.rnl": b"// native drawing style\n", "eda-symbol.rnl": b'// @USE-PACKAGE(name="eda-style",path="eda-style.rnl")\n// drawing symbol\n'}
        self.orphan = b"subckt orphan a b\nends orphan\n"
        self.manifests = {}
        for lid in ("first", "variant"):
            self.manifests[lid] = {"schema": "circuitgit.library.v1", "id": lid, "name": lid, "cells": []}
            names = ("Parent", "Child") if lid == "first" else ("Child",)
            for name in names:
                sources = {**self.support, "Child.scs": self.child, "orphan.scs": self.orphan}
                if name == "Parent": sources["Parent.scs"] = self.parent
                sources["view-" + name + ".scs"] = ('simulator lang=spectre\n' + ''.join('include "' + n + '"\n' for n in sources if n.endswith('.scs'))).encode()
                self.add_cell(lid, name, sources)
        self.flush()

    def write(self, path, raw):
        file = self.root / path; file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(raw if isinstance(raw, bytes) else MOD.dump(raw))

    def add_cell(self, lid, name, sources, source_prefix="projects/export/native"):
        directory = "lib/" + lid + "/" + name
        rows = []
        for filename, raw in sources.items():
            path = directory + "/schematic/" + filename
            self.write(path, raw)
            rows.append({"path": path, "source": source_prefix + "/" + filename, "source_sha256": MOD.digest(raw),
                         "sha256": MOD.digest(raw), "bytes": len(raw), "transformation": "none"})
        self.write(directory + "/README.md", b"# Test fixture\n")
        self.write(directory + "/docs/provenance.json", {"source_cell": {"library": "export", "cell": name, "view": "schematic"}, "files": rows})
        self.manifests[lid]["cells"].append({"id": name, "name": name, "directory": directory, "readme": directory + "/README.md",
            "kind": "circuit", "project_id": None, "requires_external_models": False,
            "views": [{"id": "schematic", "kind": "rnl", "entry": directory + "/schematic/view-" + name + ".scs",
                       "level": name, "files": [row["path"] for row in rows]}]})

    def flush(self):
        self.write("lib/catalog.json", {"schema": "circuitgit.libraries.v1", "libraries": [
            {"id": lid, "name": lid, "manifest": "lib/" + lid + "/library.json"} for lid in self.manifests]})
        for lid, manifest in self.manifests.items(): self.write("lib/" + lid + "/library.json", manifest)

    def test_plan_preserves_inputs_and_targets_existing_cell_owner(self):
        originals = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        plan = MOD.make_plan(self.root); report = plan["outputs"][MOD.REPORT]
        self.assertEqual(report["summary"]["rnl_views"], 3)
        self.assertLess(report["summary"]["files_after"], report["summary"]["files_before"])
        parent_child = "lib/first/Parent/schematic/Child.scs"
        child = "lib/first/Child/schematic/Child.scs"
        self.assertEqual(report["mapping"][parent_child]["canonical"], child)
        self.assertEqual(report["mapping"][child]["canonical"], child)
        self.assertEqual(report["mapping"]["lib/variant/Child/schematic/Child.scs"]["canonical"], "lib/variant/Child/schematic/Child.scs")
        for path, raw in originals.items(): self.assertEqual((self.root / path).read_bytes(), raw)
        self.assertFalse((self.root / MOD.REPORT).exists())

    def test_apply_materializes_identical_views_and_parent_sees_child_edit(self):
        plan = MOD.make_plan(self.root)
        provenance = {p: p.read_bytes() for p in self.root.rglob("provenance.json")}
        original_entries = [v["entry"] for m in self.manifests.values() for c in m["cells"] for v in c["views"]]
        result = MOD.apply_plan(self.root, plan)
        self.assertEqual(result["state"], "applied")
        self.assertEqual(result["verified_rnl_views"], 3)
        self.assertEqual(MOD.apply_plan(self.root, plan)["state"], "already-applied")
        for path, raw in provenance.items(): self.assertEqual(path.read_bytes(), raw)
        for path in original_entries: self.assertTrue((self.root / path).is_file())
        manifest = json.loads((self.root / "lib/first/library.json").read_bytes())
        view = manifest["cells"][0]["views"][0]
        snapshot = MOD.view_snapshot(self.root, view)
        parent_child = "lib/first/Parent/schematic/Child.scs"
        child = "lib/first/Child/schematic/Child.scs"
        self.assertFalse((self.root / parent_child).exists())
        self.assertEqual(snapshot[parent_child], self.child)
        # Both canonical-file relative dependencies and old logical paths are present.
        self.assertIn("lib/first/Child/schematic/eda-symbol.rnl", view["aliases"])
        symbol = view["aliases"]["lib/first/Child/schematic/eda-symbol.rnl"]
        self.assertIn(str(Path(symbol).parent / "eda-style.rnl"), view["aliases"])
        changed = self.child.replace(b"r=1k", b"r=2k")
        self.write(child, changed)
        self.assertEqual(MOD.view_snapshot(self.root, view)[parent_child], changed)

    def test_no_owner_dependency_is_library_scoped_and_support_is_global(self):
        report = MOD.make_plan(self.root)["outputs"][MOD.REPORT]
        first = report["mapping"]["lib/first/Parent/schematic/orphan.scs"]["canonical"]
        self.assertTrue(first.startswith("lib/first/_shared/native/"))
        self.assertEqual(report["mapping"]["lib/first/Child/schematic/orphan.scs"]["canonical"], first)
        self.assertNotEqual(report["mapping"]["lib/variant/Child/schematic/orphan.scs"]["canonical"], first)
        support = {row["canonical"] for old, row in report["mapping"].items() if old.endswith("/eda-symbol.rnl")}
        self.assertEqual(len(support), 1)
        self.assertTrue(next(iter(support)).startswith("lib/_shared/rnl/"))
        self.assertEqual(report["summary"]["readonly_unregistered_groups"], 1)

    def test_same_bytes_with_different_source_identity_are_not_merged(self):
        path = self.root / "lib/first/Parent/docs/provenance.json"
        provenance = json.loads(path.read_bytes())
        next(row for row in provenance["files"] if row["path"].endswith("/Child.scs"))["source"] = "projects/other/native/Child.scs"
        path.write_bytes(MOD.dump(provenance))
        report = MOD.make_plan(self.root)["outputs"][MOD.REPORT]
        original = "lib/first/Parent/schematic/Child.scs"
        self.assertEqual(report["mapping"][original]["canonical"], original)

    def test_primary_dependency_entry_and_registered_owner_are_both_preserved(self):
        # A display can enter a dependency directly. That does not move authority
        # away from its registered Child cell or permit deleting the display entry.
        parent = self.manifests["first"]["cells"][0]["views"][0]
        parent["entry"] = "lib/first/Parent/schematic/Child.scs"
        self.flush()
        plan = MOD.make_plan(self.root); mapping = plan["outputs"][MOD.REPORT]["mapping"]
        canonical = "lib/first/Child/schematic/Child.scs"
        self.assertEqual(mapping[canonical]["canonical"], canonical)
        self.assertEqual(mapping[parent["entry"]]["canonical"], parent["entry"])
        MOD.apply_plan(self.root, plan)
        self.assertTrue((self.root / canonical).is_file())
        self.assertTrue((self.root / parent["entry"]).is_file())

    def test_byte_variants_of_support_keep_distinct_canonical_paths(self):
        path = "lib/variant/Child/schematic/eda-style.rnl"
        raw = b"// different style\n"; self.write(path, raw)
        provenance_path = self.root / "lib/variant/Child/docs/provenance.json"
        provenance = json.loads(provenance_path.read_bytes())
        row = next(row for row in provenance["files"] if row["path"] == path)
        row.update(sha256=MOD.digest(raw), source_sha256=MOD.digest(raw), bytes=len(raw))
        provenance_path.write_bytes(MOD.dump(provenance))
        plan = MOD.make_plan(self.root)
        mappings = plan["outputs"][MOD.REPORT]["mapping"]
        self.assertNotEqual(mappings[path]["canonical"], mappings["lib/first/Child/schematic/eda-style.rnl"]["canonical"])
        MOD.apply_plan(self.root, plan)
        self.assertEqual(MOD.verify(self.root, plan["outputs"][MOD.REPORT])["verified_rnl_views"], 3)

    def test_source_mutation_after_plan_stops_before_data_migration(self):
        plan = MOD.make_plan(self.root)
        self.write("lib/first/Child/schematic/Child.scs", b"// changed source\n")
        with self.assertRaisesRegex(ValueError, "Source changed after plan"):
            MOD.apply_plan(self.root, plan)
        self.assertFalse((self.root / MOD.REPORT).exists())
        self.assertTrue((self.root / "lib/first/Parent/schematic/Child.scs").exists())

    def test_alias_shadow_and_unlisted_target_are_rejected(self):
        a, b = "lib/first/Child/schematic/Child.scs", "lib/first/Child/schematic/orphan.scs"
        with self.assertRaisesRegex(ValueError, "shadows"):
            MOD.view_snapshot(self.root, {"entry": a, "files": [a, b], "aliases": {a: b}})
        with self.assertRaisesRegex(ValueError, "not a physical"):
            MOD.view_snapshot(self.root, {"entry": a, "files": [a], "aliases": {b: b}})

    def test_write_failure_restores_original_files_and_manifest(self):
        plan = MOD.make_plan(self.root)
        before = {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        original = MOD.atomic_write; counter = [0]
        def write(root, path, raw):
            counter[0] += 1
            if counter[0] == 2: raise OSError("Synthetic migration failure")
            original(root, path, raw)
        with patch.object(MOD, "atomic_write", side_effect=write), self.assertRaises(OSError):
            MOD.apply_plan(self.root, plan)
        for path, raw in before.items(): self.assertEqual((self.root / path).read_bytes(), raw)
        self.assertFalse((self.root / MOD.REPORT).exists())
        result = json.loads((self.root / ".local/library-deduplicate" / plan["plan_id"] / "result.json").read_bytes())
        self.assertEqual(result["state"], "rolled-back")

    def test_electrical_audit_does_not_claim_equivalence_for_changed_parameter(self):
        original = MOD.electrical_blocks(self.child)["Child"]
        geometry_only = MOD.electrical_blocks(self.child.replace(b"@PLACE(12, 34)", b"@PLACE(56, 78)"))["Child"]
        changed = MOD.electrical_blocks(self.child.replace(b"r=1k", b"r=2k"))["Child"]
        self.assertEqual(original["token_sha256"], geometry_only["token_sha256"])
        self.assertNotEqual(original["token_sha256"], changed["token_sha256"])

    def test_bus_mapping_audit_proves_token_or_statement_identity_and_rejects_collision(self):
        simulation = MOD.electrical_blocks(b'subckt Bus D\\<1\\> D\\<0\\>\nR1 (D\\<1\\> 0) resistor r=1k\nR0 (D\\<0\\> 0) resistor r=2k\nends Bus\n')["Bus"]
        native = MOD.electrical_blocks(b'subckt Bus D_1 D_0\nR1 (D_1 0) resistor r=1k\nR0 (D_0 0) resistor r=2k\nends Bus\n')["Bus"]
        audit = MOD.bus_rename_audit(simulation, native)
        self.assertEqual(audit["status"], "exact-tokens-after-bus-renaming")
        self.assertEqual(audit["identifiers"], {'D\\<0\\>': 'D_0', 'D\\<1\\>': 'D_1'})
        reordered = MOD.electrical_blocks(b'subckt Bus D_1 D_0\nR0 (D_0 0) resistor r=2k\nR1 (D_1 0) resistor r=1k\nends Bus\n')["Bus"]
        self.assertEqual(MOD.bus_rename_audit(simulation, reordered)["status"], "same-statements-after-bus-renaming")
        collision = MOD.electrical_blocks(b'subckt Bus D\\<1\\> D_1\nR0 (D\\<1\\> D_1) resistor r=2k\nends Bus\n')["Bus"]
        self.assertEqual(MOD.bus_rename_audit(collision, native)["status"], "identifier-collision")


if __name__ == "__main__":
    unittest.main()
