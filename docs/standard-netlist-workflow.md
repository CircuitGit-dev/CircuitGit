# 通用网表流程调研 — 2026-11-09

## 结论和当前实现方向

已有 Spectre/SPICE 文本可直接作为版本控制和仿真的输入，不要求先导入 OA。现有 Virtuoso schematic 存在 OA 中，由 Cadence 标准 netlister 读取库、视图、CDF 与模型映射生成网表。迁移脚本只负责参数化、隔离执行、依赖组织和证据记录，不自行实现 OA 读取器或通用模拟电路 netlister。

两个会话保持原任务：IC_on_Github 负责通用导出入口与项目数据集成；PIPETISAR 仿真流程迁移到 GitHub 负责通用运行入口。原理图导出与完整仿真输入包是不同接口。si 生成的电路结构仍需参数、model include、analysis 和 options 才能复现一个具体测试。

## 已核对的现有 bridge

现有本地仓库：`existing LLM_for_IC/virtuoso-bridge-lite checkout`。
远端：`https://github.com/Arcadia-1/virtuoso-bridge-lite.git`。
本次读取版本：`ecaf5a5c5499051ea4c4796a480e278a3e9c0da8`。活动 Python 包也从此 checkout 加载。没有额外下载或更新。

1. `client.schematic.export_netlist(lib, cell, output_dir, view='schematic', simulator='spectre', run_dir=...)` 已实现。底层为 OCEAN `simulator` → `design` → `createNetlist`，下载整个 netlist 目录。`run_dir` 显式指定时保留远端产物。
2. `client.schematic.import_netlist(lib, cell, netlist_file, language='Spectre', ref_libs=..., dev_map_file=..., overwrite=False, run_dir=...)` 已实现。调用 Cadence `spiceIn`，再转换 netlist view 为 schematic；器件映射及库引用必须匹配。
3. `client.maestro.create_netlist_for_corner(test, corner, output_dir, session=...)` 对应 `maeCreateNetlistForCorner`；适合明确 ADE 测试/工艺角的导出。
4. `skills/virtuoso/references/batch-netlist-si.md` 记录独立批处理：Cadence 生成的 `si.env` + `cds.lib` + `si`。当前 Spectre 流程用 `-command nl`，CDL 等后端可能用 `-command netlist`，须按目标安装版本验证。不能把后端命令混用。

代码依据：`src/virtuoso_bridge/virtuoso/schematic/__init__.py`、`schematic/netlist.py`、`maestro/writer.py`；文档依据：`skills/virtuoso/references/schematic-python-api.md`、`batch-netlist-si.md`、`netlist.md`。

`export_netlist()` 会开启 OCEAN 会话，可能影响共享 CIW 的现有 OCEAN 会话。当前自动化优先使用已成功验证的独立 si 执行，避免以桥接连接作为持续依赖。导入先检查器件映射与子电路选择，不等同于恢复原图坐标、布线风格、Maestro 设置或版图。

## Cadence 官方资料交叉核对

- Cadence Community，Andrew Beckett，How to export spice netlist?：确认 OCEAN `simulator/design/createNetlist`，以及 `si.env` + `si -batch -command netlist` 的 CDL 导出。另说明顶层是否包装 subckt 是单独选项。
  https://community.cadence.com/cadence_technology_forums/f/custom-ic-skill/47676/how-to-export-spice-netlist
- Cadence Community，Andrew Beckett，schematic creation using SKILL：确认 File → Import → SPICE 也能读 Spectre，并指出器件属性与 CDF callbacks 的要求。
  https://community.cadence.com/cadence_technology_forums/f/custom-ic-skill/36821/schematic-creation-using-skill
- Cadence 官方博客，Virtuosity: 21 Things I Learned in May and June 2014：说明 SpiceIn 支持文本 CDL/HSpice/Spectre/SPICE 转 schematic 或 netlist view。
  https://community.cadence.com/cadence_blogs_8/b/cic/posts/virtuosity-x-things-i-learned-in-may-and-june-2014-by-browsing-cadence-online-support

这些官方公开资料证明路线存在，不替代当前服务器已安装版本的命令/API验证。Bridge 参考文档中的局部限制也不应推广为所有 Cadence 版本的事实。

## 通用脚本验收要求

- 库、cell/view、cds.lib、环境初始化、si.env、输出目录和执行目标通过配置传入。
- PIPETISAR/real-SAR/MDAC 名称、站点账号和服务器绝对路径只出现在示例/站点配置。
- 同一入口至少在两个真实 cell 上验证，记录 Cadence 版本、配置/产物 hash、日志和明确退出码。
- 已有文本网表可直接交给 simulation bundle；APS/线程等是显式 profile 或参数，而非所有项目的默认假设。
- 分别标明已完成导出、网表一致性验证、离线 runner 测试、只读服务器 preflight、真正 Spectre 提交/收集。
- 本轮通用导出优先；SpiceIn 的 API 和标准流程已确认，不能据此声称任意输入格式或原理图无损往返已实测。
