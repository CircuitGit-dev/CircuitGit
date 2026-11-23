#!/usr/bin/env python3
"""Plan, apply and verify byte-preserving canonical library sources.

The default command only writes a local plan. Native source/provenance records
are never rewritten. Relative renderer paths are materialized by view.aliases;
only the manifest inventories and new migration evidence change.
"""
import argparse
import collections
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
SCHEMA = "circuitgit.library-deduplication.v1"
REPORT = "lib/migrations/source-layout-v1.json"
SUPPORT = re.compile(r"(?:eda-symbol|eda-style|rnl-std-[A-Za-z0-9_-]+)\.rnl\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def dump(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def safe_path(root, value):
    if not isinstance(value, str) or not value.startswith(("lib/", "projects/")) or any(
            p in ("", ".", "..") for p in value.split("/")) or any(c in value for c in "\\:%?#\x00"):
        raise ValueError("Unsafe repository source path: " + str(value))
    path = root / value
    if any(p.is_symlink() for p in (path, *path.parents) if p != root and root in p.parents):
        raise ValueError("Symlink source is not supported: " + value)
    return path


def read(root, path):
    file = safe_path(root, path)
    if not file.is_file() or file.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Missing or oversized source: " + path)
    return file.read_bytes()


def dependencies(raw):
    """Only the relative include/package forms produced by the pinned importer."""
    text = raw.decode("utf-8")
    result = re.findall(r'^\s*include\s+"([^"\n]+)"', text, re.M)
    for declaration in re.findall(r"@USE-PACKAGE\(([^)]*)\)", text):
        path = re.search(r'\bpath="([^"]+)"', declaration)
        name = re.search(r'\bname="([^"]+)"', declaration)
        if path:
            result.append(path[1])
        elif name:
            result.append(name[1] + ".rnl")
        else:
            raise ValueError("Unrecognized native package dependency")
    for path in result:
        if PurePosixPath(path).is_absolute() or any(p in ("", ".", "..") for p in path.split("/")) or any(c in path for c in "\\:%?#\x00"):
            raise ValueError("Unsafe or external native dependency: " + path)
    return result


def source_identity(row):
    if not isinstance(row, dict) or not isinstance(row.get("source"), str) or not SHA256.fullmatch(row.get("source_sha256", "")):
        return None
    return row["source"], row["source_sha256"], row.get("transformation", "none")


def view_snapshot(root, view, overlay=None):
    """Physical files plus explicit virtual aliases; aliases cannot shadow a file."""
    overlay = overlay or {}
    files = view.get("files")
    if not isinstance(files, list) or len(files) != len(set(files)) or view.get("entry") not in files:
        raise ValueError("Invalid view physical inventory")
    physical = {path: overlay[path] if path in overlay else read(root, path) for path in files}
    snapshot = dict(physical)
    aliases = view.get("aliases", {})
    if not isinstance(aliases, dict):
        raise ValueError("View aliases must be an object")
    for virtual, canonical in aliases.items():
        safe_path(root, virtual); safe_path(root, canonical)
        if canonical not in physical:
            raise ValueError("Alias target is not a physical view member: " + canonical)
        if virtual in physical and virtual != canonical:
            raise ValueError("Alias shadows a physical view member: " + virtual)
        snapshot[virtual] = physical[canonical]
    return snapshot


def verify_dependencies(snapshot):
    for path, raw in snapshot.items():
        for relative in dependencies(raw):
            dependency = str(PurePosixPath(path).parent / relative)
            if dependency not in snapshot:
                raise ValueError("Native dependency is missing: " + path + " -> " + dependency)


def inventories(root):
    catalog_raw = read(root, "lib/catalog.json")
    catalog = json.loads(catalog_raw)
    if catalog.get("schema") != "circuitgit.libraries.v1" or not isinstance(catalog.get("libraries"), list):
        raise ValueError("Invalid library catalog")
    manifests, views, records, inputs, bytes_by_path = {}, [], {}, {"lib/catalog.json": digest(catalog_raw)}, {}
    cells = {}
    for item in catalog["libraries"]:
        lid = item["id"]
        if lid in manifests or item["manifest"] != "lib/" + lid + "/library.json":
            raise ValueError("Duplicate or mismatched library identity")
        raw = read(root, item["manifest"]); manifest = json.loads(raw)
        if manifest.get("schema") != "circuitgit.library.v1" or manifest.get("id") != lid:
            raise ValueError("Invalid library manifest")
        manifests[lid] = {"path": item["manifest"], "value": manifest, "raw": raw}
        inputs[item["manifest"]] = digest(raw)
        for cell in manifest["cells"]:
            cid = cell["id"]
            if (lid, cid) in cells or cell["directory"] != "lib/" + lid + "/" + cid:
                raise ValueError("Duplicate or mismatched cell identity")
            cells[lid, cid] = cell
            provenance_path = cell["directory"] + "/docs/provenance.json"
            provenance_raw = read(root, provenance_path)
            inputs[provenance_path] = digest(provenance_raw)
            provenance = json.loads(provenance_raw)
            rows = {row["path"]: row for row in provenance.get("files", [])}
            for view in cell["views"]:
                if view["kind"] != "rnl":
                    continue
                if view.get("aliases"):
                    raise ValueError("This import is already normalized; verify its migration report instead of planning again")
                snapshot = view_snapshot(root, view)
                verify_dependencies(snapshot)
                views.append({"library_id": lid, "cell_id": cid, "view": view, "provenance": provenance})
                for path, content in snapshot.items():
                    row = rows.get(path)
                    if not path.startswith(cell["directory"] + "/") or row is None or row.get("sha256") != digest(content):
                        raise ValueError("Native import/provenance identity has changed: " + path)
                    inputs[path] = digest(content); bytes_by_path[path] = content
                    record = {"library_id": lid, "cell_id": cid, "source_cell": provenance.get("source_cell", {}),
                              "row": row, "view_id": view["id"], "primary": path == view["entry"]}
                    if path in records and records[path] != record:
                        raise ValueError("Ambiguous native physical ownership: " + path)
                    records[path] = record
    return manifests, views, records, inputs, bytes_by_path, cells


def choose_mapping(records, contents):
    groups, mapping, decisions = collections.defaultdict(list), {}, []
    for path, record in records.items():
        name = PurePosixPath(path).name
        identity = source_identity(record["row"])
        if SUPPORT.fullmatch(name):
            key = ("public-rnl", name, digest(contents[path]))
        elif path.endswith(".scs") and identity:
            key = ("native", record["library_id"], name, digest(contents[path]), *identity)
        else:
            key = ("retained", path)
        groups[key].append(path)
    for key, members in sorted(groups.items()):
        members = sorted(members)
        primaries = [path for path in members if records[path]["primary"]]
        owners = []
        for path in members:
            record = records[path]
            stem = PurePosixPath(path).stem.removeprefix("view-")
            if stem == record["cell_id"] == record["source_cell"].get("cell"):
                owners.append(path)
        for path in primaries:
            mapping[path] = path
        if len(owners) == 1:
            canonical = owners[0]
            reason = "existing-primary-entry" if canonical in primaries else "registered-cell-owner"
        elif len(primaries) > 1:
            # Entry identity takes precedence; never move one cell's primary into another cell.
            canonical = primaries[0]
            reason = "multiple-primary-entries-retained"
        elif primaries:
            canonical, reason = primaries[0], "existing-primary-entry"
        elif key[0] == "public-rnl":
            canonical = "lib/_shared/rnl/" + key[2] + "/" + key[1]
            reason = "public-drawing-package"
        elif key[0] == "native" and len(members) > 1 and not owners:
            group_hash = digest(dump(list(key)))
            canonical = "lib/" + key[1] + "/_shared/native/" + group_hash + "/" + key[2]
            reason = "unregistered-dependency-readonly"
        else:
            canonical, reason = members[0], "unique-or-ambiguous-owner-retained"
        for path in members:
            mapping.setdefault(path, canonical)
        if len(members) > 1 or canonical not in members:
            decisions.append({"canonical": canonical, "members": members, "reason": reason,
                              "sha256": digest(contents[members[0]]), "bytes": len(contents[members[0]]),
                              "source_identity": list(key[4:]) if key[0] == "native" else None,
                              "library_id": key[1] if key[0] == "native" else None,
                              "owner_cell": records[canonical]["cell_id"] if canonical in owners else None})
    return mapping, decisions


def normalized_view(root, view, mapping, contents):
    original = {path: contents[path] for path in view["files"]}
    physical = {mapping[path] for path in original}
    aliases, expected, queue = {}, dict(original), []
    # Every new physical path keeps the source occurrence that proved its closure.
    occurrence = {}
    for old in sorted(original):
        canonical = mapping[old]
        if canonical in occurrence and original[old] != original[occurrence[canonical]]:
            raise ValueError("Different bytes mapped to one canonical path")
        occurrence.setdefault(canonical, old)
        if old != canonical:
            aliases[old] = canonical
        queue.append((old, old))
    queue.extend((canonical, old) for canonical, old in occurrence.items())
    done = set()
    while queue:
        virtual, old = queue.pop()
        if (virtual, old) in done:
            continue
        done.add((virtual, old))
        if virtual in expected and expected[virtual] != original[old]:
            raise ValueError("Virtual source collision: " + virtual)
        expected[virtual] = original[old]
        for name in dependencies(original[old]):
            old_dependency = str(PurePosixPath(old).parent / name)
            virtual_dependency = str(PurePosixPath(virtual).parent / name)
            if old_dependency not in original:
                raise ValueError("Incomplete original dependency closure: " + old_dependency)
            canonical = mapping[old_dependency]
            if canonical not in physical:
                raise ValueError("Dependency target missing from canonical view")
            if virtual_dependency in physical and virtual_dependency != canonical:
                raise ValueError("Canonical dependency aliases would shadow a physical file: " + virtual_dependency)
            if virtual_dependency in aliases and aliases[virtual_dependency] != canonical:
                raise ValueError("Conflicting virtual dependency: " + virtual_dependency)
            if virtual_dependency != canonical:
                aliases[virtual_dependency] = canonical
            queue.append((virtual_dependency, old_dependency))
    result = {**view, "files": sorted(physical), "aliases": dict(sorted(aliases.items()))}
    if mapping[view["entry"]] != view["entry"]:
        raise ValueError("A primary view entry cannot move")
    overlay = {canonical: original[old] for canonical, old in occurrence.items()}
    snapshot = view_snapshot(root, result, overlay)
    verify_dependencies(snapshot)
    if any(snapshot.get(path) != raw for path, raw in original.items()):
        raise ValueError("The materialized original view has changed")
    return result, {"entry": view["entry"], "level": view.get("level"),
                    "original_files": {path: digest(raw) for path, raw in sorted(original.items())},
                    "original_snapshot_sha256": digest(dump({path: digest(raw) for path, raw in sorted(original.items())})),
                    "physical_files": len(physical), "virtual_aliases": len(aliases),
                    "materialized_files": len(snapshot), "original_snapshot_identical": True}


def electrical_blocks(raw):
    """Exact electrical token comparison; this is not semantic equivalence or a parser."""
    text = raw.decode("utf-8")
    text = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(("//", "*")))
    text = re.sub(r"\\\s*\n\s*", " ", text)
    lines = text.splitlines(); blocks = {}; active = None
    for index, line in enumerate(lines):
        begin = re.match(r"\s*subckt\s+(\S+)(.*)", line, re.I)
        end = re.match(r"\s*ends(?:\s+(\S+))?\s*$", line, re.I)
        if begin:
            if active or begin[1] in blocks:
                raise ValueError("Nested or duplicate subcircuit definition")
            active = (begin[1], index, begin[2].split())
        elif end and active:
            name, first, ports = active
            if end[1] and end[1] != name:
                raise ValueError("Subcircuit end identity differs")
            statements = [re.findall(r'"(?:\\.|[^"\\])*"|\S+', line) for line in lines[first:index + 1] if line.strip()]
            tokens = [token for statement in statements for token in statement]
            blocks[name] = {"name": name, "ports": ports, "token_sha256": digest(dump(tokens)), "tokens": tokens, "statements": statements}
            active = None
    if active:
        raise ValueError("Unclosed subcircuit definition")
    return blocks


