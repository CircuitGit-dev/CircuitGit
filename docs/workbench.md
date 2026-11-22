# 本地 IC 工作台

入口是 `python3 -B tools/workbench/launch.py`，默认地址 `http://127.0.0.1:8766/`。浏览器、网关与本地 RNL 组件同源。无需前端构建或 CDN；只读预览也可用 `python3 -B -m http.server 8765 --bind 127.0.0.1 --directory web`，此模式没有提交或仿真能力。

## 工作副本与设置

`config/workbench.example.json` 保存仓库与分支默认值，`config/workbench.projects.json` 登记允许操作的项目，`config/site.example.json` 描述已有仿真站点。启动器首次生成 `.local.json` 后保留用户设置；也可用 `--config /absolute/path/to/gateway.local.json` 指定现有安装。

网关执行已安装的 `tools/workbench/` 代码。源码从独立 runtime checkout 读取；页面只能编辑已登记的项目文本和配置，不能执行编辑commit内的脚本。运行目录、SSH和GitHub身份保留本地。开发checkout与运行checkout分别提交，避免网页保存与开发集成争用同一Git索引。

默认 runtime branch 为 `codex/workbench-session`。同步优先获取该远端分支；尚未推送时读取配置的 base branch。已有本地分叉或未提交变更会返回冲突，不强制覆盖。网页修改提交到 runtime branch，选中推送才会推到 GitHub；后续可通过常规 PR 合回开发分支。

## 可编辑源、OA 与图形的关系

| 内容 | 权威源和更新规则 |
|---|---|
| 原始schematic/symbol/layout | `design/native/` 和原SAR参考OA快照；恢复后由Virtuoso编辑，重新导出及验证后才能形成新基线 |
| 当前文本电路 | `projects/<id>/circuit.scs`；网页和GitHub编辑同一源 |
| 仿真设置 | `projects/<id>/configurations/*.json`；参数、分析、求解器和postprocess导出定义参与commit与输入哈希 |
| 网页图形 | 当前文本源生成的派生视图；必须与显示的path/hash/commit匹配才允许对象定位 |
| 每次运行输入 | 网关从指定commit与配置生成新的冻结bundle，重新计算所有输入哈希；原历史bundle不变 |
| 结果 | run_id关联source commit、输入/外部依赖哈希、solver状态、raw清单和发布回执 |

本次RNL范围为22个子电路与TB，共711个实例。实际upstream UI负责画图、命中与层级导航；适配器负责Spectre文本索引、派生放置及选中事件。MOS为四端符号，外部库/行为/标准单元为端口方框。密集连线可能重叠，图形不等于原OA坐标。解析失败保持stale，不以局部成功宣称全图同步。

选择对象返回原始源范围；总线转义仅用于名称对齐。ID由source path、scope、kind、name构成，插入注释或改参数不改变ID。源变更立即禁用旧映射，新的hash与渲染确认后才恢复定位。实际物理点击测试和程序化选择证据分别记录。

## 仿真和结果

计划显示选定commit、配置、输入和外部模型依赖；preflight核查站点可达和工具/模型，提交后才发生新Spectre运行。断连后沿用原run_id查询，不另建重复任务。页面区分求解器退出与测量验收。完整raw由本地网关收集，浏览器仅显示导出的抽样波形与摘要。

发布面向配置指定的现有私有GitHub仓库：结果索引进入 `codex/results/<run_id>`，完整数据进入 `sim-<run_id>` Release资产。发布回执核对资产存在、大小与SHA256；失败保留本地包，可继续原run发布。已确认发布的归档保持不变。

本次两个运行均来自 `1d9279ef0ba016a8c5d26e1260eff664d2eae25f`：

- RC：`20261109T054143Z-1d9279ef0b-5380487a`，实际Spectre exit0，0错误/0警告；该run的OCEAN数据与有限上升沿RC解析解最大误差0.0002348074V，低于0.001V smoke界限。
- real-SAR LOW24ns：`20261109T054442Z-1d9279ef0b-014b97a6`，实际Spectre exit0，日志记录0错误、50警告，已从该run导出波形。警告保留于归档；此处不宣称已完成ADC动态性能或签核验收。

随后另做一次不同电阻值的HTTP全链验收：`20261109T071529Z-ba49b4ff1c-955216aa`，source commit `ba49b4ff1cecf8efa9b03dd46f755dac53a2bd8e`。GitHub提交R=2kΩ和版本化postprocess后，经HTTP sync、plan、jobs、状态、collect、publish完成一次真实运行；τ=2ns，与该run的OCEAN导出比较最大误差0.0000348372V < 0.001V。完整105,213-byte归档通过私有Release资产SHA256校验。

这些运行在最终工作台开发commit之前产生，来源commit保持原值。三次完整包均已私有发布。精确回收/发布及浏览器联调证据位于 `validation/phase2/`，不能将离线MOCK测试作为真实后端或仿真成功证明。

## 加入另一个电路

1. 新建 `projects/<id>/circuit.scs` 和配置JSON；先准备包含模型、analysis、options、save定义的可验证bundle模板。
2. 在可信安装的 `config/workbench.projects.json` 登记source_path、稳定configuration ID、configuration_path、bundle_template以及source_replacements。
3. 初次启动后更新本地 `workbench.local.json` 的projects登记并重启。运行工具无需改项目名常量。
4. 提交项目源与配置，先检查plan/preflight，再以新的幂等键运行一个有明确验收标准的最小任务。

外部PDK/标准单元模型及许可证留在站点，通过别名和hash绑定。只改设计文本不会自动获得新的PDK依赖或layout/LVS/PEX结果。

## 验证

CI执行原生快照与bundle完整性、phase1 CLI、工作台后端、UI核心、实际WASM图形构建、vendor135文件哈希和CSP启动脚本检查。浏览器测试需本机Chrome及Playwright；`tests/browser.test.mjs` 的后端为明确标记的MOCK，`tests/live.test.mjs` 对真实网关默认只读/preview/plan，不会重新跑仿真。

本次研究库没有layout；参考SAR保留9个layout view，其层级闭包和当前整机LVS/PEX未验证。网页提供设计审查与任务入口，完整Cadence编辑/签核仍由已有授权环境完成。
