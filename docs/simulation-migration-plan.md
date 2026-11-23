# Git 电路源与独立 Spectre 流程

当前流程从 Git 中的电路源、RNL 图形和选定 testbench 配置出发，编译并核对输入后通过授权站点提交独立 Spectre 作业，再收集日志、波形与后处理结果。不需要恢复 OA 或运行 Virtuoso CIW。

`tools/workbench/ic_sim.py` 是唯一 standalone runner 实现。`tools/sim/ic_sim.py` 仅保留旧 CLI/Python 导入兼容，实际函数与 runner hash 指向该实现。Bundle 和 site 字段详见[仿真接口](../tools/sim/INTERFACE.md)。网页、Agent 和远端调度使用现有网关授权与持久回执；旧 CLI 不替代这些管理规则。

## 数据与运行边界

| 位置 | 保存内容 |
|---|---|
| Git 电路库 | 所属 RNL/电气源、参数与保存信号配置、testbench 选择、受审摘要和来源记录 |
| 本地私有配置 | SSH alias、站点路径、外部模型映射、连接凭据、运行状态与操作回执 |
| 授权远端 | 独立 Spectre 进程、站点 PDK/许可证、每次运行的隔离输入/输出目录 |
| 结果归档 | 与原 source/config/run 身份绑定的日志、波形、校验记录和已验证指标 |

源网表可以直接进入 bundle。每个输入文件有精确 hash，include/Verilog-A 依赖需要显式闭合；外部模型通过站点 alias 引用，不自动复制进 Git。RNL 图形编辑与 Spectre 源的同步必须由实际修改和验证证明，不能只靠文件同名推断。

## 执行和恢复

从仓库根目录运行无网络的示例计划：

```bash
python3 -B tools/workbench/ic_sim.py --site config/site.example.json plan --bundle tools/sim/fixtures/bundle.json
```

这个 fixture 只检查传输/输入组织，未获准执行，也不代表 ADC 仿真。实际运行使用操作者自己的受审 bundle 和私有 site：

```bash
python3 -B tools/workbench/ic_sim.py --site /absolute/site.local.json preflight --bundle /absolute/bundle.json
python3 -B tools/workbench/ic_sim.py --site /absolute/site.local.json run --bundle /absolute/bundle.json --execute --raw --results /absolute/run-results
```

`plan` 不联网；`preflight` 会检查授权远端。`run --execute` 检查受审文件、Git 提交、输入和外部模型 hash，创建独立目录并进行单次提交。模型、setup 和工具来源随运行回执保留。默认结果目录属于 canonical runner；集成时建议显式传 `--results`。

断线、超时或不确定结果必须沿用原 receipt 查询/收集，不能改 key 或另开运行来重试：

```bash
python3 -B tools/workbench/ic_sim.py --site /absolute/site.local.json status --receipt /absolute/run-results/RUN_ID/run.json
python3 -B tools/workbench/ic_sim.py --site /absolute/site.local.json collect --receipt /absolute/run-results/RUN_ID/run.json --raw
```

运行成功 footer 与退出码只证明求解器完成。PSFXL/OCEAN/CSV 的读取与科学测量另行核对；配置、结果归档与指标均需保留原运行身份。未知状态不自动取消、清理或重复提交。

## CI 与历史

公共 GitHub CI 可验证源码、配置、include 闭包和 RNL。真实 Spectre 需要已配置的授权执行环境，不能从静态检查通过推断模型或许可证可用。现行 TB 选择与工作流见[TB CI](circuit-ci.md)。

2026-11-09 的 real-SAR、ideal 和 MDAC 导入使用各自原始设置与测量约定；历史波形和失败结论保持原样。Maestro/OA 导出在当时作为配置来源，不是当前执行依赖。原始迁移清单、采样/译码/FFT 约定及当时尚未完成的验证可查阅[固定历史版本](https://github.com/joshuazeng713/CircuitGit/blob/10e067bd341736d39cb1157562e76e9914a311e6/docs/simulation-migration-plan.md)。不要把历史未完成事项、私有路径或旧结果当作当前新运行的验收。