def bus_rename_audit(simulation, native):
    """Describe a checked identifier bijection; never rewrite either source."""
    identifiers = {}
    pattern = re.compile(r"([A-Za-z_][A-Za-z0-9_.$]*)\\?<([0-9]+)\\?>")
    def token(value):
        if value.startswith('"'):
            return value
        def replace(match):
            target = match[1] + "_" + match[2]
            identifiers[match[0]] = target
            return target
        return pattern.sub(replace, value)
    normalized = [[token(value) for value in statement] for statement in simulation["statements"]]
    bare_identifiers = set(re.findall(r"[A-Za-z_][A-Za-z0-9_.$]*", " ".join(simulation["tokens"])))
    collisions = sorted({target for target in identifiers.values() if target in bare_identifiers})
    if len(set(identifiers.values())) != len(identifiers):
        collisions += ["multiple simulation spellings map to one native identifier"]
    exact = [value for statement in normalized for value in statement] == native["tokens"]
    same_statements = (normalized[0] == native["statements"][0] and normalized[-1] == native["statements"][-1]
                       and sorted(map(tuple, normalized[1:-1])) == sorted(map(tuple, native["statements"][1:-1])))
    status = ("identifier-collision" if collisions else "exact-tokens-after-bus-renaming" if exact
              else "same-statements-after-bus-renaming" if same_statements else "differences-remain")
    return {"status": status, "identifiers": dict(sorted(identifiers.items())), "collisions": collisions,
            "simulation_statements": len(simulation["statements"]), "native_statements": len(native["statements"]),
            "automatic_replacement": False}


