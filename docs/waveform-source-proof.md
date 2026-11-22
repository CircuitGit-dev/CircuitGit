# Data-driven correction of owner reconciliation candidate — v2

2026-11-09. This supersedes `reconciliation-review/minimal-owner-candidate.patch`, its hardcoded patched files and review-v1 tar. **Do not apply that old patch.** Keep the integrator's existing `display_source` and injected `Geometry.blob`; this revision changes only the reconciliation block and frontend verification message. No new simulation, run catalog, transport or architecture.

## Ready-to-integrate patch

The inspected owner working copy already contains the previous hardcoded patch. Apply ONLY `patches/generic-proof-from-working-copy.patch` if both exact before hashes match `evidence/patch-bases.json`. If starting from committed6dc7a3b candidate bytes instead, apply ONLY `generic-proof-from-committed-candidate.patch`. The two alternatives produce identical final Python/JS bytes. Do not stack them. Preserve concurrent owner edits and all AI/context/geometry code.

The generic modules contain no project name, run ID, concrete hash, suffix text or specific suffix byte length. Fixed numeric constants are validation resource bounds only. Project identity belongs to the locally registered mapping and its immutable proof data.

## Installed proof contract

Add `display_source.proof: {commit,path,sha256}` to the same trusted mapping. HTTP callers cannot select it or change mappings. The server requires a full40hex commit, safe repository-relative path and64hex SHA256, reads the actual proof blob with the existing Geometry.blob, enforces64KiB and verifies its hash before parsing. It does not trust `passed`, `checks`, `verified` or another declarative verdict in the proof.

Proof schema `ic.exact-comment-suffix-proof.v1`:

- source_path: same canonical path explicitly registered by this run's mapping.
- base: fixed commit, sha256, bytes. SHA must equal the original run source SHA already validated by validate_mapping.
- view: fixed commit, sha256, bytes. Commit/SHA must equal the explicit display_source fields.
- suffix: utf8, bytes, sha256. These bind the complete exact suffix; only bounded complete blank/Spectre `//` lines are accepted.

Both actual base/view Git blobs are read and hash/length checked. Base must end in newline, have no trailing continuation after whitespace, and view must equal base + the exact proof suffix. Unknown comments cannot pass against unchanged proof; altered electrical bytes cannot pass either. Even a newly signed/hash-bound proof cannot authorize an electrical suffix or incomplete/continued base line. Input verified is discarded; the response supplies verified only after all checks and contains original/run hash, view hash, source lengths, actual suffix length/hash and actual proof hash.

Frontend requires those server-produced identities to agree, uses returned suffix_bytes in the historical message, and still requires exact current editor path/hash, no dirty/pending state, geometry sourceMatch and exact bundle/manifest identity. Updating bundle_commit alone does not authorize a different source. The response remains HISTORICAL; no new simulation is claimed.

## This SAR proof / installation sequence

`proofs/sar-exact-comment-suffix.json` is the coordinator's exact proof bytes, copied unchanged. SHA256 `039a17563f2f5d01dda9587e90614901e7c4a98fb0ba9aa2f376e4073dba314d`.

It binds base c17c52565b5a6f0f1f51a22408ca5135301eca0d /12d9cfed2933bb2e4627e01e64662fadf58b8bf33ac38cd4a12e926ae37c89eb and view c44e3e14694e0c4be3f4c70201e2bc262860492f /e1796412229ce57426b9a41597b86435997e05f80306604872e63a07b770b5b6. Its122-byte suffix is exactly the two existing workbench validation comments and intervening blanks. Those values occur only in proof/test/documentation data. This independently reproduces the657f3d5 reconciliation; actual source bytes are included as evidence.

The sole integrator commits this proof as an ordinary data file, e.g. `validation/waveform-proofs/sar-exact-comment-suffix.json`, then captures the actual resulting full commit. No proof commit in a test response is a production commit: the test commits are explicitly disposable local fixtures. The proof's view.commit stays c44e3e1; it need not equal the later commit that stores the proof or the current geometry commit.

To create a registration fragment after that real data commit:

```bash
python3 make_display_source.py --repo /path/to/runtime/workspace \
  --proof-commit FULL_ACTUAL_PROOF_COMMIT \
  --proof-path validation/waveform-proofs/sar-exact-comment-suffix.json \
  --proof-sha256 039a17563f2f5d01dda9587e90614901e7c4a98fb0ba9aa2f376e4073dba314d \
  --output /new/path/display-source.json
```

This read-only helper checks actual committed proof bytes and creates a new fragment; it never registers/configures anything or emits verified. Merge that fragment into the existing local installed map, retain original source/hash/run/config/raw/objects, and pin its geometry to the actual final runtime manifest. Then the gateway checks actual run provenance and both source blobs on every mapping read. Never copy the synthetic test reference to production or use HEAD in the proof reference.

## Targeted evidence

13 Python tests pass using actual Git blobs through Geometry.blob in a disposable local shared Git fixture. Real base/view bytes match the independently audited files. Negative cases include unknown third comment with unchanged proof, changed electrical bytes, proof byte/hash mismatch, symbolic commits, unsafe paths, wrong run hash, missing proof despite verified=true, incomplete base line, trailing continuation, electrical suffix and inconsistent suffix hash.

A second explicitly SYNTHETIC project with different source path/run/commits/hashes and a51-byte exact suffix has its own independent hash-bound proof and passes unchanged generic code. It creates no simulated results and claims no physical waveform data.5 JS tests cover both historical labels with dynamic lengths, missing/inconsistent verified provenance and all existing source/geometry staleness guards.

Only this bounded correction was tested; no wider browser sweep, production deployment, Git push, OCEAN or simulation was performed. Original v1, v1.1 and companion archives are unchanged. After integration/deployment confirmation the remaining task is formal8766 read-only physical-click acceptance.
