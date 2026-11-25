from collections import OrderedDict
from threading import RLock
"""Read-only, committed native geometry. This module never invokes an exporter.

Integrity, electrical freshness and the owner's fidelity attestation are separate.
Only the installed project registry selects a manifest. Repository data is never code.
"""
import hashlib
import json
import os
import re
import subprocess
from pathlib import PurePosixPath
from urllib.parse import urlencode

from runner import locked
from workspace import Conflict, project_path, project_metadata

MANIFEST_BYTES = 1024 * 1024
FILE_BYTES = 2 * 1024 * 1024
CLOSURE_BYTES = 20 * 1024 * 1024
MAX_FILES = 300
HEX40 = re.compile(r"[a-f0-9]{40}\Z")
HEX64 = re.compile(r"[a-f0-9]{64}\Z")
ID = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
KINDS = {"native-netlist": ".scs", "native-assembly": ".scs", "rnl": ".rnl", "source-map": ".json", "validation-report": ".json", "provenance": ".json"}
VIEW_KINDS = {"native-netlist", "native-assembly", "rnl"}
CHECKS = ("placement", "orientation", "wire_routes", "pins", "symbols", "labels")
COUNTS = ("instances", "ports", "wires", "symbols", "labels")


class InvalidGeometry(ValueError):
    """A committed manifest or member failed validation (HTTP 422)."""


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def relative(value):
    # Do not normalize first: normalization would conceal empty / dot segments.
    if (not isinstance(value, str) or not 1 <= len(value) <= 512 or
            any(ord(c) < 32 or ord(c) == 127 for c in value) or
            any(c in value for c in "\\:%?#") or
            any(not p or p.startswith(".") for p in value.split("/"))):
        raise ValueError("invalid geometry relative path")
    return value


def digest(value):
    if not isinstance(value, str) or not HEX64.fullmatch(value):
        raise ValueError("SHA256 must be 64 lowercase hex characters")
    return value