def simulation_audit(root, manifests, mapping, records, contents):
    files, owners, duplicate_groups = set(), {}, collections.defaultdict(list)
    for path, record in records.items():
        name = PurePosixPath(path).stem
        if path.endswith(".scs") and name == record["cell_id"] == record["source_cell"].get("cell"):
            blocks = electrical_blocks(contents[path])
            if name in blocks:
                owners.setdefault((record["library_id"], name), []).append((path, blocks[name]))
    projects = []
    for lid, manifest in manifests.items():
        for cell in manifest["value"]["cells"]:
            for view in cell["views"]:
                if view.get("id") == "simulation":
                    for path in view["files"]:
                        if "/simulation/" in path:
                            files.add(path)
                            if path.endswith("/netlist/project.scs"):
                                projects.append((lid, cell["id"], path))
    hashes = {}
    for path in sorted(files):
        raw = read(root, path)
        hashes[path] = digest(raw)
        duplicate_groups[(PurePosixPath(path).name, hashes[path])].append(path)
    comparisons = []
    for lid, cid, path in projects:
        blocks = electrical_blocks(read(root, path)); rows = []
        for name, block in blocks.items():
            candidates = owners.get((lid, name), [])
            row = {"subcircuit": name, "simulation_token_sha256": block["token_sha256"], "ports": block["ports"]}
            if len(candidates) != 1:
                row.update(status="missing-or-ambiguous-native-owner", candidates=[mapping[source] for source, _ in candidates])
            else:
                source, native = candidates[0]
                row.update(canonical_source=mapping[source], native_token_sha256=native["token_sha256"],
                           native_ports=native["ports"], status="exact-electrical-tokens" if block["tokens"] == native["tokens"]
                           else "ports-match-body-differs" if block["ports"] == native["ports"] else "port-interface-differs")
                if block["tokens"] != native["tokens"]:
                    row["bus_rename_audit"] = bus_rename_audit(block, native)
            rows.append(row)
        comparisons.append({"library_id": lid, "cell_id": cid, "project_source": path, "sha256": digest(read(root, path)),
                            "subcircuits": rows, "counts": dict(collections.Counter(row["status"] for row in rows))})
    duplicates = [{"basename": name, "sha256": sha, "paths": paths, "bytes_each": len(read(root, paths[0]))}
                  for (name, sha), paths in sorted(duplicate_groups.items()) if len(paths) > 1]
    return {"action": "audit-only; historical simulation/configuration/bundle files are unchanged",
            "comparison": "Only comments, continuation line breaks and token whitespace are normalized; no electrical equivalence is inferred.",
            "files": hashes, "duplicates": duplicates, "projects": comparisons}


