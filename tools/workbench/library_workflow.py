"""Finite, cell-scoped source lifecycle for an explicitly configured public checkout.

The caller owns browser pairing or agent authorization. ``execute`` freezes the
exact authorized request before dispatch; optional previews share the same
durable implementation. There is no HTTP server or approval boolean here. All workflow
state lives below .local, outside the public library and application packages.
"""
import contextlib
import datetime
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile

from platform_compat import file_lock, git_credential_helper, git_devnull


SCHEMA = "circuitgit.library-workflow.v1"
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
SHA = re.compile(r"[a-f0-9]{40}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
TEXT = {".scs", ".rnl", ".va", ".v", ".sv", ".json", ".md", ".txt", ".ocn", ".il"}
PRIVATE = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,})\b|https?://[^\s/@:]+:[^\s/@]+@|/(?:Users|home)/[^/\s]+/", re.I)
MAX_FILE = 1024 * 1024
MAX_DIFF = 256 * 1024
MAX_OUTPUT = 4 * 1024 * 1024


class WorkflowError(ValueError):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code, self.status, self.details = code, status, details or {}


def require(condition, message, code="invalid_request", status=400):
    if not condition:
        raise WorkflowError(code, message, status)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value).encode()).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def identifier(value):
    require(isinstance(value, str) and ID.fullmatch(value) and ".." not in value, "Invalid library/cell identifier")
    return value


def relative_path(value):
    require(isinstance(value, str) and 0 < len(value.encode()) <= 512, "Invalid source path")
    parts = value.split("/")
    require(parts[0] in {"lib", "projects"} and all(p and p not in {".", ".."} and not p.startswith(".") for p in parts)
            and not any(c in value for c in "\\:%?#") and not any(ord(c) < 32 or ord(c) == 127 for c in value), "Invalid source path")
    require(not any(p.lower() in {"private", "pdks", "psf", "ahdlsimdb", "node_modules"} for p in parts)
            and not value.endswith(".local.json"), "Private/runtime files are outside the library workflow")
    return value


def branch_name(value):
    require(isinstance(value, str) and len(value) <= 180 and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]*", value)
            and ".." not in value and "//" not in value and not value.endswith(("/", ".", ".lock"))
            and all(not p.startswith(".") for p in value.split("/")), "Invalid branch name")
    return value


