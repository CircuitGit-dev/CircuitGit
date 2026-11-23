"""Synthetic public-library packaging checks; no engineering data or live services.

Run: python3 -B tests/library/test_build_library.py
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("circuitgit_build_library", ROOT / "tools/dev/build_library.py")
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class BuildLibraryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="circuitgit-library-test-")
        self.addCleanup(temporary.cleanup)
        self.temp = Path(temporary.name)
        self.root = self.temp / "repo"
        self.output = self.temp / "site"
        self.root.mkdir()
        self.directory = "lib/fixture/gain"
        self.entry = self.directory + "/netlist/gain.scs"
        self.dependency = self.directory + "/netlist/device.scs"
        self.catalog = {
            "schema": "circuitgit.libraries.v1",
            "libraries": [{"id": "fixture", "name": "Fixture library", "description": "Synthetic only",
                           "manifest": "lib/fixture/library.json"}],
        }
        self.library = {
            "schema": "circuitgit.library.v1", "id": "fixture", "name": "Fixture library",
            "description": "Synthetic packaging fixture, not simulation evidence",
            "cells": [{"id": "gain", "name": "Gain cell", "kind": "circuit", "directory": self.directory,
                       "readme": self.directory + "/README.md", "project_id": None,
                       "requires_external_models": False,
                       "views": [{"id": "netlist", "label": "Netlist", "kind": "spectre",
                                  "entry": self.entry, "files": [self.entry, self.dependency]}]}],
        }
        self.write("lib/README.md", "# Synthetic public circuit library\n")
        self.write(self.directory + "/README.md", "# Gain cell\nFixture data only; no simulator was run.\n")
        self.write(self.entry, 'simulator lang=spectre\ninclude "device.scs"\n')
        self.write(self.dependency, "subckt gain in out\nR0 (in out) resistor r=1000\nends gain\n")
        self.save()

    @property
    def cell(self):
        return self.library["cells"][0]

    @property
    def view(self):
        return self.cell["views"][0]

    def write(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        target.write_bytes(value if isinstance(value, bytes) else value.encode("utf-8"))
        return target

    def save(self):
        self.write("lib/catalog.json", self.catalog)
        self.write("lib/fixture/library.json", self.library)

    def inventory(self, directory):
        return {p.relative_to(directory).as_posix(): p.read_bytes()
                for p in directory.rglob("*") if p.is_file()}

    def test_collect_reports_exact_sorted_inventory_and_source_hashes(self):
        report = BUILD.collect(self.root)
        expected = {"lib/catalog.json", "lib/README.md", "lib/fixture/library.json",
                    self.directory + "/README.md", self.entry, self.dependency}
        self.assertEqual(report["schema"], "circuitgit.library-build.v1")
        self.assertEqual((report["libraries"], report["cells"], report["views"]), (1, 1, 1))
        self.assertEqual([item["path"] for item in report["files"]], sorted(expected))
        for item in report["files"]:
            data = (self.root / item["path"]).read_bytes()
            self.assertEqual(item["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual(item["bytes"], len(data))
        self.assertEqual(report["bytes"], sum(item["bytes"] for item in report["files"]))

    def test_publish_copies_only_indexed_closure_and_never_scans_private_neighbors(self):
        self.write(self.directory + "/private/site.local.json", {"password": "synthetic-private-value"})
        self.write(self.directory + "/netlist/unlisted.scs", "// unpublished fixture neighbor\n")
        self.write("projects/unlisted/runtime.json", {"state": "not-public"})
        self.write("lib/not-indexed/library.json", {"schema": "not-a-public-library"})
        before = self.inventory(self.root)
        report = BUILD.publish(self.root, self.output)
        actual = self.inventory(self.output / "library-files")
        expected = {item["path"]: before[item["path"]] for item in report["files"]}
        self.assertEqual(actual, expected)
        self.assertEqual(self.inventory(self.root), before, "Publication must not mutate circuit source bytes")

    def test_explicit_shared_and_legacy_rc_sources_are_allowed_and_deduplicated(self):
        shared = "lib/reusable/resistor/netlist/resistor.scs"
        legacy = "projects/rc-smoke/circuit.scs"
        self.write(shared, "// shared synthetic primitive\n")
        self.write(legacy, "// original legacy RC source remains in projects\n")
        self.view["files"].append(shared)
        self.cell["project_id"] = "rc-smoke"
        self.cell["views"].append({"id": "simulation", "label": "Legacy RC", "kind": "spectre",
                                   "entry": legacy, "files": [legacy, shared]})
        self.save()
        original = (self.root / legacy).read_bytes()
        report = BUILD.publish(self.root, self.output)
        paths = [item["path"] for item in report["files"]]
        self.assertEqual(paths.count(shared), 1)
        self.assertEqual(report["views"], 2)
        self.assertEqual((self.output / "library-files" / legacy).read_bytes(), original)
        self.assertEqual((self.root / legacy).read_bytes(), original)
        self.assertEqual({p for p in paths if p.endswith("circuit.scs")}, {legacy})

    def test_absent_and_empty_catalogs_remain_supported(self):
        absent = self.temp / "legacy-repo"
        absent.mkdir()
        report = BUILD.publish(absent, self.output)
        self.assertEqual(report, {"schema": "circuitgit.library-build.v1", "libraries": 0,
                                  "cells": 0, "views": 0, "files": [], "bytes": 0})
        self.catalog["libraries"] = []
        self.save()
        report = BUILD.collect(self.root)
        self.assertEqual((report["libraries"], report["cells"], report["views"]), (0, 0, 0))
        self.assertEqual([item["path"] for item in report["files"]], ["lib/README.md", "lib/catalog.json"])

    def test_library_cell_and_readme_identities_cannot_be_substituted(self):
        original_catalog, original_library = copy.deepcopy(self.catalog), copy.deepcopy(self.library)
        cases = ("manifest", "library-id", "cell-directory", "cell-readme")
        for case in cases:
            with self.subTest(case=case):
                self.catalog, self.library = copy.deepcopy(original_catalog), copy.deepcopy(original_library)
                if case == "manifest":
                    self.catalog["libraries"][0]["manifest"] = "lib/other/library.json"
                elif case == "library-id":
                    self.library["id"] = "other"
                elif case == "cell-directory":
                    self.cell["directory"] = "lib/fixture/other"
                else:
                    self.cell["readme"] = "lib/fixture/other/README.md"
                self.save()
                with self.assertRaises(ValueError):
                    BUILD.collect(self.root)

    def test_missing_listed_dependencies_and_entries_outside_closure_are_rejected(self):
        (self.root / self.dependency).unlink()
        with self.assertRaisesRegex(ValueError, "Missing library file"):
            BUILD.collect(self.root)
        self.write(self.dependency, "// restored synthetic dependency\n")
        self.view["files"] = [self.dependency]
        self.save()
        with self.assertRaisesRegex(ValueError, "closure"):
            BUILD.collect(self.root)

    def test_traversal_absolute_url_encoded_and_windows_inventory_paths_are_rejected(self):
        paths = ["lib/fixture/../outside.scs", "lib/fixture/./outside.scs", "lib//outside.scs",
                 "/etc/fixture.scs", "https://example.invalid/fixture.scs", "file:///tmp/fixture.scs",
                 "lib/fixture/%2e%2e/outside.scs", "C:\\fixture\\circuit.scs", "lib\\fixture\\circuit.scs",
                 "lib/fixture/gain/source.scs?download=1", "lib/fixture/gain/source.scs#fragment",
                 "lib/fixture/gain/line\nfeed.scs", "lib/fixture/gain/control\x7f.scs"]
        for path in paths:
            with self.subTest(path=path):
                self.view["files"] = [self.entry, self.dependency, path]
                self.save()
                with self.assertRaisesRegex(ValueError, "Invalid library path"):
                    BUILD.collect(self.root)

    def test_explicit_private_runtime_and_machine_setting_files_are_rejected(self):
        paths = ["lib/fixture/gain/private/data.json", "lib/fixture/gain/PDKs/model.scs",
                 "lib/fixture/gain/psf/results.txt", "lib/fixture/gain/ahdlsimdb/data.json",
                 "lib/fixture/gain/node_modules/package.json", "lib/fixture/gain/.state/record.json",
                 "lib/fixture/gain/site.local.json"]
        for path in paths:
            with self.subTest(path=path):
                self.write(path, "{}\n")
                self.view["files"] = [self.entry, self.dependency, path]
                self.save()
                with self.assertRaises(ValueError):
                    BUILD.collect(self.root)

    def test_source_file_parent_and_catalog_symlinks_are_rejected(self):
        original = (self.root / self.dependency).read_bytes()
        external = self.temp / "external.scs"
        external.write_bytes(original)
        dependency = self.root / self.dependency
        dependency.unlink()
        dependency.symlink_to(external)
        with self.assertRaisesRegex(ValueError, "symlink"):
            BUILD.collect(self.root)
        dependency.unlink()
        dependency.write_bytes(original)
        alias = self.root / "lib/fixture/gain/alias"
        alias.symlink_to(dependency.parent, target_is_directory=True)
        self.view["files"].append("lib/fixture/gain/alias/device.scs")
        self.save()
        with self.assertRaisesRegex(ValueError, "symlink"):
            BUILD.collect(self.root)
        alias.unlink()
        self.view["files"].pop()
        self.save()
        catalog = self.root / "lib/catalog.json"
        catalog.unlink()
        catalog.symlink_to(self.temp / "absent-catalog.json")
        with self.assertRaisesRegex(ValueError, "symlink"):
            BUILD.collect(self.root)
        dangling_root = self.temp / "dangling-library-repo"
        dangling_root.mkdir()
        (dangling_root / "lib").symlink_to(self.temp / "absent-library", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            BUILD.collect(dangling_root)

    def test_credentials_and_private_machine_paths_in_text_or_metadata_are_rejected(self):
        examples = ["-----BEGIN PRIVATE KEY-----\nsynthetic-only\n-----END PRIVATE KEY-----",
                    "ghp_" + "0" * 36, "github_pat_" + "0" * 40, "sk-" + "0" * 30,
                    "https://fixture:synthetic-password@example.invalid/source",
                    "/Users/fixture/private/project/circuit.scs", "/home/fixture/private/circuit.scs"]
        for value in examples:
            with self.subTest(location="source", example=value[:30]):
                self.write(self.dependency, "// " + value + "\n")
                with self.assertRaisesRegex(ValueError, "Private credentials or machine paths"):
                    BUILD.collect(self.root)
        self.write(self.dependency, "// synthetic public dependency\n")
        self.catalog["libraries"][0]["description"] = "/Users/fixture/private/source"
        self.save()
        with self.assertRaisesRegex(ValueError, "Private credentials or machine paths"):
            BUILD.collect(self.root)

    def test_duplicate_library_cell_view_and_file_ids_are_rejected(self):
        original_catalog, original_library = copy.deepcopy(self.catalog), copy.deepcopy(self.library)
        for case in ("library", "cell", "view", "file"):
            with self.subTest(case=case):
                self.catalog, self.library = copy.deepcopy(original_catalog), copy.deepcopy(original_library)
                if case == "library":
                    self.catalog["libraries"].append(copy.deepcopy(self.catalog["libraries"][0]))
                elif case == "cell":
                    self.library["cells"].append(copy.deepcopy(self.cell))
                elif case == "view":
                    self.cell["views"].append(copy.deepcopy(self.view))
                else:
                    self.view["files"].append(self.entry)
                self.save()
                with self.assertRaises(ValueError):
                    BUILD.collect(self.root)

    def test_malformed_catalog_and_library_objects_fail_with_validation_errors(self):
        for value in ([], "not-an-object", None, 42):
            with self.subTest(location="catalog", value=value):
                self.write("lib/catalog.json", json.dumps(value))
                with self.assertRaises(ValueError):
                    BUILD.collect(self.root)
            self.write("lib/catalog.json", self.catalog)
            with self.subTest(location="library", value=value):
                self.write("lib/fixture/library.json", json.dumps(value))
                with self.assertRaises(ValueError):
                    BUILD.collect(self.root)
            self.write("lib/fixture/library.json", self.library)

    def test_invalid_publication_does_not_replace_existing_output(self):
        BUILD.publish(self.root, self.output)
        before = self.inventory(self.output)
        self.write(self.dependency, "// /Users/fixture/private/model.scs\n")
        with self.assertRaises(ValueError):
            BUILD.publish(self.root, self.output)
        self.assertEqual(self.inventory(self.output), before)

    def test_republication_removes_stale_library_files_but_preserves_application_assets(self):
        BUILD.publish(self.root, self.output)
        application = self.output / "application.js"
        application.write_text("// unrelated generated application asset\n")
        stale = self.output / "library-files/lib/previous/unlisted.txt"
        stale.parent.mkdir(parents=True)
        stale.write_text("not in the current public inventory\n")
        self.cell["views"] = [{"id": "docs", "label": "Documentation", "kind": "markdown",
                               "entry": self.cell["readme"], "files": [self.cell["readme"]]}]
        self.save()
        report = BUILD.publish(self.root, self.output)
        self.assertEqual(set(self.inventory(self.output / "library-files")),
                         {item["path"] for item in report["files"]})
        self.assertEqual(application.read_text(), "// unrelated generated application asset\n")

    def test_publication_rejects_symlink_destination_without_writing_through_it(self):
        external = self.temp / "external-output"
        external.mkdir()
        self.output.mkdir()
        (self.output / "library-files").symlink_to(external, target_is_directory=True)
        with self.assertRaises(ValueError):
            BUILD.publish(self.root, self.output)
        self.assertEqual(self.inventory(external), {})


if __name__ == "__main__":
    unittest.main()