def make_plan(root):
    root = Path(root).resolve()
    manifests, views, records, inputs, contents, cells = inventories(root)
    mapping, decisions = choose_mapping(records, contents)
    outputs, checks = {}, []
    for row in views:
        normalized, check = normalized_view(root, row["view"], mapping, contents)
        row["view"].clear(); row["view"].update(normalized)
        checks.append({"library_id": row["library_id"], "cell_id": row["cell_id"], "view_id": row["view"]["id"], **check})
    for lid, manifest in manifests.items():
        outputs[manifest["path"]] = manifest["value"]
    copies = {}
    for path, target in sorted(mapping.items()):
        if path != target:
            copies.setdefault(target, {"source": path, "sha256": digest(contents[path]), "bytes": len(contents[path])})
    deletions = sorted(path for path, target in mapping.items() if path != target)
    canonical_files = set(mapping.values())
    physical_bytes = {mapping[path]: len(raw) for path, raw in contents.items()}
    try:
        commit = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        commit = None
    simulation = simulation_audit(root, manifests, mapping, records, contents)
    inputs.update(simulation["files"])
    preserved = {path: sha for path, sha in inputs.items() if path.endswith("/provenance.json") or path in simulation["files"]}
    report = {"schema": SCHEMA, "source_commit": commit,
              "policy": {"native_bytes": "unchanged", "primary_entries": "unchanged", "provenance": "historical files unchanged",
                         "native_scope": "same library, basename, byte hash and provenance source identity",
                         "drawing_packages": "global basename plus byte hash", "simulation": "audit only"},
              "summary": {"libraries": len(manifests), "cells": len(cells), "rnl_views": len(views),
                          "files_before": len(contents), "files_after": len(canonical_files),
                          "bytes_before": sum(map(len, contents.values())), "bytes_after": sum(physical_bytes.values()),
                          "removed_copies": len(deletions), "new_shared_files": len([p for p in copies if p not in contents]),
                          "registered_owner_groups": sum(row["reason"] == "registered-cell-owner" for row in decisions),
                          "readonly_unregistered_groups": sum(row["reason"] == "unregistered-dependency-readonly" for row in decisions)},
              "mapping": {path: {"canonical": target, "sha256": digest(contents[path])} for path, target in sorted(mapping.items())},
              "preserved_files": dict(sorted(preserved.items())), "groups": decisions, "views": checks, "simulation_audit": simulation}
    outputs[REPORT] = report
    payload = {"schema": SCHEMA, "inputs": dict(sorted(inputs.items())), "copies": copies,
               "delete": deletions, "outputs": outputs, "report_path": REPORT}
    return {"plan_id": digest(dump(payload)), **payload}


