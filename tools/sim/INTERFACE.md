# 仿真包接口 v1

本文件定义 standalone Spectre 接口。唯一实现是 `../workbench/ic_sim.py`，本目录的 `ic_sim.py` 兼容旧 CLI 和 Python 导入；所有函数及 runner 来源 hash 使用该实现。现有 Git 文本网表可以直接进入 bundle，无需 OA、bridge 或 Virtuoso。调用方负责所选电路源闭包及站点外部模型绑定。

## Bundle：`ic.sim.bundle.v1`

每个测试一个 JSON，必需字段如下：

| 字段 | 约定 |
|---|---|
| schema | `ic.sim.bundle.v1` |
| design_id | 稳定设计版本，如 `pipetisar-real-sar-20261106` |
| design_origin | `oa-export`（默认）或 `text-netlist`；后者不要求 library/top_cell/testbench/history/test 非空 |
| library / top_cell / testbench | 明确原始身份，不能从当前 CIW 焦点猜测 |
| history / test | 原始参考历史与测试，如 `Interactive.0` / `PIPE_LOW`；新任务用独立 run_id |
| test_id | 本包可读名称，与上述字段同时记录 |
| source_root | 相对于 bundle 文件所在目录；所有源文件必须位于其内 |
| entrypoint | 本原型限 `netlist/<文件名>.scs`，示例 `netlist/input.scs` |
| files | 显式数组，每项 `source`、`destination`、`sha256`；路径相对于 source_root / run root |
| external_sha256 | 推荐 `{ "ULVT_ALIAS": "64位sha256", ... }`；每个使用的外部 alias 必须有 pin |
| external_dependencies | 可选丰富元数据数组，每项 `alias`、`sha256`、可选 `sections`；与映射并用时 hash 必须相同 |
| simulator | `{ "profile": "nov6-aps2", "args": [...], "output_format": "psfxl" }`；args省略时按profile取值 |
| configuration | 原始参数、tran、solver、采样窗、有效 reltol 等；原样放入结果 provenance，不覆盖网表 |
| historical_reference | 原始 source/netlist/log/CSV SHA256 等；建议保留可回溯路径 |
| reviewed_for_distribution | 经集成人确认项目源和外部模型边界后改为 true；执行必须为 true |

`files[].sha256` 是 Git 源文件原始 bytes。网表使用 `@EXTERNAL_<ALIAS>@`；CLI 仅替换这些 token，并另记 staged SHA256。所有 include/ahdl_include/VA include 必须在闭包中；Cadence 自带 `constants.vams` / `disciplines.vams` 除外。所有其他绝对 include 必须匹配 site 的显式外部路径。不支持向 Spectre 注入 `-param` 或在末尾覆盖参数；修改原参数定义并重新生成/提交包。

## Site：`ic.sim.site.v1`

本地 `site.local.json`，勿提交。仓库模板 `config/site.example.json` 不含凭据，只有示例路径。

- `ssh_target`：本地 SSH Host alias，认证、JumpHost、密钥均由用户 `~/.ssh/config` / agent 管理。
- `expected_host` / `expected_user`：preflight 必须匹配。
- `remote_runs_root`：绝对路径，末段必须是 `ic_on_github_runs`，例如服务器独立 scratch。禁止指向活动 ADE 结果路径。
- `cadence_cshrc`、`spectre_bin`、`ocean_bin`：服务器路径；许可证变量由服务器受控 setup 提供。CLI 不传输或保存许可证内容。
- `external_files`：`ALIAS -> 服务器绝对路径`。preflight 读取存在性和 SHA256，不下载外部模型内容。只检查声明的入口文件；递归 PDK 模型闭包仍需站点版本/目录清单。

模板不预设外部模型。正式 alias 使用大写字母/数字/下划线名称，并与 `external_sha256` 对应。站点必须提供所选电路要求的精确模型，不能以相近型号替代。CLI 不自动复制或创建模型；模型入口/setup/Spectre hash 会在 preflight 和远端作业启动时分别核对。

`spectre-default` 默认只有 `-64`；`nov6-aps2` 默认 `-64 +aps +mt=2 +lqtimeout 900 -maxw 5 -maxn 5`。显式 `args` 覆盖profile默认值。CLI保留 `+log/-raw/-format/-ahdllibdir` 的隔离输出路径并拒绝 `-param`，其余argv直接传给Spectre。输出格式可选 `psfxl/psfascii/psfbin`；本CLI收集归档，不承担通用格式解析。

## CLI

从仓库根目录以 Python 3.9+ 运行（只需标准库）：

```bash
python3 tools/workbench/ic_sim.py --site config/site.example.json plan --bundle tools/sim/fixtures/bundle.json
python3 tools/workbench/ic_sim.py --site /absolute/site.local.json preflight --bundle /path/to/BUNDLE.json
python3 tools/workbench/ic_sim.py --site /absolute/site.local.json run --bundle /path/to/BUNDLE.json --execute --raw --results /absolute/runs
python3 tools/workbench/ic_sim.py --site /absolute/site.local.json status --receipt /absolute/runs/RUN_ID/run.json
python3 tools/workbench/ic_sim.py --site /absolute/site.local.json collect --receipt /absolute/runs/RUN_ID/run.json --raw
```

`plan` 不联网、不创建仿真任务。`run` 未给 `--execute` 时也只做 plan。真正执行前检查 clean commit、文件跟踪、源 hash、身份、依赖 hash；冻结提交与配置 hash，使用唯一目录和永久 `launch_once`，不调用共享 CIW，不自动重试提交。默认等待 3600 秒后进入 reconcile；可用 `--wait-seconds` 控制本地等待，超时不杀服务器任务。服务器不需要 Python3。

结果分两层：Spectre 退出码=0 且有成功 footer，状态才是 `simulator_complete_pending_measurements`；这仍不表示电路通过精度/FFT验收。`collect --raw` 回收 PSFXL、日志、manifest 和校验记录的 tar.gz；不会自动解包，避免覆盖本地源。不带 `--raw` 仅收日志/状态。再次 collect 不启动仿真。

| CLI 退出码 | 含义 |
|---|---|
| 0 | plan/preflight 完成；或观察到求解器完成并完成收集（测量未验收） |
| 1 | 观察到远端求解/输入校验/作业设置失败，已尝试收集证据 |
| 2 | 本地配置、依赖、路径、身份、hash、staging 或 SSH 检查失败；看错误与 receipt |
| 75 | 已提交但未能确认终态/超时，必须用 status/collect；禁止重播 |

远端 staging 的原子目录已存在返回 75；归档错误返回 71；job setup 失败返回 70；这些被 receipt/本地错误保留。`reported_state=running` 仅是最后持久化状态，进程可能已中断，CLI 不把它当“当前存活”保证。

## Run：`ic.sim.run.v1`

包含全部设计身份、history/test、configuration、simulator、external_dependencies及external_sha256；`provenance` 保存 source_commit、source_clean、bundle/runner/site-config hashes、每个源文件及 staged hash。runtime_preflight 保存当时模型入口/setup/Spectre hashes和版本证据。`run_id` 包含 UTC 时间、commit前12位和随机串。历史 history 保持不变；新 run_id 是独立试验，不重用已完成的 ADE submission。

当前原型的 `run` 不自动运行 OCEAN/科学指标求值。PSFXL 使用独立 OCEAN 后处理或已验证导出 CSV，再按既有采样/译码约定验收。禁止用通用 bridge ASCII parser 直接解析 PSFXL。日志可能包含站点许可证服务器信息，回收目录必须保持本地/私有且排除 Git。
