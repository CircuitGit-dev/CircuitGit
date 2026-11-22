# IC Workbench backend

Portable HTTP v1 backend for versioned textual netlists. It runs installed Python code, not scripts/hooks supplied by a Git commit. OA/netlist export and viewer assets are separate packages.

## Start

Requires Python3.9+, local git/SSH/gh, a configured private GitHub repository and licensed remote Cadence environment. Matplotlib enables PNG export; CSV/display JSON and full native raw are retained independently if PNG generation fails. No GitHub or SSH credential is sent to the browser.

```bash
python3 -B tools/workbench/server.py --config /absolute/path/gateway.local.json --web-root /absolute/path/web --port 8766
```

Open `http://127.0.0.1:8766`. The bind is restricted to127.0.0.1; Host/Origin must match that exact origin. `localhost` is deliberately not an interchangeable Host. API calls use `{ok,data}` or `{ok:false,error}`; same-origin health supplies an ephemeral `X-Workbench-Token` for POST requests. This token is only CSRF protection, not a GitHub token. No CORS or arbitrary shell API is provided.

Copy this folder to `tools/workbench/`. Use the coordinated `project-catalog.json` as the trusted local config's `projects` array. `github_repo`, `seed_repo`, `runtime_root`, `runtime_branch`, `base_branch`, `site_file`, and `projects` are configured at installation; the browser cannot change the allowlist. This deployment pins analog-topology-synth/IC_on_Github. A different private repository can be selected in installed config without changing Python. Credentials stay in existing gh/SSH configuration and remote site setup.

The gateway clones to runtime_root/workspace, creates an isolated codex/* runtime branch, and does not mutate seed_repo. GitHub writes use that runtime branch or per-run codex/results/* branches. The development integration checkout has a separate owner.

## Source and configurations

One canonical circuit per project; one JSON per stable configuration ID. New bundles are materialized from a selected commit with refreshed hashes. `materialization.json` binds source SHA256, actual source commit and compiler SHA256, and is signed with a local key outside repository/browser access. Archived template hashes remain unchanged. The runner accepts only correctly signed materializations from its configured frozen directory.

Preview validates actual materialized include closure and configuration declarations. Commit checks base_commit and exact current file state. Sync explicitly fetches the runtime branch if it exists, otherwise the configured base branch; dirty/diverged work is rejected. No force-push or automatic conflict reset occurs.

Allowed configuration keys are parameters, analysis, simulator, description and postprocess. Parameters update existing declarations; they are not appended as late overrides. Source paths, symlinks, file sizes and unsafe shell/absolute-output directives are checked. Site/model paths are server-side aliases and externally pinned hashes.

```json
{"postprocess":{"signals":[{"name":"in","unit":"V"},{"name":"out","unit":"V"}],"start_s":0,"end_s":1.2e-8,"step_s":5e-12,"max_display_points":1600}}
```

Times are numeric SI seconds. Without committed postprocess settings, no signal/window is guessed; native raw stays downloadable. Export is bounded to32signals and200000CSV points. Independent OCEAN reads only the new run's PSFXL; CSV, display JSON and optional PNG are included before the complete archive is generated. Display decimation is not a numerical performance analysis.

`configuration.template_reference` records historical template settings; effective device values come from canonical/staged source. `effective_parameters`, `effective_tran`, entrypoint hash and workbench configuration describe the newly materialized recipe. A template's old R value must not be mistaken for an edited canonical R.

## Jobs and recovery

`POST /api/jobs` requires a caller idempotency_key. The durable receipt is written before remote staging/launch; retrying the same key returns its existing handle, and different input under that key is rejected. A remote launch_once claim prevents a duplicate process. Restarting the gateway never resubmits an uncertain job. Inspect existing state/receipts instead.

All run.json writers share a short record lock and merge only changed fields; status polling cannot erase collection/publication receipts. Long SSH/API calls do not hold that lock. Separate operation locks serialize submission, collection and publication. API status labels distinguish observed running, uncertain outcomes and solver success pending scientific acceptance.

CLI access is also available via runner.py --site SITE --runs RUNS submit/status/collect. The HTTP collect action additionally invokes configured OCEAN export. Neither a successful Spectre footer nor a completed upload establishes ADC precision signoff.

## Complete results and private GitHub publication

Collection checks remote/local archive SHA256 and size, inventories each file and retains the full native result tree. Compiled AHDL cache, packaging scratch and launch claim directories are explicitly excluded; they are not waveform results. Postprocess files trigger an archive rebuild before publication. Previous local archive versions remain under archives/.

Small manifest/summary/file index/PNG/publication receipt files enter Git through an explicit allowlist, even if the repository ignores result directories. Raw tar archives never enter Git. Full archives and PNGs upload to a Release in the same private repository, with verified asset state/size/SHA256. Files larger than1GiB are split into ordered parts rather than truncated; >1000assets is rejected. The actual large-split path has not been live tested in this phase.

GitHub documentation checked on2026-11-09: releases permit at most1000assets, each under2GiB; asset metadata exposes digest/size and upload_url comes from the release API. Implementation uses the returned upload URL. After publishing a draft it re-GETs the release and assets, verifies tag/id/draft/size/digest, then records final canonical URLs rather than /untagged placeholders.

References: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases and https://docs.github.com/en/rest/releases/assets .

Uploaded bytes are immutable in this workflow. Collect on a published run returns the existing checksum-verified archive; changed bytes require an explicit new version rather than silently replacing a Release. A completed publish call can refresh canonical URLs after re-verification without retransmitting assets. Ambiguous uploads retain local files and reconcile server state before retry; mismatched existing assets are never overwritten automatically.

Publication receipts distinguish source_commit, archive_commit, result branch, release/tag and verified asset hashes. The Git-versioned receipt necessarily precedes the commit that stores it; the local/API receipt records the actual confirmed commit containing the final index.

## Tests and limits

```bash
python3 -B tools/workbench/test_backend.py
```

Tests use isolated local repositories and loopback HTTP. They cover origin/CSRF/path checks, static JSON bytes, actual compiled missing-include rejection, stale bases, signed bundle integrity, external branch sync, idempotency, concurrent GET plus receipt writers, immutable published archives and small-file-only Git staging. Real Cadence/GitHub acceptance evidence is kept separately from these tests.

This is a local trusted-user gateway, not a hardened public multi-tenant service or OS sandbox. Netlist paths/flags are constrained, but licensed EDA still executes as the configured server user. No public bind, process cancellation endpoint or unreviewed repository script execution is supported. Some future netlist dialects/resource include forms may need explicit compiler support rather than bypassing closure checks.