def verify(root, report):
    if report.get("schema") != SCHEMA:
        raise ValueError("Unsupported migration report")
    root = Path(root).resolve(); count = 0
    manifests = {}
    for path, sha in report.get("preserved_files", {}).items():
        if digest(read(root, path)) != sha:
            raise ValueError("Historical provenance/simulation evidence changed: " + path)
    for check in report["views"]:
        lid = check["library_id"]
        if lid not in manifests:
            manifests[lid] = json.loads(read(root, "lib/" + lid + "/library.json"))
        cell = next(cell for cell in manifests[lid]["cells"] if cell["id"] == check["cell_id"])
        view = next(view for view in cell["views"] if view["id"] == check["view_id"])
        if (view["entry"], view.get("level")) != (check["entry"], check["level"]):
            raise ValueError("Primary native view identity changed")
        snapshot = view_snapshot(root, view); verify_dependencies(snapshot)
        for path, sha in check["original_files"].items():
            if path not in snapshot or digest(snapshot[path]) != sha:
                raise ValueError("Original native snapshot differs: " + path)
        count += 1
    return {"schema": SCHEMA, "verified_rnl_views": count, "original_snapshots_identical": True}


def atomic_write(root, path, raw):
    target = safe_path(root, path); target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".deduplicate-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        os.chmod(temporary, target.stat().st_mode & 0o777 if target.exists() else 0o644)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply_plan(root, plan):
    root = Path(root).resolve()
    payload = {key: value for key, value in plan.items() if key != "plan_id"}
    if plan.get("schema") != SCHEMA or plan.get("plan_id") != digest(dump(payload)):
        raise ValueError("Plan fingerprint does not match")
    if all(safe_path(root, path).is_file() and read(root, path) == dump(value) for path, value in plan["outputs"].items()) and all(
            not safe_path(root, path).exists() for path in plan["delete"]):
        return {"state": "already-applied", **verify(root, plan["outputs"][plan["report_path"]])}
    for path, sha in plan["inputs"].items():
        if digest(read(root, path)) != sha:
            raise ValueError("Source changed after plan: " + path)
    writes = {path: read(root, row["source"]) for path, row in plan["copies"].items()}
    for path, row in plan["copies"].items():
        if digest(writes[path]) != row["sha256"]:
            raise ValueError("Canonical copy source changed: " + path)
        if safe_path(root, path).exists() and read(root, path) != writes[path]:
            raise ValueError("Canonical destination has different content: " + path)
    writes.update({path: dump(value) for path, value in plan["outputs"].items()})
    touched = set(writes) | set(plan["delete"])
    before = {path: read(root, path) if safe_path(root, path).exists() else None for path in touched}
    backup = root / ".local/library-deduplicate" / plan["plan_id"]
    if any(path.is_symlink() for path in (backup, *backup.parents) if path != root and root in path.parents):
        raise ValueError("Migration backup path contains a symlink")
    backup.mkdir(parents=True, exist_ok=True)
    (backup / "plan.json").write_bytes(dump(plan))
    for path, raw in before.items():
        if raw is not None:
            (backup / digest(raw)).write_bytes(raw)
    (backup / "before.json").write_bytes(dump({path: digest(raw) if raw is not None else None for path, raw in before.items()}))
    try:
        for path, raw in writes.items():
            atomic_write(root, path, raw)
        verify(root, plan["outputs"][plan["report_path"]])
        for path in plan["delete"]:
            if digest(read(root, path)) != plan["inputs"][path]:
                raise ValueError("Source changed before removal: " + path)
            safe_path(root, path).unlink()
        result = {"state": "applied", **verify(root, plan["outputs"][plan["report_path"]])}
        (backup / "result.json").write_bytes(dump(result))
        return result
    except Exception:
        # Only undo our bytes. Preserve any concurrent external modification.
        failures = []
        for path, original in before.items():
            current = read(root, path) if safe_path(root, path).exists() else None
            if current not in (original, writes.get(path)) and not (current is None and path in plan["delete"]):
                failures.append(path); continue
            if original is None:
                if current is not None:
                    safe_path(root, path).unlink()
            elif current != original:
                atomic_write(root, path, original)
        (backup / "result.json").write_bytes(dump({"state": "partial" if failures else "rolled-back", "preserved_external_edits": failures}))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "apply", "verify"), nargs="?", default="plan")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--plan", type=Path, default=ROOT / ".local/library-deduplicate/plan.json")
    parser.add_argument("--report", default=REPORT)
    args = parser.parse_args()
    if args.action == "plan":
        plan = make_plan(args.root)
        args.plan.parent.mkdir(parents=True, exist_ok=True)
        args.plan.write_bytes(dump(plan))
        print(json.dumps({"plan_id": plan["plan_id"], "plan_path": str(args.plan), **plan["outputs"][REPORT]["summary"]}, ensure_ascii=False, indent=2))
    elif args.action == "apply":
        print(json.dumps(apply_plan(args.root, json.loads(args.plan.read_bytes())), indent=2))
    else:
        print(json.dumps(verify(args.root, json.loads(read(args.root.resolve(), args.report))), indent=2))


if __name__ == "__main__":
    main()
