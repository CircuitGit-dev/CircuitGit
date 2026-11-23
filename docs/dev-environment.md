# Developer environment / 开发环境

From the repository root on macOS or Linux:

```bash
python3 -B tools/dev/setup_env.py
```

One command prepares the Python dependencies, builds the browser and Codex packages plus the static Pages demo, and checks package integrity and document links. A usable Python **3.11+** and Git must already be installed. The first dependency installation needs access to the pinned public Git repository and Python package index.

在 macOS / Linux 的仓库根目录运行以上命令即可。电脑需已有 Python **3.11+** 和 Git；首次安装依赖需要网络。脚本不会安装 Node、浏览器、Cadence、PDK 或系统工具，也不会启动模型、SSH、仿真、网页服务或浏览器。

## What setup does / 执行步骤

1. Reads the exact repository and commit from [the SpiceOwl integration lock](../contracts/spiceowl-integration.lock.json).
2. Reuses an isolated project Python only after checking its version, package origin, installed commit, module locations and ADCToolbox version. Otherwise it creates an owned environment under `.local/python/` and installs `spiceowl[adctools,mcp]` from the lock plus `adctoolbox==0.9.3`.
3. Runs `pip check`, `tools/dev/build.py all`, `tools/dev/build_pages.py`, `tools/dev/check_structure.py` and the offline `tools/dev/check_links.py`.
4. Verifies the generated entrypoints and build markers in `web/`, `dist/ic-workbench/` and `site/`, then writes `.local/developer-setup.json` with the selected interpreter, pin and successful checks.

The installer reuses the existing [Python bootstrap](../tools/workbench/bootstrap_python.py). A compatible `.venv` may be reused, but setup never upgrades an unrelated existing environment. A changed pin or missing extra gets its own managed environment; previous environments and active processes remain intact. The launcher can reuse the verified developer environment afterward. Packages are not installed globally and shell configuration is not changed.

安装逻辑复用现有启动器：检查通过的项目环境直接复用；锁定版本变化或缺少额外依赖时创建新的独立环境，不在旧环境里原地升级。依赖失败时停止后续构建，保留已有环境及上一次成功回执。SpiceOwl commit 与 ADCToolbox 版本固定；其他依赖按该 commit 声明的约束安装，因此不同平台的完整 wheel 集合不保证逐字节相同。

## Inspect or choose Python / 查看计划与选择解释器

```bash
python3 -B tools/dev/setup_env.py --plan
python3 -B tools/dev/setup_env.py --python /absolute/path/to/python3.11
```

`--plan` reads the lock and prints the steps without installing, building or writing. `--python` is a creation candidate used when no matching project environment exists. It does not replace or modify that interpreter's global packages.

The success report contains the exact `python` path. Use it for Python tests that import SpiceOwl or ADC analysis dependencies. For example:

```bash
CG_PYTHON="$(python3 -c 'import json; print(json.load(open(".local/developer-setup.json"))["python"])')"
"$CG_PYTHON" -B tools/workbench/test_onboarding_analysis.py
```

The basic packaging scripts use Python's standard library. JavaScript tests separately require Node **22+**; browser tests require a separately supplied Playwright/browser installation. Setup does not install a frontend toolchain. The optional official-SDK MCP package can be built explicitly with `tools/dev/build.py mcp`; `build.py all` preserves the repository's existing web/Codex build scope. See [the architecture guide](architecture.md) and [agent connections](agent-connections.md).

## Failures and repeated runs / 失败与重复执行

Run the same setup command again after fixing a dependency download, Python or Git issue. Verified dependencies are reused. Generated packages are rebuilt through their existing guarded builders; source code, local site settings, active conversations and simulation state are not modified.

Setup exits **0** only after every stage succeeds, **1** on a setup/build/health error, and **130** when interrupted. A failed stage prevents later stages from running. An earlier `.local/developer-setup.json` remains an earlier observation; it does not establish that the interrupted or failed new run succeeded. Concurrent setup commands stop at the project lock instead of installing or rebuilding simultaneously. An unmanaged output directory is preserved and reported by the existing builder.

失败后修复原因并重跑同一命令即可。不要把上一次的成功回执当作这一次也成功；只有本次输出 `status: ready` 且退出码为 0，才代表所有步骤完成。开发环境准备与启动服务是独立操作；后续运行入口见[安装与部署](getting-started.md)。

## Document link checks / 文档链接检查

```bash
python3 -B tools/dev/check_links.py
python3 -B tools/dev/check_links.py --path README.md --path docs
python3 -B tools/dev/check_links.py --online --max-external 50 --timeout 5
```

The default audit is offline. It discovers repository Markdown and document HTML, checks rendered relative file links, Markdown/HTML anchors and source line anchors, and flags outdated first-party CircuitGit/SpiceOwl documentation URLs, including clone examples. It understands images and reference-style links; code examples and comments are not treated as rendered local links. Generated outputs, dependency/vendor trees, caches and symlink documents are excluded and listed in coverage.

Historical evidence and license/provenance documents are not rewritten. Unresolved historical references are warnings requiring human interpretation. The tool checks document hyperlinks, not every URL-like string in JavaScript, private configuration, arbitrary files or live application routes. Unsupported URI or asset-fragment formats receive explicit skip records.

`--online` adds a bounded, point-in-time check of unique public HTTP URLs. It uses no credentials, cookies or environment proxies and skips local/private/example addresses. It reports redirects, 404/410 failures, access restrictions, rate limits, network failures and unstarted URLs separately. A rate-limited host receives no further requests in that audit. External fragments are not checked. Authentication failures and network errors remain unverified; a successful audit does not promise every external page will remain reachable.

默认检查完全离线。当前文档的真实文件或锚点断链、已迁移第一方旧 URL 会使检查失败；历史证据保留并给出警告。可选在线检查只是有范围、有时间点的可达性观察，403/429/超时不会被误报为“已验证可用”，也不会访问本机服务。JSON 报告包含扫描范围、跳过原因和逐项结果。
