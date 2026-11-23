# Standalone Spectre 兼容入口

唯一 runner 实现位于 [`tools/workbench/ic_sim.py`](../workbench/ic_sim.py)。本目录的 `ic_sim.py` 保留旧命令和 Python 导入兼容，函数、默认运行目录及来源 hash 都指向该实现。Bundle/site/receipt 约定见 [INTERFACE.md](INTERFACE.md)。

从仓库根目录做离线检查：

```bash
python3 -B tools/sim/test_ic_sim.py
python3 -B tests/architecture/test_sim_compat.py
python3 -B tools/workbench/ic_sim.py --site config/site.example.json plan --bundle tools/sim/fixtures/bundle.json
```

fixture 只验证传输和输入组织，不是 ADC，也未获准执行。已有 Spectre 文本可直接列入 bundle，无需 OA、bridge 或 Virtuoso。RNL 由工作台编辑和验证，实际仿真使用所选配置编译出的电气源与显式依赖。

`run --execute --raw` 在受审 Git 源、私有站点、外部模型和许可证满足要求后执行单次提交与结果收集。普通 GitHub CI 只运行离线检查；`ci/sim-static.yml.example` 是示例模板。网页和 MCP 使用现有网关配置及操作回执，不能把 CLI 兼容入口当作额外授权。

`historical-runs.json` 保留早期 real-SAR、ideal 与 MDAC 的历史身份和测量设置，不表示当前进行过新仿真。已有 provenance/hash 保持原样。当前流程见[独立仿真文档](../../docs/simulation-migration-plan.md)，原始导入背景见[历史原图迁移](../../docs/native-geometry-migration.md)。
