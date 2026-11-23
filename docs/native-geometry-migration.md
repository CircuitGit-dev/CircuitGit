# Virtuoso 原图的历史导入

本页记录 2026-11-09 的 OA/EDIF/RNL 导入背景。现行 CircuitGit 直接编辑 Git 内的 RNL、电气源和仿真配置，不要求安装 Virtuoso，也不以重新导出 OA 作为保存电路的前置步骤。

## 历史方法和证据

当时的迁移从已保存的 OA 快照出发，用固定版本的 rnl-virtuoso 导出电气层级、符号、实例位置与方向、引脚和原始连线路径，再生成网页可读取的显式依赖闭包。原理图的可读性来自导出的几何信息，不是仅凭网表自动布局。

历史导入包含 real-SAR 整机、研究库和参考库的独立入口。电气器件、子电路端口和终端顺序与 canonical Spectre 源比较；被 netlister 忽略的部分器件另外作为非电气图形恢复。动态标签、字体及部分引脚细节仍存在已记录损失，不能据此宣称完全复现或版图签核等效。

原始私有工作区包含 OA 归档、RNL/Spectre 导出和逐文件 hash；公共库保留其受审的源文件、provenance 与损失说明。私有归档路径不保证存在于本仓库的新克隆中。已有来源和验证 hash 不因后续编辑而重写。

旧的 OA capture/restore、Cadence batch netlist export、rnl-virtuoso 导出启动器和 SI 示例已从当前应用删除。需要研究当时的具体实现时，可查阅固定 Git 源码：

- [OA capture](https://github.com/joshuazeng713/CircuitGit/blob/10e067bd341736d39cb1157562e76e9914a311e6/tools/snapshot_oa.py) 与 [OA restore](https://github.com/joshuazeng713/CircuitGit/blob/10e067bd341736d39cb1157562e76e9914a311e6/tools/restore_oa.py)。
- [Cadence batch netlist export](https://github.com/joshuazeng713/CircuitGit/blob/10e067bd341736d39cb1157562e76e9914a311e6/tools/netlist_export.py)。
- [原生几何导出启动器](https://github.com/joshuazeng713/CircuitGit/blob/10e067bd341736d39cb1157562e76e9914a311e6/tools/native_geometry/native_export.py) 与 [当时的局部补丁](https://github.com/joshuazeng713/CircuitGit/blob/10e067bd341736d39cb1157562e76e9914a311e6/tools/native_geometry/rnl-virtuoso-local-fixes.patch)。
- [完整历史迁移步骤与覆盖说明](https://github.com/joshuazeng713/CircuitGit/blob/10e067bd341736d39cb1157562e76e9914a311e6/docs/native-geometry-migration.md)。

`tools/native_geometry/exporter-patch-manifest.json` 和 `exporter-LICENSE` 仍保留历史 hash 与许可记录；它们不表示当前应用会重新构建或调用该导出器。`config/native-export.example.json` 也只是历史导入配置示例。

## 当前维护方式

1. 从电路库的明确 library/cell/view 打开所属 RNL 文件及依赖闭包。
2. 修改电气连接时，同时更新需要变化的所属 RNL 符号、位置或连线信息。可用同一 `save_files` 操作保留成组修改和检查点；共享依赖及历史 provenance 不直接改写。
3. 保存后读取当前版本并刷新 Viewer。电气检查、RNL 解析/显示和仿真结果各自验证，不将写入成功当作渲染或仿真成功。
4. 选择注册的 testbench 配置，编译成源与配置 hash 固定的输入，再交给独立远端 Spectre。外部 PDK 模型与许可证仍由站点管理。

`tools/native_geometry/build_native_bundle.mjs`、`append_native_libraries.mjs` 和验证器保留用于处理已有导入数据；它们不会恢复 OA 或启动 Virtuoso。新导入需要自己的明确来源、文件清单及验证，不复用旧证据冒充新导出。

现行操作见[电路库](circuit-libraries.md)、[Agent 工具](library-agents.md)、[RNL Studio](rnl-studio.md)和[独立仿真](simulation-migration-plan.md)。