def object_json(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise ValueError("duplicate JSON key: " + key)
            out[key] = value
        return out
    data = json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
    if not isinstance(data, dict):
        raise ValueError("JSON object required")
    return data


def strings(value, label):
    if not isinstance(value, list) or any(not isinstance(x, str) for x in value) or len(value) != len(set(value)):
        raise ValueError("invalid/duplicate " + label)
    return value


def imports(text):
    """Recognize the exporter's literal package/import subset, fail on other forms.

    Keep RNL in Spectre // and SPICE * comments. This is a closure scanner, not a
    replacement for the official RNL parser or a geometry/electrical equivalence test.
    """
    annotated = re.sub(r"(?m)^\s*(?://|\*) ?", "", text)
    token = re.compile(r'"(?:[^"\\]|\\.)*"|@(USE-PACKAGE|PACKAGE|INCLUDE|IMPORT)\b', re.I)
    packages, uses = [], []
    for match in token.finditer(annotated):
        kind = match.group(1)
        if not kind:
            continue
        kind = kind.upper()
        if kind in {"INCLUDE", "IMPORT"}:
            raise ValueError("unsupported RNL import directive: " + kind)
        tail = annotated[match.end():]
        call = re.match(r'\s*\(([^()]*)\)', tail)
        if not call:
            raise ValueError("unsupported package declaration")
        args, pos = {}, 0
        body = call[1]
        arg = re.compile(r'\s*(name|version|path)\s*=\s*("(?:[^"\\]|\\.)*")\s*(,|$)')
        while pos < len(body):
            part = arg.match(body, pos)
            if not part or part[1] in args:
                raise ValueError("unsupported/duplicate package argument")
            args[part[1]] = json.loads(part[2]); pos = part.end()
        if not args.get("name") or not args.get("version") or (kind == "PACKAGE" and "path" in args):
            raise ValueError("package name/version required")
        (packages if kind == "PACKAGE" else uses).append(args)
    refs = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(("//", "*", ";")):
            continue
        if re.match(r"(?i)(?:ahdl_include|model|\.model|\.hdl|shell|system|exec)\b", line) or "$system" in line:
            raise ValueError("electrical model/execution content is not a native geometry asset")
        if re.match(r"(?i)(?:include|\.inc\w*|\.lib)\b", line):
            match = re.fullmatch(r'(?:include|\.include|\.inc)\s+(?:"([^"\r\n]+)"|([^\s"\r\n]+))\s*(?://.*)?', line, re.I)
            if not match:
                raise ValueError("unsupported include syntax")
            refs.append(match[1] or match[2])
    flat = re.sub(r"\\\r?\n\s*", " ", text)
    definitions = re.findall(r"(?im)^\s*(?:subckt|\.subckt)\s+(\S+)", flat)
    targets = re.findall(r"(?m)^\s*[^\s/*;]+\s+\([^\n)]*\)\s+(\S+)", flat)
    return packages, uses, refs, definitions, targets


class Geometry:
    def __init__(self, workspace):
        self.workspace = workspace
        self._snapshots = OrderedDict()
        self._snapshot_lock = RLock()

    def git(self, *args, check=True):
        env = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1", GIT_OPTIONAL_LOCKS="0")
        result = subprocess.run(["git", "-c", "core.hooksPath=" + os.devnull, "-c", "core.fsmonitor=false",
                                 "-C", str(self.workspace.root), *args], capture_output=True, env=env)
        if check and result.returncode:
            raise ValueError("geometry Git object lookup failed")
        return result

    def commit(self, value):
        if not isinstance(value, str) or not HEX40.fullmatch(value):
            raise ValueError("full bundle/source commit required")
        if self.git("cat-file", "-t", value).stdout.strip() != b"commit":
            raise ValueError("commit identity is not a Git commit")
        return value

    def blob(self, commit, path, limit):
        relative(path)
        rows = self.git("ls-tree", "-z", commit, "--", ":(literal)" + path).stdout.split(b"\0")
        rows = [row for row in rows if row]
        if len(rows) != 1:
            raise FileNotFoundError("committed geometry/source file missing: " + path)
        header, name = rows[0].split(b"\t", 1)
        mode, kind, oid = header.decode().split()
        if name.decode() != path or mode not in {"100644", "100755"} or kind != "blob":
            raise ValueError("geometry/source member must be a regular committed blob")
        size = int(self.git("cat-file", "-s", oid).stdout)
        if size > limit:
            raise ValueError("Git blob exceeds byte limit before read: " + path)
        raw = self.git("cat-file", "blob", oid).stdout
        if len(raw) != size:
            raise ValueError("Git blob length changed")
        return raw

    def registration(self, project_id):
        p = self.workspace.projects.get(project_id)
        if not p:
            raise FileNotFoundError("unknown geometry project")
        path = p.get("geometry_manifest")
        if not path:
            raise FileNotFoundError("native geometry manifest is not registered")
        relative(path)
        source = project_path(p["source_path"])
        project_metadata(p)
        if source.startswith("lib/"):
            project_root = "/".join(source.split("/")[:3])
            folders = ("schematic", "native", "geometry")
        else:
            project_root = str(PurePosixPath(source).parent)
            folders = ("native", "geometry")
        if (not path.endswith(".json") or
                not any(path.startswith(project_root + "/" + folder + "/") for folder in folders)):
            raise ValueError("registered manifest must be under this project's native/geometry or library cell schematic directory")
        return p, path

    def snapshot(self, project_id, commit, manifest_hash=None):
        # Commit-addressed, already verified immutable objects only. Freshness()
        # still reads the live source on every request. Bound memory to 2x32MiB.
        self.commit(commit)
        if self.git("merge-base", "--is-ancestor", commit, self.workspace.head(), check=False).returncode:
            raise Conflict("geometry bundle commit is not in current repository history")
        key = (project_id, commit)
        with self._snapshot_lock:
            snap = self._snapshots.get(key)
            if snap is not None:
                if manifest_hash is not None and digest(manifest_hash) != snap["sha256"]:
                    raise Conflict("geometry manifest hash does not match pinned commit")
                self._snapshots.move_to_end(key)
                return snap
            snap = self._uncached_snapshot(project_id, commit, manifest_hash)
            if sum(f["bytes"] for f in snap["table"].values()) <= 32*1024*1024:
                self._snapshots[key] = snap
                while len(self._snapshots) > 2:
                    self._snapshots.popitem(last=False)
            return snap

    def _uncached_snapshot(self, project_id, commit, manifest_hash=None):
        p, path = self.registration(project_id)
        self.commit(commit)
        if self.git("merge-base", "--is-ancestor", commit, self.workspace.head(), check=False).returncode:
            raise Conflict("geometry bundle commit is not in current repository history")
        raw = self.blob(commit, path, MANIFEST_BYTES)
        actual_hash = sha(raw)
        if manifest_hash is not None and digest(manifest_hash) != actual_hash:
            raise Conflict("geometry manifest hash does not match pinned commit")
        try:
            m = object_json(raw)
            if m.get("schema") != "ic.native-geometry.v1" or m.get("project_id") != project_id:
                raise ValueError("geometry manifest schema/project mismatch")
            if not ID.fullmatch(m.get("id", "")):
                raise ValueError("invalid geometry export id")
            sources = [m["source"], *m["source"].get("files", [])]
            if len(sources) > MAX_FILES or m["source"]["path"] != p["source_path"]:
                raise ValueError("canonical source binding mismatch")
            allowed_sources = {p["source_path"], *p.get("read_paths", [])}
            seen = set()
            for source in sources:
                sp = relative(source["path"])
                if sp not in allowed_sources or sp in seen:
                    raise ValueError("source binding must name unique registered electrical files")
                seen.add(sp); self.commit(source["commit"]); digest(source["sha256"])
                if sha(self.blob(source["commit"], sp, FILE_BYTES)) != source["sha256"]:
                    raise ValueError("export-time source blob/hash mismatch")
            files = m["files"]
            if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
                raise ValueError("geometry catalog exceeds 300 files or is empty")
            table = {}
            for f in files:
                fp = relative(f["path"])
                if fp in table or f.get("kind") not in KINDS or PurePosixPath(fp).suffix != KINDS[f["kind"]]:
                    raise ValueError("duplicate path or unsupported geometry asset kind")
                if not ID.fullmatch(f.get("export_namespace", "default")):
                    raise ValueError("invalid native export namespace")
                digest(f["sha256"])
                if type(f["bytes"]) is not int or not 0 < f["bytes"] <= FILE_BYTES:
                    raise ValueError("geometry file must be 1..2 MiB")
                strings(f["dependencies"], "dependencies")
                table[fp] = f
            for f in files:
                if any(dep not in table or table[dep]["kind"] not in VIEW_KINDS for dep in f["dependencies"]):
                    raise ValueError("dependency is missing or is not viewer data")
                if f["kind"] not in VIEW_KINDS and f["dependencies"]:
                    raise ValueError("metadata cannot depend on viewer files")
            cells = m["cells"]
            if not isinstance(cells, list) or not 1 <= len(cells) <= MAX_FILES:
                raise ValueError("invalid cell catalog")
            cell_table = {}
            for cell in cells:
                if not ID.fullmatch(cell["id"]) or cell["id"] in cell_table:
                    raise ValueError("invalid/duplicate cell id")
                for key in ("library", "cell", "view"):
                    if not isinstance(cell["cell_view"].get(key), str) or not 1 <= len(cell["cell_view"][key]) <= 256:
                        raise ValueError("cell/view identity required")
                if not isinstance(cell["level"], str) or not 1 <= len(cell["level"]) <= 256:
                    raise ValueError("cell level required")
                if cell["entrypoint"] not in table or table[cell["entrypoint"]]["kind"] not in VIEW_KINDS:
                    raise ValueError("cell entrypoint is not listed viewer data")
                if cell.get("export_namespace", "default") != table[cell["entrypoint"]].get("export_namespace", "default"):
                    raise ValueError("cell/file export namespace mismatch")
                cell_table[cell["id"]] = cell
            if m["root_cell"] not in cell_table or m["entrypoint"] != cell_table[m["root_cell"]]["entrypoint"]:
                raise ValueError("root cell/entrypoint mismatch")
            snap = {"manifest": m, "table": table, "cells": cell_table, "project": p,
                    "commit": commit, "sha256": actual_hash, "manifest_path": path,
                    "root": str(PurePosixPath(path).parent), "raw": {}, "scanned": {}}
            used = set()
            for cell in cells:
                used.update(self.closure(snap, cell["entrypoint"]))
            for f in files:
                if f["kind"] in VIEW_KINDS and f["path"] not in used:
                    raise ValueError("unreachable viewer member")
            return snap
        except (ValueError, KeyError, TypeError, AttributeError, FileNotFoundError, RecursionError) as error:
            raise InvalidGeometry(str(error)) from error

    def closure(self, snap, entry):
        ordered, active, visited = [], set(), set()
        def visit(path):
            if path in active:
                raise ValueError("geometry dependency cycle")
            if path in visited:
                return
            active.add(path)
            for dep in snap["table"][path]["dependencies"]:
                visit(dep)
            active.remove(path); visited.add(path); ordered.append(path)
        visit(entry)
        if len(ordered) > MAX_FILES or sum(snap["table"][p]["bytes"] for p in ordered) > CLOSURE_BYTES:
            raise ValueError("cell viewer closure exceeds 300 files / 20 MiB")
        return ordered

    def member(self, snap, path):
        if path in snap["raw"]:
            return snap["raw"][path]
        f = snap["table"][path]
        raw = self.blob(snap["commit"], snap["root"] + "/" + path, min(FILE_BYTES, f["bytes"]))
        if len(raw) != f["bytes"] or sha(raw) != f["sha256"]:
            raise ValueError("geometry member size/hash mismatch: " + path)
        text = raw.decode("utf-8")
        if "\x00" in text:
            raise ValueError("binary geometry member rejected")
        if f["kind"] in VIEW_KINDS:
            if f["kind"] == "native-assembly":
                # A committed include-only wrapper can assemble native fragments
                # without rewriting their annotations or enabling Auto Include.
                for line in text.splitlines():
                    line = line.strip()
                    if line and not line.startswith(("//", "*", ";")) and not re.fullmatch(r'simulator\s+lang=spectre|include\s+"[^"\r\n]+"', line):
                        raise ValueError("native assembly may contain only literal includes and Spectre language selection")
            elif "@RNL" not in text:
                raise ValueError("native geometry annotation is absent")
            snap["scanned"][path] = imports(text)
            if f["kind"] == "native-assembly" and not snap["scanned"][path][2]:
                raise ValueError("native assembly must include at least one native fragment")
        else:
            object_json(raw)
        snap["raw"][path] = raw
        return raw

    def validate_cell(self, snap, cell_id):
        if cell_id not in snap["cells"]:
            raise FileNotFoundError("unknown geometry cell")
        try:
            cell = snap["cells"][cell_id]
            paths = self.closure(snap, cell["entrypoint"])
            providers = {}
            for path in paths:
                self.member(snap, path)
                for package in snap["scanned"][path][0]:
                    key = (package["name"], package["version"])
                    if key in providers:
                        raise ValueError("duplicate package provider")
                    providers[key] = path
            levels = {}
            for c in snap["cells"].values():
                levels.setdefault((c.get("export_namespace", "default"), c["level"]), set()).add(c["entrypoint"])
            for path in paths:
                _, uses, includes, definitions, targets = snap["scanned"][path]
                declared = set(snap["table"][path]["dependencies"])
                for use in uses:
                    provider = providers.get((use["name"], use["version"]))
                    if not provider or provider not in declared:
                        raise ValueError("package import is outside declared direct dependencies")
                    if "path" in use and self.import_path(path, use["path"]) != provider:
                        raise ValueError("package path/name/version binding mismatch")
                for include in includes:
                    if self.import_path(path, include) not in declared:
                        raise ValueError("include is outside declared direct dependencies")
                for target in targets:
                    candidates = levels.get((snap["table"][path].get("export_namespace", "default"), target), set()) - {path}
                    if target not in definitions and candidates and not (candidates & declared):
                        raise ValueError("hierarchy target is outside declared dependencies: " + target)
            # Native Spectre cell levels must exist in their entry file, not another pool file.
            if snap["table"][cell["entrypoint"]]["kind"] == "native-netlist":
                if cell["level"] not in snap["scanned"][cell["entrypoint"]][3] and cell["level"] != "@top":
                    raise ValueError("requested cell level is absent from entrypoint")
            if snap["table"][cell["entrypoint"]]["kind"] == "native-assembly":
                imported, pending = set(), [cell["entrypoint"]]
                while pending:
                    path = pending.pop()
                    if path in imported:
                        continue
                    imported.add(path)
                    pending.extend(self.import_path(path, ref) for ref in snap["scanned"][path][2])
                if cell["level"] != "@top" and not any(cell["level"] in snap["scanned"][p][3] for p in imported):
                    raise ValueError("requested level is absent from explicit assembly includes")
            return paths
        except (ValueError, KeyError, TypeError, AttributeError, FileNotFoundError) as error:
            raise InvalidGeometry(str(error)) from error

    @staticmethod
    def import_path(importer, value):
        relative(value)
        parent = str(PurePosixPath(importer).parent)
        return relative(value if parent == "." else parent + "/" + value)

    @staticmethod
    def url(origin, endpoint, snap, **extra):
        # Origin is supplied only by the loopback server, never by a client header.
        return origin + "/api/geometry/" + endpoint + "?" + urlencode({
            "project_id": snap["project"]["id"], "bundle_commit": snap["commit"],
            "manifest_sha256": snap["sha256"], **extra})

    def pinned(self, project_id, commit, manifest_hash):
        digest(manifest_hash)
        if not isinstance(commit, str) or not HEX40.fullmatch(commit):
            raise ValueError("full bundle commit required")
        try:
            self.commit(commit)
        except ValueError as error:
            raise Conflict("pinned geometry commit is unavailable") from error
        try:
            return self.snapshot(project_id, commit, manifest_hash)
        except (Conflict, InvalidGeometry, FileNotFoundError):
            raise
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            raise InvalidGeometry(str(error)) from error

    def viewer_manifest(self, project_id, commit, manifest_hash, cell_id, origin):
        snap = self.pinned(project_id, commit, manifest_hash)
        paths = self.validate_cell(snap, cell_id)
        cell = snap["cells"][cell_id]
        return {"format": 1, "id": snap["manifest"]["id"], "entry": cell["entrypoint"],
                "level": cell["level"], "pool": [p for p in paths if p != cell["entrypoint"]],
                "files": [{"path": p, "url": self.url(origin, "file", snap, path=p),
                           "sha256": snap["table"][p]["sha256"], "size": snap["table"][p]["bytes"]} for p in paths],
                "settings": {"autoInclude": False}}

    def file(self, project_id, commit, manifest_hash, path):
        relative(path)
        snap = self.pinned(project_id, commit, manifest_hash)
        if path not in snap["table"]:
            raise FileNotFoundError("file is not a registered geometry member")
        try:
            if snap["table"][path]["kind"] in VIEW_KINDS:
                cell = next(c for c in snap["cells"].values() if path in self.closure(snap, c["entrypoint"]))
                self.validate_cell(snap, cell["id"])
            raw = self.member(snap, path)
        except (ValueError, KeyError, TypeError, AttributeError, FileNotFoundError) as error:
            raise InvalidGeometry(str(error)) from error
        mime = "application/json" if path.endswith(".json") else "text/plain; charset=utf-8"
        headers = {"ETag": '"' + sha(raw) + '"', "X-Geometry-Bundle-Commit": commit,
                   "X-Geometry-Manifest-SHA256": manifest_hash,
                   "X-Geometry-Source-Commit": snap["manifest"]["source"]["commit"]}
        return raw, mime, headers

    def freshness(self, snap, current, requested):
        reasons, identities = [], []
        for source in [snap["manifest"]["source"], *snap["manifest"]["source"].get("files", [])]:
            path = source["path"]
            dirty = bool(self.git("status", "--porcelain", "--", ":(literal)" + path).stdout)
            head_hash = sha(self.blob(current["base_commit"], path, FILE_BYTES))
            f = self.workspace.file_path(path)
            if f.stat().st_size > FILE_BYTES:
                raise ValueError("current electrical source exceeds limit")
            current_hash = sha(f.read_bytes())
            if dirty:
                reasons.append("dirty_source:" + path)
            if head_hash != source["sha256"] or current_hash != source["sha256"]:
                reasons.append("source_hash_mismatch:" + path)
            identities.append({"path": path, "geometry_source_commit": source["commit"],
                               "geometry_source_sha256": source["sha256"], "current_source_sha256": current_hash,
                               "current_source_commit": None if dirty else current["base_commit"], "dirty": dirty})
        if requested and requested != current["sha256"]:
            reasons.append("editor_hash_mismatch")
        if identities[0]["current_source_sha256"] != current["sha256"] or self.workspace.head() != current["base_commit"]:
            reasons.append("source_changed_during_read")
        return reasons, {**identities[0], "requested_source_sha256": requested or None,
                         "match_kind": "mismatch" if reasons else "exact_content", "files": identities,
                         "observed_head": current["base_commit"]}

    def fidelity(self, snap, cell_id, paths):
        m = snap["manifest"]; cell = snap["cells"][cell_id]
        coverage = cell.get("coverage", m.get("coverage"))
        losses = cell.get("losses", m.get("losses"))
        declared = cell.get("fidelity", m.get("fidelity", {}))
        coordinate = m.get("coordinate_system")
        reasons = []
        export = m.get("native_export")
        if (not isinstance(export, dict) or not export.get("origin") or not export.get("version") or
                not isinstance(export.get("snapshot_sha256"), str) or not HEX64.fullmatch(export["snapshot_sha256"]) or
                not isinstance(export.get("config_sha256"), str) or not HEX64.fullmatch(export["config_sha256"])):
            reasons.append("native_export_provenance_unverified")
        if not isinstance(coverage, dict) or coverage.get("status") != "complete":
            reasons.append("coverage_unknown_or_partial")
        else:
            for key in COUNTS:
                count = coverage.get("counts", {}).get(key, {})
                if type(count.get("expected")) is not int or count["expected"] < 0 or type(count.get("exported")) is not int or count["expected"] != count["exported"]:
                    reasons.append("coverage_incomplete:" + key)
        if not isinstance(losses, list):
            losses = None; reasons.append("losses_unknown")
        elif any(not isinstance(loss, dict) or not isinstance(loss.get("reason"), str) or loss.get("blocking") is not False for loss in losses):
            reasons.append("blocking_or_unclassified_losses")
        elif any(loss.get("severity") in {"error", "blocking"} for loss in losses):
            reasons.append("blocking_losses")
        if not isinstance(coordinate, dict) or not isinstance(coordinate.get("units"), str) or not coordinate["units"] or not isinstance(coordinate.get("transform"), dict) or not coordinate["transform"]:
            reasons.append("coordinate_system_unverified")
        verified = False
        if isinstance(declared, dict) and declared.get("status") == "verified" and declared.get("report"):
            report_path = declared["report"]
            if report_path not in snap["table"] or snap["table"][report_path]["kind"] != "validation-report":
                raise InvalidGeometry("fidelity report is not a listed validation report")
            report = object_json(self.member(snap, report_path))
            record = report.get("cells", {}).get(cell_id, {})
            verified = (report.get("schema") == "ic.native-geometry.validation.v1" and
                        report.get("project_id") == m["project_id"] and bool(report.get("verifier")) and
                        report.get("source_sha256") == m["source"]["sha256"] and
                        all(record.get("checks", {}).get(k) is True for k in CHECKS) and
                        all(record.get("geometry_files", {}).get(p) == snap["table"][p]["sha256"] for p in paths))
        if not verified:
            reasons.append("owner_fidelity_evidence_unverified")
        return ("verified" if verified else "partial" if isinstance(declared, dict) and declared.get("status") == "partial" else "unverified"), coverage, losses, coordinate, reasons

    def mapping(self, snap, mapping_path, stale):
        m = snap["manifest"]
        if mapping_path not in snap["table"] or snap["table"][mapping_path]["kind"] != "source-map":
            raise InvalidGeometry("mapping is not a listed source-map")
        mapping = object_json(self.member(snap, mapping_path))
        if mapping.get("schema") != "ic.native.source-map.v1" or mapping.get("bound_source_hash") != m["source"]["sha256"] or not isinstance(mapping.get("objects"), list):
            raise InvalidGeometry("mapping source binding/schema mismatch")
        source_table = {s["path"]: s for s in [m["source"], *m["source"].get("files", [])]}
        source_lines = {}
        for obj in mapping["objects"]:
            if not isinstance(obj, dict) or any(not isinstance(obj.get(k), str) or not obj[k] for k in ("kind", "name", "scope", "viewer_source_path", "source_path")):
                raise InvalidGeometry("mapping object identity required")
            viewer = obj["viewer_source_path"]
            if viewer not in snap["table"] or snap["table"][viewer]["kind"] not in VIEW_KINDS:
                raise InvalidGeometry("mapping viewer source is not listed native data")
            if obj.get("source_kind") == "export":
                if obj.get("readonly") is not True or obj["source_path"] not in snap["table"] or snap["table"][obj["source_path"]]["kind"] not in VIEW_KINDS:
                    raise InvalidGeometry("mapping export target is not read-only native data")
                lines = len(self.member(snap, obj["source_path"]).splitlines())
            else:
                source = source_table.get(obj["source_path"])
                if not source or obj.get("source_sha256") != source["sha256"]:
                    raise InvalidGeometry("canonical mapping source hash/path mismatch")
                if source["path"] not in source_lines:
                    source_lines[source["path"]] = len(self.blob(source["commit"], source["path"], FILE_BYTES).splitlines())
                lines = source_lines[source["path"]]
            start, end = obj.get("line_start"), obj.get("line_end", obj.get("line_start"))
            if type(start) is not int or type(end) is not int or not 1 <= start <= end <= lines:
                raise InvalidGeometry("mapping line is outside bound source")
        # Preserve the original mapping blob; the response removes stale canonical jumps.
        objects = mapping["objects"] if not stale else [o for o in mapping["objects"] if o.get("source_kind") == "export"]
        return {**mapping, "objects": objects, "canonical_enabled": not stale}

    def schematic(self, project_id, path, requested, origin):
        p = self.workspace.projects.get(project_id)
        if not p or path != p["source_path"]:
            raise FileNotFoundError("unknown schematic source")
        if requested:
            digest(requested)
        with locked(self.workspace.runtime / "workspace.lock"):
            if self.workspace.file_path(path).stat().st_size > FILE_BYTES:
                raise ValueError("current electrical source exceeds limit before read")
            current = self.workspace.file(path)
            dirty = bool(self.git("status", "--porcelain", "--", ":(literal)" + path).stdout)
            result = {"source_path": path, "source_hash": current["sha256"],
                      "source_commit": None if dirty else current["base_commit"], "base_commit": current["base_commit"],
                      "available": False, "stale": True, "native_ready": False, "mapping": None}
            g = {"schema": "ic.native-geometry.payload.v1", "mode": "native", "state": "missing",
                 "available": False, "stale": True, "native_ready": False, "integrity": "unknown",
                 "fidelity": "unverified", "coverage": None, "losses": None, "coordinate_system": None,
                 "source_mapping_enabled": False, "cells": [], "files": [], "reasons": []}
            result["geometry"] = g
            try:
                snap = self.snapshot(project_id, current["base_commit"])
                m = snap["manifest"]; cell_id = m["root_cell"]
                paths = self.validate_cell(snap, cell_id)
                stale_reasons, binding = self.freshness(snap, current, requested)
                fidelity, coverage, losses, coordinate, fidelity_reasons = self.fidelity(snap, cell_id, paths)
                stale = bool(stale_reasons); ready = not stale and not fidelity_reasons
                state = "stale" if stale else "ready" if ready else "partial"
                cells = [{"id": c["id"], "label": c.get("label", c.get("export_namespace", "canonical") + ": " + c["cell_view"]["cell"]), "cell_view": c["cell_view"], "entrypoint": c["entrypoint"],
                          "level": c["level"], **{k:c[k] for k in ("source_kind", "canonical_source_mapping", "coverage", "losses", "fidelity", "export_namespace") if k in c}, "viewer_manifest_url": self.url(origin, "viewer-manifest", snap, entry=c["id"])} for c in m["cells"]]
                g.update(state=state, available=True, stale=stale, native_ready=ready, integrity="valid",
                         fidelity=fidelity, fidelity_authority="committed_owner_attestation",
                         coverage=coverage, losses=losses, coordinate_system=coordinate,
                         reasons=stale_reasons + fidelity_reasons, bundle_commit=snap["commit"],
                         manifest_sha256=snap["sha256"], manifest_path=snap["manifest_path"], source_binding=binding,
                         native_export=m.get("native_export"), root_cell=cell_id, cells=cells,
                         cell_view=snap["cells"][cell_id]["cell_view"], entrypoint=m["entrypoint"],
                         viewer_manifest_url=self.url(origin, "viewer-manifest", snap, entry=cell_id),
                         files=[{**snap["table"][fp], "url": self.url(origin, "file", snap, path=fp)} for fp in paths],
                         validation_scope={"cell": cell_id, "other_cells": "validated on pinned viewer request"})
                mapping_path = m.get("mapping")
                if mapping_path:
                    g["mapping"] = self.mapping(snap, mapping_path, stale)
                    g["source_mapping_enabled"] = not stale
                result.update(available=True, stale=stale, native_ready=ready)
            except FileNotFoundError as error:
                g["reasons"] = [str(error)]
            except (ValueError, KeyError, TypeError, AttributeError, RecursionError) as error:
                g.update(state="invalid", available=False, stale=True, native_ready=False, integrity="invalid",
                         source_mapping_enabled=False, cells=[], files=[], reasons=[str(error)])
                g.pop("mapping", None); g.pop("viewer_manifest_url", None)
            return result
