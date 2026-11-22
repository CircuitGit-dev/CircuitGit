# Virtuoso 原图迁移

2026-11-09 的迁移以已经保存的 OA 文件为来源。Git 同时保留原生 OA 归档、原始 RNL 导出、用于网页显示的确定性副本，以及原图到仿真网表的映射。`projects/real-sar-20261106/circuit.scs` 仍是仿真的电气输入。

## 已迁移范围

| 范围 | 内容 | 网页入口 |
|---|---|---:|
| real-SAR 整机 | 711 个电气器件；22 个子电路和 testbench；1,630 条器件/网络源映射 | 23 |
| 2026_PIPETISAR_RESEARCH | 54 个 schematic cell、10 个仅有 symbol 的 cell | 64 |
| 2026_PIPESAR 参考库 | 选定的 10 个 cell；原生归档包含其中的 9 个 layout | 10 |

97 个入口保留独立的依赖闭包。研究库和参考库以 `research.`、`original-sar.` 标识，仅作已保存快照浏览；它们不会替换 real-SAR 仿真源或继承其性能验收。研究库的历史版本保持独立，原始 SAR 库也没有被 real-SAR 研究副本覆盖。没有新增版图或 DRC/LVS/PEX 验收。

原生归档位于 `design/archives/`。原始 RNL/Spectre 导出位于 `design/native/rnl/*.tar.gz`，旁边有逐文件 hash。网页副本位于 `projects/real-sar-20261106/native/`，manifest 明确列出来源、每个成员的 hash、依赖、坐标体系、损失和源映射。PDK 模型与标准单元电气实现仍由服务器提供。

## 保真程度

独立审计在含外部接口展开的完整诊断导出上核对了 1,832 条 EDIF 原始路径，全部吻合。渲染的另外 5 条记录是零长度重合接点：OTA 的 `(47,0)`、`(4,23)`、`(47,-24)`，Switch 的 `(-1,5)`、`(3,-1)`。生产包将厂商 NAND 的内部实现留在外部，保留与 canonical 网表一致的 711 个器件。所有终端顺序、器件参数和子电路端口顺序通过电气比较。

原图中 `nlAction=ignore` 的 OTA C0/C4/R7 与 SAR 的 W0<0:9> 已恢复成 4 个非电气图形。位置、方向、符号笔画来自原始 EDIF；不会改变仿真连接。图形的端点显示为小圆点。动态 `cdsParam/cdsTerm` 标签、字体/样式以及同一端口的多个物理引脚细节尚未达到完整复现，因此 UI 明确显示 partial，不能据此宣称版图或签核等效。

## 可重复处理

1. 在隔离目录恢复保存的 OA，并配置服务器上的 Cadence/PDK 路径。不要指向正在编辑的 OA 库。
2. 使用固定的 rnl-virtuoso 0.9.5 源码提交，应用 `tools/native_geometry/rnl-virtuoso-local-fixes.patch`，执行上游 Go 测试并构建。补丁处理 PCell 参数化子主单元和动态变量污染、Verilog-A 局部函数端口解析，并提供离线 ignored-figure 提取。清单记录原始及补丁后 hash。
3. 导出配置保存为忽略提交的 `config/native-export.local.json`。运行：

```sh
python -B tools/native_geometry/native_export.py \
  --config config/native-export.local.json \
  --receipt-dir scratch/native-export-unique-run
```

导出强制 `auto-check-save=false`，不启动仿真。每次输出和 receipt 使用新目录；未知结果须先核对原 job，不重复提交。

4. `build_native_bundle.mjs` 按显式配置创建整机显示副本；`append_native_libraries.mjs` 加入库浏览目录。所有配置路径以配置文件目录为基准。脚本拒绝覆盖已有输出，并核对 canonical hash 和每个器件的电气元组。每个电容必须已有明确的原生 symbol 指定，才允许去掉两个冲突的自动电容规则；没有过滤 core diagnostics。外部 AHDL 路径只从网页副本移除，原始导出仍保留。
5. 每个子电路由一个扁平 include-only wrapper 加载完整依赖，Auto Include=false；顶层 TB 直接使用已有显式 includes。避免逐片段递归 include 导致重复定义。

```sh
node tools/native_geometry/validate_native_bundle.mjs \
  projects/real-sar-20261106/native \
  web/vendor/rnl-viewer/core/client.js scratch/native-core-check
python -B tools/native_geometry/check_bundle.py
```

提交电气变更后，旧图自动标记 stale；需要显式选择查看历史图，canonical 跳转停止。重新导出并通过上述检查后再更新快照。仿真 CLI、配置、结果归档仍使用 `docs/simulation-migration-plan.md` 和 `docs/workbench.md` 中的同一流程。

## 独立库的未恢复图形

上述4组恢复仅适用于整机 canonical 图。研究库独立浏览副本仍缺 OTA C0/C4/R7 与 RSW W0<0:9>（13个标量记录/4组图形）；原始 SAR 参考库仍缺 L5_9bit_RSW_CDAC/I4 和 L6_9bit_RSW/W0<0:9>（11个标量记录/2组图形）。I4 的 CDAC 被原网表器忽略，所以参考 SAR 顶层闭包显示144个器件；L7 CDAC 可单独打开257个器件，不能把两者计数相加宣称顶层完整。原始EDIF和OA归档仍保留这些图形。网页每个库入口的损失清单明确列出未恢复项，详见 native/library-ignored-inventory.json。该盘点只使用64份已保存EDIF，无额外EDA操作。

构建配置模板为 `config/native-build.example.json`。填入这一次导出对应的完整 commit、源 SHA256 与 OA snapshot SHA256，再执行 `node tools/native_geometry/build_native_bundle.mjs config/native-build.local.json`。如果 external=false 导出省略了 canonical 中的参数化包装层，须通过 `additional_verified_fragments` 明确提供其原始导出、目标文件、library/cell/subcircuit 和原始 SHA256；脚本会验证完整 canonical 器件数与连接，缺少包装层时不会静默成功。