class LibraryWorkflow:
    READ_OPERATIONS = frozenset({"catalog", "describe", "read_file", "current", "history", "commit_detail", "checkpoints", "get_ci", "get_testbenches", "get_testbench_result", "review", "receipt", "pr_status", "branches"})
    PREPARE_OPERATIONS = frozenset({"preview_save", "preview_commit", "preview_restore", "preview_pr", "preview_ci", "preview_testbench", "preview_create_library", "preview_create_cell", "preview_clone_cell", "preview_create_branch", "preview_switch_branch"})
    EXECUTE_OPERATIONS = frozenset({"save", "save_files", "commit", "restore", "pr", "ci", "create_library", "create_cell", "clone_cell", "create_branch", "switch_branch"})
    REPO_OPERATIONS = frozenset({"create_library", "create_cell", "clone_cell", "create_branch", "switch_branch"})

    def __init__(self, root, repository, base_branch="main", state_dir=None, ci_registry=None, gh_bin="gh"):
        self.root = Path(root).resolve(strict=True)
        require(isinstance(repository, str) and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
                and all(p not in {".", ".."} for p in repository.split("/")), "Invalid configured GitHub repository")
        self.repository, self.base_branch = repository, branch_name(base_branch)
        self.git_bin = shutil.which("git") or "git"
        self.gh_bin = shutil.which(gh_bin) or gh_bin
        self.state = Path(state_dir).absolute() if state_dir else self.root / ".local/library-workflow"
        require(self.state.is_relative_to(self.root / ".local"), "Workflow state must remain inside repository .local")
        self._safe_local(self.state)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.ci_registry = self._registry(ci_registry or {})
        self._assert_repository()

    def _safe_local(self, path):
        require(path.is_relative_to(self.root), "Internal state path escaped the checkout")
        for part in [path, *path.parents]:
            if part == self.root:
                break
            require(not part.is_symlink(), "Symlinks are not allowed in workflow state")

    @contextlib.contextmanager
    def _locked(self):
        path = self.state / "workflow.lock"
        self._safe_local(path)
        with file_lock(path):
            yield

    def _git(self, *args, data=None, index=None, check=True, network=False, identity=None, identity_config=False):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0", GIT_NO_REPLACE_OBJECTS="1",
                   GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_ATTR_NOSYSTEM="1",
                   GIT_ALLOW_PROTOCOL="https" if network else "", GIT_PROTOCOL_FROM_USER="0", LC_ALL="C")
        if identity_config:
            env.pop("GIT_CONFIG_GLOBAL", None)  # Read only the user's configured name/email, never run a Git command from configuration.
        if index:
            env["GIT_INDEX_FILE"] = str(index)
        devnull = git_devnull()
        command = [self.git_bin, "--no-pager", "--literal-pathspecs", "-c", "core.hooksPath=" + devnull,
                   "-c", "core.fsmonitor=false", "-c", "core.attributesFile=" + devnull, "-c", "submodule.recurse=false",
                   "-c", "log.showSignature=false", "-c", "diff.renames=false", "-c", "commit.gpgSign=false",
                   "-c", "protocol.allow=never"]
        if identity:
            command += ["-c", "user.name=" + identity["name"], "-c", "user.email=" + identity["email"]]
        if args and args[0] in {"update-index", "read-tree", "write-tree", "diff"}:
            # update-index --cacheinfo can still refresh a real index entry and
            # invoke an attribute clean filter. Disable configured drivers on
            # this invocation, not just hash-object's direct input filtering.
            try:
                filters = subprocess.run([self.git_bin, "-C", str(self.root), "config", "--includes", "--name-only", "--get-regexp",
                                          r"^filter\..*\.(clean|smudge|process|required)$"],
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                raise WorkflowError("git_unavailable", "Git filter settings cannot be safely inspected", 503) from None
            require(filters.returncode in {0, 1} and len(filters.stdout) <= 32768, "Git filter configuration exceeds safe bounds")
            names = set()
            for key in filters.stdout.decode().splitlines():
                match = re.fullmatch(r"filter\.([A-Za-z0-9_.-]+)\.(?:clean|smudge|process|required)", key, re.I)
                require(match is not None, "Git filter name cannot be safely disabled")
                names.add(match[1])
            for name in sorted(names):
                for suffix in ("clean", "smudge", "process"):
                    command += ["-c", "filter." + name + "." + suffix + "="]
                command += ["-c", "filter." + name + ".required=false"]
        if network:
            command += ["-c", "protocol.https.allow=always", "-c", "credential.helper=", "-c",
                        "credential.helper=" + git_credential_helper(self.gh_bin)]
        command += ["-C", str(self.root), *args]
        try:
            result = subprocess.run(command, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=60 if network else 20)
        except (OSError, subprocess.TimeoutExpired):
            raise WorkflowError("git_unavailable", "Git command failed or its outcome is unknown", 503) from None
        require(len(result.stdout) <= MAX_OUTPUT and len(result.stderr) <= 65536, "Git response exceeds the bounded workflow", "output_limit", 413)
        if check and result.returncode:
            raise WorkflowError("git_failed", "Git could not complete the requested operation", 409)
        return result

    def _gh(self, *args):
        env = dict(os.environ, GH_PROMPT_DISABLED="1", GH_PAGER="cat", PAGER="cat")
        try:
            result = subprocess.run([self.gh_bin, *args], cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            raise WorkflowError("github_unknown", "GitHub request failed or its outcome is unknown", 503) from None
        require(result.returncode == 0 and len(result.stdout) <= MAX_OUTPUT, "GitHub request did not return a confirmed result", "github_unknown", 503)
        return result.stdout

    def _assert_repository(self):
        top = self._git("rev-parse", "--show-toplevel").stdout.decode().strip()
        require(Path(top).resolve() == self.root, "Configured directory is not the repository root", "repository_mismatch", 409)
        origin = self._git("config", "--local", "--get", "remote.origin.url").stdout.decode().strip()
        require(origin in {prefix + self.repository + suffix
                           for prefix in ("https://github.com/", "git@github.com:", "ssh://git@github.com/")
                           for suffix in ("", ".git")}, "Repository origin differs from the configured GitHub repository", "repository_mismatch", 409)
        rewrites = self._git("config", "--includes", "--get-regexp", r"^url\..*\.(insteadof|pushinsteadof)$", check=False)
        require(rewrites.returncode == 1, "Repository URL rewrites are not supported", "repository_mismatch", 409)

    def _head(self):
        self._assert_repository()
        head = self._git("rev-parse", "--verify", "HEAD^{commit}").stdout.decode().strip()
        require(SHA.fullmatch(head), "Unsupported Git commit identity")
        return head

    def _branch(self):
        result = self._git("symbolic-ref", "--quiet", "--short", "HEAD", check=False)
        return result.stdout.decode().strip() if not result.returncode else None

    def _identity(self):
        values = {}
        for field in ("name", "email"):
            result = self._git("config", "--get", "user." + field, check=False, identity_config=True)
            require(result.returncode in {0, 1}, "Git committer identity cannot be read", "identity_unavailable", 409)
            values[field] = result.stdout.decode("utf-8").strip() if result.returncode == 0 else ""
        if not all(values.values()):
            return {"name": "CircuitGit Workbench", "email": "circuitgit@localhost.invalid", "source": "neutral_fallback"}
        require(0 < len(values["name"]) <= 120 and not any(ord(c) < 32 or c in "<>" for c in values["name"])
                and len(values["email"]) <= 254 and re.fullmatch(r"[^\s<>@]+@[^\s<>@]+", values["email"]),
                "Configured Git committer identity is invalid", "identity_unavailable", 409)
        return {**values, "source": "git_config"}

    def _blob(self, commit, path):
        require(isinstance(commit, str) and SHA.fullmatch(commit), "A full commit SHA is required")
        relative_path(path)
        row = self._git("ls-tree", "-z", commit, "--", path).stdout
        if not row:
            return None
        mode, kind, oid = row.split(b"\t", 1)[0].decode().split()
        require(kind == "blob" and mode in {"100644", "100755"}, "Historical source is not a regular file")
        raw = self._git("cat-file", "blob", oid).stdout
        require(len(raw) <= MAX_FILE, "Source exceeds the 1 MiB editing limit", "file_limit", 413)
        return raw

    def _json_blob(self, head, path):
        raw = self._blob(head, path)
        require(raw is not None, "Committed library inventory is missing")
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError):
            raise WorkflowError("invalid_inventory", "Committed library metadata is invalid") from None
        require(isinstance(value, dict), "Committed library metadata must be an object")
        return value, digest(raw)

    def _scope(self, library_id, cell_id, snapshot=None):
        lid, cid = identifier(library_id), identifier(cell_id)
        head = self._head() if snapshot is None else snapshot[0]
        catalog, catalog_hash = self._json_blob(head, "lib/catalog.json") if snapshot is None else snapshot[1:3]
        require(catalog.get("schema") == "circuitgit.libraries.v1" and isinstance(catalog.get("libraries"), list), "Invalid committed catalog")
        choices = [item for item in catalog["libraries"] if isinstance(item, dict) and item.get("id") == lid]
        manifest_path = "lib/" + lid + "/library.json"
        require(len(choices) == 1 and choices[0].get("manifest") == manifest_path, "Library identity is not uniquely registered")
        manifest, manifest_hash = self._json_blob(head, manifest_path) if snapshot is None else snapshot[3:5]
        require(manifest.get("schema") == "circuitgit.library.v1" and manifest.get("id") == lid and isinstance(manifest.get("cells"), list), "Invalid committed library identity")
        choices = [item for item in manifest["cells"] if isinstance(item, dict) and item.get("id") == cid]
        directory = "lib/" + lid + "/" + cid
        require(len(choices) == 1 and choices[0].get("directory") == directory, "Cell identity is not uniquely registered")
        cell = choices[0]
        readme = relative_path(cell.get("readme"))
        require(readme.startswith(directory + "/"), "Cell README identity differs")
        paths = {readme}
        require(isinstance(cell.get("views"), list), "Cell views are invalid")
        for view in cell["views"]:
            require(isinstance(view, dict) and isinstance(view.get("files"), list) and view.get("entry") in view["files"], "View inventory is incomplete")
            paths.update(relative_path(path) for path in view["files"])
        require(len(paths) <= 2000, "Cell inventory exceeds workflow bounds")
        project = cell.get("project_id")
        legacy_prefix = "projects/" + identifier(project) + "/" if isinstance(project, str) else None
        owned = {p for p in paths if p.startswith(directory + "/") or legacy_prefix and p.startswith(legacy_prefix)}
        ci_path = directory + "/ci.json"
        owned.add(ci_path)
        source_paths = set(paths)
        bundle_index = directory + "/testbenches/index.json"
        bundle_raw = self._blob(head, bundle_index)
        bundle_paths = set()
        if bundle_raw is not None:
            try:
                bundle_data = json.loads(bundle_raw)
            except ValueError:
                raise WorkflowError("invalid_testbench", "Committed Testbench CI index is invalid") from None
            require(isinstance(bundle_data, dict) and bundle_data.get("schema") == "ic.testbench_ci_index.v1"
                    and (bundle_data.get("library_id"), bundle_data.get("cell_id")) == (lid, cid)
                    and isinstance(bundle_data.get("testbenches"), list) and len(bundle_data["testbenches"]) <= 64,
                    "Committed Testbench CI index differs from the selected cell")
            seen = set()
            for item in bundle_data["testbenches"]:
                require(isinstance(item, dict), "Invalid Testbench CI index entry")
                tid = identifier(item.get("id"))
                require(tid not in seen, "Duplicate Testbench CI registration"); seen.add(tid)
                prefix = directory + "/testbenches/" + tid + "/"
                require(item.get("manifest_path") == prefix + "manifest.json", "Testbench manifest escaped its cell")
                bundle_paths.update(prefix + name for name in ("testbench.scs", "analysis.py", "manifest.json"))
                registered = self._blob(head, item["manifest_path"])
                require(registered is not None and digest(registered) == item.get("manifest_sha256"),
                        "Registered Testbench CI manifest integrity failed", "conflict", 409)
                record = json.loads(registered)
                helpers = self._testbench_helper_files(record.get("agent_manifest"))
                expected = {name: prefix + "helpers/" + name for name in helpers}
                require(record.get("helper_paths", {}) == expected, "Registered Testbench helper inventory differs")
                bundle_paths.update(expected.values())
            bundle_paths.add(bundle_index)
            paths.update(bundle_paths); owned.update(bundle_paths)
        editable = {p for p in owned if PurePosixPath(p).suffix.lower() in TEXT
                    and p not in bundle_paths and not p.endswith(("/docs/provenance.json", "/provenance.json"))}
        return {"library_id": lid, "cell_id": cid, "cell": cell, "head": head, "paths": paths | {ci_path},
                "owned": owned, "editable": editable, "ci_path": ci_path,
                "source_paths": source_paths, "bundle_index": bundle_index, "bundle_paths": bundle_paths,
                "scope_hash": digest([catalog_hash, manifest_hash, lid, cid])}

    def _file(self, path):
        relative_path(path)
        file = self.root / path
        for part in [file, *file.parents]:
            if part == self.root:
                break
            require(not part.is_symlink(), "Source symlinks are not editable")
        if not file.exists():
            return None
        require(file.is_file() and file.stat().st_size <= MAX_FILE, "Source is not a bounded regular file")
        return file.read_bytes()

    def _content(self, path, value):
        require(isinstance(value, str), "Source content must be UTF-8 text")
        raw = value.encode("utf-8")
        require(len(raw) <= MAX_FILE and "\0" not in value, "Source exceeds the text editing limit")
        require(not PRIVATE.search(value), "Private credentials or machine paths cannot be written to public sources")
        if path.endswith(".json"):
            try:
                json.loads(value)
            except ValueError:
                raise WorkflowError("invalid_json", "JSON source is invalid") from None
        return raw

    def _diff(self, path, before, after):
        try:
            a = (before or b"").decode("utf-8").splitlines(keepends=True)
            b = (after or b"").decode("utf-8").splitlines(keepends=True)
        except UnicodeError:
            return "Binary file changed: " + path + "\n"
        value = "".join(difflib.unified_diff(a, b, fromfile="a/" + path, tofile="b/" + path))
        require(len(value.encode()) <= MAX_DIFF, "Diff exceeds the review limit", "diff_limit", 413)
        return value

    def describe(self, library_id, cell_id, published_entry=None, source_sha256=None):
        scope = self._scope(library_id, cell_id)
        match = None
        if published_entry is not None or source_sha256 is not None:
            require(published_entry in scope["paths"] and isinstance(source_sha256, str) and HASH.fullmatch(source_sha256), "Invalid public snapshot identity")
            blob = self._blob(scope["head"], published_entry)
            match = blob is not None and digest(blob) == source_sha256
        return {"schema": SCHEMA, "library_id": library_id, "cell_id": cell_id, "repository": self.repository,
                "branch": self._branch(), "base_branch": self.base_branch, "base_commit": scope["head"],
                "source_match": match, "snapshot_matches_head": match, "scope_hash": scope["scope_hash"],
                "committer": self._identity(),
                "files": [{"path": p, "editable": p in scope["editable"] and p != scope["ci_path"]} for p in sorted(scope["paths"])],
                "capabilities": {"read": True, "save": True, "save_files": True, "execute": True, "commit": self._branch() is not None,
                                 "restore": True, "pr": True, "ci": bool(self._cell_testbenches(scope)), "testbench_review": self._branch() is not None,
                                 "branches": True, "create_library": self._branch() is not None, "create_cell": self._branch() is not None,
                                 "clone_cell": self._branch() is not None, "create_branch": True, "switch_branch": True},
                "provenance_note": "Recorded import provenance remains historical; saved source edits are new working revisions."}

    def catalog(self):
        head = self._head()
        catalog, catalog_hash = self._json_blob(head, "lib/catalog.json")
        require(catalog.get("schema") == "circuitgit.libraries.v1" and isinstance(catalog.get("libraries"), list), "Invalid committed catalog")
        libraries, seen = [], set()
        for item in catalog["libraries"]:
            require(isinstance(item, dict), "Invalid catalog library")
            lid = identifier(item.get("id"))
            require(lid not in seen and item.get("manifest") == "lib/" + lid + "/library.json", "Library is not uniquely registered")
            seen.add(lid)
            manifest, manifest_hash = self._json_blob(head, item["manifest"])
            require(manifest.get("schema") == "circuitgit.library.v1" and manifest.get("id") == lid and isinstance(manifest.get("cells"), list), "Invalid committed library")
            cells = []
            for cell in manifest["cells"]:
                require(isinstance(cell, dict), "Invalid registered cell")
                cid = identifier(cell.get("id"))
                scope = self._scope(lid, cid, (head, catalog, catalog_hash, manifest, manifest_hash))
                candidates = sorted(cell["views"], key=lambda row: {"spectre": 0, "rnl": 1}.get(row.get("kind"), 2))
                source = next((row["entry"] for row in candidates if row.get("kind") == "spectre" and row["entry"] in scope["editable"]), None)
                if source is None:
                    source = next((path for row in candidates if row.get("kind") == "rnl" for path in sorted(row["files"])
                                   if path.startswith(cell["directory"] + "/") and PurePosixPath(path).name == cid + ".scs"
                                   and path in scope["editable"]), None)
                if source is None:
                    source = next((row["entry"] for row in candidates if row["entry"] in scope["editable"] and row["entry"] != scope["ci_path"]), None)
                if source is None:
                    source = next(iter(sorted(scope["editable"] - {scope["ci_path"]})), None)
                cells.append({key: cell.get(key) for key in ("id", "name", "directory", "views", "project_id", "requires_external_models", "kind")})
                cells[-1]["source_path"] = source
            libraries.append({"id": lid, "name": manifest.get("name", item.get("name", lid)), "cells": cells})
        result = {"schema": SCHEMA, "repository": self.repository, "base_commit": head, "libraries": libraries}
        require(len(canonical(result).encode()) <= MAX_OUTPUT, "Library catalog exceeds output bounds", "output_limit", 413)
        require(self._head() == head, "Library history changed while reading catalog", "conflict", 409)
        return result

    def _revision(self, scope, files=None):
        """Observe the full readable closure, including dependencies owned by other cells."""
        files = files if files is not None else {path: self._file(path) for path in sorted(scope["paths"])}
        checkpoints = []
        for path in (self.state / "checkpoints").glob("*.json"):
            record = self._record(path)
            if (record.get("library_id"), record.get("cell_id")) == (scope["library_id"], scope["cell_id"]):
                checkpoints.append(path.stem)
        return digest({"head": scope["head"], "scope": scope["scope_hash"], "checkpoints": sorted(checkpoints),
                       "files": {path: digest(raw) if raw is not None else None for path, raw in files.items()}})

    def read_file(self, library_id, cell_id, path):
        scope = self._scope(library_id, cell_id)
        require(path in scope["paths"], "File is not in this cell's committed inventory", "out_of_scope", 403)
        observed = {source: self._file(source) for source in sorted(scope["paths"])}
        raw, committed = observed[path], self._blob(scope["head"], path)
        require(raw is not None, "Source file is missing", "not_found", 404)
        try:
            content = raw.decode("utf-8")
        except UnicodeError:
            raise WorkflowError("not_text", "This source is not editable UTF-8 text") from None
        revision = self._revision(scope, observed)
        return {"path": path, "content": content, "text": content, "sha256": digest(raw), "revision": revision, "fingerprint": revision,
                "head_sha256": digest(committed) if committed is not None else None, "base_commit": scope["head"],
                "editable": path in scope["editable"] and path != scope["ci_path"]}

    def current(self, library_id, cell_id):
        scope = self._scope(library_id, cell_id)
        changes, diffs = [], []
        observed = {path: self._file(path) for path in sorted(scope["paths"])}
        for path in sorted(scope["owned"]):
            before, after = self._blob(scope["head"], path), observed[path]
            if before == after:
                continue
            changes.append({"path": path, "status": "A" if before is None else "D" if after is None else "M",
                            "before_sha256": digest(before) if before is not None else None,
                            "sha256": digest(after) if after is not None else None, "editable": path in scope["editable"]})
            diffs.append(self._diff(path, before, after))
        diff = "".join(diffs)
        require(len(diff.encode()) <= MAX_DIFF, "Cell diff exceeds the review limit", "diff_limit", 413)
        revision = self._revision(scope, observed)
        return {"schema": SCHEMA, "library_id": library_id, "cell_id": cell_id, "base_commit": scope["head"], "revision": revision, "fingerprint": revision,
                "branch": self._branch(), "changes": changes, "dirty": bool(changes), "diff": diff}

    def _reachable(self, commit, head):
        require(isinstance(commit, str) and SHA.fullmatch(commit), "Use a full lowercase commit SHA")
        require(self._git("merge-base", "--is-ancestor", commit, head, check=False).returncode == 0,
                "Commit is not part of this checkout's current history", "unknown_commit", 404)

    def _commit_metadata(self, commit, paths):
        raw = self._git("show", "-s", "--no-notes", "--format=%H%x00%P%x00%aI%x00%s%x00%b", commit).stdout.decode("utf-8", errors="replace")
        sha, parents, timestamp, subject, body = raw.split("\0", 4)
        require(len(subject) + len(body) <= 16384, "Commit description exceeds the display limit")
        parent_list = parents.split()
        args = ["diff-tree", "--no-commit-id", "--no-renames", "-r", "--name-only", "-z"]
        args += [parent_list[0], commit] if parent_list else ["--root", commit]
        changed = self._git(*args, "--", *sorted(paths)).stdout.decode().rstrip("\0").split("\0")
        return {"sha": sha, "parents": parent_list, "timestamp": timestamp, "subject": subject,
                "title": subject, "body": body.rstrip(), "files": [p for p in changed if p]}

    def history(self, library_id, cell_id, limit=30):
        require(type(limit) is int and 1 <= limit <= 100, "History limit must be 1–100")
        scope = self._scope(library_id, cell_id)
        hashes = self._git("log", "--first-parent", "--no-notes", "--format=%H", "-n", str(limit + 1), scope["head"], "--", *sorted(scope["owned"])).stdout.decode().splitlines()
        return {"base_commit": scope["head"], "commits": [self._commit_metadata(h, scope["owned"]) for h in hashes[:limit]], "has_more": len(hashes) > limit}

    def commit_detail(self, library_id, cell_id, commit):
        scope = self._scope(library_id, cell_id)
        self._reachable(commit, scope["head"])
        metadata = self._commit_metadata(commit, scope["owned"])
        require(metadata["files"], "Commit has no changes for this cell", "unknown_commit", 404)
        diff = "".join(self._diff(path, self._blob(metadata["parents"][0], path) if metadata["parents"] else None,
                                  self._blob(commit, path)) for path in metadata["files"])
        require(len(diff.encode()) <= MAX_DIFF, "Commit diff exceeds review bounds", "diff_limit", 413)
        return {"base_commit": scope["head"], "commit": metadata, "files": metadata["files"], "diff": diff}

    def _append(self, path, value):
        self._safe_local(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        raw = canonical(value).encode() if not isinstance(value, bytes) else value
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            require(path.read_bytes() == raw, "Immutable workflow record already exists with different content", "conflict", 409)
            return
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        self._fsync_dir(path.parent)

    def _fsync_dir(self, path):
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _record(self, path):
        self._safe_local(path)
        require(path.is_file() and path.stat().st_size <= 4 * MAX_FILE, "Workflow record is missing or invalid", "not_found", 404)
        return json.loads(path.read_text())

    def _review(self, scope, operation, payload, diff="", summary=""):
        record = {"schema": SCHEMA, "operation": operation, "library_id": scope["library_id"], "cell_id": scope["cell_id"],
                  "repository": self.repository, "branch": self._branch(), "base_commit": scope["head"], "scope_hash": scope["scope_hash"],
                  "payload": payload, "diff": diff, "summary": summary, "automatic_push": False}
        require(len(canonical(record).encode()) <= 4 * MAX_FILE, "Review exceeds the durable record limit", "review_limit", 413)
        review_id = digest(record)
        self._append(self.state / "reviews" / (review_id + ".json"), record)
        return {**record, "review_id": review_id, "files": payload.get("files", [payload["path"]] if "path" in payload else [])}

    def review(self, review_id):
        require(isinstance(review_id, str) and HASH.fullmatch(review_id), "Invalid review ID")
        record = self._record(self.state / "reviews" / (review_id + ".json"))
        require(digest(record) == review_id, "Frozen review integrity check failed", "conflict", 409)
        return {**record, "review_id": review_id}

    def _save_review(self, scope, path, content, base_sha256, operation="save", extra=None):
        require(path in scope["editable"], "File is not an editable source owned by this cell", "out_of_scope", 403)
        before = self._file(path)
        actual = digest(before) if before is not None else None
        require(base_sha256 == actual, "Source changed; read the current file before preparing again", "conflict", 409)
        after = self._content(path, content)
        require(after != before, "No source change to review")
        payload = {"path": path, "content": content, "base_sha256": actual, "sha256": digest(after),
                   "checkpoint_base": self._checkpoint_base(scope, path), **(extra or {})}
        return self._review(scope, operation, payload, self._diff(path, before, after), "Restore source as a new change" if operation == "restore" else "Save a local source checkpoint")

    def preview_save(self, library_id, cell_id, path, base_sha256, content=None, text=None):
        scope = self._scope(library_id, cell_id)
        require(path != scope["ci_path"], "Use the reviewed CI selector for cell CI configuration")
        require(content is None or text is None or content == text, "Conflicting source content")
        return self._save_review(scope, path, content if content is not None else text, base_sha256)

    def _preview_save_files(self, library_id, cell_id, files):
        scope = self._scope(library_id, cell_id)
        require(isinstance(files, list) and 1 <= len(files) <= 32, "Grouped save requires 1–32 cell files")
        changes, diffs, seen = [], [], set()
        for item in files:
            require(isinstance(item, dict) and set(item) == {"path", "base_sha256", "content"}, "Each grouped file needs path, base_sha256 and content")
            path = relative_path(item["path"])
            require(path not in seen and path in scope["editable"] and path != scope["ci_path"], "Grouped save must contain distinct editable files owned by one cell", "out_of_scope", 403)
            seen.add(path)
            before, after = self._file(path), self._content(path, item["content"])
            require(item["base_sha256"] == (digest(before) if before is not None else None), "Grouped source changed; read all files again", "conflict", 409)
            require(before != after, "Each grouped file must contain a change")
            changes.append({**item, "sha256": digest(after), "checkpoint_base": self._checkpoint_base(scope, path)})
            diffs.append(self._diff(path, before, after))
        diff = "".join(diffs)
        require(len(diff.encode()) <= MAX_DIFF, "Grouped diff exceeds the review limit", "diff_limit", 413)
        return self._review(scope, "save_files", {"files": [row["path"] for row in changes], "changes": changes}, diff,
                            "Save coordinated cell source checkpoints")

    def _checkpoint(self, checkpoint_id):
        require(isinstance(checkpoint_id, str) and HASH.fullmatch(checkpoint_id), "Invalid checkpoint ID")
        record = self._record(self.state / "checkpoints" / (checkpoint_id + ".json"))
        receipt = self.receipt(record["operation_id"])
        require(receipt["state"] == "complete", "Checkpoint save has not been confirmed complete", "outcome_unknown", 409)
        return record

    def _checkpoint_base(self, scope, source_path):
        """Distinguish an explicit new edit after a restore from replaying an old review."""
        ids = []
        for path in (self.state / "checkpoints").glob("*.json"):
            record = self._record(path)
            if (record.get("library_id"), record.get("cell_id"), record.get("path")) == (scope["library_id"], scope["cell_id"], source_path):
                ids.append(path.stem)
        return digest(sorted(ids))

    def checkpoints(self, library_id, cell_id, limit=30):
        scope = self._scope(library_id, cell_id)
        require(type(limit) is int and 1 <= limit <= 100, "Checkpoint limit must be 1–100")
        records = []
        for path in sorted((self.state / "checkpoints").glob("*.json")):
            record = self._record(path)
            if (record.get("library_id"), record.get("cell_id")) != (library_id, cell_id):
                continue
            receipt = self.receipt(record["operation_id"])
            records.append({**record, "state": receipt["state"], "restore_versions": ["before", "after"] if record["before_sha256"] else ["after"]})
        records.sort(key=lambda row: row["created_at"], reverse=True)
        revision = self._revision(scope)
        return {"checkpoints": records[:limit], "has_more": len(records) > limit, "revision": revision, "fingerprint": revision}

    def preview_restore(self, library_id, cell_id, path, base_sha256, checkpoint_id=None, commit=None, checkpoint_version="after"):
        require((checkpoint_id is None) != (commit is None), "Choose one checkpoint or historical commit")
        require(checkpoint_version in {"before", "after"}, "Choose the saved before or after source")
        scope = self._scope(library_id, cell_id)
        require(path != scope["ci_path"], "Restore CI settings through the current registered CI selector")
        if checkpoint_id is not None:
            checkpoint = self._checkpoint(checkpoint_id)
            require((checkpoint["library_id"], checkpoint["cell_id"], checkpoint["path"]) == (library_id, cell_id, path), "Checkpoint belongs to a different cell/file")
            wanted_hash = checkpoint["before_sha256"] if checkpoint_version == "before" else checkpoint["sha256"]
            require(wanted_hash is not None, "The file did not exist before this checkpoint; deletion is not supported")
            object_path = self.state / "objects" / wanted_hash
            self._safe_local(object_path)
            require(object_path.is_file() and object_path.stat().st_size <= MAX_FILE, "Checkpoint object is unavailable")
            raw = object_path.read_bytes()
            require(digest(raw) == wanted_hash, "Checkpoint content integrity check failed")
        else:
            self._reachable(commit, scope["head"])
            raw = self._blob(commit, path)
            require(raw is not None, "Historical file is absent; no partial restore was prepared")
        return self._save_review(scope, path, raw.decode("utf-8"), base_sha256, "restore", {"target_commit": commit, "checkpoint_id": checkpoint_id, "checkpoint_version": checkpoint_version})

    def preview_commit(self, library_id, cell_id, base_commit, message=None, title=None, body=None):
        scope = self._scope(library_id, cell_id)
        require(base_commit == scope["head"] and self._branch(), "Commit base changed or checkout is detached", "conflict", 409)
        if message is None:
            message = (title or "") + ("\n\n" + body if body else "")
        require(isinstance(message, str) and 0 < len(message.strip()) <= 8000 and "\0" not in message, "Commit needs a bounded title/description")
        require(not PRIVATE.search(message), "Private credentials or machine paths cannot enter public commit descriptions")
        current = self.current(library_id, cell_id)
        require(current["changes"], "Cell has no changes to commit")
        paths = [item["path"] for item in current["changes"]]
        require(all(p in scope["editable"] for p in paths), "Cell has binary or historical-provenance changes; handle those separately")
        staged = self._git("diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z", scope["head"], "--", *paths).stdout
        require(not staged, "Selected cell files have staged changes; preserve that staging before using the web commit", "conflict", 409)
        require(not any(item["status"] == "D" for item in current["changes"]), "File deletion is not supported by this source editor")
        snapshots = []
        for path in paths:
            raw = self._file(path)
            self._content(path, raw.decode("utf-8"))
            if path == scope["ci_path"]:
                self._validate_ci(scope, json.loads(raw))
            snapshots.append({"path": path, "content": raw.decode("utf-8"), "sha256": digest(raw)})
        return self._review(scope, "commit", {"message": message, "files": paths, "snapshots": snapshots, "committer": self._identity()}, current["diff"], "Create a scoped local Git commit; no push")

    def _registry(self, registry):
        if isinstance(registry, dict) and "testbenches" in registry:
            registry = registry["testbenches"]
        items = list(registry.values()) if isinstance(registry, dict) else registry
        require(isinstance(items, list) and len(items) <= 1000, "Invalid configured testbench registry")
        result = {}
        for item in items:
            require(isinstance(item, dict), "Invalid testbench registration")
            tid = identifier(item.get("id"))
            require(tid not in result, "Duplicate testbench registration")
            identifier(item.get("library_id")); identifier(item.get("cell_id"))
            relative_path(item.get("configuration_path"))
            require(item.get("engine") in {"source-check", "spectre"}, "Unsupported registered CI engine")
            require(isinstance(item.get("workflow_path"), str) and re.fullmatch(r"\.github/workflows/[A-Za-z0-9_-]+\.ya?ml", item["workflow_path"]), "Invalid registered workflow path")
            result[tid] = {key: item[key] for key in ("id", "library_id", "cell_id", "configuration_path", "engine", "workflow_path", "label", "requires_external_models", "available") if key in item}
        return result

    def _cell_testbenches(self, scope):
        return [row for row in self.ci_registry.values() if (row["library_id"], row["cell_id"]) == (scope["library_id"], scope["cell_id"])]

    def get_ci(self, library_id, cell_id):
        scope = self._scope(library_id, cell_id)
        raw = self._file(scope["ci_path"])
        config = json.loads(raw) if raw is not None else None
        if config is not None:
            self._validate_ci(scope, config)
        return {"path": scope["ci_path"], "sha256": digest(raw) if raw is not None else None, "config": config,
                "testbenches": self._cell_testbenches(scope), "execution_status": "not_checked",
                "agent_testbenches": self.get_testbenches(library_id, cell_id),
                "note": "Configuration selects registered checks only. No workflow or Spectre simulation has been started."}

    def _validate_ci(self, scope, config):
        require(isinstance(config, dict) and set(config) == {"schema", "library_id", "cell_id", "enabled", "testbench_ids"}
                and config.get("schema") == "circuitgit.cell-ci.v1" and config.get("library_id") == scope["library_id"]
                and config.get("cell_id") == scope["cell_id"] and type(config.get("enabled")) is bool, "Invalid cell CI identity/schema")
        selected = config.get("testbench_ids")
        allowed = {row["id"] for row in self._cell_testbenches(scope)}
        require(isinstance(selected, list) and len(selected) <= 32 and all(isinstance(tid, str) for tid in selected)
                and len(set(selected)) == len(selected) and set(selected) <= allowed
                and (not config["enabled"] or bool(selected)), "CI configuration must select registered testbenches for this cell")

    def preview_ci(self, library_id, cell_id, testbench_ids, enabled, base_sha256):
        scope = self._scope(library_id, cell_id)
        require(type(enabled) is bool and isinstance(testbench_ids, list) and len(testbench_ids) <= 32
                and all(isinstance(tid, str) for tid in testbench_ids) and len(set(testbench_ids)) == len(testbench_ids), "Invalid cell CI selection")
        allowed = {row["id"] for row in self._cell_testbenches(scope)}
        require(set(testbench_ids) <= allowed and (not enabled or bool(testbench_ids)), "Choose registered testbenches belonging to this cell")
        config = {"schema": "circuitgit.cell-ci.v1", "library_id": library_id, "cell_id": cell_id,
                  "enabled": enabled, "testbench_ids": testbench_ids}
        self._validate_ci(scope, config)
        return self._save_review(scope, scope["ci_path"], json.dumps(config, indent=2) + "\n", base_sha256, "ci", {"registry_hash": digest(self.ci_registry)})

    def _testbench_source(self, scope, require_clean=False):
        hashes = {}
        for path in sorted(scope["source_paths"]):
            raw = self._file(path)
            require(raw is not None, "The cell source closure contains a missing file", "conflict", 409)
            if require_clean:
                require(raw == self._blob(scope["head"], path), "Commit the exact cell source before proposing a Testbench CI", "conflict", 409)
            hashes[path] = digest(raw)
        return {"source_commit": scope["head"], "files": hashes, "sha256": digest(hashes), "inventory_sha256": digest(scope["cell"])}

    def _testbench_index(self, scope):
        raw = self._file(scope["bundle_index"])
        require(raw == self._blob(scope["head"], scope["bundle_index"]), "Testbench CI index has uncommitted changes", "conflict", 409)
        return json.loads(raw) if raw else {"schema": "ic.testbench_ci_index.v1", "library_id": scope["library_id"],
                                          "cell_id": scope["cell_id"], "testbenches": []}

    def _agent_testbench_manifest(self, manifest):
        # Load only the fixed, installed stdlib validator. Repository candidate
        # Python and authored analysis.py are never imported by this workflow.
        spec = importlib.util.spec_from_file_location("ic_agent_testbench_manifest", Path(__file__).with_name("agent_testbench_manifest.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        try:
            validated = module.validate_manifest(manifest)
        except (ValueError, TypeError):
            raise WorkflowError("invalid_testbench", "Provide a complete finite ic.agent_testbench.v1 manifest") from None
        require(bool(validated["criteria"]), "Explicit Testbench CI acceptance criteria are required")
        return validated["criteria"]

    def _testbench_helper_files(self, manifest):
        spec = importlib.util.spec_from_file_location("ic_agent_testbench_manifest", Path(__file__).with_name("agent_testbench_manifest.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        try:
            return module.helper_files(module.validate_manifest(manifest))
        except (ValueError, TypeError):
            raise WorkflowError("invalid_testbench", "Testbench helpers must be bounded relative literal sources") from None

    def preview_testbench(self, library_id, cell_id, testbench_id, base_commit, testbench, analysis, manifest, title, body=""):
        """Freeze Agent-authored bytes for the existing correlated human Web review.

        This method creates local review data only. It is deliberately absent
        from EXECUTE_OPERATIONS: the Agent cannot register executable code.
        """
        scope = self._scope(library_id, cell_id)
        tid = identifier(testbench_id)
        require(base_commit == scope["head"] and self._branch() is not None, "An exact current source commit and attached branch are required", "conflict", 409)
        require(isinstance(title, str) and 0 < len(title.strip()) <= 120 and not any(ord(c) < 32 for c in title), "Invalid Testbench CI title")
        require(isinstance(body, str) and len(body) <= 8000 and "\0" not in body and not PRIVATE.search(title + "\n" + body), "Invalid Testbench CI description")
        criteria = self._agent_testbench_manifest(manifest)
        helpers = self._testbench_helper_files(manifest)
        require(manifest["text"] == testbench, "Manifest text must equal the complete reviewed testbench bytes")
        source = self._testbench_source(scope, require_clean=True)
        prefix = scope["cell"]["directory"] + "/testbenches/" + tid + "/"
        tb = self._content(prefix + "testbench.scs", testbench)
        script = self._content(prefix + "analysis.py", analysis)
        require(tb.strip() and script.strip(), "A complete testbench and analysis script are required")
        # Syntax checking is non-executing. Python is retained for code review,
        # never imported or run by a library/CI operation.
        try:
            compile(analysis, "analysis.py", "exec", dont_inherit=True)
        except (SyntaxError, ValueError):
            raise WorkflowError("invalid_testbench", "Analysis script is not valid Python source") from None
        self._content(prefix + "manifest.json", canonical(manifest))
        binding = {"source_commit": source["source_commit"], "source_sha256": source["sha256"],
                   "source_inventory_sha256": source["inventory_sha256"],
                   "testbench_sha256": digest(tb), "analysis_sha256": digest(script),
                   "manifest_sha256": digest(manifest), "criteria_sha256": digest(criteria)}
        if helpers:
            binding["helper_sha256"] = {name: digest(raw) for name, raw in helpers.items()}
        record = {"schema": "ic.testbench_ci.v1", "id": tid, "library_id": library_id, "cell_id": cell_id,
                  "source": source, "binding": binding, "agent_manifest": manifest,
                  "testbench_path": prefix + "testbench.scs", "analysis_path": prefix + "analysis.py",
                  "execution": "spiceowl_named_algorithm", "arbitrary_script_execution": False,
                  "title": title.strip(), "body": body, "simulation_started": False}
        if helpers:
            record["helper_paths"] = {name: prefix + "helpers/" + name for name in helpers}
        contents = {prefix + "testbench.scs": testbench, prefix + "analysis.py": analysis,
                    prefix + "manifest.json": json.dumps(record, ensure_ascii=False, indent=2) + "\n"}
        contents.update({prefix + "helpers/" + name: raw.decode("utf-8") for name, raw in helpers.items()})
        index = self._testbench_index(scope)
        index["testbenches"] = [item for item in index["testbenches"] if item["id"] != tid]
        require(len(index["testbenches"]) < 64, "A cell can register at most 64 Testbench CI bundles")
        index["testbenches"].append({"id": tid, "manifest_path": prefix + "manifest.json",
                                   "manifest_sha256": digest(contents[prefix + "manifest.json"].encode()), "enabled": True})
        index["testbenches"].sort(key=lambda item: item["id"])
        contents[scope["bundle_index"]] = json.dumps(index, ensure_ascii=False, indent=2) + "\n"
        snapshots, per_file = [], []
        for path, content in contents.items():
            raw, before = self._content(path, content), self._file(path)
            require(before == self._blob(scope["head"], path), "Testbench bundle has uncommitted files; preserve them before proposing an update", "conflict", 409)
            sha = digest(before) if before is not None else None
            snapshots.append({"path": path, "content": content, "base_sha256": sha, "sha256": digest(raw),
                              "checkpoint_base": self._checkpoint_base(scope, path)})
            per_file.append({"path": path, "before_sha256": sha, "sha256": digest(raw), "diff": self._diff(path, before, raw)})
        files = sorted(contents)
        staged = self._git("diff", "--cached", "--name-only", "-z", "--", *files).stdout
        require(not staged, "Testbench paths have staged changes; preserve that staging before registration", "conflict", 409)
        diff = "".join(item["diff"] for item in per_file)
        require(diff and len(diff.encode()) <= MAX_DIFF, "Testbench preview is empty or exceeds review bounds", "diff_limit", 413)
        payload = {"testbench_id": tid, "files": files, "snapshots": snapshots, "per_file_diffs": per_file,
                   "manifest": manifest, "binding": binding, "source": source, "committer": self._identity(),
                   "message": title.strip() + ("\n\n" + body.strip() if body.strip() else ""),
                   "human_review_required": True, "simulation_started": False}
        return self._review(scope, "register_testbench", payload, diff,
                            "Review all testbench, analysis and criteria bytes; confirm once to register a cell-scoped Git version. No simulation is submitted.")

    def get_testbenches(self, library_id, cell_id):
        scope = self._scope(library_id, cell_id)
        index = self._testbench_index(scope)
        source = self._testbench_source(scope)
        result_records = []
        for path in sorted((self.state / "testbench-results").glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:256]:
            value = self._record(path)
            if (value.get("library_id"), value.get("cell_id")) == (library_id, cell_id):
                require(value.get("schema") == "ic.testbench_ci_result.v1" and digest(value) == path.stem, "Saved CI result integrity failed")
                result_records.append({"result_id": path.stem, **{key: value.get(key) for key in
                                      ("testbench_id", "registration_commit", "binding", "status", "job_id", "analysis_id", "evaluation", "source_commit")}})
                if len(result_records) >= 32:
                    break
        bundles = []
        for item in index["testbenches"]:
            raw = self._blob(scope["head"], item["manifest_path"])
            require(raw is not None and digest(raw) == item.get("manifest_sha256"), "Registered Testbench CI manifest integrity failed", "conflict", 409)
            record = json.loads(raw)
            require(record.get("schema") == "ic.testbench_ci.v1" and record.get("id") == item["id"]
                    and (record.get("library_id"), record.get("cell_id")) == (library_id, cell_id), "Registered Testbench CI identity differs")
            require(isinstance(record.get("source"), dict) and isinstance(record["source"].get("files"), dict)
                    and record["source"].get("sha256") == digest(record["source"]["files"])
                    and record.get("binding", {}).get("source_sha256") == record["source"]["sha256"]
                    and record["binding"].get("source_inventory_sha256") == record["source"].get("inventory_sha256")
                    and record["binding"].get("source_commit") == record["source"].get("source_commit"), "Registered source binding integrity failed")
            prefix = scope["cell"]["directory"] + "/testbenches/" + item["id"] + "/"
            for name, field in (("testbench.scs", "testbench_sha256"), ("analysis.py", "analysis_sha256")):
                content = self._blob(scope["head"], prefix + name)
                require(content is not None and digest(content) == record["binding"].get(field), "Registered Testbench CI file integrity failed", "conflict", 409)
            require(digest(record["agent_manifest"]) == record["binding"].get("manifest_sha256")
                    and digest(self._agent_testbench_manifest(record["agent_manifest"])) == record["binding"].get("criteria_sha256"), "Registered criteria integrity failed")
            helpers = self._testbench_helper_files(record["agent_manifest"])
            require(record["binding"].get("helper_sha256", {}) == {name: digest(raw) for name, raw in helpers.items()},
                    "Registered Testbench helper binding differs", "conflict", 409)
            for name, expected in helpers.items():
                content = self._blob(scope["head"], prefix + "helpers/" + name)
                require(content == expected, "Registered Testbench helper bytes changed", "conflict", 409)
            commit = self._git("log", "-1", "--format=%H", scope["head"], "--", item["manifest_path"]).stdout.decode().strip()
            bundles.append({"id": item["id"], "title": record.get("title", item["id"]), "enabled": item.get("enabled") is True,
                            "manifest_path": item["manifest_path"], "registration_commit": commit, "binding": record["binding"],
                            "source_matches": source["files"] == record["source"]["files"] and source["inventory_sha256"] == record["source"]["inventory_sha256"], "execution": record["execution"],
                            "execution_status": "not_run", "arbitrary_script_execution": False})
            results = [result for result in result_records if result["testbench_id"] == item["id"]
                       and result["registration_commit"] == commit and result["binding"] == record["binding"]]
            if results:
                bundles[-1].update(execution_status=results[0]["status"], latest_result=results[0])
            pending_runs = []
            for request_path in (self.state / "testbench-runs").glob("*/request.json"):
                if (request_path.parent / "complete.json").exists():
                    continue
                pending = self._record(request_path)
                if ((pending.get("library_id"), pending.get("cell_id"), pending.get("testbench_id")) == (library_id, cell_id, item["id"])
                        and pending.get("registration_commit") == commit and pending.get("binding") == record["binding"]):
                    pending_runs.append({"run_key": request_path.parent.name, "automatic_retry": False})
            if pending_runs:
                bundles[-1].update(execution_status="unknown", pending_runs=pending_runs[:16])
        proposals = []
        for path in sorted((self.state / "reviews").glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:256]:
            record = self._record(path)
            if record.get("operation") != "register_testbench" or (record.get("library_id"), record.get("cell_id")) != (library_id, cell_id):
                continue
            payload = record["payload"]
            receipt = self.receipt(review_id=path.stem)
            proposals.append({"review_id": path.stem, "id": payload["testbench_id"], "title": payload["message"].split("\n", 1)[0],
                              "binding": payload["binding"], "base_commit": record["base_commit"], "state": receipt["state"],
                              "source_matches": record["base_commit"] == scope["head"] and payload["source"]["files"] == source["files"],
                              "files": payload["files"], "per_file_diffs": payload["per_file_diffs"]})
            if len(proposals) >= 20:
                break
        result = {"library_id": library_id, "cell_id": cell_id, "base_commit": scope["head"], "bundles": bundles,
                  "proposals": proposals, "results": result_records, "simulation_started": False,
                  "note": "Registration versions reviewed bytes only. Named analysis and remote solver require their own exact artifact/run binding."}
        require(len(canonical(result).encode()) <= MAX_OUTPUT, "Testbench inventory exceeds bounded output", "output_limit", 413)
        return result

    def get_testbench_result(self, library_id, cell_id, testbench_id, result_id):
        self._scope(library_id, cell_id)
        tid = identifier(testbench_id)
        require(isinstance(result_id, str) and HASH.fullmatch(result_id), "An exact CI result digest is required")
        value = self._record(self.state / "testbench-results" / (result_id + ".json"))
        require(digest(value) == result_id and (value.get("library_id"), value.get("cell_id"), value.get("testbench_id")) == (library_id, cell_id, tid),
                "CI result does not belong to this exact cell/testbench", "out_of_scope", 403)
        return {**value, "result_id": result_id}

    def testbench_registration(self, library_id, cell_id, testbench_id, registration_commit, binding):
        """Require this host's durable human-reviewed registration, not Git data alone."""
        identifier(library_id); identifier(cell_id); identifier(testbench_id)
        require(isinstance(registration_commit, str) and SHA.fullmatch(registration_commit), "Exact registered commit required")
        for path in (self.state / "operations").glob("*/complete.json"):
            value = self._record(path)
            if (value.get("operation") != "register_testbench" or value.get("registered") is not True
                    or value.get("state") != "complete" or value.get("registration_commit") != registration_commit
                    or value.get("testbench_id") != testbench_id or value.get("binding") != binding):
                continue
            review = self.review(value["review_id"])
            if (review["library_id"], review["cell_id"]) != (library_id, cell_id):
                continue
            require(review["operation"] == "register_testbench" and review["payload"]["binding"] == binding,
                    "Registration receipt differs from its frozen review")
            return {"review_id": value["review_id"], "operation_id": value["operation_id"], "registration_commit": registration_commit}
        raise WorkflowError("review_required", "This host has no completed human-reviewed registration for the exact Testbench CI version", 403)

    def testbench_review(self, library_id, cell_id, review_id):
        """Read one exact proposal for a paired browser to open human review."""
        scope = self._scope(library_id, cell_id)
        review = self.review(review_id)
        require(review.get("operation") == "register_testbench"
                and (review.get("library_id"), review.get("cell_id")) == (library_id, cell_id),
                "Testbench review does not belong to this cell", "out_of_scope", 403)
        require(review["base_commit"] == scope["head"] and review["scope_hash"] == scope["scope_hash"]
                and review["payload"]["source"] == self._testbench_source(scope, require_clean=True),
                "Testbench source changed; prepare a new review", "conflict", 409)
        return review

    def _base(self):
        for ref in ("refs/remotes/origin/" + self.base_branch, "refs/heads/" + self.base_branch):
            result = self._git("rev-parse", "--verify", "--end-of-options", ref + "^{commit}", check=False)
            if result.returncode == 0:
                return result.stdout.decode().strip()
        raise WorkflowError("base_unavailable", "The configured base branch is not available locally", 409)

    def _working_dirty(self):
        out = self._git("status", "--porcelain=v1", "-z", "--untracked-files=no").stdout
        return bool(out)

    def branches(self):
        """List local Git branches and working-tree cleanliness without network I/O."""
        head = self._head()
        current = self._branch()
        raw = self._git("for-each-ref", "--format=%(refname:short)\t%(objectname)", "refs/heads").stdout.decode("utf-8")
        items = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            name, commit = line.split("\t", 1)
            items.append({
                "name": name,
                "commit": commit,
                "is_current": name == current,
                "is_base": name == self.base_branch,
            })
        return {
            "schema": SCHEMA,
            "repository": self.repository,
            "current_branch": current,
            "base_branch": self.base_branch,
            "head": head,
            "dirty": self._working_dirty(),
            "branches": items,
        }

    def _repo_review(self, operation, base_commit, scope_hash, payload, diff="", summary="", library_id=None, cell_id=None):
        review = {
            "schema": SCHEMA,
            "operation": operation,
            "library_id": library_id,
            "cell_id": cell_id,
            "repository": self.repository,
            "branch": self._branch(),
            "base_commit": base_commit,
            "scope_hash": scope_hash,
            "summary": summary,
            "diff": diff,
            "payload": payload,
        }
        rid = digest(review)
        self._append(self.state / "reviews" / (rid + ".json"), review)
        return {**review, "review_id": rid}

    def preview_create_library(self, library_id, name, base_commit, description=""):
        lid = identifier(library_id)
        head = self._head()
        require(base_commit == head and self._branch() is not None, "Base commit changed or checkout is detached", "conflict", 409)
        require(isinstance(name, str) and 0 < len(name.strip()) <= 120 and not any(ord(c) < 32 for c in name), "Invalid library name")
        require(isinstance(description, str) and len(description) <= 2000 and "\0" not in description and not PRIVATE.search(name + "\n" + description), "Invalid library description")
        catalog, catalog_hash = self._json_blob(head, "lib/catalog.json")
        require(catalog.get("schema") == "circuitgit.libraries.v1" and isinstance(catalog.get("libraries"), list), "Invalid committed catalog")
        require(not any(isinstance(item, dict) and item.get("id") == lid for item in catalog["libraries"]), "Library already exists", "conflict", 409)
        manifest_path = "lib/" + lid + "/library.json"
        require(self._blob(head, manifest_path) is None and self._file(manifest_path) is None, "Library manifest already exists", "conflict", 409)
        require(self._file("lib/catalog.json") == self._blob(head, "lib/catalog.json"), "lib/catalog.json has uncommitted edits; commit or revert first", "conflict", 409)
        updated_catalog = {
            **catalog,
            "libraries": [
                *catalog["libraries"],
                {"id": lid, "name": name.strip(), "description": description.strip(), "manifest": manifest_path},
            ],
        }
        new_manifest = {
            "schema": "circuitgit.library.v1",
            "id": lid,
            "name": name.strip(),
            "description": description.strip(),
            "cells": [],
        }
        catalog_text = json.dumps(updated_catalog, indent=2, ensure_ascii=False) + "\n"
        manifest_text = json.dumps(new_manifest, indent=2, ensure_ascii=False) + "\n"
        self._content("lib/catalog.json", catalog_text)
        self._content(manifest_path, manifest_text)
        snapshots = [
            {"path": "lib/catalog.json", "base_sha256": catalog_hash, "sha256": digest(catalog_text.encode()), "content": catalog_text},
            {"path": manifest_path, "base_sha256": None, "sha256": digest(manifest_text.encode()), "content": manifest_text},
        ]
        diff = self._diff("lib/catalog.json", self._blob(head, "lib/catalog.json"), catalog_text.encode()) + self._diff(manifest_path, None, manifest_text.encode())
        return self._repo_review(
            "create_library",
            head,
            digest([catalog_hash, "create_library", lid]),
            {
                "library_id": lid,
                "name": name.strip(),
                "description": description.strip(),
                "files": ["lib/catalog.json", manifest_path],
                "snapshots": snapshots,
                "message": f"Create library {lid}",
                "committer": self._identity(),
            },
            diff=diff,
            summary=f"Create circuit library {lid} and commit its manifest locally",
            library_id=lid,
        )

    def _default_cell_netlist(self, cell_id):
        safe_subckt = re.sub(r"[^A-Za-z0-9_]", "_", cell_id)
        if not safe_subckt or not safe_subckt[0].isalpha():
            safe_subckt = "CELL_" + safe_subckt
        return (
            "simulator lang=spectre\n"
            f"subckt {safe_subckt} IN OUT VDD VSS\n"
            "    R0 (IN OUT) resistor r=1k\n"
            "// @RNL(author=\"circuitgit-starter\") {\n"
            "//   #\"R0\" @PLACE(0, 0) => @ORIENT(\"R0\");\n"
            "//   %in = @PLACE(-18, 0);\n"
            "//   %out = @PLACE(18, 0);\n"
            "//   &\"IN\" @WIRE(mode=\"straight\") {%in #\"R0\":1};\n"
            "//   &\"OUT\" @WIRE(mode=\"straight\") {#\"R0\":2 %out};\n"
            "// }\n"
            f"ends {safe_subckt}\n"
        )

    def preview_create_cell(self, library_id, cell_id, base_commit, name=None, description="", kind="circuit", content=None, readme=None, requires_external_models=False):
        lid, cid = identifier(library_id), identifier(cell_id)
        head = self._head()
        require(base_commit == head and self._branch() is not None, "Base commit changed or checkout is detached", "conflict", 409)
        cell_name = (name if name is not None else cid).strip()
        require(0 < len(cell_name) <= 120 and not any(ord(c) < 32 for c in cell_name), "Invalid cell name")
        require(isinstance(description, str) and len(description) <= 2000 and "\0" not in description, "Invalid cell description")
        require(kind in {"circuit", "testbench", "subcircuit", "symbol"}, "Unsupported cell kind")
        require(isinstance(requires_external_models, bool), "requires_external_models must be boolean")
        catalog, catalog_hash = self._json_blob(head, "lib/catalog.json")
        manifest_path = "lib/" + lid + "/library.json"
        require(any(isinstance(item, dict) and item.get("id") == lid and item.get("manifest") == manifest_path for item in catalog.get("libraries", [])), "Library is not registered", "not_found", 404)
        manifest, manifest_hash = self._json_blob(head, manifest_path)
        require(manifest.get("schema") == "circuitgit.library.v1" and manifest.get("id") == lid and isinstance(manifest.get("cells"), list), "Invalid library manifest")
        require(not any(isinstance(c, dict) and c.get("id") == cid for c in manifest["cells"]), "Cell already exists in library", "conflict", 409)
        require(self._file(manifest_path) == self._blob(head, manifest_path), "Library manifest has uncommitted edits; commit or revert first", "conflict", 409)

        directory = f"lib/{lid}/{cid}"
        scs_path = f"{directory}/schematic/{cid}.scs"
        readme_path = f"{directory}/README.md"
        for p in (scs_path, readme_path):
            require(self._blob(head, p) is None and self._file(p) is None, "Target cell file already exists: " + p, "conflict", 409)

        scs_text = self._default_cell_netlist(cid) if content is None else content
        readme_text = (f"# {cell_name}\n\n{description.strip() or 'Circuit cell created in CircuitGit.'}\n") if readme is None else readme
        self._content(scs_path, scs_text)
        self._content(readme_path, readme_text)

        new_cell = {
            "id": cid,
            "name": cell_name,
            "description": description.strip(),
            "directory": directory,
            "kind": kind,
            "readme": readme_path,
            "project_id": None,
            "requires_external_models": requires_external_models,
            "views": [
                {"id": "schematic", "label": "Schematic", "kind": "rnl", "entry": scs_path, "files": [scs_path]},
                {"id": "docs", "label": "Documentation", "kind": "markdown", "entry": readme_path, "files": [readme_path]},
            ],
        }
        updated_manifest = {**manifest, "cells": [*manifest["cells"], new_cell]}
        manifest_text = json.dumps(updated_manifest, indent=2, ensure_ascii=False) + "\n"
        self._content(manifest_path, manifest_text)
        snapshots = [
            {"path": manifest_path, "base_sha256": manifest_hash, "sha256": digest(manifest_text.encode()), "content": manifest_text},
            {"path": scs_path, "base_sha256": None, "sha256": digest(scs_text.encode()), "content": scs_text},
            {"path": readme_path, "base_sha256": None, "sha256": digest(readme_text.encode()), "content": readme_text},
        ]
        diff = (
            self._diff(manifest_path, self._blob(head, manifest_path), manifest_text.encode())
            + self._diff(scs_path, None, scs_text.encode())
            + self._diff(readme_path, None, readme_text.encode())
        )
        return self._repo_review(
            "create_cell",
            head,
            digest([catalog_hash, manifest_hash, "create_cell", lid, cid]),
            {
                "library_id": lid,
                "cell_id": cid,
                "directory": directory,
                "entry": scs_path,
                "files": [s["path"] for s in snapshots],
                "snapshots": snapshots,
                "message": f"Create cell {lid}/{cid}",
                "committer": self._identity(),
            },
            diff=diff,
            summary=f"Create cell {lid}/{cid} and commit it to the current branch",
            library_id=lid,
            cell_id=cid,
        )

    def preview_clone_cell(self, source_library_id, source_cell_id, library_id, cell_id, base_commit, name=None, description=None):
        src_lid, src_cid = identifier(source_library_id), identifier(source_cell_id)
        dst_lid, dst_cid = identifier(library_id), identifier(cell_id)
        head = self._head()
        require(base_commit == head and self._branch() is not None, "Base commit changed or checkout is detached", "conflict", 409)
        src_scope = self._scope(src_lid, src_cid)
        catalog, catalog_hash = self._json_blob(head, "lib/catalog.json")
        manifest_path = "lib/" + dst_lid + "/library.json"
        require(any(isinstance(item, dict) and item.get("id") == dst_lid and item.get("manifest") == manifest_path for item in catalog.get("libraries", [])), "Target library is not registered", "not_found", 404)
        manifest, manifest_hash = self._json_blob(head, manifest_path)
        require(not any(isinstance(c, dict) and c.get("id") == dst_cid for c in manifest.get("cells", [])), "Target cell already exists", "conflict", 409)
        require(self._file(manifest_path) == self._blob(head, manifest_path), "Target library manifest has uncommitted edits", "conflict", 409)

        src_dir = src_scope["cell"]["directory"]
        dst_dir = f"lib/{dst_lid}/{dst_cid}"
        src_cell = src_scope["cell"]
        snapshots = []
        path_map = {}

        # Copy only files physically owned inside the source cell directory (shared dependencies stay referenced once).
        owned_sources = sorted(
            p for p in src_scope["source_paths"]
            if p.startswith(src_dir + "/") and not p.endswith(("/docs/provenance.json", "/provenance.json"))
        )
        require(bool(owned_sources) and len(owned_sources) <= 100, "Source cell has no cloneable owned files or exceeds clone limit")
        for old_path in owned_sources:
            rel = old_path[len(src_dir) + 1:]
            new_path = f"{dst_dir}/{rel}"
            require(self._blob(head, new_path) is None and self._file(new_path) is None, "Target file already exists: " + new_path, "conflict", 409)
            raw = self._blob(head, old_path)
            require(raw is not None, "Source cell file missing at HEAD: " + old_path)
            text = raw.decode("utf-8")
            self._content(new_path, text)
            path_map[old_path] = new_path
            snapshots.append({"path": new_path, "base_sha256": None, "sha256": digest(raw), "content": text})

        new_views = []
        for view in src_cell.get("views", []):
            mapped_files = []
            for fp in view.get("files", []):
                if fp in path_map:
                    mapped_files.append(path_map[fp])
                elif not fp.startswith(src_dir + "/"):
                    # Retain shared dependency reference without copying.
                    mapped_files.append(fp)
            if not mapped_files:
                continue
            entry = path_map.get(view["entry"], view["entry"])
            if entry not in mapped_files:
                entry = mapped_files[0]
            cloned_view = {**view, "entry": entry, "files": mapped_files}
            if "aliases" in cloned_view and isinstance(cloned_view["aliases"], dict):
                cloned_view["aliases"] = {k: path_map.get(v, v) for k, v in cloned_view["aliases"].items()}
            new_views.append(cloned_view)

        new_readme = path_map.get(src_cell["readme"], f"{dst_dir}/README.md")
        if new_readme not in {s["path"] for s in snapshots}:
            readme_text = f"# {name or dst_cid}\n\nCloned from `{src_lid}/{src_cid}` at `{head[:12]}`.\n"
            self._content(new_readme, readme_text)
            snapshots.append({"path": new_readme, "base_sha256": None, "sha256": digest(readme_text.encode()), "content": readme_text})

        cell_name = (name if name is not None else dst_cid).strip()
        cell_desc = (description if description is not None else f"Cloned from {src_lid}/{src_cid}").strip()
        new_cell = {
            "id": dst_cid,
            "name": cell_name,
            "description": cell_desc,
            "directory": dst_dir,
            "kind": src_cell.get("kind", "circuit"),
            "readme": new_readme,
            "project_id": None,
            "requires_external_models": bool(src_cell.get("requires_external_models", False)),
            "views": new_views,
        }
        updated_manifest = {**manifest, "cells": [*manifest["cells"], new_cell]}
        manifest_text = json.dumps(updated_manifest, indent=2, ensure_ascii=False) + "\n"
        self._content(manifest_path, manifest_text)
        snapshots.insert(0, {"path": manifest_path, "base_sha256": manifest_hash, "sha256": digest(manifest_text.encode()), "content": manifest_text})
        diff = self._diff(manifest_path, self._blob(head, manifest_path), manifest_text.encode())
        for snap in snapshots[1:]:
            diff += self._diff(snap["path"], None, snap["content"].encode())
        require(len(diff.encode()) <= MAX_DIFF, "Clone diff exceeds review limit", "diff_limit", 413)
        return self._repo_review(
            "clone_cell",
            head,
            digest([catalog_hash, manifest_hash, src_scope["scope_hash"], "clone_cell", dst_lid, dst_cid]),
            {
                "source_library_id": src_lid,
                "source_cell_id": src_cid,
                "library_id": dst_lid,
                "cell_id": dst_cid,
                "directory": dst_dir,
                "files": [s["path"] for s in snapshots],
                "snapshots": snapshots,
                "message": f"Clone cell {src_lid}/{src_cid} to {dst_lid}/{dst_cid}",
                "committer": self._identity(),
            },
            diff=diff,
            summary=f"Clone cell {src_lid}/{src_cid} into {dst_lid}/{dst_cid} locally",
            library_id=dst_lid,
            cell_id=dst_cid,
        )

    def preview_create_branch(self, branch, base_commit, from_ref=None, checkout=True):
        target = branch_name(branch)
        head = self._head()
        require(base_commit == head, "Base commit changed; refresh branch state first", "conflict", 409)
        require(target != self.base_branch, "Cannot create a branch with the base branch name", "conflict", 409)
        require(isinstance(checkout, bool), "checkout must be boolean")
        exists = self._git("show-ref", "--verify", "--quiet", "refs/heads/" + target, check=False).returncode == 0
        require(not exists, "Branch already exists: " + target, "conflict", 409)
        if from_ref is not None:
            require(isinstance(from_ref, str) and (SHA.fullmatch(from_ref) or branch_name(from_ref)), "Invalid from_ref")
            resolved = self._git("rev-parse", "--verify", "--end-of-options", from_ref + "^{commit}", check=False)
            require(resolved.returncode == 0, "Base reference not found: " + from_ref, "not_found", 404)
            start_commit = resolved.stdout.decode().strip()
        else:
            start_commit = head
        if checkout:
            require(not self._working_dirty(), "Working tree has uncommitted changes; commit or save before switching branches", "conflict", 409)
        return self._repo_review(
            "create_branch",
            head,
            digest(["create_branch", target, start_commit, checkout]),
            {"branch": target, "start_commit": start_commit, "checkout": checkout, "previous_branch": self._branch()},
            diff="",
            summary=f"Create local branch {target} at {start_commit[:12]}" + (" and switch to it" if checkout else ""),
        )

    def preview_switch_branch(self, branch, base_commit):
        target = branch_name(branch)
        head = self._head()
        require(base_commit == head, "Base commit changed; refresh branch state first", "conflict", 409)
        resolved = self._git("rev-parse", "--verify", "--end-of-options", "refs/heads/" + target + "^{commit}", check=False)
        require(resolved.returncode == 0, "Local branch does not exist: " + target, "not_found", 404)
        require(not self._working_dirty(), "Working tree has uncommitted changes; commit before switching branches", "conflict", 409)
        target_commit = resolved.stdout.decode().strip()
        return self._repo_review(
            "switch_branch",
            head,
            digest(["switch_branch", target, target_commit]),
            {"branch": target, "target_commit": target_commit, "previous_branch": self._branch()},
            diff="",
            summary=f"Switch local checkout to branch {target} ({target_commit[:12]})",
        )

    def preview_pr(self, library_id, cell_id, commit, title, body="", branch=None, base_branch=None, action="create", related_cells=None):
        scope = self._scope(library_id, cell_id)
        self._reachable(commit, scope["head"])
        require(base_branch in (None, self.base_branch), "PR base differs from the configured base branch")
        require(action in {"create", "update"}, "Choose create or update PR")
        require(isinstance(title, str) and 0 < len(title.strip()) <= 120 and not any(ord(c) < 32 for c in title), "Invalid PR title")
        require(isinstance(body, str) and len(body) <= 16000 and "\0" not in body and not PRIVATE.search(title + "\n" + body), "Invalid or private PR description")
        related_scopes = []
        related_identities = []
        if related_cells is not None:
            require(isinstance(related_cells, list) and len(related_cells) <= 16, "related_cells accepts at most 16 entries")
            seen_rel = {(scope["library_id"], scope["cell_id"])}
            for item in related_cells:
                require(isinstance(item, dict) and set(item) == {"library_id", "cell_id"}, "Each related cell requires exact library_id and cell_id")
                pair = (identifier(item["library_id"]), identifier(item["cell_id"]))
                if pair in seen_rel:
                    continue
                seen_rel.add(pair)
                related_scopes.append(self._scope(pair[0], pair[1]))
                related_identities.append({"library_id": pair[0], "cell_id": pair[1]})
        base = self._base()
        self._reachable(base, commit)
        all_scopes = [scope, *related_scopes]
        allowed_files = set()
        for item_scope in all_scopes:
            allowed_files |= item_scope["editable"] | item_scope["bundle_paths"]
            # Allow owning library manifest (and catalog if library is new) when a cell/library is newly added relative to base.
            lib_manifest = "lib/" + item_scope["library_id"] + "/library.json"
            base_manifest = self._blob(base, lib_manifest)
            if base_manifest is None:
                allowed_files.add("lib/catalog.json")
                allowed_files.add(lib_manifest)
            else:
                try:
                    base_cells = {c.get("id") for c in json.loads(base_manifest).get("cells", []) if isinstance(c, dict)}
                except ValueError:
                    base_cells = set()
                if item_scope["cell_id"] not in base_cells:
                    allowed_files.add(lib_manifest)
        files = self._git("diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", base, commit).stdout.decode().rstrip("\0").split("\0")
        require(files != [""] and set(files) <= allowed_files, "PR contains changes outside the selected cell(s); declare related_cells or prepare a scoped branch first", "out_of_scope", 409)
        for item_scope in all_scopes:
            if set(files) & item_scope["bundle_paths"]:
                require(commit == scope["head"], "Publish the exact current reviewed Testbench CI version", "conflict", 409)
                for bundle in self.get_testbenches(item_scope["library_id"], item_scope["cell_id"])["bundles"]:
                    prefix = item_scope["cell"]["directory"] + "/testbenches/" + bundle["id"] + "/"
                    if any(path.startswith(prefix) for path in files):
                        self.testbench_registration(item_scope["library_id"], item_scope["cell_id"], bundle["id"], bundle["registration_commit"], bundle["binding"])
        ci_by_path = {item_scope["ci_path"]: item_scope for item_scope in all_scopes}
        for path in files:
            content = self._blob(commit, path)
            require(content is not None, "Deletion is not supported by the library PR workflow")
            self._content(path, content.decode("utf-8"))
            if path in ci_by_path:
                self._validate_ci(ci_by_path[path], json.loads(content))
        branch = self._pr_branch(scope, branch or "codex/library/" + library_id + "/" + cell_id + "-" + commit[:12])
        diff = "".join(self._diff(path, self._blob(base, path), self._blob(commit, path)) for path in files)
        require(len(diff.encode()) <= MAX_DIFF, "PR diff exceeds review bounds", "diff_limit", 413)
        payload = {"commit": commit, "pr_branch": branch, "base_branch": self.base_branch,
                   "base_sha": base, "title": title, "body": body, "action": action, "files": files}
        if related_identities:
            payload["related_cells"] = related_identities
        return self._review(scope, "pr", payload, diff,
                            "Push the exact reviewed commit and " + action + " its pull request; never merge or force-push")

    def _pr_branch(self, scope, branch):
        branch_name(branch)
        prefix = "codex/library/" + scope["library_id"] + "/" + scope["cell_id"]
        require(branch == prefix or branch.startswith((prefix + "-", prefix + "/")), "PR branch must belong to the exact selected library/cell")
        require(branch != self.base_branch, "PR branch cannot be the configured base")
        return branch

    def pr_status(self, library_id, cell_id, branch):
        scope = self._scope(library_id, cell_id)
        branch = self._pr_branch(scope, branch)
        rows = json.loads(self._gh("pr", "list", "--repo", self.repository, "--state", "all", "--head", branch,
                                   "--base", self.base_branch, "--json", "number,url,state,headRefName,headRefOid,baseRefName,statusCheckRollup", "--limit", "5"))
        require(isinstance(rows, list) and len(rows) <= 5, "Invalid GitHub PR status")
        result = []
        for row in rows:
            require(isinstance(row, dict) and row.get("headRefName") == branch and row.get("baseRefName") == self.base_branch
                    and isinstance(row.get("url"), str) and re.fullmatch(r"https://github\.com/" + re.escape(self.repository) + r"/pull/[1-9][0-9]*", row["url"])
                    and row.get("state") in {"OPEN", "CLOSED", "MERGED"}, "GitHub PR identity differs")
            checks = row.get("statusCheckRollup") or []
            require(isinstance(checks, list) and len(checks) <= 100, "CI check status exceeds display bounds")
            visible_checks = [{key: check[key] for key in ("name", "workflowName", "status", "conclusion", "state", "context", "detailsUrl", "targetUrl") if key in check}
                              for check in checks if isinstance(check, dict)]
            result.append({key: row.get(key) for key in ("number", "url", "state", "headRefName", "headRefOid", "baseRefName")})
            result[-1]["statusCheckRollup"] = visible_checks
        return {"state": "not_found" if not result else result[0]["state"].lower() if len(result) == 1 else "multiple",
                "repository": self.repository, "branch": branch, "base_branch": self.base_branch,
                "pull_requests": result, "remote_checked": True, "simulation_claim": "No simulation result is inferred from workflow status."}

    def _operation_id(self, key):
        require(isinstance(key, str) and 8 <= len(key) <= 160 and not any(ord(c) < 32 for c in key), "A stable idempotency key is required")
        return hashlib.sha256(key.encode()).hexdigest()

    def execute(self, operation, args, idempotency_key):
        """Execute a caller-authorized finite operation, retaining the exact request on retries."""
        require(isinstance(operation, str) and operation in self.EXECUTE_OPERATIONS and isinstance(args, dict), "Unsupported finite library execution")
        try:
            request_fingerprint = digest({"operation": operation, "args": args})
            require(len(canonical(args).encode()) <= 4 * MAX_FILE, "Execution exceeds the durable request limit", "request_limit", 413)
        except (TypeError, ValueError) as error:
            if isinstance(error, WorkflowError):
                raise
            raise WorkflowError("invalid_request", "Execution arguments must be JSON values") from None
        oid = self._operation_id(idempotency_key)
        intent_path = self.state / "executions" / oid / "intent.json"
        with self._locked():
            if intent_path.exists():
                intent = self._record(intent_path)
                require(intent["request_fingerprint"] == request_fingerprint, "Idempotency key belongs to a different request", "conflict", 409)
                review_id = intent["review_id"]
            else:
                require(not (self.state / "operations" / oid / "request.json").exists(), "Idempotency key already belongs to another operation", "conflict", 409)
                method = self._preview_save_files if operation == "save_files" else getattr(self, "preview_" + operation)
                try:
                    review = method(**args)
                except TypeError:
                    raise WorkflowError("invalid_request", "Unexpected arguments for library execution") from None
                review_id = review["review_id"]
                self._append(intent_path, {"request_fingerprint": request_fingerprint, "review_id": review_id,
                                           "operation": operation, "created_at": now()})
        # confirm owns the repository lock; this is deliberately outside it.
        return self.confirm(review_id, idempotency_key)

    def receipt(self, operation_id=None, idempotency_key=None, review_id=None):
        if review_id is not None:
            self.review(review_id)
            require(operation_id is None and idempotency_key is None, "Choose one receipt identity")
            candidates = []
            for path in (self.state / "operations").glob("*/request.json"):
                record = self._record(path)
                if record.get("review_id") == review_id:
                    candidates.append((record["created_at"], path.parent.name))
            if not candidates:
                return {"review_id": review_id, "state": "prepared", "automatic_retry": False}
            candidates.sort()
            return self.receipt(operation_id=candidates[-1][1])
        oid = self._operation_id(idempotency_key) if idempotency_key is not None else operation_id
        require(isinstance(oid, str) and HASH.fullmatch(oid), "Invalid operation identity")
        folder = self.state / "operations" / oid
        if not (folder / "request.json").exists():
            intent_path = self.state / "executions" / oid / "intent.json"
            if intent_path.exists():
                intent = self._record(intent_path)
                return {"operation_id": oid, "review_id": intent["review_id"], "operation": intent["operation"],
                        "state": "prepared", "dispatched": False, "automatic_retry": False}
            return {"operation_id": oid, "state": "not_found", "dispatched": False, "automatic_retry": False}
        request = self._record(folder / "request.json")
        if (folder / "complete.json").exists():
            return self._record(folder / "complete.json")
        stages = [self._record(path) for path in sorted(folder.glob("stage-*.json"))]
        return {"operation_id": oid, "review_id": request["review_id"], "state": "unknown", "automatic_retry": False, "stages": stages}

    def confirm(self, review_id, idempotency_key):
        """Apply the frozen request after caller authorization or legacy correlated review."""
        with self._locked():
            review = self.review(review_id)
            oid = self._operation_id(idempotency_key)
            folder = self.state / "operations" / oid
            if (folder / "request.json").exists():
                existing = self._record(folder / "request.json")
                require(existing["review_id"] == review_id, "Idempotency key belongs to another frozen review", "conflict", 409)
                return self.receipt(operation_id=oid)
            payload, operation = review["payload"], review["operation"]
            if operation in self.REPO_OPERATIONS:
                require(self._head() == review["base_commit"] and self._branch() == review["branch"],
                        "Repository state changed after request preparation; prepare again", "conflict", 409)
                if operation in {"create_library", "create_cell", "clone_cell"}:
                    for item in payload["snapshots"]:
                        before = self._file(item["path"])
                        require((digest(before) if before is not None else None) == item["base_sha256"],
                                "Target library file changed after preparation", "conflict", 409)
                elif operation in {"create_branch", "switch_branch"}:
                    if operation == "switch_branch" or payload.get("checkout"):
                        require(not self._working_dirty(), "Working tree gained uncommitted edits; commit before switching branches", "conflict", 409)
            else:
                scope = self._scope(review["library_id"], review["cell_id"])
                require(scope["head"] == review["base_commit"] and scope["scope_hash"] == review["scope_hash"]
                        and self._branch() == review["branch"], "Repository, source base or library inventory changed; prepare again", "conflict", 409)
                if operation in {"save", "save_files", "restore", "ci"}:
                    for item in payload["changes"] if operation == "save_files" else [payload]:
                        before = self._file(item["path"])
                        require((digest(before) if before is not None else None) == item["base_sha256"], "Source changed after request preparation", "conflict", 409)
                        require(item["checkpoint_base"] == self._checkpoint_base(scope, item["path"]),
                                "File save history changed after request preparation; prepare again", "conflict", 409)
                    if operation == "ci":
                        require(payload["registry_hash"] == digest(self.ci_registry), "Testbench registry changed after preview", "conflict", 409)
                elif operation == "commit":
                    refreshed = self.preview_commit(scope["library_id"], scope["cell_id"], scope["head"], message=payload["message"])
                    require(refreshed["review_id"] == review_id, "Commit changes differ from the reviewed diff", "conflict", 409)
                elif operation == "pr":
                    refreshed = self.preview_pr(scope["library_id"], scope["cell_id"], payload["commit"], payload["title"], payload["body"], payload["pr_branch"], payload["base_branch"], payload["action"], related_cells=payload.get("related_cells"))
                    require(refreshed["review_id"] == review_id, "PR base or reviewed scope changed", "conflict", 409)
                elif operation == "register_testbench":
                    require(payload.get("human_review_required") is True, "Missing Testbench CI human-review declaration")
                    require(self._testbench_source(scope, require_clean=True) == payload["source"], "Cell source changed after testbench review", "conflict", 409)
                    self._agent_testbench_manifest(payload["manifest"])
                    for item in payload["snapshots"]:
                        before = self._file(item["path"])
                        require((digest(before) if before is not None else None) == item["base_sha256"]
                                and digest(item["content"].encode()) == item["sha256"], "Testbench bytes changed after review", "conflict", 409)
                        require(item["checkpoint_base"] == self._checkpoint_base(scope, item["path"]), "Testbench save history changed after review", "conflict", 409)
                    require(not self._git("diff", "--cached", "--name-only", "-z", "--", *payload["files"]).stdout,
                            "Testbench paths gained staged changes after review", "conflict", 409)
                else:
                    raise WorkflowError("invalid_review", "Unsupported frozen workflow operation")
            self._append(folder / "request.json", {"review_id": review_id, "operation": operation, "created_at": now()})
            try:
                if operation == "save_files":
                    result = self._apply_save_files(review, oid)
                elif operation in {"save", "restore", "ci"}:
                    result = self._apply_save(review, oid)
                elif operation == "commit":
                    result = self._apply_commit(review, oid)
                elif operation == "register_testbench":
                    result = self._apply_register_testbench(review, oid)
                elif operation in {"create_library", "create_cell", "clone_cell"}:
                    result = self._apply_crud_commit(review, oid)
                elif operation == "create_branch":
                    result = self._apply_create_branch(review, oid)
                elif operation == "switch_branch":
                    result = self._apply_switch_branch(review, oid)
                else:
                    result = self._apply_pr(review, oid)
                result = {**result, "schema": SCHEMA, "operation_id": oid, "review_id": review_id,
                          "state": result.get("state", "complete"), "automatic_retry": False}
                self._append(folder / "complete.json", result)
                return result
            except Exception as error:
                self._append(folder / "stage-99-unknown.json", {"stage": "unknown", "code": getattr(error, "code", "operation_failed"), "automatic_retry": False})
                raise WorkflowError("outcome_unknown", "Operation outcome requires receipt reconciliation; do not replay", 409, {"operation_id": oid, "review_id": review_id}) from None

    def _apply_save(self, review, oid):
        payload = review["payload"]
        path, raw = payload["path"], self._content(payload["path"], payload["content"])
        before = self._file(path)
        for content in (before, raw):
            if content is not None:
                self._append(self.state / "objects" / digest(content), content)
        checkpoint_id = digest([oid, path, digest(raw)])
        checkpoint = {"checkpoint_id": checkpoint_id, "operation_id": oid, "library_id": review["library_id"], "cell_id": review["cell_id"],
                      "path": path, "created_at": now(), "summary": review["summary"], "base_commit": review["base_commit"],
                      "before_sha256": digest(before) if before is not None else None, "sha256": digest(raw)}
        self._append(self.state / "checkpoints" / (checkpoint_id + ".json"), checkpoint)
        self._replace_source(path, raw, payload["base_sha256"])
        return {**checkpoint, "automatic_push": False, "operation": review["operation"]}

    def _replace_source(self, path, raw, expected_sha256):
        """Replace one bounded source atomically, checking it immediately before rename."""
        target = self.root / path
        self._file(path)  # Validate regular-file/symlink confinement before creating parents.
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".circuitgit-save-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw); handle.flush(); os.fsync(handle.fileno())
            os.chmod(temporary, target.stat().st_mode & 0o777 if target.exists() else 0o644)
            current = self._file(path)
            require((digest(current) if current is not None else None) == expected_sha256, "Source changed during save", "conflict", 409)
            os.replace(temporary, target)
            self._fsync_dir(target.parent)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _apply_save_files(self, review, oid):
        changes, originals, checkpoints = review["payload"]["changes"], {}, []
        for item in changes:
            originals[item["path"]] = self._file(item["path"])
            require((digest(originals[item["path"]]) if originals[item["path"]] is not None else None) == item["base_sha256"],
                    "Grouped source changed before save", "conflict", 409)
        try:
            # Persist every before/after object and checkpoint before replacing the first source.
            for item in changes:
                raw, before = self._content(item["path"], item["content"]), originals[item["path"]]
                for content in (before, raw):
                    if content is not None:
                        self._append(self.state / "objects" / digest(content), content)
                checkpoint_id = digest([oid, item["path"], item["sha256"]])
                checkpoint = {"checkpoint_id": checkpoint_id, "operation_id": oid, "group_id": oid,
                              "library_id": review["library_id"], "cell_id": review["cell_id"], "path": item["path"],
                              "created_at": now(), "summary": review["summary"], "base_commit": review["base_commit"],
                              "before_sha256": item["base_sha256"], "sha256": item["sha256"]}
                self._append(self.state / "checkpoints" / (checkpoint_id + ".json"), checkpoint)
                checkpoints.append(checkpoint_id)
            for item in changes:
                self._replace_source(item["path"], item["content"].encode(), item["base_sha256"])
        except Exception as error:
            rollback_errors, states = [], []
            # Examine all files: rename may succeed before a later fsync reports failure.
            for item in reversed(changes):
                path, before = item["path"], originals[item["path"]]
                try:
                    current = self._file(path)
                    if current != before:
                        require(current is not None and digest(current) == item["sha256"],
                                "A concurrent external edit is preserved", "conflict", 409)
                        if before is None:
                            require(digest(self._file(path)) == item["sha256"], "Source changed during rollback", "conflict", 409)
                            (self.root / path).unlink()
                            self._fsync_dir((self.root / path).parent)
                        else:
                            self._replace_source(path, before, item["sha256"])
                except Exception as rollback_error:
                    rollback_errors.append({"path": path, "code": getattr(rollback_error, "code", "rollback_failed")})
            for item in changes:
                try:
                    current = self._file(item["path"])
                    states.append({"path": item["path"], "restored": current == originals[item["path"]],
                                   "sha256": digest(current) if current is not None else None})
                except Exception:
                    states.append({"path": item["path"], "restored": False, "sha256": None, "unreadable": True})
            return {"operation": "save_files", "group_id": oid, "checkpoint_ids": checkpoints,
                    "state": "rolled_back" if all(row["restored"] for row in states) else "partial",
                    "error": {"code": getattr(error, "code", "save_failed"), "message": "Grouped save failed; inspect the recorded file outcomes before a new edit."},
                    "files": states, "rollback_errors": rollback_errors, "automatic_push": False}
        return {"operation": "save_files", "group_id": oid, "checkpoint_ids": checkpoints,
                "files": review["payload"]["files"], "automatic_push": False}

    def _apply_register_testbench(self, review, oid):
        payload = review["payload"]
        saved = self._apply_save_files({**review, "payload": {**payload, "changes": payload["snapshots"]}}, oid)
        if saved.get("state", "complete") != "complete":
            return {**saved, "operation": "register_testbench", "registered": False, "simulation_started": False}
        result = self._apply_commit(review, oid)
        return {**result, "operation": "register_testbench", "registered": True, "testbench_id": payload["testbench_id"],
                "registration_commit": result["commit"], "binding": payload["binding"],
                "checkpoint_ids": saved["checkpoint_ids"], "simulation_started": False, "execution_status": "not_run"}

    def _apply_commit(self, review, oid):
        payload, base = review["payload"], review["base_commit"]
        fd, index = tempfile.mkstemp(prefix="index-", dir=self.state)
        os.close(fd); os.unlink(index)
        staged = []
        try:
            self._git("read-tree", base, index=index)
            for item in payload["snapshots"]:
                raw = item["content"].encode()
                require(digest(self._file(item["path"])) == item["sha256"], "Source changed during commit", "conflict", 409)
                blob = self._git("hash-object", "-w", "--stdin", "--no-filters", data=raw).stdout.decode().strip()
                row = self._git("ls-tree", base, "--", item["path"]).stdout
                mode = row.split(b" ", 1)[0].decode() if row else "100644"
                self._git("update-index", "--add", "--cacheinfo", mode, blob, item["path"], index=index)
                staged.append((mode, blob, item["path"]))
            tree = self._git("write-tree", index=index).stdout.decode().strip()
            commit = self._git("commit-tree", tree, "-p", base, data=(payload["message"].rstrip() + "\n").encode(), identity=payload["committer"]).stdout.decode().strip()
            self._append(self.state / "operations" / oid / "stage-10-commit.json", {"stage": "commit_created", "commit": commit})
            self._git("update-ref", "refs/heads/" + review["branch"], commit, base)
            # Update only the committed paths in the real index; every unrelated
            # staged blob remains byte-for-byte untouched.
            for mode, blob, path in staged:
                self._git("update-index", "--add", "--cacheinfo", mode, blob, path)
            return {"operation": "commit", "commit": commit, "base_commit": commit, "branch": review["branch"],
                    "files": payload["files"], "committer": payload["committer"], "automatic_push": False}
        finally:
            if os.path.exists(index):
                os.unlink(index)

    def _apply_crud_commit(self, review, oid):
        payload = review["payload"]
        saved = self._apply_save_files({**review, "payload": {**payload, "changes": payload["snapshots"]}}, oid)
        if saved.get("state", "complete") != "complete":
            return {**saved, "operation": review["operation"]}
        committed = self._apply_commit(review, oid)
        return {
            **committed,
            "operation": review["operation"],
            "library_id": review.get("library_id"),
            "cell_id": review.get("cell_id"),
            "directory": payload.get("directory"),
            "entry": payload.get("entry"),
            "checkpoint_ids": saved["checkpoint_ids"],
        }

    def _apply_create_branch(self, review, oid):
        payload = review["payload"]
        target = payload["branch"]
        start_commit = payload["start_commit"]
        if payload.get("checkout", True):
            self._git("checkout", "-b", target, start_commit)
        else:
            self._git("branch", target, start_commit)
        return {
            "operation": "create_branch",
            "branch": target,
            "previous_branch": payload.get("previous_branch"),
            "commit": start_commit,
            "base_commit": self._head(),
            "checked_out": bool(payload.get("checkout", True)),
            "automatic_push": False,
        }

    def _apply_switch_branch(self, review, oid):
        payload = review["payload"]
        target = payload["branch"]
        self._git("checkout", target)
        head = self._head()
        return {
            "operation": "switch_branch",
            "branch": target,
            "previous_branch": payload.get("previous_branch"),
            "commit": head,
            "base_commit": head,
            "automatic_push": False,
        }

    def _apply_pr(self, review, oid):
        payload = review["payload"]
        branch = payload["pr_branch"]
        rows = json.loads(self._gh("pr", "list", "--repo", self.repository, "--state", "open", "--head", branch,
                                   "--base", self.base_branch, "--json", "number,url,headRefName,baseRefName", "--limit", "10"))
        require(isinstance(rows, list) and len(rows) <= 1, "PR branch is ambiguous")
        require(bool(rows) == (payload["action"] == "update"), "PR existence differs from the requested create/update action")
        if rows:
            require(rows[0].get("headRefName") == branch and rows[0].get("baseRefName") == self.base_branch
                    and type(rows[0].get("number")) is int, "GitHub PR identity differs")
        remote_base = self._git("ls-remote", "--refs", "--", "https://github.com/" + self.repository + ".git",
                                "refs/heads/" + self.base_branch, network=True).stdout.decode().split()
        require(remote_base == [payload["base_sha"], "refs/heads/" + self.base_branch],
                "Remote base changed since preview; refresh the local base and prepare again", "conflict", 409)
        self._git("push", "--porcelain", "--", "https://github.com/" + self.repository + ".git",
                  payload["commit"] + ":refs/heads/" + branch, network=True)
        self._append(self.state / "operations" / oid / "stage-20-push.json", {"stage": "push_returned_success", "commit": payload["commit"], "branch": branch})
        body_file = self.state / "operations" / oid / "body.txt"
        self._append(body_file, payload["body"].encode())
        if rows:
            self._gh("pr", "edit", str(rows[0]["number"]), "--repo", self.repository, "--title", payload["title"], "--body-file", str(body_file))
            url = rows[0]["url"]
        else:
            url = self._gh("pr", "create", "--repo", self.repository, "--base", self.base_branch, "--head", branch,
                           "--title", payload["title"], "--body-file", str(body_file)).decode().strip()
        require(re.fullmatch(r"https://github\.com/" + re.escape(self.repository) + r"/pull/[1-9][0-9]*", url), "GitHub did not confirm the exact PR URL")
        verified = json.loads(self._gh("pr", "view", url, "--repo", self.repository, "--json", "url,state,headRefName,headRefOid,baseRefName"))
        require(isinstance(verified, dict) and verified.get("url") == url and verified.get("headRefName") == branch
                and verified.get("headRefOid") == payload["commit"] and verified.get("baseRefName") == self.base_branch
                and verified.get("state") == "OPEN", "GitHub has not confirmed the exact reviewed PR head", "github_unknown", 409)
        return {"operation": "pr", "action": payload["action"], "commit": payload["commit"], "branch": branch,
                "base_branch": self.base_branch, "url": url, "merged": False, "force_pushed": False}

    def save(self, library_id, cell_id, path, content, base_sha256, idempotency_key):
        """Convenience for an already-authorized agent invocation."""
        return self.execute("save", {"library_id": library_id, "cell_id": cell_id, "path": path,
                                     "content": content, "base_sha256": base_sha256}, idempotency_key)

    def dispatch(self, operation, payload):
        require(operation in self.READ_OPERATIONS | self.PREPARE_OPERATIONS and isinstance(payload, dict), "Unsupported finite library operation")
        args = dict(payload)
        if operation != "describe":
            args.pop("published_entry", None); args.pop("source_sha256", None)
        if operation in {"review", "receipt", "branches"}:
            args.pop("library_id", None); args.pop("cell_id", None)
        try:
            return getattr(self, operation)(**args)
        except TypeError:
            raise WorkflowError("invalid_request", "Unexpected arguments for library operation") from None
